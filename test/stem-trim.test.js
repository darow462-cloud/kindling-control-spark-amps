import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizedClip, clipIsFull, peakEnvelope, wavFromAudioBuffer,
  validatePcm16Wav, crc32, wavZip,
} from '../src/app/stem-trim-utils.js';

function mockBuffer({ seconds = 1, rate = 1000, channels = 2 } = {}) {
  const length = seconds * rate;
  const content = Array.from({ length: channels }, (_, channel) =>
    Float32Array.from({ length }, (_, n) => channel ? -n / length : n / length));
  return {
    duration: seconds, sampleRate: rate, length, numberOfChannels: channels,
    getChannelData: (index) => content[index],
  };
}
const highRate = () => {
  const low = mockBuffer({ seconds: 1, rate: 44100 });
  return low;
};
test('normalization requires bounded, ordered, nonzero ranges', () => {
  assert.deepEqual(normalizedClip(0.25, 0.8, 1), { start: 0.25, end: 0.8 });
  assert.equal(clipIsFull({ start: 0, end: 1 }, 1), true);
  assert.equal(clipIsFull({ start: 0.2, end: 1 }, 1), false);
  for (const [a, b, d] of [[0.9,0.7,1],[-0.1,0.7,1],[0.2,1.1,1],[0,0.05,1],[0,1,0]]) {
    assert.throws(() => normalizedClip(a,b,d));
  }
  assert.throws(() => normalizedClip(NaN, 0.5, 1));
});

test('mono/stereo PCM16 trimming preserves exact frame count and correct WAV header', async () => {
  const buffer = highRate();
  const wav = wavFromAudioBuffer(buffer, 0.25, 0.75, {fadeSeconds:0});
  const binary = await wav.arrayBuffer();
  assert.equal(validatePcm16Wav(binary),true);
  const view = new DataView(binary);
  assert.equal(view.getUint32(24,true),44100);
  assert.equal(view.getUint16(22,true),2);
  assert.equal(view.getUint32(40,true), 22050 * 2 * 2);
  assert.equal(binary.byteLength,44+22050*4);
  const left=view.getInt16(44,true);
  const right=view.getInt16(46,true);
  assert.ok(left > 7500 && left < 9000);
  assert.ok(right < -7500 && right > -9000);
  assert.ok(left!==0 && right!==0,'no forced silence without fade');
});

test('short edge fades are applied evenly to both channels without modifying originals',async()=>{
  const audio = highRate();
  const original = audio.getChannelData(0)[22050];
  const output = await wavFromAudioBuffer(audio,0.25,0.75,{fadeSeconds:0.01}).arrayBuffer();
  const v = new DataView(output);
  assert.equal(v.getInt16(44,true),0);
  assert.equal(v.getInt16(46,true),0);
  assert.equal(v.getInt16(output.byteLength-4,true),0);
  assert.equal(v.getInt16(output.byteLength-2,true),0);
  assert.equal(audio.getChannelData(0)[22050], original);
});

test('PCM validator rejects malformed and truncated headers',async()=>{
  const good=await wavFromAudioBuffer(highRate(),0.1,0.4).arrayBuffer();
  const corrupt=good.slice(0);
  new DataView(corrupt).setUint32(40,100,true);
  assert.equal(validatePcm16Wav(corrupt),false);
  assert.equal(validatePcm16Wav(new ArrayBuffer(20)),false);
  assert.equal(validatePcm16Wav(new Uint8Array(good)),false,'strict ArrayBuffer boundary');
  assert.throws(()=>wavFromAudioBuffer(highRate(),0.1,0.5,{maxBytes:100}));
  assert.throws(()=>wavFromAudioBuffer(mockBuffer({rate:1000}),0.1,0.5),/8 and 192 kHz/);
});

test('downsampled peak waveform is bounded and deterministic',()=>{
  const wave=peakEnvelope(highRate(),30);
  assert.equal(wave.length,30);
  assert.ok(wave.every(p=>p>=0 && p<=1));
  assert.ok(wave[20]>wave[5]);
  assert.throws(()=>peakEnvelope(null));
});

test('six stored ZIP entries have correct local/central headers and no recompression',async()=>{
  const stems=['drums','bass','vocals','guitar','piano','other'];
  const entries=stems.map(name=>({
    name:name+'-clip.wav',
    blob:wavFromAudioBuffer(highRate(),0.1,0.25,{fadeSeconds:0}),
  }));
  const archive=await wavZip(entries);
  const data=new Uint8Array(await archive.arrayBuffer());
  const v=new DataView(data.buffer);
  assert.equal(v.getUint32(data.length-22,true),0x06054b50);
  assert.equal(v.getUint16(data.length-22+10,true),6);
  let position=0;
  for(const stem of stems) {
    assert.equal(v.getUint32(position,true),0x04034b50);
    assert.equal(v.getUint16(position+8,true),0); // store mode
    const size=v.getUint32(position+18,true);
    const filenameSize=v.getUint16(position+26,true);
    const name=new TextDecoder().decode(data.subarray(position+30,position+30+filenameSize));
    assert.equal(name,stem+'-clip.wav');
    const audio=data.subarray(position+30+filenameSize,position+30+filenameSize+size);
    assert.equal(crc32(audio),v.getUint32(position+14,true));
    assert.equal(validatePcm16Wav(audio.slice().buffer),true);
    position+=30+filenameSize+size;
  }
  assert.equal(v.getUint32(position,true),0x02014b50);
  await assert.rejects(wavZip([entries[0],entries[0]]),/Only uniquely named/);
  await assert.rejects(wavZip([{name:'../source.wav',blob:entries[0].blob}]),/Only uniquely named/);
});
test('clip UI integrated with both separators and all six source rows',()=>{
  const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
  const panel=readFileSync(new URL('../src/app/stem-panel.js',import.meta.url),'utf8');
  const native=readFileSync(new URL('../desktop/main.js',import.meta.url),'utf8');
  const preload=readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8');
  const mixer=readFileSync(new URL('../src/app/stem-mixer.js',import.meta.url),'utf8');
  for(const id of [
    'stem-source-clip','stem-source-waveform','stem-source-apply','stem-source-reset',
    'stem-mixer-clips','stem-mixer-clips-waveforms','stem-mixer-clips-export',
  ]) assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(panel,/initSourceClip/);
  assert.match(panel,/initStemExportClip/);
  assert.match(panel,/warnNeedsApply/);
  assert.match(native,/stem:prepare-clip/);
  assert.match(native,/inputPath: stemClipStore\.path \|\| stemInput/);
  assert.match(preload,/prepareClip:/);
  assert.match(mixer,/previewRange\(start, end, from = start\)/);
});
