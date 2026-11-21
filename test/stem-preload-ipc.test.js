// Regression: the Stems UI passes mode + protectPeaks through preload to
// desktop/main.js. Before 0.6.1-hotfix, preload discarded both arguments,
// resulting in "Invalid separation settings" for every user-started job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function loadPreloadBridge() {
  const invocations = [];
  let exposed;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'kindlingDesktop');
        exposed = api;
      },
    },
    ipcRenderer: {
      invoke: async (channel, ...args) => {
        invocations.push({ channel, args });
        return { id: 'test-job', mode: args[0]?.mode };
      },
      on() {},
      removeListener() {},
      send() {},
    },
  };
  const source = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  runInNewContext(source, {
    require: (moduleName) => {
      assert.equal(moduleName, 'electron');
      return electron;
    },
    process: { platform: 'win32' },
  }, { filename: 'desktop/preload.cjs' });
  assert.ok(exposed?.stems, 'preload must expose its Stems API');
  return { bridge: exposed.stems, invocations };
}

test('preload forwards Standard mode and enabled peak protection to Electron IPC', async () => {
  const { bridge, invocations } = loadPreloadBridge();
  assert.equal(bridge.supported, true);
  const settings = { mode: 'standard', protectPeaks: true };
  const result = await bridge.start(settings);
  assert.equal(result.id, 'test-job');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].channel, 'stem:start');
  assert.deepEqual(invocations[0].args, [settings]);
});

test('preload forwards High Quality mode and disabled protection (diagnostic)', async () => {
  const { bridge, invocations } = loadPreloadBridge();
  const settings = { mode: 'high-quality', protectPeaks: false };
  await bridge.start(settings);
  assert.equal(invocations[0].channel, 'stem:start');
  assert.equal(invocations[0].args.length, 1);
  assert.equal(invocations[0].args[0].mode, 'high-quality');
  assert.equal(invocations[0].args[0].protectPeaks, false);
});

test('preload exposes no generic shell or arbitrary subprocess actions', () => {
  const { bridge } = loadPreloadBridge();
  assert.equal(bridge.spawn, undefined);
  assert.equal(bridge.exec, undefined);
  assert.equal(bridge.runCommand, undefined);
});
