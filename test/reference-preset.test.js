import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzePcm } from '../src/app/audio-analysis.js';
import { generateReferencePreset, guessReferenceTone } from '../src/app/reference-preset.js';
import { EFFECTS, SLOTS } from '../src/spark/effects.js';
import { presetToJson, presetFromJson } from '../src/spark/messages.js';

const rate = 44100;
function tone(hz, seconds = 1) {
  return Float32Array.from({ length: rate * seconds }, (_, i) =>
    0.3 * Math.sin(2 * Math.PI * hz * i / rate));
}
function measured(hz) {
  return analyzePcm({ channels: [tone(hz)], sampleRate: rate });
}
function profile(bands, crestDb = 7) {
  return {
    rmsDb: -16, crestDb, centroidHz: 1850,
    bands: Object.entries(bands).map(([key, percent]) => ({ key, percent })),
  };
}
const fullBands = (patch = {}) => ({
  sub: 1, bass: 12, lowMid: 14, mid: 46, presence: 23, air: 4, ...patch,
});
function verifyPreset(result) {
  const { preset } = result;
  assert.equal(preset.pedals.length, SLOTS.length);
  assert.match(preset.name, /^Match - /);
  for (let i = 0; i < preset.pedals.length; i++) {
    const effect = preset.pedals[i];
    const matching = EFFECTS.find(e => e.id.toLowerCase() === effect.name.toLowerCase());
    assert.equal(matching?.slot, SLOTS[i].key);
    assert.equal(typeof effect.isOn, 'boolean');
    assert.ok(effect.params.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  }
  const decoded = presetFromJson(presetToJson(preset));
  assert.deepEqual(decoded.pedals, preset.pedals, 'JSON export round-trips through existing importer');
}

test('a single original audio signal generates a valid editable Spark preset without a guitar recording', () => {
  const measuredClean = measured(440);
  const result = generateReferencePreset(measuredClean, { referenceName: 'Riff.wav' });
  assert.equal(result.style, 'clean');
  assert.equal(result.preset.name, 'Match - Riff');
  assert.equal(result.preset.pedals[3].name, 'Twin');
  assert.equal(result.preset.pedals[3].params[4], 0.38, 'safe preset amp volume');
  assert.equal(result.preset.pedals[2].isOn, false);
  assert.equal(result.preset.pedals[5].isOn, false);
  verifyPreset(result);
});

test('dense bright reference selects an available high-gain model and supports manual style override', () => {
  const reference = profile(fullBands(), 7);
  assert.equal(guessReferenceTone(reference), 'high-gain');
  const result = generateReferencePreset(reference, { referenceName:'Heavy Guitar.flac' });
  assert.equal(result.style, 'high-gain');
  assert.equal(result.preset.pedals[3].name, 'Rectifier');
  assert.equal(result.preset.pedals[2].name, 'DistortionTS9');
  assert.equal(result.preset.pedals[2].isOn, true);
  assert.equal(result.preset.pedals[0].isOn, true);
  verifyPreset(result);
  const crunch = generateReferencePreset(reference, { style:'crunch' });
  assert.equal(crunch.style, 'crunch');
  assert.equal(crunch.preset.pedals[3].name, 'Plexi');
  assert.equal(crunch.preset.pedals[2].isOn, false);
  verifyPreset(crunch);
});

test('spectral brightness changes suggested treble while keeping all controls in physical ranges', () => {
  const dark = profile(fullBands({bass:28,lowMid:31,mid:33,presence:6,air:1}),15);
  const bright = profile(fullBands({bass:1,lowMid:4,mid:35,presence:42,air:17}),15);
  const a = generateReferencePreset(dark,{style:'clean'});
  const b = generateReferencePreset(bright,{style:'clean'});
  assert.ok(a.preset.pedals[3].params[1] < b.preset.pedals[3].params[1]);
  assert.ok(a.preset.pedals[3].params[3] > b.preset.pedals[3].params[3]);
  verifyPreset(a);
  verifyPreset(b);
});

test('silent or malformed references cannot generate arbitrary loud presets', () => {
  assert.throws(() => generateReferencePreset({rmsDb:-120,crestDb:0,centroidHz:0,bands:[]}), /silent|quiet/i);
  assert.throws(() => generateReferencePreset(profile(fullBands({presence: NaN}))), /invalid/i);
  assert.throws(() => generateReferencePreset(profile(fullBands()), {style:'fuzzy'}), /supported/);
});

test('reference-only generation is reachable in Analyze without requiring the Your Guitar track', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/app/audio-panel.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="analysis-preset-generate"/);
  assert.match(html, /id="analysis-preset-apply"/);
  assert.match(html, /id="analysis-preset-export"/);
  assert.match(panel, /if \(role === 'reference'\) regenerateReferencePreset\(\)/);
  assert.match(panel, /generateReferencePreset\(tracks\.reference\.profile/);
  assert.match(panel, /presetToJson\(preset\)/);
  assert.match(app, /onApplyGeneratedPreset: async/);
  assert.match(app, /load into the temporary live slot/);
});
