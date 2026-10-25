const keyInput = document.querySelector('#key');
const modelSelect = document.querySelector('#model');
const status = document.querySelector('#status');

chrome.storage.local.get(['groqKey', 'model'], stored => {
  keyInput.value = stored.groqKey || '';
  if (stored.model) modelSelect.value = stored.model;
});

document.querySelector('#start').addEventListener('click', async () => {
  const key = keyInput.value.trim();
  if (!key) { status.textContent = 'Paste your Groq API key first.'; return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) { status.textContent = 'Open the meeting tab first, then click this again.'; return; }
  await chrome.storage.local.set({ groqKey: key, model: modelSelect.value });
  try {
    // The stream id must be requested here, while the click that opened this popup still grants access to the tab.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const result = await chrome.runtime.sendMessage({ target: 'background', type: 'start', tabId: tab.id, streamId });
    if (result?.error) throw new Error(result.error);
    status.textContent = 'Listening to this tab. The assistant panel is on the page.';
  } catch (error) { status.textContent = error.message; }
});

document.querySelector('#stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
  status.textContent = 'Stopped.';
});
