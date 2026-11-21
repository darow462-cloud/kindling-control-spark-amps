// Shared, non-destructive audio clipping primitives. No native filesystem
// access, external audio service, normalization or new runtime dependencies.
export const MAX_SOURCE_DECODE_BYTES = 180 * 1024 * 1024;
export const MAX_CLIP_WAV_BYTES = 175 * 1024 * 1024;
export const MAX_CLIP_SECONDS = 15 * 60;
export const CLIP_MIN_SECONDS = 0.10;
export const MAX_ZIP_BYTES = 512 * 1024 * 1024;

export function normalizedClip(start, end, duration, minSeconds = CLIP_MIN_SECONDS) {
  if (![start, end, duration, minSeconds].every(Number.isFinite) ||
      duration <= 0 || minSeconds <= 0 || end <= start ||
      start < 0 || end > duration + 0.011 || end - start < minSeconds - 1e-8) {
    throw new Error('Select a valid audio segment of at least 0.1 seconds.');
  }
  return { start: Math.max(0, start), end: Math.min(duration, end) };
}

export function clipIsFull(range, duration) {
  return !!range && Number.isFinite(duration) && duration > 0 &&
    range.start <= 0.015 && range.end >= duration - 0.015;
}

export function durationClock(seconds) {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(value);
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0') +
    '.' + String(Math.round((value - whole) * 100)).padStart(2, '0').slice(-2);
}

export function peakEnvelope(buffer, bins = 260) {
  if (!buffer || !Number.isInteger(buffer.numberOfChannels) ||
      buffer.numberOfChannels < 1 || !Number.isFinite(buffer.length) ||
      buffer.length < 1 || !Number.isInteger(bins) || bins < 1 || bins > 2048) {
    throw new Error('Invalid audio data for waveform.');
  }
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) },
    (_, n) => buffer.getChannelData(n));
  const peaks = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const start = Math.floor(i * buffer.length / bins);
    const stop = Math.max(start + 1, Math.floor((i + 1) * buffer.length / bins));
    let p = 0;
    // Bounded sample scan for fast waveform extraction on long source clips.
    const stride = Math.max(1, Math.floor((stop - start) / 96));
    for (let j = start; j < stop; j += stride) {
      for (const samples of channels) p = Math.max(p, Math.abs(samples[j] || 0));
    }
    peaks[i] = Math.min(1, p);
  }
  return peaks;
}

export function wavFromAudioBuffer(buffer, startSeconds, endSeconds, {
  fadeSeconds = 0.005, maxBytes = MAX_CLIP_WAV_BYTES,
} = {}) {
  if (!buffer || !Number.isFinite(buffer.sampleRate) ||
      !Number.isInteger(buffer.numberOfChannels) ||
      ![1, 2].includes(buffer.numberOfChannels) ||
      !Number.isFinite(buffer.duration) || !Number.isInteger(buffer.length) ||
      buffer.sampleRate < 8000 || buffer.sampleRate > 192000) {
    throw new Error('Clipping supports mono or stereo audio between 8 and 192 kHz.');
  }
  const { start, end } = normalizedClip(startSeconds, endSeconds, buffer.duration);
  const startFrame = Math.round(start * buffer.sampleRate);
  const endFrame = Math.min(buffer.length, Math.round(end * buffer.sampleRate));
  const frameCount = endFrame - startFrame;
  const channels = buffer.numberOfChannels;
  const totalBytes = 44 + frameCount * channels * 2;
  if (frameCount < 1 || totalBytes > maxBytes || totalBytes > 0xffffffff) {
    throw new Error('Selected WAV segment is too large. Choose a shorter section.');
  }
  const output = new Uint8Array(totalBytes);
  const view = new DataView(output.buffer);
  function ascii(offset, value) {
    for (let i = 0; i < value.length; i++) output[offset + i] = value.charCodeAt(i);
  }
  ascii(0, 'RIFF');
  view.setUint32(4, totalBytes - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, totalBytes - 44, true);

  const samples = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  const fade = Math.min(Math.floor(frameCount / 2), Math.max(0, Math.floor(fadeSeconds * buffer.sampleRate)));
  let offset = 44;
  for (let f = 0; f < frameCount; f++) {
    const envelope = fade ? Math.min(1, f / fade, (frameCount - 1 - f) / fade) : 1;
    for (let ch = 0; ch < channels; ch++) {
      const value = Math.max(-1, Math.min(1, (samples[ch][startFrame + f] || 0) * envelope));
      view.setInt16(offset, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
      offset += 2;
    }
  }
  return new Blob([output], { type: 'audio/wav' });
}

export function validatePcm16Wav(data, maxBytes = MAX_CLIP_WAV_BYTES) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 46 ||
      data.byteLength > maxBytes) return false;
  const view = new DataView(data);
  const tag = (offset, str) => [...str].every((c, i) => view.getUint8(offset + i) === c.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') ||
      !tag(12, 'fmt ') || !tag(36, 'data') ||
      view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 ||
      ![1, 2].includes(view.getUint16(22, true)) ||
      view.getUint16(34, true) !== 16) return false;
  const rate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const bytes = view.getUint32(40, true);
  return rate >= 8000 && rate <= 192000 &&
    view.getUint16(32, true) === channels * 2 &&
    view.getUint32(28, true) === rate * channels * 2 &&
    bytes > 0 && bytes % (channels * 2) === 0 &&
    bytes + 44 === data.byteLength;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let v = n;
  for (let i = 0; i < 8; i++) v = (v >>> 1) ^ (v & 1 ? 0xedb88320 : 0);
  return v >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function wavZip(entries, { maxBytes = MAX_ZIP_BYTES } = {}) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 6) {
    throw new Error('Choose one to six WAV clips for export.');
  }
  const names = new Set();
  const pieces = [];
  const central = [];
  let position = 0;
  let bytesTotal = 0;
  for (const item of entries) {
    if (!/^(drums|bass|vocals|guitar|piano|other)(-clip)?\.wav$/.test(item?.name) ||
        names.has(item.name) || !(item.blob instanceof Blob)) {
      throw new Error('Only uniquely named instrument WAV files can be exported.');
    }
    names.add(item.name);
    if (item.blob.size > MAX_CLIP_WAV_BYTES) throw new Error('A WAV clip exceeds the safe export size.');
    bytesTotal += item.blob.size;
    if (bytesTotal > maxBytes) throw new Error('Clipped tracks exceed the 512 MB ZIP limit.');
    const data = new Uint8Array(await item.blob.arrayBuffer());
    if (!validatePcm16Wav(data.buffer)) throw new Error('Invalid clipped WAV content.');
    const name = new TextEncoder().encode(item.name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, 0, true); // Stored, no compression.
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const v = new DataView(entry.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint32(16, crc, true);
    v.setUint32(20, data.length, true);
    v.setUint32(24, data.length, true);
    v.setUint16(28, name.length, true);
    v.setUint32(42, position, true);
    entry.set(name, 46);
    central.push(entry);
    pieces.push(local, item.blob);
    position += local.length + item.blob.size;
  }
  const directoryStart = position;
  for (const e of central) { pieces.push(e); position += e.length; }
  const tail = new Uint8Array(22);
  const end = new DataView(tail.buffer);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, position - directoryStart, true);
  end.setUint32(16, directoryStart, true);
  return new Blob([...pieces, tail], { type: 'application/zip' });
}

export function triggerDownload(blob, filename, { documentRef = document, urlApi = URL } = {}) {
  const url = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  documentRef.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Leave the URL active during the asynchronous Chromium download kickoff.
  setTimeout(() => urlApi.revokeObjectURL(url), 60000);
}
