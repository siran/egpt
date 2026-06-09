// wa-dom-send.mjs — the SEND FIX (operator 2026-06-08). Type, then CLICK the
// Send button that appears (Enter is ignored by WA's Lexical composer). Targets
// Self only; verifies the open chat is Self before typing a single char.
//   node tests-manual/wa-dom-send.mjs
import WebSocket from 'ws';
import http from 'node:http';
const PORT = Number(process.env.CDP_PORT || 9221);
const SELF = process.env.SELF_NUMBER || '16468217865';
const MSG = 'egpt cdp roundtrip ' + new Date().toISOString().slice(11, 19);
const listTargets = () => new Promise((res, rej) => { http.get(`http://127.0.0.1:${PORT}/json/list`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej); });
function connect(u){const ws=new WebSocket(u,{maxPayload:1e8});let id=1;const p=new Map();ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return}if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});const evaluate=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.result?.result?.value;};return{send,ready,evaluate};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  const wa=(await listTargets()).find(t=>t.type==='page'&&/web\.whatsapp\.com/.test(t.url||''));
  if(!wa){console.log('No WA tab.');process.exit(1);}
  const cdp=connect(wa.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  console.log(`1) opening Self (${SELF})…`);
  await cdp.send('Page.navigate',{url:`https://web.whatsapp.com/send?phone=${SELF}`});
  let header=null;
  for(let i=0;i<40;i++){ await sleep(1000);
    const st=await cdp.evaluate(`(()=>{const c=document.querySelector('footer div[contenteditable="true"]');const h=document.querySelector('#main header');return {composer:!!c,header:h?h.innerText.replace(/\\n/g,' ').slice(0,50):null};})()`);
    if(st&&st.composer){header=st.header;break;}
  }
  // SAFETY GATE: only type/send if the open chat is provably Self.
  const isSelf = !!header && (/\(You\)/i.test(header) || /Message yourself/i.test(header) || header.includes('646') );
  console.log(`   header: "${header}"  → isSelf=${isSelf}`);
  if(!isSelf){ console.log('   NOT Self — aborting (no send).'); process.exit(2); }

  console.log('2) typing into composer (watch)…');
  await cdp.evaluate(`(()=>{const c=document.querySelector('footer div[contenteditable="true"]');c&&c.focus();return !!c;})()`);
  await sleep(300);
  await cdp.send('Input.insertText',{text:MSG});
  await sleep(800);

  console.log('3) finding + clicking the Send button that appeared…');
  const clicked = await cdp.evaluate(`(()=>{
    const byIcon = document.querySelector('footer [data-icon="send"], footer [data-icon="wds-ic-send-filled"]');
    const byAria = [...document.querySelectorAll('footer button[aria-label]')].find(b=>/send|enviar/i.test(b.getAttribute('aria-label')||''));
    const target = (byIcon && (byIcon.closest('button')||byIcon)) || byAria;
    if(!target) return { ok:false, footerIcons:[...document.querySelectorAll('footer [data-icon]')].map(i=>i.getAttribute('data-icon')) };
    target.click();
    return { ok:true, via: byIcon?'data-icon=send':'aria-label' };
  })()`);
  console.log('   click result:', JSON.stringify(clicked));
  await sleep(1500);

  console.log('4) verify (read-back via data-pre-plain-text + composer cleared)…');
  const verify = await cdp.evaluate(`(()=>{
    const c=document.querySelector('footer div[contenteditable="true"]');
    const composerText=c?c.innerText.trim():null;
    const main=document.querySelector('#main');
    const rows=main?[...main.querySelectorAll('[data-pre-plain-text]')]:[];
    const last=rows[rows.length-1];
    return { composerCleared: composerText==='' , composerText, lastSenderMeta: last?last.getAttribute('data-pre-plain-text'):null };
  })()`);
  console.log('   ', JSON.stringify(verify));
  console.log('\n✅ check your Self chat for:', JSON.stringify(MSG));
  process.exit(0);
})().catch(e=>{console.error('send error:',e?.message??e);process.exit(1);});
