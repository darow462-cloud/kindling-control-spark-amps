// User-facing RoFormer controls backed by Stemyla's own Rust state methods.
// Works only with the pinned Stemyla WASM rebuilt with the Kindling bridge;
// never attempts synthetic canvas clicks. The existing embedded studio is a
// visible fallback when its command/status bridge cannot be initialized.
const COMMAND = 'kindling.roformer.control.command.v1';
const ACK = 'kindling.roformer.control.ack.v1';
const STATE = 'kindling.roformer.control.state.v1';
const COMPLETED = 'kindling.roformer.stems.completed.v1';
const STUDIO_URL = 'kindling-roformer://studio/index.html';
const MAX_SONG_BYTES = 350 * 1024 * 1024;
const AUDIO_FILE = /\.(wav|aiff|aif|flac|mp3|ogg|m4a|aac)$/i;

export function validRoFormerSong(file, FileType = File) {
  return file instanceof FileType &&
    typeof file.name === 'string' && AUDIO_FILE.test(file.name) &&
    file.size > 0 && file.size <= MAX_SONG_BYTES;
}

export function initRoFormerControls({
  root,
  frame,
  windowRef = window,
  FileType = File,
  timeoutMs = 15000,
  onCompleted = () => {},
} = {}) {
  if (!root || !frame) return null;
  const $ = (name) => root.querySelector('#' + name);
  const choose = $('stem-roformer-choose-song');
  const selected = $('stem-roformer-song-file');
  const download = $('stem-roformer-download');
  const start = $('stem-roformer-separate');
  const songName = $('stem-roformer-song-name');
  const status = $('stem-roformer-control-status');
  const progress = $('stem-roformer-control-progress');
  if (![choose,selected,download,start,songName,status,progress].every(Boolean)) return null;

  let state = null;
  let pending = null;
  let acceptedSeparation = null;
  let disposed = false;
  function say(message, kind = '') {
    if (disposed) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }
  function render() {
    if (disposed) return;
    const busy = !!pending || !!state?.separating || !!state?.modelLoading ||
      Number(state?.downloadTotal) > 0 && Number(state?.downloadDone) < Number(state?.downloadTotal);
    choose.disabled = !state || !!pending || !!state.separating;
    download.disabled = !state || busy || !!state.modelReady || !!state.stopped;
    start.disabled = !state || busy || !state.canSeparate || !!state.stopped;
    const progressDone = Number(state?.progressDone) || 0;
    const progressTotal = Number(state?.progressTotal) || 0;
    const downloading = Number(state?.downloadTotal) > 0 && Number(state?.downloadDone) <
      Number(state?.downloadTotal);
    const fraction = state?.separating && progressTotal > 0
      ? progressDone / progressTotal
      : downloading ? Number(state.downloadDone) / Number(state.downloadTotal) : null;
    progress.hidden = fraction === null;
    if (fraction !== null) progress.value = String(Math.min(100, Math.max(0, fraction * 100)));
  }
  function forgetPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    render();
  }
  function send(action, file) {
    if (disposed || !state || pending || frame.src !== STUDIO_URL) return false;
    if (action === 'open_song' && !validRoFormerSong(file, FileType)) {
      say('Choose a supported song under 350 MB.', 'error');
      return false;
    }
    if (action === 'download_model' && (state.modelReady || state.modelLoading)) return false;
    if (action === 'separate' && !state.canSeparate) return false;
    const target = frame.contentWindow;
    if (!target) return false;
    const nonce = windowRef.crypto.randomUUID();
    pending = {
      nonce,
      action,
      timer: setTimeout(() => {
        if (pending?.nonce !== nonce) return;
        forgetPending();
        say('RoFormer did not acknowledge the action. Open Advanced Studio for details.', 'error');
      }, timeoutMs),
    };
    render();
    say(action === 'open_song' ? 'Opening selected song in RoFormer…' :
      action === 'download_model' ? 'Starting the model download from the Stemyla worker…' :
      'Starting local GPU separation…');
    try {
      target.postMessage({ type: COMMAND, nonce, action, ...(file ? { file } : {}) }, '*');
    } catch (error) {
      forgetPending();
      say('Could not send command to RoFormer: ' + error.message, 'error');
      return false;
    }
    return true;
  }
  function onMessage(event) {
    if (disposed || event.source !== frame.contentWindow ||
        !['kindling-roformer://studio', 'null'].includes(event.origin) ||
        !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    if (message.type === STATE) {
      const next = message.state;
      if (!next || typeof next !== 'object' ||
          typeof next.modelReady !== 'boolean' ||
          typeof next.songLoaded !== 'boolean' ||
          typeof next.separating !== 'boolean' ||
          typeof next.canSeparate !== 'boolean') return;
      state = next;
      if (!pending) {
        if (next.stopped) say('RoFormer worker stopped. Open Advanced Studio for the error.', 'error');
        else if (next.separating) say('Separating six stems on your GPU… ' +
          (next.progressTotal > 0 ? next.progressDone + '/' + next.progressTotal + ' chunks' : ''));
        else if (next.modelLoading) say('Loading BS-RoFormer SW model into WebGPU…');
        else if (next.downloadTotal > 0 && next.downloadDone < next.downloadTotal) {
          say('Downloading model: ' + Math.round(next.downloadDone / 1e6) + ' MB');
        } else if (next.canSeparate) say('Song and model are ready. Press Separate 6 tracks.');
        else if (!next.modelReady) say('BS-RoFormer SW model not loaded. Download only if you accept its terms.');
        else if (!next.songLoaded) say('Choose a song to separate.');
        else say(String(next.text || 'RoFormer is preparing…').slice(0, 220));
      }
      render();
    } else if (message.type === ACK && pending && message.nonce === pending.nonce) {
      const action = pending.action;
      const nonce = pending.nonce;
      forgetPending();
      if (!message.ok) {
        say(String(message.message || 'RoFormer rejected the action.').slice(0, 240), 'error');
      } else {
        if (action === 'open_song') acceptedSeparation = null;
        if (action === 'separate') acceptedSeparation = nonce;
        say(action === 'open_song' ? 'Opening song in the RoFormer workspace…' :
          action === 'download_model' ? 'Model download requested. It is not automatic.' :
          'Separation requested. Results will be available after processing.');
      }
    } else if (message.type === COMPLETED &&
        acceptedSeparation !== null &&
        message.nonce === acceptedSeparation &&
        typeof message.session === 'string' &&
        /^\d{10,18}$/.test(message.session)) {
      // Only a successfully acknowledged native Kindling action can trigger
      // auto-import. No import occurs on startup, old storage restore or a
      // manual separation launched inside the Advanced Studio.
      acceptedSeparation = null;
      say('RoFormer finished saving all six tracks. Importing into mixer…');
      try {
        onCompleted({ nonce: message.nonce, session: message.session });
      } catch (error) {
        say('Auto-import could not start: ' + error.message, 'error');
      }
    }
  }
  function onLoad() {
    state = null;
    acceptedSeparation = null;
    forgetPending();
    say('Connecting to the native RoFormer controls…');
    render();
  }
  choose.addEventListener('click', () => { if (!choose.disabled) selected.click(); });
  selected.addEventListener('change', () => {
    const file = selected.files?.[0];
    selected.value = '';
    if (!file) return;
    if (send('open_song', file)) songName.textContent = file.name;
  });
  download.addEventListener('click', () => { if (!download.disabled) send('download_model'); });
  start.addEventListener('click', () => { if (!start.disabled) send('separate'); });
  windowRef.addEventListener('message', onMessage);
  frame.addEventListener('load', onLoad);
  render();
  return {
    getState: () => state,
    dispose() {
      acceptedSeparation = null;
      disposed = true;
      forgetPending();
      windowRef.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
    },
  };
}
