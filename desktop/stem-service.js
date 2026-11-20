// Native Windows source separation. The renderer may only choose one of two
// fixed processing modes; it never supplies native args or executable paths.
// Neither mode sends audio to the Spark amplifier or a hosted separation API.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { applyGlobalPeakGuard } from './stem-peakguard.js';

export const STEM_NAMES = Object.freeze(['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']);
export const STEM_LABELS = Object.freeze({
  drums: 'Drums', bass: 'Bass', vocals: 'Vocals', guitar: 'Guitars',
  piano: 'Piano / keys', other: 'Other instruments',
});
export const STEM_MODES = Object.freeze(['standard', 'high-quality']);
export const MAX_STEM_INPUT_BYTES = 350 * 1024 * 1024;
const VALID_INPUTS = new Set(['.wav', '.aiff', '.aif', '.flac', '.mp3', '.ogg', '.m4a', '.aac']);
const MAX_PROGRESS_LENGTH = 300;

export function sanitizedStemBase(name) {
  const base = basename(name, extname(name))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48);
  return base || 'track';
}

export function validateStemMode(mode) {
  if (!STEM_MODES.includes(mode)) throw new Error('unsupported separation mode');
  return mode;
}

/** Fixed CLI args: no model/path/flag is controlled directly by the page. */
export function buildStemCommand(inputPath, outputDir, model = 'htdemucs_6s') {
  if (typeof inputPath !== 'string' || !inputPath ||
      !VALID_INPUTS.has(extname(inputPath).toLowerCase()) ||
      typeof outputDir !== 'string' || !outputDir ||
      !['htdemucs_6s', 'htdemucs_ft'].includes(model)) {
    throw new Error('unsupported input audio file or separation model');
  }
  return [inputPath, '--model', model, '--output', outputDir];
}

export function validStemName(name) {
  return typeof name === 'string' && STEM_NAMES.includes(name) ? name : null;
}

/** Return a bounded status string without terminal escapes. */
export function cleanStemProgress(chunk) {
  const line = String(chunk).split(/[\r\n]/).filter(Boolean).at(-1) || '';
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, MAX_PROGRESS_LENGTH);
}

/**
 * Standard: six-stem HTDemucs only.
 * High Quality: six-stem baseline, then four-stem fine-tuned inference.
 * Replace drums/bass/vocals from FT; retain six-stem guitar/piano/other.
 *
 * The outputs of independent ML models are not guaranteed to sum perfectly
 * to the input. We deliberately avoid subtracting one noisy model from the
 * other, because that can amplify artifacts in the residual 'other' stem.
 */
export function stemStages(mode, outputDir) {
  validateStemMode(mode);
  if (mode === 'standard') return [{
    model: 'htdemucs_6s', outputDir, label: '6-stem model',
  }];
  return [
    { model: 'htdemucs_6s', outputDir: join(outputDir, '_six'), label: '6-stem model' },
    { model: 'htdemucs_ft', outputDir: join(outputDir, '_ft'), label: 'fine-tuned model (drums/bass/vocals)' },
  ];
}

export class StemSeparationService {
  constructor({ executable, onEvent, spawnProcess = spawn, peakGuard = applyGlobalPeakGuard }) {
    this.executable = executable;
    this.onEvent = onEvent;
    this.spawnProcess = spawnProcess;
    this.peakGuard = peakGuard;
    this.active = null;
    this.starting = false;
    this.completed = null;
  }

  async start({ inputPath, outputRoot, mode = 'standard', protectPeaks = true }) {
    if (this.active || this.starting) throw new Error('A separation is already running');
    validateStemMode(mode);
    if (typeof protectPeaks !== 'boolean') throw new Error('Invalid peak protection option');
    this.starting = true;
    try {
      buildStemCommand(inputPath, outputRoot);
      const input = await stat(inputPath);
      if (!input.isFile() || input.size === 0 || input.size > MAX_STEM_INPUT_BYTES) {
        throw new Error('Audio file must be nonempty and smaller than 350 MB');
      }
      const output = await stat(outputRoot);
      if (!output.isDirectory()) throw new Error('Select an output folder');
      const prefix = join(outputRoot, `${sanitizedStemBase(inputPath)}-stems-`);
      const outputDir = await mkdtemp(prefix);
      const id = randomUUID();
      const job = {
        id, inputPath, outputDir, mode, protectPeaks,
        child: null, canceled: false, ended: false, lastLine: '', lastNotice: 0,
      };
      this.active = job;
      this.onEvent({ type: 'started', id, outputDir, mode, protectPeaks });
      void this._process(job);
      return { id, outputDir, mode };
    } finally {
      this.starting = false;
    }
  }

  async _runStage(job, stage, index, total) {
    if (job.canceled) throw new Error('Separation canceled');
    this.onEvent({
      type: 'stage', id: job.id, index: index + 1, total,
      model: stage.model, label: stage.label,
    });
    const args = buildStemCommand(job.inputPath, stage.outputDir, stage.model);
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.executable, args, {
          shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new Error(`Could not start native model: ${err.message}`));
        return;
      }
      job.child = child;
      let finished = false;
      const notify = (chunk) => {
        if (finished || job.canceled) return;
        const line = cleanStemProgress(chunk);
        if (!line) return;
        job.lastLine = line;
        const now = Date.now();
        if (now - job.lastNotice >= 150) {
          job.lastNotice = now;
          this.onEvent({ type: 'progress', id: job.id, text: line, stage: index + 1, total });
        }
      };
      const done = (err, code) => {
        if (finished) return;
        finished = true;
        job.child = null;
        if (job.canceled) reject(new Error('Separation canceled'));
        else if (err) reject(err);
        else if (code !== 0) reject(new Error(job.lastLine || `model exited with code ${code}`));
        else resolve();
      };
      child.stdout?.on('data', notify);
      child.stderr?.on('data', notify);
      child.once('error', (err) => done(new Error(`Native engine error: ${err.message}`)));
      child.once('close', (code) => done(null, code));
      if (job.canceled) {
        try { child.kill(); } catch { /* process already exiting */ }
      }
    });
  }

  async _process(job) {
    try {
      const stages = stemStages(job.mode, job.outputDir);
      for (let i = 0; i < stages.length; i++) {
        await this._runStage(job, stages[i], i, stages.length);
      }
      if (job.canceled) throw new Error('Separation canceled');

      if (job.mode === 'high-quality') {
        this.onEvent({ type: 'progress', id: job.id, text: 'Combining the two model results…' });
        for (const name of STEM_NAMES) {
          // Fine-tuned drums, bass and vocals only; guitar, piano, other stay
          // with the 6-stem model, no subtraction/no artificial residuals.
          const modelDir = ['drums', 'bass', 'vocals'].includes(name)
            ? stages[1].outputDir : stages[0].outputDir;
          await copyFile(join(modelDir, name + '.wav'), join(job.outputDir, name + '.wav'));
        }
        await Promise.all(stages.map((stage) =>
          rm(stage.outputDir, { recursive: true, force: true })));
      }
      if (job.canceled) throw new Error('Separation canceled');
      const paths = STEM_NAMES.map((name) => join(job.outputDir, name + '.wav'));
      const stems = [];
      for (let i = 0; i < STEM_NAMES.length; i++) {
        const file = await stat(paths[i]);
        if (!file.isFile() || file.size < 48) throw new Error(`Missing/empty ${STEM_NAMES[i]}.wav`);
        stems.push({ name: STEM_NAMES[i], label: STEM_LABELS[STEM_NAMES[i]], bytes: file.size, path: paths[i] });
      }

      this.onEvent({ type: 'progress', id: job.id, text: 'Checking output peaks and headroom…' });
      const peak = await this.peakGuard(paths, { enabled: job.protectPeaks });
      if (job.canceled) throw new Error('Separation canceled');

      this.completed = { id: job.id, outputDir: job.outputDir, stems, mode: job.mode, peak };
      this.onEvent({ type: 'complete', ...this.completed });
    } catch (err) {
      await rm(job.outputDir, { recursive: true, force: true }).catch(() => {});
      this.onEvent({
        type: job.canceled ? 'canceled' : 'error', id: job.id,
        message: job.canceled ? 'Separation canceled.' :
          `Separation failed: ${err.message || job.lastLine || 'unknown error'}`,
      });
    } finally {
      job.ended = true;
      if (this.active === job) this.active = null;
    }
  }

  cancel() {
    if (!this.active) return false;
    this.active.canceled = true;
    const child = this.active.child;
    if (child) {
      try { child.kill(); } catch { /* process may have exited */ }
    }
    return true;
  }

  fileFor(sessionId, stemName) {
    if (!this.completed || this.completed.id !== sessionId || !validStemName(stemName)) return null;
    return this.completed.stems.find((stem) => stem.name === stemName)?.path ?? null;
  }

  close() {
    this.cancel();
  }
}
