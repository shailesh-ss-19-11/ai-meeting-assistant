const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  toggleListening: () => ipcRenderer.send('overlay-toggle-listening'),
  onListening: callback => ipcRenderer.on('overlay-listening', (_event, on) => callback(Boolean(on))),
  close: () => ipcRenderer.send('overlay-close'),
  capture: () => ipcRenderer.send('overlay-capture'),
  onUpdate: callback => ipcRenderer.on('overlay-update', (_event, state) => callback(state))
});
