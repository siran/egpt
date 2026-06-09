// wa-dom-probe.mjs — anchor recon (operator 2026-06-08). Finds the DURABLE,
// human-facing DOM anchors (data-icon / aria-label / data-testid / title /
// data-id / data-pre-plain-text), not the obfuscated CSS classes. Read-only:
// reports what it finds so we click the RIGHT thing next. No sends.
//   node tests-manual/wa-dom-probe.mjs
import WebSocket from 'ws';
import http from 'node:http';
const PORT = Number(process.env.CDP_PORT || 9221);
const listTargets = () => new Promise((res, rej) => { http.get(`http://127.0.0.1:${PORT}/json/list`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:1e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const evaluate=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;};return{send,ready,evaluate};}

const RECON = `(() => {
  const out = {};
  // ── chat list: names humans read (title=), plus stable testids ──
  const pane = document.querySelector('#pane-side');
  if (pane) {
    out.chatTitles = [...pane.querySelectorAll('span[title]')].map(s=>s.getAttribute('title')).filter(Boolean).slice(0,8);
    const tids = new Set(); pane.querySelectorAll('[data-testid]').forEach(e=>tids.add(e.getAttribute('data-testid')));
    out.paneTestIds = [...tids].slice(0,25);
  }
  // ── composer + SEND control (the thing Enter failed to trigger) ──
  const composer = document.querySelector('footer div[contenteditable="true"], div[contenteditable="true"][data-tab]');
  out.composerPresent = !!composer;
  const footer = document.querySelector('footer') || (composer && composer.closest('footer'));
  if (footer) {
    out.footerButtons = [...footer.querySelectorAll('button')].map(b=>({
      aria: b.getAttribute('aria-label'), testid: b.getAttribute('data-testid'),
      icon: b.querySelector('[data-icon]') && b.querySelector('[data-icon]').getAttribute('data-icon')
    }));
    out.footerIcons = [...footer.querySelectorAll('[data-icon]')].map(i=>i.getAttribute('data-icon'));
  }
  // doc-wide: anything that looks like a send affordance
  out.sendIconAnywhere = !!document.querySelector('[data-icon="send"], span[data-icon="wds-ic-send-filled"]');
  out.ariaSendLike = [...document.querySelectorAll('[aria-label]')]
    .map(e=>e.getAttribute('aria-label')).filter(a=>/send|enviar/i.test(a||'')).slice(0,6);
  // ── read anchors in the open conversation ──
  const main = document.querySelector('#main');
  if (main) {
    out.openHeader = (main.querySelector('header')||{}).innerText && main.querySelector('header').innerText.replace(/\\n/g,' ').slice(0,40);
    out.sampleDataIds = [...main.querySelectorAll('[data-id]')].slice(-4).map(e=>e.getAttribute('data-id'));
    out.samplePrePlain = [...main.querySelectorAll('[data-pre-plain-text]')].slice(-4).map(e=>e.getAttribute('data-pre-plain-text'));
    // read-receipt / status icons humans see (check/dblcheck)
    out.statusIcons = [...new Set([...main.querySelectorAll('[data-icon]')].map(i=>i.getAttribute('data-icon')))].filter(x=>/check|msg-|read|deliver|dblcheck/i.test(x||'')).slice(0,8);
  }
  return out;
})()`;

(async () => {
  const wa = (await listTargets()).find(t => t.type==='page' && /web\.whatsapp\.com/.test(t.url||''));
  if (!wa) { console.log('No WA tab.'); process.exit(1); }
  const cdp = connect(wa.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send('Runtime.enable');
  const r = await cdp.evaluate(RECON);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(e => { console.error('probe error:', e?.message ?? e); process.exit(1); });
