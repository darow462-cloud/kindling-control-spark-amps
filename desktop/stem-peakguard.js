// Conservative peak guard for native Demucs f32 WAV outputs.
//
// Float WAV permits >0 dBFS, but typical audio playback clamps at 0 dBFS,
// creating audible crackle. We scan ALL six stems and apply one fixed gain to
// every sample of every stem, preserving inter-stem balance and dynamics.
// Never normalize individual songs/windows/segments or apply compression.

import { open } from 'node:fs/promises';

const BUFFER_BYTES = 512 * 1024;
export const DEFAULT_CEILING_DB = -1;
const db = (value) => value > 0 ? 20 * Math.log10(value) : -Infinity;

async function readExactly(handle, bytes, position) {
  const buf = Buffer.alloc(bytes);
  let done = 0;
  while (done < bytes) {
    const result = await handle.read(buf, done, bytes - done, position + done);
    if (!result.bytesRead) throw new Error('Truncated WAV file');
    done += result.bytesRead;
  }
  return buf;
}

/** Locate IEEE float data in the exact WAV type written by demucs-rs. */
export async function readFloatWavInfo(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 44) throw new Error('Invalid or empty WAV');
    const riff = await readExactly(file, 12, 0);
    if (riff.toString('ascii', 0, 4) !== 'RIFF' ||
        riff.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid RIFF WAV header');

    let offset = 12;
    let isFloatFormat = false;
    let bits = null;
    let channels = null;
    let sampleRate = null;
    let data = null;
    while (offset + 8 <= stat.size) {
      const hdr = await readExactly(file, 8, offset);
      const tag = hdr.toString('ascii', 0, 4);
      const size = hdr.readUInt32LE(4);
      const begin = offset + 8;
      if (begin + size > stat.size) throw new Error('Invalid WAV chunk size');
      if (tag === 'fmt ') {
        if (size < 16 || size > 128) throw new Error('Unsupported WAV fmt chunk');
        const fmt = await readExactly(file, size, begin);
        const tag = fmt.readUInt16LE(0);
        channels = fmt.readUInt16LE(2);
        sampleRate = fmt.readUInt32LE(4);
        bits = fmt.readUInt16LE(14);
        const align = fmt.readUInt16LE(12);
        // Demucs outputs may be WAVE_FORMAT_EXTENSIBLE (0xFFFE) rather
        // than legacy IEEE_FLOAT (3), with a 40-byte fmt chunk. Verify
        // the EXACT IEEE_FLOAT subformat GUID instead of trusting the tag.
        const ieeeFloatGuid = Buffer.from('0300000000001000800000aa00389b71', 'hex');
        const extensibleFloat = tag === 0xfffe && size >= 40 &&
          fmt.readUInt16LE(16) >= 22 &&
          fmt.readUInt16LE(18) === 32 &&
          fmt.subarray(24, 40).equals(ieeeFloatGuid);
        isFloatFormat = tag === 3 || extensibleFloat;
        if (!isFloatFormat || bits !== 32 || channels !== 2 || align !== 8 || !sampleRate) {
          throw new Error('Expected stereo 32-bit float WAV/WAVEX from the separation engine');
        }
      }
      if (tag === 'data') {
        data = { offset: begin, bytes: size };
        break;
      }
      offset = begin + size + (size % 2);
    }
    if (!isFloatFormat || bits !== 32 || channels !== 2 ||
        !data || data.bytes % 8 !== 0 || !data.bytes) {
      throw new Error('Expected a nonempty stereo 32-bit float WAV');
    }
    return { path, dataOffset: data.offset, dataBytes: data.bytes, sampleRate, channels,
      frames: data.bytes / 8 };
  } finally {
    await file.close();
  }
}

async function visitSamples(info, action) {
  const handle = await open(info.path, action.writable ? 'r+' : 'r');
  try {
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    let position = info.dataOffset;
    const end = info.dataOffset + info.dataBytes;
    while (position < end) {
      const bytes = Math.min(BUFFER_BYTES, end - position);
      let count = 0;
      while (count < bytes) {
        const result = await handle.read(buffer, count, bytes - count, position + count);
        if (!result.bytesRead) throw new Error('Truncated WAV sample data');
        count += result.bytesRead;
      }
      for (let i = 0; i < count; i += 4) {
        const value = buffer.readFloatLE(i);
        if (!Number.isFinite(value)) throw new Error('Non-finite sample in separation output');
        const next = action.sample(value);
        if (action.writable) buffer.writeFloatLE(next, i);
      }
      if (action.writable) {
        let written = 0;
        while (written < count) {
          const result = await handle.write(buffer, written, count - written, position + written);
          if (!result.bytesWritten) throw new Error('Could not write corrected WAV data');
          written += result.bytesWritten;
        }
      }
      position += count;
    }
  } finally {
    await handle.close();
  }
}

export async function applyGlobalPeakGuard(paths, { enabled = true, ceilingDb = DEFAULT_CEILING_DB } = {}) {
  if (!Array.isArray(paths) || paths.length < 1 ||
      !Number.isFinite(ceilingDb) || ceilingDb > -0.1 || ceilingDb < -12) {
    throw new RangeError('Invalid peak headroom settings');
  }

  const infos = [];
  let maxPeak = 0;
  let overs = 0;
  for (const path of paths) {
    const info = await readFloatWavInfo(path);
    let localPeak = 0, localOvers = 0;
    await visitSamples(info, { writable: false, sample(value) {
      const magnitude = Math.abs(value);
      if (magnitude > localPeak) localPeak = magnitude;
      if (magnitude >= 1) localOvers++;
    } });
    infos.push({ ...info, peak: localPeak, overs: localOvers });
    maxPeak = Math.max(maxPeak, localPeak);
    overs += localOvers;
  }

  const ceiling = 10 ** (ceilingDb / 20);
  const gain = enabled && maxPeak > ceiling ? ceiling / maxPeak : 1;
  if (gain < 1) {
    for (const info of infos) {
      await visitSamples(info, {
        writable: true,
        sample(value) { return value * gain; },
      });
    }
  }
  return {
    enabled,
    peakBeforeDb: db(maxPeak),
    peakAfterDb: db(maxPeak * gain),
    gainDb: db(gain),
    samplesOverFullScale: overs,
    ceilingDb,
    channels: infos[0].channels,
    sampleRate: infos[0].sampleRate,
  };
}
