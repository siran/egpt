// wa-audio-spike.mjs — can we pull a decrypted voice-note blob out of WA Web
// via CDP? Recon first: find a chat with a voice note, see how the audio is
// represented (audio element / blob URL / play button / lazy-load), then try
// fetch(blobURL) in-page → base64 out.
//   node tests-manual/wa-audio-spike.mjs                 # recon (list previews + open-chat audio)
//   node tests-manual/wa-audio-spike.mjs "Chat Name"     # open that chat, probe its audio, try blob fetch
import WebSocket from 'ws';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const PORT = 9221;
const TARGET = process.argv[2] || null;
const listTargets = () => new Promise((res, rej) => { http.get(`http://127.0.0.1:${PORT}/json/list`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:2e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)return{__err:r.result.exceptionDetails.exception?.description};return r.result?.result?.value;};return{send,ready,ev};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async () => {
  const wa = (await listTargets()).find(t => t.type==='page' && /web\.whatsapp\.com/.test(t.url||''));
  const cdp = connect(wa.webSocketDebuggerUrl); await cdp.ready; await cdp.send('Runtime.enable'); await cdp.send('Page.enable');

  if (TARGET) {
    console.log(`opening "${TARGET}" by click…`);
    await cdp.ev(`(()=>{const t=[...document.querySelectorAll('#pane-side span[title]')].find(s=>s.getAttribute('title')===${JSON.stringify(TARGET)});if(t){(t.closest('[role="row"]')||t).scrollIntoView({block:'center'});const r=(t.closest('[data-testid="cell-frame-container"]')||t).getBoundingClientRect();window.__r={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};return window.__r;}return null;})()`).then(r=>console.log('  rect', JSON.stringify(r)));
    const r = await cdp.ev(`window.__r||null`);
    if (r) { for (const type of ['mouseMoved','mousePressed','mouseReleased']) await cdp.send('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,button:'left',clickCount:1}); }
    await sleep(1500);
  }

  console.log('\n=== open chat audio recon ===');
  const recon = await cdp.ev(`(() => {
    const main = document.querySelector('#main'); if (!main) return 'no #main';
    const header = (main.querySelector('header')||{}).innerText;
    return {
      header: (header||'').replace(/\\n/g,' ').slice(0,40),
      mainAudio: main.querySelectorAll('audio').length,
      docAudio: document.querySelectorAll('audio').length,
      docAudioSrcs: [...document.querySelectorAll('audio')].map(a=>(a.src||'(empty)').slice(0,45)),
      iconsInMain: [...new Set([...main.querySelectorAll('[data-icon]')].map(e=>e.getAttribute('data-icon')))],
      voiceBtns: [...main.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(a=>/voice|play|audio/i.test(a||'')).slice(0,6),
      hasAudioContext: !!(window.AudioContext || window.webkitAudioContext),
      lastPpts: [...main.querySelectorAll('[data-pre-plain-text]')].slice(-3).map(p=>(p.getAttribute('data-pre-plain-text')||'').slice(0,40)),
    };
  })()`);
  console.log(JSON.stringify(recon, null, 2));

  // WA lazy-loads voice notes — no <audio>/blob until play is clicked. Click
  // the LAST voice-note play control, then mute+pause everything so it doesn't
  // blare, giving WA a beat to materialize the decrypted blob.
  const coords = await cdp.ev(`(()=>{
    const main=document.querySelector('#main'); if(!main) return null;
    const btns=[...main.querySelectorAll('[aria-label="Voice message"], [data-icon="audio-play"], [aria-label="Play voice message"]')];
    const b=btns[btns.length-1]; if(!b) return null;
    b.scrollIntoView({block:'center'});
    const r=(b.closest('button')||b).getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};
  })()`);
  if (coords) {
    console.log('\nclicking last voice-note play control', JSON.stringify(coords));
    for (const type of ['mouseMoved','mousePressed','mouseReleased']) await cdp.send('Input.dispatchMouseEvent',{type,x:coords.x,y:coords.y,button:'left',clickCount:1});
    // mute/pause loop while the blob loads
    for (let i=0;i<8;i++){ await sleep(150); await cdp.ev(`[...document.querySelectorAll('audio')].forEach(a=>{a.muted=true;try{a.pause()}catch(e){}});document.querySelectorAll('audio').length`); }
  }

  // Now try to fetch the materialized blob bytes in-page.
  const blobInfo = await cdp.ev(`(async () => {
    const main = document.querySelector('#main'); if (!main) return null;
    const a = [...main.querySelectorAll('audio')].find(a => a.src && a.src.startsWith('blob:'));
    if (!a) return { noBlobAudio: true, anyAudio: main.querySelectorAll('audio').length };
    try {
      const resp = await fetch(a.src);
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin=''; for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
      return { ok:true, blobUrl: a.src.slice(0,40), size: bytes.length, type: resp.headers.get('content-type'), b64: btoa(bin) };
    } catch (e) { return { fetchErr: String(e && e.message || e) }; }
  })()`);
  if (blobInfo?.ok) {
    const out = 'C:/Users/an/.egpt/wa-audio-spike.ogg';
    writeFileSync(out, Buffer.from(blobInfo.b64, 'base64'));
    console.log(`\n✅ BLOB EXTRACTED: ${blobInfo.size} bytes, type=${blobInfo.type} → wrote ${out}`);
    delete blobInfo.b64; console.log(JSON.stringify(blobInfo, null, 2));
  } else {
    console.log('\nblob fetch:', JSON.stringify(blobInfo, null, 2));
  }
  process.exit(0);
})().catch(e => { console.error('spike err:', e?.message ?? e); process.exit(1); });
