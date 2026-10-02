const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tdg', {
  api: (method, path, body) => ipcRenderer.invoke('api', { method, path, body }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setTrayTitle: (t) => ipcRenderer.send('tray:title', t),
  setRunning: (r) => ipcRenderer.send('timer:running', r),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  openUrl: (u) => ipcRenderer.send('open:url', u),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: (info) => ipcRenderer.invoke('update:install', info),
  on: (channel, fn) => {
    if (['window-shown', 'idle-returned'].includes(channel)) ipcRenderer.on(channel, (_e, d) => fn(d));
  },
});
