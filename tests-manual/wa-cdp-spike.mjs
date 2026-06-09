// wa-cdp-spike.mjs — THROWAWAY recon (operator 2026-06-08). Measures whether
// WhatsApp Web's internal Store is reachable for read+send over CDP in the
// CURRENT bundle, inside egpt's already-running Chrome. No spine changes; no
// commit. Sends (if any) go ONLY to the Self / note-to-self chat.
//
//   node tests-manual/wa-cdp-spike.mjs            # phase 1: recon only
//   node tests-manual/wa-cdp-spike.mjs --send     # phase 2: also send to Self
//
// Talks raw CDP to 127.0.0.1:9221 (the port operator launched Chrome on).
import WebSocket from 'ws';
import http from 'node:http';

const PORT = Number(process.env.CDP_PORT || 9221);
const DO_SEND = process.argv.includes('--send');

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Minimal CDP client over the page's webSocketDebuggerUrl.
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 100 * 1024 * 1024 });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve); ws.on('error', reject);
  });
  // Evaluate an expression in the page, await promises, return by value.
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.result?.exceptionDetails || r.error) {
      return { __evalError: r.error?.message || r.result?.exceptionDetails?.exception?.description || 'eval error' };
    }
    return r.result?.result?.value;
  };
  return { ws, ready, send, evaluate };
}

// ── The injected recon. Self-contained; returns a plain JSON-able report. ──
// moduleRaid-lite: grab webpack's require off the chunk array, enumerate
// modules, and look for the Store pieces a read/send roundtrip needs.
const RECON_FN = `(async () => {
  const out = { ts: Date.now() };
  try { out.version = window.Debug && window.Debug.VERSION; } catch (e) {}
  out.loggedIn = !!document.querySelector('#pane-side');
  out.qrPresent = !!document.querySelector('[data-ref], canvas[aria-label]');
  const chunkKey = Object.keys(self).find(k => k.startsWith('webpackChunkwhatsapp_web_client'))
    || (self.webpackChunkwhatsapp_web_client ? 'webpackChunkwhatsapp_web_client' : null);
  out.webpackChunkKey = chunkKey || null;
  if (!chunkKey) { out.store = 'NO_WEBPACK_CHUNK'; return out; }
  const arr = self[chunkKey];
  out.chunkIsArray = Array.isArray(arr);
  out.pushIsNative = arr && arr.push === Array.prototype.push;
  // moduleRaid (capture-module form): register a module whose factory captures
  // the real __webpack_require__, and a runtime cb that forces it to load.
  let cap, cbFired = false, reqTagErr = null;
  const tag = 'egptSpike' + Date.now();
  try {
    arr.push([[tag], { [tag]: (mod, exp, req) => { cap = req; } }, (req) => { cbFired = true; try { req(tag); } catch (e) { reqTagErr = e.message; } }]);
  } catch (e) { out.store = 'PUSH_THREW: ' + e.message; return out; }
  await new Promise(r => setTimeout(r, 150));
  out.cbFired = cbFired; out.reqTagErr = reqTagErr; out.capType = typeof cap;
  const require = cap;
  if (!require) { out.store = 'NO_REQUIRE_AFTER_WAIT'; return out; }
  out.requireKeys = Object.keys(require).slice(0, 30);
  out.hasM = !!require.m; out.mCount = require.m ? Object.keys(require.m).length : 0;
  out.hasC = !!require.c; out.cCount = require.c ? Object.keys(require.c).length : 0;
  const modSource = require.m ? require.m : (require.c ? require.c : null);
  if (!modSource) { out.store = 'NO_MODULE_SOURCE'; return out; }
  const ids = Object.keys(modSource);
  out.moduleCount = ids.length;
  const usingCache = !require.m;
  const mods = [];
  for (const id of ids) {
    try { mods.push(usingCache ? modSource[id] && modSource[id].exports : require(id)); } catch (e) { /* skip */ }
  }
  const findExport = (pred) => {
    for (const m of mods) {
      if (!m) continue;
      try { if (pred(m)) return true; const d = m.default; if (d && pred(d)) return true; } catch (e) {}
    }
    return false;
  };
  out.found = {
    ChatCollection:  findExport(m => m.Chat && (m.Chat.find || m.Chat.modelType === 'Chat')),
    Msg:             findExport(m => m.Msg && (m.Msg.find || m.Msg.modelType)),
    sendTextMsg:     findExport(m => typeof m.sendTextMsgToChat === 'function' || typeof m.addAndSendMsgToChat === 'function'),
    WidFactory:      findExport(m => typeof m.createWid === 'function' || typeof m.createUserWid === 'function'),
    Conn:            findExport(m => m.Conn && (m.Conn.wid || m.Conn.me)),
    UserPrefs:       findExport(m => typeof m.getMaybeMeUser === 'function' || typeof m.getMe === 'function'),
  };
  out.store = Object.values(out.found).some(Boolean) ? 'PARTIAL_OR_OK' : 'NO_STORE_MODULES';
  return out;
})()`;

const DOM_RECON_FN = `(() => {
  const out = {};
  const main = document.querySelector('#main');
  out.hasMain = !!main;                       // #main exists only when a chat is open
  out.paneSide = !!document.querySelector('#pane-side');
  out.chatListItems = document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]').length;
  out.composerPresent = !!document.querySelector('footer div[contenteditable="true"], div[contenteditable="true"][data-tab]');
  if (main) {
    const ins = main.querySelectorAll('.message-in');
    const last = ins[ins.length - 1];
    out.incomingRows = ins.length;
    out.lastIncomingText = last ? (last.querySelector('.selectable-text') || last).innerText.slice(0, 100) : null;
    const ppt = last ? last.querySelector('[data-pre-plain-text]') : null;
    out.lastIncomingMeta = ppt ? ppt.getAttribute('data-pre-plain-text') : null;
    const hdr = main.querySelector('header');
    out.openChatTitle = hdr ? hdr.innerText.replace(/\\n/g, ' ').slice(0, 60) : null;
  }
  return out;
})()`;

(async () => {
  const targets = await listTargets();
  const wa = targets.find(t => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''));
  if (!wa) { console.log('No WhatsApp Web page found on CDP. Open web.whatsapp.com in that Chrome.'); process.exit(1); }
  console.log(`WA tab: ${wa.title} | ${wa.id}`);
  const cdp = connect(wa.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  console.log('\n── PHASE 1: Store recon ──');
  const recon = await cdp.evaluate(RECON_FN);
  console.log(JSON.stringify(recon, null, 2));

  console.log('\n── PHASE 1b: DOM recon (fallback pulse) ──');
  const dom = await cdp.evaluate(DOM_RECON_FN);
  console.log(JSON.stringify(dom, null, 2));

  if (!DO_SEND) {
    console.log('\n(recon only — re-run with --send to attempt a Self roundtrip)');
    process.exit(0);
  }
  // PHASE 2 is intentionally NOT written yet — it depends on what PHASE 1
  // reports about which Store pieces exist. We build read+send against the
  // ACTUAL found surface, not a guessed one.
  console.log('\n── PHASE 2: send — not implemented until recon tells us the Store shape ──');
  process.exit(0);
})().catch(e => { console.error('spike error:', e?.message ?? e); process.exit(1); });
