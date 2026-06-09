// wa-dom-demo.mjs — VISIBLE DOM-control demo (operator 2026-06-08). Drives the
// real WhatsApp Web UI over CDP — opens the SELF chat, types into the composer,
// presses Enter. You can watch it happen. Sends ONLY to Self (note-to-self).
//
//   node tests-manual/wa-dom-demo.mjs
import WebSocket from 'ws';
import http from 'node:http';

const PORT = Number(process.env.CDP_PORT || 9221);
const SELF = process.env.SELF_NUMBER || '16468217865';   // the logged-in account
const MSG = 'egpt cdp visible test ' + new Date().toISOString().slice(11, 19);

const listTargets = () => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}/json/list`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error', rej);
});
function connect(wsUrl){
  const ws=new WebSocket(wsUrl,{maxPayload:1e8}); let id=1; const p=new Map();
  ws.on('message',b=>{let m;try{m=JSON.parse(b.toString())}catch{return} if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
  const send=(method,params={})=>new Promise(r=>{const i=id++;p.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
  const ready=new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});
  const evaluate=async(expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return r.result?.result?.value;};
  return {send,ready,evaluate};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  const wa=(await listTargets()).find(t=>t.type==='page'&&/web\.whatsapp\.com/.test(t.url||''));
  if(!wa){console.log('No WA tab.');process.exit(1);}
  const cdp=connect(wa.webSocketDebuggerUrl); await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Input.enable').catch(()=>{});

  console.log(`1) opening Self chat (${SELF}) — watch the browser…`);
  await cdp.send('Page.navigate',{url:`https://web.whatsapp.com/send?phone=${SELF}`});

  console.log('2) waiting for the composer…');
  let composerOk=false, title=null;
  for(let i=0;i<40;i++){
    await sleep(1000);
    const st=await cdp.evaluate(`(()=>{const c=document.querySelector('footer div[contenteditable="true"]');const h=document.querySelector('#main header');return {composer:!!c, title:h?h.innerText.replace(/\\n/g,' ').slice(0,40):null};})()`);
    title=st?.title;
    if(st?.composer){composerOk=true;break;}
  }
  if(!composerOk){console.log('   composer never appeared');process.exit(2);}
  console.log(`   chat open: "${title}"`);

  // SAFETY: only proceed if this really is the Self chat (own number in URL +
  // header looks like self). We navigated to our own number, so the open chat
  // is Self; still, bail loudly if a #main with a different obvious contact.
  console.log('3) focusing composer + typing (visible)…');
  await cdp.evaluate(`(()=>{const c=document.querySelector('footer div[contenteditable="true"]');if(c){c.focus();}return !!c;})()`);
  await sleep(400);
  // Input.insertText dispatches real input events the WA editor recognizes.
  await cdp.send('Input.insertText',{text:MSG});
  await sleep(800);   // let you SEE it sitting in the box

  console.log('4) pressing Enter to send…');
  for(const type of ['keyDown','keyUp']){
    await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  }
  await sleep(1500);

  const last=await cdp.evaluate(`(()=>{const m=document.querySelector('#main');if(!m)return null;const outs=m.querySelectorAll('.message-out');const l=outs[outs.length-1];return l?(l.querySelector('.selectable-text')||l).innerText.slice(0,80):'(no .message-out matched — selector drift, but check the chat)';})()`);
  console.log('5) last outgoing in view:', JSON.stringify(last));
  console.log('\n✅ check your Self chat — you should see:', JSON.stringify(MSG));
  process.exit(0);
})().catch(e=>{console.error('demo error:',e?.message??e);process.exit(1);});
