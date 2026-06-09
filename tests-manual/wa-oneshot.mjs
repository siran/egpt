// wa-oneshot.mjs — deterministic limb→gate→reply proof, no notification timing.
// Opens a chat, reads its LATEST message, runs the REAL auto-mode gate, and
// replies if (and only if) the gate permits. Live-replies only to the named
// chat (safe). Usage:
//   node tests-manual/wa-oneshot.mjs "Rodz"          # mode=mention
//   node tests-manual/wa-oneshot.mjs "Rodz" on       # mode=on
import { createWaWebDom } from '../src/tools/wa-web-dom.mjs';
import { mentionStatus, replyAllowed, mayEmit, DEFAULT_AUTO_MODE } from '../src/auto-mode.mjs';

const CHAT = process.argv[2] || 'Rodz';
const MODE = process.argv[3] || DEFAULT_AUTO_MODE;   // 'mention' default

const wa = createWaWebDom({ log: (m) => console.log('  ', m) });
await wa.attach();
console.log(`opening "${CHAT}"…`);
const opened = await wa.openChatByName(CHAT);
if (!opened) { console.log('could not open chat'); process.exit(2); }
const msgs = await wa.readLatest(1);
const last = msgs[msgs.length - 1];
console.log('latest message:', JSON.stringify(last));
if (!last?.text) { console.log('no readable last message'); process.exit(2); }

const status = mentionStatus(last.text);
const allowed = replyAllowed(MODE, { atEStart: status.atEStart, atEAnywhere: status.atEAnywhere, replyToBot: false });
const emit = mayEmit(MODE, { replyAllowed: allowed, isReaction: false });
console.log(`gate: mode=${MODE} from=${last.sender} atEAnywhere=${status.atEAnywhere} → replyAllowed=${allowed} mayEmit=${emit}`);

if (emit) {
  const reply = `🐶 e — inert reply (cdp) @ ${new Date().toISOString().slice(11, 19)}`;
  const r = await wa.sendText(reply);
  console.log('→ REPLIED:', JSON.stringify(r), '| text:', JSON.stringify(reply));
} else {
  console.log('→ silent (gate) — send an "@e …" message as the latest, then re-run');
}
wa.stop();
process.exit(0);
