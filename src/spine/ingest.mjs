// ingest.mjs — the command ingest box (operator 2026-06-29: "it should be called
// ingest, since the spine CONSUMES from it"). Drop a file in EGPT_HOME/state/ingest
// (operator 2026-07-03: the box lives under state/ now) and the node acts on it; the
// file is consumed (deleted) once read. The classic
// lifecycle commands map to the daemon's respawn exit codes:
//
//   /restart        -> exit 43  (daemon respawns this checkout — picks up commits)
//   /upgrade        -> exit 42  (daemon git pull + npm + build, then respawn)
//   /rewind <ref>   -> exit 44  (daemon checks out <ref>, then respawn)
//   /standdown      -> exit 45  (hand the profile to the waiting Session 1 daemon; the Session 0
//                                daemon holds off until Session 1 lets go — daemon-runtime.mjs)
//
// 43, 42 and 45 are deferred since 2026-09-28 (operator: "yes, restart should wait for turns in
// progress"): boot routes them through spine.drainForRestart(), which KEEPS SERVING and exits at
// the first moment no turn is in flight (capped) — see spine.mjs. Only 44 leaves immediately.
//
// The file CONTENT is the command line ("/restart", "/rewind abc123"). Writers
// should temp->rename for atomicity; the sweep skips dotfiles and *.tmp so a
// half-written file is never read.
//
// `/to <chatId>` (2026-10-26): the lines below it are typed into that chat as the node's owner
// (boot → spine.handleInbound, the limbs' own entry):
//
//   /to tg:-1004408163350/55
//   ed, resume the thread above
//
// The chat must already have a conversations.yaml entry; an unknown id or empty text is ignored.
// `/file <path>` lines attach files. ingest.show posts the line in the chat; ingest.auto false holds
// it until an owner answers the posted question (boot ingestTo / answerIngest).
import { readdir as fsReaddir, readFile as fsReadFile, unlink as fsUnlink, mkdir as fsMkdir, writeFile as fsWriteFile, rename as fsRename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

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

// `/to <chatId>` + message lines → { chatId, text, files }; `/file <path>` lines are the files.
// null = not a /to file.
export function toLine(content) {
  const [head, ...rest] = String(content ?? '').split(/\r?\n/);
  const m = /^\/to\s+(\S+)$/.exec(head.trim());
  if (!m) return null;
  const files = [];
  const text = rest.filter((l) => { const f = /^\/file\s+(.+)$/.exec(l.trim()); if (f) files.push(f[1].trim()); return !f; });
  return { chatId: m[1], text: text.join('\n').trim(), files };
}

// The question under a `/to` line while ingest.auto is false (config ingest.ask overrides it).
export const INGEST_ASK = 'received message, dispatch? reply yes / no';

const YES = new Set(['yes', 'si', 'sí', 'y', 'ok', '👍']);
const NO = new Set(['no', 'n', '👎']);
// An owner's answer to that question: true = dispatch, false = drop, null = not an answer.
export function answerOf(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '').replace(/[.!]+$/, '');
  return YES.has(t) ? true : NO.has(t) ? false : null;
}

// The open questions — { chatId, ids (the posts that ask it), body } — kept in `path` so a restart
// keeps them. No expiry. Rewritten whole, temp + rename.
export function createIngestAsks({ path, io = {}, onLog = () => {} }) {
  const readFile = io.readFile ?? fsReadFile;
  const writeFile = io.writeFile ?? fsWriteFile;
  const rename = io.rename ?? fsRename;
  const mkdir = io.mkdir ?? fsMkdir;
  let asks = [];
  let chain = Promise.resolve();
  const persist = () => (chain = chain.then(async () => {
    const tmp = `${path}.tmp-${process.pid}`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(asks, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  }).catch((e) => onLog(`could not write ${path}: ${e?.message ?? e}`)));
  return {
    async load() {
      try { const d = JSON.parse(await readFile(path, 'utf8')); asks = Array.isArray(d) ? d.filter((a) => a?.chatId && Array.isArray(a.ids)) : []; }
      catch (e) { if (e?.code !== 'ENOENT') onLog(`${path} unreadable (${e?.message ?? e}) — no open questions`); }
    },
    add(ask) { asks = [...asks, ask]; return persist(); },
    // A reaction on Telegram names no topic: `tg:<chat>` finds a question asked in `tg:<chat>/<topic>`.
    find(chatId, id) { return id == null ? null : asks.find((a) => (a.chatId === chatId || a.chatId.startsWith(`${chatId}/`)) && a.ids.includes(String(id))) ?? null; },
    take(ask) { asks = asks.filter((a) => a !== ask); return persist(); },
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
  if (tok === '/standdown' && /^(force)?$/.test(cmd.slice(tok.length).trim())) return 45;
  return null;
}

// `/restart force` / `/upgrade force`: the drain skips its wait for background work (turns are
// still waited for). `/standdown force`: it does not wait for the turns either (background work is
// never waited for there). Same code as the bare command; the callers hand this to announceAndExit.
export function lifecycleForce(line) {
  return /^\/(restart|upgrade|standdown)\s+force$/.test(String(line ?? '').trim());
}
