import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyGlobalPeakGuard, readFloatWavInfo, DEFAULT_CEILING_DB,
} from '../desktop/stem-peakguard.js';

const makeWav = (samples) => {
  if (samples.length % 2) throw new Error('stereo pairs required');
  const dataSize = samples.length * 4;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);   // IEEE float
  b.writeUInt16LE(2, 22);   // stereo
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(44100 * 8, 28); // byte rate
  b.writeUInt16LE(8, 32);  // block align
  b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(dataSize, 40);
  samples.forEach((v, i) => b.writeFloatLE(v, 44 + i * 4));
  return b;
};
const values = (b) => Array.from({ length: (b.length - 44) / 4 }, (_, i) => b.readFloatLE(44 + i * 4));

// This is the exact WAVE_FORMAT_EXTENSIBLE + IEEE_FLOAT GUID layout used by
// real 32-bit float stem exports (including the user's WAVEX drums.wav).
const makeWavex = (samples) => {
  const base = makeWav(samples);
  const extended = Buffer.alloc(base.length + 24);
  base.copy(extended, 0, 0, 36);
  extended.writeUInt32LE(extended.length - 8, 4); // RIFF size
  extended.writeUInt32LE(40, 16);                 // fmt chunk size
  extended.writeUInt16LE(0xfffe, 20);             // WAVE_FORMAT_EXTENSIBLE
  extended.writeUInt16LE(22, 36);                 // cbSize
  extended.writeUInt16LE(32, 38);                 // valid bits
  extended.writeUInt32LE(3, 40);                  // stereo speaker mask
  Buffer.from('0300000000001000800000aa00389b71', 'hex').copy(extended, 44);
  base.copy(extended, 60, 36);                    // data header + samples
  return extended;
};

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'kindling-peak-'));
  return { root, path: (i) => join(root, `${i}.wav`) };
}

test('f32 WAV scanner reports channels, duration, data region and rejects invalid media', async () => {
  const ws = await workspace();
  try {
    await writeFile(ws.path(1), makeWav([0, 0, 1.174, -0.1]));
    const info = await readFloatWavInfo(ws.path(1));
    assert.equal(info.sampleRate, 44100);
    assert.equal(info.frames, 2);
    assert.equal(info.dataOffset, 44);
    assert.equal(info.dataBytes, 16);
    await writeFile(ws.path(2), Buffer.alloc(100, 1));
    await assert.rejects(readFloatWavInfo(ws.path(2)), /RIFF/);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('one uniform gain reduces 1.174 peak to -1 dBFS and preserves every sample ratio', async () => {
  const ws = await workspace();
  try {
    const names = [1, 2, 3];
    const arrays = [
      [0.2, -0.4, 1.174, 0.8, -0.6, 0.1],
      [0.5, -0.3, 0.25, 0.02, -0.2, -0.15],
      [-0.5, 0.1, 0.02, 0.0, 0.1, -0.25],
    ];
    for (const i of names) await writeFile(ws.path(i), makeWav(arrays[i - 1]));
    const result = await applyGlobalPeakGuard(names.map(ws.path), { enabled: true });
    const expectedGain = (10 ** (DEFAULT_CEILING_DB / 20)) / 1.174;
    assert.ok(result.samplesOverFullScale > 0);
    assert.ok(Math.abs(result.peakBeforeDb - 20 * Math.log10(1.174)) < 0.002);
    assert.ok(Math.abs(result.peakAfterDb + 1) < 0.001);
    assert.ok(Math.abs(result.gainDb - 20 * Math.log10(expectedGain)) < 0.002);
    for (const i of names) {
      const resultSamples = values(await readFile(ws.path(i)));
      const original = arrays[i - 1];
      for (let j = 0; j < original.length; j++) {
        assert.ok(Math.abs(resultSamples[j] - original[j] * expectedGain) < 1e-7);
      }
    }
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('safe audio below the ceiling is not rewritten or artificially boosted', async () => {
  const ws = await workspace();
  try {
    const wav = makeWav([0, 0.2, -0.2, -0.3, 0.5, 0.4]);
    await writeFile(ws.path(1), wav);
    const out = await applyGlobalPeakGuard([ws.path(1)]);
    assert.equal(out.gainDb, 0);
    assert.deepEqual(await readFile(ws.path(1)), wav);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('turning off the guard preserves float samples above 0 dBFS for diagnosis', async () => {
  const ws = await workspace();
  try {
    const wav = makeWav([1.18, 0.1, -1.2, 0.4]);
    await writeFile(ws.path(1), wav);
    const result = await applyGlobalPeakGuard([ws.path(1)], { enabled: false });
    assert.equal(result.samplesOverFullScale, 2);
    assert.equal(result.gainDb, 0);
    assert.deepEqual(await readFile(ws.path(1)), wav);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('non-finite input is rejected before changing even the first stem', async () => {
  const ws = await workspace();
  try {
    const first = makeWav([1.1, 0, -0.8, 0.6]);
    await writeFile(ws.path(1), first);
    await writeFile(ws.path(2), makeWav([0.1, NaN]));
    await assert.rejects(applyGlobalPeakGuard([ws.path(1), ws.path(2)]), /Non-finite/);
    assert.deepEqual(await readFile(ws.path(1)), first);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('unreasonable ceiling and non-WAV output are rejected rather than silently clipped', async () => {
  const ws = await workspace();
  try {
    await writeFile(ws.path(1), makeWav([0.4, 0.5]));
    await assert.rejects(applyGlobalPeakGuard([ws.path(1)], { ceilingDb: 0 }), RangeError);
    await writeFile(ws.path(2), Buffer.alloc(50, 0));
    await assert.rejects(applyGlobalPeakGuard([ws.path(2)]), /RIFF/);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});


test('real 40-byte WAVEX IEEE float files are accepted and gain protected', async () => {
  const ws = await workspace();
  try {
    const source = makeWavex([1.174, 0.4, -0.75, 0.25]);
    await writeFile(ws.path(5), source);
    const info = await readFloatWavInfo(ws.path(5));
    assert.equal(info.dataOffset, 68);
    assert.equal(info.frames, 2);
    const result = await applyGlobalPeakGuard([ws.path(5)]);
    assert.ok(Math.abs(result.peakAfterDb + 1) < 0.001);
    const protectedFile = await readFile(ws.path(5));
    const left = protectedFile.readFloatLE(68);
    assert.ok(Math.abs(left - (10 ** (-1 / 20))) < 0.00001);
    assert.deepEqual(protectedFile.subarray(0, 68), source.subarray(0, 68), 'WAVEX header must not be rewritten');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('a WAVEX header with the wrong subtype GUID is rejected before writing', async () => {
  const ws = await workspace();
  try {
    const invalid = makeWavex([1.25, 0.4]);
    invalid[44] = 0x01; // PCM integer subtype, not IEEE float
    await writeFile(ws.path(6), invalid);
    await assert.rejects(applyGlobalPeakGuard([ws.path(6)]), /float/);
    assert.deepEqual(await readFile(ws.path(6)), invalid);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});
