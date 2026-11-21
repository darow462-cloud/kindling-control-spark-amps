// Experimental reference-only Spark 2 preset builder. This is a transparent,
// deterministic *starting-tone heuristic*, not model/gear identification,
// machine-learned tone cloning, or proof of a spectral match. No upload or
// user recording is required. Generated effects use supported Spark wire IDs.
import { blankPreset, findEffect } from '../spark/effects.js';

export const TONE_STYLES = Object.freeze([
  { value: 'auto', label: 'Automatic estimate' },
  { value: 'clean', label: 'Clean' },
  { value: 'crunch', label: 'Crunch' },
  { value: 'high-gain', label: 'High gain' },
]);

const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));

const ampForStyle = Object.freeze({
  clean: 'Twin',
  crunch: 'Plexi',
  'high-gain': 'Rectifier',
});
const styleLabels = Object.freeze({
  clean: 'Clean / dynamic',
  crunch: 'Crunch / edge of breakup',
  'high-gain': 'High gain / saturated',
});

function normalizedBands(profile) {
  if (!profile || !Array.isArray(profile.bands) || !profile.bands.length ||
      !Number.isFinite(profile.rmsDb) || !Number.isFinite(profile.crestDb) ||
      !Number.isFinite(profile.centroidHz) || profile.rmsDb <= -70) {
    throw new Error('The reference is silent, too quiet, or has no valid audio analysis.');
  }
  const wanted = ['sub', 'bass', 'lowMid', 'mid', 'presence', 'air'];
  const bands = Object.fromEntries(profile.bands.map((band) =>
    [band.key, Number(band.percent)]));
  if (!wanted.every((key) => Number.isFinite(bands[key]) &&
      bands[key] >= 0 && bands[key] <= 100)) {
    throw new Error('Reference frequency-band measurements are invalid.');
  }
  return bands;
}

/** Rough brightness and compression clues, not a trustworthy gain classifier. */
export function guessReferenceTone(profile) {
  const bands = normalizedBands(profile);
  const bright = bands.presence + bands.air;
  const crest = profile.crestDb;
  const dense = bright >= 17 && crest <= 9.5;
  const edged = bright >= 9 && crest <= 15;
  return dense ? 'high-gain' : edged ? 'crunch' : 'clean';
}

export function generateReferencePreset(profile, {
  style = 'auto',
  referenceName = 'Reference',
} = {}) {
  const bands = normalizedBands(profile);
  if (!TONE_STYLES.some((mode) => mode.value === style)) {
    throw new Error('Choose a supported tone character.');
  }
  const guess = guessReferenceTone(profile);
  const chosen = style === 'auto' ? guess : style;
  const ampId = ampForStyle[chosen];
  const ampCatalog = findEffect(ampId);
  if (!ampCatalog || ampCatalog.slot !== 'amp') {
    throw new Error('The selected Spark 2 amp model is unavailable.');
  }

  const namePart = String(referenceName).replace(/\.[^.]+$/, '')
    .replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 46) || 'Reference';
  const name = ('Match - ' + namePart).slice(0, 64);
  const preset = blankPreset(name);
  const low = bands.bass + 0.5 * bands.lowMid;
  const high = bands.presence + 0.75 * bands.air;

  const gainBase = { clean: 0.29, crunch: 0.58, 'high-gain': 0.69 }[chosen];
  const gain = clamp(gainBase + (12 - profile.crestDb) * 0.006,
    chosen === 'clean' ? 0.2 : 0.44,
    chosen === 'high-gain' ? 0.80 : 0.71);
  const bass = clamp(0.47 + (low - 20) * 0.004, 0.28, 0.67);
  const middle = clamp(0.53 + (bands.mid - 29) * 0.003, 0.34, 0.73);
  const treble = clamp(0.48 + (high - 15) * 0.008, 0.32, 0.71);
  const amp = preset.pedals[3];
  amp.name = ampId;
  amp.isOn = true;
  amp.params = [gain, treble, middle, bass, 0.38]; // Spark AMP_PARAMS order

  const gate = preset.pedals[0];
  gate.isOn = chosen === 'high-gain';
  gate.params = [0.18, 0.30];

  const comp = preset.pedals[1];
  comp.isOn = chosen === 'clean' && profile.crestDb > 14;
  comp.params = [0, 0.45, 0.22];

  const drive = preset.pedals[2];
  drive.name = 'DistortionTS9';
  drive.isOn = chosen === 'high-gain';
  drive.params = [0.13, clamp(treble + 0.04, 0.3, 0.7), 0.64];

  const mod = preset.pedals[4];
  mod.isOn = false;
  const delay = preset.pedals[5];
  delay.isOn = false;
  const reverb = preset.pedals[6];
  reverb.isOn = chosen !== 'high-gain';
  reverb.params = [chosen === 'clean' ? 0.15 : 0.10,
    0.52, 0.3, 0.28, 0.28, 0.6, 0.20];

  preset.description =
    'Experimental reference-only starting point. Frequency/crest heuristic; ' +
    'not an exact reconstruction of the recorded amp, cabinet or effects.';
  return {
    preset,
    style: chosen,
    guessedStyle: guess,
    ampLabel: ampCatalog.name,
    summary: [
      style === 'auto'
        ? 'Character estimated automatically: ' + styleLabels[chosen]
        : 'Character selected manually: ' + styleLabels[chosen],
      'Amp: ' + ampCatalog.name +
        ' · Gain ' + Math.round(gain * 100) + '%' +
        ' · Bass ' + Math.round(bass * 100) + '%' +
        ' · Middle ' + Math.round(middle * 100) + '%' +
        ' · Treble ' + Math.round(treble * 100) + '%',
      'Noise gate ' + (gate.isOn ? 'on' : 'off') +
        ' · Tube Drive ' + (drive.isOn ? 'on' : 'off') +
        ' · Reverb ' + (reverb.isOn ? 'on' : 'off'),
      'Initial estimate only: pickup, speaker, microphone, layering and mastering cannot be identified from this recording.',
    ],
  };
}
