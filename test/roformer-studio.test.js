import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFileSync } from 'node:fs';
import { mkdtemp as mkdtempAsync, mkdir as mkdirAsync, writeFile as writeFileAsync, rm as rmAsync, symlink as symlinkAsync, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  resolveStudioResource, studioContentType,
  ROFORMER_ORIGIN, ROFORMER_SOURCE_COMMIT,
} from '../desktop/roformer-studio.js';

test('pinned RoFormer provenance and exact MIME types for WebAssembly workers', () => {
  assert.match(ROFORMER_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(ROFORMER_ORIGIN, 'kindling-roformer://studio');
  assert.equal(studioContentType('/foo.wasm'), 'application/wasm');
  assert.equal(studioContentType('/foo.js'), 'text/javascript; charset=utf-8');
  assert.equal(studioContentType('/index.html'), 'text/html; charset=utf-8');
});

test('bundled studio resolver only serves trusted host and files inside the studio', async () => {
  const dir = await mkdtempAsync(join(tmpdir(), 'kindling-roformer-'));
  const studio = join(dir, 'studio');
  await mkdirAsync(studio);
  await writeFileAsync(join(studio, 'index.html'), '<html>local</html>');
  await writeFileAsync(join(studio, 'worker.js'), 'console.log(1)');
  await writeFileAsync(join(dir, 'secret.txt'), 'SECRET');
  try {
    const homepage = await resolveStudioResource(studio, 'kindling-roformer://studio/');
    assert.equal(homepage.file, await realpath(join(studio, 'index.html')));
    assert.equal(homepage.type, 'text/html; charset=utf-8');
    const worker = await resolveStudioResource(studio, 'kindling-roformer://studio/worker.js');
    assert.equal(worker.file, await realpath(join(studio, 'worker.js')));
    await assert.rejects(resolveStudioResource(studio, 'kindling://app/index.html'), /untrusted/);
    await assert.rejects(resolveStudioResource(studio, 'kindling-roformer://evil/index.html'), /untrusted/);
    await assert.rejects(resolveStudioResource(studio, 'https://example.com/index.html'), /untrusted/);
    await assert.rejects(resolveStudioResource(studio, 'kindling-roformer://studio/%00index.html'));
    await assert.rejects(resolveStudioResource(studio, 'kindling-roformer://studio/not-there.wasm'));
    await assert.rejects(resolveStudioResource(studio, 'kindling-roformer://studio/%2e%2e/secret.txt'));
  } finally {
    await rmAsync(dir, { recursive: true, force: true });
  }
});

test('studio resource resolver refuses symlinks to other local folders', async () => {
  const dir = await mkdtempAsync(join(tmpdir(), 'kindling-roformer-'));
  const studio = join(dir, 'studio');
  await mkdirAsync(studio);
  await writeFileAsync(join(dir, 'private.wav'), 'SECRET');
  try {
    await symlinkAsync(join(dir, 'private.wav'), join(studio, 'model.wasm'));
    await assert.rejects(resolveStudioResource(studio, 'kindling-roformer://studio/model.wasm'), /outside/);
  } finally {
    await rmAsync(dir, { recursive: true, force: true });
  }
});

test('Electron preload only exposes a fixed RoFormer launch IPC', async () => {
  let desktop;
  const invoked = [];
  const source = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  runInNewContext(source, {
    process: { platform: 'win32' },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, object) => { desktop = object; } },
      ipcRenderer: {
        on() {}, removeListener() {}, send() {},
        invoke: async (channel, ...args) => { invoked.push({ channel, args }); return true; },
      },
    }),
  });
  assert.equal(typeof desktop?.roformer?.openStudio, 'function');
  assert.equal(desktop.roformer.spawn, undefined);
  assert.equal(await desktop.roformer.openStudio(), true);
  assert.deepEqual(invoked, [{ channel: 'roformer:open', args: [] }]);
});
