// ingest.mjs — the command ingest box (operator 2026-06-29: "it should be called
// ingest, since the spine CONSUMES from it"). Drop a file in EGPT_HOME/state/ingest
// (operator 2026-07-03: the box lives under state/ now) and the node acts on it; the
// file is consumed (deleted) once read. The classic
// lifecycle commands map to the daemon's respawn exit codes:
//
//   /restart        -> exit 43  (daemon respawns this checkout — picks up commits)
//   /upgrade        -> exit 42  (daemon git pull + npm + build, then respawn)
//   /rewind <ref>   -> exit 44  (daemon checks out <ref>, then respawn)
//   /standdown [p]  -> exit 45  (the Session 0 → Session 1 handover: the daemon does NOT
//                                respawn — it watches state/spine.pid AND port p, and comes
//                                back only once neither holds the profile. THE ONLY
//                                DEFERRED ONE: boot routes 45 through spine.standdown(), which
//                                stops admitting turns, drains the ones in flight and only THEN
//                                exits — see spine.mjs. The other three leave immediately.)
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

// The shell editor's self-announce marker (src/shell/spine-link.mjs drops it into ingest as
// it starts dialing). Not a lifecycle command — boot's ingest handle checks this FIRST and
// routes it to the shell-port limb's poke() instead of lifecycleExit, so the editor's own
// announce never gets logged as an unknown command. poke() is normally a no-op (the spine
// already holds the console port from boot); it matters when the spine's BIND failed and it
// is backing off, where the announce makes it retry now. Pure + exported so
// the check is unit-testable in isolation, same as lifecycleExit below.
export const SHELL_CONNECT_MARKER = '/shell-connect';
export function isShellConnectMarker(line) { return String(line ?? '').trim() === SHELL_CONNECT_MARKER; }

// Map a command line to the daemon exit code (+ side effect). Returns the exit
// code to call, or null for an unknown command. Pure + exported so the mapping is
// test-locked separately from the fs sweep.
export function lifecycleExit(line, { writeRewindTarget, writeStanddownTarget } = {}) {
  const cmd = String(line ?? '').trim();
  const tok = cmd.split(/\s+/)[0];
  if (tok === '/restart') return 43;
  if (tok === '/upgrade') return 42;
  if (tok === '/rewind') {
    const ref = cmd.slice(tok.length).trim();
    if (ref) writeRewindTarget?.(ref);
    return 44;
  }
  // /standdown [port] — the successor announcing that it is taking this profile. The PORT is
  // the console port it will serve on, and it reaches the daemon the SAME way /rewind's ref
  // does: a caller-injected writer drops it in EGPT_HOME (standdown-target.txt), the daemon
  // reads-and-consumes it on the exit code (daemon-runtime.mjs's standdownPort). No second
  // mechanism, and nothing is written when no port is named — the daemon already answers that
  // case with the profile's OWN console port, which is the whole point of one port per profile.
  //
  // A MALFORMED PORT IS NOT A STAND-DOWN. `null` here means "unknown command" (boot logs it and
  // ignores it) — deliberately stricter than /rewind's "any ref rewinds", because standing down
  // on a port nobody will hold leaves the profile UNHELD: the daemon would watch a port that
  // never answers and respawn on the first tick, which is a restart wearing a handover's name.
  // The range is validPort's (daemon-runtime.mjs:55), the same one the watcher accepts; the
  // digits-only test is stricter than the daemon's Number() on purpose (see the line).
  if (tok === '/standdown') {
    const arg = cmd.slice(tok.length).trim();
    if (arg) {
      const port = /^\d+$/.test(arg) ? Number(arg) : NaN;   // DIGITS ONLY — bare Number() would read '0x5b57' and '2e4' as ports
      if (!(port > 0 && port < 65536)) return null;
      writeStanddownTarget?.(String(port));
    }
    return 45;
  }
  return null;
}
