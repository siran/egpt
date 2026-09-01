// brainpool.mjs — the §2b Brain port: run a being's turn through the warm pool
// and return { text, sessionId }. Thin wrapper over the KEPT primitives
// (createWarmPool + the conversation's stored claude session), carrying the §7
// invariants that live at the turn boundary:
//
//   - warm key  `<being>:<engine>:<surface>:<slug>`  (engine = the conversation's
//     brain type, ccode by default; matches dispatch.mjs + compact-being + the
//     warm-sessions tests — the compactor reseeds the SAME key).
//   - session-identity guard: we pass the conversation's stored sessionId as
//     brainOptions.sessionId, which is what arms createWarmPool's re-pin guard
//     (evict+reopen when a different session is requested — the /e-new fix).
//   - context-overflow backstop: "Prompt is too long" — THROWN by the CLI on a
//     result error, OR returned verbatim as the result text — evicts the warm
//     entry and retries ONCE on a FRESH session (no resume). The transcript is
//     the durable record; the chat never sees the overflow string.
//   - identity kickoff: on a FRESH conversation thread, the FIRST user turn is
//     prefixed with the personality's identity feed — the mechanism in place
//     since beta-1 (buildLineagePrelude) and today (readIdentityFeed). NOT a
//     system prompt: that was tried (0b6eecd) and reverted (c46466d) as
//     "unnecessary AND wasteful — the brain accepts being eGPT through the normal
//     conversation." A resumed thread already holds it, so it isn't re-sent.
//
// There are only AGENTS (operator 2026-08-28: "there are no siblings no more. we
// evicted the concept"). Every one under agents[<name>], defaultKey included, resolves
// the same way via resolveBeingDef; .configuration names a type file resolved through
// the brains registry, never frozen into readonly. Every one gets the kickoff feed for
// its own `personality:` (see wrapFresh below), and its thread persists in a per-agent
// NESTED block (recordThread(..., being)).
import { slugDir, getBeing, recordThread, readIdentityFeed, seedIdentityLayers, readAutoModeLayer, appendThreadStat, mutateState, nowIsoString, rollTranscript, stampThreadId, DETERMINISTIC_MODEL, DETERMINISTIC_EFFORT, DEFAULT_ALLOWED_TOOLS } from '../conversations-state.mjs';
// THE wake vocabulary, imported — not re-read here. `handles:` (else the map key) plus the
// CONDITIONAL fallback_handle, exactly as the mention matcher resolves them, so what the card
// tells an agent it answers to can never drift from what actually wakes it (feedConfig below).
import { wakeTokens, fallbackWake } from './router.mjs';
import { Room } from '../room-core.mjs';
import { isContextOverflowError, isDeadSessionError } from '../brain-errors.mjs';
import { parseFrequency } from './heartbeat-loader.mjs';
import { WRITE_TOOLS } from '../claude-args.mjs';
import { loadPermissionLevel } from './permission-levels.mjs';
import { mkdir as fsMkdir, readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as YAML from 'yaml';

// MSYS2/Cygwin "/c/Users/.." → "C:/Users/.." (mirror of warm-cli's normalizeCwd) so an
// msys-form allowed_paths key becomes a real --add-dir root the CLI can match.
function normalizeCwd(p) {
  if (!p) return p;
  const m = String(p).match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// Confinement contract (operator 2026-07-02, "make the comment true"): allowed_tools
// 'all'/'*' (or any non-list value) = TRUSTED/unconfined — buildClaudeArgs bypasses
// permissions and gives full filesystem access. A LIST (a YAML vertical list → an Array)
// = CONFINED: file tools stay path-limited to the conversation dir (cwd) PLUS the def's
// allowed_paths. This is the honest reading of the type file's "by default agents can
// access their conversation directory" comment. Returns brainOptions confinement fields
// ({} when unconfined) to spread into baseOpts → buildClaudeArgs.
//   allowed_paths (a map): key = a path (msys `/c/..` or windows form, normalized); value
//     null/empty        → full-access root   (→ addDirs)
//     { allowed_tools: [list-with-NO-write-tools] } → read-only root (→ readOnlyDirs)
//     { allowed_tools: [list-WITH-write-tools]   } → full access + one log line (per-path
//         tool granularity beyond read-only isn't native — honest approximation)
// ONLY the literal 'all'/'*' is REJECTED (operator 2026-07-03: "better to reject 'all'")
// — coerced to the explicit DEFAULT list, so a type file that says 'all' is treated
// IDENTICALLY to the default vertical list: an Array → confined to its conversation dir,
// explicit tools, no bypass. Any OTHER value passes through untouched — an Array list
// (confined), a space/comma string list (explicit), or absent (downstream default).
// Exported so every caller that resolves a def — turn() below, /e access's live override —
// runs it through this one chokepoint, not a duplicate 'all'/'*' check.
export function coerceAllowedTools(def) {
  if (def && (def.allowed_tools === 'all' || def.allowed_tools === '*')) {
    return { ...def, allowed_tools: DEFAULT_ALLOWED_TOOLS };
  }
  return def;
}

// ALLOW_NEW_INPUT (operator 2026-08-30) — may a message arriving while a turn is ALREADY
// streaming STEER that turn, instead of queueing behind it on the spine's per-conversation
// FIFO? An ORDERED enum, widest last:
//   none         today's behavior — the message queues and is prompted into the NEXT turn.
//   same_sender  a message from the SAME sender whose message triggered the in-flight turn
//                steers it; anyone else queues.
//   any          any sender in the conversation steers the in-flight turn.
//
// DEFAULT same_sender, AND IT HAS ONLY BEEN TESTED WITH ccode. The 2026-08-30 measurement
// that this whole feature rests on drove the real `claude --input-format stream-json` CLI
// and nothing else: an agentic turn absorbs a mid-flight user line at a tool boundary. What
// pi's harness does with one is unknown (untested), and llama is plain HTTP request/response
// with no stream to interrupt at all. Neither exports `inject`, so neither can steer no
// matter what this says — the enum is a POLICY, the session primitive is the CAPABILITY, and
// the capability is what actually gates it (warm-sessions.mjs `steer`).
export const ALLOW_NEW_INPUT_VALUES = ['none', 'same_sender', 'any'];
export const DEFAULT_ALLOW_NEW_INPUT = 'same_sender';

// A typo in config.yaml must NOT take a conversation down — this is a routing preference,
// not a safety gate, and the default is the safe reading either way. So: log it once per
// turn it is read and fall back, never throw (the same forgiveness resolveBeingDef gives a
// type file that omits model/effort).
export function normalizeAllowNewInput(v, being = '?', onLog = () => {}) {
  if (ALLOW_NEW_INPUT_VALUES.includes(v)) return v;
  onLog(`brainpool: ${being} allow_new_input ${JSON.stringify(v)} is not one of ${ALLOW_NEW_INPUT_VALUES.join('|')} — using '${DEFAULT_ALLOW_NEW_INPUT}'`);
  return DEFAULT_ALLOW_NEW_INPUT;
}

// DANGEROUSLY_SKIP_PERMISSIONS (operator 2026-08 meta-engineer): the ONE type-file flag
// that skips coercion AND confinement entirely — a `dangerously_skip_permissions: true`
// type runs genuinely unconfined (full filesystem, its allowed_tools list passed verbatim,
// including bare Bash/Agent), exactly like an interactive `claude` session. Every call site
// below checks it explicitly rather than teaching coerceAllowedTools itself about it, so
// the function stays what its callers already assume: ALWAYS confining. Reachability (who
// may even address an unconfined agent) is gated upstream, in router.mjs/mesh.mjs — this
// file only decides how the TURN runs once addressed.
function confinementFor(def, cwd, onLog) {
  if (def?.dangerously_skip_permissions === true) return {};   // the unconfined tier — no confineToDirs/addDirs/readOnlyDirs, ever
  if (!Array.isArray(def?.allowed_tools)) return {};   // defensive: post-coercion this is always a list
  const addDirs = [], readOnlyDirs = [];
  const paths = (def.allowed_paths && typeof def.allowed_paths === 'object' && !Array.isArray(def.allowed_paths)) ? def.allowed_paths : {};
  for (const [rawPath, grant] of Object.entries(paths)) {
    const p = normalizeCwd(String(rawPath).trim());
    if (!p) continue;
    const tools = (grant && typeof grant === 'object' && !Array.isArray(grant) && Array.isArray(grant.allowed_tools)) ? grant.allowed_tools : null;
    if (tools && !tools.some((t) => WRITE_TOOLS.includes(t))) {
      readOnlyDirs.push(p);   // a tool list with NO write-class tools → read-only
    } else {
      if (tools) onLog(`brainpool: allowed_paths ${p} lists write tools — per-path tool granularity beyond read-only isn't native; granting full access`);
      addDirs.push(p);        // null/empty grant, or a list WITH write tools → full access
    }
  }
  return { confineToDirs: [cwd], ...(addDirs.length ? { addDirs } : {}), ...(readOnlyDirs.length ? { readOnlyDirs } : {}) };
}

// Pure: a conversation's RESOLVED config doc → { idleTtlMs }. The `warm: { idle_ttl }`
// override (operator 2026-07-02) sets THIS conversation's warm idle TTL, beating the class
// TTL: a ms number or a "<qty><unit>" duration (ms/s/m/h), with `0` = always evict this
// conversation (at turn end) and any negative (e.g. `-1`) = keep it always warm (never
// idle-evict). Absent block / unparseable value → null (the
// conversation falls through to the class TTL). Reuses heartbeat-loader's
// parseFrequency for the duration grammar, but parseFrequency rejects 0/negative,
// so both are accepted here explicitly BEFORE delegating (0 and any negative are valid
// values, not garbage).
//
// It takes a DOC, not config.yaml text: `warm:` is one rung-resolved block of the ONE
// namespace now (config/config.yaml < config/conversations.yaml < <conv>/config.yaml), and
// the config resolver hands the merged doc over. A node-wide `warm: { idle_ttl }` therefore
// finally reaches conversations that declare none — it never did while this opened the
// folder file by itself.
export function parseWarmBlock(doc) {
  const w = (doc && typeof doc === 'object' && doc.warm && typeof doc.warm === 'object' && !Array.isArray(doc.warm))
    ? doc.warm : {};
  const v = w.idle_ttl;
  if (v === undefined || v === null) return { idleTtlMs: null };
  if (v === 0) return { idleTtlMs: 0 };               // 0 = always evict (parseFrequency rejects it)
  if (typeof v === 'number' && v < 0) return { idleTtlMs: v };   // any negative = never evict (matches _armIdle's `ttl < 0`; parseFrequency also rejects negatives)
  return { idleTtlMs: parseFrequency(v) ?? null };    // garbage → null
}

// Default identity manifest: the shipped e_identity.md (honoring a config
// brains.identity override / 'off'). The fallback when a personality has no
// identities/<name>/ folder feed.
async function defaultLoadManifest(getConfig) {
  const p = (getConfig() ?? {}).brains?.identity;
  if (p === 'off') return '';
  try {
    return await fsReadFile(p && p !== 'off' ? p : new URL('../../e_identity.md', import.meta.url), 'utf8');
  } catch { return ''; }
}

// The persona agent's `configuration` (config.yaml's `agents:` block) — the agent-type file a
// persona conversation runs on — or null when no default agent is declared. The persona is the
// single `default: true` agent (operator 2026-07-10 — no e/egpt handle test); new-config-only
// (operator 2026-07-02): reads `configuration`, never the retired `type` back-read. Pure, given
// getConfig.
function personaAgentConfigurationFrom(getConfig) {
  const agents = (getConfig?.() ?? {}).agents ?? {};
  for (const [, a] of Object.entries(agents)) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    if (a.default === true) return a.configuration ?? null;
  }
  return null;
}

// THE persona brain def, resolved FRESH from config (operator 2026-08-14, phase 1: no more
// per-conversation freeze — this is the ONLY path now, used on EVERY turn, not just a never-
// instanced conversation's first one). The persona agent's `configuration` resolved through the
// brains registry, else the shipped 'egpt' type (a bare ccode def if even that is absent).
// New-config-only (operator 2026-07-02): NO config.default_brain fallback and NO
// 'default'→'egpt' alias. Exported so every caller that needs the persona's live def — turn()
// below, and commands.mjs's bare `/status <target>` preview (statusTarget) — resolves it the
// SAME way instead of re-deriving a second one (name-the-existing-thing). /e access is
// retired (2026-08-15) — /agents' own status/access_level views resolve through
// resolveBeingDef instead, since they must cover any being, not just the persona.
export function resolveDefaultBrainDef({ getConfig = () => ({}), brains = null, convDir, brainType = 'ccode' } = {}) {
  const configuration = personaAgentConfigurationFrom(getConfig);
  if (configuration) {
    const def = brains?.resolve?.(configuration, { convDir });
    if (def) return def;                                     // persona configuration wins
    // named but unresolvable → fall through to the shipped 'egpt' type
  }
  return brains?.resolve?.('egpt', { convDir }) ?? { name: 'egpt', type: brainType };
}

// Shape a resolved registry def into the brainpool's def contract, letting the agent
// entry override the display name. `claude-code` normalizes to the `ccode` token. Module
// scope (moved out of createBrainPool alongside resolveBeingDef, 2026-08-15, retiring /e's
// defaultKey-only command surface for /agents) — only resolveBeingDef calls this; brainType
// is passed as a param here instead of closed over.
function shapeDef(name, def, agent = {}, brainType = 'ccode') {
  const type = String(def?.type ?? '').toLowerCase() === 'claude-code' ? 'ccode' : (def?.type ?? brainType);
  return {
    name: agent.name ?? def?.name ?? name,
    type,
    model: def?.model ?? null,
    effort: def?.effort ?? null,
    allowed_tools: def?.allowed_tools ?? DEFAULT_ALLOWED_TOOLS,
    allowed_paths: def?.allowed_paths ?? undefined,   // carried so a confined agent's extra roots survive
    cwd: def?.cwd ?? undefined,
    system_prompt: def?.system_prompt ?? undefined,
    // personality (operator 2026-08-14, phase 2 fix): a type file's `personality:` pin, read
    // by turn()'s `def.personality ?? 'egpt'` — this allowlist previously dropped it because
    // shapeDef only ever shaped SIBLING defs, which never consulted it (no identity kickoff).
    // Now that resolveBeingDef shapes the PERSONA's def too, an unshaped personality pin
    // would silently stop reaching loadFeed — carried through here instead.
    personality: def?.personality ?? undefined,
    dangerously_skip_permissions: def?.dangerously_skip_permissions === true,   // carried so an unconfined type file survives shaping
    // verbose_thinking (operator 2026-08-29 ruling, wren's "see your full chain of thought"):
    // carried the same way dangerously_skip_permissions is, so a type file's opt-in survives shaping.
    // STILL LOAD-BEARING after the 2026-08-30 move to config.yaml ("verbose thinking should be
    // controlled from config.yaml rather than the agent.yaml"): that added two config.yaml tiers
    // ABOVE this one (see resolveConv), it did not retire it — this carry IS the bottom tier, and
    // wren's live egpt-xhigh.yaml sets verbose_thinking here and in neither config.yaml tier.
    verbose_thinking: def?.verbose_thinking === true,
  };
}

// THE ONE agent-def resolver (operator 2026-08-14: "remove the concept of siblings" —
// every agent under agents[<name>], defaultKey included, resolves the SAME way; was
// `siblingDef`, and renamed because it no longer is). Its
// `configuration` (configuration ≠ relay) names an agent-type file resolved through the
// brains registry. Never frozen — the def LIVES in config, nothing per-conversation to
// instance. No agent entry / unresolvable configuration → a bare ccode def keyed by the
// being name (keeps it runnable). NOTE: for defaultKey specifically this bare fallback is
// narrower than the old persona-only path it replaces — the old resolveDefaultBrainDef
// fallback additionally tried the shipped 'egpt' brain-type FILE (picking up any local
// customisation of config/agents/egpt.yaml, e.g. a custom allowed_paths/system_prompt/
// personality) before giving up; this bare object skips that file entirely. In today's
// config the two converge in practice (DEFAULT_ALLOWED_TOOLS is byte-for-byte the shipped
// egpt.yaml list, and DETERMINISTIC_MODEL/EFFORT below already match its model/effort), but
// it only converges because those constants happen to mirror the shipped file — this is a
// real, if misconfiguration-only, behaviour difference (only reachable when defaultKey's
// own agent entry names no resolvable `configuration` at all, which boot does not permit
// in the normal case).
//
// PROMOTED TO MODULE SCOPE (operator 2026-08-15, retiring /e's defaultKey-only command
// surface for /agents, which must resolve ANY being in ANY conversation, not just the being
// createBrainPool's own turn() is mid-running for): exported with the same parameter-bag
// convention resolveDefaultBrainDef already uses just above, so commands.mjs's /agents status
// view calls this SAME resolver instead of re-deriving the algorithm a second time
// (name-the-existing-thing). createBrainPool's turn() below now calls this exported version,
// passing its own closure vars, in place of the private closure this used to be.
export function resolveBeingDef(being, convDir, { getConfig = () => ({}), brains = null, brainType = 'ccode' } = {}) {
  const agent = ((getConfig() ?? {}).agents ?? {})[being];
  if (agent && typeof agent === 'object' && !Array.isArray(agent) && String(agent.configuration ?? '').toLowerCase() !== 'relay') {
    const def = brains?.resolve?.(agent.configuration, { convDir }) ?? null;
    if (def) return shapeDef(being, def, agent, brainType);
    // configuration named but no file → fall through to the bare def (keeps the being runnable)
  }
  return {
    name: (agent && typeof agent === 'object' ? agent.name : null) ?? being,
    type: brainType,
    model: null,
    effort: null,
    allowed_tools: DEFAULT_ALLOWED_TOOLS,
  };
}

// THE PROVENANCE FRAME a SCOPED turn's prompt carries (operator 2026-08-31). One instance now
// hears SEVERAL chats: room/acim's E answers in the room AND in every group invited into it, all
// on one thread. The dispatch line already names the chat it came from (`Ana@[perrito
// traducciones].wa (13:25): …`), but on a SHARED thread that name stops being decoration — it is
// the only thing telling the being who is talking, which of its chats this turn belongs to, and
// therefore where the answer it is about to write will be delivered. So a scoped turn says it
// outright, once, above the line. ALL-CAPS lead, matching the two other frames the pipe composes
// around a prompt (transcript-log.mjs's promptWithRecentContext / promptWithQuotedMessage), so a
// being reads all three the same way.
//
// It says nothing about the REPLY PATH because that path is untouched: `out` is opened per
// message by the spine and goes back to the origin whatever this says. This only lets the being
// KNOW that, instead of having to infer it from a chat name it has no reason to read closely.
// Module scope, pure, and NOT exported: turn() is its only caller, and its shape is locked from
// outside through the prompt the warm pool is handed (tests/identity-scope.test.mjs).
function withOrigin(ev) {
  const line = ev?.line ?? ev?.body ?? '';
  const name = (ev?.chatName != null && String(ev.chatName).trim()) ? String(ev.chatName).trim() : String(ev?.chatId ?? '?');
  return `THIS LINE ARRIVED IN "${name}" (${ev?.surface ?? '?'}) — one of the several chats that share this thread, not the conversation the thread is named for. Your reply to it is delivered THERE, to the people in that chat.\n${line}`;
}

export function createBrainPool({
  pool,                              // a createWarmPool instance ({ run, evict })
  getConfig = () => ({}),
  contacts,                          // the shared contact-resolver (createContacts) — slug + rename self-heal
  loadState, writeState,            // conversations-state YAML IO (injected)
  brains = null,                     // the brain registry (createBrains) — resolves the default a fresh conv is instanced from
  defaultKey = 'e',                  // the DEFAULT agent's id (its map key), injected by boot from the single `default:true` agent — never assume 'e' (operator 2026-07-10); all it still gates is the deterministic model/effort floor below
  brainType = 'ccode',               // fallback engine when a brain def / registry is absent
  io = {},
  isOverflow = isContextOverflowError,
  isDeadSession = isDeadSessionError,
  resolveConfig = () => ({}),       // (convDir) -> that conversation's RESOLVED config doc (src/spine/config-resolver.mjs configFor). ONE namespace, three rungs; boot injects the live resolver, tests a canned doc.
  resolveScope = null,              // (being, surface, chatId) -> {surface, chatId}|null — THE IDENTITY SCOPE (src/spine/identity-scope.mjs, operator 2026-08-31). null — the default, and every caller that wires none — means every conversation is its own scope: the four keys below derive from exactly the inputs they derive from today, with no extra read.
  loadFeed = readIdentityFeed,      // (personality, config) -> the persona's full feed
  labelOf = () => '',               // (being) -> its DISPLAY NAME — THE resolver (boot.mjs labelOf: the agents-registry `name:`, NEVER the map key, c346d8e), the SAME function the sender and the transcript service are handed, so the card stamps the name the chat stamps. Fed to the kickoff as {{agent_name}} (feedConfig below). Default '' — an unwired caller (a test) renders that line AWAY rather than leaking a key into an identity card
  seedLayers = seedIdentityLayers,  // (room, personality, {io}) -> copy the fed layers into <room>/identity.d
  loadAutoLayer = readAutoModeLayer,// () -> the `mode: auto` operator-role instruction layer (appended to an auto conversation's kickoff)
  loadManifest = null,              // () -> e_identity.md fallback (default below)
  afterTurn = null,                 // ({key, sessionId, model, cwd, allowedTools}) — post-turn hook (auto-compaction)
  loadPermission = loadPermissionLevel,  // (level) -> {dangerouslySkipPermissions, allowedTools}|null — config/permissions/<level>.md for /agents ... access_level; injectable (tests), NO caching in the real implementation (see permission-levels.mjs)
  onLog = () => {},
} = {}) {
  if (!pool || typeof pool.run !== 'function') throw new Error('createBrainPool: pool (createWarmPool) is required');
  if (typeof contacts?.resolve !== 'function') throw new Error('createBrainPool: contacts (createContacts) is required');
  if (typeof loadState !== 'function' || typeof writeState !== 'function') throw new Error('createBrainPool: loadState + writeState are required');
  const mkdir = io.mkdir ?? fsMkdir;
  const readFile = io.readFile ?? fsReadFile;
  const _loadManifest = loadManifest ?? (() => defaultLoadManifest(getConfig));

  // THE ANSWERING AGENT'S OWN IDENTITY, as feed placeholders — what turns the shipped
  // 00-identity card from one node's hand-written prose into a TEMPLATE (operator 2026-09-01:
  // "we can have it even as a template file with <node_name>, <agent_name>... this helps when
  // egpt is used by other users, they only configure the name in config.yaml for their agents").
  //
  // THE LIVE BUG: do's persona is an eGPT instance NAMED `don` on node `do`, and its identity
  // file said "I am don" — yet the model still answered "Sí, soy eGPT — este hilo es mi nodo,
  // no el de Don". A card can only ASSERT a name it was typed with; it could never BE the agent
  // taking the turn, so every node hand-edited its own copy and they all drifted.
  //
  // The config the feed already receives is the NODE's whole config (passed so cards can quote
  // {{chrome.bin}}), which is why {{node_name}} needed no change here at all. What it carried
  // nothing of is WHICH agent is being fed: turn() knows (`being`), the config does not. These
  // two keys are exactly that gap and nothing more:
  //
  //   {{agent_name}}     labelOf(being) — the agents-registry `name:`, NEVER the map key. ''
  //                      for an agent that declares none, and fillCardPlaceholders DROPS THE
  //                      WHOLE LINE on a blank value, so an unnamed agent renders no stamp
  //                      rather than an empty one. Same rule the reply stamp follows (c346d8e).
  //   {{agent_handles}}  the @tokens it wakes on — wakeTokens (declared `handles:`, else the
  //                      map key) ∪ fallbackWake's CONDITIONAL handles, deduped, in declaration
  //                      order, rendered `@a, @b`. Imported from router.mjs rather than re-read
  //                      here: a second reading of `handles:` is exactly how this repo grew
  //                      three mention systems. '' (an agent addressable by nothing,
  //                      `handles: []`) drops its line too.
  //
  // A FRESH object per kickoff, spread OVER the node config — never a mutation of the shared
  // config object, and the agent taking the turn wins over any same-named top-level key.
  const feedConfig = (being) => {
    const cfg = getConfig() ?? {};
    const agent = (cfg.agents ?? {})[being];
    const handles = [...new Set([...wakeTokens(being, agent), ...(fallbackWake(agent)?.handles ?? [])])];
    return { ...cfg, agent_name: labelOf(being), agent_handles: handles.map((h) => `@${h}`).join(', ') };
  };
  // Last warm-pool key run per conversation (`<being>:<surface>:<chatId>` → warm key).
  // Lets a caller (the spine's per-turn TIMEOUT, DEFECT 2) evict EXACTLY the entry a
  // hung turn is wedged on without re-deriving the engine/slug — a hung CLI must not
  // poison the next turn.
  const lastKeyByConv = new Map();

  // `mode: auto` operator-role layer delivery, tracked per (conversation, thread). A
  // FRESH thread gets the layer inside its identity kickoff (wrapFresh); a RESUMED
  // thread that flipped to auto after it was already running gets it ONCE as a one-time
  // preamble (first turn after the flip). In-memory by design — losing it on restart
  // only re-states a true fact once, never a leak. Bounded so a long-lived node can't
  // grow it without limit.
  const autoDelivered = new Set();
  function markAuto(key) {
    autoDelivered.add(key);
    if (autoDelivered.size > 1000) autoDelivered.delete(autoDelivered.values().next().value);
  }

  // This conversation's warm idle TTL, from the RESOLVED config (the resolver's in-memory
  // set — no file read here any more). Absent block / unparseable → null → class TTL.
  function readWarmTtl(convDir) {
    return parseWarmBlock(resolveConfig(convDir)).idleTtlMs;
  }

  // chatId → { slug, sessionId, mode, accessLevel }. The shared resolver registers the
  // contact on first sight AND re-arms the name-tracking rename; the slug it
  // returns is the CURRENT one. When a rename fired, the warm-pool key below embeds
  // that new slug, so the conversation naturally re-keys onto a fresh warm entry —
  // the stale entry ages out via the pool's LRU, no extra eviction machinery. We
  // then re-read state fresh (the resolver may have just rewritten it — a rename
  // nulls the thread state) for the per-being view.
  //
  // VOCABULARY RETIREMENT (operator 2026-07-02): we no longer read the conversation's
  // `personality` — the identity feed a fresh thread boots from is a property of the
  // resolved agent-type def (def.personality ?? 'egpt'), read at kickoff in turn().
  //
  // THE IDENTITY SCOPE (operator 2026-08-31 — the module header of src/spine/identity-scope.mjs
  // carries the case and the ruling). Resolved FIRST, above, because WHICH conversation this
  // being's instance lives in is upstream of every key derived below it: the thread, the warm
  // key, the conversation dir, and the per-conversation run config. `scoped:false` means the
  // conversation IS its own scope — the only possible answer with no resolveScope injected, and
  // the reason an unscoped node's derivation is byte-identical to what it was before this
  // existed: same address in, same address out, no extra state read, no extra file read.
  //
  // NEVER THROWS. A scope that will not resolve falls back to the conversation itself, because
  // being your own instance is never WRONG — only narrower than the operator asked for — while a
  // half-resolved one would put two processes on one session file.
  async function scopeAddr(being, ev) {
    if (!resolveScope) return { surface: ev.surface, chatId: ev.chatId, scoped: false };
    let s = null;
    try { s = await resolveScope(being, ev.surface, ev.chatId); }
    catch (e) { onLog(`brainpool: scope ${being} ${ev.surface}/${ev.chatId}: ${e?.message ?? e}`); }
    if (!s || (s.surface === ev.surface && String(s.chatId) === String(ev.chatId))) {
      return { surface: ev.surface, chatId: ev.chatId, scoped: false };
    }
    return { surface: s.surface, chatId: s.chatId, scoped: true };
  }

  async function resolveConv(ev, being) {
    const scope = await scopeAddr(being, ev);
    // The ORIGIN's own registration still runs, first and unchanged: it is what re-arms the
    // pushedName refresh and the rename self-heal for the chat the message actually arrived in,
    // and a scoped conversation still owns its folder, its transcript and its media (operator
    // 2026-08-31: a transcript is about the CHAT, not the being — they are not merged).
    const own = await contacts.resolve(ev.surface, ev.chatId, { chatName: ev.chatName });
    // ...and then the SCOPE's own slug — the one every identity key below is built from —
    // WITHOUT the origin's chatName: ensureContact reads pushedName as the chat's own title, so
    // passing it would re-slug (and move on disk) the room after whichever group last spoke into
    // it. Unscoped, this is the SAME single resolve() call it has always been.
    const slug = scope.scoped ? await contacts.resolve(scope.surface, scope.chatId) : own;
    const state = slug ? await loadState() : null;
    const b = state ? getBeing(state, scope.surface, scope.chatId, being) : null;
    // MODE STAYS WITH THE CHAT, alone among the fields read here. Everything else joins the
    // scope; `mode` is the one the SPINE also resolves for this same message (gating.decide, on
    // the ORIGIN conversation, deciding whether this being answers in this chat at all), and two
    // readings of one field would mean a group in `mode: auto` dwelling and impersonating per
    // the origin while its kickoff layer was chosen per the room. getBeing is a PURE function
    // over the state already loaded, so the second view costs no second read.
    const b0 = (state && scope.scoped) ? getBeing(state, ev.surface, ev.chatId, being) : b;
    return {
      scope,
      slug,
      sessionId: b?.threadId ?? null,
      // The conversation's stored E mode — 'auto' arms the operator-role kickoff layer
      // (read raw, not gating-resolved: auto is an explicit per-conversation opt-in).
      mode: b0?.mode ?? null,
      // /e access all|regular (operator 2026-08-14) — applied live, every turn, in turn()
      // below (see the ACCESS-LEVEL OVERRIDE comment). No more `brain` field here (phase 1,
      // 2026-08-14): there is no per-conversation freeze to read any more — turn() always
      // resolves every being's engine/model/effort/tools fresh via resolveBeingDef.
      // GLOBAL-DEFAULT TIER (operator 2026-08-15, same two-tier pattern allowed_users uses):
      // the per-conversation override (above) wins when set; else fall to this node's
      // agents.<being>.conversation_defaults.access_level default (config.yaml, via getConfig
      // — no per-conversation freeze, read fresh every turn like everything else here); else
      // null = no override at either tier (today's ordinary default). conversation_defaults
      // (not a flat sibling of handles/configuration) is the allowlist of which agent fields
      // get this two-tier treatment — see router.mjs's allowed_users read for the twin of this.
      // UNSET RESOLVES TO 'regular' (operator 2026-08-20, refinement of the 2026-08-16
      // structural gate): accessLevel can now only ever be 'all' or 'regular' — an unset
      // value at both tiers is no longer a distinct "undeclared" state that refuses the
      // turn, it explicitly resolves to the confined tier. Gate #1 below (which used to
      // catch the null case) is now unreachable and has been removed accordingly.
      // AND IT JOINS THE SCOPE (operator 2026-08-31, ruled explicitly for acim + "perrito
      // traducciones"): the invited group's members are in his circle of trust, so the ROOM's
      // `all` applies to a turn the group triggers — the group does not keep the 'regular' it
      // would otherwise inherit from the global default. This is safe only because it is
      // `allowed_users` that gates WHO may wake the being (router.mjs/mesh.mjs's reachability
      // check, and the structural gate in turn() below which REFUSES an 'all' being with no
      // allowed_users at either tier) — and room/acim already carries one, as any 'all' being
      // structurally must.
      accessLevel: b?.accessLevel ?? getConfig()?.agents?.[being]?.conversation_defaults?.access_level ?? 'regular',
      // ALLOWED_USERS, same two-tier resolution as accessLevel just above (operator 2026-08-16) —
      // needed here (not just at router.mjs/mesh.mjs's reachability gates) so turn() can refuse to
      // run an accessLevel:'all' being that has no allowed_users set at either tier: unconfined
      // capability + unrestricted reachability is an unsafe combination the operator wants caught
      // structurally (see the STRUCTURAL SAFETY GATES block below).
      allowedUsers: b?.allowedUsers ?? getConfig()?.agents?.[being]?.conversation_defaults?.allowed_users ?? null,
      // SANDBOXED, same two-tier resolution as accessLevel/allowedUsers above (operator
      // 2026-08-20) — OS-level process isolation (setup/sandbox-logon-launcher.ps1) layered
      // on top of accessLevel:'all''s existing CLI-flag-level unconfinement. DEFAULT-ON
      // (operator 2026-08-20, same day): unset at both tiers now resolves to true, not null
      // — every being runs OS-sandboxed unless a tier explicitly opts out with `false`. `??`
      // only falls through on null/undefined, so an explicit `sandboxed: false` at either
      // tier still short-circuits before reaching this fallback.
      sandboxed: b?.sandboxed ?? getConfig()?.agents?.[being]?.conversation_defaults?.sandboxed ?? true,
      // VERBOSE_THINKING, same two-tier resolution as accessLevel/allowedUsers/sandboxed above
      // (operator 2026-08-30: "verbose thinking should be controlled from config.yaml rather
      // than the agent.yaml"). It shipped the day before as a TYPE-FILE-ONLY field, which made
      // the agent-type file the ONLY place to turn it on — far too coarse a knob: every being
      // pointed at that type got it, in every conversation. Nesting it under
      // conversation_defaults is what buys it the per-conversation override (the nesting IS the
      // allowlist — see the accessLevel note above), so one chat can watch a being think without
      // arming the whole node.
      //
      // THIS FIELD ALONE HAS A THIRD TIER, and it is why the fallback here is null rather than
      // false: the type file's own verbose_thinking (carried through shapeDef) is still honoured
      // BELOW these two, applied in baseOpts where `def` finally exists. A `false` fallback here
      // would short-circuit `??` and silently regress wren's live egpt-xhigh.yaml, which declares
      // it on the type file and nowhere else. null = "neither config.yaml tier stated anything —
      // go ask the type file".
      verboseThinking: b?.verboseThinking ?? getConfig()?.agents?.[being]?.conversation_defaults?.verbose_thinking ?? null,
      // ALLOW_NEW_INPUT, same two-tier resolution as accessLevel/allowedUsers/sandboxed
      // above (operator 2026-08-30). Unlike verbose_thinking there is NO third tier: this
      // is a property of a CONVERSATION (who is talking to whom, right now), never of an
      // agent TYPE — a type file could not sensibly say "in every chat, anyone may cut in".
      //
      // The fallback is the LITERAL DEFAULT, not null, because unlike verboseThinking there
      // is no lower tier for a null to defer to — resolution ENDS here, so it must end on a
      // real value. DEFAULT 'same_sender': the person who asked is the person allowed to
      // change their mind mid-answer, which is the case the operator actually asked for;
      // 'any' additionally lets a bystander redirect someone else's live turn, and 'none'
      // is today's byte-for-byte behavior. ONLY TESTED WITH ccode — see the enum's note
      // above; a brain whose session exports no `inject` queues regardless of this value.
      //
      // `??` (not ||) so an explicit `allow_new_input: none` at the per-conversation tier is
      // a real opt-out that stops the walk instead of falling through to a node-wide 'any'.
      // normalizeAllowNewInput runs LAST, over whatever the walk produced, so a typo at
      // EITHER tier is caught and logged rather than reaching the spine as a routing verdict.
      allowNewInput: normalizeAllowNewInput(
        b?.allowNewInput ?? getConfig()?.agents?.[being]?.conversation_defaults?.allow_new_input ?? DEFAULT_ALLOW_NEW_INPUT,
        being, onLog,
      ),
    };
  }

  return {
    /** @returns {Promise<{ text: string, sessionId: string|null, being: string }>} */
    async turn(being, ev, onPartial = () => {}) {
      // `scope` is the address this being's INSTANCE lives at — the conversation itself for
      // every unscoped turn, the room for a chat invited into one. EVERY identity key below
      // derives from it and none from `ev`: thread, warm key, conv dir, run config, transcript
      // roll, thread stats. `ev` still owns what belongs to the MESSAGE — its line, its reply,
      // its own transcript (see resolveConv above).
      const { scope, slug, sessionId, mode, accessLevel, allowedUsers, sandboxed, verboseThinking } = await resolveConv(ev, being);
      if (!slug) throw new Error(`brainpool: no slug for ${scope.surface}/${scope.chatId}`);

      // STRUCTURAL SAFETY GATE (operator 2026-08-16; refined 2026-08-20). Refuses the ENTIRE
      // turn — no engine/LLM invocation, no tool grant of any kind, not even the type file's
      // own baseline allowed_tools — before any being-def resolution below.
      //
      // accessLevel:'all' (unconfined) must never be paired with an empty/unset allowed_users
      // (unrestricted reachability) — that combination is caught here, structurally, rather
      // than left to "unrestricted by default". The escape hatch is the SAME literal "*"
      // wildcard router.mjs/mesh.mjs's allowedUsersPermits recognizes: an explicit ['*'] is a
      // non-empty array, so it already satisfies this check.
      //
      // The former gate #1 here ("accessLevel must be structurally 'all' or 'regular', or the
      // turn refuses") is REMOVED, not left as unreachable dead code: resolveConv's own
      // accessLevel fallback now resolves an unset value to the explicit 'regular' (operator
      // 2026-08-20) rather than null, so accessLevel can only ever be 'all' or 'regular' by the
      // time turn() reads it — that throw could no longer fire.
      if (accessLevel === 'all' && !(Array.isArray(allowedUsers) && allowedUsers.length)) {
        throw new Error(`brainpool: ${being} has access_level 'all' but no allowed_users set — refusing to run (set allowed_users, or ['*'] to explicitly allow anyone)`);
      }

      const convDir = slugDir(scope.surface, slug);
      // 'mode: auto' — every agent's own conversations.yaml mode is eligible (operator
      // 2026-08-14: "remove the concept of siblings" — was default-agent-only; any agent
      // hand-configured `mode: auto` also gets the operator-role kickoff below).
      const wantAuto = mode === 'auto';
      const autoKey = (tid) => `${scope.surface}:${scope.chatId}:${tid}`;
      // A THREAD IS BEING INSTANCED on this turn (no thread yet) — read by the layer seeding: a
      // refresh re-copies the room template, an ordinary turn does not. Being-agnostic: each
      // being's own thread (getBeing(..., being).threadId, read by resolveConv above) is
      // independent of every other resident being's.
      const fresh = !sessionId;
      // THE ONE resolution path (phase 2, operator 2026-08-14): every being's def — the
      // persona included — comes from resolveBeingDef (agents[<being>].configuration names a
      // type file resolved through the brains registry). This is the SAME path a
      // never-instanced conversation always used for the persona (phase 1) — now the ONLY
      // path, for every being, so a config edit (repointing agents.<being>.configuration, or
      // the type file itself) reaches every conversation on its very next turn.
      // dangerously_skip_permissions:true skips coercion (see confinementFor's comment above) —
      // the type file's allowed_tools (which may legitimately include bare Bash/Agent) passes
      // through verbatim rather than being capped to DEFAULT_ALLOWED_TOOLS.
      const rawDef = resolveBeingDef(being, convDir, { getConfig, brains, brainType });
      let def = rawDef.dangerously_skip_permissions === true ? rawDef : coerceAllowedTools(rawDef);   // 'all' → explicit list (rejected)
      let runModel, runEffort;
      if (being === defaultKey) {
        // DETERMINISM (operator 2026-07-02: "don't do 'null means inherit the login default' —
        // make it deterministic"): the persona's RUN must carry CONCRETE model/effort, never
        // null. A type def that omits either falls back to the module constants — logged so a
        // mis-specified type is visible. This is the ONE asymmetry defaultKey still gates:
        // another agent's model/effort stay exactly as configured (may be unset — it can
        // legitimately inherit the CLI login default, or be a local engine that has no
        // notion of either).
        if (def.model == null || def.effort == null) onLog(`type ${def.name} omits model/effort — using deterministic fallback`);
        runModel = def.model ?? DETERMINISTIC_MODEL;
        runEffort = def.effort ?? DETERMINISTIC_EFFORT;
        // THE ROLL (operator 2026-07-25: "there must be a new transcript if thread-id
        // changes"). This is the moment the thread changes, whatever changed it (a deleted
        // threadId, /e reset, a dead session), and it is BEFORE the new thread writes a line.
        // Keyed on the transcript's OWN front matter, so a file that names no thread — a
        // brand-new conversation, or a retry after a turn that threw before recordThread — is
        // left alone. Never throws by contract. PERSONA-ONLY, deliberately NOT generalized by
        // phase 2 (operator 2026-08-14 investigation): transcript.md is ONE FILE PER
        // CONVERSATION FOLDER (Room.transcriptPath), shared by every resident being, not
        // per-being. Rolling it archives (and blanks) that ONE shared file — safe when it is
        // this conversation's only resident, but a SECOND resident being's own fresh-thread
        // event (e.g. its first-ever message here, while the persona is mid-thread) would
        // archive the persona's still-live transcript out from under it: accum-mode's
        // contextSinceLastTurn gap-fill and the quoted-message lookup (transcript-
        // log.mjs) both read this one file, and a resumed CLI session's own history is NOT
        // what would be lost — the shared file's un-resumed record (what every OTHER being
        // and every human said since each being's own last turn) is. Left exactly as today.
        if (fresh) await rollTranscript(scope.surface, slug, { io });
      } else {
        runModel = def.model; runEffort = def.effort;
      }
      // ACCESS-LEVEL OVERRIDE (operator 2026-08-14, was /e access all|regular; phase 2, same
      // day: no longer persona-only — every being's OWN accessLevel, read per-being above via
      // resolveConv/getBeing, is eligible). Runs AFTER the being-def resolution above and
      // BEFORE confinementFor/baseOpts read def.allowed_tools/def.dangerously_skip_permissions
      // below, so it wins regardless of which being this turn is for. permission-levels.mjs
      // re-reads the file fresh on every call (no caching): editing config/permissions/<level>.md
      // changes this turn's grant with no command re-run needed. /agents <handle>|all access_level
      // all|regular (retired /e access's replacement, 2026-08-15) can write ANY being's
      // accessLevel now, not just defaultKey's — closing the asymmetry this comment used to
      // note; an agent given an accessLevel by hand-editing conversations.yaml has always
      // gotten the same live override the default one does.
      if (accessLevel === 'all' || accessLevel === 'regular') {
        const perm = loadPermission(accessLevel);
        if (perm) def = { ...def, dangerously_skip_permissions: perm.dangerouslySkipPermissions, allowed_tools: perm.allowedTools };
      }
      const engine = def.type ?? brainType;
      // The identity-feed selector (operator 2026-07-02): a property of the resolved
      // agent-type def, NOT the conversation. A type file may pin `personality: <name>`;
      // absent, it's 'egpt' (the shipped default).
      const personality = def.personality ?? 'egpt';
      // E works inside the conversation's own folder unless the brain pins a
      // workspace. The dir must exist before the CLI spawns (warm-cli throws on a
      // missing cwd), and the brain runs before transcript creates it — so mkdir here.
      const cwd = def.cwd ?? convDir;
      await mkdir(cwd, { recursive: true });
      // Copy the kickoff layers into the conversation's OWN folder (operator 2026-07-25:
      // "they all get to model at the beginning, but should also be copied for local
      // consult, since by default conversation-e has only access to it's folder"). Copy-
      // if-missing, so it costs a stat per layer and self-heals a conversation that was
      // started before this existed — hence every turn, not only the fresh
      // kickoff (a live conversation resumes forever and would otherwise never get them).
      // ON A REFRESH the copies are OVERWRITTEN (operator 2026-07-26: "all skeleton files are
      // copied on refresh thread") — that is how an edited template (10-actions.md learning
      // /ask) reaches a conversation seeded long ago; copy-if-missing alone never could. A
      // mid-thread turn keeps copy-if-missing so nothing is rewritten under a running E.
      // Targets convDir, NOT cwd: a def that pins a workspace must not have identity.d
      // written into it. EVERY agent gets its identity.d copied into its own conv folder,
      // for local file-tool consult — and since 2026-08-28 that same identity also reaches
      // its live prompt on a fresh thread (see wrapFresh below), so the two no longer
      // disagree.
      // Best-effort by contract (seedIdentityLayers never throws) — never breaks a turn.
      // Room.forChat, not slugDir: seedIdentityLayers is keyed on the Room instance now (a
      // conversation IS a Room), so its own ensureTree/identityDir resolve off convDir too.
      await seedLayers(Room.forChat(scope.surface, slug), personality, { io, overwrite: fresh });

      const key = `${being}:${engine}:${scope.surface}:${slug}`;
      lastKeyByConv.set(`${being}:${ev.surface}:${ev.chatId}`, key);
      // ...and under the SCOPE's address too when the two differ (operator 2026-08-31). evict()
      // and steer() below are SYNCHRONOUS by contract — the spine awaits them, but their return
      // values are a key lookup, not a resolution — so they cannot resolve a scope of their own.
      // Registering both addresses is what lets a wedged entry be evicted, and a live turn be
      // steered, from EITHER end of a joined pair: both names now point at the one warm entry.
      if (scope.scoped) lastKeyByConv.set(`${being}:${scope.surface}:${scope.chatId}`, key);
      // The def's OWN system_prompt and nothing else (operator 2026-08-29): WHO an agent is comes
      // from its identity feed (config/identities/<personality>.md in the 00-identity slot), never
      // from a sentence boot assembles about the node's DEFAULT persona — that addendum told every
      // agent it was "don" while its feed said otherwise.
      const appendSystemPrompt = def.system_prompt;
      const baseOpts = {
        engine,
        cwd,
        allowedTools: def.allowed_tools ?? DEFAULT_ALLOWED_TOOLS,
        ...(runModel ? { model: runModel } : {}),
        ...(runEffort ? { effort: runEffort } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        // Resume the conversation's OWN thread, or null = fresh. NOT
        // default_brain.session_id — that would cross-wire every chat onto one
        // session; the auto-dispatch path keys the session per conversation
        // (dispatch.mjs: convEntry.threadId ?? null).
        sessionId: sessionId ?? null,
        // Confine-by-default: a LIST allowed_tools sandboxes file tools to the conversation
        // dir (cwd) + the def's allowed_paths; 'all' stays trusted/unconfined ({} spread).
        ...confinementFor(def, cwd, onLog),
        // EXPLICIT field (operator 2026-08-17, "make access_level: all finally mean what it
        // says"): buildClaudeArgs reads this to add the actual bypass flags. Named explicitly
        // rather than inferred from the absence of confineToDirs (an existing but ambiguous
        // proxy) — by this point def.dangerously_skip_permissions is EITHER the type file's own
        // trusted base-layer grant (brains.mjs resolve(): conv-local layers can never set or
        // clear it) OR the ACCESS-LEVEL OVERRIDE above (config/permissions/<level>.md, itself
        // only reachable via the STRUCTURAL SAFETY GATES: accessLevel structurally set +
        // allowed_users non-empty + sender matched before this turn ever ran) — never
        // attacker-writable.
        dangerouslySkipPermissions: def.dangerously_skip_permissions === true,
        // verbose_thinking (operator 2026-08-29 ruling; MOVED to config.yaml 2026-08-30 —
        // "verbose thinking should be controlled from config.yaml rather than the agent.yaml").
        // Reaches createWarmCliSession the same way cwd/model/effort do — a plain read into
        // baseOpts, spread by warm-sessions.mjs into makeSession(...brainOptions). Opt-in,
        // default false.
        //
        // THE FULL PRECEDENCE LANDS HERE, and only here, because this is the first point where
        // both halves exist: resolveConv already collapsed the two config.yaml tiers (the
        // per-conversation conversations.yaml override, then agents.<being>.
        // conversation_defaults.verbose_thinking) into `verboseThinking`, null when neither
        // stated anything; `def` — the TYPE FILE, the original and still-live third tier — is
        // only resolved down here. So: per-conversation ?? conversation_defaults ?? type file ??
        // false. `??` (not ||) throughout, so an explicit `verbose_thinking: false` at a HIGHER
        // tier is a real opt-out that stops the walk rather than falling through to a lower
        // tier's `true` — the whole point of adding the config.yaml tiers over a type file one
        // conversation can't otherwise escape. The `=== true` keeps a hand-typed non-boolean
        // (`verbose_thinking: "yes"`) from reaching warm-cli-session as anything but a boolean.
        verboseThinking: (verboseThinking ?? def.verbose_thinking) === true,
        // Plain passthrough (operator 2026-08-20) — boot.mjs's makeSession reads this to pick
        // createSandboxCliSession over createBrainSession. No structural gating beyond this:
        // the STRUCTURAL SAFETY GATES above already refuse the whole turn when accessLevel
        // isn't set, so a sandboxed being still needs its own access_level/allowed_users.
        sandboxed: sandboxed === true,
      };

      // Identity kickoff: prefix the first turn of a fresh thread with the feed,
      // framed as a plain live message (no "installing persona" preamble). The
      // overflow-reset retry re-wraps because its fresh session needs the identity.
      // A SCOPED turn's line is framed with where it came from (withOrigin, above); an unscoped
      // one is the bare dispatch line, byte-for-byte as it has always been.
      const line = scope.scoped ? withOrigin(ev) : (ev.line ?? ev.body);
      const wrapFresh = async () => {
        // EVERY agent gets its own feed. There is no persona/sibling split any
        // more -- the concept was evicted (operator 2026-08-28: "there are no
        // siblings no more... we only have agents now"). Each agent names its own
        // `personality:`, so the feed it gets is ITS identity plus the shared
        // layers, and no agent opens a thread not knowing what /media is or that
        // it has a folder.
        // config passed so the cards can quote it ({{chrome.bin}} etc.) — plus THIS being's own
        // name and handles (feedConfig above), so 00-identity can be one shipped template every
        // agent on every node renders correctly instead of a per-node hand-edit.
        let feed = (await loadFeed(personality, feedConfig(being))) || '';
        if (!feed.trim()) feed = (await _loadManifest()) || '';
        // 'mode: auto': append the operator-role instruction layer to the kickoff feed so
        // a fresh auto thread learns the stance up front. Best-effort (a missing layer just
        // means it gates like 'on'). The overflow/dead-session retry re-wraps, so it re-lands.
        if (wantAuto) {
          const auto = (await loadAutoLayer()) || '';
          if (auto.trim()) feed = `${feed.trim() ? `${feed.trim()}\n\n` : ''}${auto.trim()}`;
        }
        if (!feed.trim()) return line;   // no identity configured → raw line
        return `${feed.trim()}\n\n---\n\nLive message from the chat (envelope \`Sender@[Chat or group name] (HH:MM): body\`):\n${line}`;
      };
      // A RESUMED thread that flipped to auto after it was already running: prepend the
      // operator-role layer ONCE (first turn after the flip) as a plain preamble — the
      // thread already holds its identity, this only adds the auto stance.
      const wrapAutoResume = async () => {
        const auto = (await loadAutoLayer()) || '';
        if (!auto.trim()) return line;
        return `${auto.trim()}\n\n---\n\n${line}`;
      };
      // The FIRST message this turn sends: identity kickoff on a fresh thread, the plain
      // line on a resume — unless a resumed thread just flipped to auto and hasn't been
      // told yet, in which case the one-time auto preamble leads.
      let firstMsg;
      if (!sessionId) {
        firstMsg = await wrapFresh();
      } else if (wantAuto && !autoDelivered.has(autoKey(sessionId))) {
        firstMsg = await wrapAutoResume();
        markAuto(autoKey(sessionId));
      } else {
        firstMsg = line;
      }

      // Per-conversation warm-idle override (operator 2026-07-02): this
      // conversation's own config.yaml `warm: { idle_ttl }` overrides the class TTL
      // (0 = always evict; a negative = keep it always warm). Read per turn from the resolver's in-memory set and
      // re-stamped on the warm entry every run, so a rung edited since the last reload
      // takes effect on the next turn. Applied to BOTH the normal turn and
      // the overflow retry below. (compaction.afterTurn's own pool.run reuses this
      // same warm entry but OMITS idleTtlMs, so it keeps the ttl stamped here — no
      // need to thread the override through it.)
      const idleTtlMs = readWarmTtl(convDir);
      const run = (msg, opts) => pool.run(key, msg, onPartial, { brainOptions: opts, klass: 'conversation', idleTtlMs });

      let r, overflow = false, deadSession = false;
      try { r = await run(firstMsg, baseOpts); }
      catch (e) { if (isOverflow(e?.message)) overflow = true; else if (isDeadSession(e?.message)) deadSession = true; else throw e; }
      // overflow can also arrive as the RESULT text (returned, not thrown).
      if (!overflow && isOverflow(typeof r === 'string' ? r : r?.text)) overflow = true;
      // dead-session backstop (parallel to overflow above): the stored sessionId's
      // resume target is gone from the CLI's own session store (e.g. the profile
      // dir it's keyed under moved/renamed). Same recovery — reset + retry once
      // fresh — mutually exclusive with overflow (only one branch fires per turn).
      if (!overflow && !deadSession && isDeadSession(typeof r === 'string' ? r : r?.text)) deadSession = true;
      if (overflow) {
        onLog(`brainpool: context overflow on ${key} — reset + retry once fresh`);
        pool.evict?.(key);
        r = await run(await wrapFresh(), { ...baseOpts, sessionId: null });
      } else if (deadSession) {
        onLog(`brainpool: dead session ${sessionId} for ${key} — retrying fresh`);
        pool.evict?.(key);
        r = await run(await wrapFresh(), { ...baseOpts, sessionId: null });
      }

      const text = typeof r === 'string' ? r : (r?.text ?? '');
      const newSession = (r && typeof r === 'object' && r.sessionId) || null;
      // Persist a freshly-minted session so the next turn resumes it — being-aware:
      // a nested <being> block for EVERY being (the persona included, operator 2026-07-10).
      // A fresh thread's kickoff already carried the auto layer (wrapFresh) — mark the
      // newly-minted thread delivered so a later RESUMED turn on it doesn't re-inject.
      if (wantAuto && newSession) markAuto(autoKey(newSession));
      if (newSession && newSession !== sessionId) {
        const nowIso = nowIsoString();
        await mutateState(writeState, async () => {
          await writeState(recordThread(await loadState(), scope.surface, scope.chatId, newSession, nowIso, being));
        });
        // THE STAMP: the transcript now names the thread it belongs to. Here because this is
        // the ONE place a new session is recorded — a transcript is born at ingestion, before
        // any thread exists, so the slot can only be filled once the turn mints one. A turn
        // that throws never gets here, and an un-stamped transcript is exactly what the roll
        // above refuses to touch. Never throws by contract.
        await stampThreadId(scope.surface, slug, newSession, { io });
        // Mirror the freshly-minted thread into the per-chat stats file's branchable history
        // (state/stats/<surface>/<chatId>.yaml — a changed threadId appends; the old id stays
        // addressable so a conversation can be branched from it). Keyed by the SCOPE's chatId
        // (the registry key the thread was just recorded under), not the slug and not the chat
        // the message arrived in — a thread has exactly one history, wherever it was woken from.
        // Injectable io, never fatal — the state write is durable.
        try { await appendThreadStat(scope.surface, scope.chatId, { id: newSession, created: nowIso, identity_injected: nowIso }, { io }); } catch { /* non-fatal */ }
      }
      // Auto-compaction hook: after a cooling period the service /compacts this
      // session in place if it grew past ratio. Fire-and-forget — never block the reply.
      try { afterTurn?.({ key, sessionId: newSession ?? sessionId ?? null, model: def.model, cwd, allowedTools: baseOpts.allowedTools }); } catch { /* non-fatal */ }
      return { text, sessionId: newSession ?? sessionId ?? null, being };
    },

    // WHERE THIS BEING'S INSTANCE LIVES for this event — the conversation itself, or the room a
    // `wa-group` membership joined it to (operator 2026-08-31). The spine's per-conversation turn
    // FIFO is the ONE of the four identity keys derived outside this module, and the spine cannot
    // resolve config or rooms.yaml itself, so it asks here — the same division allowNewInput below
    // already draws (resolution lives beside every other field in resolveConv; the caller only
    // formats). Returns an address, never a key, so the turn-key FORMAT stays in the one file that
    // owns it. Read per call, never cached: an invited group joins or leaves on the next message.
    async scopeOf(being, ev) {
      const s = await scopeAddr(being, ev ?? {});
      return { surface: s.surface, chatId: s.chatId };
    },

    // Evict the warm entry for a conversation (DEFECT 2): the spine's per-turn timeout
    // calls this so a wedged CLI process is closed and the queue drains onto a fresh
    // session next turn. Keyed off the last warm key this being+conversation ran (no
    // re-derivation); a no-op if the conversation never opened one.
    evict(being, ev) {
      const k = lastKeyByConv.get(`${being}:${ev?.surface}:${ev?.chatId}`);
      if (k) pool.evict?.(k);
    },

    // This conversation's resolved allow_new_input (operator 2026-08-30). The spine holds
    // the OTHER half of the steer decision — WHO triggered the turn currently streaming —
    // and cannot resolve config itself, so it asks here: resolution stays in resolveConv
    // beside every other two-tier conversation_defaults field, and the spine only compares.
    // Read per call, never cached, exactly like every other field there: an edited config
    // takes effect on the next message, not the next restart.
    async allowNewInput(being, ev) {
      return (await resolveConv(ev, being)).allowNewInput;
    },

    // Weave this message into the turn ALREADY streaming for this being+conversation
    // (operator 2026-08-30). Returns true ONLY if it was genuinely woven in — false means
    // NOTHING happened and the caller must queue an ordinary turn (see warm-sessions
    // `steer`'s injected-or-nothing contract; that is what keeps a false from becoming a
    // reply nobody delivers).
    //
    // Keyed off lastKeyByConv, the SAME lookup evict() uses, and for the same reason: no
    // re-derivation of engine/slug. It is also exact here by construction — a turn can only
    // be in flight because turn() ran and stamped that key on its way to pool.run. And it is
    // what keeps this off turn()'s own path: a steer must NOT re-enter the fresh-thread
    // machinery there (rollTranscript, the identity-feed wrap, an overwrite seedLayers),
    // because a conversation's FIRST turn has no recorded sessionId while it is still in
    // flight — steering it through turn() would post the whole identity feed as the
    // mid-turn message and archive the live transcript out from under it.
    steer(being, ev) {
      const k = lastKeyByConv.get(`${being}:${ev?.surface}:${ev?.chatId}`);
      if (!k) return false;
      return pool.steer?.(k, ev?.line ?? ev?.body ?? '') === true;
    },
  };
}
