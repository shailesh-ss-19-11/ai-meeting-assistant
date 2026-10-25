import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { timingSafeEqual } from 'node:crypto';

const app = express();
// Electron's file:// renderer sends the serialized origin "null". The API
// itself is bound to loopback only, so permit that renderer origin explicitly.
app.use(cors({ origin: (origin, callback) => {
  const isExtension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '');
  callback(null, !origin || origin === 'null' || origin === 'http://localhost:5173' || isExtension);
} }));
app.use(express.json({ limit: '1mb' }));
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
// Provider settings live in memory only (seeded from .env); the key is never returned to any client.
const aiConfig = {
  baseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'replace-me' ? process.env.OPENAI_API_KEY : '',
  model: process.env.AI_MODEL || 'gpt-4o-mini',
  transcriptionModel: process.env.AI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  keyless: false
};
const providerHeaders = extra => ({ ...(aiConfig.apiKey ? { Authorization: `Bearer ${aiConfig.apiKey}` } : {}), ...extra });
const providerReady = () => Boolean(aiConfig.apiKey || aiConfig.keyless);
let latestContext = { text: '', updatedAt: null };

const MIN_TOKEN_LENGTH = 32;
function tokenProblem() {
  const expected = process.env.BRIDGE_TOKEN || '';
  if (!expected || expected === 'replace-with-a-random-secret') return 'Set a private BRIDGE_TOKEN in server/.env.';
  if (expected.length < MIN_TOKEN_LENGTH) return `BRIDGE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (try: openssl rand -hex 32).`;
  return null;
}

// Every /api route requires the token so other local pages or processes cannot spend the AI key.
function requireBridgeToken(req, res, next) {
  const problem = tokenProblem();
  if (problem) return res.status(503).json({ error: problem });
  const expectedBytes = Buffer.from(process.env.BRIDGE_TOKEN);
  const providedBytes = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const valid = expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
  if (!valid) return res.status(401).json({ error: 'Bridge token is missing or invalid.' });
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/context', requireBridgeToken, (_req, res) => res.set('Cache-Control', 'no-store').json(latestContext));
app.post('/api/context', requireBridgeToken, (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== 'string' || text.length > 12000) return res.status(400).json({ error: 'Context must be text of at most 12,000 characters.' });
  latestContext = { text, updatedAt: new Date().toISOString() };
  res.set('Cache-Control', 'no-store').json({ ok: true, updatedAt: latestContext.updatedAt });
});
app.get('/api/config', requireBridgeToken, (_req, res) => {
  const { baseUrl, model, transcriptionModel, keyless } = aiConfig;
  res.set('Cache-Control', 'no-store').json({ baseUrl, model, transcriptionModel, keyless, hasKey: Boolean(aiConfig.apiKey) });
});
app.post('/api/config', requireBridgeToken, (req, res) => {
  const { baseUrl, apiKey, model, transcriptionModel = '', keyless = false } = req.body ?? {};
  let url;
  try { url = new URL(baseUrl); } catch { /* handled below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol)) return res.status(400).json({ error: 'baseUrl must be an http(s) URL.' });
  if (typeof model !== 'string' || !model.trim() || model.length > 200) return res.status(400).json({ error: 'A model name is required.' });
  if (typeof transcriptionModel !== 'string' || transcriptionModel.length > 200) return res.status(400).json({ error: 'Invalid transcription model.' });
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 500)) return res.status(400).json({ error: 'Invalid API key.' });
  // Switching provider without a new key must not send the old provider's key to the new host.
  const sameHost = new URL(aiConfig.baseUrl).origin === url.origin;
  aiConfig.apiKey = apiKey?.trim() || (sameHost ? aiConfig.apiKey : '');
  Object.assign(aiConfig, { baseUrl: baseUrl.replace(/\/$/, ''), model: model.trim(), transcriptionModel: transcriptionModel.trim(), keyless: Boolean(keyless) });
  res.json({ ok: true, hasKey: Boolean(aiConfig.apiKey) });
});
app.get('/api/models', requireBridgeToken, async (req, res) => {
  // ?baseUrl= previews another provider's public model list; the saved key is only sent to the saved host.
  let base = aiConfig.baseUrl;
  if (req.query.baseUrl) {
    try { const u = new URL(String(req.query.baseUrl)); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); base = String(req.query.baseUrl).replace(/\/$/, ''); }
    catch { return res.status(400).json({ error: 'baseUrl must be an http(s) URL.' }); }
  }
  const sameHost = new URL(base).origin === new URL(aiConfig.baseUrl).origin;
  if (!req.query.baseUrl && !providerReady()) return res.status(503).json({ error: 'Save an API key first.' });
  try {
    const response = await fetch(`${base}/models`, { headers: sameHost ? providerHeaders() : {}, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return res.status(response.status).json({ error: `Provider returned ${response.status} when listing models.` });
    const body = await response.json();
    const items = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    const models = items.map(m => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean).sort();
    res.json({ models });
  } catch (error) { res.status(502).json({ error: error.message || 'Could not list models.' }); }
});
app.post('/api/transcribe', requireBridgeToken, (req, res, next) => audioUpload.single('audio')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'An audio segment is required.' });
  if (!providerReady()) return res.status(503).json({ error: 'Save an API key in the Setup card first.' });
  if (!aiConfig.transcriptionModel) return res.status(400).json({ error: 'This provider has no speech-to-text. Choose Groq (one key for chat and voice).' });
  try {
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'meeting.webm');
    form.append('model', aiConfig.transcriptionModel);
    const response = await fetch(`${aiConfig.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: providerHeaders(), body: form
    });
    if (!response.ok) return res.status(response.status).json({ error: `Transcription provider returned ${response.status}: ${(await response.text()).slice(0, 200)}` });
    const result = await response.json();
    res.json({ text: typeof result.text === 'string' ? result.text : '' });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not reach transcription provider.' });
  }
});
app.post('/api/answer', requireBridgeToken, async (req, res) => {
  const { task, context = '', spoken = false } = req.body ?? {};
  if (typeof task !== 'string' || !task.trim()) return res.status(400).json({ error: 'Task text is required.' });
  if (task.length > 20000 || typeof context !== 'string' || context.length > 12000) return res.status(413).json({ error: 'Input is too long.' });
  if (!providerReady()) return res.status(503).json({ error: 'Save an API key in the AI provider card first.' });

  const upstream = new AbortController();
  res.on('close', () => upstream.abort());
  try {
    const response = await fetch(`${aiConfig.baseUrl}/chat/completions`, {
      method: 'POST', signal: upstream.signal,
      headers: providerHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: aiConfig.model, stream: true, messages: [
        { role: 'system', content: spoken
          ? 'You are speaking in a live meeting on the user\'s behalf. The other person just said something. Reply to it directly, in first person, in 2-4 short natural spoken sentences the user can read out loud. No headings, no preamble.'
          : 'You are a concise meeting assistant. Help reason through the user-provided task. State assumptions and explain code or answers clearly.' },
        { role: 'user', content: spoken ? `Recent conversation:\n${context || '(none)'}\n\nThe other person just said:\n${task}` : `Recent meeting context:\n${context || '(none provided)'}\n\nTask detected from screen:\n${task}` }
      ] })
    });
    if (!response.ok) return res.status(response.status).json({ error: `AI provider returned ${response.status}: ${(await response.text()).slice(0, 200)}` });
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    let sent = 0;
    const handleChunk = chunk => {
      if (chunk.error) { send({ error: String(chunk.error.message || chunk.error).slice(0, 300) }); sent++; return; }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? choice?.message ?? {};
      // Reasoning models (e.g. DeepSeek-R1, Nemotron) may stream their thoughts in a separate field.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof delta.content === 'string' && delta.content) { send({ token: delta.content }); sent++; }
      else if (typeof reasoning === 'string' && reasoning) { send({ reasoning }); sent++; }
    };
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      // Some providers ignore stream:true and return one JSON body.
      try { handleChunk(await response.json()); } catch { /* reported below */ }
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split(/\r?\n/);
        pending = done ? '' : lines.pop();
        if (done) pending = '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try { handleChunk(JSON.parse(data)); } catch { /* ignore incomplete/provider metadata lines */ }
        }
        if (done) break;
      }
    }
    if (!sent) send({ error: 'The provider returned an empty response. Check that the selected model supports chat completions.' });
    res.end();
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ error: error.message || 'Could not reach AI provider.' });
    else res.end();
  }
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return res.end();
  const status = error.status || error.statusCode || 500;
  res.status(status).json({ error: status === 400 ? 'Request body is not valid JSON.' : status === 413 ? 'Request body is too large.' : 'Unexpected server error.' });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, '127.0.0.1', () => {
  console.log(`Assistant API listening on http://127.0.0.1:${port}`);
  if (tokenProblem()) console.warn(`Warning: ${tokenProblem()}`);
  if (!aiConfig.apiKey) console.warn('Note: no API key in .env; choose a provider and enter a key in the desktop app.');
});
