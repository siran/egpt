// ingest.mjs — the command ingest box (operator 2026-06-29: "it should be called
// ingest, since the spine CONSUMES from it"). Drop a file in EGPT_HOME/state/ingest
// (operator 2026-07-03: the box lives under state/ now) and the node acts on it; the
// file is consumed (deleted) once read. The classic
// lifecycle commands map to the daemon's respawn exit codes:
//
//   /restart        -> exit 43  (daemon respawns this checkout — picks up commits)
//   /upgrade        -> exit 42  (daemon git pull + npm + build, then respawn)
//   /rewind <ref>   -> exit 44  (daemon checks out <ref>, then respawn)
//
// The file CONTENT is the command line ("/restart", "/rewind abc123"). Writers
// should temp->rename for atomicity; the sweep skips dotfiles and *.tmp so a
// half-written file is never read.
import { readdir as fsReaddir, readFile as fsReadFile, unlink as fsUnlink, mkdir as fsMkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function createIngest({ dir, handle, intervalMs = 1000, io = {}, onLog = () => {} } = {}) {
  if (!dir) throw new Error('createIngest: dir is required');
  if (typeof handle !== 'function') throw new Error('createIngest: handle is required');
  const readdir = io.readdir ?? fsReaddir;
  const readFile = io.readFile ?? fsReadFile;
  const unlink = io.unlink ?? fsUnlink;
  const mkdir = io.mkdir ?? fsMkdir;

  let timer = null, sweeping = false;

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      let names = [];
      try { names = await readdir(dir); } catch { return; }   // dir not created yet — nothing to do
      for (const name of [...names].sort()) {
        if (name.startsWith('.') || name.endsWith('.tmp')) continue;   // in-flight write
        const p = join(dir, name);
        let content = '';
        try { content = await readFile(p, 'utf8'); } catch { continue; }
        try { await unlink(p); } catch { /* consume once */ }
        try { await handle(String(content ?? '').trim(), name); }
        catch (e) { onLog(`ingest ${name}: ${e?.message ?? e}`); }
      }
    } finally { sweeping = false; }
  }

  return {
    async start() {
      try { await mkdir(dir, { recursive: true }); } catch { /* best effort */ }
      timer = setInterval(() => { sweep(); }, intervalMs);
      timer.unref?.();
      await sweep();   // pick up anything already waiting
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    sweep,   // exposed for tests
  };
}

// Map a command line to the daemon exit code (+ side effect). Returns the exit
// code to call, or null for an unknown command. Pure + exported so the mapping is
// test-locked separately from the fs sweep.
export function lifecycleExit(line, { writeRewindTarget } = {}) {
  const cmd = String(line ?? '').trim();
  const tok = cmd.split(/\s+/)[0];
  if (tok === '/restart') return 43;
  if (tok === '/upgrade') return 42;
  if (tok === '/rewind') {
    const ref = cmd.slice(tok.length).trim();
    if (ref) writeRewindTarget?.(ref);
    return 44;
  }
  return null;
}
