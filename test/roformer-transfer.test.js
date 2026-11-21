import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  initRoFormerTransfer,
  validRoFormerTransfer,
  ROFORMER_TRANSFER_REQUEST,
  ROFORMER_TRANSFER_RESULT,
  ROFORMER_TRANSFER_ERROR,
} from '../src/app/roformer-transfer.js';

const wav = () => {
  const data = new Uint8Array(48);
  const label = (offset, word) => {
    for (let i = 0; i < word.length; i++) data[offset + i] = word.charCodeAt(i);
  };
  label(0, 'RIFF');
  label(8, 'WAVE');
  return new Blob([data], { type: 'audio/wav' });
};
class FakeFile extends Blob {
  constructor(parts, name, opts) {
    super(parts, opts);
    this.name = name;
  }
}
class Element {
  constructor() {
    this.handlers = new Map();
    this.disabled = true;
    this.dataset = {};
    this.textContent = '';
    this.src = '';
  }
  addEventListener(name, callback) {
    const list = this.handlers.get(name) ?? [];
    list.push(callback);
    this.handlers.set(name, list);
  }
  removeEventListener(name, callback) {
    this.handlers.set(name, (this.handlers.get(name) ?? []).filter((fn) => fn !== callback));
  }
  trigger(name, event = {}) {
    for (const callback of this.handlers.get(name) ?? []) callback(event);
  }
  click() { this.trigger('click'); }
}
function host() {
  const button = new Element();
  const status = new Element();
  const requests = [];
  const frame = new Element();
  frame.contentWindow = {
    postMessage: (message) => requests.push(message),
  };
  const win = new Element();
  win.crypto = { randomUUID: () => 'ba0f0916-d4a0-4d2b-a0a7-abcd12345aaa' };
  const imports = [];
  const root = {
    querySelector: (selector) => ({
      '#stem-mixer-import-direct': button,
      '#stem-mixer-transfer-status': status,
    })[selector],
  };
  const transfer = initRoFormerTransfer({
    root, frame, windowRef: win, BlobType: Blob, FileType: FakeFile,
    onFiles: (files) => { imports.push(files); return files.length; },
    timeoutMs: 100,
  });
  function load() {
    frame.src = 'kindling-roformer://studio/index.html';
    frame.trigger('load');
  }
  function answer(type, stems, opts = {}) {
    win.trigger('message', {
      source: opts.source ?? frame.contentWindow,
      origin: opts.origin ?? 'kindling-roformer://studio',
      data: { type, nonce: opts.nonce ?? requests[0]?.nonce, stems, message: opts.message },
    });
  }
  return { button, status, requests, imports, frame, win, transfer, load, answer };
}
test('Host imports only after a user click and an origin/source/nonce-validated answer', async () => {
  const f = host();
  assert.equal(f.button.disabled, true);
  f.load();
  assert.equal(f.button.disabled, false);
  assert.deepEqual(f.imports, []);
  f.button.click();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].type, ROFORMER_TRANSFER_REQUEST);
  assert.equal(f.button.disabled, true);
  const stems = [{ name: 'guitar', file: wav() }];
  f.answer(ROFORMER_TRANSFER_RESULT, stems, { origin: 'https://evil.invalid' });
  f.answer(ROFORMER_TRANSFER_RESULT, stems, { source: {} });
  f.answer(ROFORMER_TRANSFER_RESULT, stems, { nonce: 'wrong' });
  assert.equal(f.imports.length, 0);
  f.answer(ROFORMER_TRANSFER_RESULT, stems);
  await Promise.resolve();
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0][0].name, 'guitar.wav');
  assert.equal(f.button.disabled, false);
  f.transfer.dispose();
});

test('Malformed, duplicates and oversized payloads are rejected', async () => {
  assert.equal(validRoFormerTransfer([], Blob), false);
  assert.equal(validRoFormerTransfer([{ name: 'guitar', file: wav() }], Blob), true);
  assert.equal(validRoFormerTransfer([
    { name: 'guitar', file: wav() }, { name: 'guitar', file: wav() },
  ], Blob), false);
  assert.equal(validRoFormerTransfer([{ name: '../secret', file: wav() }], Blob), false);
  assert.equal(validRoFormerTransfer([{ name: 'guitar', file: 'not-a-blob' }], Blob), false);
  const f = host();
  f.load();
  f.button.click();
  f.answer(ROFORMER_TRANSFER_RESULT, [{ name: 'guitar', file: 'not-a-blob' }]);
  await Promise.resolve();
  assert.equal(f.imports.length, 0);
  assert.match(f.status.textContent, /invalid or oversized/);
  f.transfer.dispose();
});

test('Child reports missing stored stems without exposing arbitrary OPFS contents', async () => {
  const source = readFileSync(new URL('../desktop/roformer-transfer-bridge.js', import.meta.url), 'utf8');
  let handler;
  const responses = [];
  const sessions = {
    async getFileHandle(name) {
      if (name === 'current') return { async getFile() { return new Blob(['1763730000000']); } };
      throw Error('Missing file');
    },
    async getDirectoryHandle(name) {
      if (name === '1763730000000') return {
        async getFileHandle(file) {
          if (file === 'meta') return {
            async getFile() { return new Blob(['name\tSong\nrate\t44100\n']); },
          };
          throw Error('Missing file');
        },
      };
      throw Error('Unexpected directory');
    },
  };
  const root = { async getDirectoryHandle(name) {
    assert.equal(name, 'sessions');
    return sessions;
  } };
  const parent = { postMessage: (data) => responses.push(data) };
  const win = {
    parent,
    addEventListener(name, callback) {
      assert.equal(name, 'message');
      handler = callback;
    },
  };
  runInNewContext(source, {
    window: win, navigator: { storage: { async getDirectory() { return root; } } },
    console, Blob, Uint8Array, String, Array, Set, RegExp,
  });
  const nonce = 'ba0f0916-d4a0-4d2b-a0a7-abcd12345aaa';
  handler({ source: {}, origin: 'kindling://app', data: { type: ROFORMER_TRANSFER_REQUEST, nonce } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 0);
  handler({ source: parent, origin: 'kindling://app', data: { type: ROFORMER_TRANSFER_REQUEST, nonce } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].type, ROFORMER_TRANSFER_ERROR);
  assert.match(responses[0].message, /no completed RoFormer stems/i);
});

test('Child reads complete six stem WAVs from the current Stemyla session only', async () => {
  const source = readFileSync(new URL('../desktop/roformer-transfer-bridge.js', import.meta.url), 'utf8');
  const responses = [];
  const valid = wav();
  const stemNames = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'];
  let handler;
  const folder = {
    async getFileHandle(name) {
      assert.ok(stemNames.some((stem) => stem + '.wav' === name));
      return { getFile: async () => valid };
    },
  };
  const session = {
    async getFileHandle(name) {
      assert.equal(name, 'meta');
      return {
        getFile: async () => new Blob([
          'name\tSong\nrate\t44100\n' +
          stemNames.map((n) => 'stem\t' + n + '\n').join(''),
        ]),
      };
    },
    async getDirectoryHandle(name) {
      assert.equal(name, 'stems');
      return folder;
    },
  };
  const sessions = {
    async getFileHandle(name) {
      assert.equal(name, 'current');
      return { getFile: async () => new Blob(['1763730000000']) };
    },
    async getDirectoryHandle(name) {
      assert.equal(name, '1763730000000');
      return session;
    },
  };
  const root = {
    async getDirectoryHandle(name) {
      assert.equal(name, 'sessions');
      return sessions;
    },
  };
  const parent = { postMessage: (data) => responses.push(data) };
  const win = { parent, addEventListener: (name, fn) => { handler = fn; } };
  runInNewContext(source, {
    window: win, navigator: { storage: { getDirectory: async () => root } },
    Blob, Uint8Array, String, Array, Set, RegExp,
  });
  const nonce = 'ba0f0916-d4a0-4d2b-a0a7-abcd12345aaa';
  handler({ source: parent, origin: 'kindling://app',
    data: { type: ROFORMER_TRANSFER_REQUEST, nonce } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].type, ROFORMER_TRANSFER_RESULT);
  assert.equal(responses[0].stems.length, 6);
  assert.deepEqual(Array.from(responses[0].stems, (s) => s.name), stemNames);
  assert.ok(responses[0].stems.every((s) => s.file.size === valid.size));
});
