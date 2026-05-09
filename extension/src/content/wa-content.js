// extension/src/content/wa-content.js — content script that runs in
// every web.whatsapp.com page (declared in manifest.chrome.json).
//
// No CDP, no --remote-allow-origins=*, no "started debugging" banner.
// Communicates with the extension's background service worker via a
// chrome.runtime port; background relays to/from the egpt UI tab and
// (optionally) to the bus.
//
// Wire protocol over the port (in both directions):
//   { type: 'incoming', chatId, fromMe, msgId, text, ts }   (script → bg)
//   { type: 'ready', ts }                                    (script → bg)
//   { type: 'send', text }                                   (bg → script)
//
// Selectors are heuristic and will drift as WA Web ships UI changes.
// They're all in this file — pin updates here when the bundle moves.

(() => {
  if (window.__egptWaContentInstalled) return;
  window.__egptWaContentInstalled = true;

  let port = null;

  function connect() {
    try { port = chrome.runtime.connect({ name: 'egpt-wa-content' }); }
    catch { return setTimeout(connect, 1000); }
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'send') doSend(msg.text);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // Service worker may have idled; reconnect shortly.
      setTimeout(connect, 1000);
    });
    safePost({ type: 'ready', ts: Date.now() });
  }

  function safePost(ev) {
    if (!port) return;
    try { port.postMessage(ev); } catch { /* port died — onDisconnect will retry */ }
  }

  // Track seen message ids so MutationObserver re-scans don't replay.
  const seen = new Set();

  // WA Web data-id format: "<fromMe>_<chatJid>_<msgId>". chatJid can
  // itself contain '_' in group ids — split, then reassemble the middle.
  function parseDataId(id) {
    if (!id) return null;
    const parts = id.split('_');
    if (parts.length < 3) return null;
    return {
      fromMe:  parts[0] === 'true',
      chatJid: parts.slice(1, -1).join('_'),
      msgId:   parts[parts.length - 1],
    };
  }

  function textOf(row) {
    const el = row.querySelector('.copyable-text, [class*="copyable-text"]');
    if (!el) return '';
    return (el.innerText || '').trim();
  }

  function scan() {
    const rows = document.querySelectorAll('[data-id]');
    for (const row of rows) {
      const id = row.getAttribute('data-id');
      if (seen.has(id)) continue;
      const parsed = parseDataId(id);
      if (!parsed) { seen.add(id); continue; }
      const text = textOf(row);
      if (!text) { seen.add(id); continue; }
      seen.add(id);
      safePost({
        type: 'incoming',
        chatId:  parsed.chatJid,
        fromMe:  parsed.fromMe,
        msgId:   parsed.msgId,
        text,
        ts: Date.now(),
      });
    }
  }

  // Initial scan: silence existing messages so a fresh page load
  // doesn't flood the bus with chat history.
  document.querySelectorAll('[data-id]').forEach(r => seen.add(r.getAttribute('data-id')));

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });

  // Send: type into the WA Web composer and click send (or fall back
  // to Enter). Returns true on success-ish, false if the input or
  // send button can't be located.
  function doSend(text) {
    const input = document.querySelector('div[contenteditable="true"][data-tab="10"]')
               || document.querySelector('footer div[contenteditable="true"]')
               || document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (!input) return false;
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete',    false, null);
    document.execCommand('insertText', false, text);
    const sendBtn = document.querySelector('button[aria-label*="Send" i]')
                 || document.querySelector('span[data-icon="send"]')?.closest('button')
                 || document.querySelector('span[data-icon="wds-ic-send-filled"]')?.closest('button');
    if (sendBtn) { sendBtn.click(); return true; }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }

  connect();
})();
