const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  toggleListening: () => ipcRenderer.send('overlay-toggle-listening'),
  onListening: callback => ipcRenderer.on('overlay-listening', (_event, on) => callback(Boolean(on))),
  close: () => ipcRenderer.send('overlay-close'),
  capture: () => ipcRenderer.send('overlay-capture'),
  ask: (channel, text) => ipcRenderer.send('overlay-ask', { channel, text }),
  getHistory: () => ipcRenderer.invoke('overlay-history'),
  onHistoryAdd: callback => ipcRenderer.on('overlay-history-add', (_event, entry) => callback(entry)),
  onUpdate: callback => ipcRenderer.on('overlay-update', (_event, state) => callback(state))
});
