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

  // Parse the timestamp embedded in data-pre-plain-text.
  // Format observed: "[HH:MM, M/D/YYYY] Author: "  (also "[H:MM AM/PM, ...]" in some locales).
  // Returns ms-since-epoch, or null when unparsable. Used to filter
  // history rows: anything older than the content-script load time
  // (with grace) is past, never a real-time event no matter how it
  // got into the DOM.
  function parseRowTimestamp(row) {
    const ppt = row.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text');
    if (!ppt) return null;
    const m = ppt.match(/\[(\d{1,2}):(\d{2})(?:\s*(AM|PM))?,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]/i);
    if (!m) return null;
    let [, hh, mn, ampm, mo, da, yr] = m;
    hh = +hh; mn = +mn; mo = +mo; da = +da; yr = +yr;
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hh < 12) hh += 12;
      if (ampm.toUpperCase() === 'AM' && hh === 12) hh = 0;
    }
    // Try M/D/YYYY (en-US, the format observed here). If the resulting
    // date is in the future (i.e., locale is D/M), try the other order.
    let candidate = new Date(yr, mo - 1, da, hh, mn).getTime();
    if (candidate > Date.now() + 86_400_000) {
      candidate = new Date(yr, da - 1, mo, hh, mn).getTime();
    }
    return candidate;
  }
  function activeChat() {
    const h = document.querySelector('header span[dir="auto"][title]');
    return h?.getAttribute('title') || h?.innerText?.trim() || null;
  }

  // Silent window — debounced PER-CHAT. Each chat-switch dumps that
  // chat's history into the DOM via mutation; without a per-chat
  // reset, only the first chat-load is silenced and every subsequent
  // switch re-emits everything. Backstop: timestamp filter — any row
  // whose data-pre-plain-text timestamp predates the content script's
  // load time is treated as history and silenced regardless of seen
  // / silent-window state. The two layers cover each other when
  // either fails.
  const SILENT_WINDOW_MS = 5_000;
  const HISTORY_GRACE_MS = 5_000;
  const loadTime = Date.now();
  let silentUntil = loadTime + SILENT_WINDOW_MS;
  let lastChat = null;
  const isSilent = () => Date.now() < silentUntil;

  function scan() {
    const rows = document.querySelectorAll('[data-id]');
    const chat = activeChat();
    if (chat !== lastChat) {
      lastChat = chat;
      silentUntil = Date.now() + SILENT_WINDOW_MS;
    }
    const silent = isSilent();
    for (const row of rows) {
      const id = row.getAttribute('data-id');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (silent) continue;
      const text = textOf(row);
      if (!text) continue;
      // Backstop: drop rows older than (loadTime - grace). Real-time
      // messages will always be timestamped now-ish; history rows
      // (from chat reloads, virtual-list re-renders, etc.) won't be.
      const ts = parseRowTimestamp(row);
      if (ts && ts < loadTime - HISTORY_GRACE_MS) continue;
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
