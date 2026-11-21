// Electron shell for Windows, macOS and Linux. It loads the same web app from
// src/ over a private secure scheme (Web Bluetooth needs a secure context) and
// supplies the Bluetooth device chooser Chromium shows in a normal browser.

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { existsSync } from 'node:fs';
import { StemSeparationService } from './stem-service.js';
import { ROFORMER_ORIGIN, resolveStudioResource } from './roformer-studio.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, normalize, sep } from 'node:path';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const SCHEME = 'kindling';
const STEM_SCHEME = 'kindling-stem';
const ROFORMER_SCHEME = 'kindling-roformer';

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Reads only WAV files produced by this session's trusted separator. URLs
  // cannot access arbitrary local files and work with HTMLAudioElement/fetch.
  { scheme: STEM_SCHEME, privileges: {
    standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
  } },
  { scheme: ROFORMER_SCHEME, privileges: {
    standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
  } },
]);

// Web Bluetooth is still behind a flag in Chromium on Linux.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-experimental-web-platform-features');

let pendingBluetoothCallback = null;
let mainWindow = null;
let stemInput = null;
let stemOutput = null;
let stemService = null;

function studioResourcesRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, 'roformer-studio')
    : fileURLToPath(new URL('../build/roformer-studio/', import.meta.url));
}

function bundledRoformerStatus() {
  // This is a fixed read-only status. The renderer cannot choose a local
  // file, URL, executable or second browser window.
  return {
    available: existsSync(join(studioResourcesRoot(), 'index.html')),
    url: `${ROFORMER_ORIGIN}/index.html`,
  };
}

function trustedMain(event) {
  return mainWindow && !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.sender.getURL().startsWith(`${SCHEME}://app/index.html`);
}

function enginePath() {
  // A development override is never accepted by a packaged Portable.
  if (!app.isPackaged && process.env.KINDLING_DEMUCS_CLI) {
    return process.env.KINDLING_DEMUCS_CLI;
  }
  return app.isPackaged
    ? join(process.resourcesPath, 'demucs', 'demucs.exe')
    : fileURLToPath(new URL('../build/bin/demucs.exe', import.meta.url));
}

function stemFileUrl(id, name) {
  return `${STEM_SCHEME}://${id}/${name}.wav`;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 380,
    minHeight: 500,
    title: 'KindlingControl',
    icon: fileURLToPath(new URL('../src/icons/icon-512.png', import.meta.url)), // Windows/Linux window + taskbar
    backgroundColor: '#121417',
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Called repeatedly while scanning, each time with the full list so far.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    pendingBluetoothCallback = callback;
    win.webContents.send(
      'bt:devices',
      devices.map((d) => ({ id: d.deviceId, name: d.deviceName })),
    );
  });

  const query = process.argv.includes('--mock') ? '?mock=Spark%20GO' : '';
  win.loadURL(`${SCHEME}://app/index.html${query}`);
  mainWindow = win;
  win.once('closed', () => { stemService?.close(); if (mainWindow === win) mainWindow = null; });
  return win;
}

// Every window (the app, the guide and the Console windows) gets the same link rules:
// external https links open in the real browser; only our own scheme loads inside the app.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // The user guide ("Open in a new window" in Help) opens in its own locked-down window.
    if (url.startsWith(`${SCHEME}://app/guide/`)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000,
          height: 820,
          title: 'KindlingControl user guide',
          backgroundColor: '#0d0e10',
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, // no preload
        },
      };
    }
    // The popped-out Console: same origin, so the app window can move its live Console into it.
    if (url === `${SCHEME}://app/console.html`) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 760,
          height: 680,
          title: 'KindlingControl console',
          backgroundColor: '#121417',
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }, // no preload
        },
      };
    }
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    // RoFormer now runs only inside a sandboxed iframe under the Stems tab,
    // never as the top-level page or another BrowserWindow.
    const nativeApp = url.startsWith(`${SCHEME}://app/`);
    if (!nativeApp) {
      e.preventDefault();
      if (url.startsWith('https:')) shell.openExternal(url);
    }
  });
});

ipcMain.on('bt:select', (_e, id) => {
  if (!pendingBluetoothCallback) return;
  pendingBluetoothCallback(id || ''); // '' cancels requestDevice()
  pendingBluetoothCallback = null;
});

app.whenReady().then(() => {
  stemService = new StemSeparationService({
    executable: enginePath(),
    onEvent: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const message = event.type === 'complete'
        ? { ...event, stems: event.stems.map(({ name, label, bytes }) =>
          ({ name, label, bytes, url: stemFileUrl(event.id, name) })) }
        : event;
      mainWindow.webContents.send('stem:event', message);
    },
  });

  // Pinned WebAssembly app is served only from its packaged assets.
  // Model weights are intentionally not bundled and must be downloaded
  // explicitly by the user through the studio's own Download Model control.
  protocol.handle(ROFORMER_SCHEME, async (req) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405 });
      }
      const asset = await resolveStudioResource(studioResourcesRoot(), req.url);
      const source = await net.fetch(pathToFileURL(asset.file).toString());
      const headers = new Headers(source.headers);
      headers.set('Content-Type', asset.type);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(req.method === 'HEAD' ? null : source.body, {
        status: source.status, headers,
      });
    } catch {
      return new Response('Studio asset not found', { status: 404 });
    }
  });

  ipcMain.handle('roformer:status', async (event) => {
    if (!trustedMain(event)) throw new Error('Untrusted app window');
    return bundledRoformerStatus();
  });

  protocol.handle(STEM_SCHEME, async (req) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) return new Response('Method not allowed', { status: 405 });
      const url = new URL(req.url);
      if (!/^\/[a-z]+\.wav$/.test(url.pathname)) return new Response('Not found', { status: 404 });
      const stemName = url.pathname.slice(1, -4);
      const file = stemService.fileFor(url.hostname, stemName);
      if (!file) return new Response('Not found', { status: 404 });
      // Only the six validated WAV files generated by our active session are
      // served. Enable media playback and Analyze's in-memory fetch.
      const source = await net.fetch(pathToFileURL(file).toString(), {
        headers: req.headers.get('range') ? { Range: req.headers.get('range') } : {},
      });
      const headers = new Headers(source.headers);
      headers.set('Content-Type', 'audio/wav');
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(source.body, { status: source.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  ipcMain.handle('stem:choose-input', async (event) => {
    if (!trustedMain(event)) throw new Error('Untrusted app window');
    const picker = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a song to separate',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'aiff', 'aif', 'mp3', 'flac', 'ogg', 'm4a', 'aac'] }],
    });
    if (picker.canceled || !picker.filePaths.length) return null;
    stemInput = picker.filePaths[0];
    return { name: stemInput.split(/[\\/]/).at(-1), path: stemInput };
  });
  ipcMain.handle('stem:choose-output', async (event) => {
    if (!trustedMain(event)) throw new Error('Untrusted app window');
    const picker = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for separated WAV stems',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picker.canceled || !picker.filePaths.length) return null;
    stemOutput = picker.filePaths[0];
    return { path: stemOutput };
  });
  ipcMain.handle('stem:start', async (event, options = {}) => {
    if (!trustedMain(event)) throw new Error('Untrusted app window');
    if (!stemInput || !stemOutput) throw new Error('Select an audio file and an output folder first');
    if (!existsSync(enginePath())) {
      throw new Error('The Demucs separation engine is not bundled in this build. Use the Windows Portable build with native stems support.');
    }
    // Renderer can select one of two fixed modes and toggle safe headroom.
    // Native executable, filesystem paths and CLI arguments remain main-owned.
    if (!options || typeof options !== 'object' ||
        !['standard', 'high-quality'].includes(options.mode) ||
        typeof options.protectPeaks !== 'boolean') {
      throw new Error('Invalid separation settings');
    }
    return stemService.start({
      inputPath: stemInput, outputRoot: stemOutput,
      mode: options.mode, protectPeaks: options.protectPeaks,
    });
  });
  ipcMain.handle('stem:cancel', async (event) => {
    if (!trustedMain(event)) throw new Error('Untrusted app window');
    return stemService.cancel();
  });
  ipcMain.handle('stem:open-output', async (event) => {
    if (!trustedMain(event)) throw new Error('Untrusted app window');
    const outputDir = stemService.completed?.outputDir;
    if (!outputDir) throw new Error('No separated stems to open');
    return shell.openPath(outputDir);
  });

  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
