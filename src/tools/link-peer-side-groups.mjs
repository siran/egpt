// link-peer-side-groups.mjs — a peer node's side groups, linked on this node as if it had seen each
// one's opener: the opener is replayed through this node's own commands.linkSideGroup (operator
// 2026-11-02: NU adopting kg's). Nodes on the same Beeper accounts share chat ids; Rodz's room for each
// group is the peer's stored mouth_chat (same account, same id).
//
//   node src/tools/link-peer-side-groups.mjs <copy of the peer's conversations.yaml> [--peer kg]           # dry run
//   node src/tools/link-peer-side-groups.mjs <copy of the peer's conversations.yaml> [--peer kg] --apply   # write
//
// Kinds: automatic and join (an alias of the chat), split (its own conversation; this node's residents'
// threads in the parent are copied, as a live opener does). The peer's split: { tunnel } is not carried
// (an opener does not carry it): the dry run names it. --apply refuses while this node's spine runs.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCommands } from '../spine/commands.mjs';
import { parse, readState, writeState, CONV_YAML_PATH } from '../conversations-state.mjs';
import { encodeChatCanary, decodeChatCanary } from '../node-signature.mjs';
import { liveDaemonPid } from '../daemon-singleton.mjs';
import { readConfigSync } from './config-io.mjs';
import { EGPT_HOME } from '../egpt-home.mjs';

const KIND_ORDER = { split: 0, automatic: 1, join: 1 };   // a side group's chat may itself be a split

// The peer's side groups: { surface, chatId, kind, origin, transcript, title, mouth, tunnel }.
export function peerSideGroups(peerState) {
  const out = [];
  for (const [surface, bucket] of Object.entries(peerState?.contacts ?? {})) {
    for (const [chatId, e] of Object.entries(bucket ?? {})) {
      const mouth = e?.mouth_chat ?? null;
      if (e?.aliasOf) out.push({ surface, chatId, kind: e.automatic === true ? 'automatic' : 'join', origin: e.aliasOf, transcript: e.transcript ?? null, title: e.transcript ?? null, mouth });
      else if (e?.parent_chat) out.push({ surface, chatId, kind: 'split', origin: e.parent_chat, transcript: null, title: e.pushedName || null, mouth, tunnel: e.split?.tunnel ?? null });
    }
  }
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

// Each peer side group's opener, replayed through linkSideGroup → the group + outcome ('linked',
// 'held' here already, 'not linked') + the lines linkSideGroup logged for it.
export async function linkPeerSideGroups(peerState, { peer = 'peer', getConfig, loadState, writeState: write, io = {} }) {
  const groups = peerSideGroups(peerState);
  // Rodz's copy of each opener, as already arrived on the mouth.
  const copies = groups.filter((g) => g.mouth).map((g) => ({ chatID: g.mouth, text: encodeChatCanary({ group: g.chatId, origin: g.origin, kind: g.kind }) }));
  let logs = [];
  const cmds = createCommands({
    getConfig, loadState, writeState: write, io, chromeHost: null, onLog: (m) => logs.push(m),
    forkBridge: { awaitMouthMessage: async (test) => copies.find(test) ?? null },
  });
  const holds = async (g) => { const e = (await loadState())?.contacts?.[g.surface]?.[g.chatId]; return !!(e?.aliasOf || e?.parent_chat); };
  const out = [];
  for (const g of groups) {
    logs = [];
    const held = await holds(g);
    const canary = decodeChatCanary(encodeChatCanary({ group: g.chatId, origin: g.origin, kind: g.kind, transcript: g.transcript }));
    await cmds.linkSideGroup({ surface: g.surface, chatId: g.chatId, chatName: g.title, fromNode: peer, canary });
    out.push({ ...g, outcome: held ? 'held' : (await holds(g)) ? 'linked' : 'not linked', log: logs });
  }
  return out;
}

// This node's live spine pid (state/spine.pid + a fresh state/alive.txt), or null.
export function liveSpinePid(home = EGPT_HOME) {
  let pidFileContent = '';
  try { pidFileContent = readFileSync(join(home, 'state', 'spine.pid'), 'utf8'); } catch { /* none */ }
  let beatAgeMs = Infinity;
  try { beatAgeMs = Date.now() - statSync(join(home, 'state', 'alive.txt')).mtimeMs; } catch { /* none */ }
  return liveDaemonPid({ pidFileContent, beatAgeMs });
}

// One group: kind, side id → origin, title, mouth room, the peer's tunnel, outcome; then linkSideGroup's own lines.
export function formatRow(r, { dry = false } = {}) {
  const notes = [r.mouth ? `mouth ${r.mouth}` : 'no mouth room', ...(r.tunnel == null ? [] : [`tunnel ${r.tunnel ? 'on' : 'off'} on the peer`])];
  const outcome = dry && r.outcome === 'linked' ? 'would link' : r.outcome;
  return [`  ${r.kind.padEnd(9)} ${r.surface}/${r.chatId} → ${r.origin}  "${r.title ?? ''}"  (${notes.join(', ')})  ${outcome}`, ...r.log.map((l) => `      ${l}`)].join('\n');
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const at = argv.indexOf('--peer');
  const peer = at === -1 ? 'peer' : argv[at + 1];
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--peer');
  if (!file || !peer) { console.error('usage: node src/tools/link-peer-side-groups.mjs <peer conversations.yaml> [--peer <node>] [--apply]'); return 2; }
  const peerState = parse(readFileSync(file, 'utf8'));
  if (apply) {
    const pid = liveSpinePid();
    if (pid) { console.error(`refused: this node's spine runs (pid ${pid}) and writes ${CONV_YAML_PATH} itself — stop it, then --apply`); return 1; }
  }
  const config = readConfigSync();
  let st = apply ? null : await readState(CONV_YAML_PATH);
  const rows = await linkPeerSideGroups(peerState, apply
    ? { peer, getConfig: () => config, loadState: () => readState(CONV_YAML_PATH), writeState: (s) => writeState(CONV_YAML_PATH, s) }
    : { peer, getConfig: () => config, loadState: async () => st, writeState: async (s) => { st = s; }, io: { mkdir: async () => {}, writeFile: async () => {} } });
  console.log(`${apply ? 'linked' : 'dry run'}: ${file} (peer ${peer}) → ${CONV_YAML_PATH}`);
  for (const r of rows) console.log(formatRow(r, { dry: !apply }));
  const n = (o) => rows.filter((r) => r.outcome === o).length;
  console.log(`${n('linked')} ${apply ? 'linked' : 'to link'}, ${n('held')} held here already, ${n('not linked')} not linked.${apply ? '' : ' Nothing written; --apply to write (spine stopped).'}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
