// Deliberately narrow local resource resolver for the optional RoFormer
// WebGPU studio. The studio has its own secure origin, no Node or preload.
//
// The bundled source is a pinned MIT/Apache-2.0 WebAssembly application.
// Its BS-RoFormer SW model weights are NOT bundled or automatically downloaded.
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

export const ROFORMER_ORIGIN = 'kindling-roformer://studio';
export const ROFORMER_SOURCE_COMMIT = 'b2a771808d36f9a8d2f333528805d0ee2c1040a8';
export const ROFORMER_SOURCE_URL = 'https://github.com/lloydmeta/stemyla';
const MIMES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

export function studioContentType(path) {
  return MIMES.get(extname(path).toLowerCase()) ?? 'application/octet-stream';
}

export async function resolveStudioResource(root, requestedUrl) {
  const url = new URL(requestedUrl);
  if (url.origin !== ROFORMER_ORIGIN || !['GET', 'HEAD'].includes('GET')) {
    // The HTTP method is checked by the Electron protocol handler.
    throw new Error('untrusted RoFormer studio URL');
  }
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.includes('\\') || decoded.includes('\0')) throw new Error('invalid path');
  const documentName = decoded === '/' ? '/index.html' : decoded;
  const candidate = resolve(root, '.' + documentName);
  const base = await realpath(root);
  const target = await realpath(candidate);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith('..' + sep) || rel === '' ||
      rel.startsWith(sep) || rel.includes(':')) {
    throw new Error('outside bundled studio');
  }
  const file = await stat(target);
  if (!file.isFile()) throw new Error('not a studio file');
  return { file: target, type: studioContentType(target) };
}
