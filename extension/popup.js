const tokenInput = document.querySelector('#token');
const contextInput = document.querySelector('#context');
const status = document.querySelector('#status');
chrome.storage.local.get(['bridgeToken', 'meetingContext'], stored => {
  tokenInput.value = stored.bridgeToken || '';
  contextInput.value = stored.meetingContext || '';
});

document.querySelector('#send').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const text = contextInput.value;
  if (!token) { status.textContent = 'Enter the bridge token first.'; return; }
  status.textContent = 'Sending to local assistant…';
  chrome.storage.local.set({ bridgeToken: token, meetingContext: text });
  try {
    const response = await fetch('http://127.0.0.1:8787/api/context', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Bridge request failed (${response.status}).`);
    status.textContent = 'Context sent to the desktop assistant.';
  } catch (error) { status.textContent = error.message || 'Could not reach the local assistant.'; }
});

document.querySelector('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(contextInput.value); status.textContent = 'Copied to clipboard.'; }
  catch { status.textContent = 'Select and copy the text manually.'; }
});
