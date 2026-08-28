#!/usr/bin/env node
// setup/config-drift.mjs — does this node's config SHAPE match the peer's?
//
//   node setup/config-drift.mjs                 # compare against the default peer
//   node setup/config-drift.mjs --peer dolly    # ssh target
//   node setup/config-drift.mjs --peer "-p 2222 an@192.168.1.102"
//
// Nodes legitimately differ in VALUES (dolly runs a 3B, reve a 26B; dj-son's
// heartbeat lives only on dolly). What must not drift is which KEYS exist: a key
// one node has and the other lacks is a half-finished change, or a config the
// other node silently ignores. Exactly how @l existed on reve and not on dolly.
//
// Only key paths cross the wire — never values. config.yaml holds beeper_token
// and relay_password.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EGPT_HOME } from '../src/egpt-home.mjs';
import { shapeOf, diffShapes, dropPerNode } from '../src/tools/config-shape.mjs';

const argv = process.argv.slice(2);
const peerArg = argv[argv.indexOf('--peer') + 1];
// The peer must present a POSIX shell: `ssh dolly` lands in Windows cmd, where
// `cat` and `||` do not exist. Dolly runs an MSYS2 sshd on 2222 — that is the
// endpoint to name. Override with --peer or EGPT_PEER.
const PEER = (argv.includes('--peer') && peerArg) || process.env.EGPT_PEER || '-p 2222 an@192.168.1.102';
const PEER_LABEL = (PEER.split('@')[1] || PEER.split(' ').pop() || PEER).trim();   // short, for the report

const FILES = ['config/config.yaml', 'config/rooms.yaml', 'config/conversations.yaml'];
const AGENT_DIR = 'config/agents';

const localRead = (rel) => { try { return readFileSync(join(EGPT_HOME, rel), 'utf8'); } catch { return ''; } };
const localList = () => { try { return readdirSync(join(EGPT_HOME, AGENT_DIR)).filter((f) => f.endsWith('.yaml')); } catch { return []; } };

function ssh(cmd) {
  const args = [...PEER.split(' ').filter(Boolean), cmd];
  try { return execFileSync('ssh', args, { encoding: 'utf8', timeout: 60000 }); }
  catch (e) { throw new Error(`ssh ${PEER}: ${e?.message ?? e}`); }
}
// cat over ssh, one file; missing file -> '' rather than a failure
const remoteRead = (rel) => { try { return ssh(`cat ~/.egpt/${rel}`); } catch { return ''; } };   // missing file -> ''
const remoteList = () => {
  try { return ssh(`ls ~/.egpt/${AGENT_DIR} 2>/dev/null || true`).split(/\r?\n/).map((s) => s.trim()).filter((f) => f.endsWith('.yaml')); }
  catch { return []; }
};

let drift = 0;
const report = (label, a, b) => {
  const d = diffShapes(dropPerNode(a), dropPerNode(b));
  if (!d.onlyA.length && !d.onlyB.length) { console.log(`  ok    ${label}`); return; }
  drift++;
  console.log(`  DRIFT ${label}`);
  for (const k of d.onlyA) console.log(`          local only : ${k}`);
  for (const k of d.onlyB) console.log(`          ${PEER_LABEL} only : ${k}`);
};

console.log(`config shape: local vs ${PEER_LABEL}\n`);
for (const rel of FILES) report(rel, shapeOf(localRead(rel)), shapeOf(remoteRead(rel)));

const lf = localList(), rf = remoteList();
for (const f of [...new Set([...lf, ...rf])].sort()) {
  const rel = `${AGENT_DIR}/${f}`;
  if (!lf.includes(f)) { drift++; console.log(`  DRIFT ${rel}\n          ${PEER_LABEL} only : the whole file`); continue; }
  if (!rf.includes(f)) { drift++; console.log(`  DRIFT ${rel}\n          local only : the whole file`); continue; }
  report(rel, shapeOf(localRead(rel)), shapeOf(remoteRead(rel)));
}

console.log(drift ? `\n${drift} file(s) drifted.` : '\nno drift.');
process.exit(drift ? 1 : 0);
