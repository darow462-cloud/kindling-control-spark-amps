import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MIX_STEMS, identifyStemFile, audibleVolume, initStemMixer,
} from '../src/app/stem-mixer.js';

class FakeElement {
  constructor() {
    this.handlers = new Map();
    this.attributes = {};
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.files = [];
    this.classList = { toggle() {} };
  }
  addEventListener(type, callback) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(callback);
  }
  fire(type) { for (const callback of this.handlers.get(type) ?? []) callback({ target: this }); }
  click() { this.fire('click'); }
  append(...items) { this.children.push(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
}
class FakeAudio extends FakeElement {
  constructor() {
    super();
    this.paused = true;
    this.currentTime = 0;
    this.duration = 60;
    this.readyState = 1;
    this.volume = 1;
    this.muted = false;
    this.src = '';
  }
  play() { this.paused = false; this.fire('play'); return Promise.resolve(); }
  pause() { this.paused = true; this.fire('pause'); }
  load() { if (this.src) this.fire('loadedmetadata'); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
function fixture() {
  const ids = [
    'stem-mixer-rows', 'stem-mixer-status', 'stem-mixer-play',
    'stem-mixer-stop', 'stem-mixer-seek', 'stem-mixer-clock',
    'stem-mixer-analyze-guitar', 'stem-mixer-demucs',
    'stem-mixer-roformer', 'stem-mixer-import',
  ];
  const el = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const players = [];
  const doc = { createElement: (tag) => {
    const v = tag === 'audio' ? new FakeAudio() : new FakeElement();
    if (tag === 'audio') players.push(v);
    return v;
  } };
  const revoked = [];
  let seq = 0;
  const urlApi = {
    createObjectURL() { return 'blob:mix/' + ++seq; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  const calls = [];
  const root = { querySelector(selector) { return el[selector.slice(1)]; } };
  const mixer = initStemMixer({
    root, documentRef: doc, urlApi,
    onPlay: () => { calls.push('play'); },
    onAnalyzeDemucs: (stem) => { calls.push(['demucs', stem.url]); },
    onAnalyzeRoFormer: (file) => { calls.push(['roformer', file.name]); },
  });
  const row = (name) => {
    const i = MIX_STEMS.indexOf(name);
    assert.ok(i >= 0);
    const children = el['stem-mixer-rows'].children[i].children;
    return {
      title: children[0], fileName: children[1], file: children[2],
      mute: children[3], solo: children[4], volume: children[5], level: children[6],
    };
  };
  return { mixer, el, players, calls, revoked, row };
}
const file = (name) => ({ name, size: 1200 });
const demucs = (name) => ({
  name, label: name, url: 'kindling-stem://550e8400-e29b-41d4-a716-446655440000/' + name + '.wav',
});

test('six channel names and safe filename auto-detection', () => {
  assert.deepEqual(MIX_STEMS, ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']);
  assert.equal(identifyStemFile('song_Drums.wav'), 'drums');
  assert.equal(identifyStemFile('Song - Guitar.wav'), 'guitar');
  assert.equal(identifyStemFile('song-vocals.WAV'), 'vocals');
  assert.equal(identifyStemFile('song - piano.wav'), 'piano');
  assert.equal(identifyStemFile('song-other.wav'), 'other');
  assert.equal(identifyStemFile('guitar-bass.wav'), null);
  assert.equal(identifyStemFile('unknown.wav'), null);
  assert.equal(identifyStemFile('../guitar.mp3'), null);
  assert.equal(audibleVolume({ volume: 0.8, mute: false, solo: false }, false), 0.8);
  assert.equal(audibleVolume({ volume: 0.8, mute: false, solo: false }, true), 0);
  assert.equal(audibleVolume({ volume: 0.8, mute: true, solo: true }, true), 0);
  assert.equal(audibleVolume({ volume: 1.5, mute: false, solo: true }, true), 1);
});

test('manual import of six exported RoFormer WAVs supports volume, mute, solo, seek, stop', async () => {
  const f = fixture();
  const imported = MIX_STEMS.map((name) => file('song-' + name + '.wav'));
  f.el['stem-mixer-import'].files = imported;
  f.el['stem-mixer-import'].fire('change');
  assert.equal(f.mixer.getActive(), 'roformer');
  assert.deepEqual(f.mixer.getLoadedNames(), MIX_STEMS);
  assert.equal(f.el['stem-mixer-play'].disabled, false);
  assert.equal(f.row('guitar').fileName.textContent, 'song-guitar.wav');
  f.row('guitar').volume.value = '40';
  f.row('guitar').volume.fire('input');
  assert.equal(f.players[3].volume, 0.4);
  f.el['stem-mixer-play'].click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.players.filter((a) => !a.paused).length, 6);
  assert.equal(f.calls[0], 'play');
  f.row('drums').mute.click();
  assert.equal(f.players[0].muted, true);
  f.row('guitar').solo.click();
  assert.equal(f.players[3].muted, false);
  assert.equal(f.players[1].muted, true);
  f.el['stem-mixer-seek'].value = '500';
  f.el['stem-mixer-seek'].fire('input');
  assert.equal(f.players[3].currentTime, 30);
  f.el['stem-mixer-stop'].click();
  assert.equal(f.players.filter((a) => !a.paused).length, 0);
  assert.equal(f.players[3].currentTime, 0);
  f.mixer.dispose();
  assert.deepEqual(f.revoked, ['blob:mix/1', 'blob:mix/2', 'blob:mix/3',
    'blob:mix/4', 'blob:mix/5', 'blob:mix/6']);
});

test('shared transport reports live time, permits synced seeking and bounds preview playback', async () => {
  const f = fixture();
  const snapshots = [];
  const unsubscribe = f.mixer.subscribeTransport((snapshot) => snapshots.push(snapshot));
  assert.equal(snapshots.at(-1).playing, false);
  assert.equal(f.mixer.loadDemucs(MIX_STEMS.map(demucs)),6);
  assert.equal(f.mixer.getDuration(),60);
  assert.equal(f.mixer.previewRange(10,20),true);
  await Promise.resolve();
  assert.equal(f.mixer.getPosition(),10);
  assert.equal(f.mixer.isPlaying(),true);
  assert.equal(snapshots.at(-1).playing,true);
  assert.equal(f.mixer.seekTo(14),true);
  assert.ok(f.players.every((player)=>player.currentTime===14));
  assert.equal(snapshots.at(-1).time,14);
  assert.equal(f.mixer.seekTo(Number.NaN),false);
  assert.equal(f.mixer.seekTo(21),true);
  assert.equal(f.mixer.isPlaying(),false,'seeking beyond preview end stops playback');
  assert.equal(f.mixer.getPosition(),21);
  assert.equal(f.mixer.previewRange(10,20,14),true);
  await Promise.resolve();
  assert.equal(f.mixer.getPosition(),14,'resume at chosen preview position');
  f.players[0].currentTime=20;
  f.players[0].fire('timeupdate');
  assert.equal(f.mixer.isPlaying(),false,'master end of preview stops synchronized players');
  unsubscribe();
  const count=snapshots.length;
  f.mixer.seekTo(4);
  assert.equal(snapshots.length,count,'unsubscribe removes transport observer');
  f.mixer.dispose();
});

test('trusted native Demucs set is loaded automatically and rejects arbitrary HTTP URLs', () => {
  const f = fixture();
  assert.equal(f.mixer.loadDemucs([{ name: 'guitar', url: 'https://example.com/guitar.wav' }]), 0);
  assert.equal(f.mixer.loadDemucs([{ name: 'guitar', url: demucs('bass').url }]), 0);
  assert.equal(f.mixer.loadDemucs(MIX_STEMS.map(demucs)), 6);
  assert.equal(f.mixer.getActive(), 'demucs');
  assert.deepEqual(f.mixer.getLoadedNames(), MIX_STEMS);
  assert.equal(f.players[3].src, demucs('guitar').url);
  f.el['stem-mixer-roformer'].click();
  assert.equal(f.mixer.getActive(), 'roformer');
  assert.equal(f.el['stem-mixer-play'].disabled, true);
  f.el['stem-mixer-demucs'].click();
  assert.equal(f.mixer.getActive(), 'demucs');
  assert.equal(f.players[3].src, demucs('guitar').url);
  f.mixer.dispose();
  assert.deepEqual(f.revoked, [], 'native session URLs are not Blob URLs');
});

test('per-track WAV chooser accepts unknown RoFormer filenames; previous blob is released', () => {
  const f = fixture();
  f.el['stem-mixer-roformer'].click();
  const input = f.row('guitar').file;
  input.files = [file('solo_take1.wav')];
  input.fire('change');
  assert.deepEqual(f.mixer.getLoadedNames('roformer'), ['guitar']);
  assert.equal(f.row('guitar').fileName.textContent, 'solo_take1.wav');
  input.files = [file('solo_take2.wav')];
  input.fire('change');
  assert.deepEqual(f.revoked, ['blob:mix/1']);
  assert.equal(f.row('guitar').fileName.textContent, 'solo_take2.wav');
  f.mixer.dispose();
  assert.deepEqual(f.revoked, ['blob:mix/1', 'blob:mix/2']);
});

test('guitar Analyze callbacks use a trusted Demucs URL or explicitly chosen RoFormer File', async () => {
  const f = fixture();
  f.mixer.loadDemucs([demucs('guitar')]);
  f.el['stem-mixer-analyze-guitar'].click();
  await Promise.resolve();
  assert.deepEqual(f.calls.at(-1), ['demucs', demucs('guitar').url]);
  const input = f.row('guitar').file;
  input.files = [file('lead-guitars.wav')];
  input.fire('change');
  f.el['stem-mixer-analyze-guitar'].click();
  await Promise.resolve();
  assert.deepEqual(f.calls.at(-1), ['roformer', 'lead-guitars.wav']);
  f.mixer.dispose();
});

test('mixer controls are in Stems and Analyze integrates explicitly selected local WAV', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const stemPanel = readFileSync(new URL('../src/app/stem-panel.js', import.meta.url), 'utf8');
  const audioPanel = readFileSync(new URL('../src/app/audio-panel.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="stem-mixer-rows"/);
  assert.match(html, /id="stem-mixer-import"/);
  assert.match(html, /id="stem-mixer-analyze-guitar"/);
  assert.match(stemPanel, /mixer\?\.loadDemucs\(state\.stems\)/);
  assert.match(audioPanel, /async function loadImportedGuitar\(file\)/);
  assert.match(app, /onAnalyzeImportedGuitar:/);
});
