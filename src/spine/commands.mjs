// commands.mjs — the §2c command intercept: an operator's slash command (typed
// in the Self DM, or from any authorized sender) is handled HERE, not routed to
// the brain. v2's loop otherwise sends every inbound to E — so "/restart" went to
// the persona instead of bouncing the node.
//
// v1 wires the LIFECYCLE commands (the operator's standing need: control the node
// from Self) via the same exit-code path as ingest. The other ~50 slash/*.mjs
// commands need a richer ctx (sessions, bridge, channels) and land as that ctx is
// built (Phase 4c); until then they are RECOGNIZED (not leaked to E) and answered
// with a short note.
import { lifecycleExit } from './ingest.mjs';
import { isAutoMode, AUTO_MODES } from '../auto-mode.mjs';
import { patchContact, getContact, getBeing } from '../../conversations-state.mjs';
import { stat as fsStat, readFile as fsReadFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';

// Compact uptime: "2h13m" / "13m05s" / "42s". Whole seconds; drops the finest
// unit once hours are in play so /status stays a terse ops line.
function humanizeUptime(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// Resolve a target chat for `/e auto <mode> <target>` (so the operator can set a
// remote chat's mode from the Self DM). A verbatim @jid / room-id is used as-is;
// otherwise a fuzzy slug/name fragment is matched against the surface's contacts —
// exactly one must match (else: not-found / ambiguous). Conv-state only: the chat
// you'd set a mode for is one E has already seen, so it is a contact.
function resolveTarget(state, term, surface) {
  if (/[@!]|:beeper/.test(term)) {
    // A verbatim jid must still be a chat E has seen — else patchContact silently
    // no-ops (returns state unchanged) and we'd report a false "✅" for a typo'd or
    // never-seen id. Resolve it through getContact so a bad id fails loudly here.
    const c = getContact(state, surface, term);
    if (!c) return { error: `no chat matches "${term}" — E hasn't seen that chat id` };
    return { jid: c.jid, name: c.slug };
  }
  const bucket = state?.contacts?.[surface] ?? {};
  const needle = term.toLowerCase();
  const hits = [];
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!entry || entry.aliasOf || !entry.slug) continue;
    const name = String(entry.pushedName ?? entry.slug);
    if (name.toLowerCase().includes(needle) || String(entry.slug).toLowerCase().includes(needle)) hits.push({ jid, name });
  }
  if (!hits.length) return { error: `no chat matches "${term}" — try the exact name or its @jid` };
  if (hits.length > 1) return { error: `"${term}" matches ${hits.length}: ${hits.slice(0, 6).map((h) => h.name).join(', ')} — be more specific` };
  return hits[0];
}

export function createCommands({
  getConfig = () => ({}),
  send,                                  // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
  loadState = null, writeState = null,   // conv-state IO — lets /e auto persist a mode
  io = {},                               // { stat, readFile } — real fs by default; /status probes alive.txt + heartbeats.readonly.yaml through here
  // git probe for /status (short sha + subject). Mirrors boot's gitOut so it's
  // fakeable in tests without threading spawnSync through createCommands.
  gitOut = (args) => { try { return spawnSync('git', args, { cwd: process.cwd() }).stdout?.toString().trim() || ''; } catch { return ''; } },
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};
  const stat = io.stat ?? fsStat;
  const readFile = io.readFile ?? fsReadFile;

  // Same id in any form counts as the Self DM (lid vs phone-form — a /restart
  // often arrives as the @lid self-jid). The Self DM is PER-SURFACE now (operator
  // 2026-07-02): a /restart typed in the telegram surface's own chat_id is checked
  // against cfg.telegram.chat_id, not whatsapp's — ids are per-surface namespaces.
  // Fall back to the whatsapp block when ev.surface is absent (safety). Authorized
  // senders (per-surface allowed_users / isSender) can command from anywhere.
  function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (!body.startsWith('/')) return false;
    const selfDm = cfg()[ev?.surface ?? 'whatsapp']?.chat_id;
    return (selfDm && ev.chatId === selfDm) || !!ev.authorized || !!ev.isSender;
  }

  async function run(ev) {
    const line = String(ev.body ?? '').trim();
    const code = lifecycleExit(line, { writeRewindTarget });
    if (code != null) {
      onLog(`${line} -> exit ${code}`);
      await exit(code);                    // process leaves (after the bridge's "restarting…" announce); the daemon respawns
      return;
    }

    // /e auto <mode> [<target>] — set a conversation's E reply-mode (modes live in
    // conversations.yaml now). In a chat: omit <target> to set THIS chat. From the
    // Self DM: name the target chat (slug/name fragment, or its @jid / room-id).
    const auto = /^\/(?:e|egpt)\s+auto\s+(\S+)(?:\s+(.+?))?\s*$/i.exec(line);
    if (auto) {
      const mode = auto[1].toLowerCase();
      const targetTerm = auto[2]?.trim() || null;
      if (!isAutoMode(mode)) { await send?.(ev.chatId, `/e auto: unknown mode "${mode}" — use one of: ${AUTO_MODES.join(', ')}`); return; }
      if (!loadState || !writeState) { await send?.(ev.chatId, '/e auto: conversation state not wired'); return; }
      try {
        const state = await loadState();
        let jid = ev.chatId, where = 'here';
        if (targetTerm) {
          const r = resolveTarget(state, targetTerm, ev.surface);
          if (r.error) { await send?.(ev.chatId, `/e auto: ${r.error}`); return; }
          jid = r.jid; where = `for ${r.name}`;
        }
        await writeState(patchContact(state, ev.surface, jid, { mode }));
        await send?.(ev.chatId, `✅ E mode ${where} → ${mode}`);
      } catch (e) { onLog(`/e auto ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/e auto: failed — ${e?.message ?? e}`); }
      return;
    }

    // /status — one compact ops line with live node health. Every probe is
    // wrapped: any failure degrades to '?' so /status NEVER throws (a broken git
    // checkout / missing profile file must still yield a reply).
    if (/^\/status\b/i.test(line)) {
      await send?.(ev.chatId, await status(ev));
      return;
    }

    const tok = line.split(/\s+/)[0];
    await send?.(ev.chatId, `${tok}: recognized — lifecycle (/restart, /upgrade, /rewind) + /e auto <mode> + /status are wired in v2 so far.`);
  }

  // Assemble the /status report as a fenced YAML block (operator 2026-07-02: the
  // old prose line inlined the full git subject and rendered as a wall of text —
  // fences render as monospace in WhatsApp/Beeper). Runs IN the spine process, so
  // it reads process-local liveness (pid/uptime) + this profile's state files.
  // Each probe is independently guarded; a degraded probe shows '?', never aborts.
  async function status(ev) {
    let sha = '?', subject = '';
    try { sha = gitOut(['rev-parse', '--short', 'HEAD']) || '?'; } catch { sha = '?'; }
    try { subject = gitOut(['log', '-1', '--format=%s']) || ''; } catch { subject = ''; }

    const pid = process.pid;
    let up = '?';
    try { up = humanizeUptime(process.uptime()); } catch { up = '?'; }

    // Liveness = the alive.txt MTIME age (boot's alive heartbeat rewrites it each tick).
    let beat = '?';
    try {
      const s = await stat(join(EGPT_HOME, 'state', 'alive.txt'));
      beat = `${Math.max(0, Math.round((Date.now() - s.mtimeMs) / 1000))}s`;
    } catch { beat = '?'; }

    // Heartbeat count = entries in the spine-written readonly view (tolerate absence).
    let hb = '?';
    try {
      const doc = YAML.parse(await readFile(join(EGPT_HOME, 'state', 'heartbeats.readonly.yaml'), 'utf8'));
      if (Array.isArray(doc?.heartbeats)) hb = String(doc.heartbeats.length);
    } catch { hb = '?'; }

    // Conversations = non-alias, slugged contacts across every surface. Reuse the
    // same loaded state for THIS chat's E mode (cheap; omitted if unresolvable).
    let convs = '?', mode = null;
    try {
      const st = loadState ? await loadState() : null;
      if (st) {   // null = state unresolvable → leave convs '?', not a false 0
        let n = 0;
        for (const bucket of Object.values(st.contacts ?? {})) {
          for (const entry of Object.values(bucket ?? {})) {
            if (entry && !entry.aliasOf && entry.slug) n++;
          }
        }
        convs = String(n);
        try { mode = getBeing(st, ev.surface, ev.chatId, 'e')?.mode ?? null; } catch { mode = null; }
      }
    } catch { convs = '?'; }

    // First line "egpt: <sha> · <subject>" with the WHOLE line truncated to 60
    // chars + '…' (the untruncated subject was the wall the operator flagged).
    // No subject → "egpt: <sha>"; a failed sha probe → "egpt: ?".
    const val = sha === '?' ? '?' : (subject ? `${sha} · ${subject}` : sha);
    let egptLine = `egpt: ${val}`;
    if (egptLine.length > 60) egptLine = `${egptLine.slice(0, 60)}…`;

    const lines = [
      egptLine,
      `pid: ${pid}`,
      `up: ${up}`,
      `beat: ${beat} ago`,
      `heartbeats: ${hb}`,
      `conversations: ${convs}`,
    ];
    if (mode) lines.push(`mode: ${mode}`);
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  return { isCommand, run };
}
