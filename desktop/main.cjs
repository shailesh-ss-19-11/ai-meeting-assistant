const { app, BrowserWindow, globalShortcut, desktopCapturer, dialog, ipcMain, safeStorage, session, systemPreferences } = require('electron');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createWorker } = require('tesseract.js');

const PORT = 8787;
let win;
let serverProcess;
let bridgeToken;
let serverError = '';
let ocrWorker;
let ocrQueue = Promise.resolve();

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function writeSettings(data) { fs.writeFileSync(settingsFile(), JSON.stringify(data), { mode: 0o600 }); }

// The token is generated once and stored; the user never has to create or paste it for the desktop app.
function loadToken() {
  const settings = readSettings();
  if (!settings.bridgeToken || settings.bridgeToken.length < 32) { settings.bridgeToken = crypto.randomBytes(32).toString('hex'); writeSettings(settings); }
  return settings.bridgeToken;
}

async function serverHealthy() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
async function startServer() {
  if (await serverHealthy()) { serverError = `Port ${PORT} is already in use by another server. Close it (or any separately started "npm run server") and restart this app.`; return; }
  serverProcess = fork(path.join(__dirname, '..', 'server', 'index.js'), [], {
    cwd: path.join(__dirname, '..', 'server'), stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), BRIDGE_TOKEN: bridgeToken, ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: '' }
  });
  serverProcess.on('exit', code => { serverProcess = null; if (code) serverError = `The built-in server stopped (exit ${code}). Run "npm run install:all" and restart.`; });
  for (let i = 0; i < 50 && !(await serverHealthy()); i++) await new Promise(r => setTimeout(r, 100));
  if (!(await serverHealthy()) && !serverError) serverError = 'The built-in server did not start. Run "npm run install:all" and restart.';
}

// Push the remembered provider (and its encrypted key) to the server's memory.
async function restoreProvider() {
  const { provider } = readSettings();
  if (!provider || serverError) return;
  let apiKey = '';
  try { if (provider.encryptedKey && safeStorage.isEncryptionAvailable()) apiKey = safeStorage.decryptString(Buffer.from(provider.encryptedKey, 'base64')); } catch { /* key unreadable; user re-enters */ }
  await fetch(`http://127.0.0.1:${PORT}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridgeToken}` },
    body: JSON.stringify({ baseUrl: provider.baseUrl, model: provider.model, transcriptionModel: provider.transcription || '', keyless: Boolean(provider.keyless), apiKey: apiKey || undefined }) }).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({ width: 440, height: 760, minWidth: 360, minHeight: 560,
    title: 'Meeting Assistant', backgroundColor: '#10131a',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
}

const isAssistant = webContents => Boolean(win && !win.isDestroyed() && webContents && webContents.id === win.webContents.id);

app.whenReady().then(async () => {
  // Only the assistant window may use the microphone; video and every other permission are denied.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnly = details?.mediaTypes?.includes('audio') && !details.mediaTypes.includes('video');
    callback(Boolean(isAssistant(webContents) && permission === 'media' && audioOnly));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => isAssistant(webContents) && permission === 'media');
  bridgeToken = loadToken();
  await startServer();
  await restoreProvider();
  createWindow();
  const registered = globalShortcut.register('CommandOrControl+Shift+Space', () => win?.webContents.send('capture-shortcut'));
  win.webContents.once('did-finish-load', () => { if (!registered) win.webContents.send('shortcut-unavailable'); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('will-quit', () => { serverProcess?.kill(); globalShortcut.unregisterAll(); ocrWorker?.terminate().catch(() => {}); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function senderAllowed(event) { return isAssistant(event.sender); }
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!senderAllowed(event)) throw new Error('Untrusted sender.');
    return fn(...args);
  });
}

handle('list-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  return sources.map(({ id, name }) => ({ id, name }));
});

handle('capture-source', async sourceId => {
  if (typeof sourceId !== 'string') throw new Error('Invalid capture source.');
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new Error('Screen Recording permission is not granted. Enable it for Electron in System Settings → Privacy & Security → Screen Recording, then restart the app.');
  }
  const source = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 2200, height: 1400 } })).find(item => item.id === sourceId);
  if (!source) throw new Error('Capture source is no longer available. Refresh the list.');
  if (source.thumbnail.isEmpty()) throw new Error('The capture was empty. Check Screen Recording permission or pick another source.');
  return source.thumbnail.toDataURL();
});

// One long-lived worker (language data is cached in userData); jobs are serialized.
async function getWorker() {
  if (!ocrWorker) ocrWorker = await createWorker('eng', 1, { cachePath: path.join(app.getPath('userData'), 'tesseract') });
  return ocrWorker;
}
handle('recognize-text', image => {
  if (typeof image !== 'string' || !image.startsWith('data:image/')) throw new Error('Invalid image.');
  const job = ocrQueue.then(async () => {
    try { return (await (await getWorker()).recognize(image)).data.text; }
    catch (error) { await ocrWorker?.terminate().catch(() => {}); ocrWorker = null; throw error; }
  });
  ocrQueue = job.catch(() => {});
  return job;
});

handle('request-microphone', async () => {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  return status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
});

// Native confirmation so consent cannot be skipped by page script.
const CONSENT = {
  transcription: { message: 'Start microphone transcription?', detail: 'The microphone will be recorded in 8-second segments and each segment is sent to your configured external AI provider for transcription. Make sure everyone in the meeting has agreed to this. Recording stays on until you click Stop.' },
  periodic: { message: 'Enable periodic screen scanning?', detail: 'Every 15 seconds the selected screen or window will be captured and read locally. When the text changes, it is sent to your configured external AI provider to generate a suggestion. Scanning stays on until you turn it off.' }
};
handle('confirm', async kind => {
  const entry = CONSENT[kind];
  if (!entry) return false;
  const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, ...entry });
  return response === 1;
});

handle('app-state', () => {
  const { provider } = readSettings();
  return { token: bridgeToken, serverError, provider: provider ? { ...provider, encryptedKey: undefined, hasKey: Boolean(provider.encryptedKey) } : null };
});
// Remember the provider choice; the key is encrypted with the OS keychain (safeStorage) and never returned to the page.
handle('remember-provider', config => {
  const settings = readSettings();
  const old = settings.provider || {};
  let encryptedKey = old.baseUrl === config.baseUrl ? old.encryptedKey : undefined;
  if (config.apiKey) {
    if (safeStorage.isEncryptionAvailable()) encryptedKey = safeStorage.encryptString(config.apiKey).toString('base64');
    else encryptedKey = undefined;
  }
  const { id, model, baseUrl, transcription, keyless } = config;
  settings.provider = { id, model, baseUrl, transcription, keyless, encryptedKey };
  writeSettings(settings);
  return { remembered: Boolean(encryptedKey) || Boolean(keyless) };
});
