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

  // JID shape: <digits>@<host> for personal chats; <digits>-<digits>@g.us
  // for groups. Reject message-id-shaped values (pure hex without @).
  const looksLikeJid = (v) => typeof v === 'string'
    && /^[\w\d-]+@[\w.]+$/.test(v)
    && !/^[A-F0-9]{16,}$/i.test(v);

  function chatListPanel() {
    return document.querySelector('[aria-label="Chat list" i]') ||
           document.querySelector('[role="grid"][aria-label*="Chat" i]');
  }

  // Extract { jid, name, preview, unread } from a chat-list row.
  // Returns null when the row has no name.
  function extractRow(row) {
    const titleEl = row.querySelector('span[dir="auto"][title]')
                 || row.querySelector('span[dir="auto"]');
    const name = (titleEl?.getAttribute('title') || titleEl?.innerText || '').trim();
    if (!name) return null;
    let jid = null;
    const idCandidates = [
      ...(row.attributes?.[Symbol.iterator] ? [row] : []),
      ...row.querySelectorAll('[data-id], [data-jid]'),
      row.parentElement,
    ].filter(Boolean);
    for (const el of idCandidates) {
      const v = el.getAttribute?.('data-id') || el.getAttribute?.('data-jid');
      if (looksLikeJid(v)) { jid = v; break; }
    }
    const previewEl = [...row.querySelectorAll('span[dir="auto"]')]
      .find(s => s !== titleEl);
    const preview = (previewEl?.innerText || '').slice(0, 200).trim();
    // WA Web flags unread via aria-label="<N> unread message[s]" on a
    // span inside the row, OR (older builds) data-icon="unread-count".
    // Either is enough — we don't need to read the count.
    const unread = !!(
      row.querySelector('span[aria-label*="unread" i]') ||
      row.querySelector('[data-icon="unread-count"]')
    );
    return { jid, name, preview, unread };
  }

  // Scrape the WA Web chat list panel. Returns an ordered list of
  // visible chats (top-to-bottom — usually most-recent first).
  // Heuristic selectors; pin updates here when WA Web reships.
  function scrapeChatList(limit = 20) {
    const panel = chatListPanel();
    if (!panel) return [];
    const rows = panel.querySelectorAll('[role="listitem"], div[role="row"]');
    const chats = [];
    for (const row of rows) {
      const r = extractRow(row);
      if (!r) continue;
      chats.push({ jid: r.jid, name: r.name, preview: r.preview });
      if (chats.length >= limit) break;
    }
    return chats;
  }

  function connect() {
    try { port = chrome.runtime.connect({ name: 'egpt-wa-content' }); }
    catch { return setTimeout(connect, 1000); }
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      // Request/response for /channels listing — background forwards
      // a 'list-channels' from the subscriber, we scrape and reply.
      if (msg.type === 'list-channels') {
        const chats = scrapeChatList(msg.limit ?? 20);
        safePost({ type: 'channels-list', requestId: msg.requestId, chats });
      }
    });
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
    const raw = h?.getAttribute('title') || h?.innerText || '';
    // First-line + whitespace-collapse, matching the title comparison in
    // background.js sendToFirstWaTab. Some headers carry "last seen…"
    // affordances on a second line; without normalization, replyTo
    // would carry that string and ensureActiveChat would never match a
    // chat-list row (whose title is just the chat name).
    const norm = raw.split('\n')[0].replace(/\s+/g, ' ').trim();
    return norm || null;
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

  // ── Auto-focus on wake-word notifications ──────────────────────
  //
  // WA Web only mounts message DOM for the focused chat. Without
  // this, a phone-typed '@e foo' lands in chat A but sits in the
  // chat-list as just an unread badge — the MutationObserver above
  // sees nothing until the user manually opens A.
  //
  // Strategy: poll the chat list for unread rows whose preview text
  // matches the wake-word (@e / @egpt), and request that background
  // CDP-click the row to open it. Background does the actual click
  // because synthetic events don't switch chats (event.isTrusted).
  //
  // Defers when the user is mid-compose in the WA Web tab — yanking
  // their focus mid-keystroke would be hostile. We wait until the
  // composer is empty / unfocused, then proceed. The unread badge
  // persists until WA reads the message, so deferring loses nothing.
  const WAKE_RE = /^@(egpt|e)\b/i;
  const _autoOpenedAt = new Map();   // key (jid|name) → ms
  const AUTO_OPEN_DEDUPE_MS = 10_000;
  const AUTO_OPEN_INTERVAL_MS = 1_500;

  function findComposer() {
    return document.querySelector('div[contenteditable="true"][data-tab="10"]')
        || document.querySelector('footer div[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"][role="textbox"]');
  }
  function userIsComposing() {
    const c = findComposer();
    if (!c) return false;
    if (document.activeElement !== c) return false;
    return ((c.innerText || '').trim().length > 0);
  }

  function autoOpenScan() {
    if (userIsComposing()) return;
    const panel = chatListPanel();
    if (!panel) return;
    const rows = panel.querySelectorAll('[role="listitem"], div[role="row"]');
    for (const row of rows) {
      const r = extractRow(row);
      if (!r || !r.unread) continue;
      if (!WAKE_RE.test(r.preview)) continue;
      const key = r.jid || r.name;
      if (!key) continue;
      const last = _autoOpenedAt.get(key) ?? 0;
      if (Date.now() - last < AUTO_OPEN_DEDUPE_MS) continue;
      _autoOpenedAt.set(key, Date.now());
      safePost({ type: 'open-chat', chatJid: r.jid, chatName: r.name });
    }
  }
  setInterval(autoOpenScan, AUTO_OPEN_INTERVAL_MS);

  connect();
})();
