// warm-session-spike.mjs — verify createWarmSession: two turns on ONE open
// query, the second remembers the first (warm context) + is fast (no respawn).
import { createWarmSession } from '../config/brains/claude-sdk.mjs';

const s = createWarmSession({ model: 'haiku', onLog: (m) => console.log('  [log]', m) });

const t1 = Date.now();
const r1 = await s.turn('Reply with exactly this token and nothing else: PING-42');
console.log(`turn1 (${Date.now() - t1}ms):`, JSON.stringify(r1.text), '| session', r1.sessionId);

const t2 = Date.now();
const r2 = await s.turn('What token did I just ask you to say? Reply with only the token.');
console.log(`turn2 (${Date.now() - t2}ms):`, JSON.stringify(r2.text));

console.log(r2.text.includes('PING-42') ? '\n✅ WARM: second turn remembered the first (context retained on one open query)' : '\n❌ second turn did NOT remember — streaming-input not retaining context');
s.close();
setTimeout(() => process.exit(0), 500);
