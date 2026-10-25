// Captures the meeting tab's audio, cuts it at pauses, transcribes it with Groq Whisper and asks the chat model for a reply.
const RATE = 16000;
const SILENT_RMS = 0.0037;   // whole chunk below this is skipped (also stops Whisper inventing "Thank you.")
const PAUSE_RMS = 0.0046;    // trailing 0.7 s below this means the speaker paused
const GROQ = 'https://api.groq.com/openai/v1';

let playback; let analysis; let processor; let stream;
let config = { key: '', model: '' };
let paused = false;
let chunks = []; let sampleCount = 0;
let answering = false; let pending = null;

const rms = frames => { let sum = 0; for (const v of frames) sum += v * v; return frames.length ? Math.sqrt(sum / frames.length) : 0; };
const panel = payload => chrome.runtime.sendMessage({ target: 'background', type: 'panel', payload });

function wavFrom(frames) {
  const pcm = new Int16Array(frames.length);
  for (let i = 0; i < frames.length; i++) pcm[i] = Math.max(-1, Math.min(1, frames[i])) * 32767;
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset, value) => [...value].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); header.setUint32(4, 36 + pcm.byteLength, true); text(8, 'WAVEfmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true);
  header.setUint16(22, 1, true); header.setUint32(24, RATE, true); header.setUint32(28, RATE * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
  text(36, 'data'); header.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

async function transcribe(frames) {
  const form = new FormData();
  form.append('file', wavFrom(frames), 'call.wav'); form.append('model', 'whisper-large-v3-turbo');
  const response = await fetch(`${GROQ}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${config.key}` }, body: form });
  if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${(await response.text()).slice(0, 160)}`);
  return ((await response.json()).text || '').trim();
}

async function answer(heard) {
  if (answering) { pending = heard; return; }
  answering = true;
  panel({ type: 'reply', heard, answer: '', state: 'Thinking…' });
  let raw = '';
  try {
    const response = await fetch(`${GROQ}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: config.model, stream: true, messages: [
        { role: 'system', content: "You are speaking in a live meeting on the user's behalf. The other person just said something. Reply to it directly, in first person, in 2-4 short natural spoken sentences the user can read out loud. No headings, no preamble." },
        { role: 'user', content: `The other person just said:\n${heard}` }] }) });
    if (!response.ok) throw new Error(`Chat failed (${response.status}): ${(await response.text()).slice(0, 160)}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        try { raw += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch { continue; }
        panel({ type: 'reply', heard, answer: raw, state: 'Writing…' });
      }
    }
    panel({ type: 'reply', heard, answer: raw, state: 'Ready' });
  } catch (error) { panel({ type: 'reply', heard, error: error.message, state: 'Error' }); }
  finally { answering = false; if (pending) { const next = pending; pending = null; answer(next); } }
}

async function flush() {
  const frames = new Float32Array(sampleCount); let offset = 0;
  for (const part of chunks) { frames.set(part, offset); offset += part.length; }
  chunks = []; sampleCount = 0;
  if (rms(frames) < SILENT_RMS) return;
  try {
    const text = await transcribe(frames);
    if (text.split(/\s+/).filter(Boolean).length >= 3) answer(text);
  } catch (error) { panel({ type: 'reply', heard: '', error: error.message, state: 'Error' }); }
}

function onAudio(event) {
  if (paused) return;
  const data = new Float32Array(event.inputBuffer.getChannelData(0));
  chunks.push(data); sampleCount += data.length;
  if (sampleCount < 3 * RATE) return;
  // Cut where the speaker pauses so sentences stay whole, or after 15 s of continuous speech.
  const tail = new Float32Array(Math.floor(0.7 * RATE)); let filled = 0;
  for (let i = chunks.length - 1; i >= 0 && filled < tail.length; i--) {
    const take = Math.min(chunks[i].length, tail.length - filled);
    tail.set(chunks[i].subarray(chunks[i].length - take), tail.length - filled - take); filled += take;
  }
  if (rms(tail) < PAUSE_RMS || sampleCount >= 15 * RATE) flush();
}

async function start({ streamId, key, model }) {
  stop();
  config = { key, model }; paused = false;
  stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  // Capturing a tab mutes it for the user, so play it back unchanged while a second 16 kHz context feeds the transcriber.
  playback = new AudioContext(); playback.createMediaStreamSource(stream).connect(playback.destination);
  analysis = new AudioContext({ sampleRate: RATE });
  processor = analysis.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = onAudio;
  analysis.createMediaStreamSource(stream).connect(processor); processor.connect(analysis.destination);
}

function stop() {
  processor?.disconnect(); stream?.getTracks().forEach(track => track.stop());
  playback?.close().catch(() => {}); analysis?.close().catch(() => {});
  processor = stream = playback = analysis = null; chunks = []; sampleCount = 0; pending = null;
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.target !== 'offscreen') return;
  if (message.type === 'start') start(message).catch(error => panel({ type: 'reply', heard: '', error: `Could not capture the tab audio: ${error.message}`, state: 'Error' }));
  else if (message.type === 'stop') stop();
  else if (message.type === 'toggle') { paused = !paused; chunks = []; sampleCount = 0; panel({ type: 'listening', on: !paused }); }
});
