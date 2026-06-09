// wa-notif-spike.mjs — afferent-trigger spike (operator 2026-06-08). Installs
// THREE sensors before WA boots and reports which one catches a new message
// while the tab is backgrounded:
//   1) page-level window.Notification constructor
//   2) ServiceWorkerRegistration.showNotification (page-side proto)
//   3) MutationObserver on #pane-side (unread badge) — mechanism-agnostic
// Read-only (no sends). Reloads the WA tab once, then prints captured events
// live for ~120s. DURING that window: background the WA tab and send yourself a
// WhatsApp message from your phone.
//   node tests-manual/wa-notif-spike.mjs
import WebSocket from 'ws';
import http from 'node:http';
const PORT = Number(process.env.CDP_PORT || 9221);
const WATCH_SECONDS = Number(process.env.WATCH || 120);
const listTargets = () => new Promise((res, rej) => { http.get(`http://127.0.0.1:${PORT}/json/list`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:1e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const evaluate=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.result?.result?.value;};return{send,ready,evaluate};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const HOOK = `(() => {
  if (window.__egptHookInstalled) return;
  window.__egptHookInstalled = true;
  window.__egptEvents = [];
  const log = (kind, data) => { try { window.__egptEvents.push(Object.assign({ t: Date.now(), kind }, data || {})); } catch (e) {} };
  // 1) page Notification constructor
  try {
    const Real = window.Notification;
    if (Real) {
      const W = function (title, opts) { log('Notification', { title: String(title), body: opts && opts.body, tag: opts && opts.tag }); return new Real(title, opts); };
      try { W.requestPermission = Real.requestPermission && Real.requestPermission.bind(Real); } catch (e) {}
      try { Object.defineProperty(W, 'permission', { get: () => Real.permission }); } catch (e) {}
      Object.setPrototypeOf(W, Real);
      Object.defineProperty(window, 'Notification', { value: W, configurable: true, writable: true });
      log('installed', { sensor: 'Notification', perm: Real.permission });
    }
  } catch (e) { log('hookErr', { where: 'Notification', e: String(e) }); }
  // 2) ServiceWorkerRegistration.showNotification (page proto)
  try {
    const SWR = window.ServiceWorkerRegistration;
    if (SWR && SWR.prototype && SWR.prototype.showNotification) {
      const real = SWR.prototype.showNotification;
      SWR.prototype.showNotification = function (title, opts) { log('SWShowNotification', { title: String(title), body: opts && opts.body, tag: opts && opts.tag }); return real.apply(this, arguments); };
      log('installed', { sensor: 'SWShowNotification' });
    }
  } catch (e) { log('hookErr', { where: 'SW', e: String(e) }); }
  // 3) MutationObserver on chat list (unread badge) — fires regardless of notif mechanism
  try {
    let lastSig = '';
    const snapshot = () => {
      const badges = [...document.querySelectorAll('[data-testid="icon-unread-count"]')];
      return badges.map(b => {
        const cell = b.closest('[data-testid="cell-frame-container"]');
        const title = cell ? (cell.querySelector('[data-testid="cell-frame-title"] span[title], span[title]') || {}).getAttribute && cell.querySelector('span[title]').getAttribute('title') : null;
        return (title || '?') + ':' + b.innerText;
      }).join('|');
    };
    const tick = () => {
      const sig = snapshot();
      if (sig !== lastSig) { log('unreadChange', { from: lastSig, to: sig }); lastSig = sig; }
    };
    const start = () => {
      const pane = document.querySelector('#pane-side');
      if (!pane) { setTimeout(start, 1000); return; }
      lastSig = snapshot();
      new MutationObserver(() => tick()).observe(pane, { childList: true, subtree: true, characterData: true });
      log('installed', { sensor: 'MutationObserver', initialUnread: lastSig });
    };
    start();
  } catch (e) { log('hookErr', { where: 'MO', e: String(e) }); }
})()`;

(async () => {
  const wa = (await listTargets()).find(t => t.type==='page' && /web\.whatsapp\.com/.test(t.url||''));
  if (!wa) { console.log('No WA tab.'); process.exit(1); }
  const cdp = connect(wa.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  console.log('1) installing 3 sensors for next document…');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  console.log('2) reloading WA tab…');
  await cdp.send('Page.reload', {});

  console.log('3) waiting for app + sensors…');
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const ev = await cdp.evaluate(`window.__egptEvents ? window.__egptEvents.filter(e=>e.kind==='installed') : null`);
    if (Array.isArray(ev) && ev.length) { console.log('   sensors installed:', JSON.stringify(ev)); break; }
  }

  console.log(`\n>>> NOW: background the WA tab (focus another window / minimize Chrome) and send yourself a WhatsApp message from your phone. Watching ${WATCH_SECONDS}s… <<<\n`);
  let seen = 0;
  const until = Date.now() + WATCH_SECONDS * 1000;
  while (Date.now() < until) {
    await sleep(2000);
    const evs = await cdp.evaluate(`window.__egptEvents ? window.__egptEvents.slice(${seen}) : []`);
    if (Array.isArray(evs) && evs.length) {
      for (const e of evs) console.log(`   [+${Math.round((e.t - (until - WATCH_SECONDS*1000))/1000)}s] ${e.kind}`, JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k])=>!['t','kind'].includes(k)))));
      seen += evs.length;
    }
  }
  console.log('\n── done watching. Which sensor(s) fired above is our afferent nerve. ──');
  process.exit(0);
})().catch(e => { console.error('spike error:', e?.message ?? e); process.exit(1); });
