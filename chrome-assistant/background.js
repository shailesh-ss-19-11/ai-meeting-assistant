// Coordinates the popup, the offscreen audio worker and the page panel. Holds no state that must survive a restart.
let activeTabId = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Capture and transcribe the audio of the meeting tab.' });
}

async function toPanel(message) {
  if (activeTabId == null) return;
  try { await chrome.tabs.sendMessage(activeTabId, { target: 'panel', ...message }); } catch { /* tab closed or reloaded */ }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'background') return;
  (async () => {
    if (message.type === 'start') {
      const { groqKey, model } = await chrome.storage.local.get(['groqKey', 'model']);
      if (!groqKey) return sendResponse({ error: 'No API key saved.' });
      activeTabId = message.tabId;
      await chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ['content.js'] });
      await ensureOffscreen();
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: message.streamId, key: groqKey, model: model || 'openai/gpt-oss-120b' });
      await toPanel({ type: 'listening', on: true });
      sendResponse({ ok: true });
    } else if (message.type === 'stop') {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
      await toPanel({ type: 'listening', on: false });
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
      sendResponse({ ok: true });
    } else if (message.type === 'toggle') {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'toggle' });
      sendResponse({ ok: true });
    } else if (message.type === 'panel') {
      await toPanel(message.payload);
      sendResponse({ ok: true });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== activeTabId) return;
  activeTabId = null;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
});
