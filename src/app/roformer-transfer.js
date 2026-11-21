// Host-side bridge for the optional local RoFormer studio.
// Data flow is one-way and user-initiated: parent requests the current stored
// stems, then accepts only validated File objects from the exact iframe
// window, with a nonce. No Electron IPC or native file access is involved.
export const ROFORMER_TRANSFER_REQUEST = 'kindling.roformer.stems.request.v1';
export const ROFORMER_TRANSFER_RESULT = 'kindling.roformer.stems.result.v1';
export const ROFORMER_TRANSFER_ERROR = 'kindling.roformer.stems.error.v1';
export const MAX_ROFORMER_IMPORT = 1024 * 1024 * 1024;
export const ROFORMER_ALLOWED_STEMS = Object.freeze([
  'drums', 'bass', 'vocals', 'guitar', 'piano', 'other',
]);

export function validRoFormerTransfer(stems, BlobType = Blob) {
  if (!Array.isArray(stems) || stems.length < 1 || stems.length > 6) return false;
  const used = new Set();
  let size = 0;
  for (const item of stems) {
    if (!item || !ROFORMER_ALLOWED_STEMS.includes(item.name) ||
        used.has(item.name) || !(item.file instanceof BlobType) ||
        item.file.size < 44 || item.file.size > 256 * 1024 * 1024) return false;
    used.add(item.name);
    size += item.file.size;
    if (size > MAX_ROFORMER_IMPORT) return false;
  }
  return true;
}

export function initRoFormerTransfer({
  root,
  frame,
  onFiles,
  windowRef = window,
  FileType = File,
  BlobType = Blob,
  timeoutMs = 20000,
} = {}) {
  if (!root || !frame) return null;
  const button = root.querySelector('#stem-mixer-import-direct');
  const status = root.querySelector('#stem-mixer-transfer-status');
  if (!button || !status) return null;
  let ready = false;
  let disposed = false;
  let request = null;

  function say(message, type = '') {
    if (disposed) return;
    status.textContent = message;
    status.dataset.kind = type;
  }
  function update() {
    button.disabled = disposed || !ready || !!request;
  }
  function invalidate() {
    if (request) clearTimeout(request.timeout);
    request = null;
    update();
  }
  function onLoad() {
    ready = frame.src === 'kindling-roformer://studio/index.html';
    invalidate();
    say(ready
      ? 'RoFormer ready. After separation, import its stored WAVs directly.'
      : 'Open the RoFormer workspace to enable direct import.');
  }
  function onFrameError() {
    ready = false;
    invalidate();
    say('RoFormer workspace could not be loaded.', 'error');
  }
  async function onMessage(event) {
    if (disposed || !request || event.source !== frame.contentWindow) return;
    // Custom Electron schemes can report an opaque "null" origin in some
    // Chromium versions. Source-window identity + an unguessable nonce are
    // mandatory even when origin is visible.
    if (!['kindling-roformer://studio', 'null'].includes(event.origin)) return;
    const message = event.data;
    if (!message || message.nonce !== request.nonce ||
        ![ROFORMER_TRANSFER_RESULT, ROFORMER_TRANSFER_ERROR].includes(message.type)) return;
    const expectedSession = request.expectedSession;
    invalidate();
    if (message.type === ROFORMER_TRANSFER_ERROR) {
      say('RoFormer import unavailable: ' + String(message.message || 'No completed stems').slice(0, 240), 'error');
      return;
    }
    if (expectedSession && message.session !== expectedSession) {
      say('RoFormer changed songs before its WAVs could be imported.', 'error');
      return;
    }
    if (expectedSession && (!Array.isArray(message.stems) || message.stems.length !== 6)) {
      say('RoFormer did not return all six completed WAVs.', 'error');
      return;
    }
    if (!validRoFormerTransfer(message.stems, BlobType)) {
      say('RoFormer supplied invalid or oversized audio files.', 'error');
      return;
    }
    // Assign canonical filenames so the existing six-channel mixer can
    // auto-recognize them without trusting arbitrary names from the frame.
    const files = message.stems.map(({ name, file }) =>
      new FileType([file], name + '.wav', { type: 'audio/wav' }));
    try {
      const imported = await onFiles(files);
      say(imported > 0
        ? 'Imported ' + imported + ' RoFormer WAV track(s) into the six-channel mixer.'
        : 'No RoFormer WAV tracks could be imported.', imported > 0 ? 'success' : 'error');
    } catch (error) {
      say('RoFormer WAV transfer failed: ' + String(error.message || error), 'error');
    }
  }
  function importNow(expectedSession = null) {
    if (disposed || !ready || request) return false;
    if (expectedSession !== null && !/^\d{10,18}$/.test(expectedSession)) {
      say('Invalid completed RoFormer session.', 'error');
      return false;
    }
    const receiver = frame.contentWindow;
    if (!receiver) {
      say('RoFormer workspace is not ready.', 'error');
      return false;
    }
    const nonce = windowRef.crypto.randomUUID();
    const timeout = setTimeout(() => {
      if (request?.nonce !== nonce) return;
      invalidate();
      say('RoFormer did not respond. Check that separation has finished.', 'error');
    }, timeoutMs);
    request = { nonce, timeout, expectedSession };
    update();
    say(expectedSession
      ? 'Automatically loading six completed RoFormer stems into the mixer…'
      : 'Reading completed RoFormer stems from its local song storage…');
    try {
      receiver.postMessage({
        type: ROFORMER_TRANSFER_REQUEST, nonce,
        ...(expectedSession ? { expectedSession } : {}),
      }, '*');
      return true;
    } catch (error) {
      invalidate();
      say('Cannot request RoFormer WAVs: ' + error.message, 'error');
      return false;
    }
  }

  button.addEventListener('click', () => importNow());
  frame.addEventListener('load', onLoad);
  frame.addEventListener('error', onFrameError);
  windowRef.addEventListener('message', onMessage);
  update();
  return {
    isReady: () => ready,
    importCompleted(session) { return importNow(session); },
    dispose() {
      disposed = true;
      invalidate();
      windowRef.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      frame.removeEventListener('error', onFrameError);
    },
  };
}
