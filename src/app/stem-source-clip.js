// One source-clip editor for both native Demucs and isolated RoFormer. Editing
// ranges does not mutate either original file. Applying creates a bounded,
// local PCM16 WAV; native Demucs receives it through narrow, main-owned IPC,
// and RoFormer receives a user-selected File through its existing bridge.
import {
  clipIsFull, durationClock, MAX_SOURCE_DECODE_BYTES, MAX_CLIP_SECONDS,
  peakEnvelope, wavFromAudioBuffer,
} from './stem-trim-utils.js';

export function initSourceClip({
  root,
  onDemucsApply = async () => {},
  onDemucsRestore = async () => {},
  onRoFormerApply = async () => {},
  onRoFormerRestore = async () => {},
  windowRef = window,
  urlApi = URL,
} = {}) {
  if (!root) return null;
  const $ = (id) => root.querySelector('#' + id);
  const els = {
    name: $('stem-source-name'), status: $('stem-source-trim-status'),
    waveform: $('stem-source-waveform'), start: $('stem-source-start'),
    end: $('stem-source-end'), startNum: $('stem-source-start-number'),
    endNum: $('stem-source-end-number'), duration: $('stem-source-duration'),
    apply: $('stem-source-apply'), reset: $('stem-source-reset'),
    preview: $('stem-source-preview'), stop: $('stem-source-preview-stop'),
  };
  if (!Object.values(els).every(Boolean)) return null;

  const audio = windowRef.document.createElement('audio');
  audio.preload = 'metadata';
  let source = null;
  let decoded = null;
  let duration = 0;
  let start = 0;
  let end = 0;
  let applied = null;
  let loaded = false;
  let busy = false;
  let epoch = 0;
  let disposed = false;
  let dragHandle = null;

  function say(message, kind = '') {
    if (disposed) return;
    els.status.textContent = message;
    els.status.dataset.kind = kind;
  }
  function isTrimmed() {
    return duration > 0 && !clipIsFull({ start, end }, duration);
  }
  function isApplied() {
    return !!applied && Math.abs(applied.start - start) < 0.005 &&
      Math.abs(applied.end - end) < 0.005;
  }
  function refresh() {
    if (disposed) return;
    els.start.value = String(Math.round(start / (duration || 1) * 1000));
    els.end.value = String(Math.round(end / (duration || 1) * 1000));
    els.startNum.value = start.toFixed(2);
    els.endNum.value = end.toFixed(2);
    els.startNum.max = String(duration);
    els.endNum.max = String(duration);
    els.duration.textContent = durationClock(end - start) + ' selected of ' + durationClock(duration);
    els.preview.disabled = !source || !duration || busy;
    els.stop.disabled = !source;
    els.apply.disabled = !loaded || !isTrimmed() || busy || isApplied();
    els.reset.disabled = !source || busy || (!isTrimmed() && !applied);
    els.name.textContent = source ? source.name + ' · ' +
      (source.engine === 'demucs' ? 'Demucs' : 'RoFormer') : 'Choose an audio file in either engine';
    draw();
  }
  function draw() {
    const canvas = els.waveform;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1c2531';
    ctx.fillRect(0, 0, w, h);
    if (!decoded || !duration) return;
    const peaks = peakEnvelope(decoded, 300);
    const barWidth = w / peaks.length;
    ctx.fillStyle = '#738fa3';
    for (let i = 0; i < peaks.length; i++) {
      const height = Math.max(1, peaks[i] * (h - 12));
      ctx.fillRect(i * barWidth, (h - height) / 2, Math.max(1, barWidth - 0.4), height);
    }
    const a = start / duration * w, b = end / duration * w;
    ctx.fillStyle = 'rgba(87, 204, 226, .17)';
    ctx.fillRect(a, 0, b - a, h);
    ctx.strokeStyle = '#8be2e9';
    ctx.lineWidth = 2;
    for (const x of [a, b]) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }
  function setRange(a, b) {
    if (!duration || busy) return;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      say('Enter finite numeric start and end times.', 'error');
      refresh();
      return;
    }
    const step = Math.min(0.1, duration / 2);
    start = Math.max(0, Math.min(duration - step, a));
    end = Math.max(start + step, Math.min(duration, b));
    audio.pause();
    refresh();
    if (isApplied()) say('The selected clip is ready for separation.', 'success');
    else if (isTrimmed()) say('Selection changed. Apply this clip before starting separation.');
    else if (applied) say('Apply the new selection or restore the full original song.');
    else say('Full original song selected. Trim only if you want a shorter section.');
  }
  function releaseSource() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (source?.owned) urlApi.revokeObjectURL(source.url);
    source = null;
    decoded = null;
    loaded = false;
    duration = start = end = 0;
    applied = null;
  }
  async function loadSource({ engine, file }) {
    if (disposed || busy || !['demucs','roformer'].includes(engine) || !file ||
        typeof file.size !== 'number' || file.size < 1) return false;
    const token = ++epoch;
    // Switching engines must never leave a staged clip in the other engine.
    // Restore its selected source first; a later click must not separate
    // an old clip while the UI displays a different original.
    if (source && source.engine !== engine && applied) {
      try {
        if (source.engine === 'demucs') await onDemucsRestore();
        else await onRoFormerRestore(source.file);
      } catch (error) {
        say('Previous selected clip could not be restored: ' +
          String(error.message || error).slice(0, 140), 'error');
        return false;
      }
    }
    if (disposed || token !== epoch) return false;
    releaseSource();
    const name = String(file.name || 'audio').slice(0, 140);
    const url = urlApi.createObjectURL(file);
    source = { engine, name, file, url, owned: true };
    root.hidden = false;
    audio.src = url;
    say('Reading local audio and generating the waveform…');
    refresh();
    if (file.size > MAX_SOURCE_DECODE_BYTES) {
      say('Audio is over 180 MB. Full-song separation still works; clipping is unavailable for this source.', 'error');
      return false;
    }
    let context = null;
    try {
      const Context = windowRef.AudioContext || windowRef.webkitAudioContext;
      if (!Context) throw new Error('Web Audio decoding is unavailable.');
      context = new Context();
      const bytes = await file.arrayBuffer();
      const data = await context.decodeAudioData(bytes);
      if (disposed || token !== epoch) return false;
      if (!Number.isFinite(data.duration) || data.duration <= 0 ||
          data.duration > MAX_CLIP_SECONDS) {
        throw new Error('Audio preview supports songs up to 15 minutes.');
      }
      decoded = data;
      duration = data.duration;
      start = 0;
      end = duration;
      loaded = true;
      say('Drag the waveform handles or enter exact times in seconds. The original stays untouched.');
      refresh();
      return true;
    } catch (error) {
      if (!disposed && token === epoch) {
        decoded = null;
        loaded = false;
        say('Cannot prepare waveform: ' + String(error?.message || error).slice(0,180) +
          '. Full-song separation remains available.', 'error');
        refresh();
      }
      return false;
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }
  async function apply() {
    if (disposed || !source || !loaded || !isTrimmed() || busy) return false;
    const token = epoch;
    busy = true;
    refresh();
    say('Preparing a local PCM16 WAV of the selected section…');
    try {
      const wav = wavFromAudioBuffer(decoded, start, end);
      if (source.engine === 'demucs') {
        await onDemucsApply(wav);
      } else {
        const clippedFile = new File([wav], 'selected-clip.wav', { type: 'audio/wav' });
        await onRoFormerApply(clippedFile);
      }
      if (disposed || token !== epoch) return false;
      applied = { start, end };
      say('Clip applied. Start separation with the selected engine.', 'success');
      return true;
    } catch (error) {
      if (!disposed && token === epoch) say('Clip not applied: ' +
        String(error?.message || error).slice(0, 180), 'error');
      return false;
    } finally {
      busy = false;
      refresh();
    }
  }
  async function reset() {
    if (disposed || !source || busy) return;
    audio.pause();
    busy = true; refresh();
    try {
      if (applied) {
        if (source.engine === 'demucs') await onDemucsRestore();
        else await onRoFormerRestore(source.file);
      }
      start = 0; end = duration; applied = null;
      say('Original full song restored. No source audio was modified.', 'success');
    } catch (error) {
      say('Could not restore the original source: ' + error.message, 'error');
    } finally { busy = false; refresh(); }
  }
  async function preview() {
    if (!source || !duration || busy) return;
    try {
      audio.pause();
      audio.currentTime = start;
      await audio.play();
    } catch (error) {
      say('Could not preview this audio: ' + error.message, 'error');
    }
  }
  audio.addEventListener('timeupdate', () => {
    if (duration && audio.currentTime >= end - 0.015) {
      audio.pause();
      audio.currentTime = start;
    }
  });
  els.start.addEventListener('input', () => setRange(Number(els.start.value) / 1000 * duration, end));
  els.end.addEventListener('input', () => setRange(start, Number(els.end.value) / 1000 * duration));
  els.startNum.addEventListener('change', () => setRange(Number(els.startNum.value), end));
  els.endNum.addEventListener('change', () => setRange(start, Number(els.endNum.value)));
  els.apply.addEventListener('click', () => { void apply(); });
  els.reset.addEventListener('click', () => { void reset(); });
  els.preview.addEventListener('click', () => { void preview(); });
  els.stop.addEventListener('click', () => { audio.pause(); });
  function pointerTime(event) {
    const rect = els.waveform.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
  }
  els.waveform.addEventListener('pointerdown', (event) => {
    if (!loaded || busy) return;
    const time = pointerTime(event);
    dragHandle = Math.abs(start - time) < Math.abs(end - time) ? 'start' : 'end';
    els.waveform.setPointerCapture?.(event.pointerId);
    if (dragHandle === 'start') setRange(time, end);
    else setRange(start, time);
  });
  els.waveform.addEventListener('pointermove', (event) => {
    if (!dragHandle || !loaded) return;
    if (dragHandle === 'start') setRange(pointerTime(event), end);
    else setRange(start, pointerTime(event));
  });
  for (const type of ['pointerup','pointercancel']) {
    els.waveform.addEventListener(type, () => { dragHandle = null; });
  }
  refresh();
  return {
    loadSource,
    getSource: () => source ? { engine: source.engine, name: source.name } : null,
    getRange: () => ({ start, end, duration }),
    canSeparate(engine) {
      return !source || source.engine !== engine ||
        (!busy && (!isTrimmed() && !applied || isApplied()));
    },
    needsApply(engine) {
      return !!source && source.engine === engine &&
        (busy || isTrimmed() && !isApplied() || !isTrimmed() && !!applied);
    },
    warnNeedsApply() {
      say('The current range is not applied. Click Apply clip to separator, or Use full original.', 'error');
    },
    dispose() {
      disposed = true;
      ++epoch;
      releaseSource();
    },
  };
}
