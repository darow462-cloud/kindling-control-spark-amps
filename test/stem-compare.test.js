import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatStemTime, initStemCompare, isLocalWav } from '../src/app/stem-compare.js';

class FakeElement {
  constructor() {
    this.disabled = false;
    this.value = '';
    this.files = [];
    this.dataset = {};
    this.textContent = '';
    this.attributes = {};
    this.handlers = new Map();
  }
  addEventListener(name, callback, options) {
    const entries = this.handlers.get(name) ?? [];
    entries.push({ callback, once: !!options?.once });
    this.handlers.set(name, entries);
  }
  fire(name) {
    const entries = [...(this.handlers.get(name) ?? [])];
    for (const entry of entries) {
      entry.callback();
      if (entry.once) {
        this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== entry));
      }
    }
  }
  click() { this.fire('click'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
}
class FakeAudio extends FakeElement {
  constructor() {
    super();
    this.paused = true;
    this.currentTime = 0;
    this.duration = 120;
    this.readyState = 1;
    this.src = '';
    this.preload = '';
  }
  play() {
    this.paused = false;
    this.fire('play');
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.fire('pause');
    }
  }
  load() { this.fire('loadedmetadata'); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
function fixture() {
  const ids = [
    'stem-compare-a-name', 'stem-compare-b-name', 'stem-compare-a',
    'stem-compare-b', 'stem-compare-seek', 'stem-compare-play',
    'stem-compare-stop', 'stem-compare-clock', 'stem-compare-status',
    'stem-compare-a-file', 'stem-compare-b-file',
  ];
  const el = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const audio = [];
  const documentRef = { createElement: (tag) => {
    assert.equal(tag, 'audio');
    const instance = new FakeAudio();
    audio.push(instance);
    return instance;
  } };
  const revoked = [];
  let seq = 0;
  const urlApi = {
    createObjectURL: () => 'blob:stems/' + ++seq,
    revokeObjectURL: (url) => revoked.push(url),
  };
  const root = { querySelector: (selector) => el[selector.slice(1)] };
  let otherPlayersPaused = 0;
  const compare = initStemCompare({
    root, documentRef, urlApi,
    onPlay: () => { otherPlayersPaused++; },
  });
  return { el, audio, compare, revoked, get onPlayCalls() { return otherPlayersPaused; } };
}
const demucsUrl = 'kindling-stem://550e8400-e29b-41d4-a716-446655440000/guitar.wav';

test('WAV selection accepts only nonempty WAV names and formats listening time', () => {
  assert.equal(isLocalWav({ name: 'guitar.wav', size: 100 }), true);
  assert.equal(isLocalWav({ name: 'guitar.WAV', size: 1 }), true);
  assert.equal(isLocalWav({ name: 'guitar.wav.exe', size: 100 }), false);
  assert.equal(isLocalWav({ name: 'guitar.wav', size: 0 }), false);
  assert.equal(formatStemTime(83.8), '1:23');
  assert.equal(formatStemTime(Number.NaN), '0:00');
});

test('Demucs guitar auto-loads and A/B switch keeps playback position', async () => {
  const f = fixture();
  assert.equal(f.compare.setDemucs({ name: 'guitar', url: demucsUrl }), true);
  assert.equal(f.el['stem-compare-a'].disabled, false);
  assert.equal(f.el['stem-compare-b'].disabled, true);
  assert.equal(f.el['stem-compare-a-name'].textContent, 'Guitar (latest Demucs)');
  f.el['stem-compare-b-file'].files = [{ name: 'roformer-guitar.wav', size: 2400 }];
  f.el['stem-compare-b-file'].fire('change');
  f.el['stem-compare-play'].click();
  await Promise.resolve();
  assert.equal(f.audio[0].paused, false);
  assert.equal(f.onPlayCalls, 1);
  f.audio[0].currentTime = 42;
  f.el['stem-compare-b'].click();
  await Promise.resolve();
  assert.equal(f.compare.getActive(), 'b');
  assert.equal(f.audio[0].paused, true);
  assert.equal(f.audio[1].paused, false);
  assert.equal(f.audio[1].currentTime, 42);
  assert.equal(f.el['stem-compare-b'].getAttribute('aria-pressed'), 'true');
  assert.equal(f.el['stem-compare-clock'].textContent, '0:42 / 2:00');
  f.el['stem-compare-seek'].value = '500';
  f.el['stem-compare-seek'].fire('input');
  assert.equal(f.audio[1].currentTime, 60);
  f.compare.dispose();
  assert.deepEqual(f.revoked, ['blob:stems/1']);
  assert.equal(f.audio[1].paused, true);
});

test('invalid RoFormer file is rejected without creating or replacing audio', () => {
  const f = fixture();
  f.el['stem-compare-b-file'].files = [{ name: 'unexpected.exe', size: 50 }];
  f.el['stem-compare-b-file'].fire('change');
  assert.equal(f.el['stem-compare-b'].disabled, true);
  assert.match(f.el['stem-compare-status'].textContent, /Choose a non-empty WAV/);
  assert.equal(f.audio[1].src, '');
  assert.equal(f.compare.setDemucs({ name: 'guitar', url: 'https://example.com/a.wav' }), false);
  assert.equal(f.compare.setDemucs({ name: 'vocals', url: demucsUrl }), false);
  f.compare.dispose();
});

test('replacing a manual WAV and closing releases only owned blob URLs', () => {
  const f = fixture();
  const input = f.el['stem-compare-a-file'];
  input.files = [{ name: 'first.wav', size: 50 }];
  input.fire('change');
  input.files = [{ name: 'second.wav', size: 51 }];
  input.fire('change');
  assert.deepEqual(f.revoked, ['blob:stems/1']);
  f.compare.dispose();
  assert.deepEqual(f.revoked, ['blob:stems/1', 'blob:stems/2']);
});

test('comparison UI and Demucs completion hook are present in main Stems tab', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const stemPanel = readFileSync(new URL('../src/app/stem-panel.js', import.meta.url), 'utf8');
  assert.match(html, /id="stem-compare"/);
  assert.match(html, /id="stem-compare-b-file"/);
  assert.match(html, /id="stem-compare-seek"/);
  assert.match(stemPanel, /initStemCompare/);
  assert.match(stemPanel, /compare\?\.setDemucs\(guitar\)/);
});
