// Creates an Electron Builder config only for the Windows native-stems build.
// Normal KindlingControl packaging does not require Rust or demucs.exe.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const bin = join(project, 'build', 'bin');
for (const name of ['demucs.exe', 'LICENSE.txt']) {
  const path = join(bin, name);
  const file = await stat(path).catch(() => null);
  if (!file?.isFile() || file.size === 0) {
    throw new Error(`Native stem build is incomplete: missing ${path}`);
  }
}
const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const config = {
  ...pkg.build,
  extraResources: [
    ...(pkg.build.extraResources ?? []),
    {
      from: 'build/bin',
      to: 'demucs',
      filter: ['demucs.exe', 'LICENSE.txt'],
    },
  ],
};
const target = join(project, 'build', 'stem-electron-builder.json');
await writeFile(target, JSON.stringify(config, null, 2) + '\n');
console.log('Generated native stem packaging config:', target);
