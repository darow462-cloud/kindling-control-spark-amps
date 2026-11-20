import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fftPower, analyzePcm, compareAudioProfiles, AUDIO_BANDS,
  SPECTRUM_POINTS, ANALYSIS_SECONDS,
} from '../src/app/audio-analysis.js';

const RATE = 48000;
const sine = (frequency, seconds = 2, amplitude = 0.5) => Float32Array.from(
  { length: Math.floor(RATE * seconds) }, (_, i) =>
    amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE),
);
const analyze = (frequency, amplitude = 0.5) => analyzePcm({
  channels: [sine(frequency, 2, amplitude)], sampleRate: RATE,
});
const energy = (profile, key) => profile.bands.find((x) => x.key === key).percent;

test('FFT of a unit impulse has constant power at each frequency', () => {
  const result = fftPower(new Float64Array([1, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(result.length, 5);
  for (const p of result) assert.ok(Math.abs(p - 1) < 1e-10);
});

test('bass and upper-presence sine waves are assigned to different bands', () => {
  const low = analyze(125);
  const high = analyze(3200);
  assert.ok(energy(low, 'bass') > 97, `unexpected bass energy: ${energy(low, 'bass')}`);
  assert.ok(energy(high, 'presence') > 97, `unexpected upper presence: ${energy(high, 'presence')}`);
  assert.ok(low.centroidHz > 100 && low.centroidHz < 150);
  assert.ok(high.centroidHz > 3000 && high.centroidHz < 3400);
  assert.equal(low.bands.length, AUDIO_BANDS.length);
  assert.equal(low.spectrum.length, SPECTRUM_POINTS);
  assert.ok(low.spectrum.every((x) => Number.isFinite(x) && x <= 0 && x >= -75));
  assert.ok(low.analyzedSeconds > 1.9);
});

test('doubling the recording amplitude changes dBFS but not relative spectral shape', () => {
  const a = analyze(440, 0.25);
  const b = analyze(440, 0.5);
  assert.ok(Math.abs((b.rmsDb - a.rmsDb) - 6.0206) < 0.02);
  assert.ok(Math.abs((b.peakDb - a.peakDb) - 6.0206) < 0.02);
  assert.ok(Math.abs(b.crestDb - a.crestDb) < 0.02);
  for (let i = 0; i < a.bands.length; i++) {
    assert.ok(Math.abs(a.bands[i].percent - b.bands[i].percent) < 0.01);
  }
});

test('stereo analysis avoids phase cancellation from opposite-polarity channels', () => {
  const first = sine(180);
  const opposite = first.map((v) => -v);
  const p = analyzePcm({ channels: [first, opposite], sampleRate: RATE });
  assert.ok(p.rmsDb > -10, `opposing stereo channels cancelled: ${p.rmsDb}`);
  assert.ok(energy(p, 'bass') > 97);
});

test('offset analysis selects the requested section rather than the whole track', () => {
  const data = new Float32Array(RATE * 4);
  data.set(sine(120, 2), 0);
  data.set(sine(3000, 2), RATE * 2);
  const first = analyzePcm({ channels: [data], sampleRate: RATE, startSec: 0, windowSec: 1.5 });
  const last = analyzePcm({ channels: [data], sampleRate: RATE, startSec: 2.2, windowSec: 1.5 });
  assert.ok(energy(first, 'bass') > 95);
  assert.ok(energy(last, 'presence') > 95);
  assert.equal(ANALYSIS_SECONDS, 8);
});

test('silence has a stable finite result and produces an actionable warning', () => {
  const silence = analyzePcm({ channels: [new Float32Array(RATE)], sampleRate: RATE });
  assert.equal(silence.rmsDb, -120);
  assert.equal(silence.peakDb, -120);
  assert.equal(silence.crestDb, 0);
  assert.equal(silence.centroidHz, 0);
  assert.ok(silence.bands.every((b) => b.percent === 0));
  assert.ok(compareAudioProfiles(silence, analyze(440))[0].includes('near silent'));
});

test('comparison suggests reducing excess bass and excess presence when appropriate', () => {
  const bassHeavy = compareAudioProfiles(analyze(3200), analyze(125));
  const bright = compareAudioProfiles(analyze(125), analyze(3200));
  assert.ok(bassHeavy.some((message) => message.includes('low-frequency')));
  assert.ok(bright.some((message) => message.includes('upper-frequency')));
});

test('malformed PCM and invalid window settings are rejected', () => {
  assert.throws(() => analyzePcm({ channels: [], sampleRate: RATE }), RangeError);
  assert.throws(() => analyzePcm({ channels: [sine(120)], sampleRate: 0 }), RangeError);
  assert.throws(() => analyzePcm({ channels: [sine(120)], sampleRate: RATE, fftSize: 3000 }), RangeError);
  assert.throws(() => analyzePcm({ channels: [sine(120)], sampleRate: RATE, startSec: -1 }), RangeError);
});
