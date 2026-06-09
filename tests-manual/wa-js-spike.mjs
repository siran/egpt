// wa-js-spike.mjs — THROWAWAY (operator 2026-06-08, KISS). Tests option 3:
// ride @wppconnect/wa-js (a MAINTAINED Store layer) injected over our own CDP.
//
//   1. inject dist/wppconnect-wa.js via Page.addScriptToEvaluateOnNewDocument
//      (runs at document-start, so it hooks webpack BEFORE WA Web boots)
//   2. reload the WA tab
//   3. wait for window.WPP.isReady
//   4. one roundtrip: send a line to the Self chat via WPP, read it back
//
// Sends ONLY to Self (note-to-self). Reloads the brain-profile WA tab once.
//   node tests-manual/wa-js-spike.mjs
import WebSocket from 'ws';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CDP_PORT || 9221);
const WAJS = readFileSync(fileURLToPath(new URL('./wppconnect-wa.js', import.meta.url)), 'utf8');

const listTargets = () => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 100 * 1024 * 1024 });
  let nextId = 1; const pending = new Map();
  ws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const ready = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __evalError: r.result.exceptionDetails.exception?.description || 'eval error' };
    return r.result?.result?.value;
  };
  return { ready, send, evaluate };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const wa = (await listTargets()).find(t => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''));
  if (!wa) { console.log('No WhatsApp Web page on CDP. Open web.whatsapp.com in that Chrome.'); process.exit(1); }
  console.log(`WA tab: ${wa.title} | ${wa.id}`);
  const cdp = connect(wa.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  if (process.argv.includes('--diag')) {
    const diag = await cdp.evaluate(`(() => { try {
      const W = window.WPP; const ch = self.webpackChunkwhatsapp_web_client;
      return {
        wppType: typeof W,
        version: W && W.version,
        keys: W ? Object.keys(W) : null,
        webpackKeys: (W && W.webpack) ? Object.keys(W.webpack) : null,
        webpackIsReady: !!(W && W.webpack && W.webpack.isReady),
        waVersion: window.Debug && window.Debug.VERSION,
        chunkPresent: !!ch, chunkLen: ch ? ch.length : null,
        chunkPushNative: ch ? (ch.push === Array.prototype.push) : null,
      };
    } catch (e) { return { err: String(e && e.message || e) }; } })()`);
    console.log('DIAG:', JSON.stringify(diag, null, 2));
    process.exit(0);
  }

  // Safe readiness probe — ONLY property reads, never a call that can throw.
  const READY_PROBE = `(() => { try {
    const W = window.WPP;
    return { wpp: typeof W, isReady: !!(W && W.isReady), isFullReady: !!(W && W.isFullReady), webpackReady: !!(W && W.webpack && W.webpack.isReady) };
  } catch (e) { return { err: String(e && e.message || e) }; } })()`;

  const pre = await cdp.evaluate(READY_PROBE);
  let ready = !!pre?.isReady;
  if (ready) {
    console.log('\n1-3) WPP already live (skipping inject/reload):', JSON.stringify(pre));
  } else {
    console.log('\n1) injecting wa-js for next document…');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WAJS });
    console.log('2) reloading WA tab…');
    await cdp.send('Page.reload', {});
    console.log('3) waiting for WPP.isReady (up to 90s)…');
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const st = await cdp.evaluate(READY_PROBE);
      if (i % 5 === 0 || st?.isReady) console.log(`   t+${i}s`, JSON.stringify(st));
      if (st?.isReady) { ready = true; break; }
    }
  }
  if (!ready) { console.log('   WPP never became ready — option 3 needs a closer look (version vs bundle).'); process.exit(2); }
  console.log('   WPP READY ✅');

  console.log('\n4) roundtrip via WPP (Self chat)…');
  const tag = 'egpt wa-js spike ' + new Date().toISOString().slice(11, 19);
  const result = await cdp.evaluate(`(async () => {
    const me = WPP.conn.getMyUserId();
    const meId = me && (me._serialized || me.toString());
    const sent = await WPP.chat.sendTextMessage(meId, ${JSON.stringify(tag)}, { createChat: true });
    const sentId = sent && (sent.id && (sent.id._serialized || sent.id) || sent.messageId || sent.to);
    const msgs = await WPP.chat.getMessages(meId, { count: 3 });
    return {
      meId,
      sentType: typeof sent,
      sentId: typeof sentId === 'object' ? JSON.stringify(sentId) : sentId,
      lastMessages: (msgs || []).map(m => ({ id: m.id && (m.id._serialized || String(m.id)), fromMe: m.id && m.id.fromMe, body: (m.body || '').slice(0, 60) })),
    };
  })()`);
  console.log(JSON.stringify(result, null, 2));
  console.log('\n✅ done — check your WhatsApp Self chat for:', JSON.stringify(tag));
  process.exit(0);
})().catch(e => { console.error('spike error:', e?.message ?? e); process.exit(1); });
