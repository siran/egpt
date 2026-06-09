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
  let _ws = null, _nextId = 1, _pending = new Map(), _eventsSeen = 0, _notifTimer = null;
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
    _notifTimer = setInterval(async () => {
      const evs = await _eval(`window.__egptEvents ? window.__egptEvents.slice(${_eventsSeen}) : []`);
      if (!Array.isArray(evs) || !evs.length) return;
      _eventsSeen += evs.length;
      for (const e of evs) if (e.kind === 'message') { try { cb({ chatName: e.chatName, jid: e.jid, preview: e.preview, ts: e.t }); } catch (err) { log(`wa-dom: onNewMessage cb threw — ${err?.message ?? err}`); } }
    }, intervalMs);
    _notifTimer.unref?.();
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
    const rect = await _eval(`(() => {
      const want = ${JSON.stringify(want)};
      const t = [...document.querySelectorAll('#pane-side span[title]')].find(s => s.getAttribute('title') === want);
      if (!t) return null;
      const cell = t.closest('[data-testid="cell-frame-container"]') || t.closest('[role="row"]') || t;
      cell.scrollIntoView({ block: 'center' });
      const r = cell.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!rect) { log(`wa-dom: openChatByName("${want}") — not found in (rendered) list`); return false; }
    await _send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await _send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await _send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    for (let i = 0; i < 24; i++) {
      await _sleep(250);
      const title = await openChatTitle();
      if (title && title.includes(want.slice(0, 14))) return true;
    }
    log(`wa-dom: openChatByName("${want}") — clicked but header didn't confirm (title="${await openChatTitle()}")`);
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

  function stop() { if (_notifTimer) clearInterval(_notifTimer); try { _ws?.close(); } catch {} _ws = null; }

  return { attach, isLoggedIn, isAlive, bringToFront, onNewMessage, openChatByName, readLatest, sendText, openChatTitle, stop };
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
