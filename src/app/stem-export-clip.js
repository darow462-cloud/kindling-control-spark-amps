// Shared six-stem non-destructive trimming. One selection applies to every
// separated WAV; all outputs decode to one fixed rate so frame boundaries
// coincide. Original WAVs, model outputs, Mute and Solo are never modified.
import {
  MAX_SOURCE_DECODE_BYTES, MAX_CLIP_SECONDS, peakEnvelope, durationClock,
  normalizedClip, wavFromAudioBuffer, wavZip, triggerDownload,
} from './stem-trim-utils.js';
import { MIX_STEMS, MIX_LABELS } from './stem-mixer.js';

export function initStemExportClip({
  root,
  mixer,
  windowRef = window,
  documentRef = document,
  download = triggerDownload,
} = {}) {
  if (!root || !mixer) return null;
  const $ = (id) => root.querySelector('#' + id);
  const elements = {
    load: $('stem-mixer-clips-load'),
    start: $('stem-mixer-clips-start'),
    end: $('stem-mixer-clips-end'),
    startNum: $('stem-mixer-clips-start-number'),
    endNum: $('stem-mixer-clips-end-number'),
    export: $('stem-mixer-clips-export'),
    preview: $('stem-mixer-clips-preview'),
    status: $('stem-mixer-clips-status'),
    selected: $('stem-mixer-clips-selected'),
    lanes: $('stem-mixer-clips-waveforms'),
  };
  if (!Object.values(elements).every(Boolean)) return null;

  let current = { mode: '', sources: [], signature: '' };
  let bins = new Map();
  let duration = 0;
  let start = 0;
  let end = 0;
  let busy = false;
  let epoch = 0;
  let disposed = false;
  const canvases = new Map();

  function say(message, error = false) {
    if (disposed) return;
    elements.status.textContent = message;
    elements.status.dataset.kind = error ? 'error' : '';
  }
  function draw() {
    for (const name of MIX_STEMS) {
      const canvas = canvases.get(name);
      const ctx = canvas?.getContext?.('2d');
      if (!ctx) continue;
      const width = canvas.width, height = canvas.height;
      ctx.clearRect(0,0,width,height);
      ctx.fillStyle = '#192632';
      ctx.fillRect(0,0,width,height);
      const peaks = bins.get(name);
      if (!peaks) continue;
      ctx.fillStyle = '#83afc5';
      const step = width / peaks.length;
      for (let i=0;i<peaks.length;i++) {
        const h = Math.max(1,peaks[i]*(height-5));
        ctx.fillRect(i*step,(height-h)/2,Math.max(1,step-0.5),h);
      }
      const left = start / duration * width;
      const right = end / duration * width;
      ctx.fillStyle = 'rgba(87, 204, 226, 0.17)';
      ctx.fillRect(left,0,right-left,height);
      ctx.strokeStyle='#8be2e9';ctx.lineWidth=1.7;
      for (const x of [left,right]) {
        ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();
      }
    }
  }
  function refresh() {
    if (disposed) return;
    elements.load.disabled = current.sources.length!==6 || busy;
    elements.export.disabled = bins.size!==6 || busy ||
      !duration || end-start < 0.1;
    elements.preview.disabled = !duration || busy;
    elements.start.disabled = !duration || busy;
    elements.end.disabled = !duration || busy;
    elements.startNum.disabled = !duration || busy;
    elements.endNum.disabled = !duration || busy;
    elements.start.value = String(Math.round(start / (duration || 1) * 1000));
    elements.end.value = String(Math.round(end / (duration || 1) * 1000));
    elements.startNum.value = start.toFixed(2);
    elements.endNum.value = end.toFixed(2);
    elements.startNum.max = String(duration);
    elements.endNum.max = String(duration);
    elements.selected.textContent = duration
      ? durationClock(end-start) + ' selected of ' + durationClock(duration)
      : 'Load the six WAV waveforms to select a common section.';
    draw();
  }
  function sourcesChanged({mode='',sources=[]}={}) {
    if (disposed) return;
    ++epoch;
    const allowed = Array.isArray(sources) ? sources.filter((item)=>
      MIX_STEMS.includes(item.name) &&
      typeof item.url === 'string' &&
      (/^blob:/.test(item.url) ||
      /^kindling-stem:\/\/[0-9a-f-]+\/[a-z]+\.wav$/i.test(item.url))) : [];
    const signature = mode + '|' + allowed.map((s)=>s.name+':'+s.url).join('|');
    if (signature===current.signature) return;
    current = { mode, sources: allowed, signature };
    duration = start = end = 0;
    bins = new Map();
    for (const name of MIX_STEMS) canvases.get(name)?.getContext?.('2d')?.clearRect(
      0,0,canvases.get(name).width,canvases.get(name).height);
    say(allowed.length===6
      ? 'Ready to load all six waveforms. Selection will apply to all tracks together.'
      : 'Load all six WAV tracks into the selected mixer bank to enable synced clipping.');
    refresh();
  }
  async function decodeWav(source, context) {
    const response = await windowRef.fetch(source.url);
    if (!response.ok) throw new Error('Could not read the local ' + source.name + ' WAV.');
    const length = Number(response.headers.get('content-length')||'0');
    if (length > MAX_SOURCE_DECODE_BYTES) throw new Error(source.name + ' WAV is too large for clipping.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_SOURCE_DECODE_BYTES) throw new Error(source.name + ' WAV is too large.');
    const audio = await context.decodeAudioData(bytes);
    if (audio.numberOfChannels < 1 || audio.numberOfChannels > 2 ||
        !Number.isFinite(audio.duration) || audio.duration<=0 ||
        audio.duration>MAX_CLIP_SECONDS) {
      throw new Error('Clip editor supports mono/stereo WAVs up to 15 minutes.');
    }
    return audio;
  }
  async function loadWaveforms() {
    if (disposed || busy || current.sources.length!==6) return false;
    busy=true;refresh();
    const token=++epoch;
    const sources = current.sources.slice();
    let ctx=null;
    try {
      const Context=windowRef.AudioContext||windowRef.webkitAudioContext;
      if (!Context) throw new Error('Web Audio decoding is unavailable.');
      ctx=new Context({ sampleRate:44100 });
      const localBins=new Map();
      const durations=[];
      for (let i=0;i<sources.length;i++) {
        say('Preparing waveforms: '+(i+1)+'/6 · '+MIX_LABELS[sources[i].name]);
        const audio=await decodeWav(sources[i],ctx);
        if (token!==epoch || disposed) return false;
        localBins.set(sources[i].name,peakEnvelope(audio,320));
        durations.push(audio.duration);
      }
      const min=Math.min(...durations), max=Math.max(...durations);
      if (max-min>0.2) throw new Error('WAV durations differ by more than 0.2 s; cannot guarantee alignment.');
      bins=localBins;
      duration=min;
      start=0;end=duration;
      say('All six waveforms ready. Set a common start/end, preview, then export WAV clips as ZIP.');
      return true;
    } catch(error) {
      if (!disposed && token===epoch) {
        bins=new Map();duration=start=end=0;
        say('Cannot prepare synchronized WAVs: '+String(error.message||error).slice(0,190),true);
      }
      return false;
    } finally {
      busy=false;
      if (ctx) await ctx.close().catch(()=>{});
      refresh();
    }
  }
  function updateRange(a,b) {
    if (!duration || busy) return;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      say('Enter finite numeric start and end times.', true);
      refresh();
      return;
    }
    const minimum=Math.min(0.1,duration/2);
    start=Math.max(0,Math.min(duration-minimum,a));
    end=Math.max(start+minimum,Math.min(duration,b));
    refresh();
  }
  function preview() {
    if (!duration || end-start<0.1 || busy) return;
    if (!mixer.previewRange(start,end)) say('Mixer is not ready for segment playback.',true);
  }
  async function exportZip() {
    if (disposed || busy || bins.size!==6) return false;
    const sources=current.sources.slice();
    const token=++epoch;
    busy=true;refresh();
    let context=null;
    try {
      const {start:s,end:e}=normalizedClip(start,end,duration);
      const Context=windowRef.AudioContext||windowRef.webkitAudioContext;
      if (!Context) throw new Error('Web Audio unavailable.');
      context=new Context({sampleRate:44100});
      const entries=[];
      for (let i=0;i<sources.length;i++) {
        if (disposed || token!==epoch) throw new Error('Tracks changed during export. Please try again.');
        const source=sources[i];
        say('Trimming WAV '+(i+1)+'/6 · '+MIX_LABELS[source.name]);
        const buffer=await decodeWav(source,context);
        if (buffer.duration + 0.011 < e) throw new Error(source.name+' WAV is shorter than the selection.');
        const blob=wavFromAudioBuffer(buffer,s,e,{fadeSeconds:0.005});
        entries.push({name:source.name+'-clip.wav',blob});
      }
      say('Packaging six aligned PCM16 WAVs into ZIP…');
      const zip=await wavZip(entries);
      if (token!==epoch || disposed) throw new Error('Track selection changed before export.');
      download(zip,current.mode+'-six-stems-clip.zip',{documentRef});
      say('Six aligned WAV clips exported as ZIP. Original tracks are unchanged.');
      return true;
    } catch(error) {
      if (!disposed) say('Clip export failed: '+String(error.message||error).slice(0,200),true);
      return false;
    } finally {
      busy=false;refresh();
      if (context) await context.close().catch(()=>{});
    }
  }
  for (const name of MIX_STEMS) {
    const row=documentRef.createElement('div');
    row.className='stem-mixer-clip-row';
    const title=documentRef.createElement('span');
    title.textContent=MIX_LABELS[name];
    const canvas=documentRef.createElement('canvas');
    canvas.width=600;canvas.height=36;
    canvas.setAttribute('aria-label',MIX_LABELS[name]+' waveform');
    row.append(title,canvas);
    elements.lanes.append(row);
    canvases.set(name,canvas);
  }
  elements.load.addEventListener('click',()=>{void loadWaveforms();});
  elements.preview.addEventListener('click',preview);
  elements.export.addEventListener('click',()=>{void exportZip();});
  elements.start.addEventListener('input',()=>updateRange(Number(elements.start.value)/1000*duration,end));
  elements.end.addEventListener('input',()=>updateRange(start,Number(elements.end.value)/1000*duration));
  elements.startNum.addEventListener('change',()=>updateRange(Number(elements.startNum.value),end));
  elements.endNum.addEventListener('change',()=>updateRange(start,Number(elements.endNum.value)));
  refresh();
  return {
    sourcesChanged,
    getRange:()=>({start,end,duration}),
    dispose(){disposed=true;++epoch;bins.clear();},
  };
}
