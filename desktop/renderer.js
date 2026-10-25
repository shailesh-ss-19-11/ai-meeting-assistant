const sourceSelect = document.querySelector('#source');
const ocrOutput = document.querySelector('#ocr');
const answer = document.querySelector('#answer');
const message = document.querySelector('#message');
const preview = document.querySelector('#preview');
let timer;
let busy = false;
let microphoneStream;
let listening = false;
let recorder;
let transcriptText = '';
let uploadQueue = Promise.resolve();
let bridgePoller;
let lastBridgeUpdate = null;

const API = 'http://127.0.0.1:8787';
const authHeaders = () => ({ Authorization: `Bearer ${document.querySelector('#bridge-token').value.trim()}` });
async function readError(response, fallback) {
  try { return (await response.json()).error || fallback; } catch { return fallback; }
}
function needToken() {
  if (document.querySelector('#bridge-token').value.trim()) return false;
  message.textContent = 'Enter the BRIDGE_TOKEN from server/.env first (Meeting context card).';
  return true;
}

async function refreshSources() {
  try {
    const sources = await window.assistant.listSources();
    sourceSelect.innerHTML = '<option value="">Choose a screen or window…</option>';
    sources.forEach(source => {
      const option = document.createElement('option'); option.value = source.id; option.textContent = source.name;
      sourceSelect.append(option);
    });
    message.textContent = sources.length ? '' : 'No capture sources found.';
  } catch (error) { message.textContent = error.message; }
}

async function askAssistant(task) {
  if (busy || needToken()) return;
  busy = true; message.textContent = 'Generating a suggestion…';
  try {
    answer.innerHTML = ''; const p = document.createElement('p'); p.textContent = '';
    const sparkle = document.createElement('span'); sparkle.className = 'sparkle'; sparkle.textContent = '✦'; answer.append(sparkle, p);
    const response = await fetch(`${API}/api/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ task, context: document.querySelector('#context').value }) });
    if (!response.ok) throw new Error(await readError(response, `Assistant request failed (${response.status}).`));
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n'); buffer = events.pop();
      for (const event of events) for (const line of event.split('\n')) if (line.startsWith('data: ')) {
        try { p.textContent += JSON.parse(line.slice(6)).token || ''; } catch { /* malformed event */ }
      }
    }
    message.textContent = 'Suggestion ready.';
  } catch (error) { message.textContent = error.message; }
  finally { busy = false; }
}

let lastScanText = '';
async function captureAndAnswer({ periodic = false } = {}) {
  if (busy) return;
  if (!sourceSelect.value) { message.textContent = 'Choose a screen or window first.'; return; }
  busy = true; message.textContent = 'Capturing and reading screen…';
  try {
    const image = await window.assistant.captureSource(sourceSelect.value);
    preview.innerHTML = ''; const img = document.createElement('img'); img.src = image; preview.append(img); preview.classList.remove('hidden');
    const text = (await window.assistant.recognizeText(image)).trim();
    if (!text) throw new Error('No readable text found. Try selecting a closer window.');
    if (periodic && text === lastScanText) { message.textContent = 'Screen unchanged; skipped.'; return; }
    lastScanText = text;
    ocrOutput.textContent = text;
    busy = false;
    await askAssistant(text);
  } catch (error) { message.textContent = error.message; }
  finally { busy = false; }
}

function appendTranscript(text) {
  const context = document.querySelector('#context');
  context.value = `${context.value}${context.value ? '\n' : ''}${text}`.slice(-12000);
  transcriptText = `${transcriptText}${transcriptText ? '\n' : ''}${text}`.slice(-3000);
  document.querySelector('#transcript-log').textContent = transcriptText;
  document.querySelector('#transcript-log').scrollTop = document.querySelector('#transcript-log').scrollHeight;
  if (/[?？]/.test(text) || /\b(what|why|how|when|where|who|which|could you|can you|would you|should we)\b/i.test(text)) {
    ocrOutput.textContent = `Spoken question: ${text}`;
    document.querySelector('#spoken-answer').classList.remove('hidden');
  }
}

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

function connectBridge() {
  const input = document.querySelector('#bridge-token');
  localStorage.setItem('bridgeToken', input.value.trim());
  clearInterval(bridgePoller);
  pollBridge();
  bridgePoller = setInterval(pollBridge, 3000);
}

async function uploadAudio(blob) {
  if (!blob.size) return;
  const form = new FormData(); form.append('audio', blob, `meeting-${Date.now()}.webm`);
  const response = await fetch(`${API}/api/transcribe`, { method: 'POST', headers: authHeaders(), body: form });
  if (!response.ok) throw new Error(await readError(response, `Transcription failed (${response.status}).`));
  const result = await response.json();
  if (result.text?.trim()) appendTranscript(result.text.trim());
}

function startAudioSegment() {
  if (!listening || !microphoneStream) return;
  const parts = [];
  try {
    const current = new MediaRecorder(microphoneStream);
    recorder = current;
    current.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
    current.onstop = () => {
      const blob = new Blob(parts, { type: current.mimeType || 'audio/webm' });
      if (listening) startAudioSegment();
      else { microphoneStream?.getTracks().forEach(track => track.stop()); microphoneStream = null; }
      uploadQueue = uploadQueue.then(() => uploadAudio(blob)).catch(error => { message.textContent = error.message; });
    };
    current.start();
    setTimeout(() => { if (current.state === 'recording') current.stop(); }, 8000);
  } catch (error) { message.textContent = error.message; stopTranscription(); }
}

async function stopTranscription() {
  listening = false;
  const button = document.querySelector('#transcribe');
  button.textContent = 'Start transcription'; button.classList.remove('recording');
  document.querySelector('#rec-state').classList.add('hidden');
  if (recorder?.state === 'recording') recorder.stop();
  else { microphoneStream?.getTracks().forEach(track => track.stop()); microphoneStream = null; }
}

async function toggleTranscription() {
  if (listening) return stopTranscription();
  if (needToken()) return;
  try {
    if (!(await window.assistant.confirm('transcription'))) return;
    if (!(await window.assistant.requestMicrophone())) throw new Error('Microphone permission is not enabled for this app.');
    const selected = document.querySelector('#microphone').value;
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: selected ? { deviceId: { exact: selected } } : true, video: false });
    listening = true;
    document.querySelector('#transcribe').textContent = 'Stop transcription';
    document.querySelector('#transcribe').classList.add('recording');
    message.textContent = 'Listening. Audio is transcribed in 8-second segments.';
    document.querySelector('#rec-state').classList.remove('hidden');
    startAudioSegment();
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphone = document.querySelector('#microphone'); const current = microphone.value;
    microphone.innerHTML = '<option value="">Default microphone</option>';
    devices.filter(device => device.kind === 'audioinput').forEach(device => {
      const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || 'Microphone'; microphone.append(option);
    });
    microphone.value = current;
  } catch (error) { message.textContent = error.message; await stopTranscription(); }
}

document.querySelector('#capture').addEventListener('click', () => captureAndAnswer());
document.querySelector('#refresh').addEventListener('click', refreshSources);
document.querySelector('#transcribe').addEventListener('click', toggleTranscription);
document.querySelector('#spoken-answer').addEventListener('click', () => askAssistant(ocrOutput.textContent.replace(/^Spoken question: /, '')));
document.querySelector('#connect-bridge').addEventListener('click', connectBridge);
document.querySelector('#clear').addEventListener('click', () => { ocrOutput.textContent = 'Capture a screen to extract its text.'; answer.innerHTML = '<span class="sparkle">✦</span><p>Your response will appear here.</p>'; preview.classList.add('hidden'); document.querySelector('#spoken-answer').classList.add('hidden'); message.textContent = ''; });
async function scanLoop() {
  if (!document.querySelector('#auto').checked) return;
  await captureAndAnswer({ periodic: true });
  if (document.querySelector('#auto').checked) timer = setTimeout(scanLoop, 15000);
}
document.querySelector('#auto').addEventListener('change', async event => {
  clearTimeout(timer);
  const badge = document.querySelector('#scan-state');
  if (!event.target.checked) { badge.classList.add('hidden'); return; }
  if (!sourceSelect.value) { event.target.checked = false; message.textContent = 'Choose a screen or window first.'; return; }
  if (!(await window.assistant.confirm('periodic'))) { event.target.checked = false; return; }
  badge.classList.remove('hidden'); lastScanText = '';
  scanLoop();
});
window.assistant.onCaptureShortcut(() => captureAndAnswer());
window.assistant.onShortcutUnavailable(() => { message.textContent = 'The keyboard shortcut is in use by another app; use the button instead.'; });
window.addEventListener('beforeunload', () => { listening = false; microphoneStream?.getTracks().forEach(track => track.stop()); });
(async () => {
  const field = document.querySelector('#bridge-token');
  field.value = localStorage.getItem('bridgeToken') || await window.assistant.localBridgeToken();
  if (field.value) connectBridge();
})();
refreshSources();

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
  document.querySelector('#api-key').placeholder = p.keyless ? 'Not needed for this provider' : 'Paste key (not saved to disk)';
  fillModels(p.models, selectedModel);
  providerStatus.textContent = p.transcription ? 'Chat and transcription supported.' : 'Chat only: this provider has no transcription model here, so use another provider for the microphone.';
}
window.PROVIDERS.forEach(p => providerSel.append(new Option(p.name, p.id)));
providerSel.addEventListener('change', () => onProviderChange());
modelSel.addEventListener('change', () => modelCustom.classList.toggle('hidden', modelSel.value !== CUSTOM));

async function saveProvider() {
  if (needToken()) return false;
  const p = currentProvider();
  const model = (modelSel.value === CUSTOM ? modelCustom.value : modelSel.value).trim();
  const key = document.querySelector('#api-key').value.trim();
  const baseUrl = document.querySelector('#base-url').value.trim();
  if (!baseUrl) { providerStatus.textContent = 'Enter the API base URL.'; return false; }
  if (!model) { providerStatus.textContent = 'Choose or enter a model (or use ⟳ to load the list after saving a key).'; return false; }
  if (!key && !p.keyless && !(await currentConfig())?.hasKey) { providerStatus.textContent = 'Paste your API key.'; return false; }
  try {
    const response = await fetch(`${API}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ baseUrl, model, apiKey: key || undefined, transcriptionModel: p.transcription, keyless: Boolean(p.keyless) }) });
    if (!response.ok) throw new Error(await readError(response, 'Could not save provider.'));
    document.querySelector('#api-key').value = '';
    try { localStorage.setItem('provider', JSON.stringify({ id: p.id, model, baseUrl })); } catch { /* ignore */ }
    providerStatus.textContent = `Saved: ${p.name} · ${model}. Content you analyze is sent to this provider.`;
    return true;
  } catch (error) { providerStatus.textContent = error.message; return false; }
}

async function fetchLiveModels() {
  const response = await fetch(`${API}/api/models`, { headers: authHeaders() });
  if (!response.ok) throw new Error(await readError(response, 'Could not load models.'));
  const { models } = await response.json();
  if (!models.length) throw new Error('Provider returned no models.');
  fillModels(models, modelSel.value === CUSTOM ? modelCustom.value : modelSel.value);
  return models.length;
}

async function loadModels() {
  if (!(await saveProvider())) return;
  try { providerStatus.textContent = `Loaded ${await fetchLiveModels()} models from the provider. Pick one and Save again.`; }
  catch (error) { providerStatus.textContent = `${error.message} You can still pick a listed model or Custom….`; }
}

async function currentConfig() {
  try { const r = await fetch(`${API}/api/config`, { headers: authHeaders() }); return r.ok ? await r.json() : null; } catch { return null; }
}
document.querySelector('#save-provider').addEventListener('click', async () => { if (await saveProvider()) fetchLiveModels().catch(() => {}); });
document.querySelector('#load-models').addEventListener('click', loadModels);

(async () => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('provider')); } catch { /* ignore */ }
  const p = window.PROVIDERS.find(x => x.id === saved?.id) || window.PROVIDERS[0];
  providerSel.value = p.id;
  onProviderChange(saved?.model);
  if (saved?.baseUrl && p.id === 'custom') document.querySelector('#base-url').value = saved.baseUrl;
  await new Promise(r => setTimeout(r, 400)); // let the token prefill finish
  const cfg = document.querySelector('#bridge-token').value ? await currentConfig() : null;
  if (cfg) providerStatus.textContent = cfg.hasKey || cfg.keyless ? `Server has a key for ${new URL(cfg.baseUrl).host}. Model: ${cfg.model}.` : 'Enter your API key and click Save provider.';
})();
