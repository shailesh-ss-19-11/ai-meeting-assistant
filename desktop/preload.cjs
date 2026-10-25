const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('assistant', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  captureSource: id => ipcRenderer.invoke('capture-source', id),
  recognizeText: image => ipcRenderer.invoke('recognize-text', image),
  requestMicrophone: () => ipcRenderer.invoke('request-microphone'),
  confirm: kind => ipcRenderer.invoke('confirm', kind),
  appState: () => ipcRenderer.invoke('app-state'),
  rememberProvider: config => ipcRenderer.invoke('remember-provider', config),
  onCaptureShortcut: callback => ipcRenderer.on('capture-shortcut', () => callback()),
  onShortcutUnavailable: callback => ipcRenderer.on('shortcut-unavailable', () => callback())
});
