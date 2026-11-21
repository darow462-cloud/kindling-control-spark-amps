import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wavFromAudioBuffer } from '../src/app/stem-trim-utils.js';
import {
  StemClipStore, validCanonicalPcmWav, readSelectedAudioForTrim,
} from '../desktop/stem-clip-store.js';

const waveform = {
  sampleRate: 44100, numberOfChannels: 1, length: 44100, duration: 1,
  getChannelData() { return new Float32Array(44100).fill(0.1); },
};
async function wavBytes() {
  return new Uint8Array(await wavFromAudioBuffer(waveform, 0, 1).arrayBuffer());
}
test('the native staging validator permits only bounded canonical PCM16, not file paths', async () => {
  const bytes=await wavBytes();
  assert.equal(validCanonicalPcmWav(bytes),true);
  assert.equal(validCanonicalPcmWav(bytes.buffer),true);
  assert.equal(validCanonicalPcmWav(Buffer.from(bytes)),true);
  assert.equal(validCanonicalPcmWav('C:\\Users\\something.wav'),false);
  assert.equal(validCanonicalPcmWav({path:'C:\\something.wav'}),false);
  const wrong=bytes.slice();
  wrong[0]=0;
  assert.equal(validCanonicalPcmWav(wrong),false);
  const truncated=bytes.subarray(0,100);
  assert.equal(validCanonicalPcmWav(truncated),false);
});

test('prepared clip lives in private temp folder, is replaceable and never edits original',async()=>{
  const root=await mkdtemp(join(tmpdir(),'kindling-trim-test-'));
  const store=new StemClipStore({root});
  try{
    const original=join(root,'original.wav');
    const bytes=await wavBytes();
    await writeFile(original,bytes);
    const initial=await readFile(original);
    const result=await store.prepare(bytes);
    assert.equal(result.active,true);
    const first=store.path;
    assert.ok(first.startsWith(root));
    assert.equal(first.endsWith('selected-clip.wav'),true);
    assert.deepEqual(await readFile(first),Buffer.from(bytes));
    await store.prepare(bytes.slice());
    assert.notEqual(store.path,first);
    await assert.rejects(access(first));
    await store.clear();
    assert.equal(store.path,null);
    await assert.rejects(access(join(root,'nothing')));
    assert.deepEqual(await readFile(original),initial,'original was never changed');
    await assert.rejects(store.prepare(new Uint8Array([0,1,2])),/PCM16/);
  }finally {
    await store.clear();
    await rm(root,{recursive:true,force:true});
  }
});
test('renderer may read only selected audio file with allowed extension and size',async()=>{
  const root=await mkdtemp(join(tmpdir(),'kindling-reader-test-'));
  try {
    const path=join(root,'riff.wav');
    const bytes=await wavBytes();
    await writeFile(path,bytes);
    const result=await readSelectedAudioForTrim(path);
    assert.equal(result.name,'riff.wav');
    assert.deepEqual(Buffer.from(result.bytes),Buffer.from(bytes));
    await assert.rejects(readSelectedAudioForTrim(join(root,'missing.wav')));
    await assert.rejects(readSelectedAudioForTrim(join(root,'untrusted.exe')),/supported/);
  }finally{await rm(root,{recursive:true,force:true});}
});
