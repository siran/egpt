// wa-audio-hook.mjs — capture a decrypted voice note via AudioContext.
// WA Web decodes voice notes with the Web Audio API (no <audio>/blob). Hook
// decodeAudioData(arrayBuffer) — WA passes the DECRYPTED ogg/opus bytes there
// on play. Inject hook → find a voice note → click play → grab the bytes.
//   node tests-manual/wa-audio-hook.mjs
import WebSocket from 'ws';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const listTargets = () => new Promise((res, rej) => { http.get('http://127.0.0.1:9221/json/list', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:2e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)return{__err:r.result.exceptionDetails.exception?.description?.slice(0,200)};return r.result?.result?.value;};return{send,ready,ev};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const HOOK = `(() => {
  if (window.__egptAudioHook) return 'already';
  window.__egptAudioHook = true;
  window.__egptAudioCaps = [];
  const grab = (buf) => {
    try {
      if (!(buf instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(buf.slice(0));
      let bin=''; for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
      window.__egptAudioCaps.push({ t: Date.now(), size: bytes.length, b64: btoa(bin) });
    } catch (e) {}
  };
  for (const Ctor of [window.AudioContext, window.webkitAudioContext, window.OfflineAudioContext, window.BaseAudioContext].filter(Boolean)) {
    const proto = Ctor.prototype;
    if (proto && proto.decodeAudioData && !proto.__egptWrapped) {
      const real = proto.decodeAudioData;
      proto.decodeAudioData = function (buf, ...rest) { grab(buf); return real.call(this, buf, ...rest); };
      proto.__egptWrapped = true;
    }
  }
  return 'installed';
})()`;

(async () => {
  const wa = (await listTargets()).find(t => t.type==='page' && /web\.whatsapp\.com/.test(t.url||''));
  const cdp = connect(wa.webSocketDebuggerUrl); await cdp.ready; await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  console.log('hook:', await cdp.ev(HOOK));

  // Find a voice-note play control in the open chat; scroll up a bit if none in view.
  let coords = null;
  for (let attempt = 0; attempt < 4 && !coords; attempt++) {
    coords = await cdp.ev(`(()=>{
      const main=document.querySelector('#main'); if(!main) return null;
      const btns=[...main.querySelectorAll('[aria-label="Voice message"], [data-icon="audio-play"], [aria-label="Play voice message"], button[aria-label*="lay"]')];
      const b=btns[btns.length-1]; if(!b) return null;
      b.scrollIntoView({block:'center'});
      const r=(b.closest('button')||b).getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
    })()`);
    if (!coords) { await cdp.ev(`(()=>{const m=document.querySelector('#main [role="application"], #main .copyable-area, #main'); if(m) m.scrollBy(0,-800);})()`); await sleep(700); }
  }
  console.log('voice play control:', JSON.stringify(coords));
  if (coords) {
    for (const type of ['mouseMoved','mousePressed','mouseReleased']) await cdp.send('Input.dispatchMouseEvent',{type,x:coords.x,y:coords.y,button:'left',clickCount:1});
  }
  // give decode a moment
  for (let i=0;i<10;i++){ await sleep(300); const n = await cdp.ev(`window.__egptAudioCaps ? window.__egptAudioCaps.length : -1`); if (Array.isArray(n)||n>0) break; }

  const caps = await cdp.ev(`(window.__egptAudioCaps||[]).map(c=>({t:c.t,size:c.size}))`);
  console.log('\ncaptured decodeAudioData calls:', JSON.stringify(caps));
  if (Array.isArray(caps) && caps.length) {
    const big = await cdp.ev(`(()=>{const c=(window.__egptAudioCaps||[]).slice().sort((a,b)=>b.size-a.size)[0]; return c?{size:c.size,b64:c.b64}:null;})()`);
    if (big?.b64) { writeFileSync('C:/Users/an/.egpt/wa-audio-hook.ogg', Buffer.from(big.b64,'base64')); console.log(`✅ wrote ${big.size} bytes → C:/Users/an/.egpt/wa-audio-hook.ogg (check the file header for OggS/opus)`); }
  } else {
    console.log('no decodeAudioData captured — WA may stream/decode differently, or no voice note played.');
  }
  process.exit(0);
})().catch(e => { console.error('err', e?.message ?? e); process.exit(1); });
