// Minimal bridge for the Bluetooth device picker. Nothing else from Node or
// Electron is exposed to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kindlingDesktop', {
  platform: process.platform,
  onBluetoothDevices: (cb) => ipcRenderer.on('bt:devices', (_e, devices) => cb(devices)),
  selectBluetoothDevice: (id) => ipcRenderer.send('bt:select', id),
  roformer: {
    // No arbitrary paths or commands: the host only opens pinned local assets.
    openStudio: () => ipcRenderer.invoke('roformer:open'),
  },
  stems: {
    supported: process.platform === 'win32',
    chooseInput: () => ipcRenderer.invoke('stem:choose-input'),
    chooseOutput: () => ipcRenderer.invoke('stem:choose-output'),
    start: (settings) => ipcRenderer.invoke('stem:start', settings),
    cancel: () => ipcRenderer.invoke('stem:cancel'),
    openOutput: () => ipcRenderer.invoke('stem:open-output'),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('stem:event', listener);
      return () => ipcRenderer.removeListener('stem:event', listener);
    },
  },
});
