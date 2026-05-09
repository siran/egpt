// extension/src/content/wa-content.js — content script that runs in
// every web.whatsapp.com page (declared in manifest.chrome.json).
//
// No CDP, no --remote-allow-origins=*, no "started debugging" banner.
// Communicates with the extension's background service worker via a
// chrome.runtime port; background relays to/from the egpt UI tab and
// (optionally) to the bus.
//
// Wire protocol over the port:
//   { type: 'incoming', chatId, fromMe, msgId, text, ts }   (script → bg)
//   { type: 'ready', ts }                                    (script → bg)
//
// Send is NOT routed through this script — WA Web rejects synthetic
// DOM events (event.isTrusted=false). Background drives sends via
// chrome.debugger Input.* events directly against the WA tab; this
// content script is receive-only.
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
    // No inbound messages from background today — sends are routed
    // through chrome.debugger Input.* events directly to the tab
    // (synthetic DOM events from this content script can't trigger
    // WA Web's send button — WA checks event.isTrusted). The
    // listener stays as a hook for future control messages.
    port.onMessage.addListener(() => {});
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

  connect();
})();
