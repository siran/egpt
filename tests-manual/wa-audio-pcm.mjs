// wa-audio-pcm.mjs — last in-page swing: capture decoded PCM off Web Audio.
// Hook BaseAudioContext.createBufferSource → wrap the node's start() to grab
// node.buffer (the WASM-decoded PCM). Play a voice note, capture, write a WAV.
import WebSocket from 'ws';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const listTargets = () => new Promise((res, rej) => { http.get('http://127.0.0.1:9221/json/list', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:3e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.result?.exceptionDetails)return{__err:r.result.exceptionDetails.exception?.description?.slice(0,200)};return r.result?.result?.value;};return{send,ready,ev};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const click=async(cdp,c)=>{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:c.x,y:c.y,button:'left',clickCount:1});};

const HOOK = `(() => {
  if (window.__pcmHook) return 'already';
  window.__pcmHook = true; window.__egptPCM = null;
  const base = (window.BaseAudioContext && window.BaseAudioContext.prototype) || (window.AudioContext && window.AudioContext.prototype);
  if (base && base.createBufferSource && !base.__pcm) {
    const real = base.createBufferSource;
    base.createBufferSource = function (...a) {
      const node = real.apply(this, a);
      if (node && node.start) {
        const realStart = node.start.bind(node);
        node.start = function (...sa) {
          try {
            const buf = node.buffer;
            if (buf && buf.length && (!window.__egptPCM || buf.length > window.__egptPCM.length)) {
              const ch = buf.getChannelData(0);
              const u8 = new Uint8Array(ch.buffer.slice(ch.byteOffset, ch.byteOffset + ch.length * 4));
              let s=''; const CH=0x8000; for (let i=0;i<u8.length;i+=CH) s += String.fromCharCode.apply(null, u8.subarray(i, i+CH));
              window.__egptPCM = { sampleRate: buf.sampleRate, length: buf.length, channels: buf.numberOfChannels, b64: btoa(s) };
            }
          } catch (e) { window.__pcmErr = String(e && e.message); }
          return realStart(...sa);
        };
      }
      return node;
    };
    base.__pcm = true;
  }
  return 'installed';
})()`;

function floatPCMtoWav(f32, sampleRate) {
  const n = f32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { let s = Math.max(-1, Math.min(1, f32[i])); buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2); }
  return buf;
}

(async () => {
  const wa = (await listTargets()).find(t => t.type==='page' && /web\.whatsapp\.com/.test(t.url||''));
  const cdp = connect(wa.webSocketDebuggerUrl); await cdp.ready; await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  console.log('pcm hook:', await cdp.ev(HOOK));
  const found = await cdp.ev(`(()=>{const main=document.querySelector('#main');if(!main)return null;const b=[...main.querySelectorAll('[aria-label="Play voice message"]')].pop();if(!b)return{none:true};b.scrollIntoView({block:'center'});const r=(b.closest('button')||b).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  console.log('play btn:', JSON.stringify(found));
  if (found && found.x != null) { console.log('clicking play…'); await click(cdp, { x: found.x, y: found.y }); }
  for (let i=0;i<14;i++){ await sleep(350); const ok = await cdp.ev(`!!window.__egptPCM`); if (ok===true) break; }
  const meta = await cdp.ev(`window.__egptPCM ? {sampleRate:window.__egptPCM.sampleRate,length:window.__egptPCM.length,channels:window.__egptPCM.channels} : (window.__pcmErr||null)`);
  console.log('PCM capture:', JSON.stringify(meta));
  if (meta && meta.length) {
    const b64 = await cdp.ev(`window.__egptPCM.b64`);
    const raw = Buffer.from(b64, 'base64');
    const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    const wav = floatPCMtoWav(f32, meta.sampleRate);
    writeFileSync('C:/Users/an/.egpt/wa-audio-pcm.wav', wav);
    console.log(`✅ PCM captured: ${(meta.length/meta.sampleRate).toFixed(1)}s @ ${meta.sampleRate}Hz → wrote C:/Users/an/.egpt/wa-audio-pcm.wav (${wav.length} bytes)`);
  } else {
    console.log('no PCM captured (WA may use AudioWorklet/streaming, not createBufferSource).');
  }
  process.exit(0);
})().catch(e => { console.error('err', e?.message ?? e); process.exit(1); });
