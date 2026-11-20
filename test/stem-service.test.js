import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STEM_NAMES, STEM_LABELS, sanitizedStemBase, buildStemCommand,
  validStemName, cleanStemProgress, StemSeparationService,
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
