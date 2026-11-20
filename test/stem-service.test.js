import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STEM_NAMES, STEM_LABELS, sanitizedStemBase, buildStemCommand,
  validStemName, cleanStemProgress, StemSeparationService,
  validateStemMode, stemStages, STEM_MODES,
} from '../desktop/stem-service.js';

function fakeProcess(onLaunch) {
  return (executable, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', 1));
      return true;
    };
    queueMicrotask(() => {
      onLaunch({ executable, args, opts, child });
    });
    return child;
  };
}

async function tempFolder() {
  const root = await mkdtemp(join(tmpdir(), 'kindling-stems-test-'));
  const input = join(root, 'My song.mp3');
  await writeFile(input, Buffer.from([0x49, 0x44, 0x33, 1]));
  const outputRoot = join(root, 'output');
  await mkdir(outputRoot);
  return { root, input, outputRoot };
}

test('command uses only pinned 6-stem model, no shell and no user-controlled flags', () => {
  const args = buildStemCommand('C:\\Music\\Track.mp3', 'C:\\Out');
  assert.deepEqual(args, ['C:\\Music\\Track.mp3', '--model', 'htdemucs_6s', '--output', 'C:\\Out']);
  assert.throws(() => buildStemCommand('--model', 'C:\\Out'), /unsupported/);
  assert.throws(() => buildStemCommand('script.bat', 'C:\\Out'), /unsupported/);
  assert.equal(sanitizedStemBase('../../Über /weird?.mp3'), 'weird');
  assert.equal(validStemName('guitar'), 'guitar');
  assert.equal(validStemName('../../secret'), null);
  assert.deepEqual(STEM_NAMES, ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other']);
  assert.equal(STEM_LABELS.guitar, 'Guitars');
});

test('progress messages strip terminal escapes and remain bounded', () => {
  assert.equal(cleanStemProgress('\x1b[32mLoading model...\x1b[0m'), 'Loading model...');
  assert.equal(cleanStemProgress('Reading\rDownloading 10%'), 'Downloading 10%');
  assert.equal(cleanStemProgress('x'.repeat(600)).length, 300);
});

test('successful native run returns 6 output WAV paths, engine arguments and local session URLs', async () => {
  const { root, input, outputRoot } = await tempFolder();
  const events = [];
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const fake = fakeProcess(({ executable, args, opts, child }) => {
    assert.equal(executable, 'demucs-test.exe');
    assert.equal(opts.shell, false);
    assert.equal(opts.windowsHide, true);
    assert.equal(args[2], 'htdemucs_6s');
    child.stderr.emit('data', 'Loading cached model...\rSeparating...');
    (async () => {
      for (const name of STEM_NAMES) await writeFile(join(args[4], name + '.wav'), Buffer.alloc(100, 1));
      child.emit('close', 0);
    })().catch((e) => child.emit('error', e));
  });
  const separator = new StemSeparationService({
    // Legacy subprocess tests use tiny placeholder WAVs; real float WAV
    // validation and level protection have their own regression suite.
    peakGuard: async () => ({ gainDb: 0, peakBeforeDb: -3, peakAfterDb: -3, samplesOverFullScale: 0, enabled: true }),
    executable: 'demucs-test.exe', spawnProcess: fake,
    onEvent: (event) => { events.push(event); if (event.type === 'complete' || event.type === 'error') resolve(event); },
  });
  try {
    const started = await separator.start({ inputPath: input, outputRoot });
    const finished = await done;
    assert.equal(finished.type, 'complete');
    assert.equal(finished.id, started.id);
    assert.equal(finished.stems.length, 6);
    assert.ok(events.some((event) => event.type === 'progress'));
    assert.equal(separator.fileFor(started.id, 'guitar'), join(started.outputDir, 'guitar.wav'));
    assert.equal(separator.fileFor(started.id, '../../input.mp3'), null);
    assert.equal(separator.fileFor('other-session', 'guitar'), null);
    assert.equal((await stat(separator.fileFor(started.id, 'bass'))).size, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation stops the engine and deletes only this run’s incomplete output folder', async () => {
  const { root, input, outputRoot } = await tempFolder();
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const separator = new StemSeparationService({
    // Legacy subprocess tests use tiny placeholder WAVs; real float WAV
    // validation and level protection have their own regression suite.
    peakGuard: async () => ({ gainDb: 0, peakBeforeDb: -3, peakAfterDb: -3, samplesOverFullScale: 0, enabled: true }),
    executable: 'demucs-test.exe',
    spawnProcess: fakeProcess(() => {}),
    onEvent: (event) => { if (event.type === 'canceled') resolve(event); },
  });
  try {
    const started = await separator.start({ inputPath: input, outputRoot });
    assert.equal(separator.cancel(), true);
    const result = await done;
    assert.equal(result.type, 'canceled');
    assert.equal(separator.active, null);
    await assert.rejects(stat(started.outputDir), { code: 'ENOENT' });
    assert.equal((await readFile(input)).length, 4, 'user input must not be deleted');
    assert.equal((await stat(outputRoot)).isDirectory(), true, 'destination folder must not be deleted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('engine failure and missing stems are reported without retaining partial output', async () => {
  for (const exitCode of [0, 2]) {
    const { root, input, outputRoot } = await tempFolder();
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const separator = new StemSeparationService({
    // Legacy subprocess tests use tiny placeholder WAVs; real float WAV
    // validation and level protection have their own regression suite.
    peakGuard: async () => ({ gainDb: 0, peakBeforeDb: -3, peakAfterDb: -3, samplesOverFullScale: 0, enabled: true }),
      executable: 'demucs-test.exe',
      spawnProcess: fakeProcess(({ child }) => {
        child.stderr.emit('data', 'GPU device unavailable');
        child.emit('close', exitCode);
      }),
      onEvent: (event) => { if (event.type === 'error') resolve(event); },
    });
    try {
      const started = await separator.start({ inputPath: input, outputRoot });
      const result = await done;
      assert.equal(result.type, 'error');
      assert.match(result.message, /Separation failed/);
      await assert.rejects(stat(started.outputDir), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('rejects unsupported inputs and concurrent separation without spawning', async () => {
  const { root, input, outputRoot } = await tempFolder();
  let count = 0;
  const separator = new StemSeparationService({
    // Legacy subprocess tests use tiny placeholder WAVs; real float WAV
    // validation and level protection have their own regression suite.
    peakGuard: async () => ({ gainDb: 0, peakBeforeDb: -3, peakAfterDb: -3, samplesOverFullScale: 0, enabled: true }),
    executable: 'demucs-test.exe',
    spawnProcess: (...args) => {
      count++;
      return fakeProcess(() => {})(...args);
    },
    onEvent: () => {},
  });
  try {
    await assert.rejects(separator.start({ inputPath: join(root, 'bad.exe'), outputRoot }), /unsupported/);
    await separator.start({ inputPath: input, outputRoot });
    await assert.rejects(separator.start({ inputPath: input, outputRoot }), /already running/);
    assert.equal(count, 1);
    separator.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('allowlisted High Quality mode uses only the 6s and FT models', () => {
  assert.deepEqual(STEM_MODES, ['standard', 'high-quality']);
  assert.equal(validateStemMode('high-quality'), 'high-quality');
  assert.throws(() => validateStemMode('../../anything'), /unsupported/);
  assert.throws(() => buildStemCommand('song.wav', '/tmp', 'untrusted'), /unsupported/);
  const stages = stemStages('high-quality', '/tmp/example');
  assert.deepEqual(stages.map((s) => s.model), ['htdemucs_6s', 'htdemucs_ft']);
  assert.deepEqual(stemStages('standard', '/tmp/example').map((s) => s.model), ['htdemucs_6s']);
});

test('High Quality combines fine-tuned drums/bass/vocals and six-stem guitar/piano/other', async () => {
  const { root, input, outputRoot } = await tempFolder();
  const launched = [];
  const events = [];
  let resolveFinish;
  const finished = new Promise((resolve) => { resolveFinish = resolve; });
  let receivedPaths = null;
  const separator = new StemSeparationService({
    executable: 'demucs-test.exe',
    peakGuard: async (paths, opts) => {
      receivedPaths = paths;
      assert.equal(opts.enabled, true);
      return { gainDb: -1.5, peakBeforeDb: 0.5, peakAfterDb: -1, enabled: true, samplesOverFullScale: 8 };
    },
    spawnProcess: fakeProcess(({ args, child }) => {
      launched.push(args);
      (async () => {
        await mkdir(args[4], { recursive: true });
        const model = args[2];
        for (const name of model === 'htdemucs_ft'
          ? ['drums', 'bass', 'other', 'vocals'] : STEM_NAMES) {
          const marker = model === 'htdemucs_ft' ? 70 : 60;
          await writeFile(join(args[4], name + '.wav'), Buffer.alloc(100, marker));
        }
        child.emit('close', 0);
      })().catch((err) => child.emit('error', err));
    }),
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'complete' || event.type === 'error') resolveFinish(event);
    },
  });
  try {
    const started = await separator.start({ inputPath: input, outputRoot, mode: 'high-quality' });
    const result = await finished;
    assert.equal(result.type, 'complete', result.message);
    assert.equal(result.id, started.id);
    assert.equal(result.mode, 'high-quality');
    assert.equal(result.peak.gainDb, -1.5);
    assert.equal(launched.length, 2);
    assert.deepEqual(launched.map((args) => args[2]), ['htdemucs_6s', 'htdemucs_ft']);
    assert.equal(events.filter((e) => e.type === 'stage').length, 2);
    assert.equal(receivedPaths.length, 6);
    for (const name of STEM_NAMES) {
      const byte = (await readFile(join(started.outputDir, name + '.wav')))[0];
      assert.equal(byte, ['drums', 'bass', 'vocals'].includes(name) ? 70 : 60);
    }
    assert.equal(separator.fileFor(started.id, 'guitar'), join(started.outputDir, 'guitar.wav'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation during the FT stage aborts without exporting half-finished HQ stems', async () => {
  const { root, input, outputRoot } = await tempFolder();
  let resolveSecond;
  const secondStarted = new Promise((resolve) => { resolveSecond = resolve; });
  let resolveCanceled;
  const canceled = new Promise((resolve) => { resolveCanceled = resolve; });
  const separator = new StemSeparationService({
    executable: 'demucs-test.exe',
    peakGuard: async () => { throw new Error('guard should not run after cancel'); },
    spawnProcess: fakeProcess(({ args, child }) => {
      if (args[2] === 'htdemucs_ft') {
        resolveSecond();
        return;
      }
      (async () => {
        await mkdir(args[4], { recursive: true });
        for (const name of STEM_NAMES) {
          await writeFile(join(args[4], name + '.wav'), Buffer.alloc(100, 1));
        }
        child.emit('close', 0);
      })().catch((err) => child.emit('error', err));
    }),
    onEvent: (event) => { if (event.type === 'canceled') resolveCanceled(event); },
  });
  try {
    const started = await separator.start({ inputPath: input, outputRoot, mode: 'high-quality' });
    await secondStarted;
    assert.equal(separator.cancel(), true);
    const event = await canceled;
    assert.equal(event.id, started.id);
    await assert.rejects(stat(started.outputDir), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
