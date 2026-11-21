// KindlingControl-owned companion for the pinned Stemyla WebGPU studio.
// Installed only in the isolated kindling-roformer://studio origin at packaging.
// Stemyla v b2a7718 stores complete PCM16 WAV stems in:
//   sessions/current -> session id
//   sessions/<id>/meta -> "stem\t<name>" lines
//   sessions/<id>/stems/<name>.wav
// Read ONLY the current session's completed six stems, and send File handles
// to the embedding KindlingControl window after an explicit user request.
// No Node, no network, no filesystem outside this origin, no model control.
(() => {
  'use strict';
  const REQUEST = 'kindling.roformer.stems.request.v1';
  const RESULT = 'kindling.roformer.stems.result.v1';
  const ERROR = 'kindling.roformer.stems.error.v1';
  const COMPLETED = 'kindling.roformer.stems.completed.v1';
  const ALLOWED = new Set(['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']);
  const MAX_FILE = 256 * 1024 * 1024;
  const MAX_TOTAL = 1024 * 1024 * 1024;
  let busy = false;

  async function child(dir, name) {
    return dir.getDirectoryHandle(name, { create: false });
  }
  async function file(dir, name) {
    const handle = await dir.getFileHandle(name, { create: false });
    return handle.getFile();
  }
  function fileName(stemName) {
    // Same stem_file() sanitizer as pinned Stemyla stem_protocol v b2a7718.
    return Array.from(stemName).map((char) =>
      /[\p{L}\p{N} -]/u.test(char) ? char : '_').join('') + '.wav';
  }
  async function isPcmWav(blob) {
    if (!blob || blob.size < 44 || blob.size > MAX_FILE) return false;
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const tag = (offset) => String.fromCharCode(...head.slice(offset, offset + 4));
    return (tag(0) === 'RIFF' || tag(0) === 'RF64') && tag(8) === 'WAVE';
  }
  async function getStems(expectedSession = null) {
    if (!navigator.storage?.getDirectory) {
      throw new Error('Browser storage is unavailable for RoFormer.');
    }
    const root = await navigator.storage.getDirectory();
    const sessions = await child(root, 'sessions');
    const current = (await (await file(sessions, 'current')).text()).trim();
    if (!/^\d{10,18}$/.test(current)) {
      throw new Error('No valid RoFormer song session is open.');
    }
    // A completed run is bound to a specific session, so reopening another
    // song cannot import the old WAVs by accident.
    if (expectedSession !== null && expectedSession !== current) {
      throw new Error('The completed RoFormer session is no longer current.');
    }
    const session = await child(sessions, current);
    const meta = await (await file(session, 'meta')).text();
    const stemNames = meta.split(/\r?\n/)
      .filter((line) => line.startsWith('stem\t'))
      .map((line) => line.split('\t')[1]?.trim())
      .filter(Boolean);
    if (!stemNames.length) {
      throw new Error('This song has no completed RoFormer stems yet.');
    }
    const directory = await child(session, 'stems');
    const stems = [];
    const used = new Set();
    let total = 0;
    for (const name of stemNames) {
      const id = name.toLowerCase();
      if (!ALLOWED.has(id) || used.has(id)) continue;
      used.add(id);
      const wav = await file(directory, fileName(name));
      if (!(await isPcmWav(wav))) {
        throw new Error('RoFormer WAV for ' + name + ' is missing, too large or incomplete.');
      }
      total += wav.size;
      if (total > MAX_TOTAL) {
        throw new Error('RoFormer stems exceed the 1 GB in-app import safety limit.');
      }
      stems.push({ name: id, file: wav });
    }
    if (!stems.length) {
      throw new Error('No supported six-stem RoFormer WAVs were found.');
    }
    if (expectedSession && stems.length !== 6) {
      throw new Error('The completed session does not contain all six WAV stems.');
    }
    return { stems, session: current };
  }

  // User-driven control channel for a *locally rebuilt* pinned Stemyla WASM.
  // The Rust app polls this queue from its normal UI frame and calls its
  // existing model/song/separation methods. JS never reaches into egui canvas
  // coordinates, triggers an automatic model download or opens arbitrary files.
  const controlQueue = [];
  let lastState = '';
  let lastStateSent = -Infinity;
  const COMMAND = 'kindling.roformer.control.command.v1';
  const ACK = 'kindling.roformer.control.ack.v1';
  const STATE = 'kindling.roformer.control.state.v1';
  const SOURCE_AUDIO = /\.(wav|aiff|aif|flac|mp3|ogg|m4a|aac)$/i;
  window.__kindlingControl = {
    available: true,
    take() { return controlQueue.shift() ?? null; },
    ack(nonce, ok, message) {
      window.parent.postMessage({ type: ACK, nonce, ok, message }, '*');
    },
    completed(nonce, session) {
      // A Rust callback is issued only after Stemyla commits its WAV files
      // and meta. The parent must independently match this to the accepted
      // separate command before making any request.
      if (/^[a-zA-Z0-9-]{16,80}$/.test(nonce) &&
          /^\d{10,18}$/.test(session)) {
        window.parent.postMessage({ type: COMPLETED, nonce, session }, '*');
      }
    },
    report(modelReady, modelLoading, downloadDone, downloadTotal,
      separating, progressDone, progressTotal, songLoaded, canSeparate, stopped, text) {
      const state = {
        modelReady, modelLoading, downloadDone, downloadTotal, separating,
        progressDone, progressTotal, songLoaded, canSeparate, stopped,
        text: String(text || '').slice(0, 240),
      };
      const serialized = JSON.stringify(state);
      const now = performance.now();
      if (serialized !== lastState || now - lastStateSent >= 2000) {
        lastState = serialized;
        lastStateSent = now;
        window.parent.postMessage({ type: STATE, state }, '*');
      }
    },
  };

  window.addEventListener('message', (event) => {
    if (window.parent === window || event.source !== window.parent ||
        !['kindling://app', 'null'].includes(event.origin)) return;
    const data = event.data;
    if (!data || data.type !== COMMAND ||
        typeof data.nonce !== 'string' ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(data.nonce) ||
        !['open_song', 'download_model', 'separate'].includes(data.action)) return;
    if (controlQueue.length >= 2) {
      window.parent.postMessage({
        type: ACK, nonce: data.nonce, ok: false,
        message: 'Another RoFormer action is still pending.',
      }, '*');
      return;
    }
    if (data.action === 'open_song') {
      const file = data.file;
      if (!(file instanceof File) || !SOURCE_AUDIO.test(file.name) ||
          file.size < 1 || file.size > 350 * 1024 * 1024) {
        window.parent.postMessage({
          type: ACK, nonce: data.nonce, ok: false,
          message: 'Choose a supported audio file under 350 MB.',
        }, '*');
        return;
      }
      controlQueue.push({ action: 'open_song', file, nonce: data.nonce });
    } else {
      controlQueue.push({ action: data.action, nonce: data.nonce });
    }
  });

  window.addEventListener('message', async (event) => {
    if (window.parent === window || event.source !== window.parent ||
        !['kindling://app', 'null'].includes(event.origin)) return;
    const data = event.data;
    if (!data || data.type !== REQUEST ||
        typeof data.nonce !== 'string' ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(data.nonce) || busy) return;
    busy = true;
    try {
      const expectedSession = typeof data.expectedSession === 'string' &&
          /^\d{10,18}$/.test(data.expectedSession)
        ? data.expectedSession : null;
      // An invalid session marker must fail closed rather than reading
      // whichever track happens to be open now.
      if (data.expectedSession != null && !expectedSession) {
        throw new Error('Invalid completed-session identifier.');
      }
      const { stems, session } = await getStems(expectedSession);
      // File and Blob objects are structured-cloned without copying audio
      // into JS arrays. This does not submit anything over the network.
      window.parent.postMessage({ type: RESULT, nonce: data.nonce, stems, session }, '*');
    } catch (error) {
      window.parent.postMessage({
        type: ERROR,
        nonce: data.nonce,
        message: String(error?.message || 'Could not access stored RoFormer WAVs').slice(0, 240),
      }, '*');
    } finally {
      busy = false;
    }
  });
})();
