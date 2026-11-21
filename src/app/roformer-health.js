// On-demand RoFormer diagnostics for the pinned isolated WebGPU studio.
// No native filesystem access, song names, user paths, GPU identifiers,
// model weights, audio payloads or network requests are used here.
export const ROFORMER_HEALTH_REQUEST = 'kindling.roformer.health.request.v1';
export const ROFORMER_HEALTH_RESULT = 'kindling.roformer.health.result.v1';
const STUDIO_URL = 'kindling-roformer://studio/index.html';
const ALLOWED_ORIGINS = new Set(['kindling-roformer://studio', 'null']);
const BOOLS = ['bridge', 'nativeReports', 'webgpuApi', 'opfsApi', 'studioCanvas'];

export function isValidHealth(health) {
  return !!health && typeof health === 'object' &&
    BOOLS.every((key) => typeof health[key] === 'boolean');
}

export function formatRoFormerHealth({
  health, state = null, lastStateAt = 0, loadedTracks = 0,
  now = Date.now(), version = '0.7.7',
} = {}) {
  const label = (v) => v ? 'yes' : 'no';
  const age = lastStateAt > 0 && now >= lastStateAt
    ? Math.floor((now - lastStateAt) / 1000) : null;
  const fresh = health?.nativeReports && age !== null && age <= 10;
  const model = state ? (state.modelReady ? 'ready' : 'not ready') : 'unknown';
  const progress = state
    ? (state.separating ? 'processing' : state.modelLoading ? 'loading model' : 'idle')
    : 'unknown';
  const trackCount = Math.max(0, Math.min(6, Number.isFinite(loadedTracks) ? loadedTracks : 0));
  const lines = [
    'KindlingControl RoFormer diagnostic — ' + String(version).slice(0, 32),
    'Studio JavaScript bridge: ' + label(health?.bridge),
    'Native Rust reports: ' + (fresh ? 'recent' : health?.nativeReports ? 'stale' : 'not observed'),
    'Native report age: ' + (age === null ? 'unknown' : age + ' s'),
    'WebGPU browser API: ' + label(health?.webgpuApi),
    'Local OPFS browser API: ' + label(health?.opfsApi),
    'Stemyla canvas: ' + label(health?.studioCanvas),
    'Model: ' + model,
    'Processing: ' + progress,
    'RoFormer mixer tracks: ' + trackCount + '/6',
  ];
  if (!health?.webgpuApi) lines.push('Hint: WebGPU is unavailable; check GPU acceleration.');
  if (!health?.opfsApi) lines.push('Hint: direct WAV import needs OPFS; manual WAV import remains available.');
  if (!fresh) lines.push('Hint: no recent Rust status; open Advanced Studio to inspect the workspace.');
  lines.push('This is an API/status check, not a full GPU inference or audio-quality test.');
  return lines.join('\n');
}

export function initRoFormerHealth({
  root, frame, controls = null, mixer = null,
  windowRef = window, clipboardRef = globalThis.navigator?.clipboard,
  timeoutMs = 8000,
} = {}) {
  if (!root || !frame) return null;
  const button = root.querySelector('#stem-roformer-check-health');
  const copy = root.querySelector('#stem-roformer-copy-health');
  const output = root.querySelector('#stem-roformer-health-report');
  const status = root.querySelector('#stem-roformer-health-status');
  if (![button, copy, output, status].every(Boolean)) return null;
  let pending = null;
  let disposed = false;
  let report = '';

  function say(message, error = false) {
    if (disposed) return;
    status.textContent = message;
    status.dataset.kind = error ? 'error' : '';
  }
  function cancel() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    button.disabled = disposed;
  }
  function onLoad() {
    cancel();
    report = '';
    output.textContent = '';
    copy.disabled = true;
    say('Studio reloaded. Run the diagnostic again to check its new state.');
  }
  function onMessage(event) {
    if (disposed || !pending ||
        event.source !== frame.contentWindow ||
        !ALLOWED_ORIGINS.has(event.origin) ||
        event.data?.type !== ROFORMER_HEALTH_RESULT ||
        event.data.nonce !== pending.nonce) return;
    const health = event.data.health;
    cancel();
    if (!isValidHealth(health)) {
      say('RoFormer returned an invalid health response.', true);
      return;
    }
    const state = controls?.getState?.() ?? null;
    report = formatRoFormerHealth({
      health, state,
      lastStateAt: controls?.getLastStateAt?.() ?? 0,
      loadedTracks: mixer?.getLoadedNames?.('roformer')?.length ?? 0,
    });
    output.textContent = report;
    copy.disabled = false;
    if (!health.bridge || !health.nativeReports) {
      say('Some components are not responding. See diagnostic and Advanced Studio.', true);
    } else if (!health.webgpuApi || !health.opfsApi) {
      say('Browser capabilities are limited. Manual WAV import may be required.', true);
    } else {
      say('Interfaces are present. This does not verify GPU inference.');
    }
  }
  function check() {
    if (disposed || pending) return;
    if (frame.src !== STUDIO_URL || !frame.contentWindow) {
      say('Select the RoFormer engine in Stems and open its workspace first.', true);
      return;
    }
    const nonce = windowRef.crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pending?.nonce !== nonce) return;
      cancel();
      say('The embedded RoFormer bridge did not respond. Open Advanced Studio.', true);
    }, timeoutMs);
    pending = { nonce, timer };
    button.disabled = true;
    say('Checking the isolated RoFormer studio without accessing your audio…');
    try {
      frame.contentWindow.postMessage({ type: ROFORMER_HEALTH_REQUEST, nonce }, '*');
    } catch (error) {
      cancel();
      say('Could not contact RoFormer: ' + String(error?.message || error).slice(0, 160), true);
    }
  }
  async function copyReport() {
    if (disposed || !report) return;
    if (!clipboardRef?.writeText) {
      say('Clipboard unavailable. Select the diagnostic text to copy it.', true);
      return;
    }
    try {
      await clipboardRef.writeText(report);
      say('Diagnostic copied. It contains no filenames or personal paths.');
    } catch {
      say('Clipboard unavailable. Select the diagnostic text to copy it.', true);
    }
  }
  button.addEventListener('click', check);
  copy.addEventListener('click', () => { void copyReport(); });
  frame.addEventListener('load', onLoad);
  windowRef.addEventListener('message', onMessage);
  copy.disabled = true;
  button.disabled = false;
  return {
    getReport: () => report,
    dispose() {
      disposed = true;
      cancel();
      frame.removeEventListener('load', onLoad);
      windowRef.removeEventListener('message', onMessage);
    },
  };
}
