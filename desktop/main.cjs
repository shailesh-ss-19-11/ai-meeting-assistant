const { app, BrowserWindow, screen, globalShortcut, desktopCapturer, dialog, ipcMain, safeStorage, session, systemPreferences } = require('electron');
const { fork, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createWorker } = require('tesseract.js');

const PORT = 8787;
let win;
let overlay;
let overlayState = { voice: {}, screen: {} };
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
  // Excluded from screen sharing/recording so meeting participants cannot see this window.
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
}

// Small always-on-top frosted panel with the question and the suggested reply. Like the main window it is
// excluded from screen sharing, so only the user sees it.
function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({ width: 900, height: 480, minWidth: 560, minHeight: 280, x: workArea.x + workArea.width - 920, y: workArea.y + 20,
    frame: false, transparent: true, hasShadow: false, resizable: true, show: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload-overlay.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  overlay.setContentProtection(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', event => event.preventDefault());
  overlay.webContents.once('did-finish-load', () => { overlay.webContents.send('overlay-listening', overlayListening); for (const channel of ['voice', 'screen']) overlay.webContents.send('overlay-update', { channel, ...overlayState[channel] }); overlay.showInactive(); });
  overlay.on('closed', () => { overlay = null; });
}
function toggleOverlay() {
  if (!overlay || overlay.isDestroyed()) return createOverlay();
  if (overlay.isVisible()) overlay.hide(); else overlay.showInactive();
}

const isAssistant = webContents => Boolean(win && !win.isDestroyed() && webContents && webContents.id === win.webContents.id);

app.whenReady().then(async () => {
  // Only the assistant window may use the microphone; video and every other permission are denied.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnly = details?.mediaTypes?.includes('audio') && !details.mediaTypes.includes('video');
    callback(Boolean(isAssistant(webContents) && permission === 'media' && audioOnly));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => isAssistant(webContents) && permission === 'media');
  // No Dock icon, so the app is not visible there while sharing the screen; the windows stay reachable by shortcut.
  app.dock?.hide();
  bridgeToken = loadToken();
  await startServer();
  await restoreProvider();
  createWindow();
  createOverlay();
  globalShortcut.register('CommandOrControl+Shift+O', toggleOverlay);
  globalShortcut.register('CommandOrControl+Shift+M', () => { if (!win || win.isDestroyed()) createWindow(); else if (win.isVisible() && win.isFocused()) win.hide(); else { win.show(); win.focus(); } });
  const registered = globalShortcut.register('CommandOrControl+Shift+Space', () => win?.webContents.send('capture-shortcut'));
  win.webContents.once('did-finish-load', () => { if (!registered) win.webContents.send('shortcut-unavailable'); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('will-quit', () => { serverProcess?.kill(); globalShortcut.unregisterAll(); ocrWorker?.terminate().catch(() => {}); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

let overlayListening = false;
ipcMain.on('overlay-toggle-listening', event => { if (overlay && !overlay.isDestroyed() && event.sender.id === overlay.webContents.id) win?.webContents.send('toggle-listening'); });
ipcMain.on('overlay-listening', (event, on) => {
  if (!isAssistant(event.sender)) return;
  overlayListening = Boolean(on);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-listening', overlayListening);
});
ipcMain.on('overlay-close', event => { if (overlay && !overlay.isDestroyed() && event.sender.id === overlay.webContents.id) overlay.hide(); });
ipcMain.on('overlay-capture', event => { if (overlay && !overlay.isDestroyed() && event.sender.id === overlay.webContents.id) win?.webContents.send('capture-shortcut'); });
ipcMain.on('overlay-update', (event, state) => {
  if (!isAssistant(event.sender) || !state || typeof state !== 'object') return;
  const text = value => (typeof value === 'string' ? value.slice(0, 20000) : '');
  const channel = state.channel === 'screen' ? 'screen' : 'voice';
  overlayState = { ...overlayState, [channel]: { question: text(state.question), answer: text(state.answer), state: text(state.state), error: text(state.error) } };
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-update', { channel, ...overlayState[channel] });
});

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
  const source = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 3200, height: 2000 } })).find(item => item.id === sourceId);
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

// System audio (the other side of a call) is captured by a small native helper and transcribed in 8-second chunks.
let sysAudio = null;
function wavFrom(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function rms(pcm) {
  let sum = 0; const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return n ? Math.sqrt(sum / n) : 0;
}
async function transcribeChunk(pcm) {
  if (rms(pcm) < 120) return; // silence: skip (also avoids Whisper hallucinating "Thank you.")
  const form = new FormData();
  form.append('audio', new Blob([wavFrom(pcm)], { type: 'audio/wav' }), 'them.wav');
  const response = await fetch(`http://127.0.0.1:${PORT}/api/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${bridgeToken}` }, body: form });
  const body = await response.json().catch(() => ({}));
  if (process.env.SYSAUDIO_DEBUG) fs.appendFileSync(path.join(app.getPath('userData'), 'audio-debug.log'), `transcribe status=${response.status} ${JSON.stringify(body).slice(0, 200)}\n`);
  if (!response.ok) return win?.webContents.send('system-audio-status', body.error || `Transcription failed (${response.status}).`);
  if (body.text?.trim()) win?.webContents.send('system-transcript', body.text.trim());
}
function stopSystemAudio() {
  if (!sysAudio) return;
  clearInterval(sysAudio.timer); clearTimeout(sysAudio.watchdog); sysAudio.child.kill(); sysAudio = null;
}
handle('start-system-audio', () => {
  if (sysAudio) return true;
  if (process.platform !== 'darwin') throw new Error('System audio capture is only implemented for macOS.');
  const helper = path.join(__dirname, 'native', 'sysaudio');
  if (!fs.existsSync(helper)) throw new Error('Native audio helper is missing. Run "npm run build:native" in the desktop folder.');
  const child = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, chunks: [], received: 0, timer: null, watchdog: null };
  sysAudio = state;
  child.stdout.on('data', data => { state.chunks.push(data); state.received += data.length; });
  child.stderr.on('data', data => { const text = String(data).trim(); if (/failed|stopped/.test(text)) win?.webContents.send('system-audio-status', `System audio: ${text}`); });
  child.on('exit', () => { if (sysAudio === state) { stopSystemAudio(); win?.webContents.send('system-audio-status', 'System audio stopped.'); } });
  // Cut the audio where the speaker pauses (so sentences stay whole), or after 15 s of continuous speech.
  const BYTES_PER_SECOND = 32000;
  state.timer = setInterval(() => {
    const buffered = Buffer.concat(state.chunks.splice(0)); state.chunks.push(buffered);
    if (buffered.length < 3 * BYTES_PER_SECOND) return;
    const paused = rms(buffered.subarray(buffered.length - Math.floor(0.7 * BYTES_PER_SECOND))) < 150;
    if (!paused && buffered.length < 15 * BYTES_PER_SECOND) return;
    state.chunks.length = 0;
    if (process.env.SYSAUDIO_DEBUG) fs.appendFileSync(path.join(app.getPath('userData'), 'audio-debug.log'), `${new Date().toISOString()} bytes=${buffered.length} rms=${Math.round(rms(buffered))}\n`);
    transcribeChunk(buffered).catch(error => win?.webContents.send('system-audio-status', error.message));
  }, 500);
  state.watchdog = setTimeout(() => { if (!state.received) win?.webContents.send('system-audio-status', 'No system audio received. Allow audio recording for Electron (System Settings → Privacy & Security → Screen & System Audio Recording) and make sure sound is playing.'); }, 6000);
  return true;
});
handle('stop-system-audio', () => { stopSystemAudio(); return true; });
app.on('will-quit', stopSystemAudio);

// Native confirmation so consent cannot be skipped by page script.
const CONSENT = {
  system: { message: 'Transcribe the other side of the call?', detail: 'System audio (what plays through your speakers, such as other meeting participants) is captured in 8-second segments and sent to your configured external AI provider for transcription. Make sure everyone in the meeting has agreed. It stays on until you click Stop.' }
};
handle('confirm', async kind => {
  const entry = CONSENT[kind];
  if (!entry) return false;
  // Consent is asked once and remembered, so listening can start by itself on later launches.
  const settings = readSettings();
  if (settings.consent?.[kind]) return true;
  const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0, ...entry });
  if (response !== 1) return false;
  writeSettings({ ...settings, consent: { ...settings.consent, [kind]: true } });
  return true;
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
