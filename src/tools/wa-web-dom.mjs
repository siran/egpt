// wa-web-dom.mjs — the QUARANTINED WhatsApp-Web-over-CDP anchor layer.
//
// EVERYTHING WhatsApp-Web-specific lives here: the CDP connection, the injected
// notification hook, and the DOM operations — all keyed on DURABLE human/
// semantic anchors (data-testid / title / data-pre-plain-text / data-id /
// data-icon / aria-label), NEVER the obfuscated CSS hash classes. WhatsApp
// reshuffles its bundle constantly; when it does, the fix is in THIS one file.
// The rest of egpt sees only the clean methods below — no jid/DOM leakage.
//
// Validated against WA Web 2.3000.x (2026-06-08): see docs/wa-cdp-glove-scope.md.
//
// Run directly for a read-only self-test:
//   node src/tools/wa-web-dom.mjs                 # watch notifications → open → read (no sends)
//   node src/tools/wa-web-dom.mjs --send-self     # also send one line to Self
import WebSocket from 'ws';
import http from 'node:http';
import { readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Where WA Web's Download-action writes decrypted voice notes (set via CDP
// Page.setDownloadBehavior at attach). The only way to get the decrypted audio:
// WA decodes Opus in a WASM/AudioWorklet the page can't hook, but its own
// "Download" menu writes the plaintext .ogg (validated 2026-06-09).
const DOWNLOAD_DIR = join(homedir(), '.egpt', 'wa-downloads');
try { mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch { /* ignore */ }

// ── Injected sensor hook (document-start AND live). Captures WA's page-level
// Notification calls into window.__egptEvents. Idempotent. (Confirmed
// 2026-06-08: WA uses window.Notification, NOT the service worker; the event's
// tag is the chat JID, title is the chat name, body is "Sender: preview".) A
// MutationObserver on the chat list provides a mechanism-agnostic backup.
const SENSOR_HOOK = `(() => {
  if (window.__egptHookInstalled) return 'already';
  window.__egptHookInstalled = true;
  window.__egptEvents = [];
  const log = (kind, d) => { try { window.__egptEvents.push(Object.assign({ t: Date.now(), kind }, d || {})); } catch (e) {} };
  try {
    const Real = window.Notification;
    if (Real) {
      const W = function (title, opts) { log('message', { chatName: String(title), preview: opts && opts.body, jid: opts && opts.tag }); return new Real(title, opts); };
      try { W.requestPermission = Real.requestPermission && Real.requestPermission.bind(Real); } catch (e) {}
      try { Object.defineProperty(W, 'permission', { get: () => Real.permission }); } catch (e) {}
      Object.setPrototypeOf(W, Real);
      Object.defineProperty(window, 'Notification', { value: W, configurable: true, writable: true });
    }
  } catch (e) { log('hookErr', { where: 'Notification', e: String(e) }); }
  return 'installed';
})()`;

export function createWaWebDom({ port = 9221, host = '127.0.0.1', log = () => {} } = {}) {
  let _ws = null, _nextId = 1, _pending = new Map(), _notifTimer = null, _watchTimer = null;
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const _listTargets = () => new Promise((res, rej) => {
    http.get(`http://${host}:${port}/json/list`, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
  const _send = (method, params = {}) => new Promise((resolve, reject) => {
    if (!_ws) return reject(new Error('not attached'));
    const id = _nextId++;
    _pending.set(id, resolve);
    _ws.send(JSON.stringify({ id, method, params }));
  });
  // Evaluate an expression in the page; returns the by-value result (or undefined on error).
  const _eval = async (expression) => {
    const r = await _send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) { log(`wa-dom: eval threw — ${r.result.exceptionDetails.exception?.description?.slice(0, 120)}`); return undefined; }
    return r.result?.result?.value;
  };

  async function attach() {
    const wa = (await _listTargets()).find(t => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''));
    if (!wa) throw new Error('no WhatsApp Web tab found on CDP — open web.whatsapp.com in the egpt Chrome');
    await new Promise((resolve, reject) => {
      _ws = new WebSocket(wa.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 });
      _ws.on('open', resolve); _ws.on('error', reject);
      _ws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } if (m.id && _pending.has(m.id)) { _pending.get(m.id)(m); _pending.delete(m.id); } });
    });
    await _send('Page.enable'); await _send('Runtime.enable');
    // Direct WA's "Download" action to our capture folder (voice-note extraction).
    try { await _send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR }); } catch { /* older CDP */ }
    // Persist for future (re)loads + install live so we catch messages now.
    await _send('Page.addScriptToEvaluateOnNewDocument', { source: SENSOR_HOOK });
    const live = await _eval(SENSOR_HOOK);
    const loggedIn = await isLoggedIn();
    log(`wa-dom: attached (sensor=${live}, loggedIn=${loggedIn})`);
    return { ok: true, loggedIn };
  }

  async function isLoggedIn() { return !!(await _eval(`!!document.querySelector('#pane-side')`)); }
  async function isAlive() { return !!_ws && _ws.readyState === 1 && await isLoggedIn(); }
  async function bringToFront() { try { await _send('Page.bringToFront'); } catch (e) {} }

  // Poll the injected event queue; deliver new 'message' events to cb.
  // cb({ chatName, jid, preview, ts }). WA only fires these when the tab is not
  // focused — exactly when egpt should attend.
  function onNewMessage(cb, { intervalMs = 1500 } = {}) {
    if (_notifTimer) clearInterval(_notifTimer);
    // Deliver by TIMESTAMP, not count: only message events that arrive AFTER
    // this registration (e.t > since). The page hook's __egptEvents persists
    // across restarts (we never reload), so a count-based prime races with a
    // message landing during the first poll interval — timestamp gating is
    // race-free and skips history cleanly. Dedup by jid+t. (page Date.now()
    // and node Date.now() share the same system clock — directly comparable.)
    const since = Date.now();
    const _delivered = new Set();
    _notifTimer = setInterval(async () => {
      const evs = await _eval(`window.__egptEvents ? window.__egptEvents.filter(e => e.kind === 'message' && e.t > ${since}) : []`);
      if (!Array.isArray(evs) || !evs.length) return;
      for (const e of evs) {
        const key = `${e.jid || ''}|${e.t}`;
        if (_delivered.has(key)) continue;
        _delivered.add(key);
        try { cb({ chatName: e.chatName, jid: e.jid, preview: e.preview, ts: e.t }); } catch (err) { log(`wa-dom: onNewMessage cb threw — ${err?.message ?? err}`); }
      }
    }, intervalMs);
    _notifTimer.unref?.();
  }

  // DOM WATCHER (primary afferent — does NOT depend on notifications, which
  // are focus-gated/OS-gated and the operator turns off). Polls the chat list
  // for a chat whose UNREAD badge appeared or increased = new incoming
  // message(s). With the renderer kept alive by the launch flags, the list
  // updates even when the window is unfocused, so this fires regardless of
  // focus. cb({ chatName, preview, unread }). A chat egpt opens to read gets
  // marked read (unread→0); a fresh message re-raises the badge → re-fires.
  // (Misses a message that lands while that exact chat is open+focused — it's
  // auto-read, no badge — which is fine: egpt isn't sitting inside chats.)
  function watchChatList(cb, { intervalMs = 2500 } = {}) {
    if (_watchTimer) clearInterval(_watchTimer);
    const _prev = new Map();   // chatName -> last signature (unread|preview)
    let primed = false, _busy = false;
    _watchTimer = setInterval(async () => {
      if (_busy) return;   // SERIALIZE: a slow callback (download+transcribe ~25s)
      _busy = true;        // must finish before the next scan, else concurrent
      try {                // chat-opens close each other's menus / corrupt state.
        const rows = await _eval(`(() => {
          const pane = document.querySelector('#pane-side'); if (!pane) return [];
          // Keep the most-recent chats (top) rendered regardless of scroll —
          // WA virtualizes, and a chat scrolled out of view is invisible to us.
          const list = pane.querySelector('[data-testid="chat-list"]') || pane.querySelector('[role="grid"]');
          let sc = list; while (sc && sc.scrollHeight <= sc.clientHeight + 10 && sc !== pane) sc = sc.parentElement;
          if (sc && sc.scrollTop > 0) sc.scrollTop = 0;
          // Include the Self note-to-self row: it's [data-testid="message-yourself-row"],
          // NOT a cell-frame-container — so the old selector silently dropped it
          // and Self was never watched (operator 2026-06-09).
          return [...pane.querySelectorAll('[data-testid="cell-frame-container"], [data-testid="message-yourself-row"]')].map(c => {
            const t = c.querySelector('[data-testid="cell-frame-title"] span[title]') || c.querySelector('span[title]');
            const badge = c.querySelector('[data-testid="icon-unread-count"]');
            // Full secondary text (NOT just span[title]) so a voice note (mic +
            // duration, no span[title], no unread on your own Self msg) still
            // changes the signature. Strip HH:MM so a per-minute clock tick in
            // the row innerText fallback can't false-fire (→ re-download loops).
            const sec = c.querySelector('[data-testid="cell-frame-secondary"]');
            let preview = (sec ? sec.innerText : c.innerText) || '';
            preview = preview.replace(/\\b\\d{1,2}:\\d{2}\\b/g, '').replace(/\\s+/g, ' ').trim().slice(0, 80);
            return { name: t ? t.getAttribute('title') : null, unread: badge ? (parseInt(badge.innerText, 10) || 0) : 0, preview };
          }).filter(r => r.name);
        })()`);
        if (!Array.isArray(rows)) return;
        // Collect changed chats first (signature = unread|preview), update the
        // baseline, THEN process them one at a time (awaited). Fires on ANY
        // chat-list activity so a message in the OPEN chat (auto-read → no
        // badge) is still caught; the host gate filters non-@e.
        const changed = [];
        for (const r of rows) {
          const sig = `${r.unread}|${r.preview ?? ''}`;
          const was = _prev.get(r.name);
          _prev.set(r.name, sig);
          if (primed && was !== undefined && sig !== was) changed.push(r);
        }
        primed = true;
        for (const r of changed) {
          try { await cb({ chatName: r.name, preview: r.preview, unread: r.unread }); }
          catch (err) { log(`wa-dom: watch cb threw — ${err?.message ?? err}`); }
        }
      } finally { _busy = false; }
    }, intervalMs);
    _watchTimer.unref?.();
    log('wa-dom: chat-list watcher started (unread-badge scan; no notifications needed)');
  }

  // Open a chat by the NAME a human reads (the notification's title). WA Web
  // virtualizes — only the open chat renders — so this is how we make a chat's
  // messages readable. The chat-list row is a [role=row]/gridcell with NO
  // role=button; a synthetic .click() on it does NOT navigate. So we do a REAL
  // mouse click at the row's coordinates (CDP Input.dispatchMouseEvent) —
  // human-like and triggers WA's handlers. Returns true once #main shows that
  // chat (header includes the name).
  async function openChatByName(name) {
    await bringToFront();
    const want = String(name || '');
    // Retry across the list settling — right after a notification the chat
    // reorders/scrolls, so the row may not be rendered at the exact instant we
    // look (observed 2026-06-08: a too-eager search returned not-found, then
    // succeeded a beat later).
    for (let attempt = 0; attempt < 4; attempt++) {
      const rect = await _eval(`(() => {
        const want = ${JSON.stringify(want)};
        const t = [...document.querySelectorAll('#pane-side [data-testid="cell-frame-title"] span[title], #pane-side span[title]')].find(s => s.getAttribute('title') === want);
        if (!t) return null;
        const cell = t.closest('[data-testid="cell-frame-container"]') || t.closest('[data-testid="message-yourself-row"]') || t.closest('[role="row"]') || t;
        cell.scrollIntoView({ block: 'center' });
        const r = cell.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!rect) { await _sleep(400); continue; }   // not rendered yet — let the list settle
      await _sleep(120);   // let scrollIntoView settle before clicking the coords
      await _send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await _send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await _send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 16; i++) {
        await _sleep(250);
        const title = await openChatTitle();
        if (title && title.includes(want.slice(0, 14))) return true;
      }
      log(`wa-dom: openChatByName("${want}") — attempt ${attempt + 1} clicked but header didn't confirm`);
    }
    log(`wa-dom: openChatByName("${want}") — gave up after retries (not found / no nav)`);
    return false;
  }

  // Read the last n messages of the OPEN chat via the durable anchor
  // [data-pre-plain-text] ("[HH:MM, M/D/YYYY] Sender: ") + .selectable-text.
  // Returns [{ sender, ts, text }] oldest→newest. (No fromMe needed on the
  // afferent path — WA only NOTIFIES incoming messages, never our own sends;
  // and we know our own sends because we drive them. The obfuscated
  // message-in/out classes and a reachable per-message id are not used.)
  async function readLatest(n = 3) {
    return await _eval(`(() => {
      const main = document.querySelector('#main'); if (!main) return [];
      const ppts = [...main.querySelectorAll('[data-pre-plain-text]')].slice(-${Math.max(1, n)});
      return ppts.map(p => {
        const meta = p.getAttribute('data-pre-plain-text') || '';
        const m = meta.match(/^\\[(.*?)\\]\\s*(.*?):\\s*$/);
        const textEl = p.querySelector('.selectable-text') || p;
        return { sender: m ? m[2] : null, ts: m ? m[1] : null, text: textEl ? textEl.innerText : null };
      });
    })()`) ?? [];
  }

  // What kind is the BOTTOMMOST (latest) message in the open chat? 'text'
  // (has a [data-pre-plain-text]) | 'voice' (a "Play voice message" button) |
  // 'other'. Used to decide whether to transcribe.
  async function latestKind() {
    return await _eval(`(() => {
      const main = document.querySelector('#main'); if (!main) return 'none';
      const marks = [...main.querySelectorAll('[data-pre-plain-text], [aria-label="Play voice message"]')];
      const last = marks[marks.length - 1]; if (!last) return 'none';
      return last.getAttribute('aria-label') === 'Play voice message' ? 'voice' : 'text';
    })()`) ?? 'none';
  }

  // Download the LATEST voice note in the open chat via WA's Download menu
  // (right-click the bubble → Download). Returns the captured .ogg path or null.
  async function downloadLatestVoiceNote() {
    await bringToFront();
    const before = new Set(readdirSync(DOWNLOAD_DIR));
    const bubble = await _eval(`(() => {
      const main = document.querySelector('#main'); if (!main) return null;
      const play = [...main.querySelectorAll('[aria-label="Play voice message"]')].pop(); if (!play) return null;
      const row = play.closest('[data-id]') || play.closest('[role="row"]') || play.parentElement.parentElement;
      row.scrollIntoView({ block: 'center' });
      const r = row.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!bubble) { log('wa-dom: downloadLatestVoiceNote — no voice note in open chat'); return null; }
    // right-click → WA message context menu
    await _send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bubble.x, y: bubble.y });
    await _send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bubble.x, y: bubble.y, button: 'right', clickCount: 1 });
    await _send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bubble.x, y: bubble.y, button: 'right', clickCount: 1 });
    await _sleep(700);
    const dl = await _eval(`(() => {
      const d = [...document.querySelectorAll('[role="menuitem"], li, div[role="button"]')].find(e => /^download$/i.test((e.innerText||'').trim()));
      if (!d) return null; const r = d.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!dl) { log('wa-dom: downloadLatestVoiceNote — no Download in menu'); try { await _send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); } catch {} return null; }
    await _send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dl.x, y: dl.y, button: 'left', clickCount: 1 });
    await _send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dl.x, y: dl.y, button: 'left', clickCount: 1 });
    for (let i = 0; i < 24; i++) {
      await _sleep(400);
      const news = readdirSync(DOWNLOAD_DIR).filter(f => !before.has(f) && !f.endsWith('.crdownload'));
      if (news.length) { const p = join(DOWNLOAD_DIR, news[0]); log(`wa-dom: voice note downloaded → ${news[0]}`); return p; }
    }
    log('wa-dom: downloadLatestVoiceNote — download did not appear'); return null;
  }

  // Type + click the Send button (Enter is ignored by WA's Lexical composer).
  // Returns { ok }. Caller is responsible for having the intended chat open.
  async function sendText(text) {
    await bringToFront();
    const focused = await _eval(`(() => { const c = document.querySelector('#main footer div[contenteditable="true"]'); if (!c) return false; c.focus(); return true; })()`);
    if (!focused) { log('wa-dom: sendText — no composer (no chat open?)'); return { ok: false }; }
    await new Promise(r => setTimeout(r, 150));
    await _send('Input.insertText', { text: String(text) });
    await new Promise(r => setTimeout(r, 400));
    const clicked = await _eval(`(() => {
      const icon = document.querySelector('#main footer [data-icon="send"], #main footer [data-icon="wds-ic-send-filled"]');
      const aria = [...document.querySelectorAll('#main footer button[aria-label]')].find(b => /send|enviar/i.test(b.getAttribute('aria-label') || ''));
      const target = (icon && (icon.closest('button') || icon)) || aria;
      if (!target) return false; target.click(); return true;
    })()`);
    if (!clicked) { log('wa-dom: sendText — send button not found'); return { ok: false }; }
    await new Promise(r => setTimeout(r, 800));
    return { ok: true };
  }

  // The header title of the currently open chat (for safety checks).
  async function openChatTitle() { return await _eval(`(() => { const h = document.querySelector('#main header'); return h ? h.innerText.replace(/\\n/g, ' ').slice(0, 60) : null; })()`); }

  function stop() { if (_notifTimer) clearInterval(_notifTimer); if (_watchTimer) clearInterval(_watchTimer); try { _ws?.close(); } catch {} _ws = null; }

  return { attach, isLoggedIn, isAlive, bringToFront, onNewMessage, watchChatList, openChatByName, readLatest, latestKind, downloadLatestVoiceNote, sendText, openChatTitle, stop };
}

// ── read-only self-test ─────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('wa-web-dom.mjs')) {
  const wa = createWaWebDom({ log: (m) => console.log(m) });
  const SEND_SELF = process.argv.includes('--send-self');
  const SELF = process.env.SELF_NUMBER || '16468217865';
  (async () => {
    await wa.attach();
    console.log(`open chat: "${await wa.openChatTitle()}"`);
    console.log('latest in open chat:', JSON.stringify(await wa.readLatest(3), null, 2));

    if (SEND_SELF) {
      console.log('\nopening Self by name + sending one line…');
      // Self appears in the list as "(You)" / your number; open by exact title is unreliable, so use the send URL via navigate is out of scope here — instead require Self already open. Safety: only send if header looks like Self.
      const title = await wa.openChatTitle();
      if (/\(You\)|Message yourself|646/i.test(title || '')) {
        const r = await wa.sendText('egpt wa-web-dom selftest ' + new Date().toISOString().slice(11, 19));
        console.log('sendText →', JSON.stringify(r));
      } else {
        console.log(`SKIP send: open chat "${title}" is not Self — open your Self chat first.`);
      }
    }

    console.log('\nwatching notifications 120s — send yourself a msg from ANOTHER contact (tab backgrounded). Each → open + read (READ-ONLY):');
    wa.onNewMessage(async (m) => {
      console.log(`\n📨 ${m.chatName}  <${m.jid}>  "${m.preview}"`);
      const opened = await wa.openChatByName(m.chatName);
      if (opened) console.log('   read:', JSON.stringify(await wa.readLatest(2)));
      else console.log('   (could not open by name)');
    });
    await new Promise(r => setTimeout(r, 120000));
    wa.stop();
    console.log('\n── selftest done ──');
    process.exit(0);
  })().catch(e => { console.error('selftest error:', e?.message ?? e); process.exit(1); });
}
