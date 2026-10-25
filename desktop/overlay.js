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
