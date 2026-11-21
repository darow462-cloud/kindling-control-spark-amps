import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installRoFormerTransfer } from '../tools/install-roformer-transfer.js';

test('packaging inserts a single local companion without modifying WASM', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'roformer-bridge-'));
  try {
    const studio = join(temp, 'studio');
    await mkdir(studio);
    const index = join(studio, 'index.html');
    const bridge = join(temp, 'bridge.js');
    const original = '<!DOCTYPE html><html><body><canvas id="stem_explorer"></canvas></body></html>';
    await writeFile(index, original);
    await writeFile(bridge, 'window.__test = true;');
    const first = await installRoFormerTransfer({ studioRoot: studio, bridgePath: bridge });
    assert.equal(first.installed, true);
    const second = await installRoFormerTransfer({ studioRoot: studio, bridgePath: bridge });
    assert.equal(second.installed, false);
    const html = await readFile(index, 'utf8');
    assert.equal(html.split('kindling-transfer-bridge.js').length - 1, 1);
    assert.match(html, /<script type="module" src="\.\/kindling-transfer-bridge\.js"><\/script>/);
    assert.equal(await readFile(join(studio, 'kindling-transfer-bridge.js'), 'utf8'),
      'window.__test = true;');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('unexpected upstream HTML fails closed', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'roformer-bad-'));
  try {
    const studio = join(temp, 'studio');
    await mkdir(studio);
    await writeFile(join(studio, 'index.html'), '<html><body>Not Stemyla</body></html>');
    await writeFile(join(temp, 'bridge.js'), 'test');
    await assert.rejects(installRoFormerTransfer({
      studioRoot: studio, bridgePath: join(temp, 'bridge.js'),
    }), /Unexpected pinned Stemyla HTML/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
