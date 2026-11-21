// Adds a small KindlingControl-owned script to the pinned, already-built
// Stemyla index.html at Portable packaging time. Does NOT change upstream
// WASM binaries or model weights. The script runs only at the isolated
// kindling-roformer://studio origin and reads only explicitly requested stems.
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_STUDIO = join(projectRoot, 'build', 'roformer-studio');
const DEFAULT_BRIDGE = join(projectRoot, 'desktop', 'roformer-transfer-bridge.js');
const SCRIPT_NAME = 'kindling-transfer-bridge.js';
const TAG = '<script type="module" src="./' + SCRIPT_NAME + '"></script>';

export async function installRoFormerTransfer({
  studioRoot = DEFAULT_STUDIO,
  bridgePath = DEFAULT_BRIDGE,
} = {}) {
  const index = join(studioRoot, 'index.html');
  const html = await readFile(index, 'utf8');
  if (!html.includes('stem_explorer') || !/<\/body>/i.test(html)) {
    throw new Error('Unexpected pinned Stemyla HTML: aborting integration.');
  }
  if (html.includes(SCRIPT_NAME) && !html.includes(TAG)) {
    throw new Error('Unexpected existing transfer script reference.');
  }
  const updated = html.includes(TAG)
    ? html
    : html.replace(/<\/body>/i, TAG + '\n</body>');
  // Restrict to the expected packaged asset directory; never read/write
  // model checkpoints or source song files.
  await copyFile(bridgePath, join(dirname(index), SCRIPT_NAME));
  await writeFile(index, updated, 'utf8');
  return { file: index, installed: !html.includes(TAG) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const info = await installRoFormerTransfer();
    process.stdout.write('RoFormer local transfer bridge: ' +
      (info.installed ? 'installed' : 'already present') + '\n');
  } catch (error) {
    process.stderr.write('RoFormer local transfer bridge failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
