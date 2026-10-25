// Floating assistant panel injected into the meeting tab (isolated in a shadow root so the page cannot restyle it).
(() => {
  if (window.__meetingLiveAssistant) { window.__meetingLiveAssistant.show(); return; }
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:380px;height:300px;min-width:260px;min-height:160px;resize:both;overflow:hidden;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      .panel{height:100%;display:flex;flex-direction:column;border-radius:14px;border:1px solid rgba(255,255,255,.55);background:rgba(255,255,255,.55);backdrop-filter:blur(16px) saturate(1.4);box-shadow:0 8px 30px rgba(0,0,0,.25);color:#000;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
      header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;cursor:grab;font-weight:700;border-bottom:1px solid rgba(0,0,0,.12);user-select:none}
      button{font:600 11px inherit;color:#000;background:rgba(255,255,255,.75);border:1px solid rgba(0,0,0,.25);border-radius:7px;padding:3px 9px;cursor:pointer}
      .body{flex:1;min-height:0;display:flex;flex-direction:column;padding:6px 12px 10px}
      h3{margin:6px 0 2px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.65}
      #heard{margin:0;max-height:64px;overflow:auto;font-weight:600}
      #answer{flex:1;min-height:0;overflow:auto;white-space:pre-wrap;font-size:14px}
      #answer.error{color:#7a0000}
      .state{font-weight:600;font-size:11px;opacity:.7;margin-right:6px}
    </style>
    <div class="panel">
      <header id="drag"><span>✦ Live assistant</span><span><span class="state" id="state">Listening…</span><button id="toggle">⏸ Pause</button> <button id="close">✕</button></span></header>
      <div class="body"><h3>Heard</h3><p id="heard">Nothing heard yet.</p><h3>Say this</h3><div id="answer">Replies to what the other person says appear here.</div></div>
    </div>`;
  document.documentElement.append(host);
  const $ = selector => root.querySelector(selector);

  let dragging = null;
  $('#drag').addEventListener('mousedown', event => { if (event.target.closest('button')) return; const rect = host.getBoundingClientRect(); dragging = { x: event.clientX - rect.left, y: event.clientY - rect.top }; event.preventDefault(); });
  addEventListener('mousemove', event => { if (dragging) { host.style.left = `${event.clientX - dragging.x}px`; host.style.top = `${event.clientY - dragging.y}px`; host.style.right = 'auto'; } });
  addEventListener('mouseup', () => { dragging = null; });
  $('#close').addEventListener('click', () => { host.style.display = 'none'; });
  $('#toggle').addEventListener('click', () => chrome.runtime.sendMessage({ target: 'background', type: 'toggle' }));

  chrome.runtime.onMessage.addListener(message => {
    if (message?.target !== 'panel') return;
    host.style.display = 'block';
    if (message.type === 'listening') {
      $('#toggle').textContent = message.on ? '⏸ Pause' : '▶ Start';
      $('#state').textContent = message.on ? 'Listening…' : 'Paused';
    } else if (message.type === 'reply') {
      $('#heard').textContent = message.heard || $('#heard').textContent;
      $('#state').textContent = message.state || '';
      const answer = $('#answer');
      answer.className = message.error ? 'error' : '';
      answer.textContent = message.error || message.answer || '';
      answer.scrollTop = answer.scrollHeight;
    }
  });
  window.__meetingLiveAssistant = { show: () => { host.style.display = 'block'; } };
})();
