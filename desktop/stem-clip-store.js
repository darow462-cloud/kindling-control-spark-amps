// Windows-only temporary user-approved audio clip. The renderer can submit a
// bounded canonical PCM16 WAV byte buffer, never a filesystem path, executable,
// filename or arbitrary separation argument. The original chosen song is
// never overwritten and this temporary clip is cleaned up on source change.
import { readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const MAX_AUDIO_PREVIEW_BYTES = 180 * 1024 * 1024;
export const MAX_STAGED_WAV_BYTES = 175 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.wav','.aiff','.aif','.flac','.mp3','.ogg','.m4a','.aac']);

export function validCanonicalPcmWav(value) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) bytes =
    Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else return false;
  if (bytes.length < 46 || bytes.length > MAX_STAGED_WAV_BYTES ||
      bytes.toString('ascii',0,4)!=='RIFF' ||
      bytes.toString('ascii',8,12)!=='WAVE' ||
      bytes.toString('ascii',12,16)!=='fmt ' ||
      bytes.toString('ascii',36,40)!=='data' ||
      bytes.readUInt32LE(16)!==16 ||
      bytes.readUInt16LE(20)!==1 ||
      bytes.readUInt16LE(34)!==16) return false;
  const channels=bytes.readUInt16LE(22);
  const sampleRate=bytes.readUInt32LE(24);
  const length=bytes.readUInt32LE(40);
  if (channels!==1 && channels!==2) return false;
  if (sampleRate<8000 || sampleRate>192000) return false;
  if (bytes.readUInt16LE(32)!==channels*2 ||
      bytes.readUInt32LE(28)!==sampleRate*channels*2 ||
      length+44!==bytes.length ||
      length===0 || length%(channels*2)!==0) return false;
  const duration=length/(sampleRate*channels*2);
  return duration>=0.10 && duration<=900.01;
}

export async function readSelectedAudioForTrim(inputPath) {
  if (typeof inputPath!=='string' || !ALLOWED_EXTENSIONS.has(extname(inputPath).toLowerCase())) {
    throw new Error('Choose a supported audio file first.');
  }
  const info=await stat(inputPath);
  if (!info.isFile() || info.size<1 || info.size>MAX_AUDIO_PREVIEW_BYTES) {
    throw new Error('Source preview supports audio files up to 180 MB; full-song separation is still available.');
  }
  // A file from the operating-system picker, never a renderer-supplied path.
  return { bytes: new Uint8Array(await readFile(inputPath)), name: basename(inputPath) };
}

export class StemClipStore {
  constructor({ root=tmpdir() }={}) {
    this.root=root;
    this.directory=null;
    this.path=null;
  }
  async clear() {
    const prev=this.directory;
    this.directory=null;
    this.path=null;
    if (prev) await rm(prev,{recursive:true,force:true});
  }
  async prepare(value) {
    if (!validCanonicalPcmWav(value)) {
      throw new Error('Selected clip must be a bounded PCM16 WAV of 0.1–900 seconds.');
    }
    // Never trust a client-provided filesystem location. Every clip has
    // a fresh isolated temporary folder and a fixed output basename.
    const directory=await mkdtemp(join(this.root,'kindling-stem-clip-'));
    const path=join(directory,'selected-clip.wav');
    const bytes=value instanceof ArrayBuffer ? Buffer.from(value) :
      Buffer.from(value.buffer,value.byteOffset,value.byteLength);
    try {
      await writeFile(path,bytes,{flag:'wx'});
      await this.clear();
      this.directory=directory;
      this.path=path;
    } catch(error) {
      await rm(directory,{recursive:true,force:true}).catch(()=>{});
      throw error;
    }
    return { bytes: value.byteLength, active: true };
  }
}
