import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const TOKEN = 'a'.repeat(40);
const PORT = 18787, UPSTREAM = 18788;
let server, mock;

before(async () => {
  mock = http.createServer((req, res) => {
    if (req.url.endsWith('/chat/completions')) {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        const model = JSON.parse(body).model;
        if (model === 'json-model') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'whole' } }] })); }
        if (model === 'empty-model') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: [DONE]\n\n'); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (model === 'reason-model') res.write(`data:${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] })}\r\n\r\n`);
        for (const t of ['Hel', 'lo']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\r\n\r\n`);
        res.end('data: [DONE]\r\n\r\n');
      });
    } else if (req.url.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] }));
    } else if (req.url.endsWith('/audio/transcriptions')) {
      req.resume(); req.on('end', () => res.end(JSON.stringify({ text: 'what is the plan?' })));
    } else { res.writeHead(500); res.end('bad'); }
  }).listen(UPSTREAM, '127.0.0.1');
  server = spawn('node', ['index.js'], { env: { ...process.env, PORT, BRIDGE_TOKEN: TOKEN, OPENAI_API_KEY: 'test', AI_BASE_URL: `http://127.0.0.1:${UPSTREAM}` }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => { server.kill(); mock.close(); });

const url = p => `http://127.0.0.1:${PORT}${p}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

test('rejects missing/invalid token on every api route', async () => {
  for (const [m, p] of [['GET', '/api/context'], ['POST', '/api/context'], ['POST', '/api/answer'], ['POST', '/api/transcribe']]) {
    assert.equal((await fetch(url(p), { method: m })).status, 401, p);
    assert.equal((await fetch(url(p), { method: m, headers: { Authorization: 'Bearer wrong' } })).status, 401, p);
  }
});
test('context sync round-trips with valid token', async () => {
  const post = await fetch(url('/api/context'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'notes' }) });
  assert.equal(post.status, 200);
  assert.equal((await (await fetch(url('/api/context'), { headers: auth })).json()).text, 'notes');
});
test('context validation', async () => {
  const r = await fetch(url('/api/context'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 5 }) });
  assert.equal(r.status, 400);
  const bad = await fetch(url('/api/context'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
});
test('answer streams tokens', async () => {
  const r = await fetch(url('/api/answer'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'x' }) });
  const text = await r.text();
  assert.match(text, /"Hel"/); assert.match(text, /"lo"/);
});
test('answer rejects empty task', async () => {
  const r = await fetch(url('/api/answer'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400);
});
test('transcribe requires audio and returns provider text', async () => {
  assert.equal((await fetch(url('/api/transcribe'), { method: 'POST', headers: auth })).status, 400);
  const form = new FormData(); form.append('audio', new Blob(['x'], { type: 'audio/webm' }), 'a.webm');
  const r = await fetch(url('/api/transcribe'), { method: 'POST', headers: auth, body: form });
  assert.equal((await r.json()).text, 'what is the plan?');
});
test('binds to loopback only', async () => {
  const r = await fetch(url('/health')); assert.equal(r.status, 200);
});

test('provider config: save, never leak key, list models, key not reused on new host', async () => {
  const json = { ...auth, 'Content-Type': 'application/json' };
  const save = await fetch(url('/api/config'), { method: 'POST', headers: json, body: JSON.stringify({ baseUrl: `http://127.0.0.1:${UPSTREAM}`, model: 'x', apiKey: 'secret-key', transcriptionModel: 't' }) });
  assert.equal(save.status, 200);
  const cfg = await (await fetch(url('/api/config'), { headers: auth })).json();
  assert.equal(cfg.hasKey, true); assert.equal(cfg.model, 'x');
  assert.ok(!JSON.stringify(cfg).includes('secret-key'));
  assert.deepEqual((await (await fetch(url('/api/models'), { headers: auth })).json()).models, ['m-a', 'm-b']);
  const bad = await fetch(url('/api/config'), { method: 'POST', headers: json, body: JSON.stringify({ baseUrl: 'ftp://x', model: 'x' }) });
  assert.equal(bad.status, 400);
  await fetch(url('/api/config'), { method: 'POST', headers: json, body: JSON.stringify({ baseUrl: 'https://other.example/v1', model: 'x' }) });
  assert.equal((await (await fetch(url('/api/config'), { headers: auth })).json()).hasKey, false);
});

async function answerWith(model) {
  const json = { ...auth, 'Content-Type': 'application/json' };
  await fetch(url('/api/config'), { method: 'POST', headers: json, body: JSON.stringify({ baseUrl: `http://127.0.0.1:${UPSTREAM}`, model, apiKey: 'k' }) });
  return (await fetch(url('/api/answer'), { method: 'POST', headers: json, body: JSON.stringify({ task: 'x' }) })).text();
}
test('handles CRLF streams, reasoning deltas, non-stream JSON and empty replies', async () => {
  const reason = await answerWith('reason-model');
  assert.match(reason, /"reasoning":"thinking"/); assert.match(reason, /"Hel"/);
  assert.match(await answerWith('json-model'), /"token":"whole"/);
  assert.match(await answerWith('empty-model'), /empty response/);
});
