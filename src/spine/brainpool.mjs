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
import { slugDir, getBeing, recordThread, patchBeing, readIdentityFeed, seedIdentityLayers, readAutoModeLayer, appendThreadStat, mutateState, nowIsoString, rollTranscript, stampThreadId, DETERMINISTIC_MODEL, DETERMINISTIC_EFFORT, DEFAULT_ALLOWED_TOOLS } from '../conversations-state.mjs';
// THE wake vocabulary, imported — not re-read here. `handles:` (else the map key) plus the
// CONDITIONAL fallback_handle, exactly as the mention matcher resolves them, so what the card
// tells an agent it answers to can never drift from what actually wakes it (feedConfig below).
import { Room } from '../room-core.mjs';
// The room's ./directives/config.readonly.yaml (operator 2026-09-24) and the mode ladder it states.
import { renderConfigBlock, writeConfigCard } from './being-config-card.mjs';
import { resolveMode } from './gating.mjs';
// The chat line a compaction leaves behind, and the per-conversation override the service reads -
// both owned by the compaction policy, never re-spelled here (operator 2026-09-24).
import { compactedNotice } from './compaction.mjs';
import { compactionOverrideOf } from '../tools/compact-being.mjs';
// WHICH APPROVED TARGET a room's outbox/ is drained to, resolved by the ONE owner of that walk
// (the boot sweep is the other reader) — see src/room-outbox.mjs. The conversation names a KEY;
// only config.yaml's `outbox_targets:` map ever holds a path.
import { resolveOutboxTarget } from '../room-outbox.mjs';
import { isContextOverflowError, isDeadSessionError } from '../brain-errors.mjs';
import { parseFrequency } from './heartbeat-loader.mjs';
import { WRITE_TOOLS } from '../claude-args.mjs';
import { loadPermissionLevel, isAccessLevel } from './permission-levels.mjs';
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
// THE ONE `allowed_paths` WALK. Extracted 2026-09-05 because it now has TWO consumers that
// must never disagree about what a being's declared paths ARE: confinementFor below (the CLI
// layer — `--add-dir` / read-only deny rules) and sandboxSharePathsFor below that (the OS
// layer — the launcher's per-turn ACE). A copy would be a second thing to keep correct, and
// the two layers disagreeing is exactly the bug being fixed: a folder Claude Code permits and
// the kernel then refuses.
//
// PURE and grant-classifying only: `{ addDirs, readOnlyDirs }`, in declaration order, with
// blank/whitespace keys dropped and each key normalizeCwd()'d. It knows NOTHING about tiers —
// no dangerously_skip_permissions check, no allowed_tools check. Those are the CALLERS' own
// early returns, and that asymmetry is the whole point of the split (see sandboxSharePathsFor).
//
// onLog defaults to a no-op so the second consumer does not double-log the one line this walk
// emits: confinementFor passes the real logger, the share-path accessor deliberately does not.
//
// IT STILL READS ONE PLACE — `def.allowed_paths` — and that is deliberate after the node-level
// grant landed (2026-09-20). The node's own `allowed_paths:` is merged INTO the def by
// withNodeAllowedPaths, at resolveBeingDef, so by the time either consumer runs there is nothing
// left to merge: one walk, one map, and the CLI list and the share list cannot disagree about
// what the node granted. Teaching this walk about config.yaml instead would have given
// sandboxSharePathsFor (which is handed a def and nothing else) a second answer to the question.
function allowedPathsFor(def, onLog = () => {}) {
  const addDirs = [], readOnlyDirs = [];
  const paths = (def?.allowed_paths && typeof def.allowed_paths === 'object' && !Array.isArray(def.allowed_paths)) ? def.allowed_paths : {};
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
  return { addDirs, readOnlyDirs };
}

// A SANDBOXED TURN GETS NO CWD ROOT (operator ruling 2026-09-23). The turn's cwd is a per-lease
// junction, C:\Users\egpt-sbx-NN\egpt, that the launcher plants AFTER leasing an account — a name
// the spine cannot know when it builds argv, and must not learn: making these two teach each
// other about the pool would couple the CLI layer to the lease.
//
// WHY THE ROOT HAD TO GO, measured live 2026-09-23. The `egpt` mount landed and a sandboxed being
// asked `pwd` still answered
//   /c/Users/an/.egpt/conversations/whatsapp/Reencuentro CRC 1991-2026-2607161314
// The process cwd really WAS the junction; the leak was the ARGV. `confineToDirs: [cwd]` carried
// the Room's real path, claude-args unions every confine root into `--add-dir`, and the CLI
// reports the spelling it was TOLD about. So the being was handed the operator's username and a
// third party's conversation name and quoted them into a group chat - which is the whole thing
// the mount exists to stop.
//
// AND DROPPING IT COSTS NOTHING, because for a sandboxed being the OS box IS the boundary
// (operator, same day): the leased account holds an ACE on exactly the Room and its declared
// share paths and nothing else, enforced by the kernel on every open. `--add-dir` was never a
// boundary here anyway - these beings hold bare Bash.
//
// AND SINCE 2026-09-23 THE WHOLE CLI GATE GOES, not just the root (operator: "and so
// --permission-mode [should] be none at all. free roam inside the sandbox"). claude-args.mjs
// emits no `--add-dir` and no deny rules under `osConfined`.
//
// ...AND THE FEEDING GOES WITH IT, later the same day (operator: "we are not using allowed_paths
// from the CLI nor allowed_tools; these restrictions are OS enforced"). `addDirs`/`readOnlyDirs`
// were still RETURNED to the CLI layer after it had stopped being allowed to use them — a second
// consumer kept alive with nothing to consume, which is a standing invitation for some later
// argv line to read one and quote an operator path again. `allowed_paths` now has exactly ONE
// consumer, sandboxSharePathsFor, which is the layer that actually enforces.
//
// THE WALK STILL RUNS for a boxed being, and that is deliberate rather than leftover: it is what
// emits the one per-path "granularity isn't native" warning, exactly once per turn (the share
// accessor deliberately passes no logger). Its ANSWER is discarded here; its diagnostic is not.
// The alternative — teaching sandboxSharePathsFor to log — would give the one walk two places
// that decide when to speak, which is the drift this split exists to prevent.
//
// IT IS NOT THE 2026-09-05 DEFECT IN REVERSE. That defect was the OS granting a path the CLI
// then refused to use. Here the OS still grants it — the per-lease ACE is untouched — and the
// CLI refuses nothing at all. See claude-args.mjs for why a bypass on a sandboxed being is not a
// widening: the account is the boundary, and bare Bash was never path-gated anyway.
//
// PLATFORM FALLS OUT OF `sandboxed` FOR FREE, and that is the point of keying on it: on a
// non-win32 node the default resolves false (see resolveSandboxed), there is no OS box, and the
// cwd root stays exactly as it was - the CLI confinement is the only boundary there and it keeps
// being it.
//
// `osConfined` IS AN EXPLICIT FIELD, not the absence of confineToDirs, for the same reason
// `dangerouslySkipPermissions` was made one (see baseOpts): buildClaudeArgs derives "confined"
// from it, so a sandboxed turn still gets --permission-mode default and still does NOT
// pre-approve file tools. Only `--setting-sources ''` is retired there, deliberately - see
// claude-args.mjs.
function confinementFor(def, cwd, onLog, sandboxed = false) {
  if (def?.dangerously_skip_permissions === true) return {};   // the unconfined tier — no confineToDirs/addDirs/readOnlyDirs, ever
  if (!Array.isArray(def?.allowed_tools)) return {};   // defensive: post-coercion this is always a list
  const { addDirs, readOnlyDirs } = allowedPathsFor(def, onLog);   // for the WARNING; the answer is the OS layer's
  // THE BOXED TIER GETS THE TIER AND NOTHING ELSE. No root, no path lists — the leased
  // account's ACEs are the boundary, and sandboxSharePathsFor is what writes them.
  if (sandboxed === true) return { osConfined: true };
  return {
    confineToDirs: [cwd],
    ...(addDirs.length ? { addDirs } : {}),
    ...(readOnlyDirs.length ? { readOnlyDirs } : {}),
  };
}

// THE OS-LAYER CONSUMER of the same walk: every path a being's `allowed_paths` declares, for
// sandbox-cli-session.mjs to hand the launcher so the leased pool account gets a real ACE on
// each. `{ writable, readOnly }`, each in declaration order — the SAME two classes
// confinementFor gets, kept apart all the way down to the launcher's `-SharePath` and
// `-SharePathReadOnly`, which grant Modify and ReadAndExecute respectively.
//
// TWO LISTS, NOT ONE, and that is the whole point of this function (rewritten 2026-09-13). It
// used to return `[...addDirs, ...readOnlyDirs]` and the launcher had exactly ONE ACE mode,
// Modify — so a path declared read-only was read-only at the CLI layer (readOnlyDenyRules) and
// WRITABLE at the filesystem layer. The sandboxed beings on this node hold Bash and PowerShell,
// so one shell command wrote straight past the deny rule; and under the `all`/`sandbox` tiers,
// where there is no CLI layer at all, nothing enforced it anywhere. Flattening the classes HERE
// is what made the two layers disagree, which is the one thing this walk exists to prevent.
//
// NO dangerously_skip_permissions EARLY RETURN, and that is the entire reason this is a
// separate function rather than a field of confinementFor's return. confinementFor returns {}
// for the `all` and `sandbox` tiers, so those beings have no addDirs at all — the CLI layer is
// DELIBERATELY off for them, and an ACE is therefore the ONLY way a shared folder is reachable
// under exactly the tiers most likely to declare one. Gating this on the same flag would leave
// the widest tiers with no OS-layer grant, which is the bug, not the fix.
//
// The allowed_tools guard is dropped for the same reason: a being with no allowed_tools list
// still has an `allowed_paths` block that says which folders it is meant to reach.
//
// READ-ONLY PATHS ARE INCLUDED, in their own list, never dropped: excluding them would
// reproduce the original defect for exactly those paths — permitted by Claude Code, unreadable
// to the kernel. Read access is the point of declaring them.
export function sandboxSharePathsFor(def) {
  const { addDirs, readOnlyDirs } = allowedPathsFor(def);   // no onLog: confinementFor already emitted that line this turn
  return { writable: addDirs, readOnly: readOnlyDirs };
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

// The persona agent's KEY, its ENTRY and its `configuration` (config.yaml's `agents:` block) —
// the def a persona conversation runs on, as a type-file name OR an inline map — or nulls when no
// default agent is declared. The persona is the
// single `default: true` agent (operator 2026-07-10 — no e/egpt handle test); new-config-only
// (operator 2026-07-02): reads `configuration`, never the retired `type` back-read. Pure, given
// getConfig. The KEY comes back too so brains.resolve can NAME the agent when a `configuration`
// is unusable — an error that says which agent is misconfigured is the whole point of it being
// loud. The ENTRY comes back for the personality ladder below, which reads an AGENT-LEVEL
// `personality:` that lives on the entry and not on the def (operator 2026-09-10).
function personaAgentConfigurationFrom(getConfig) {
  const agents = (getConfig?.() ?? {}).agents ?? {};
  for (const [key, a] of Object.entries(agents)) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    if (a.default === true) return { key, agent: a, configuration: a.configuration ?? null };
  }
  return { key: null, agent: null, configuration: null };
}

// ── THE PERSONALITY LADDER, in ONE place (operator 2026-09-10) ────────────────────────────────
// "egpt is a personality/identity, not a brain config." A brain def is named for WHAT IT IS —
// `haiku-low`, `opus-xhigh`, fifteen of them ship — and is SHARED by every being pointed at it; a
// personality is a file, config/agents/identities/<name>.md. A being COMPOSES one of each, so
// `personality:` is read at the AGENT level in config.yaml, sibling of `configuration:`:
//
//   ken:
//     configuration: opus-xhigh   # a SHARED def — no per-being file needed
//     personality: ken            # config/agents/identities/ken.md
//
// Until this rung that was impossible, and the impossibility had a file to show for it: a STRING
// `configuration:` resolves to a SHARED type file, and brains.mjs merges an inline map with
// nothing — so the only way to give one being its own identity on a shared engine was a PRIVATE
// COPY of the shared def with `personality:` bolted on.
//
// THE RUNGS, most specific first: the agent entry, then the resolved def. The last rung — 'egpt'
// — is deliberately NOT here: it belongs to whoever is about to USE the name (turn(), /status),
// and resolveIdentityFile applies the same default again to a blank one. `undefined` when neither
// tier states one, so a shaped def still looks exactly as it did to every `?? 'egpt'` downstream.
//
// ONE DEFINITION, TWO CALLERS — shapeDef (every being's live def, which turn() feeds from) and
// resolveDefaultBrainDef (the persona preview /status prints). That is one ladder named once, not
// a second lookup: a status view that resolved the personality its own way would eventually print
// something the turn it claims to preview does not run.
const personalityFor = (agent, def) => agent?.personality ?? def?.personality ?? undefined;

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
  const { key, agent, configuration } = personaAgentConfigurationFrom(getConfig);
  // The persona's personality reads the SAME ladder every other being's does (personalityFor,
  // operator 2026-09-10). OVERLAID, not shaped: this returns the def RAW — /status prints its
  // `name`, and running it through shapeDef would start printing the agent entry's name instead —
  // and the overlay is skipped entirely when the ladder yields nothing, so a def that states no
  // personality still comes back without the key, byte-for-byte as before. WHY IT MATTERS: the
  // /status block prints `personality: <x>` and calls it "exactly what brainpool.mjs's turn()
  // feeds a fresh thread's kickoff". With the rung only in shapeDef that sentence would become
  // false the first time an operator wrote `personality:` beside `configuration:`.
  const withPersonality = (def) => { const p = personalityFor(agent, def); return p === undefined ? def : { ...def, personality: p }; };
  if (configuration) {                                       // an INLINE MAP is truthy too — both forms land here
    const def = brains?.resolve?.(configuration, { convDir, agent: key });
    if (def) return withPersonality(def);                    // persona configuration wins
    // named but unresolvable → fall through to the shipped 'egpt' type
  }
  return withPersonality(brains?.resolve?.('egpt', { convDir }) ?? { name: 'egpt', type: brainType });
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
    // SINCE 2026-09-10 the agent's OWN `personality:` outranks that pin, which is why this reads
    // the ladder (personalityFor) rather than the def alone: `agent` was already a parameter here
    // — shapeDef has always let the config.yaml entry override the def's `name` — so the being's
    // identity is decided in the same place, from the same two objects, as its display name.
    personality: personalityFor(agent, def),
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

// ── THE NODE-LEVEL `allowed_paths:` (operator 2026-09-20) ────────────────────────────────────
// "all agents see an src/ directory, it is actually interesting to have a my-code/ pointing to
// src/egpt, we can 'leak' my own src/ to the agent (read-only for now)".
//
// THE PATH THAT ASK PRODUCED — `C:/Users/an/src` — WAS RETIRED ON 2026-09-23 (operator: "dismiss
// mounting ~/src always, that was a faux-pas"). A sandboxed being now reaches the eGPT checkout
// through the `src` junction in its own pool profile, backed by a STANDING group ACE on
// ~\src\egpt, so it needs no allowed_paths entry to see its own code. THE MECHANISM BELOW IS
// UNCHANGED and is still how a node grants a path to every being at once; it is the one ENTRY
// that went, and it goes from config, not from here (setup/migrations owns that).
//
// A read grant used to be per TYPE FILE: config/agents/sonnet-default.yaml carried E's
// `allowed_paths: { C:/Users/an/src/egpt: { allowed_tools: [Read, Glob, Grep] } }`, and granting
// the same folder to a second being meant writing that block into a second file. That is the
// drift this repo keeps paying for — and REVOKING it meant finding every copy. config.yaml's own
// top-level `allowed_paths:` is the one place to grant and the one place to revoke: it is merged
// into EVERY being's def here, at resolution, so both consumers of the one walk (allowedPathsFor
// → confinementFor's CLI `--add-dir`/deny rules, and sandboxSharePathsFor's OS-layer ACE list)
// read the merged map from the SAME `def` field they already read. No second resolution path, and
// therefore no way for the two layers to disagree about what the node granted — which is the bug
// class this whole walk exists to prevent.
//
// THE DEF WINS. A being that names the SAME path keeps its own entry, whatever its class: the
// node grant sits UNDER the def's own, so a narrower per-being grant is never widened by a
// node-wide one written later. Paths are compared EXACTLY AS allowedPathsFor will read them
// (trimmed, normalizeCwd'd), so a def writing `/c/Users/an/src` and a node writing
// `C:/Users/an/src` are ONE path, not two — two spellings of one folder landing in two grant
// classes is exactly the double-ACE the launcher must never be handed. It is the walk's own
// reading and nothing more: a config that spells one folder two ways in CASE (`c:/users` vs
// `C:/Users`) still declares two paths here, exactly as it already does inside a single
// allowed_paths block — case folding would be a Windows answer in an OS-agnostic file.
//
// UNTOUCHED WHEN THERE IS NOTHING TO MERGE: no node block, or every node path already claimed by
// the def, returns the def OBJECT ITSELF — a being on a node that grants nothing keeps the def
// shape it had, `allowed_paths` key and all (absent stays absent).
function withNodeAllowedPaths(def, config) {
  const pathMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const node = pathMap(config?.allowed_paths);
  if (!node) return def;
  const own = pathMap(def?.allowed_paths) ?? {};
  const claimed = new Set(Object.keys(own).map((k) => normalizeCwd(String(k).trim())));
  const extra = Object.entries(node).filter(([k]) => !claimed.has(normalizeCwd(String(k).trim())));
  if (!extra.length) return def;
  return { ...def, allowed_paths: { ...own, ...Object.fromEntries(extra) } };
}

// THE ONE agent-def resolver (operator 2026-08-14: "remove the concept of siblings" —
// every agent under agents[<name>], defaultKey included, resolves the SAME way; was
// `siblingDef`, and renamed because it no longer is). Its
// `configuration` (configuration ≠ relay) is resolved through the brains registry — as a NAME
// (config/agents/<name>.yaml) or as an INLINE MAP written straight into config.yaml, brains.mjs
// takes both. Never frozen — the def LIVES in config, nothing per-conversation to
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
export function resolveBeingDef(being, convDir, { getConfig = () => ({}), brains = null, brainType = 'ccode', configuration = null, onLog = () => {} } = {}) {
  // The node's own config, read ONCE: its `agents:` map names this being, and its top-level
  // `allowed_paths:` is the node-wide read grant every def leaves here carrying
  // (withNodeAllowedPaths, above — applied at BOTH returns, so a being with no resolvable
  // configuration is granted the same folders as one with).
  const config = getConfig() ?? {};
  const agent = (config.agents ?? {})[being];
  // `configuration: relay` is a WORD, so only a STRING can be it (operator 2026-09-07). The old
  // `String(agent.configuration ?? '')` coercion happened to give the right answer for the new
  // inline-map form — '[object Object]' is not 'relay' — but it got there by stringifying a def,
  // which is exactly the kind of accident that stops being right later. Ask the question directly.
  const isRelay = typeof agent?.configuration === 'string' && agent.configuration.toLowerCase() === 'relay';
  if (agent && typeof agent === 'object' && !Array.isArray(agent) && !isRelay) {
    // THE CONVERSATION'S OWN `configuration:` (operator 2026-09-17: "we need to honor the key in
    // conversations.yaml"). `configuration` is conversations.yaml's agents.<being>.configuration
    // for the conversation this being's instance lives in — read by resolveConv beside
    // accessLevel, so it joins the scope — or null where none is stated, which leaves this
    // function exactly as it was. SAME two forms, SAME brains.resolve, so a bad value is refused
    // by the very code that refuses a bad config.yaml one.
    //
    // What differs is what the refusal COSTS. conversations.yaml is hand-edited and never checked
    // at boot, so it must not take the being down: it is logged every turn it is read (the "loud
    // at the point of use" shape of resolveConv's sandbox contradiction) and the being runs on its
    // config.yaml configuration, the answer it had before that line was written. A NAME with no
    // type file is refused too: config.yaml's tier drops to the bare def below for that, but a
    // typo in one chat must not quietly swap the being's model for the CLI default.
    let def = null;
    if (configuration != null) {
      const own = agent.configuration;
      const instead = `running on config.yaml's configuration (${typeof own === 'string' ? own : (own ? 'an inline map' : 'none')}) instead`;
      try {
        def = brains?.resolve?.(configuration, { convDir, agent: being, source: 'conversations.yaml' }) ?? null;
        if (!def) onLog(`brainpool: agent '${being}' has an unusable \`configuration\` in conversations.yaml — '${configuration}' names no config/agents/${configuration}.yaml (${convDir}); ${instead}`);
      } catch (e) {
        onLog(`brainpool: ${e?.message ?? e} (${convDir}); ${instead}`);
      }
    }
    def ??= brains?.resolve?.(agent.configuration, { convDir, agent: being }) ?? null;
    if (def) return withNodeAllowedPaths(shapeDef(being, def, agent, brainType), config);
    // configuration named but no file → fall through to the bare def (keeps the being runnable)
  }
  return withNodeAllowedPaths({
    name: (agent && typeof agent === 'object' ? agent.name : null) ?? being,
    type: brainType,
    model: null,
    effort: null,
    allowed_tools: DEFAULT_ALLOWED_TOOLS,
    // The AGENT's own `personality:` survives the bare fallback (operator 2026-09-10). What is
    // missing on this path is the DEF — a `configuration:` naming a file that does not resolve —
    // and the identity was never the def's to begin with. Dropping it here would answer a typo in
    // `configuration:` by silently running the being as eGPT while config.yaml plainly says
    // otherwise. `undefined` when the entry states none, i.e. exactly the shape this object had.
    personality: personalityFor(agent, null),
  }, config);
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

// ── THE `sandboxed` RESOLUTION ─────────────────────────────────────────────────────────────
// OS-level process isolation (setup/sandbox-logon-launcher.ps1) layered on top of
// accessLevel:'all''s CLI-flag-level unconfinement. FOUR RUNGS, highest first, one per line —
// extracted 2026-09-13 from a single-line ternary-plus-`??`-chain whose precedence was legible
// only in the prose above it, which is how a live config's `sandboxed: false` going DEAD under
// `access_level: sandbox` stayed invisible to everyone reading the code. Same answers, same
// order: `!= null` is exactly `??`'s fall-through condition, and a tier's value is returned
// VERBATIM, never coerced, so a rung that answered still answers exactly what it answered.
//
// DEFAULT-ON (operator 2026-08-20): unset at both tiers resolves true, not null — every being
// runs OS-sandboxed unless a tier explicitly opts out with `false`.
//
// AND THE DEFAULT IS PLATFORM-AWARE (operator 2026-09-04: "egpt is meant to be run in an OS
// agnostic way. im on windows so i want it work for me to the fullest. but a beeper account +
// whatsapp account is enough to unleash all agents, like it has always been"). The isolation
// this flag buys is Windows machinery (LogonUser + a per-folder ACE), so unset resolves `true`
// on win32 — byte-identical to the 2026-08-20 default-on, Windows loses nothing — and `false`
// everywhere else, where that same default failed a fresh clone on its FIRST turn with a bare
// spawn ENOENT that named a shell binary instead of the feature.
//
// A DEFAULT MAY BE PLATFORM-AWARE BECAUSE IT IS A DEFAULT — nobody asked for it, so it is ours
// to pick per node. AN EXPLICIT REQUEST MAY NOT BE: a tier that says `sandboxed: true` resolves
// true on EVERY platform. Downgrading it here would make the config key a lie — "sandboxed:
// true" while running unsandboxed — so sandbox-cli-session.mjs refuses the session loudly on a
// non-win32 node instead, naming the feature and the fix. RESOLUTION HERE; REFUSAL THERE.
//
// AND access_level:'sandbox' FORCES IT TRUE (operator 2026-09-05) — which is why it is rung 1.
// That tier means "all's capability, but only inside the OS box": the kernel-enforced boundary
// REPLACES the CLI-enforced one rather than layering over it, so a rung answering false would
// leave the being unconfined at BOTH levels and make the level's own name a lie. It is an
// EXPLICIT REQUEST in precisely the sense the paragraph above defends, so it is platform-blind
// for the same reason — resolution here, refusal in sandbox-cli-session.mjs.
export function resolveSandboxed(args) {
  return resolveSandboxedRung(args).value;
}

// ...AND WHICH RUNG ANSWERED (operator 2026-09-24, for the room's config.readonly.yaml): the same
// four rungs, returning the value together with the rung that produced it, so the card can say
// why a being is boxed without a second copy of the order. resolveSandboxed is this, minus the rung.
export function resolveSandboxedRung({ accessLevel, conversationValue, agentDefaultValue, platform }) {
  if (accessLevel === 'sandbox') return { value: true, rung: 'level' };                        // 1. the LEVEL forces the box (2026-09-05)
  if (conversationValue != null) return { value: conversationValue, rung: 'conversation' };  // 2. this being, in THIS conversation (conversations.yaml)
  if (agentDefaultValue != null) return { value: agentDefaultValue, rung: 'agent' };         // 3. agents.<being>.conversation_defaults.sandboxed (config.yaml)
  return { value: platform === 'win32', rung: 'platform' };                                  // 4. nobody asked → the platform-aware default (2026-09-04)
}

// THE ONE CONTRADICTION those rungs can be handed: `access_level: sandbox` (rung 1, which forces
// the box) beside a lower rung asking to be UNBOXED. Rung 1 wins, so that `sandboxed: false` is
// DEAD config that reads as though it did something — the exact misreading this extraction was
// ordered over. Named ONCE here so the two places that refuse to hold it quietly cannot disagree
// about what it IS: boot.mjs makes it fatal for the config.yaml tier (cfg is read once at boot,
// so boot is the moment), and resolveConv logs it every turn for the conversations.yaml tier
// (hand-edited per conversation, never fixed at boot, so the turn is the only honest moment).
export function isSandboxContradiction(accessLevel, sandboxedValue) {
  return accessLevel === 'sandbox' && sandboxedValue != null && !sandboxedValue;
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
  seedLayers = seedIdentityLayers,  // (room, personality, {io}) -> copy the SHARED fed layers into <room>/directives
  writeCard = writeConfigCard,      // (room, being, block, {io, onLog}) -> <room>/directives/config.readonly.yaml when it changed
  loadAutoLayer = readAutoModeLayer,// () -> the `mode: auto` operator-role instruction layer (appended to an auto conversation's kickoff)
  loadManifest = null,              // () -> e_identity.md fallback (default below)
  afterTurn = null,                 // ({key, sessionId, model, cwd, allowedTools, compaction, outbox, armIdentityRefresh, noticeCompacted}) — THE post-turn hook (auto-compaction AND the room-outbox drain ride this one, never a second). `armIdentityRefresh` is a CALLBACK the service invokes after a compact that succeeded — see the arming block at the end of turn(); `noticeCompacted` ({tokens}) says so in the turn's chat, null unless noticeTo is wired; `outbox` is {target:{key,to,unknown}, surface, slug, being, chatId} or null (src/room-outbox.mjs)
  loadPermission = loadPermissionLevel,  // (level) -> {dangerouslySkipPermissions, allowedTools}|null — config/permissions/<level>.md for /agents ... access_level; injectable (tests), NO caching in the real implementation (see permission-levels.mjs)
  // THE PLATFORM THIS NODE RUNS ON, injected rather than read off the global, so a test can
  // drive win32 AND posix in one run without redefining process.platform (same options-DI
  // convention as io/loadPermission above). Read by exactly one thing: the PLATFORM-AWARE
  // `sandboxed` default in resolveConv below.
  platform = process.platform,
  // A RECOVERY THE OPERATOR MUST HEAR ABOUT (operator 2026-09-14: "no error can go silent").
  // The two backstops below - context overflow and a dead resume target - both RECOVER by
  // throwing the thread away and answering from a blank one, and until this existed the only
  // trace was an onLog line in the daemon log. The being then replied normally, so from the
  // chat there was no error at all: on 2026-09-14 E answered three people from a wiped thread
  // and the operator found out by noticing it had stopped following the conversation.
  //
  // SEPARATE FROM onLog on purpose: onLog is the running commentary, this is the small set of
  // events worth waking someone for, and boot routes it to the operator's Self chat. Default is
  // a no-op rather than onLog, so an unwired caller (every test) logs exactly what it did before.
  onAlert = () => {},
  // SAYS ONE LINE IN THE ADMIN CHANNEL, from the being's own mouth: (text, being) -> Promise. Boot
  // resolves config.yaml's admin_channel and says it through sayOnce - the ONE placement every node
  // line takes - so this module never holds a sender or a channel. Read by exactly one thing: the
  // compaction notice handed out on afterTurn below (operator 2026-09-24). null (every test that
  // wires none) means no notice, nothing else.
  noticeTo = null,
  onLog = () => {},
} = {}) {
  if (!pool || typeof pool.run !== 'function') throw new Error('createBrainPool: pool (createWarmPool) is required');
  if (typeof contacts?.resolve !== 'function') throw new Error('createBrainPool: contacts (createContacts) is required');
  if (typeof loadState !== 'function' || typeof writeState !== 'function') throw new Error('createBrainPool: loadState + writeState are required');
  const alert = (m) => { try { onAlert(m); } catch (e) { onLog(`brainpool: alert failed: ${e?.message ?? e}`); } };
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
  //
  // NO {{agent_handles}} (operator 2026-09-01: "handles need not appear in identity files, model
  // is a bit agnostic, the model just gets prompted"). The ROUTER decides who wakes; telling the
  // model its own wake tokens buys nothing and would have stated the CONDITIONAL fallback flatly
  // — kg's card would claim @e when @e only reaches kg where the peer account is absent.
  //
  // A FRESH object per kickoff, spread OVER the node config — never a mutation of the shared
  // config object, and the agent taking the turn wins over any same-named top-level key.
  const feedConfig = (being) => ({ ...(getConfig() ?? {}), agent_name: labelOf(being) });

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
    // THE PIN RIDES ALONG (operator 2026-09-01). Carried on BOTH returns, the `scoped:false` one
    // included: a being pinned to room/wren is pinned when it is addressed IN room/wren too, and
    // that is precisely the chat whose own chatter would otherwise be the cycle it gets prepended.
    // Read, never invented — undefined for a membership scope, which must not change at all.
    if (!s || (s.surface === ev.surface && String(s.chatId) === String(ev.chatId))) {
      return { surface: ev.surface, chatId: ev.chatId, scoped: false, pinned: s?.pinned };
    }
    return { surface: s.surface, chatId: s.chatId, scoped: true, pinned: s.pinned };
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
    // Hoisted out of the literal below ONLY because `sandboxed:` now has to read it (operator
    // 2026-09-05) and an object literal cannot reference a sibling property. Same two-tier walk,
    // 'sandbox' fallback since 2026-09-23, still decided in exactly one place — see the ACCESS
    // LEVEL comment block on the field itself below, which is where this is documented.
    const accessLevel = b?.accessLevel ?? getConfig()?.agents?.[being]?.conversation_defaults?.access_level ?? 'sandbox';
    // SANDBOXED, resolved by resolveSandboxed above — the four rungs, and the history behind
    // each, are documented there. Hoisted out of the literal for the same reason accessLevel is:
    // the contradiction check needs both values before the object exists.
    //
    // AND THE CONTRADICTION IS LOUD (operator 2026-09-13). `access_level: sandbox` + an explicit
    // `sandboxed: false` makes that second line DEAD, not an override. config.yaml's tier is
    // FATAL at boot (boot.mjs, this same predicate); conversations.yaml's is hand-edited and
    // never fixed at boot, so it is logged EVERY turn instead — the same "loud at the point of
    // use" shape normalizeAllowNewInput uses in the literal below.
    const convSandboxed = b?.sandboxed ?? null;
    if (isSandboxContradiction(accessLevel, convSandboxed)) {
      onLog(`brainpool: ${being} access_level 'sandbox' FORCES the OS sandbox on — this conversation's sandboxed:${JSON.stringify(convSandboxed)} is dead config, not an override (conversations.yaml). Remove it, or set this conversation's access_level to 'all'/'regular' to run unboxed.`);
    }
    // WHICH RUNG DECIDED THE BOX, and WHICH TIER each two-tier field below came from (operator
    // 2026-09-24): read by the room's config.readonly.yaml (being-config-card.mjs), so it can say
    // where a value came from. The same two inputs and the same `conversation ?? agent default ??
    // built-in` order as the fields themselves: `!= null` is exactly `??`'s fall-through test.
    const cd = getConfig()?.agents?.[being]?.conversation_defaults ?? {};
    const box = resolveSandboxedRung({ accessLevel, conversationValue: convSandboxed, agentDefaultValue: cd.sandboxed ?? null, platform });
    const tierOf = (conv, agent) => (conv != null ? 'conversation' : agent != null ? 'agent' : 'default');
    return {
      scope,
      slug,
      sessionId: b?.threadId ?? null,
      sources: {
        accessLevel: tierOf(b?.accessLevel, cd.access_level),
        allowedUsers: tierOf(b?.allowedUsers, cd.allowed_users),
        verboseThinking: tierOf(b?.verboseThinking, cd.verbose_thinking),
        compaction: tierOf(b?.compaction, cd.compaction),
        outboxTo: tierOf(b?.outboxTo, cd.outbox_to),
      },
      // `/agents refresh <handle>` armed an identity re-feed on this being's RUNNING thread
      // (getBeing owns what "armed" means — an EXPLICIT null identityInjectedAt, never a
      // merely absent one). Read by turn() below, with sessionId. Joins the SCOPE like
      // everything else here except `mode`: the identity is the scope's, so a scoped being
      // refreshed once is refreshed on the one thread it answers under, which is the thread
      // the feed would go into anyway.
      identityRefreshArmed: b?.identityRefreshArmed === true,
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
      // UNSET RESOLVES TO A REAL LEVEL (operator 2026-08-20, refinement of the 2026-08-16
      // structural gate): accessLevel can only ever be 'all', 'regular', or (2026-09-05)
      // 'sandbox' — an unset value at both tiers is not a distinct "undeclared" state that
      // refuses the turn. Gate #1 below (which used to catch the null case) is now unreachable
      // and has been removed accordingly.
      //
      // AND THAT LEVEL IS 'sandbox' (operator 2026-09-23: "all agents sandboxed, but the meta
      // engineers", "we work only with OS confinement"). It was 'regular' from 2026-08-20, back
      // when 'regular' was the only confined tier there was and 'sandbox' did not exist yet —
      // so SILENCE meant the tier whose boundary is a CLI flag the being's own Bash can walk
      // past, and on a posix node, or under a `sandboxed: false` on any lower rung, meant no
      // boundary at all. Four beings on the live node declare nothing.
      //
      // WHY A LEVEL AND NOT A `sandboxed: true` DEFAULT: resolveSandboxed's rung 1 reads the
      // LEVEL, above both `sandboxed` rungs, so this default cannot be undone by a stale
      // `sandboxed: false` in conversations.yaml — it is loudly contradicted instead (see
      // isSandboxContradiction, logged just below). It is also the tier that MEANS the ruling:
      // 'sandbox' is all's capability inside the OS box, which is "sandboxed with all tools
      // available" exactly.
      //
      // THE META ENGINEERS ARE UNTOUCHED BECAUSE THEY SAY SO, not because this default spares
      // them: wren (kg) and dren (do) declare `access_level: all` explicitly, which is read
      // before this fallback is ever reached. A meta engineer that stopped declaring one would
      // be boxed — that is the intended direction of the mistake, and it is locked by test.
      //
      // 'regular' REMAINS EXPRESSIBLE, just no longer the default: a being that asks for it
      // gets the CLI-confined tier it always got, which on a node with no OS box is its only
      // boundary (see confinementFor).
      // AND IT JOINS THE SCOPE (operator 2026-08-31, ruled explicitly for acim + "perrito
      // traducciones"): the invited group's members are in his circle of trust, so the ROOM's
      // `all` applies to a turn the group triggers — the group does not keep the 'regular' it
      // would otherwise inherit from the global default. This is safe only because it is
      // `allowed_users` that gates WHO may wake the being (router.mjs/mesh.mjs's reachability
      // check, and the structural gate in turn() below which REFUSES an 'all' being with no
      // allowed_users at either tier) — and room/acim already carries one, as any 'all' being
      // structurally must.
      accessLevel,
      // ALLOWED_USERS, same two-tier resolution as accessLevel just above (operator 2026-08-16) —
      // needed here (not just at router.mjs/mesh.mjs's reachability gates) so turn() can refuse to
      // run an accessLevel:'all' being that has no allowed_users set at either tier: unconfined
      // capability + unrestricted reachability is an unsafe combination the operator wants caught
      // structurally (see the STRUCTURAL SAFETY GATES block below).
      allowedUsers: b?.allowedUsers ?? getConfig()?.agents?.[being]?.conversation_defaults?.allowed_users ?? null,
      // SANDBOXED — the whole precedence is resolveSandboxed (above), which is the ONE thing that
      // answers this field for every caller. Rungs 2 and 3 are the same two-tier read
      // accessLevel/allowedUsers use above; rung 1 is the level, rung 4 this node's OS.
      sandboxed: box.value,
      sandboxedRung: box.rung,
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
      // AUTO-COMPACTION OVERRIDES for this conversation (operator 2026-09-03), same two-tier
      // walk as everything above it: the per-conversation block (for a PINNED being that block
      // is its row in config/agents.yaml, which is the point) beats
      // agents.<being>.conversation_defaults.compaction, and an absent answer at both tiers is
      // null — "nothing stated here", so compaction.mjs keeps applying the node-global block
      // exactly as it does today. REPLACES rather than merges at whichever tier answers, the
      // same rule allowed_users follows: a half-overridden compaction policy assembled from two
      // files is far harder to reason about than one that says what it means where it is written.
      compaction: compactionOverrideOf(b, getConfig(), being),
      // WHICH APPROVED TARGET THIS ROOM'S outbox/ GOES TO (operator 2026-09-22). The key itself
      // takes the SAME two-tier walk as `compaction` directly above, deliberately, because it is
      // the same rung: for a room the per-conversation block is its row in config/rooms.yaml.
      //
      // AND IT IS A KEY, NOT A PATH. The conversation names one of the destinations config.yaml's
      // root `outbox_targets:` map already approved; that map is the only place a real path is
      // ever written. With a raw path here, anything able to write the conversation record could
      // name any directory on the operator's disk — with a key it can only SELECT among folders
      // the operator granted, and an unrecognised name resolves to no path at all rather than to
      // a traversal. Resolution lives in room-outbox.resolveOutboxTarget because the BOOT SWEEP
      // reads it too and two copies of a `??` chain drift. null ⇒ this conversation names no
      // target and the feature is off for it; there is no default.
      outboxTarget: resolveOutboxTarget(b, being, getConfig()),
      // CONFIGURATION for THIS conversation (operator 2026-09-17), read from the scope's block like
      // everything above except `mode`. RAW, and ONE tier here: the fallback is not
      // conversation_defaults but agents.<being>.configuration itself, and resolveBeingDef — the
      // one resolver turn() and /agents share — is where the two are resolved and a bad value
      // refused. null = this conversation states none.
      configuration: b?.configuration ?? null,
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
      const { scope, slug, sessionId, identityRefreshArmed, mode, accessLevel, allowedUsers, sandboxed, sandboxedRung, verboseThinking, compaction: compactionOver, outboxTarget, configuration, sources } = await resolveConv(ev, being);
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
      // 2026-08-20) rather than null, so accessLevel is always a real level ('all' | 'regular' |
      // 'sandbox') by the time turn() reads it — that throw could no longer fire.
      // 'sandbox' IS EXEMPT, AND MUST STAY EXEMPT (operator 2026-09-05). This condition tests
      // `=== 'all'` deliberately — it is not a stand-in for "is unconfined". The pair this gate
      // catches is unconfined capability AND unrestricted reachability TOGETHER; under 'sandbox'
      // the turn runs in a Windows logon session whose only ACE is this conversation's own
      // folder, so the blast radius of a stranger reaching it is that folder. The operator ruled
      // a 'sandbox' being may therefore be reachable by anyone with no allowed_users set. Do NOT
      // "fix" this later by adding 'sandbox' to the condition: that deletes the tier's point.
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
      // RETHREAD re-copies the room template, an ordinary turn does not. Being-agnostic: each
      // being's own thread (getBeing(..., being).threadId, read by resolveConv above) is
      // independent of every other resident being's.
      // (The word here was "refresh" until 2026-09-10, when the operator split the verbs:
      // `rethread` is the thread-instanced-anew one this flag describes; `refresh` is now the
      // OTHER thing, immediately below, which deliberately does none of what `fresh` gates.)
      const fresh = !sessionId;
      // AN IDENTITY REFRESH IS ARMED on a thread that is otherwise fine (operator 2026-09-10,
      // `/agents refresh <handle>`): the thread is RESUMED — same session, same context, no roll,
      // no overwrite-reseed — but the command explicitly nulled its identityInjectedAt, which
      // states the literal truth that this running thread has no identity in context. The feed
      // therefore rides the next real turn as its kickoff wrap and the stamp is written back
      // below, exactly the shape `mode: auto`'s one-time resume preamble already uses.
      //
      // Never true while `fresh` is: a brand-new thread gets the feed from wrapFresh anyway, and
      // recordThread stamps threadId and identityInjectedAt together at the end of that turn.
      const identityRefresh = !fresh && identityRefreshArmed;
      // THE ONE resolution path (phase 2, operator 2026-08-14): every being's def — the
      // persona included — comes from resolveBeingDef (agents[<being>].configuration names a
      // type file resolved through the brains registry). This is the SAME path a
      // never-instanced conversation always used for the persona (phase 1) — now the ONLY
      // path, for every being, so a config edit (repointing agents.<being>.configuration, or
      // the type file itself) reaches every conversation on its very next turn.
      // dangerously_skip_permissions:true skips coercion (see confinementFor's comment above) —
      // the type file's allowed_tools (which may legitimately include bare Bash/Agent) passes
      // through verbatim rather than being capped to DEFAULT_ALLOWED_TOOLS.
      // `configuration` is this conversation's own (resolveConv) — null where it states none.
      const rawDef = resolveBeingDef(being, convDir, { getConfig, brains, brainType, configuration, onLog });
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
      // 'sandbox' (operator 2026-09-05) reads config/permissions/sandbox.md through this SAME
      // call — the tier is a third FILE, not a third code path; its `sandboxed` force lives in
      // resolveConv above and nothing about the grant itself is special-cased here. WHICH names
      // are levels is permission-levels.mjs's own answer (isAccessLevel), not a copy of its
      // list kept in sync by hand — that copy is what made the third tier unreachable by
      // command for a day.
      if (isAccessLevel(accessLevel)) {
        const perm = loadPermission(accessLevel);
        if (perm) def = { ...def, dangerously_skip_permissions: perm.dangerouslySkipPermissions, allowed_tools: perm.allowedTools };
      }
      const engine = def.type ?? brainType;
      // The identity-feed selector (operator 2026-07-02): a property of the resolved
      // agent-type def, NOT the conversation. `def.personality` is ALREADY the whole ladder by
      // the time it gets here (personalityFor, applied in shapeDef): config.yaml's agent-level
      // `personality:` first, then a type file's own pin. Absent at both, it's 'egpt' (the
      // shipped default) — the last rung, and the only one this line owns.
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
      // Targets convDir, NOT cwd: a def that pins a workspace must not have directives/
      // written into it. EVERY agent gets the SHARED layers copied into its own conv folder,
      // for local file-tool consult. Its IDENTITY is not among them (operator 2026-09-10) —
      // that reaches the model in context, at kickoff and on compaction (see wrapFresh
      // below), which is the whole reason the folder is no longer called identity.d.
      // Best-effort by contract (seedIdentityLayers never throws) — never breaks a turn.
      // Room.forChat, not slugDir: seedIdentityLayers is keyed on the Room instance now (a
      // conversation IS a Room), so its own ensureTree/directivesDir resolve off convDir too.
      await seedLayers(Room.forChat(scope.surface, slug), personality, { io, overwrite: fresh });
      // HOW THIS BEING IS CONFIGURED HERE, beside those layers (operator 2026-09-24): its block in
      // ./directives/config.readonly.yaml, rendered from the values THIS turn runs with and written
      // only when it changed — see being-config-card.mjs. Before the spawn, so a fresh thread's
      // first turn already finds it. Best-effort by contract (writeConfigCard never throws).
      // `verbose` is the one reading of verbose_thinking, shared with baseOpts below.
      const verbose = (verboseThinking ?? def.verbose_thinking) === true;
      await writeCard(Room.forChat(scope.surface, slug), being, renderConfigBlock({
        being, config: getConfig() ?? {}, scoped: scope.scoped, configuration, def, engine,
        model: runModel, effort: runEffort, accessLevel, sandboxed, sandboxedRung,
        mode: resolveMode({ mode }, being, getConfig() ?? {}),
        verboseThinking: verbose,
        verboseSource: verboseThinking != null ? sources.verboseThinking : (def.verbose_thinking != null ? 'type' : 'default'),
        allowedUsers, compaction: compactionOver, sources, outboxTarget, threadId: sessionId,
      }), { io, onLog });

      const key = `${being}:${engine}:${scope.surface}:${slug}`;
      lastKeyByConv.set(`${being}:${ev.surface}:${ev.chatId}`, key);
      // ...and under the SCOPE's address too when the two differ (operator 2026-08-31). evict()
      // and steer() below resolve NO SCOPE OF THEIR OWN — their target is a key LOOKUP, never a
      // re-resolution (steer awaits the model's acknowledgement, but that is the session's
      // answer, not a config read).
      // Registering both addresses is what lets a wedged entry be evicted, and a live turn be
      // steered, from EITHER end of a joined pair: both names now point at the one warm entry.
      if (scope.scoped) lastKeyByConv.set(`${being}:${scope.surface}:${scope.chatId}`, key);
      // The def's OWN system_prompt and nothing else (operator 2026-08-29): WHO an agent is comes
      // from its identity feed (config/identities/<personality>.md in the 00-identity slot), never
      // from a sentence boot assembles about the node's DEFAULT persona — that addendum told every
      // agent it was "don" while its feed said otherwise.
      const appendSystemPrompt = def.system_prompt;
      // SANDBOX-ONLY CREDENTIAL (operator 2026-09-05). config.yaml's `sandbox_oauth_token` is
      // the operator's own SUBSCRIPTION token (`claude setup-token`, not an API key), and the
      // read is GATED on the resolved `sandboxed` for one reason: a NON-sandboxed turn runs as
      // the operator's own Windows account and reads ~/.claude directly, so it already has a
      // credential and must not be handed a second one. Only a sandboxed turn has none — it
      // runs as a leased pool account (egpt-sbx-NN) with its own empty profile, denied the
      // operator's ~/.claude/.credentials.json by the very ACLs that make the sandbox a sandbox.
      //
      // Unset/blank collapses to '' and baseOpts below then omits the field ENTIRELY, so
      // sandbox-cli-session.mjs passes no -SetEnv and the launcher argv stays byte-identical to
      // what it was before this key existed. NEVER LOGGED: the value lands in baseOpts and
      // nowhere else — warm-cli-session.mjs's `warm-cli: spawn ...` line prints the INNER claude
      // argv, which is built AND logged before sandboxSpawn ever wraps it.
      const sandboxOauthToken = sandboxed === true ? String(getConfig()?.sandbox_oauth_token ?? '').trim() : '';
      // THE OS-LAYER SHARE PATHS (operator 2026-09-05) — `allowed_paths` finally reaching the
      // kernel and not only the CLI flags. Read from the SAME `def` confinementFor reads below
      // (post access-level override, so a tier change moves both layers together) and gated on
      // the resolved `sandboxed` for the same reason the credential above is: a NON-sandboxed
      // turn runs as the operator's own Windows account, which already reaches these folders,
      // so handing it a share list would be a no-op field on every ordinary turn.
      //
      // TWO LISTS, because the two classes get two different ACEs (Modify / ReadAndExecute) and
      // must stay distinguishable all the way to the launcher — see sandboxSharePathsFor.
      const { writable: sandboxSharePaths, readOnly: sandboxSharePathsReadOnly } =
        sandboxed === true ? sandboxSharePathsFor(def) : { writable: [], readOnly: [] };
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
        // `sandboxed` is passed because it decides WHICH confinement this turn gets: the OS box
        // (no cwd root in argv - the cwd is a mount only the launcher can name) or the CLI's own
        // root. Resolved above, from the same rungs everything else on this turn reads.
        ...confinementFor(def, cwd, onLog, sandboxed === true),
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
        verboseThinking: verbose,
        // Plain passthrough (operator 2026-08-20) — boot.mjs's makeSession reads this to pick
        // createSandboxCliSession over createBrainSession. No structural gating beyond this:
        // the STRUCTURAL SAFETY GATES above already refuse the whole turn when accessLevel
        // isn't set, so a sandboxed being still needs its own access_level/allowed_users.
        sandboxed: sandboxed === true,
        // ...and the credential THAT turn runs on, spread in ONLY when there is one (resolved
        // above, sandboxed-only). With the key unset this contributes nothing at all, which is
        // the common case and the one whose spawn argv must not change.
        ...(sandboxOauthToken ? { sandboxOauthToken } : {}),
        // ...and the OS-LAYER half of this being's `allowed_paths` (operator 2026-09-05),
        // spread in only when there are any, exactly like the credential above. Resolved from
        // the SAME def the confinementFor spread above reads, through the SAME walk
        // (sandboxSharePathsFor / allowedPathsFor), so the two layers cannot disagree about
        // which folders this being was told it may use — nor, since 2026-09-13, about WHICH WAY:
        // sandbox-cli-session.mjs turns these into the launcher's `-SharePath` and
        // `-SharePathReadOnly` JSON arrays, and each path gets a per-turn ACE of its own class
        // (Modify / ReadAndExecute), granted and revoked with the lease. Sandboxed turns only: a
        // non-sandboxed turn runs as the operator's own account and already reaches every one of
        // these paths.
        ...(sandboxSharePaths.length ? { sandboxSharePaths } : {}),
        ...(sandboxSharePathsReadOnly.length ? { sandboxSharePathsReadOnly } : {}),
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
      // line on a resume — unless the operator asked for a refresh (the feed goes back into
      // the RESUMED thread, no new session), or a resumed thread just flipped to auto and
      // hasn't been told yet, in which case the one-time auto preamble leads.
      //
      // A refresh reuses wrapFresh VERBATIM rather than growing a second feed assembler: what
      // `/agents refresh` re-feeds is by definition the same feed a kickoff carries, and the
      // one difference that would matter — a new session — is not made here but by the
      // `sessionId` in baseOpts, which a refresh leaves exactly as it was.
      let firstMsg;
      if (!sessionId || identityRefresh) {
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
        alert(`⚠️ ${labelOf(being) || being} overflowed its context in ${slug} — thread reset, it is answering from a blank one. History is in transcript.md.`);
        pool.evict?.(key);
        r = await run(await wrapFresh(), { ...baseOpts, sessionId: null });
      } else if (deadSession) {
        onLog(`brainpool: dead session ${sessionId} for ${key} — retrying fresh`);
        alert(`⚠️ ${labelOf(being) || being} lost its thread in ${slug} — the resume target ${sessionId} is gone, so it is answering from a blank one. History is in transcript.md.`);
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
      } else if (identityRefresh) {
        // THE REFRESH STAMP. The feed just went into the SAME thread (no new session, so the
        // recordThread branch above never fires and nothing would otherwise record that the
        // identity is back in context) — write identityInjectedAt alone, through patchBeing so
        // threadId/threadCreatedAt and every other field on the block survive untouched. That
        // is what disarms the re-feed: the next turn reads a stamped block and sends the raw
        // line again.
        //
        // ONLY ON A TURN THAT GOT HERE. A turn that threw never reaches this line, so the
        // refresh stays armed and the feed is retried next time — which is correct and is the
        // honest outcome: an undelivered feed must not be recorded as delivered.
        await mutateState(writeState, async () => {
          await writeState(patchBeing(await loadState(), scope.surface, scope.chatId, being, { identityInjectedAt: nowIsoString() }));
        });
      }
      // ARMING THE IDENTITY FEED ON COMPACTION (operator 2026-09-10). The ruling is that the
      // identity feeds at START, REFRESH, RETHREAD and COMPACTION; e4c299e built the first three
      // and left this one open. A native /compact rewrites this session's context IN PLACE, so
      // the kickoff feed can be summarised away — the being keeps its thread and loses who it is.
      //
      // THE GESTURE IS THE REFRESH ONE, deliberately, so there is no second feed path: write this
      // being's `identityInjectedAt` to an EXPLICIT null, which getBeing reads back as
      // identityRefreshArmed and turn() consumes above as `identityRefresh` — the next real turn
      // re-wraps through wrapFresh on the SAME session and stamps itself back. The state is also
      // literally true meanwhile: a threadId with a null injected-at says this thread is running
      // without its identity in context, which after a compact it is.
      //
      // HANDED OUT, NOT CALLED HERE — and it is NOT invoked on this turn. Only compaction.mjs
      // knows whether a compact actually SUCCEEDED (it fires a cooling period later, and only if
      // the session is over ratio); only this module owns conversations.yaml. So the state write
      // travels to the decision instead of teaching the compaction service about being blocks.
      // Same scope/being addressing as the REFRESH STAMP just above, for the same reason.
      const armIdentityRefresh = async () => {
        await mutateState(writeState, async () => {
          await writeState(patchBeing(await loadState(), scope.surface, scope.chatId, being, { identityInjectedAt: null }));
        });
      };
      // Auto-compaction hook: after a cooling period the service /compacts this
      // session in place if it grew past ratio. Fire-and-forget — never block the reply.
      // `compaction` rides along so the service applies THIS conversation's own policy
      // (operator 2026-09-03). null ⇒ the node-global block, i.e. today's behaviour exactly.
      // `outbox` rides the SAME hook rather than a second post-turn mechanism (operator
      // 2026-09-22): one descriptor, null unless this conversation states a destination, so the
      // compaction service — which destructures only what it needs — is untouched by it. It
      // carries the ROOM (the scope: the outbox belongs to the conversation the being's instance
      // lives in, which for an invited group is the room, not the group) and, separately, the
      // chat this turn's REPLY went to, which is where the drain says what it did.
      //
      // A RESOLVED TARGET RIDES EVEN WHEN ITS KEY NAMED NOTHING — `{ key, to: null, unknown }` —
      // so a typo in `outbox_to:` is reported by name instead of behaving exactly like "off".
      const outbox = outboxTarget ? { target: outboxTarget, surface: scope.surface, slug, being, chatId: ev.chatId } : null;
      // THE COMPACTION NOTICE (operator 2026-09-24: "can the bridge emit notice of this when it
      // happens?"), handed out on the SAME hook and for the same reason as armIdentityRefresh:
      // only compaction.mjs knows whether a compact succeeded, a cooling period from now, and only
      // this turn knows which conversation it came from and what the being is called. The line goes
      // to the ADMIN CHANNEL (operator: "make it's posted on admin channel, eGPT Admin"), never into
      // the chat, so it names the conversation instead: the ROOM for a chat invited into one - the
      // room's thread is the one compacted - else the chat's own name.
      const noticeCompacted = typeof noticeTo === 'function'
        ? ({ tokens } = {}) => noticeTo(compactedNotice({
          node: getConfig()?.node_name ?? null,
          label: labelOf(being) || being,
          chat: scope.scoped ? slug : (ev.chatName || slug),
          tokens,
        }), being)
        : null;
      try { afterTurn?.({ key, sessionId: newSession ?? sessionId ?? null, model: def.model, cwd, allowedTools: baseOpts.allowedTools, compaction: compactionOver, outbox, armIdentityRefresh, noticeCompacted }); } catch { /* non-fatal */ }
      return { text, sessionId: newSession ?? sessionId ?? null, being };
    },

    // WHERE THIS BEING'S INSTANCE LIVES for this event — the conversation itself, or the room a
    // `wa-group` membership joined it to (operator 2026-08-31). The spine's per-conversation turn
    // FIFO is the ONE of the four identity keys derived outside this module, and the spine cannot
    // resolve config or rooms.yaml itself, so it asks here — the same division allowNewInput below
    // already draws (resolution lives beside every other field in resolveConv; the caller only
    // formats). Returns an address, never a key, so the turn-key FORMAT stays in the one file that
    // owns it. Read per call, never cached: an invited group joins or leaves on the next message.
    // `pinned` comes out beside the address (operator 2026-09-01): the spine has to tell a
    // node-wide PIN from a membership scope — only the first suppresses the cycle prepend — and
    // this is the one resolve a turn makes, so the flag travels with it rather than being asked
    // for a second time. Still an address, never a key.
    async scopeOf(being, ev) {
      const s = await scopeAddr(being, ev ?? {});
      return { surface: s.surface, chatId: s.chatId, pinned: s.pinned };
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

    // This conversation's resolved access_level (operator 2026-09-16). The spine's per-chat loop
    // guard needs it for ONE comparison: a META ENGINEER is an `access_level: all` being, and meta
    // engineers are beyond that guard ("meta engineers are beyond the bridge"; GENOME I8). Same
    // shape and same reason as allowNewInput above - the spine cannot resolve config, so it asks;
    // resolution stays in resolveConv, read per call, never cached.
    async accessLevel(being, ev) {
      return (await resolveConv(ev, being)).accessLevel;
    },

    // Weave this message into the turn ALREADY streaming for this being+conversation
    // (operator 2026-08-30). `false` means NOTHING happened and the caller must queue an
    // ordinary turn (see warm-sessions `steer`'s injected-or-nothing contract; that is what
    // keeps a false from becoming a reply nobody delivers).
    //
    // Keyed off lastKeyByConv, the SAME lookup evict() uses, and for the same reason: no
    // re-derivation of engine/slug. It is also exact here by construction — a turn can only
    // be in flight because turn() ran and stamped that key on its way to pool.run. And it is
    // what keeps this off turn()'s own path: a steer must NOT re-enter the fresh-thread
    // machinery there (rollTranscript, the identity-feed wrap, an overwrite seedLayers),
    // because a conversation's FIRST turn has no recorded sessionId while it is still in
    // flight — steering it through turn() would post the whole identity feed as the
    // mid-turn message and archive the live transcript out from under it.
    //
    // WHAT IT RETURNS IS EVIDENCE OR NOTHING (operator 2026-09-09). `false` still means nothing
    // happened; anything else is the pool's `{ ack }` — a promise that later says whether the
    // MODEL took the line, not whether a write to a pipe succeeded. That is the whole Joyce fix,
    // and it is passed straight through rather than collapsed to a boolean here, because the
    // spine is the layer that owns what a chat is shown (turns.mjs: 📩 for the bridge's receipt,
    // 👀 only once this ack says ok).
    async steer(being, ev) {
      const k = lastKeyByConv.get(`${being}:${ev?.surface}:${ev?.chatId}`);
      if (!k) { onLog(`brainpool: steer FAILED ${being} ${ev?.surface}/${ev?.chatId} — no warm key was ever recorded for this conversation`); return false; }
      return (await pool.steer?.(k, ev?.line ?? ev?.body ?? '')) ?? false;
    },
  };
}
