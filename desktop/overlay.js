// Minimal, DOM-only markdown (code fences, **bold**, `inline`) so model output never becomes HTML.
function renderMarkdown(text, into) {
  into.textContent = '';
  text.split(/```/).forEach((part, i) => {
    if (i % 2) { const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = part.replace(/^[\w+-]*\n/, '').replace(/\n$/, ''); pre.append(code); into.append(pre); return; }
    part.split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach(chunk => {
      if (/^\*\*[^*]+\*\*$/.test(chunk)) { const b = document.createElement('strong'); b.textContent = chunk.slice(2, -2); into.append(b); }
      else if (/^`[^`]+`$/.test(chunk)) { const c = document.createElement('code'); c.textContent = chunk.slice(1, -1); into.append(c); }
      else into.append(document.createTextNode(chunk));
    });
  });
}

const listenButton = document.querySelector('#listen');
listenButton.addEventListener('click', () => window.overlay.toggleListening());
window.overlay.onListening(on => {
  listenButton.textContent = on ? '⏸ Pause' : '▶ Start';
  document.querySelector('#voice .state').textContent = on ? 'Listening…' : 'Paused';
});
document.querySelector('#close').addEventListener('click', () => window.overlay.close());
document.querySelector('#capture').addEventListener('click', () => window.overlay.capture());

const empty = {
  voice: { question: 'Nothing heard yet.', answer: 'Replies to what the other person says appear here.', state: 'Listening…' },
  screen: { question: 'Click Capture screen to read your whole screen.', answer: 'The answer for what is on your screen appears here.', state: 'Idle' }
};
window.overlay.onUpdate(({ channel, question, answer, state, error }) => {
  const pane = document.querySelector(`#${channel === 'screen' ? 'screen' : 'voice'}`);
  const fallback = empty[channel === 'screen' ? 'screen' : 'voice'];
  const answerEl = pane.querySelector('.answer');
  pane.querySelector('.question').textContent = question || fallback.question;
  pane.querySelector('.state').textContent = state || fallback.state;
  if (error) { answerEl.textContent = error; answerEl.classList.add('error'); return; }
  answerEl.classList.remove('error');
  const stick = answerEl.scrollHeight - answerEl.scrollTop - answerEl.clientHeight < 40;
  if (answer) renderMarkdown(answer, answerEl); else answerEl.textContent = fallback.answer;
  if (stick) answerEl.scrollTop = answerEl.scrollHeight;
});

// ---- Fix-and-send inputs: prefill with what was heard/read unless the user has started editing ----
document.querySelectorAll('.pane').forEach(pane => {
  const channel = pane.id;
  const form = pane.querySelector('.ask-form'); const input = form.querySelector('input'); const question = pane.querySelector('.question');
  let prefilled = '';
  new MutationObserver(() => {
    const heard = question.textContent;
    if (heard === empty[channel].question || /^(Reading your whole screen)/.test(heard)) return;
    if (!input.value || input.value === prefilled) { input.value = heard.replace(/…$/, ''); prefilled = input.value; }
  }).observe(question, { childList: true, characterData: true, subtree: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim(); if (!text) return;
    window.overlay.ask(channel, text); input.value = ''; prefilled = '';
  });
});

// ---- Saved conversations: shown above "Heard" in each pane, scroll up for older ones ----
function historyItem({ time, question, answer }) {
  const item = document.createElement('div'); item.className = 'turn';
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = new Date(time).toLocaleString();
  const q = document.createElement('p'); q.className = 'q'; q.textContent = question;
  const a = document.createElement('div'); a.className = 'a'; renderMarkdown(answer, a);
  item.append(meta, q, a); return item;
}
function addHistory(entry) {
  const log = document.querySelector(`#${entry.channel === 'screen' ? 'screen' : 'voice'} .log`);
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(historyItem(entry));
  if (stick) log.scrollTop = log.scrollHeight;
}
window.overlay.getHistory().then(list => { list.forEach(addHistory); document.querySelectorAll('.log').forEach(log => { log.scrollTop = log.scrollHeight; }); });
window.overlay.onHistoryAdd(addHistory);
