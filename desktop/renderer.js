const message = document.querySelector('#message');
const busy = { voice: false, screen: false };
let transcriptText = '';
let bridgePoller;
let lastBridgeUpdate = null;
let pendingSpoken = null;
let listening = false;

const API = 'http://127.0.0.1:8787';
const authHeaders = () => ({ Authorization: `Bearer ${document.querySelector('#bridge-token').value.trim()}` });
async function readError(response, fallback) {
  try { return (await response.json()).error || fallback; } catch { return fallback; }
}
function needToken() {
  if (document.querySelector('#bridge-token').value.trim()) return false;
  message.textContent = 'The app is still starting. Try again in a moment.';
  return true;
}

const pushOverlay = (channel, state) => window.assistant.overlayUpdate({ channel, ...state });

// ---- Replies (shown only in the floating assistant window) ----
async function askAssistant(task, { spoken = false } = {}) {
  const channel = spoken ? 'voice' : 'screen';
  if (busy[channel] || needToken()) return;
  busy[channel] = true;
  const MAX_TASK = 15000;
  const clipped = task.length > MAX_TASK ? `${task.slice(0, MAX_TASK)}\n[…text truncated: ${task.length - MAX_TASK} more characters not sent]` : task;
  const question = task.length > 600 ? `${task.slice(0, 600)}…` : task;
  pushOverlay(channel, { question, answer: '', state: 'Thinking…' });
  let raw = '';
  try {
    const response = await fetch(`${API}/api/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ task: clipped, spoken, context: document.querySelector('#context').value.slice(-12000) }) });
    if (!response.ok) throw new Error(await readError(response, `Assistant request failed (${response.status}).`));
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n'); buffer = events.pop();
      for (const event of events) for (const line of event.split('\n')) if (line.startsWith('data: ')) {
        let data; try { data = JSON.parse(line.slice(6)); } catch { continue; }
        if (data.error) throw new Error(data.error);
        if (data.reasoning) continue;
        raw += data.token || ''; pushOverlay(channel, { question, answer: raw, state: 'Writing…' });
      }
    }
    pushOverlay(channel, { question, answer: raw, state: 'Ready' });
  } catch (error) { pushOverlay(channel, { question, error: `Could not get a suggestion: ${error.message}`, state: 'Error' }); message.textContent = error.message; }
  finally { busy[channel] = false; }
}

// Whatever the other side says gets a reply; only the newest unanswered line is kept while one is in flight.
async function queueSpokenAnswer(text) {
  if (busy.voice) { pendingSpoken = text; return; }
  await askAssistant(text, { spoken: true });
  if (pendingSpoken) { const next = pendingSpoken; pendingSpoken = null; queueSpokenAnswer(next); }
}

// ---- Screen capture (only when the user asks, via the overlay button or the shortcut) ----
async function captureAndAnswer() {
  if (busy.screen) return;
  busy.screen = true; pushOverlay('screen', { question: 'Reading your whole screen…', answer: '', state: 'Capturing…' });
  let text = '';
  try {
    const sources = await window.assistant.listSources();
    const source = sources.find(s => s.id.startsWith('screen:')) || sources[0];
    if (!source) throw new Error('No screen found to capture.');
    const image = await window.assistant.captureSource(source.id);
    text = (await window.assistant.recognizeText(image)).trim();
    if (!text) throw new Error('No readable text found on the screen.');
  } catch (error) { pushOverlay('screen', { question: 'Screen capture', error: error.message, state: 'Error' }); busy.screen = false; return; }
  busy.screen = false;
  await askAssistant(text);
}
window.assistant.onCaptureShortcut(() => captureAndAnswer());
window.assistant.onShortcutUnavailable(() => { message.textContent = 'The capture shortcut is in use by another app; use the assistant window button instead.'; });

// ---- Listening to the call (system audio), started automatically ----
function appendTranscript(text) {
  const context = document.querySelector('#context');
  context.value = `${context.value}${context.value ? '\n' : ''}${text}`.slice(-12000);
  transcriptText = `${transcriptText}${transcriptText ? '\n' : ''}${text}`.slice(-3000);
  const log = document.querySelector('#transcript-log');
  log.textContent = transcriptText; log.scrollTop = log.scrollHeight;
}
window.assistant.onSystemTranscript(text => {
  appendTranscript(`Them: ${text}`);
  if (text.split(/\s+/).length >= 3) queueSpokenAnswer(text);
});
window.assistant.onSystemAudioStatus(text => { message.textContent = text; });

// Windows: capture what plays through the speakers (the other side of the call) and stream 16 kHz mono PCM to the main process.
let loopback = null;
async function startLoopback() {
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }); }
  catch (error) { throw new Error(`${error.name || 'Error'}: ${error.message || 'capture was refused'}`); }
  stream.getVideoTracks().forEach(track => track.stop());
  const tracks = stream.getAudioTracks();
  if (!tracks.length) throw new Error('Windows did not provide system audio.');
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(new MediaStream(tracks));
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = event => {
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
    window.assistant.sendSystemAudio(new Uint8Array(pcm.buffer));
  };
  source.connect(processor); processor.connect(ctx.destination);
  await ctx.resume();
  loopback = { tracks, ctx };
}
window.__startLoopback = startLoopback; // called by the main process (with a user gesture) on Windows
function stopLoopback() {
  if (!loopback) return;
  loopback.tracks.forEach(track => track.stop()); loopback.ctx.close().catch(() => {}); loopback = null;
}

async function startListening() {
  if (listening || needToken()) return;
  try {
    if (!(await window.assistant.confirm('system'))) { message.textContent = 'Listening is off because consent was declined.'; return; }
    await window.assistant.startSystemAudio();
    listening = true; window.assistant.overlayListening(true); document.querySelector('#listen-state').classList.remove('hidden');
    message.textContent = 'Listening to the call. Replies appear in the assistant window.';
  } catch (error) { message.textContent = error.message; }
}
async function stopListening() {
  if (!listening) return;
  stopLoopback(); await window.assistant.stopSystemAudio(); listening = false; pendingSpoken = null; window.assistant.overlayListening(false);
  document.querySelector('#listen-state').classList.add('hidden');
}

window.assistant.onToggleListening(() => { if (listening) stopListening(); else if (currentProvider().transcription) startListening(); else message.textContent = 'This provider has no speech-to-text. Choose Groq.'; });

// ---- Chrome extension bridge ----
async function pollBridge() {
  const token = document.querySelector('#bridge-token').value.trim();
  if (!token) return;
  try {
    const response = await fetch(`${API}/api/context`, { headers: authHeaders(), cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Bridge connection failed.');
    document.querySelector('#bridge-status').textContent = 'Connected';
    if (result.updatedAt && result.updatedAt !== lastBridgeUpdate && document.querySelector('#context') !== document.activeElement) {
      document.querySelector('#context').value = result.text;
      lastBridgeUpdate = result.updatedAt;
    }
  } catch (error) { document.querySelector('#bridge-status').textContent = error.message; clearInterval(bridgePoller); }
}
function connectBridge() { clearInterval(bridgePoller); pollBridge(); bridgePoller = setInterval(pollBridge, 3000); }
document.querySelector('#copy-token').addEventListener('click', async () => { await navigator.clipboard.writeText(document.querySelector('#bridge-token').value); document.querySelector('#bridge-status').textContent = 'Token copied. Paste it into the extension popup.'; });

// ---- AI provider selection ----
const providerSel = document.querySelector('#provider');
const modelSel = document.querySelector('#model');
const modelCustom = document.querySelector('#model-custom');
const providerStatus = document.querySelector('#provider-status');
const CUSTOM = '__custom__';
const currentProvider = () => window.PROVIDERS.find(p => p.id === providerSel.value);

function fillModels(models, selected) {
  modelSel.innerHTML = '';
  models.forEach(m => modelSel.append(new Option(m, m)));
  modelSel.append(new Option('Custom…', CUSTOM));
  if (selected && !models.includes(selected)) { modelSel.value = CUSTOM; modelCustom.value = selected; }
  else modelSel.value = selected || models[0] || CUSTOM;
  modelCustom.classList.toggle('hidden', modelSel.value !== CUSTOM);
}
function onProviderChange(selectedModel) {
  const p = currentProvider();
  document.querySelector('#base-row').classList.toggle('hidden', p.id !== 'custom');
  if (p.id !== 'custom') document.querySelector('#base-url').value = p.baseUrl;
  document.querySelector('#api-key').placeholder = p.keyless ? 'Not needed for this provider' : 'Paste your API key';
  fillModels(p.models, selectedModel);
  refreshLiveModels(p, selectedModel);
  providerStatus.textContent = p.transcription ? 'Chat and listening supported with one key.' : 'This provider has no speech-to-text, so it cannot listen to the call. Choose Groq to use one key for everything.';
}
window.PROVIDERS.forEach(p => providerSel.append(new Option(p.name, p.id)));
providerSel.addEventListener('change', () => { onProviderChange(); stopListening(); });
modelSel.addEventListener('change', () => modelCustom.classList.toggle('hidden', modelSel.value !== CUSTOM));

// Preset model names go stale, so try to replace them with the provider's live list (silent on failure).
async function refreshLiveModels(p, selectedModel) {
  if (p.id === 'custom' || !p.baseUrl || !document.querySelector('#bridge-token').value) return;
  try {
    const response = await fetch(`${API}/api/models?baseUrl=${encodeURIComponent(p.baseUrl)}`, { headers: authHeaders() });
    if (!response.ok || providerSel.value !== p.id) return;
    const { models } = await response.json();
    if (!models?.length) return;
    const ordered = [...p.models.filter(m => models.includes(m)), ...models.filter(m => !p.models.includes(m))];
    fillModels(ordered, selectedModel && ordered.includes(selectedModel) ? selectedModel : ordered[0]);
  } catch { /* offline or key required: keep presets */ }
}

async function currentConfig() {
  try { const r = await fetch(`${API}/api/config`, { headers: authHeaders() }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function saveProvider() {
  if (needToken()) return false;
  const p = currentProvider();
  const model = (modelSel.value === CUSTOM ? modelCustom.value : modelSel.value).trim();
  const key = document.querySelector('#api-key').value.trim();
  const baseUrl = document.querySelector('#base-url').value.trim();
  if (!baseUrl) { providerStatus.textContent = 'Enter the API base URL.'; return false; }
  if (!model) { providerStatus.textContent = 'Choose or enter a model.'; return false; }
  if (!key && !p.keyless && !(await currentConfig())?.hasKey) { providerStatus.textContent = 'Paste your API key.'; return false; }
  try {
    const response = await fetch(`${API}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ baseUrl, model, apiKey: key || undefined, transcriptionModel: p.transcription, keyless: Boolean(p.keyless) }) });
    if (!response.ok) throw new Error(await readError(response, 'Could not save provider.'));
    document.querySelector('#api-key').value = '';
    const { remembered } = await window.assistant.rememberProvider({ id: p.id, model, baseUrl, transcription: p.transcription, keyless: Boolean(p.keyless), apiKey: key || undefined });
    providerStatus.textContent = `Saved: ${p.name} · ${model}${remembered ? ' (key encrypted on this computer)' : ' (key kept in memory only)'}.`;
    return true;
  } catch (error) { providerStatus.textContent = error.message; return false; }
}
document.querySelector('#test-provider').addEventListener('click', async event => {
  const button = event.currentTarget;
  const result = document.querySelector('#test-result');
  const show = (text, ok) => { result.textContent = text; result.className = `privacy-note test-result ${ok ? 'pass' : 'fail'}`; };
  if (needToken()) return;
  const p = currentProvider();
  const model = (modelSel.value === CUSTOM ? modelCustom.value : modelSel.value).trim();
  const key = document.querySelector('#api-key').value.trim();
  const baseUrl = document.querySelector('#base-url').value.trim();
  if (!baseUrl) return show('Enter the API base URL.', false);
  if (!model) return show('Choose or enter a model.', false);
  button.disabled = true;
  result.className = 'privacy-note test-result'; result.textContent = 'Testing…';
  try {
    const response = await fetch(`${API}/api/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ baseUrl, model, apiKey: key || undefined, keyless: Boolean(p.keyless) }) });
    const body = await response.json().catch(() => ({}));
    if (body.ok) show(`✓ Working: ${p.name} · ${model} answered in ${(body.ms / 1000).toFixed(1)}s${body.reply ? ` (“${body.reply}”)` : ''}.`, true);
    else show(`✗ Not working: ${body.error || 'Test failed.'}`, false);
  } catch (error) { show(`✗ Not working: ${error.message}`, false); }
  finally { button.disabled = false; }
});
document.querySelector('#save-provider').addEventListener('click', async () => {
  if (!(await saveProvider())) return;
  await stopListening();
  if (currentProvider().transcription) startListening();
});

(async () => {
  const state = await window.assistant.appState();
  document.querySelector('#bridge-token').value = state.token;
  if (state.serverError) { message.textContent = state.serverError; return; }
  const saved = state.provider;
  const p = window.PROVIDERS.find(x => x.id === saved?.id) || window.PROVIDERS[0];
  providerSel.value = p.id;
  onProviderChange(saved?.model);
  if (saved?.baseUrl && p.id === 'custom') document.querySelector('#base-url').value = saved.baseUrl;
  const ready = saved && (saved.hasKey || saved.keyless);
  if (ready) providerStatus.textContent = `Ready: ${p.name} · ${saved.model}.`;
  else providerStatus.textContent = 'Choose the AI and model, paste your key, then Save & start.';
  connectBridge();
  if (ready && p.transcription) startListening();
})();
