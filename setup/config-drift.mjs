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
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const SKEL_DIR  = 'config/skeletons/room';   // the cards a being is fed — must be identical on both nodes
const SHIPPED_SKEL = join(dirname(fileURLToPath(import.meta.url)), '..', SKEL_DIR);

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

// ---- the CARDS (operator 2026-08-24: "dolly's skeletal path in .egpt must always
// match reve's. never update only one node"). These are markdown, not YAML, so
// shape-diffing says nothing — compare digests. Still no content over the wire.
const sha = (t) => createHash('sha256').update(String(t).replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);
const localSkels = () => { try { return readdirSync(join(EGPT_HOME, SKEL_DIR)).filter((f) => f.endsWith('.md')); } catch { return []; } };
const remoteSkels = () => { try { return ssh(`ls ~/.egpt/${SKEL_DIR} 2>/dev/null || true`).split(/\r?\n/).map((x) => x.trim()).filter((f) => f.endsWith('.md')); } catch { return []; } };

console.log(`\ncards: local vs ${PEER_LABEL}\n`);
const ls = localSkels(), rs = remoteSkels();
if (!ls.length && !rs.length) console.log('  ok    no profile card overrides on either node (both use the shipped cards)');
for (const f of [...new Set([...ls, ...rs])].sort()) {
  const rel = `${SKEL_DIR}/${f}`;
  if (!ls.includes(f)) { drift++; console.log(`  DRIFT ${rel}\n          ${PEER_LABEL} only : the whole file`); continue; }
  if (!rs.includes(f)) { drift++; console.log(`  DRIFT ${rel}\n          local only : the whole file`); continue; }
  const a = sha(localRead(rel)), b = sha(remoteRead(rel));
  if (a === b) console.log(`  ok    ${rel}`);
  else { drift++; console.log(`  DRIFT ${rel}\n          differing content (local ${a} / ${PEER_LABEL} ${b})`); }
}

// A profile card SHADOWS the shipped one. seed.mjs copies it copy-IF-MISSING (so an
// operator edit is never clobbered) and preferNewer() then picks between them by MTIME.
// Seeded once, never refreshed: edit the shipped card and the profile copy keeps the old
// text, waiting for any touch to make it win again. That is how a retired /delete limb
// stayed advertised for days. Identical is fine and self-healing; DIFFERING is the one
// a human has to judge — an intentional edit, or residue from an older deploy.
console.log(`\ncards: profile vs shipped (this node)\n`);
let shadows = 0;
for (const f of ls) {
  const shipped = join(SHIPPED_SKEL, f);
  if (!existsSync(shipped)) { console.log(`  ok    ${f} — profile-only card, nothing shipped to shadow`); continue; }
  const prof = join(EGPT_HOME, SKEL_DIR, f);
  if (sha(readFileSync(prof, 'utf8')) === sha(readFileSync(shipped, 'utf8'))) { console.log(`  ok    ${f} — in sync with the shipped card`); continue; }
  shadows++; drift++;
  const wins = statSync(prof).mtimeMs > statSync(shipped).mtimeMs ? 'the PROFILE copy WINS' : 'the shipped copy wins today, by mtime alone';
  console.log(`  DRIFT ${f}\n          differs from the shipped card — ${wins}.`);
  console.log(`          If that edit was deliberate, keep it. If it is residue, delete the`);
  console.log(`          profile copy — boot re-seeds it from shipped.`);
}
if (ls.length && !shadows) console.log('\n  (no stale card overrides — every profile card matches what ships)');

console.log(drift ? `\n${drift} file(s) drifted.` : '\nno drift.');
process.exit(drift ? 1 : 0);
