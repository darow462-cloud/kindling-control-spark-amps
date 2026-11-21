// Browser/Electron presentation for local audio comparisons. No microphone
// capture starts without a user click and nothing is sent over the network.
import {
  analyzeAudioBuffer, compareAudioProfiles, AUDIO_BANDS,
  SPECTRUM_MIN_HZ, SPECTRUM_MAX_HZ, ANALYSIS_SECONDS,
  MAX_AUDIO_FILE_BYTES,
} from './audio-analysis.js';
import { generateReferencePreset } from './reference-preset.js';
import { presetToJson } from '../spark/messages.js';

const MAX_RECORD_SECONDS = 30;
const fmtTime = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDb = (v) => v <= -110 ? 'Silence' : `${v.toFixed(1)} dBFS`;
const fmtHz = (v) => v > 0 ? `${Math.round(v).toLocaleString()} Hz` : '—';

export function initAudioPanel(
  root = document.getElementById('panel-analysis'),
  { onApplyGeneratedPreset = async () => false } = {},
) {
  if (!root) return null;
  const $ = (id) => root.querySelector('#' + id);
  const tracks = { reference: { buffer: null, profile: null, url: null, loadId: 0 },
    guitar: { buffer: null, profile: null, url: null, loadId: 0 } };
  let context = null;
  let recorder = null;
  let inputStream = null;
  let stopTimer = null;
  let clockTimer = null;
  let recordingStartedAt = 0;
  let generatedPreset = null;
  let applyingGenerated = false;
  const proposalUi = {
    style: $('analysis-preset-style'),
    generate: $('analysis-preset-generate'),
    apply: $('analysis-preset-apply'),
    export: $('analysis-preset-export'),
    status: $('analysis-preset-status'),
    details: $('analysis-preset-details'),
  };

  function updateGeneratedPreview() {
    if (!proposalUi.status) return;
    const hasReference = !!tracks.reference.profile;
    proposalUi.generate.disabled = !hasReference || applyingGenerated;
    proposalUi.style.disabled = !hasReference || applyingGenerated;
    proposalUi.apply.disabled = !generatedPreset || applyingGenerated;
    proposalUi.export.disabled = !generatedPreset || applyingGenerated;
    proposalUi.details.replaceChildren();
    for (const note of generatedPreset?.summary || []) {
      const line = document.createElement('li');
      line.textContent = note;
      proposalUi.details.append(line);
    }
    if (!hasReference) {
      proposalUi.status.textContent =
        'Load a reference guitar track to generate a first-pass Spark 2 preset automatically.';
    } else if (generatedPreset && !applyingGenerated) {
      const position = Number($('analysis-reference-position').value) || 0;
      proposalUi.status.textContent = 'Suggested preset: ' + generatedPreset.preset.name +
        ' · reference section starts at ' + fmtTime(position) +
        ' · experimental estimate, not an exact tone clone.';
    }
  }

  function regenerateReferencePreset() {
    generatedPreset = null;
    if (tracks.reference.profile) {
      try {
        generatedPreset = generateReferencePreset(tracks.reference.profile, {
          style: proposalUi.style?.value || 'auto',
          referenceName: tracks.reference.fileName || 'Reference',
        });
      } catch (error) {
        if (proposalUi.status) {
          proposalUi.status.textContent = 'Cannot generate preset: ' +
            String(error.message || error).slice(0, 200);
        }
      }
    }
    updateGeneratedPreview();
  }

  async function audioContext() {
    if (!context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Web Audio decoding is not available in this build.');
      context = new Context();
    }
    return context;
  }

  function message(role, text, error = false) {
    const el = $('analysis-' + role + '-status');
    el.textContent = text;
    el.classList.toggle('analysis-error', error);
  }

  function positionLabel(role) {
    const seconds = Number($('analysis-' + role + '-position').value) || 0;
    $('analysis-' + role + '-start').textContent = fmtTime(seconds);
  }

  function analyzeTrack(role) {
    const item = tracks[role];
    if (!item.buffer) return;
    const seconds = Number($('analysis-' + role + '-position').value) || 0;
    item.profile = analyzeAudioBuffer(item.buffer, seconds);
    if (role === 'reference') regenerateReferencePreset();
    render();
  }

  function updatePlayer(role, url) {
    const player = $('analysis-' + role + '-player');
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (tracks[role].url) URL.revokeObjectURL(tracks[role].url);
    tracks[role].url = url;
    player.src = url;
    player.hidden = false;
    player.load();
  }

  async function loadTrack(file, role, { maxBytes = MAX_AUDIO_FILE_BYTES, rethrow = false } = {}) {
    if (!file) return;
    const item = tracks[role];
    const requestId = ++item.loadId;
    try {
      if (file.size > maxBytes) {
        throw new Error(`File exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB. Use a shorter audio excerpt.`);
      }
      if (file.size === 0) throw new Error('The selected audio file is empty.');
      message(role, `Decoding ${file.name} locally…`);
      const ctx = await audioContext();
      // decodeAudioData may detach the input ArrayBuffer; never reuse it.
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      if (requestId !== item.loadId) return; // ignore an older in-flight import
      if (!decoded.length || !decoded.duration) throw new Error('Decoded audio has no samples.');
      item.buffer = decoded;
      item.fileName = String(file.name || 'Reference');
      const range = $('analysis-' + role + '-position');
      range.disabled = false;
      range.min = '0';
      range.max = String(Math.max(0, Math.floor((decoded.duration - ANALYSIS_SECONDS) * 2) / 2));
      range.value = '0';
      positionLabel(role);
      const url = URL.createObjectURL(file);
      updatePlayer(role, url);
      item.profile = analyzeAudioBuffer(decoded, 0);
      if (role === 'reference') regenerateReferencePreset();
      message(role, `${file.name} · ${fmtTime(decoded.duration)} · ${decoded.sampleRate.toLocaleString()} Hz · analyzed first ${Math.min(ANALYSIS_SECONDS, decoded.duration).toFixed(1)} s`);
      render();
    } catch (err) {
      if (requestId === item.loadId) message(role, `Could not analyze: ${err.message}`, true);
      if (rethrow) throw err;
    }
  }

  async function loadImportedGuitar(file) {
    // User chose an exported RoFormer WAV explicitly in the local mixer.
    // The isolated RoFormer iframe cannot read files from the main application.
    if (!file || typeof file.name !== 'string' || !/\.wav$/i.test(file.name) ||
        typeof file.arrayBuffer !== 'function') {
      throw new Error('Choose a local RoFormer guitar WAV first.');
    }
    await loadTrack(file, 'reference', { maxBytes: 180 * 1024 * 1024, rethrow: true });
  }

  async function loadSeparatedGuitar(stem) {
    if (!stem || stem.name !== 'guitar' ||
        !/^kindling-stem:\/\/[a-f0-9-]+\/guitar\.wav$/.test(stem.url)) {
      throw new Error('Invalid generated guitar track address');
    }
    // Full WAV stems can be larger than imported MP3 files. Limit decoding to
    // one trusted guitar stem at a time to avoid overwhelming the renderer.
    const limit = 180 * 1024 * 1024;
    const response = await fetch(stem.url);
    if (!response.ok) throw new Error('Could not open the generated guitar WAV');
    const expected = Number(response.headers.get('content-length'));
    if (Number.isFinite(expected) && expected > limit) {
      throw new Error('Guitar WAV is over 180 MB; use a shorter song for analysis.');
    }
    const blob = await response.blob();
    if (blob.size > limit) throw new Error('Guitar WAV is over 180 MB; use a shorter song for analysis.');
    await loadTrack(new File([blob], 'Separated guitar.wav', { type: 'audio/wav' }),
      'reference', { maxBytes: limit, rethrow: true });
  }

  async function refreshInputs() {
    const select = $('analysis-mic-select');
    if (!navigator.mediaDevices?.enumerateDevices) {
      select.replaceChildren(new Option('Recording not supported in this environment', ''));
      $('analysis-record-start').disabled = true;
      return;
    }
    try {
      const before = select.value;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      select.replaceChildren(new Option('System default', ''));
      for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        if (d.deviceId && d.deviceId !== 'default') {
          select.append(new Option(d.label || `Audio input ${i + 1}`, d.deviceId));
        }
      }
      if ([...select.options].some((o) => o.value === before)) select.value = before;
    } catch (err) {
      message('guitar', `Could not list audio inputs: ${err.message}`, true);
    }
  }

  function stopRecording() {
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
  }

  function updateRecordingUi(active) {
    $('analysis-record-start').disabled = active || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined';
    $('analysis-record-stop').disabled = !active;
    $('analysis-mic-select').disabled = active;
    $('analysis-mic-refresh').disabled = active;
    if (!active) $('analysis-record-timer').textContent = 'Up to 30 seconds';
  }

  function cleanupCapture() {
    if (stopTimer) clearTimeout(stopTimer);
    if (clockTimer) clearInterval(clockTimer);
    stopTimer = null;
    clockTimer = null;
    inputStream?.getTracks().forEach((track) => track.stop());
    inputStream = null;
    recorder = null;
    updateRecordingUi(false);
    refreshInputs().catch(() => {});
  }

  async function startRecording() {
    if (recorder) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      message('guitar', 'Audio recording is unavailable. Import a WAV or MP3 recording instead.', true);
      return;
    }
    $('analysis-record-start').disabled = true;
    try {
      const device = $('analysis-mic-select').value;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(device ? { deviceId: { exact: device } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
        },
        video: false,
      });
      inputStream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((value) => MediaRecorder.isTypeSupported(value));
      const activeRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder = activeRecorder;
      const chunks = [];
      activeRecorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      activeRecorder.onerror = (event) => {
        message('guitar', `Recording failed: ${event.error?.message || 'unknown error'}`, true);
        cleanupCapture();
      };
      activeRecorder.onstop = async () => {
        const type = activeRecorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        cleanupCapture();
        if (blob.size) {
          const extension = type.includes('mp4') ? 'm4a' : 'webm';
          const file = new File([blob], `Guitar-recording-${Date.now()}.${extension}`, { type });
          await loadTrack(file, 'guitar');
        } else {
          message('guitar', 'No samples were recorded. Check the selected audio input.', true);
        }
      };
      activeRecorder.start(500);
      recordingStartedAt = performance.now();
      updateRecordingUi(true);
      message('guitar', 'Recording… play the riff. Audio stays local until you choose Stop.');
      clockTimer = setInterval(() => {
        const sec = Math.min(MAX_RECORD_SECONDS, (performance.now() - recordingStartedAt) / 1000);
        $('analysis-record-timer').textContent = `Recording ${sec.toFixed(1)} / ${MAX_RECORD_SECONDS} s`;
      }, 200);
      stopTimer = setTimeout(stopRecording, MAX_RECORD_SECONDS * 1000);
      refreshInputs().catch(() => {});
    } catch (err) {
      cleanupCapture();
      message('guitar', `Could not start recording: ${err.message}. Check Windows microphone access, or import an audio file.`, true);
    }
  }

  function renderMetrics() {
    const target = $('analysis-metrics');
    target.replaceChildren();
    for (const [key, title] of [['reference', 'Reference'], ['guitar', 'Your guitar']]) {
      const profile = tracks[key].profile;
      if (!profile) continue;
      const card = document.createElement('div');
      card.className = 'analysis-metric-card';
      const heading = document.createElement('strong');
      heading.textContent = title;
      card.append(heading);
      for (const [label, value] of [
        ['RMS', fmtDb(profile.rmsDb)],
        ['Peak', fmtDb(profile.peakDb)],
        ['Crest', `${profile.crestDb.toFixed(1)} dB`],
        ['Spectral center', fmtHz(profile.centroidHz)],
      ]) {
        const line = document.createElement('div');
        const term = document.createElement('span');
        const result = document.createElement('b');
        term.textContent = label;
        result.textContent = value;
        line.append(term, result);
        card.append(line);
      }
      target.append(card);
    }
  }

  function renderBands() {
    const tbody = $('analysis-band-body');
    const a = tracks.reference.profile;
    const b = tracks.guitar.profile;
    tbody.replaceChildren();
    for (let i = 0; i < AUDIO_BANDS.length; i++) {
      const band = AUDIO_BANDS[i];
      const ref = a?.bands[i].percent;
      const guitar = b?.bands[i].percent;
      const tr = document.createElement('tr');
      for (const value of [
        `${band.label} (${band.low}–${band.high >= 1000 ? (band.high / 1000) + 'k' : band.high} Hz)`,
        ref == null ? '—' : `${ref.toFixed(1)}%`,
        guitar == null ? '—' : `${guitar.toFixed(1)}%`,
        ref == null || guitar == null ? '—' : `${guitar >= ref ? '+' : ''}${(guitar - ref).toFixed(1)} pp`,
      ]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  function renderAdvice() {
    const target = $('analysis-advice');
    const a = tracks.reference.profile;
    const b = tracks.guitar.profile;
    const messages = a && b
      ? compareAudioProfiles(a, b)
      : ['Load both a reference and your guitar track to compare relative frequency energy.'];
    target.replaceChildren(...messages.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
  }

  function drawSpectrum() {
    const canvas = $('analysis-spectrum');
    const context = canvas.getContext('2d');
    if (!context) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = Math.max(320, canvas.clientWidth || 760);
    const cssHeight = cssWidth < 540 ? 265 : 330;
    const canvasWidth = Math.round(cssWidth * scale);
    const canvasHeight = Math.round(cssHeight * scale);
    // Avoid repeatedly changing intrinsic canvas dimensions from within
    // ResizeObserver: that can cause another resize notification.
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const w = cssWidth, h = cssHeight;
    const margin = { left: 46, right: 18, top: 19, bottom: 34 };
    const x0 = margin.left, y0 = margin.top;
    const pw = w - x0 - margin.right, ph = h - y0 - margin.bottom;
    context.fillStyle = '#15191f';
    context.fillRect(0, 0, w, h);
    context.font = '11px system-ui, sans-serif';
    context.lineWidth = 1;
    for (let dB = 0; dB >= -75; dB -= 15) {
      const y = y0 - (dB / 75) * ph;
      context.strokeStyle = '#303842';
      context.beginPath(); context.moveTo(x0, y); context.lineTo(x0 + pw, y); context.stroke();
      context.fillStyle = '#aab3c0';
      context.fillText(`${dB} dB`, 5, y + 4);
    }
    for (const freq of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = x0 + pw * Math.log(freq / SPECTRUM_MIN_HZ) / Math.log(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ);
      context.strokeStyle = '#262e37';
      context.beginPath(); context.moveTo(x, y0); context.lineTo(x, y0 + ph); context.stroke();
      context.fillStyle = '#aab3c0';
      const label = freq >= 1000 ? `${freq / 1000}k` : String(freq);
      context.fillText(label, x - context.measureText(label).width / 2, h - 12);
    }
    for (const [key, color] of [['reference', '#f5a524'], ['guitar', '#55c0e9']]) {
      const points = tracks[key].profile?.spectrum;
      if (!points) continue;
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = 2.5;
      for (let i = 0; i < points.length; i++) {
        const x = x0 + pw * ((i + 0.5) / points.length);
        const y = y0 + (Math.max(0, Math.min(75, -points[i])) / 75) * ph;
        if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
  }

  function render() {
    updateGeneratedPreview();
    renderMetrics();
    renderBands();
    renderAdvice();
    drawSpectrum();
  }

  for (const role of ['reference', 'guitar']) {
    $('analysis-' + role + '-file').addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) loadTrack(file, role);
    });
    $('analysis-' + role + '-position').addEventListener('input', () => positionLabel(role));
    $('analysis-' + role + '-position').addEventListener('change', () => {
      const start = Number($('analysis-' + role + '-position').value) || 0;
      const player = $('analysis-' + role + '-player');
      // Keep the audible excerpt aligned with the section shown in the plot.
      try { player.currentTime = start; } catch { /* metadata may not be ready */ }
      analyzeTrack(role);
    });
  }
  proposalUi.style?.addEventListener('change', () => {
    regenerateReferencePreset();
    render();
  });
  proposalUi.generate?.addEventListener('click', () => {
    regenerateReferencePreset();
    render();
  });
  proposalUi.export?.addEventListener('click', () => {
    if (!generatedPreset || applyingGenerated) return;
    const preset = generatedPreset.preset;
    // Use the same interchange format as My presets > Import/Export.
    const blob = new Blob([JSON.stringify(presetToJson(preset), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = preset.name.replace(/[^a-z0-9._-]+/gi, '_') + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  proposalUi.apply?.addEventListener('click', async () => {
    if (!generatedPreset || applyingGenerated) return;
    applyingGenerated = true;
    const proposal = structuredClone(generatedPreset.preset);
    updateGeneratedPreview();
    proposalUi.status.textContent = 'Loading the suggested preset into the tone editor…';
    try {
      const result = await onApplyGeneratedPreset(proposal);
      if (result === false) {
        proposalUi.status.textContent = 'The preset was not loaded. Existing tone left unchanged.';
      } else {
        proposalUi.status.textContent = 'Preset loaded into the tone editor. Adjust and Save it if you like.';
      }
    } catch (error) {
      proposalUi.status.textContent = 'Cannot load Spark 2 preset: ' +
        String(error.message || error).slice(0, 200);
    } finally {
      applyingGenerated = false;
      proposalUi.generate.disabled = !tracks.reference.profile;
      proposalUi.style.disabled = !tracks.reference.profile;
      proposalUi.apply.disabled = !generatedPreset;
      proposalUi.export.disabled = !generatedPreset;
    }
  });
  $('analysis-mic-refresh').addEventListener('click', () => refreshInputs());
  $('analysis-record-start').addEventListener('click', startRecording);
  $('analysis-record-stop').addEventListener('click', stopRecording);
  updateRecordingUi(false);
  refreshInputs().catch(() => {});
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => drawSpectrum());
    observer.observe($('analysis-spectrum'));
  }
  window.addEventListener('pagehide', () => {
    try { stopRecording(); } catch { /* ignore */ }
    inputStream?.getTracks().forEach((track) => track.stop());
    for (const track of Object.values(tracks)) if (track.url) URL.revokeObjectURL(track.url);
    context?.close().catch(() => {});
  });
  render();
  return { redraw: drawSpectrum, loadSeparatedGuitar, loadImportedGuitar };
}
