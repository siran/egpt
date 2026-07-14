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
import { isAutoMode, AUTO_MODES, DEFAULT_AUTO_MODE } from '../auto-mode.mjs';
import { patchContact, getContact, getBeing, slugDir, statsPath, conversationPathOf, listIdentityLayers as defaultListIdentityLayers, DETERMINISTIC_MODEL, DETERMINISTIC_EFFORT, DEFAULT_ALLOWED_TOOLS, READONLY_ALLOWED_TOOLS, KNOWN_SURFACES } from '../conversations-state.mjs';
import { stripFrontMatter } from '../transcript-meta.mjs';
import { initWizard, wizardStep, wizardPrompt } from '../agent-wizard.mjs';
import { BUILTIN_BRAINS_DIR, PROFILE_AGENTS_DIR } from './brains.mjs';
import { coerceAllowedTools } from './brainpool.mjs';
import { stat as fsStat, readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { EGPT_HOME } from '../egpt-home.mjs';
import { shortChatId } from '../bridges/chat-id.mjs';

// Where the `custom` wizard branch AUTHORS its new files (injectable in tests): the
// agent-type YAML lands in config/agents/, a free-text identity layer as a FLAT
// config/identities/<name>.md file (operator 2026-07-03).
export const PROFILE_IDENTITIES_DIR = join(EGPT_HOME, 'config', 'identities');

// The new agent-type file (house comment style, brief). Writes the explicit
// DEFAULT_ALLOWED_TOOLS list (a LIST = CONFINED; the readonly freeze below matches).
// `personality` names the identity layer a fresh conversation of this type boots from.
function customTypeFile(name, model, effort, personality) {
  const toolLines = DEFAULT_ALLOWED_TOOLS.map((t) => `  - ${t}`).join('\n');
  return `# ${name} — custom agent type created via the /e wizard. A brain def (engine config);
# edit freely. Resolution layers (most-specific wins): src/brains < config/agents < <slug>/brains.
type: ${CCODE}
model: ${model}
effort: ${effort}
allowed_tools:        # list tools explicitly (CONFINED); 'all' is accepted but discouraged (never grants bare Bash/Agent)
${toolLines}
personality: ${personality}
`;
}

// A free-text identity layer: JUST the operator's instructions (no comment header — the
// whole file is concatenated into the kickoff feed, so a housekeeping comment would leak
// into the persona). Matches the default layer's plain-markdown convention.
const identityLayerFile = (text) => `${String(text).trim()}\n`;

// The `/e` wizard's model/effort menus (operator 2026-07-02: v1's `/e` supplied
// these same fixed lists — there is no canonical model/effort registry in v2, and
// the agent TYPE file pins concrete values anyway). The agent-type list (step 1) is
// discovered from disk. TTL matches v1's armed-wizard window.
const WIZARD_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const WIZARD_EFFORTS = ['low', 'medium', 'high'];
const WIZARD_TTL_MS = 5 * 60 * 1000;
const CCODE = 'ccode';

// Agent-type names for the wizard's first pick: the built-in defs (src/brains/*.yaml)
// plus the profile's own type files (EGPT_HOME/config/agents/*.yaml), deduped
// (case-insensitively; a profile override of a built-in shows once) and sorted. Same
// two layers the brain registry resolves against — a conversation-only brains/ layer
// is not offered (it's not a reusable type). Never throws (a missing dir is skipped).
function defaultListAgentTypes() {
  const seen = new Set();
  const out = [];
  for (const dir of [BUILTIN_BRAINS_DIR, PROFILE_AGENTS_DIR]) {
    let ents = [];
    try { ents = readdirSync(dir); } catch { continue; }
    for (const f of ents) {
      if (!f.endsWith('.yaml')) continue;
      const name = f.slice(0, -5);
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  }
  return out.sort();
}

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
// otherwise a fuzzy slug/name fragment is matched against contacts. The command's
// OWN surface is searched first (unchanged behavior on a hit there — same-surface
// always wins, even when other surfaces also match); only when the own surface has
// ZERO hits does this fall through to every OTHER known surface (operator 2026-07-05:
// naming a telegram chat from the whatsapp Self DM used to report "no chat matches" —
// resolveTarget never looked past its own surface). The returned object always
// carries the MATCHED `surface`, which may differ from the `surface` param, so
// callers act on the right conversation instead of assuming their own ev.surface.
// Conv-state only: the chat you'd set a mode for is one E has already seen, so it
// is a contact.
function fuzzyHits(state, surface, term) {
  const bucket = state?.contacts?.[surface] ?? {};
  const needle = term.toLowerCase();
  const hits = [];
  for (const [jid, entry] of Object.entries(bucket)) {
    if (!entry || entry.aliasOf || !entry.slug) continue;
    const name = String(entry.pushedName ?? entry.slug);
    if (name.toLowerCase().includes(needle) || String(entry.slug).toLowerCase().includes(needle)) hits.push({ jid, name });
  }
  return hits;
}

function resolveTarget(state, term, surface) {
  if (/[@!]|:beeper/.test(term)) {
    // A verbatim jid must still be a chat E has seen — else patchContact silently
    // no-ops (returns state unchanged) and we'd report a false "✅" for a typo'd or
    // never-seen id. Resolve it through getContact so a bad id fails loudly here.
    // Own surface first, then every other known surface in turn — first found wins
    // (jids are surface-namespaced, so a cross-surface collision isn't a practical
    // concern; no ambiguity handling needed here).
    const c = getContact(state, surface, term);
    if (c) return { jid: c.jid, name: c.slug, surface };
    for (const s of KNOWN_SURFACES) {
      if (s === surface) continue;
      const oc = getContact(state, s, term);
      if (oc) return { jid: oc.jid, name: oc.slug, surface: s };
    }
    return { error: `no chat matches "${term}" — E hasn't seen that chat id` };
  }
  const ownHits = fuzzyHits(state, surface, term);
  if (ownHits.length === 1) return { ...ownHits[0], surface };
  if (ownHits.length > 1) return { error: `"${term}" matches ${ownHits.length}: ${ownHits.slice(0, 6).map((h) => h.name).join(', ')} — be more specific` };
  const crossHits = [];
  for (const s of KNOWN_SURFACES) {
    if (s === surface) continue;
    for (const h of fuzzyHits(state, s, term)) crossHits.push({ ...h, surface: s });
  }
  if (!crossHits.length) return { error: `no chat matches "${term}" — try the exact name or its @jid` };
  if (crossHits.length > 1) return { error: `"${term}" matches ${crossHits.length}: ${crossHits.slice(0, 6).map((h) => `${h.name} (${h.surface})`).join(', ')} — be more specific` };
  return crossHits[0];
}

export function createCommands({
  getConfig = () => ({}),
  send,                                  // (chatId, text) -> deliver a plain system reply
  exit = (code) => process.exit(code),
  writeRewindTarget,
  loadState = null, writeState = null,   // conv-state IO — lets /e auto persist a mode
  brains = null,                         // the brain registry (createBrains) — the /e wizard resolves a picked agent type through it
  defaultKey = 'e',                      // the persona being-id (its map key), injected by boot from the single `default:true` agent — the persona's per-conversation mode/readonly reads+writes and its warm-key prefix all key off this, never a hardcoded 'e' (operator 2026-07-10)
  evictWarm = () => {},                  // (warmKey) -> drop that conversation's warm session so a re-point respawns fresh
  listAgentTypes = defaultListAgentTypes,// () -> string[] agent-type names for the wizard's first pick (injected in tests)
  listIdentityLayers = defaultListIdentityLayers, // () -> string[] identity-layer names for the custom branch's personality pick
  agentsDir = PROFILE_AGENTS_DIR,        // where the custom branch writes <name>.yaml (injected in tests)
  identitiesDir = PROFILE_IDENTITIES_DIR,// where the custom branch writes a free-text identity layer (injected in tests)
  io = {},                               // { stat, readFile, writeFile, mkdir } — real fs by default; /status probes files + the custom branch authors through here
  // git probe for /status (short sha + subject). Mirrors boot's gitOut so it's
  // fakeable in tests without threading spawnSync through createCommands.
  gitOut = (args) => { try { return spawnSync('git', args, { cwd: process.cwd() }).stdout?.toString().trim() || ''; } catch { return ''; } },
  onLog = () => {},
} = {}) {
  const cfg = () => getConfig() ?? {};
  const stat = io.stat ?? fsStat;
  const readFile = io.readFile ?? fsReadFile;
  const writeFile = io.writeFile ?? fsWriteFile;
  const mkdir = io.mkdir ?? fsMkdir;

  // Beeper accounts REGISTRY (operator 2026-07-08, trusted-network chunk c): a NAMED map
  // of this trusted network's Beeper accounts — which account each node fronts + its own
  // API token. v1 is REGISTRY + OBSERVABILITY ONLY: parsed here once (this runs at
  // construction, i.e. once per boot, not once per /status call) and surfaced by /status
  // as name + ACCOUNT ONLY — the token is discarded right here and never held past this
  // block, so it can't leak into /status, a log line, or an error. PHYSICAL FACT: a token
  // only answers on ITS OWN machine's local API, so acting on a sibling's token is future
  // work, not v1. An entry missing `account` is skipped + logged by name; never crashes.
  const beeperAccounts = (() => {
    const raw = cfg().beeper;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [name, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== 'object' || !entry.account) { onLog(`beeper registry: "${name}" missing account — skipped`); continue; }
      out[name] = entry.account;
    }
    return out;
  })();

  // Armed `/e` wizards, keyed by the OPERATOR's chat (where they type the answers) —
  // NOT the target chat (bare `/e` targets here; `/e <slug>` targets elsewhere). Each
  // entry carries the resolved target + the engine its live warm session runs under
  // (for eviction on done) + the arming timestamp (TTL). See armWizard/stepWizard.
  const wizards = new Map();   // chatKey -> { state, surface, chatId, oldEngine, ts }
  const chatKey = (ev) => `${ev?.surface ?? 'whatsapp'}:${ev?.chatId}`;

  // Per-surface self-DM command channels (operator 2026-07-09): the NEW shape lists them under
  // networks:.<surface>.chat_ids (plural); the OLD shape has <surface>.chat_id (singular). Read
  // BOTH, preferring networks:, always yielding a LIST — a command typed in ANY of the surface's
  // command channels is the operator (a singular chat_id normalizes to a 1-element list).
  function commandChatIds(surface) {
    const c = cfg() ?? {};
    const raw = (c.networks?.[surface] && typeof c.networks[surface] === 'object') ? c.networks[surface]
              : (c[surface] && typeof c[surface] === 'object') ? c[surface] : {};
    return Array.isArray(raw.chat_ids) ? raw.chat_ids : (raw.chat_id != null ? [raw.chat_id] : []);
  }
  // The operator gate — reused by isCommand AND the wizard's first-refusal. Same
  // authorization every slash command uses: the origin surface's own Self DM (ids
  // are per-surface namespaces), an authorized sender, or the account owner (isSender).
  function isOperator(ev) {
    // Compare in short space (shortChatId is a no-op on an id that's already short) so a config
    // chat_id in either form still matches the bridge's now-always-short ev.chatId.
    const here = shortChatId(ev?.chatId);
    const inSelfDm = commandChatIds(ev?.surface ?? 'whatsapp').some((id) => shortChatId(id) === here);
    return inSelfDm || !!ev?.authorized || !!ev?.isSender;
  }

  // Is an un-expired `/e` wizard armed for this chat? Prunes an expired one (so an
  // abandoned wizard never lingers past its 5-min window).
  function wizardActive(ev) {
    const wm = wizards.get(chatKey(ev));
    if (!wm) return false;
    if (Date.now() - wm.ts > WIZARD_TTL_MS) { wizards.delete(chatKey(ev)); return false; }
    return true;
  }

  // Same id in any form counts as the Self DM (lid vs phone-form — a /restart
  // often arrives as the @lid self-jid). The Self DM is PER-SURFACE now (operator
  // 2026-07-02): a /restart typed in the telegram surface's own chat_id is checked
  // against cfg.telegram.chat_id, not whatsapp's — ids are per-surface namespaces.
  // Fall back to the whatsapp block when ev.surface is absent (safety). Authorized
  // senders (per-surface allowed_users / isSender) can command from anywhere.
  //
  // An ARMED `/e` wizard gets FIRST REFUSAL on the operator's next message (even a
  // plain, non-slash one — a numbered pick), so it doesn't fall through to E's brain
  // turn. A non-operator message never counts (it routes normally, never touching
  // the wizard). Slash commands while armed still count as commands and route through
  // run() (v1 lets a slash bypass the wizard without cancelling it — matched below).
  function isCommand(ev) {
    const body = String(ev?.body ?? '').trim();
    if (isOperator(ev) && wizardActive(ev)) return true;
    if (!body.startsWith('/')) return false;
    return isOperator(ev);
  }

  async function run(ev) {
    const line = String(ev.body ?? '').trim();

    // Armed `/e` wizard, first refusal: a PLAIN (non-slash) operator message is a
    // numbered/typed answer — step the wizard and stop (never reach E's brain). A
    // slash command falls through to normal dispatch (v1 bypass: the wizard stays
    // armed until answered, cancelled, or TTL-expired). isCommand only routes a plain
    // message here when a wizard is armed, so a bare return after stepping is safe.
    if (!line.startsWith('/')) { await stepWizard(ev, line); return; }

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
        let jid = ev.chatId, where = 'here', targetSurface = ev.surface;
        if (targetTerm) {
          const r = resolveTarget(state, targetTerm, ev.surface);
          if (r.error) { await send?.(ev.chatId, `/e auto: ${r.error}`); return; }
          jid = r.jid; where = `for ${r.name}`; targetSurface = r.surface;
        }
        // The persona is a NESTED being keyed by defaultKey now (operator 2026-07-10) — write
        // its mode into that block (merged over the existing one), NOT a flat entry.mode, so
        // gating reads it back via getBeing(defaultKey).
        const prior = getContact(state, targetSurface, jid)?.entry?.[defaultKey] ?? {};
        await writeState(patchContact(state, targetSurface, jid, { [defaultKey]: { ...prior, mode } }));
        await send?.(ev.chatId, `✅ E mode ${where} → ${mode}`);
      } catch (e) { onLog(`/e auto ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/e auto: failed — ${e?.message ?? e}`); }
      return;
    }

    // /status [<target>] — bare: one compact ops line with live node health (unchanged
    // byte-for-byte). `/status <fragment>` targets a SPECIFIC conversation instead —
    // resolved EXACTLY like `/e auto <mode> <target>` (same resolveTarget) — and reports
    // that conversation's operator-facing facts (§ statusTarget). Every probe in both
    // forms is wrapped: any failure degrades to '?' so /status NEVER throws.
    const statusMatch = /^\/status(?:\s+(.+))?\s*$/i.exec(line);
    if (statusMatch) {
      const target = statusMatch[1]?.trim() || null;
      await send?.(ev.chatId, target ? await statusTarget(ev, target) : await status(ev));
      return;
    }

    // /e (bare) or /e <fragment> — ARM the re-point wizard (v1 parity: a guided
    // agent-type/model/effort pick, not a flag command). Bare targets THIS chat; a
    // fragment resolves the target like /e auto does. `/e auto …` is matched above, so
    // it never reaches here. Must stay AFTER /e auto + /status in the dispatch order.
    const eWiz = /^\/(?:e|egpt)(?:\s+(.+?))?\s*$/i.exec(line);
    if (eWiz) { await armWizard(ev, eWiz[1]?.trim() || null); return; }

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
        try { mode = getBeing(st, ev.surface, ev.chatId, defaultKey)?.mode ?? null; } catch { mode = null; }
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
    // Registry + OBSERVABILITY only (never acted on) — name + account, NEVER the token.
    const beeperNames = Object.keys(beeperAccounts);
    if (beeperNames.length) {
      lines.push('beeper_accounts:');
      for (const name of beeperNames) lines.push(`  ${name}: ${beeperAccounts[name]}`);
    }
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // Distinct participants seen in a transcript's tail: human senders (the
  // dispatch-line "Sender@[chat]…" shape, incl. its stage-direction "[ Sender@…" wrap)
  // and being replies ("[@being (HH:MM)]: …"), being names reported as "@<being>". No
  // member-roster store exists yet — conversation-members.mjs seeds a BRAIN roster from
  // config (residents_per_chat + auto-mode), not who actually spoke, so it doesn't answer
  // "who's in this conversation"; this reads the honest signal that already exists on
  // disk. Pure; `text` is front-matter-stripped first so `name:`/`---` lines never match.
  const _HUMAN_SENDER_RE = /^\[?\s*([^@\s][^@]*?)@\[/;
  const _BEING_REPLY_RE = /^\[@(\S+)\s\(\d{1,2}:\d{2}\)\]:/;
  function membersFromTranscript(text, { tailLines = 200 } = {}) {
    const lines = stripFrontMatter(String(text ?? '')).split('\n').slice(-tailLines);
    const seen = new Set();
    for (const line of lines) {
      const h = _HUMAN_SENDER_RE.exec(line);
      if (h) { seen.add(h[1].trim()); continue; }
      const b = _BEING_REPLY_RE.exec(line);
      if (b) seen.add(`@${b[1]}`);
    }
    return [...seen];
  }

  // /status <fragment> — the operator's per-conversation minimum: target resolved
  // exactly like /e auto's (resolveTarget), one fenced yaml block reporting that
  // conversation's name/path/mode/agent/personality/thread/members. Every probe is
  // independently guarded; a degraded probe shows '?' (or 'unknown'/'not started'
  // where that reads clearer) — this never throws, matching bare /status.
  async function statusTarget(ev, term) {
    if (!loadState) return '/status: conversation state not wired';
    const surface = ev.surface ?? 'whatsapp';   // search origin only; downstream uses r.surface, the resolved TARGET (may differ, 2026-07-05)
    let state, r;
    try {
      state = await loadState();
      r = resolveTarget(state, term, surface);
    } catch (e) { return `/status: failed — ${e?.message ?? e}`; }
    if (r.error) return `/status: ${r.error}`;

    const c = getContact(state, r.surface, r.jid);
    const slug = c?.slug ?? r.name;
    const displayName = c?.entry?.pushedName ?? r.name;

    let convDir = null;
    try { convDir = slugDir(r.surface, slug); } catch { /* non-default surface */ }

    let convPath = c?.entry?.conversation_path;
    if (!convPath) { try { convPath = conversationPathOf(r.surface, slug); } catch { convPath = '?'; } }

    const b = getBeing(state, r.surface, r.jid, defaultKey);
    const mode = b?.mode ?? `${DEFAULT_AUTO_MODE} (default)`;

    // Instanced = this being took a first turn and froze a readonly brain (getBeing's
    // brainType is null until then, matching brainpool's own instanced check). Uninstanced:
    // preview what a first turn would actually pin, composed the same way brainpool's
    // fresh-turn path does — brains.resolve('egpt', …) + coerceAllowedTools + the
    // DETERMINISTIC_MODEL/EFFORT fallbacks — reusing exactly the exports commands.mjs
    // already reaches (brains, coerceAllowedTools, DETERMINISTIC_MODEL/EFFORT,
    // DEFAULT_ALLOWED_TOOLS). This does NOT replicate brainpool's private
    // persona-agent-configuration override lookup (agents.<e/egpt>.configuration is not
    // exported) — it previews the shipped 'egpt' type, which matches the skeleton default
    // and any profile that hasn't repointed the persona; an operator who HAS repointed it
    // sees the shipped default here until the first turn actually pins their override.
    const instanced = !!b?.brainType;
    let previewDef = null;
    if (!instanced) {
      try { previewDef = coerceAllowedTools(brains?.resolve?.('egpt', { convDir })); } catch { previewDef = null; }
    }

    // Personality: resolved the way the brainpool does — the agent TYPE file's
    // `personality:` field, else 'egpt' (brains registry, same layered resolution the
    // /e wizard's preview uses). Uninstanced: resolved from the same default preview above.
    let personality = '?';
    if (b?.agent) {
      try { const def = brains?.resolve?.(b.agent, { convDir }); personality = def ? (def.personality ?? 'egpt') : '?'; }
      catch { personality = '?'; }
    } else if (!instanced) {
      personality = previewDef?.personality ?? 'egpt';
    }

    let members = 'unknown';
    if (convDir) {
      try { members = membersFromTranscript(await readFile(join(convDir, 'transcript.md'), 'utf8')).join(', ') || 'unknown'; }
      catch { members = 'unknown'; }
    }

    // Prefer the per-chat stats file's per-message counters (count + last_seen) when present,
    // each id resolved to a friendly label through the aliases map; degrade to the
    // transcript-derived name list above when the file is missing/unreadable or carries no
    // members (never throws). The stats file now lives OUTSIDE the conversation dir, under
    // state/stats/<surface>/<chatId>.yaml — read it via the module's own path helper (keyed
    // by the chat id r.jid) so this call site can't drift from where the spine writes it.
    if (convDir) {
      try {
        const statsFp = await statsPath(r.surface, r.jid, { name: displayName, io, rename: false });
        const m = YAML.parse(await readFile(statsFp, 'utf8'))?.members;
        if (m && typeof m === 'object' && Object.keys(m).length) {
          const aliases = cfg().aliases ?? {};
          // Label preference: operator-chosen alias > the entry's own name (the sender's push
          // name, written by the collector) > the raw id.
          members = Object.entries(m)
            .map(([id, v]) => `${aliases[id] ?? v?.name ?? id}: ${v?.count ?? 0} (last ${v?.last_seen ?? '?'})`)
            .join(', ');
        }
      } catch { /* no stats file / unreadable → keep the transcript derivation */ }
    }

    // Optional: this conversation's own heartbeat count (source/cwd pinned to convDir),
    // omitted when the readonly view is absent (matches bare /status's optional `mode`).
    let hb = null;
    try {
      const doc = YAML.parse(await readFile(join(EGPT_HOME, 'state', 'heartbeats.readonly.yaml'), 'utf8'));
      if (Array.isArray(doc?.heartbeats) && convDir) hb = doc.heartbeats.filter((h) => h?.source === convDir || h?.cwd === convDir).length;
    } catch { hb = null; }

    // Uninstanced fields fall back to the default preview computed above; instanced
    // fields are the exact expressions this rendered before (regression-lock: an
    // instanced conversation's output is unchanged byte-for-byte).
    const agentVal = instanced ? (b?.agent ?? '?') : (previewDef?.name ?? 'egpt');
    const engineVal = instanced ? (b?.brainType ?? '?') : (previewDef?.type ?? CCODE);
    const modelVal = instanced ? (b?.model ?? '?') : (previewDef?.model ?? DETERMINISTIC_MODEL);
    const effortVal = instanced ? (b?.effort ?? '?') : (previewDef?.effort ?? DETERMINISTIC_EFFORT);
    const toolsRaw = instanced ? b?.allowedTools : (previewDef?.allowed_tools ?? DEFAULT_ALLOWED_TOOLS);
    const toolsVal = Array.isArray(toolsRaw) ? `[${toolsRaw.join(', ')}]` : (toolsRaw ?? '?');

    const lines = [
      `name: ${displayName}`,
      `surface: ${r.surface}`,
      `slug: ${slug}`,
      `conversation_path: ${convPath}`,
      `mode: ${mode}`,
      // Marker: a single line rather than suffixing all six fields below — reads cleaner
      // in the fenced yaml and stays machine-checkable. Omitted when instanced (regression-lock).
      ...(instanced ? [] : ['instanced: false']),
      `agent: ${agentVal}`,
      `engine: ${engineVal}`,
      `model: ${modelVal}`,
      `effort: ${effortVal}`,
      `allowed_tools: ${toolsVal}`,
      `personality: ${personality}`,
      `thread_id: ${b?.threadId ?? 'not started'}`,
      `members: ${members}`,
    ];
    if (hb != null) lines.push(`heartbeats: ${hb}`);
    return '```yaml\n' + lines.join('\n') + '\n```';
  }

  // Arm the `/e` re-point wizard for the operator's chat. `targetTerm` null = THIS
  // chat; otherwise resolve it like /e auto's target (fuzzy slug/name, or a verbatim
  // @jid). Records the target's slug/jid + the engine its live warm session runs
  // under (so `done` can evict exactly that entry). Posts the first numbered prompt.
  async function armWizard(ev, targetTerm) {
    if (!loadState || !writeState) { await send?.(ev.chatId, '/e: conversation state not wired'); return; }
    const surface = ev.surface ?? 'whatsapp';   // search origin only; targetSurface (below) is the resolved TARGET (may differ, 2026-07-05)
    let state, jid, slug, displayName, targetSurface = surface;
    try {
      state = await loadState();
      if (targetTerm) {
        const r = resolveTarget(state, targetTerm, surface);
        if (r.error) { await send?.(ev.chatId, `/e: ${r.error}`); return; }
        jid = r.jid; targetSurface = r.surface;
      } else {
        jid = ev.chatId;
      }
      const c = getContact(state, targetSurface, jid);
      if (!c) { await send?.(ev.chatId, `/e: no chat matches "${targetTerm ?? 'this chat'}" — send a message there first`); return; }
      slug = c.slug; jid = c.jid;
      displayName = c.entry?.pushedName ?? slug;   // operator-facing label (slug carries a date suffix)
    } catch (e) { onLog(`/e arm ${ev.chatId}: ${e?.message ?? e}`); await send?.(ev.chatId, `/e: failed — ${e?.message ?? e}`); return; }

    // Offer only agent types that actually RESOLVE, each carrying its COMPOSITION
    // (model/effort/personality) so step 1 renders a structured-yaml preview. The
    // seeded example file (config/agents/sonnet-high.yaml) is all-comments → parses to
    // null, and a pickable option that then errors on `done` is a poor UX. Keep the raw
    // names only if resolution surprisingly drops everything (misconfig) so the operator
    // isn't stuck.
    let convDir = null; try { convDir = slugDir(targetSurface, slug); } catch { /* non-default surface */ }
    const names = listAgentTypes();
    let configurations = names.map((n) => ({ name: n }));   // fallback: bare names, no preview
    if (brains?.resolve) {
      const resolved = [];
      for (const n of names) {
        let def = null; try { def = brains.resolve(n, { convDir }); } catch { def = null; }
        if (def) resolved.push({ name: n, model: def.model ?? null, effort: def.effort ?? null, personality: def.personality ?? null });
      }
      if (resolved.length) configurations = resolved;
    }
    if (!configurations.length) { await send?.(ev.chatId, '/e: no agent types found (config/agents or src/brains)'); return; }
    // The custom branch's personality pick lists every identity layer (profile + repo);
    // a name colliding with any existing agent type re-prompts (takenNames).
    let personalities = [];
    try { personalities = listIdentityLayers(); } catch { personalities = []; }
    const takenNames = names.map((n) => String(n).toLowerCase());
    // The conversation's CURRENT instanced def marks the matching option `(current)`
    // and its frozen engine keys the warm entry to evict on done (null = never
    // instanced → fall back to the new def's engine at apply time).
    const cur = getBeing(state, targetSurface, jid, defaultKey);
    // The tools-branch "keep current" display: the live frozen list, coerced (a legacy
    // 'all' shows — and later freezes — as the explicit list, never perpetuated).
    const curTools = coerceAllowedTools({ allowed_tools: cur?.allowedTools ?? null })?.allowed_tools ?? null;
    const options = { configurations, models: WIZARD_MODELS, efforts: WIZARD_EFFORTS, personalities, takenNames };
    const current = { configurations: cur?.agent ?? null, models: cur?.model ?? null, efforts: cur?.effort ?? null, tools: curTools };
    const wstate = initWizard({ slug, jid, surface: targetSurface, options, current });
    wizards.set(chatKey(ev), { state: wstate, surface: targetSurface, chatId: ev.chatId, oldEngine: cur?.brainType ?? null, ts: Date.now() });
    await send?.(ev.chatId, `🧩 reconfigure «${displayName}»\n${wizardPrompt(wstate)}`);
  }

  // Feed a plain operator message into the armed wizard. Returns true when consumed
  // (cancel/back/step/done), false when nothing was armed (or it just expired). Only
  // reached for a non-slash operator message that isCommand already gated on.
  async function stepWizard(ev, text) {
    const key = chatKey(ev);
    const wm = wizards.get(key);
    if (!wm) return false;
    if (Date.now() - wm.ts > WIZARD_TTL_MS) { wizards.delete(key); return false; }
    const r = wizardStep(wm.state, text);
    if (r.cancelled) { wizards.delete(key); await send?.(ev.chatId, '(wizard cancelled)'); return true; }
    if (r.done) { wizards.delete(key); await applyWizard(wm, r.result); return true; }
    wm.state = r.state; wm.ts = Date.now();
    await send?.(ev.chatId, r.prompt);
    return true;
  }

  // On done: freeze the picked agent type/model/effort into the TARGET conversation's
  // readonly block (same shape the brainpool instances — keeps the existing threadId,
  // so context survives the re-point), then evict its warm session so the next turn
  // respawns with the new def. Reply terse + factual, /status house style. The `custom`
  // branch first AUTHORS the new type (+ any free-text identity layer), then applies it.
  async function applyWizard(wm, result) {
    if (result.custom) return applyCustomWizard(wm, result);
    if (result.toolsOnly) return applyToolsWizard(wm, result);
    const { surface, jid } = result;
    try {
      const state = await loadState();
      const c = getContact(state, surface, jid);
      const slug = c?.slug ?? result.slug;
      const displayName = c?.entry?.pushedName ?? slug;
      let convDir = null;
      try { convDir = slugDir(surface, slug); } catch { /* non-default surface — resolve without a conv layer */ }
      // 'all'/'*' is REJECTED (operator 2026-07-03) — a hand-written type file that
      // still says it is coerced to the explicit default list before freezing, same as
      // the brainpool's own turn (never a duplicate check — the one chokepoint).
      const def = coerceAllowedTools(brains?.resolve?.(result.configuration, { convDir }));
      if (!def) { await send?.(wm.chatId, `/e: agent type "${result.configuration}" not found`); return; }
      const engine = def.type ?? CCODE;
      // Picking an existing type IS the answer (operator 2026-07-03): apply with the type's
      // PINNED model/effort — no separate model/effort steps — falling back to the
      // deterministic floor when the type omits them (matching the brainpool's freeze).
      const model = result.model ?? def.model ?? DETERMINISTIC_MODEL;
      const effort = result.effort ?? def.effort ?? DETERMINISTIC_EFFORT;
      // Freeze into the persona's NESTED block (operator 2026-07-10 — keyed by defaultKey,
      // merged over the existing block so threadId/mode survive the re-point).
      const prior = c?.entry?.[defaultKey] ?? {};
      await writeState(patchContact(state, surface, jid, {
        [defaultKey]: { ...prior, readonly: { agent: def.name ?? result.configuration, type: engine, model, effort, allowed_tools: def.allowed_tools ?? DEFAULT_ALLOWED_TOOLS } },
      }));
      // The live warm session runs under the OLD engine (or the new one on a never-instanced
      // conversation); the pool keys it `<defaultKey>:<engine>:<surface>:<slug>`.
      evictWarm(`${defaultKey}:${wm.oldEngine ?? engine}:${surface}:${slug}`);
      await send?.(wm.chatId, `✅ «${displayName}» → ${def.name ?? result.configuration} · ${model}/${effort} (respawns next turn)`);
    } catch (e) { onLog(`/e wizard ${wm.chatId}: ${e?.message ?? e}`); await send?.(wm.chatId, `/e: failed — ${e?.message ?? e}`); }
  }

  // The `custom` branch: BUILD a new agent type. Write a free-text identity layer (when
  // the operator described one — named after the type), then the agent-type file, then
  // apply it to the conversation EXACTLY like an existing-type pick (freeze readonly,
  // keep threadId, evict warm). result.name is already sanitized by the wizard.
  async function applyCustomWizard(wm, result) {
    const { surface, jid } = result;
    try {
      const name = result.name;
      if (!name) { await send?.(wm.chatId, '/e: invalid type name'); return; }
      // Personality: a chosen existing layer, or a new layer authored from free text
      // (named after the type so it travels with it).
      let personality = result.personalityLayer || 'egpt';
      if (result.personalityText) {
        personality = name;
        const layerFile = join(identitiesDir, `${name}.md`);   // FLAT identity file (operator 2026-07-03)
        await mkdir(dirname(layerFile), { recursive: true });
        await writeFile(layerFile, identityLayerFile(result.personalityText), 'utf8');
      }
      const typeFile = join(agentsDir, `${name}.yaml`);
      await mkdir(dirname(typeFile), { recursive: true });
      await writeFile(typeFile, customTypeFile(name, result.model, result.effort, personality), 'utf8');

      const state = await loadState();
      const c = getContact(state, surface, jid);
      const slug = c?.slug ?? result.slug;
      const displayName = c?.entry?.pushedName ?? slug;
      const prior = c?.entry?.[defaultKey] ?? {};
      await writeState(patchContact(state, surface, jid, {
        [defaultKey]: { ...prior, readonly: { agent: name, type: CCODE, model: result.model, effort: result.effort, allowed_tools: DEFAULT_ALLOWED_TOOLS } },
      }));
      evictWarm(`${defaultKey}:${wm.oldEngine ?? CCODE}:${surface}:${slug}`);
      await send?.(wm.chatId, `✅ «${displayName}» → ${name} · ${result.model}/${result.effort} (new type created, respawns next turn)`);
    } catch (e) { onLog(`/e wizard custom ${wm.chatId}: ${e?.message ?? e}`); await send?.(wm.chatId, `/e: failed — ${e?.message ?? e}`); }
  }

  // The `tools` branch: edit ONLY allowed_tools, keeping the conversation's current
  // agent/type/model/effort exactly as they are (readonly is written WHOLE — patchContact
  // replaces the key — so every other field is re-read fresh here, not the arm-time
  // snapshot, and carried forward unchanged). 'current' is resolved fresh + coerced, so a
  // legacy frozen 'all' is never re-frozen — it self-heals to the explicit list here too.
  async function applyToolsWizard(wm, result) {
    const { surface, jid } = result;
    try {
      const state = await loadState();
      const c = getContact(state, surface, jid);
      const slug = c?.slug ?? result.slug;
      const displayName = c?.entry?.pushedName ?? slug;
      const cur = getBeing(state, surface, jid, defaultKey);
      let tools;
      if (result.tools === 'default') tools = DEFAULT_ALLOWED_TOOLS;
      else if (result.tools === 'readonly') tools = READONLY_ALLOWED_TOOLS;
      else if (result.tools === 'custom') tools = result.toolsCustom?.length ? result.toolsCustom : DEFAULT_ALLOWED_TOOLS;
      else tools = coerceAllowedTools({ allowed_tools: cur?.allowedTools ?? null })?.allowed_tools ?? DEFAULT_ALLOWED_TOOLS;   // 'current'
      const engine = cur?.brainType ?? wm.oldEngine ?? CCODE;
      const prior = c?.entry?.[defaultKey] ?? {};
      await writeState(patchContact(state, surface, jid, {
        [defaultKey]: {
          ...prior,
          readonly: {
            agent: cur?.agent ?? 'egpt',
            type: engine,
            model: cur?.model ?? DETERMINISTIC_MODEL,
            effort: cur?.effort ?? DETERMINISTIC_EFFORT,
            allowed_tools: tools,
          },
        },
      }));
      evictWarm(`${defaultKey}:${wm.oldEngine ?? engine}:${surface}:${slug}`);
      await send?.(wm.chatId, `✅ «${displayName}» tools → [${tools.join(', ')}] (respawns next turn)`);
    } catch (e) { onLog(`/e wizard tools ${wm.chatId}: ${e?.message ?? e}`); await send?.(wm.chatId, `/e: failed — ${e?.message ?? e}`); }
  }

  return { isCommand, run };
}
