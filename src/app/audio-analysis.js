// Local-only audio feature extraction for matching a guitar recording with a
// user-supplied reference. No imports, network, browser globals or Spark BLE.
//
// The spectrum is an averaged Hann-windowed FFT. Percentages compare relative
// spectral energy, NOT instrument separation or an exact amp-model match.

export const AUDIO_BANDS = Object.freeze([
  { key: 'sub', label: 'Sub / rumble', low: 20, high: 80 },
  { key: 'bass', label: 'Bass', low: 80, high: 250 },
  { key: 'lowMid', label: 'Low mids', low: 250, high: 500 },
  { key: 'mid', label: 'Mids', low: 500, high: 2000 },
  { key: 'presence', label: 'Presence', low: 2000, high: 5000 },
  { key: 'air', label: 'Air', low: 5000, high: 12000 },
]);
export const SPECTRUM_MIN_HZ = 40;
export const SPECTRUM_MAX_HZ = 12000;
export const SPECTRUM_POINTS = 72;
export const ANALYSIS_SECONDS = 8;
export const MAX_AUDIO_FILE_BYTES = 40 * 1024 * 1024;

const EPS = 1e-30;

export function fftPower(real, imaginary = new Float64Array(real.length)) {
  const n = real.length;
  if (n < 2 || (n & (n - 1)) !== 0 || imaginary.length !== n) {
    throw new RangeError('FFT length must be a power of two >= 2');
  }
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const step = (-2 * Math.PI) / length;
    const wrStep = Math.cos(step);
    const wiStep = Math.sin(step);
    for (let offset = 0; offset < n; offset += length) {
      let wr = 1;
      let wi = 0;
      for (let i = 0; i < length / 2; i++) {
        const even = offset + i;
        const odd = even + length / 2;
        const tr = wr * real[odd] - wi * imaginary[odd];
        const ti = wr * imaginary[odd] + wi * real[odd];
        real[odd] = real[even] - tr;
        imaginary[odd] = imaginary[even] - ti;
        real[even] += tr;
        imaginary[even] += ti;
        const nr = wr * wrStep - wi * wiStep;
        wi = wr * wiStep + wi * wrStep;
        wr = nr;
      }
    }
  }
  return Float64Array.from({ length: n / 2 + 1 }, (_, i) => real[i] ** 2 + imaginary[i] ** 2);
}

function db(value) {
  return value > EPS ? 20 * Math.log10(value) : -120;
}

/**
 * Analyze a decoded PCM window. Accepts AudioBuffer channel Float32Arrays or
 * synthetic channel arrays for regression tests. Processes at most 2 channels
 * independently (no mono cancellation of opposing stereo signals).
 */
export function analyzePcm({
  channels, sampleRate, startSec = 0, windowSec = ANALYSIS_SECONDS,
  fftSize = 4096, maxWindows = 48,
}) {
  if (!Array.isArray(channels) || !channels.length ||
      !channels.every((c) => c && typeof c.length === 'number' && c.length > 0) ||
      !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000 ||
      !Number.isInteger(fftSize) || fftSize < 256 || (fftSize & (fftSize - 1)) !== 0 ||
      !Number.isFinite(startSec) || startSec < 0 ||
      !Number.isFinite(windowSec) || windowSec <= 0 ||
      !Number.isInteger(maxWindows) || maxWindows < 1 || maxWindows > 200) {
    throw new RangeError('invalid decoded audio or analysis settings');
  }
  const actualChannels = channels.slice(0, 2);
  const totalFrames = Math.min(...actualChannels.map((c) => c.length));
  const start = Math.min(Math.max(0, Math.floor(startSec * sampleRate)), totalFrames - 1);
  const end = Math.min(totalFrames, start + Math.max(1, Math.floor(windowSec * sampleRate)));
  const frames = end - start;

  let sumSquares = 0;
  let peak = 0;
  for (const channel of actualChannels) {
    for (let i = start; i < end; i++) {
      const v = Number.isFinite(channel[i]) ? channel[i] : 0;
      peak = Math.max(peak, Math.abs(v));
      sumSquares += v * v;
    }
  }
  const rms = Math.sqrt(sumSquares / (frames * actualChannels.length));

  const power = new Float64Array(fftSize / 2 + 1);
  const hann = Float64Array.from({ length: fftSize }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1))));
  const availableStarts = Math.max(0, frames - fftSize);
  const windowCount = Math.min(maxWindows, Math.max(1, Math.ceil(frames / fftSize)));
  let processed = 0;
  for (let k = 0; k < windowCount; k++) {
    const windowStart = start + (windowCount === 1 ? 0 : Math.round(availableStarts * k / (windowCount - 1)));
    for (const channel of actualChannels) {
      const real = new Float64Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        const sample = windowStart + i;
        if (sample < end) real[i] = (Number.isFinite(channel[sample]) ? channel[sample] : 0) * hann[i];
      }
      const values = fftPower(real);
      for (let i = 1; i < values.length; i++) power[i] += values[i];
      processed++;
    }
  }

  const bandPowers = new Float64Array(AUDIO_BANDS.length);
  const spectrumPower = new Float64Array(SPECTRUM_POINTS);
  const spectrumCounts = new Uint32Array(SPECTRUM_POINTS);
  let totalPower = 0;
  let weightedFrequency = 0;
  for (let i = 1; i < power.length; i++) {
    const f = i * sampleRate / fftSize;
    const p = power[i] / Math.max(1, processed);
    if (f >= AUDIO_BANDS[0].low && f < AUDIO_BANDS.at(-1).high) {
      const band = AUDIO_BANDS.findIndex((b) => f >= b.low && f < b.high);
      if (band >= 0) bandPowers[band] += p;
      totalPower += p;
      weightedFrequency += f * p;
    }
    if (f >= SPECTRUM_MIN_HZ && f <= SPECTRUM_MAX_HZ) {
      const location = Math.log(f / SPECTRUM_MIN_HZ) / Math.log(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ);
      const bin = Math.min(SPECTRUM_POINTS - 1, Math.floor(location * SPECTRUM_POINTS));
      spectrumPower[bin] += p;
      spectrumCounts[bin]++;
    }
  }
  const averagePower = spectrumPower.map((v, i) => v / Math.max(1, spectrumCounts[i]));
  const strongest = Math.max(...averagePower, EPS);
  const spectrum = Array.from(averagePower, (v) => Math.max(-75, 10 * Math.log10(Math.max(v, EPS) / strongest)));
  return {
    sampleRate,
    startSec: start / sampleRate,
    analyzedSeconds: frames / sampleRate,
    rmsDb: db(rms),
    peakDb: db(peak),
    crestDb: rms > EPS ? 20 * Math.log10(peak / rms) : 0,
    centroidHz: totalPower > EPS ? weightedFrequency / totalPower : 0,
    bands: AUDIO_BANDS.map((band, i) => ({
      ...band,
      percent: totalPower > EPS ? (100 * bandPowers[i] / totalPower) : 0,
    })),
    spectrum,
  };
}

export function analyzeAudioBuffer(audioBuffer, startSec = 0) {
  return analyzePcm({
    channels: Array.from({ length: Math.min(audioBuffer.numberOfChannels, 2) },
      (_, i) => audioBuffer.getChannelData(i)),
    sampleRate: audioBuffer.sampleRate,
    startSec,
  });
}

export function compareAudioProfiles(reference, guitar) {
  if (!reference || !guitar) return [];
  if (reference.rmsDb <= -110 || guitar.rmsDb <= -110) {
    return ['One signal is near silent. Check the selected recording segment or audio input.'];
  }
  const diff = new Map(reference.bands.map((b, i) => [b.key, guitar.bands[i].percent - b.percent]));
  const output = [];
  const low = (diff.get('sub') || 0) + (diff.get('bass') || 0);
  if (low > 7) output.push('Your recording contains more relative low-frequency energy. Try reducing Bass, or check the input and room.');
  if (low < -7) output.push('Your recording contains less relative low-frequency energy. Compare the pickup position and Bass control.');
  if ((diff.get('lowMid') || 0) > 7) output.push('Your recording is more low-mid heavy. Check muddiness around 250–500 Hz.');
  if ((diff.get('mid') || 0) < -7) output.push('Your recording has less relative midrange energy. Review the Middle control.');
  const high = (diff.get('presence') || 0) + (diff.get('air') || 0);
  if (high > 7) output.push('Your recording has more upper-frequency energy. Check Treble, overdrive Tone and pick attack.');
  if (high < -7) output.push('Your recording has less upper-frequency energy. Check Treble, mic/speaker placement and pickup voice.');
  if (Math.abs(guitar.crestDb - reference.crestDb) > 4) {
    output.push(guitar.crestDb < reference.crestDb
      ? 'Your recording has less peak-to-average contrast; it may sound more compressed.'
      : 'Your recording has more peak-to-average contrast; check gain and compression.');
  }
  if (!output.length) output.push('The broad spectral balance is similar. Listen for differences in attack, distortion texture and articulation.');
  return output.slice(0, 4);
}
