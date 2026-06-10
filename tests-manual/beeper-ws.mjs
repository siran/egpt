// beeper-ws.mjs — find how the Beeper Desktop WebSocket (/v1/ws) authenticates.
import WebSocket from 'ws';
const T = process.env.TOK;
const B = 'ws://127.0.0.1:23373/v1/ws';
const tries = [
  ['header Authorization', () => new WebSocket(B, { headers: { Authorization: 'Bearer ' + T } })],
  ['protocols [TOK]', () => new WebSocket(B, [T])],
  ['protocols [bearer,TOK]', () => new WebSocket(B, ['bearer', T])],
  ['protocols [Authorization,Bearer TOK]', () => new WebSocket(B, ['Authorization', 'Bearer ' + T])],
  ['query access_token', () => new WebSocket(B + '?access_token=' + T)],
  ['query authorization=Bearer', () => new WebSocket(B + '?authorization=Bearer%20' + T)],
  ['header+origin', () => new WebSocket(B, { headers: { Authorization: 'Bearer ' + T, Origin: 'http://127.0.0.1:23373' } })],
];
let i = 0;
function next() {
  if (i >= tries.length) { console.log('— all variants tried —'); process.exit(0); }
  const [name, mk] = tries[i++];
  let ws;
  try { ws = mk(); } catch (e) { console.log(name, 'THROW', e.message); return setTimeout(next, 150); }
  let done = false;
  const fin = (r) => { if (done) return; done = true; console.log(`${name}: ${r}`); try { ws.close(); } catch {} setTimeout(next, 250); };
  ws.on('open', () => { console.log(`${name}: OPEN ✅`); setTimeout(() => fin('(opened; watching frames 2.5s)'), 2500); });
  ws.on('message', (m) => console.log(`${name} FRAME: ${m.toString().slice(0, 350)}`));
  ws.on('error', (e) => fin('ERR ' + e.message));
}
next();
