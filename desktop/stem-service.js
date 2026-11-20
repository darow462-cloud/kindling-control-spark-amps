// Windows desktop source separation: a tightly scoped child process, not a
// general-purpose command runner. No arbitrary executable/command reaches IPC.
// HTDemucs 6-stem is an independent native tool (demucs-rs, Apache-2.0).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export const STEM_NAMES = Object.freeze(['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']);
export const STEM_LABELS = Object.freeze({
  drums: 'Drums', bass: 'Bass', vocals: 'Vocals', guitar: 'Guitars',
  piano: 'Piano / keys', other: 'Other instruments',
});
export const MAX_STEM_INPUT_BYTES = 350 * 1024 * 1024;
const VALID_INPUTS = new Set(['.wav', '.aiff', '.aif', '.flac', '.mp3', '.ogg', '.m4a', '.aac']);
const MAX_PROGRESS_LENGTH = 300;

export function sanitizedStemBase(name) {
  const base = basename(name, extname(name))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48);
  return base || 'track';
}

export function buildStemCommand(inputPath, outputDir) {
  if (typeof inputPath !== 'string' || !inputPath ||
      !VALID_INPUTS.has(extname(inputPath).toLowerCase()) ||
      typeof outputDir !== 'string' || !outputDir) {
    throw new Error('unsupported input audio file');
  }
  return [inputPath, '--model', 'htdemucs_6s', '--output', outputDir];
}

export function validStemName(name) {
  return typeof name === 'string' && STEM_NAMES.includes(name) ? name : null;
}

/** Return a human-readable, bounded progress string from the CLI's stderr. */
export function cleanStemProgress(chunk) {
  const line = String(chunk).split(/[\r\n]/).filter(Boolean).at(-1) || '';
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, MAX_PROGRESS_LENGTH);
}

export class StemSeparationService {
  constructor({ executable, onEvent, spawnProcess = spawn }) {
    this.executable = executable;
    this.onEvent = onEvent;
    this.spawnProcess = spawnProcess;
    this.active = null;
    this.completed = null;
  }

  async start({ inputPath, outputRoot }) {
    if (this.active) throw new Error('A separation is already running');
    const command = buildStemCommand(inputPath, outputRoot);
    const input = await stat(inputPath);
    if (!input.isFile() || input.size === 0 || input.size > MAX_STEM_INPUT_BYTES) {
      throw new Error('Audio file must be nonempty and smaller than 350 MB');
    }
    const output = await stat(outputRoot);
    if (!output.isDirectory()) throw new Error('Select an output folder');
    const prefix = join(outputRoot, `${sanitizedStemBase(inputPath)}-stems-`);
    const outputDir = await mkdtemp(prefix);
    const id = randomUUID();
    const args = [command[0], '--model', 'htdemucs_6s', '--output', outputDir];

    let child;
    try {
      child = this.spawnProcess(this.executable, args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      await rm(outputDir, { recursive: true, force: true });
      throw new Error(`Could not launch the separation engine: ${err.message}`);
    }

    const job = { id, inputPath, outputDir, child, canceled: false, ended: false, lastNotice: 0, lastLine: '' };
    this.active = job;
    this.onEvent({ type: 'started', id, outputDir, model: 'htdemucs_6s' });
    const notify = (chunk) => {
      if (job.ended) return;
      const line = cleanStemProgress(chunk);
      if (!line) return;
      job.lastLine = line;
      const now = Date.now();
      if (now - job.lastNotice >= 150) {
        job.lastNotice = now;
        this.onEvent({ type: 'progress', id, text: line });
      }
    };
    child.stdout?.on('data', notify);
    child.stderr?.on('data', notify);

    const finish = async (error, code = 1) => {
      if (job.ended) return;
      job.ended = true;
      if (this.active === job) this.active = null;
      if (!error && !job.canceled && code === 0) {
        try {
          const stems = [];
          for (const name of STEM_NAMES) {
            const path = join(outputDir, name + '.wav');
            const file = await stat(path);
            if (!file.isFile() || file.size < 48) throw new Error(`Missing/empty ${name}.wav`);
            stems.push({ name, label: STEM_LABELS[name], bytes: file.size, path });
          }
          this.completed = { id, outputDir, stems };
          this.onEvent({ type: 'complete', id, outputDir, stems });
          return;
        } catch (err) {
          error = err;
        }
      }
      // Only remove the unique directory created by mkdtemp for this run.
      // Never delete the user-selected destination or any previous stems.
      await rm(outputDir, { recursive: true, force: true }).catch(() => {});
      this.onEvent({
        type: job.canceled ? 'canceled' : 'error',
        id,
        message: job.canceled ? 'Separation canceled.' :
          `Separation failed: ${error?.message || job.lastLine || `engine exit ${code}`}`,
      });
    };

    child.once('error', (err) => { void finish(err); });
    child.once('close', (code) => { void finish(null, code); });
    return { id, outputDir };
  }

  cancel() {
    if (!this.active) return false;
    this.active.canceled = true;
    try { this.active.child.kill(); } catch { /* process may have exited */ }
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
