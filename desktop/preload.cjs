const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('assistant', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  captureSource: id => ipcRenderer.invoke('capture-source', id),
  recognizeText: image => ipcRenderer.invoke('recognize-text', image),
  confirm: kind => ipcRenderer.invoke('confirm', kind),
  appState: () => ipcRenderer.invoke('app-state'),
  rememberProvider: config => ipcRenderer.invoke('remember-provider', config),
  startSystemAudio: () => ipcRenderer.invoke('start-system-audio'),
  stopSystemAudio: () => ipcRenderer.invoke('stop-system-audio'),
  platform: process.platform,
  sendSystemAudio: pcm => ipcRenderer.send('system-audio-pcm', pcm),
  onSystemTranscript: callback => ipcRenderer.on('system-transcript', (_e, text) => callback(text)),
  onSystemAudioStatus: callback => ipcRenderer.on('system-audio-status', (_e, text) => callback(text)),
  overlayListening: on => ipcRenderer.send('overlay-listening', on),
  onToggleListening: callback => ipcRenderer.on('toggle-listening', () => callback()),
  overlayUpdate: state => ipcRenderer.send('overlay-update', state),
  addHistory: entry => ipcRenderer.send('history-add', entry),
  onAskTyped: callback => ipcRenderer.on('ask-typed', (_e, ask) => callback(ask)),
  onCaptureShortcut: callback => ipcRenderer.on('capture-shortcut', () => callback()),
  onShortcutUnavailable: callback => ipcRenderer.on('shortcut-unavailable', () => callback())
});
