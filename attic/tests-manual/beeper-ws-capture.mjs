// beeper-ws-capture.mjs — connect to the Beeper WS and log every frame, so we
// learn the live event shape (message.upserted etc.). Send a text + voice note.
import WebSocket from 'ws';
const T = process.env.TOK;
const ws = new WebSocket('ws://127.0.0.1:23373/v1/ws', { headers: { Authorization: 'Bearer ' + T } });
ws.on('open', () => console.log(new Date().toISOString(), 'WS OPEN — send a WhatsApp text + a voice note now'));
ws.on('message', (m) => console.log(new Date().toISOString(), 'FRAME:', m.toString().slice(0, 900)));
ws.on('error', (e) => console.log('ERR', e.message));
ws.on('close', (c) => console.log('CLOSE', c));
setTimeout(() => { console.log('(done capturing)'); process.exit(0); }, 120000);
