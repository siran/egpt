// src/attach/discovery.mjs — how a thin client finds the running nucleus, and
// how the nucleus advertises itself.
//
// The nucleus writes a small sidecar (~/.egpt/state/nucleus.json) on boot with
// its loopback port; clients read it to know where to attach. The auth secret is
// the SAME ~/.egpt/bus.key the CDP bus already uses (loadOrCreateBusKey), so
// there's one shared key for all local egpt IPC, not a new one to manage.
//
// Paths are resolved lazily (per call) from EGPT_HOME so a test or a parallel
// node can point at an isolated home via the EGPT_HOME env var.

import { promises as fs } from 'node:fs';
import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadOrCreateBusKey } from '../tools/bus.mjs';

export { loadOrCreateBusKey };

function egptHome() { return process.env.EGPT_HOME || join(homedir(), '.egpt'); }
export function nucleusInfoPath() { return join(egptHome(), 'state', 'nucleus.json'); }

// Advertise the live nucleus. Atomic write (temp + rename) so a client reading
// concurrently never parses a half-written file.
export async function writeNucleusInfo({ port, version = null, host = '127.0.0.1' }) {
  if (!port) throw new Error('writeNucleusInfo: port required');
  const path = nucleusInfoPath();
  const info = { pid: process.pid, host, port, version, startedAt: Date.now() };
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(info), { mode: 0o600 });
  await fs.rename(tmp, path);
  return info;
}

export function readNucleusInfoSync() {
  try { return JSON.parse(readFileSync(nucleusInfoPath(), 'utf8')); } catch { return null; }
}
export async function readNucleusInfo() {
  try { return JSON.parse(await fs.readFile(nucleusInfoPath(), 'utf8')); } catch { return null; }
}
// Clear ONLY if the sidecar still belongs to us. On /restart the SUCCESSOR
// nucleus may already have written its own nucleus.json by the time our exit
// handler runs; without this guard a dying predecessor deletes the live
// successor's sidecar and clients can never discover the port (observed
// 2026-05-31: nucleus listening on a port, but nucleus.json gone → every client
// stuck "not attached").
export async function clearNucleusInfo() {
  try {
    const cur = await readNucleusInfo();
    if (cur && cur.pid && cur.pid !== process.pid) return;   // a newer nucleus owns it — leave it
    await fs.unlink(nucleusInfoPath());
  } catch {}
}
// Sync variant for the synchronous process 'exit' handler, where awaiting is not
// possible. Same pid-ownership guard.
export function clearNucleusInfoSync() {
  try {
    const cur = readNucleusInfoSync();
    if (cur && cur.pid && cur.pid !== process.pid) return;    // a newer nucleus owns it — leave it
    unlinkSync(nucleusInfoPath());
  } catch {}
}
