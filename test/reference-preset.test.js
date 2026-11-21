import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzePcm } from '../src/app/audio-analysis.js';
import {
  generateReferencePreset, generateReferencePresetVariants, guessReferenceTone,
} from '../src/app/reference-preset.js';
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
  assert.equal(result.preset.pedals[3].name, '6505Plus');
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
  assert.match(panel, /generateReferencePresetVariants\(tracks\.reference\.profile/);
  assert.match(html, /id="analysis-preset-options"/);
  assert.match(panel, /generatedGroup\.candidates\[0\]/);
  assert.match(panel, /selectedCandidateIndex = index/);
  assert.match(panel, /presetToJson\(preset\)/);
  assert.match(app, /onApplyGeneratedPreset: async/);
  assert.match(app, /await makeLive\(draft\)/);
  assert.match(app, /TEMP_SLOT/);
});


test('five distinct high-gain amp candidates are valid Spark presets and editable/exportable', () => {
  const reference = profile(fullBands(), 7);
  const group = generateReferencePresetVariants(reference, {referenceName:'Heavy.wav'});
  assert.equal(group.style, 'high-gain');
  assert.equal(group.candidates.length, 5);
  assert.deepEqual(group.candidates.map(c => c.preset.pedals[3].name),
    ['6505Plus', 'Rectifier', 'SLO100', 'BE101', 'EVH']);
  assert.equal(new Set(group.candidates.map(c => c.preset.name)).size, 5);
  for (const candidate of group.candidates) verifyPreset(candidate);
  assert.equal(group.candidates[0].preset.pedals[6].isOn, false, 'do not infer reverb from layering');
  assert.equal(group.candidates[0].preset.pedals[5].isOn, false, 'do not infer delay from stereo spread');
});

test('clean and crunch also expose multiple alternate amps, not hardcoded single-model choice', () => {
  for (const style of ['clean', 'crunch']) {
    const group = generateReferencePresetVariants(measured(440), {style,referenceName:'Original'});
    assert.ok(group.candidates.length >= 4);
    assert.equal(new Set(group.candidates.map(c => c.ampLabel)).size, group.candidates.length);
    for (const candidate of group.candidates) verifyPreset(candidate);
  }
});

test('guitar-clip.wav derived statistics favor high-gain candidates despite 14 dB crest', () => {
  // No copyrighted user audio is added to the repo; this is a descriptor-only
  // regression from the supplied test clip, with rounded measured values.
  const reference = {
    ...profile({
      sub: .1, bass: 40.3, lowMid: 11.0, mid: 16.5, presence: 29.0, air: 3.1,
    }, 14.35),
    envelopeContrastDb: 2.5,
    spectralFlatness: .05,
    rolloffHz: 4100,
    stereoCorrelation: -.108,
  };
  const group = generateReferencePresetVariants(reference, {referenceName: 'guitar-clip.wav'});
  assert.equal(group.style, 'high-gain');
  assert.equal(group.candidates.length, 5);
  assert.equal(group.candidates[0].preset.pedals[3].name, '6505Plus');
  assert.ok(group.candidates[0].preset.pedals[3].params[3] <= .52,
    '80-250 Hz note content must not cause the old excessive bass boost');
  assert.ok(group.warnings.some(x=>x.includes('correlation')));
  assert.ok(group.warnings.some(x=>x.includes('80–250 Hz')));
});

test('single clean sine has narrow spectrum and must not be guessed high-gain', () => {
  const clean = measured(440);
  assert.ok(Number.isFinite(clean.envelopeContrastDb));
  assert.ok(Number.isFinite(clean.spectralFlatness));
  assert.ok(Number.isFinite(clean.rolloffHz));
  assert.equal(clean.stereoCorrelation, null);
  assert.ok(clean.spectralFlatness < .012);
  assert.ok(clean.rolloffHz >= 400 && clean.rolloffHz <= 500);
  assert.equal(guessReferenceTone(clean), 'clean');
});

test('stereo correlation descriptor detects phase-opposed channels without assuming number of guitars', () => {
  const one = tone(330);
  const neg = one.map(v => -v);
  const opposing = analyzePcm({channels:[one,neg],sampleRate:rate});
  assert.ok(opposing.stereoCorrelation < -.99);
  const identical = analyzePcm({channels:[one,one],sampleRate:rate});
  assert.ok(identical.stereoCorrelation > .99);
});

test('invalid characters and long names remain safe in generated candidate presets', () => {
  const group = generateReferencePresetVariants(measured(440), {
    style:'clean',referenceName:'bad<file>\u0001'.repeat(20),
  });
  assert.equal(group.candidates.length, 4);
  for (const candidate of group.candidates) {
    assert.ok(candidate.preset.name.length <= 64);
    assert.doesNotMatch(candidate.preset.name, /[<>\u0000-\u001f]/);
  }
});
