import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initInlineRoformer, ROFORMER_INLINE_URL } from '../src/app/roformer-inline.js';

class FakeClassList {
  constructor() { this.classes = new Set(); }
  toggle(name, value) { if (value) this.classes.add(name); else this.classes.delete(name); }
  contains(name) { return this.classes.has(name); }
}

class FakeElement {
  constructor() {
    this.hidden = false; this.disabled = false; this.attributes = {};
    this.classList = new FakeClassList(); this.listeners = new Map();
    this.textContent = ''; this.dataset = {}; this.src = '';
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  click() { for (const handler of this.listeners.get('click') ?? []) handler(); }
  fire(type) { for (const handler of this.listeners.get(type) ?? []) handler(); }
}

function fixture({ supported = true, initiallyHidden = true } = {}) {
  const ids = [
    'stem-engine-roformer', 'stem-engine-demucs', 'stem-roformer-pane',
    'stem-demucs-pane', 'stem-roformer-frame', 'stem-roformer-status',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const root = {
    hidden: initiallyHidden,
    querySelector(selector) { return elements[selector.slice(1)]; },
  };
  const observers = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, opts) {
      assert.equal(target, root);
      assert.deepEqual(opts, { attributes: true, attributeFilter: ['hidden'] });
    }
    disconnect() { this.disconnected = true; }
    fire() { if (!this.disconnected) this.callback(); }
  }
  const calls = [];
  const bridge = supported ? {
    status: async () => {
      calls.push('status');
      return { available: true, url: ROFORMER_INLINE_URL };
    },
  } : undefined;
  const app = initInlineRoformer({ root, bridge, Observer: FakeObserver });
  const showStems = () => { root.hidden = false; observers[0].fire(); };
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { elements, root, calls, app, showStems, tick, observers };
}

test('RoFormer does not download/load GPU code until Stems tab is selected', async () => {
  const f = fixture();
  assert.equal(f.app.getEngine(), 'roformer');
  assert.equal(f.elements['stem-roformer-frame'].src, '');
  assert.equal(f.calls.length, 0);
  f.showStems();
  await f.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.elements['stem-roformer-frame'].src, ROFORMER_INLINE_URL);
  assert.equal(f.elements['stem-roformer-frame'].hidden, false);
  f.elements['stem-roformer-frame'].fire('load');
  assert.match(f.elements['stem-roformer-status'].textContent, /workspace loaded/);
  f.app.dispose();
});

test('switching Demucs and back keeps one RoFormer frame and the GPU model cache', async () => {
  const f = fixture();
  f.showStems();
  await f.tick();
  const frame = f.elements['stem-roformer-frame'];
  const originalUrl = frame.src;
  f.elements['stem-engine-demucs'].click();
  assert.equal(f.app.getEngine(), 'demucs');
  assert.equal(f.elements['stem-demucs-pane'].hidden, false);
  assert.equal(f.elements['stem-roformer-pane'].hidden, true);
  assert.equal(frame.src, originalUrl, 'do not discard RoFormer file/model state');
  assert.equal(f.elements['stem-engine-demucs'].getAttribute('aria-pressed'), 'true');
  f.elements['stem-engine-roformer'].click();
  await f.tick();
  assert.equal(f.app.getEngine(), 'roformer');
  assert.equal(f.elements['stem-demucs-pane'].hidden, true);
  assert.equal(f.elements['stem-roformer-pane'].hidden, false);
  assert.equal(f.calls.length, 1, 'must not remount embedded WebGPU app');
  f.app.dispose();
  assert.equal(f.observers[0].disconnected, true);
});

test('unsupported browser falls back to Demucs without starting any iframe', async () => {
  const f = fixture({ supported: false, initiallyHidden: false });
  assert.equal(f.app.getEngine(), 'demucs');
  assert.equal(f.elements['stem-engine-roformer'].disabled, true);
  assert.equal(f.elements['stem-roformer-frame'].src, '');
  assert.match(f.elements['stem-roformer-status'].textContent, /Windows Portable/);
  f.elements['stem-engine-roformer'].click();
  assert.equal(f.app.getEngine(), 'demucs');
  f.app.dispose();
});

test('RoFormer embedded frame requires explicit WebGPU delegation, download sandbox and separate origin', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="stem-roformer-frame"/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-downloads allow-forms"/);
  assert.match(html, /allow="webgpu; fullscreen"/);
  assert.match(html, /id="stem-demucs-pane"/);
  assert.doesNotMatch(html, /id="stem-open-roformer"/);
  const main = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /new BrowserWindow\(\{\s*width: 1360/);
  assert.doesNotMatch(main, /roformer:open/);
  assert.match(main, /roformer:status/);
});
