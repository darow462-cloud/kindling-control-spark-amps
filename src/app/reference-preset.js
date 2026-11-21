// Spark 2 reference-only tone suggestions. An explainable, uncalibrated
// heuristic proposes several compatible amp/effect presets. These are NOT
// measured/IR-matched models, original-gear recognition or guaranteed
// recreations. A playback recording cannot reveal the original input guitar.
import { blankPreset, findEffect } from '../spark/effects.js';

export const TONE_STYLES = Object.freeze([
  { value: 'auto', label: 'Automatic estimate' },
  { value: 'clean', label: 'Clean' },
  { value: 'crunch', label: 'Crunch' },
  { value: 'high-gain', label: 'High gain' },
]);

const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));

const styleLabels = {
  clean: 'Clean / dynamic',
  crunch: 'Crunch / edge of breakup',
  'high-gain': 'High gain / saturated',
};

// Curated distinct STARTING POINTS, NOT frequency responses or measured Spark
// profiles. Values are normalized 0..1 in Spark's [Gain,Treble,Middle,Bass,Vol]
// order. Avoid falsely attributing tonal identity to simple spectral features.
const MODEL_BANK = Object.freeze({
  clean: [
    { amp: 'Twin', title: 'Open American clean', gain: .31, bass: .48, mid: .52, treble: .53 },
    { amp: 'RolandJC120', title: 'Bright solid-state clean', gain: .27, bass: .43, mid: .48, treble: .59 },
    { amp: 'ADClean', title: 'Warm studio clean', gain: .33, bass: .51, mid: .55, treble: .48 },
    { amp: 'ODS50CN', title: 'Smooth clean response', gain: .35, bass: .45, mid: .59, treble: .51 },
  ],
  crunch: [
    { amp: 'Plexi', title: 'British crunch', gain: .56, bass: .42, mid: .60, treble: .56 },
    { amp: 'OverDrivenJM45', title: 'Rounded vintage crunch', gain: .61, bass: .49, mid: .61, treble: .52 },
    { amp: 'OrangeAD30', title: 'Thick mid-forward crunch', gain: .61, bass: .45, mid: .63, treble: .49 },
    { amp: 'Bogner', title: 'Saturated modern crunch', gain: .59, bass: .41, mid: .57, treble: .57 },
    { amp: 'BE101', title: 'Hot-rodded British rhythm', gain: .53, bass: .43, mid: .58, treble: .55 },
  ],
  'high-gain': [
    { amp: '6505Plus', title: 'Tight modern rhythm', gain: .61, bass: .41, mid: .58, treble: .56, boost: true },
    { amp: 'Rectifier', title: 'Heavy wide rhythm', gain: .59, bass: .40, mid: .53, treble: .55, boost: true },
    { amp: 'SLO100', title: 'Focused saturated lead', gain: .65, bass: .45, mid: .61, treble: .54, boost: false },
    { amp: 'BE101', title: 'Defined high-gain British', gain: .64, bass: .43, mid: .59, treble: .58, boost: false },
    { amp: 'EVH', title: 'Aggressive modern distortion', gain: .60, bass: .40, mid: .56, treble: .57, boost: true },
  ],
});

function normalizedBands(profile) {
  if (!profile || !Array.isArray(profile.bands) || !profile.bands.length ||
      !Number.isFinite(profile.rmsDb) || !Number.isFinite(profile.crestDb) ||
      !Number.isFinite(profile.centroidHz) || profile.rmsDb <= -70) {
    throw new Error('The reference is silent, too quiet, or has no valid audio analysis.');
  }
  const wanted = ['sub', 'bass', 'lowMid', 'mid', 'presence', 'air'];
  const bands = Object.fromEntries(profile.bands.map(band =>
    [band.key, Number(band.percent)]));
  if (!wanted.every(key => Number.isFinite(bands[key]) &&
      bands[key] >= 0 && bands[key] <= 100)) {
    throw new Error('Reference frequency-band measurements are invalid.');
  }
  return bands;
}

// The first version relied almost entirely on peak-to-RMS crest and mistook
// dense layered distorted guitar for crunch (guitar-clip.wav example).
// New estimates require broadband content plus a stable short-time envelope.
// Pure sine notes must not be misidentified as highly distorted.
export function guessReferenceTone(profile) {
  const bands = normalizedBands(profile);
  const upper = bands.presence + bands.air;
  const hasFeatures = Number.isFinite(profile.spectralFlatness) &&
    Number.isFinite(profile.envelopeContrastDb) &&
    Number.isFinite(profile.rolloffHz);
  if (!hasFeatures) {
    // Compatibility with old or synthetic profiles. Never claim confidence.
    if (upper >= 17 && profile.crestDb <= 9.5) return 'high-gain';
    if (upper >= 9 && profile.crestDb <= 15) return 'crunch';
    return 'clean';
  }
  const broadband = profile.spectralFlatness >= .012 &&
    profile.rolloffHz >= 1700;
  const dense = profile.envelopeContrastDb > 0 &&
    profile.envelopeContrastDb <= 5.0;
  if (broadband && dense && upper >= 14) return 'high-gain';
  if (broadband && upper >= 9) return 'crunch';
  return 'clean';
}

function diagnostics(profile, bands, chosen, guessed, style) {
  const output = [];
  const fmt = (n, places = 1) => Number.isFinite(n) ? n.toFixed(places) : 'n/a';
  if (Number.isFinite(profile.envelopeContrastDb)) {
    output.push('Short-time envelope contrast: ' + fmt(profile.envelopeContrastDb) +
      ' dB; spectral flatness: ' + fmt(profile.spectralFlatness, 3) +
      '; 95% spectral rolloff: ' + Math.round(profile.rolloffHz || 0) + ' Hz.');
  }
  if (Number.isFinite(profile.stereoCorrelation) && profile.stereoCorrelation < .3) {
    output.push('Low stereo-channel correlation (' + fmt(profile.stereoCorrelation, 2) +
      '): possible double-tracked guitars, phase differences or separation artefacts. One amp cannot recreate a layered stereo mix.');
  }
  if (bands.bass >= 30) {
    output.push('Strong 80–250 Hz energy may come from the played notes; Bass is intentionally kept conservative to avoid a boomy tone.');
  }
  if (style === 'auto') {
    output.push('Automatic tone character is an uncertain estimate (' +
      styleLabels[guessed] + '). Choose another character if it sounds wrong.');
  } else {
    output.push('Tone character manually selected: ' + styleLabels[chosen] + '.');
  }
  output.push('No real Spark 2 amp-response measurements were used. Amp/cabinet/effect identity cannot be recovered from a mastered stem alone.');
  return output;
}

function makeCandidate(profile, bands, model, index, style, referenceName, warnings) {
  const metadata = findEffect(model.amp);
  if (!metadata || metadata.slot !== 'amp') {
    throw new Error('A candidate Spark 2 amplifier is absent from the compatibility catalog: ' + model.amp);
  }
  const namePart = String(referenceName).replace(/\.[^.]+$/, '')
    .replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 38) || 'Reference';
  const title = ('Match - ' + namePart + (index ? ' - ' + (index + 1) : '')).slice(0, 64);
  const preset = blankPreset(title);

  // The magnitude of bass frequencies depends heavily on the riff and guitar
  // tuning. Do NOT use the old mapping (bass% -> more Bass). Small differences
  // in presence/middle shape only gently bias physically playable defaults.
  const upper = bands.presence + bands.air;
  const treble = clamp(model.treble + (upper - 20) * .0018, .35, .70);
  const middle = clamp(model.mid + (bands.mid - 24) * .0010, .39, .70);
  const bass = clamp(model.bass + (bands.lowMid - 18) * .0006, .30,
    style === 'high-gain' ? .52 : .62);
  const dense = Number.isFinite(profile.envelopeContrastDb)
    ? clamp((6 - profile.envelopeContrastDb) * .004, -.02, .02) : 0;
  const gain = clamp(model.gain + dense, style === 'clean' ? .20 : .44,
    style === 'high-gain' ? .76 : .69);

  const amp = preset.pedals[3];
  amp.name = model.amp;
  amp.params = [gain, treble, middle, bass, .38];

  const gate = preset.pedals[0];
  gate.isOn = style === 'high-gain';
  gate.params = [.16, .30];

  const comp = preset.pedals[1];
  // A mastered stem is no evidence of a physical compressor in the guitar
  // chain. Do not infer it from crest factor.
  comp.isOn = false;

  const drive = preset.pedals[2];
  drive.name = 'DistortionTS9';
  drive.isOn = !!model.boost;
  drive.params = [.12, clamp(treble + .025, .35, .70), .67];

  // Avoid hallucinating stereo modulation, delays or reverb from layered stems.
  preset.pedals[4].isOn = false;
  preset.pedals[5].isOn = false;
  preset.pedals[6].isOn = false;

  preset.description = 'Tone Match 0.8.1: uncalibrated reference-only alternative ' +
    (index + 1) + '. Not a confirmed reproduction; original amp/cabinet unknown.';

  const fmt = n => Math.round(n * 100) + '%';
  const summary = [
    'Variation ' + (index + 1) + ': ' + model.title + ' (' + styleLabels[style] + ')',
    'Amp: ' + metadata.name + ' · Gain ' + fmt(gain) +
      ' · Bass ' + fmt(bass) + ' · Middle ' + fmt(middle) + ' · Treble ' + fmt(treble),
    'Tube Drive ' + (drive.isOn ? 'on (low drive / boosted level)' : 'off') +
      ' · Noise gate ' + (gate.isOn ? 'on' : 'off') +
      ' · Mod/Delay/Reverb off by default',
  ];
  return {
    id: model.amp,
    label: model.title,
    preset,
    style,
    ampLabel: metadata.name,
    summary,
    warnings,
  };
}

export function generateReferencePresetVariants(profile, {
  style = 'auto', referenceName = 'Reference',
} = {}) {
  const bands = normalizedBands(profile);
  if (!TONE_STYLES.some(s => s.value === style)) {
    throw new Error('Choose a supported tone character.');
  }
  const guessedStyle = guessReferenceTone(profile);
  const chosen = style === 'auto' ? guessedStyle : style;
  const warnings = diagnostics(profile, bands, chosen, guessedStyle, style);
  const candidates = MODEL_BANK[chosen].map((model, index) =>
    makeCandidate(profile, bands, model, index, chosen, referenceName, warnings));
  return { guessedStyle, style: chosen, candidates, warnings };
}

// Compatibility with callers of the 0.8.0 one-preset API.
export function generateReferencePreset(profile, options = {}) {
  const group = generateReferencePresetVariants(profile, options);
  return { ...group.candidates[0], guessedStyle: group.guessedStyle };
}
