// wa-audio-play.mjs — open Self, click the last voice note's play button, and
// capture the decrypted bytes via the decodeAudioData hook.
import WebSocket from 'ws';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const listTargets = () => new Promise((res, rej) => { http.get('http://127.0.0.1:9221/json/list', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:2e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)return{__err:r.result.exceptionDetails.exception?.description?.slice(0,200)};return r.result?.result?.value;};return{send,ready,ev};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const click=async(cdp,c)=>{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:c.x,y:c.y,button:'left',clickCount:1});};

const HOOK = `(() => { if (window.__egptAudioHook) return 'already'; window.__egptAudioHook=true; window.__egptAudioCaps=[]; const grab=(b)=>{try{if(!(b instanceof ArrayBuffer))return;const u=new Uint8Array(b.slice(0));let s='';for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);window.__egptAudioCaps.push({t:Date.now(),size:u.length,b64:btoa(s)});}catch(e){}}; for(const C of [window.AudioContext,window.webkitAudioContext,window.OfflineAudioContext,window.BaseAudioContext].filter(Boolean)){const p=C.prototype;if(p&&p.decodeAudioData&&!p.__w){const r=p.decodeAudioData;p.decodeAudioData=function(b,...x){grab(b);return r.call(this,b,...x);};p.__w=true;}} return 'installed'; })()`;

(async () => {
  const wa = (await listTargets()).find(t => t.type==='page' && /web\.whatsapp\.com/.test(t.url||''));
  const cdp = connect(wa.webSocketDebuggerUrl); await cdp.ready; await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  console.log('hook:', await cdp.ev(HOOK));

  // Ensure Self chat open (the audio was sent to Self).
  let hdr = await cdp.ev(`(document.querySelector('#main header')||{}).innerText||''`);
  if (!/\(You\)|Message yourself|646/.test(hdr || '')) {
    const c = await cdp.ev(`(()=>{const r=document.querySelector('#pane-side [data-testid="message-yourself-row"]')||[...document.querySelectorAll('#pane-side span[title]')].find(s=>/646/.test(s.getAttribute('title')||''))?.closest('[data-testid="cell-frame-container"]');if(!r)return null;r.scrollIntoView({block:'center'});const b=r.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()`);
    if (c) { await click(cdp, c); await sleep(1500); }
    hdr = await cdp.ev(`(document.querySelector('#main header')||{}).innerText||''`);
  }
  console.log('open chat:', (hdr||'').replace(/\n/g,' ').slice(0,40));

  // Dump play-control candidates in the last messages, pick the last, click it.
  const found = await cdp.ev(`(()=>{
    const main=document.querySelector('#main'); if(!main) return null;
    const cands=[...main.querySelectorAll('[aria-label="Play voice message"]')];
    const labels=cands.map(c=>c.getAttribute('data-icon')||c.getAttribute('aria-label'));
    const b=cands[cands.length-1]; if(!b) return {labels, none:true};
    b.scrollIntoView({block:'center'}); const r=(b.closest('button')||b).getBoundingClientRect();
    return {labels, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
  })()`);
  console.log('play candidates:', JSON.stringify(found));
  if (found && found.x != null) { console.log('clicking play…'); await click(cdp, { x: found.x, y: found.y }); }

  for (let i=0;i<12;i++){ await sleep(300); const n=await cdp.ev(`(window.__egptAudioCaps||[]).length`); if (n>0) break; }
  const caps = await cdp.ev(`(window.__egptAudioCaps||[]).map(c=>({size:c.size}))`);
  console.log('captured:', JSON.stringify(caps));
  if (Array.isArray(caps) && caps.length) {
    const big = await cdp.ev(`(()=>{const c=(window.__egptAudioCaps||[]).slice().sort((a,b)=>b.size-a.size)[0];return c?{size:c.size,b64:c.b64}:null;})()`);
    if (big?.b64) { writeFileSync('C:/Users/an/.egpt/wa-audio-hook.ogg', Buffer.from(big.b64,'base64')); console.log(`✅ wrote ${big.size} bytes → C:/Users/an/.egpt/wa-audio-hook.ogg`); }
  }
  process.exit(0);
})().catch(e => { console.error('err', e?.message ?? e); process.exit(1); });
