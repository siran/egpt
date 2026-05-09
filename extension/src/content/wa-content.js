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
  // Queue of events that fire while port is null (MV3 SW idle window
  // between disconnect and reconnect). Without this, phone-typed
  // messages that arrive in that ~1s gap are lost. Capped to avoid
  // unbounded growth if the SW never recovers.
  const _queue = [];
  const QUEUE_CAP = 100;

  function connect() {
    try { port = chrome.runtime.connect({ name: 'egpt-wa-content' }); }
    catch { return setTimeout(connect, 1000); }
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => {
      port = null;
      // Service worker may have idled; reconnect shortly.
      setTimeout(connect, 1000);
    });
    // Always start with a ready ping.
    try { port.postMessage({ type: 'ready', ts: Date.now() }); } catch (_) {}
    // Drain anything that queued while we were disconnected — phone-
    // typed messages, etc.
    while (port && _queue.length > 0) {
      const ev = _queue.shift();
      try { port.postMessage(ev); }
      catch { _queue.unshift(ev); break; }
    }
  }

  function safePost(ev) {
    if (!port) {
      _queue.push(ev);
      if (_queue.length > QUEUE_CAP) _queue.shift();
      return;
    }
    try { port.postMessage(ev); }
    catch {
      _queue.push(ev);
      if (_queue.length > QUEUE_CAP) _queue.shift();
    }
  }

  // Track seen message ids so MutationObserver re-scans don't replay.
  const seen = new Set();

  // WA Web's data-id used to encode '<fromMe>_<chatJid>_<msgId>'; modern
  // builds drop the prefix and just use the bare msgId. So we extract:
  //   - msgId from data-id
  //   - text from the row's .copyable-text descendant
  //   - author from the row's data-pre-plain-text="[time, date] Name: "
  //   - active chat label from the conversation header
  // fromMe detection is unreliable from DOM alone (in self-DM both
  // directions show the same author), so v1 emits all rows as fromMe
  // and relies on background's echo tracker to suppress our own
  // debugger-sends bouncing back. Phase 2b will add multi-chat
  // awareness with proper sender vs self detection.
  function textOf(row) {
    const el = row.querySelector('.copyable-text, [class*="copyable-text"]');
    if (!el) return '';
    return (el.innerText || '').trim();
  }
  function authorOf(row) {
    const ppt = row.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text');
    if (!ppt) return null;
    // Format: "[10:04, 5/9/2026] An: "
    const m = ppt.match(/\]\s*(.+?):\s*$/);
    return m ? m[1] : null;
  }
  function activeChat() {
    const h = document.querySelector('header span[dir="auto"][title]');
    return h?.getAttribute('title') || h?.innerText?.trim() || null;
  }

  // Silent window after script load. The initial document.querySelectorAll
  // catches rows present at load time, but if the user has only the chat
  // list visible (no conversation pane open), there's nothing to catch.
  // When they later click a chat, the entire conversation history flows
  // in via DOM mutation — every row would emit as 'incoming', cascading
  // into TG/extension dispatch loops. During the silent window we still
  // mark rows as seen but skip the emit, treating any DOM additions as
  // chat-load activity rather than new messages.
  const startedAt = Date.now();
  const SILENT_WINDOW_MS = 5_000;
  const isSilent = () => Date.now() - startedAt < SILENT_WINDOW_MS;

  function scan() {
    const rows = document.querySelectorAll('[data-id]');
    const chat = activeChat();
    const silent = isSilent();
    for (const row of rows) {
      const id = row.getAttribute('data-id');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (silent) continue;       // history dump, not real-time input
      const text = textOf(row);
      if (!text) continue;
      safePost({
        type: 'incoming',
        chatId:  chat,
        fromMe:  true,
        msgId:   id,
        text,
        author:  authorOf(row),
        ts: Date.now(),
      });
    }
  }

  // Initial sweep: silence anything currently in the DOM.
  document.querySelectorAll('[data-id]').forEach(r => seen.add(r.getAttribute('data-id')));

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body, { childList: true, subtree: true });

  connect();
})();
