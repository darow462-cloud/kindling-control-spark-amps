// Prepare only the experimental Windows Portable with both native Demucs
// and an independently built, pinned BS-RoFormer SW WebGPU application.
// We never bundle or download model weights during packaging.
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const binaryDir = join(project, 'build', 'bin');
const studioDir = join(project, 'build', 'roformer-studio');
for (const path of [
  join(binaryDir, 'demucs.exe'),
  join(binaryDir, 'LICENSE.txt'),
  join(studioDir, 'index.html'),
]) {
  const item = await stat(path).catch(() => null);
  if (!item?.isFile() || item.size === 0) {
    throw new Error(`Missing native/roformer packaged asset: ${path}`);
  }
}
const queue = [studioDir];
const wasmFiles = [];
while (queue.length) {
  const current = queue.pop();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const next = join(current, entry.name);
    if (entry.isDirectory()) queue.push(next);
    else if (entry.isFile() && entry.name.endsWith('.wasm')) wasmFiles.push(next);
  }
}
if (wasmFiles.length < 4) {
  throw new Error(`Incomplete RoFormer WebGPU app: only ${wasmFiles.length} wasm worker(s)`);
}
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const config = {
  ...pkg.build,
  extraResources: [
    ...(pkg.build.extraResources ?? []),
    { from: 'build/bin', to: 'demucs', filter: ['demucs.exe', 'LICENSE.txt'] },
    { from: 'build/roformer-studio', to: 'roformer-studio' },
    { from: 'build/roformer-notices', to: 'roformer-notices' },
  ],
};
const notices = await stat(join(project, 'build', 'roformer-notices', 'LICENSE-APACHE')).catch(() => null);
if (!notices?.isFile()) {
  throw new Error('RoFormer studio upstream license notice missing');
}
const target = join(project, 'build', 'roformer-electron-builder.json');
await writeFile(target, JSON.stringify(config, null, 2) + '\n');
console.log(`Prepared ${wasmFiles.length} wasm modules and native engine for Windows Portable.`);
