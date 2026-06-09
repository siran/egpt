// wa-download.mjs — spike WA Web's Download-action on a voice note over CDP.
// Set a download dir, find the voice note, hover to reveal its context chevron,
// dump menu affordances → then click Download → confirm the .ogg lands.
import WebSocket from 'ws';
import http from 'node:http';
import { readdirSync, statSync } from 'node:fs';
const DL = 'C:\\Users\\an\\.egpt\\wa-downloads';
const listTargets = () => new Promise((res, rej) => { http.get('http://127.0.0.1:9221/json/list', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:2e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)return{__err:r.result.exceptionDetails.exception?.description?.slice(0,200)};return r.result?.result?.value;};return{send,ready,ev};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mouse=async(cdp,type,x,y,extra={})=>cdp.send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:type==='mouseMoved'?0:1,...extra});

(async () => {
  const wa = (await listTargets()).find(t => t.type==='page' && /web\.whatsapp\.com/.test(t.url||''));
  const cdp = connect(wa.webSocketDebuggerUrl); await cdp.ready; await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  console.log('download dir set:', DL);

  // Find the LAST voice note bubble (the message row with a "Play voice message" button).
  const bubble = await cdp.ev(`(()=>{
    const main=document.querySelector('#main'); if(!main) return null;
    const play=[...main.querySelectorAll('[aria-label="Play voice message"]')].pop(); if(!play) return {noVoice:true};
    const row=play.closest('[data-id]')||play.closest('[role="row"]')||play.parentElement.parentElement;
    row.scrollIntoView({block:'center'});
    const r=row.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width)};
  })()`);
  console.log('voice bubble:', JSON.stringify(bubble));
  if (!bubble || bubble.x == null) { console.log('no voice note found in open chat'); process.exit(2); }

  // Hover to reveal the context chevron.
  await mouse(cdp, 'mouseMoved', bubble.x, bubble.y);
  await sleep(700);
  const affordances = await cdp.ev(`(()=>{
    const main=document.querySelector('#main'); if(!main) return null;
    const play=[...main.querySelectorAll('[aria-label="Play voice message"]')].pop();
    const row=play.closest('[data-id]')||play.closest('[role="row"]');
    const within=[...(row||main).querySelectorAll('[aria-label],[data-icon]')].map(e=>e.getAttribute('aria-label')||e.getAttribute('data-icon')).filter(Boolean);
    return [...new Set(within)].slice(0,25);
  })()`);
  console.log('affordances in/near bubble after hover:', JSON.stringify(affordances));

  console.log('all #main aria-labels after hover:', JSON.stringify(await cdp.ev(`[...new Set([...document.querySelectorAll('#main [aria-label]')].map(e=>e.getAttribute('aria-label')))].slice(0,40)`)));

  // RIGHT-CLICK the voice bubble to open WA's message context menu.
  console.log('right-clicking the voice bubble…');
  await mouse(cdp, 'mouseMoved', bubble.x, bubble.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bubble.x, y: bubble.y, button: 'right', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bubble.x, y: bubble.y, button: 'right', clickCount: 1 });
  await sleep(800);
  const menu = await cdp.ev(`[...document.querySelectorAll('[role="menuitem"], li[role="button"], div[role="button"], [role="application"] li, ul li')].map(e=>(e.innerText||'').trim()).filter(t=>t&&t.length<30).slice(0,20)`);
  console.log('context menu items:', JSON.stringify(menu));
  const dl = await cdp.ev(`(()=>{const items=[...document.querySelectorAll('[role="menuitem"], li, div[role="button"], [role="application"] *')];const d=items.find(e=>/^download$/i.test((e.innerText||'').trim()));if(!d)return null;const r=d.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  console.log('download item:', JSON.stringify(dl));
  if (dl && dl.x != null) { console.log('clicking Download…'); await mouse(cdp,'mouseMoved',dl.x,dl.y); await sleep(120); await mouse(cdp,'mousePressed',dl.x,dl.y); await mouse(cdp,'mouseReleased',dl.x,dl.y); }

  // Watch the download dir for a new file.
  console.log('watching download dir…');
  const before = new Set(readdirSync(DL));
  for (let i=0;i<20;i++){ await sleep(500); const now=readdirSync(DL).filter(f=>!before.has(f)); if (now.length){ for(const f of now){ const p=`${DL}\\${f}`; let sz=0; try{sz=statSync(p).size}catch{}; console.log(`✅ NEW FILE: ${f} (${sz} bytes)`); } break; } }
  console.log('dir now:', readdirSync(DL));
  process.exit(0);
})().catch(e => { console.error('err', e?.message ?? e); process.exit(1); });
