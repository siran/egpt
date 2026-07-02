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
// v1 is the E persona on the ccode engine. LOCAL sibling beings (@wren, @don) also
// run here: a sibling's brain def comes from config.siblings[<being>] (NOT the
// brains registry, and never frozen into readonly), it gets NO identity kickoff
// (engineers, not the persona), and its thread persists in a per-being NESTED block
// (recordThread(..., being)). codex/URL brains + emitted-command stripping (the
// comm-handler's job, Phase 4) layer in later.
import { slugDir, getBeing, recordThread, readIdentityFeed, patchContact } from '../../conversations-state.mjs';
import { isContextOverflowError } from '../../dispatch.mjs';
import { parseFrequency } from './heartbeat-loader.mjs';
import { mkdir as fsMkdir, readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as YAML from 'yaml';

// Pure: a conversation folder's config.yaml text (or null/'' when absent) →
// { idleTtlMs }. The `warm: { idle_ttl }` override (operator 2026-07-02) sets THIS
// conversation's warm idle TTL, beating the class TTL: a ms number or a
// "<qty><unit>" duration (ms/s/m/h), with `0` = keep this conversation always warm
// (never idle-evict). Absent block / malformed YAML / unparseable value → null (the
// conversation falls through to the class TTL). Reuses heartbeat-loader's
// parseFrequency for the duration grammar, but parseFrequency rejects 0/negative,
// so 0 is accepted here explicitly BEFORE delegating (0 is a valid value, not garbage).
export function parseWarmBlock(yamlText) {
  let doc = {};
  if (yamlText && yamlText.trim()) {
    try { doc = YAML.parse(yamlText) ?? {}; } catch { doc = {}; }
  }
  const w = (doc && typeof doc === 'object' && doc.warm && typeof doc.warm === 'object' && !Array.isArray(doc.warm))
    ? doc.warm : {};
  const v = w.idle_ttl;
  if (v === undefined || v === null) return { idleTtlMs: null };
  if (v === 0) return { idleTtlMs: 0 };               // 0 = never evict (parseFrequency rejects it)
  return { idleTtlMs: parseFrequency(v) ?? null };    // garbage / negative → null
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

export function createBrainPool({
  pool,                              // a createWarmPool instance ({ run, evict })
  getConfig = () => ({}),
  contacts,                          // the shared contact-resolver (createContacts) — slug + rename self-heal
  loadState, writeState,            // conversations-state YAML IO (injected)
  brains = null,                     // the brain registry (createBrains) — resolves the default a fresh conv is instanced from
  brainType = 'ccode',               // fallback engine when a brain def / registry is absent
  io = {},
  isOverflow = isContextOverflowError,
  loadFeed = readIdentityFeed,      // (personality) -> identities/<name>/ feed string
  loadManifest = null,              // () -> e_identity.md fallback (default below)
  afterTurn = null,                 // ({key, sessionId, model, cwd, allowedTools}) — post-turn hook (auto-compaction)
  onLog = () => {},
} = {}) {
  if (!pool || typeof pool.run !== 'function') throw new Error('createBrainPool: pool (createWarmPool) is required');
  if (typeof contacts?.resolve !== 'function') throw new Error('createBrainPool: contacts (createContacts) is required');
  if (typeof loadState !== 'function' || typeof writeState !== 'function') throw new Error('createBrainPool: loadState + writeState are required');
  const mkdir = io.mkdir ?? fsMkdir;
  const readFile = io.readFile ?? fsReadFile;
  const _loadManifest = loadManifest ?? (() => defaultLoadManifest(getConfig));

  // Best-effort read of a conversation folder's config.yaml warm override (never
  // throws): absent / unreadable / malformed → null → the class TTL applies.
  async function readWarmTtl(convDir) {
    let text = null;
    try { text = await readFile(join(convDir, 'config.yaml'), 'utf8'); } catch { /* none = no override */ }
    return parseWarmBlock(text).idleTtlMs;
  }

  // chatId → { slug, sessionId, personality }. The shared resolver registers the
  // contact on first sight AND re-arms the name-tracking rename; the slug it
  // returns is the CURRENT one. When a rename fired, the warm-pool key below embeds
  // that new slug, so the conversation naturally re-keys onto a fresh warm entry —
  // the stale entry ages out via the pool's LRU, no extra eviction machinery. We
  // then re-read state fresh (the resolver may have just rewritten it — a rename
  // nulls the thread state) for the per-being view.
  async function resolveConv(ev, being) {
    const slug = await contacts.resolve(ev.surface, ev.chatId, { chatName: ev.chatName });
    const b = slug ? getBeing(await loadState(), ev.surface, ev.chatId, being) : null;
    return {
      slug,
      sessionId: b?.threadId ?? null,
      personality: b?.personality ?? 'default',
      // The conversation's INSTANCED brain (frozen in readonly), or null on a fresh
      // conversation that hasn't been instanced from the default yet.
      brain: b?.brainType ? { name: b.brain, type: b.brainType, model: b.model, effort: b.effort, allowed_tools: b.allowedTools } : null,
    };
  }

  // The `agents:` block (operator 2026-07-02): the unified registry. Read lazily so a
  // config edit takes effect next turn. A LOCAL agent (type ≠ 'relay') keyed by being
  // name supplies that being's TYPE, resolved through the brains registry (config/agents
  // layer). The PERSONA agent (handles include e/egpt) supplies E's default type.
  const agents = () => (getConfig() ?? {}).agents ?? {};
  const agentIds = (name, a) => [name, ...(Array.isArray(a?.handles) ? a.handles : [])].map((h) => String(h).toLowerCase());
  // The persona agent's TYPE (agents block), or null when no persona agent is declared.
  function personaAgentType() {
    for (const [name, a] of Object.entries(agents())) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
      if (String(a.type ?? '').toLowerCase() === 'relay') continue;   // relay isn't a brain
      if (agentIds(name, a).some((h) => h === 'e' || h === 'egpt')) return a.type ?? null;
    }
    return null;
  }
  // Shape a resolved registry def into the brainpool's def contract, letting the agent
  // entry override the display name. `claude-code` normalizes to the `ccode` token.
  function shapeDef(name, def, agent = {}) {
    const type = String(def?.type ?? '').toLowerCase() === 'claude-code' ? 'ccode' : (def?.type ?? brainType);
    return {
      name: agent.name ?? def?.name ?? name,
      type,
      model: def?.model ?? null,
      effort: def?.effort ?? null,
      allowed_tools: def?.allowed_tools ?? 'all',
      cwd: def?.cwd ?? undefined,
      system_prompt: def?.system_prompt ?? undefined,
    };
  }

  // A local (sibling) being's brain def. MODERN: a LOCAL agent (agents[<being>], type ≠
  // relay) — its `type` names an agent-type file resolved through the registry. LEGACY
  // fallback: config.siblings[<being>] inline shape. Either way NOT frozen into readonly
  // (the def LIVES in config, nothing per-conversation to instance).
  function siblingDef(being, convDir) {
    const agent = agents()[being];
    if (agent && typeof agent === 'object' && !Array.isArray(agent) && String(agent.type ?? '').toLowerCase() !== 'relay') {
      const def = brains?.resolve?.(agent.type, { convDir }) ?? null;
      if (def) return shapeDef(being, def, agent);
      // type named but no file → fall through to the legacy shape (keeps the being runnable)
    }
    const s = (getConfig() ?? {}).siblings?.[being] ?? {};
    const type = String(s.type ?? '').toLowerCase() === 'claude-code' ? 'ccode' : (s.type ?? brainType);
    return {
      name: (agent && typeof agent === 'object' ? agent.name : null) ?? s.name ?? being,
      type,
      model: s.model ?? null,
      effort: s.effort ?? null,
      allowed_tools: s.allowed_tools ?? 'all',
      cwd: s.cwd ?? undefined,
      system_prompt: s.system_prompt ?? undefined,
    };
  }

  // The DEFAULT brain a fresh conversation is instanced from, in order:
  //   1. the PERSONA agent's `type` (agents block) resolved through the registry,
  //   2. config.default_brain (a registry brain name, or a legacy inline def),
  //   3. the shipped 'default'.
  // Falls back to a bare ccode def if the registry is absent.
  function resolveDefaultBrain(convDir) {
    const pType = personaAgentType();
    if (pType) {
      const def = brains?.resolve?.(pType, { convDir });
      if (def) return def;                                     // persona type file wins
      // named but unresolvable → fall through to default_brain / 'default'
    }
    const db = (getConfig() ?? {}).default_brain;
    const fallback = { name: 'default', type: brainType };
    if (typeof db === 'string') return brains?.resolve?.(db, { convDir }) ?? brains?.resolve?.('default', { convDir }) ?? { name: db, type: brainType };
    const base = brains?.resolve?.('default', { convDir }) ?? fallback;
    return (db && typeof db === 'object') ? { ...base, ...db, name: db.name ?? base.name } : base;
  }

  return {
    /** @returns {Promise<{ text: string, sessionId: string|null, being: string }>} */
    async turn(being, ev, onPartial = () => {}) {
      const { slug, sessionId, personality, brain: instanced } = await resolveConv(ev, being);
      if (!slug) throw new Error(`brainpool: no slug for ${ev.surface}/${ev.chatId}`);

      const convDir = slugDir(ev.surface, slug);
      const isSibling = being !== 'e';
      let def;
      if (isSibling) {
        // Sibling / local agent: def from the agents block (type file) or the legacy
        // config.siblings[being] inline shape; never frozen into readonly.
        def = siblingDef(being, convDir);
      } else {
        // The conversation's brain: its instanced (frozen) brain, or — on the first
        // turn — the default, which we instance into conversations.yaml `readonly` now
        // so a later change to the default can't retro-alter this thread (and `/e` can
        // re-point it per-conversation).
        def = instanced;
        if (!def) {
          def = resolveDefaultBrain(convDir);
          // Freeze the instanced def under readonly.agent (operator 2026-07-02: the
          // conversations.yaml vocabulary is "agent" now; getBeing back-reads the legacy
          // readonly.brain, and migrateReadonlyBrainToAgent renames existing entries).
          await writeState(patchContact(await loadState(), ev.surface, ev.chatId, {
            readonly: { agent: def.name, type: def.type ?? brainType, model: def.model ?? null, effort: def.effort ?? null, allowed_tools: def.allowed_tools ?? 'all', personality },
          }));
        }
      }
      const engine = def.type ?? brainType;
      // E works inside the conversation's own folder unless the brain pins a
      // workspace. The dir must exist before the CLI spawns (warm-cli throws on a
      // missing cwd), and the brain runs before transcript creates it — so mkdir here.
      const cwd = def.cwd ?? convDir;
      await mkdir(cwd, { recursive: true });

      const key = `${being}:${engine}:${ev.surface}:${slug}`;
      const baseOpts = {
        cwd,
        allowedTools: def.allowed_tools ?? 'all',
        ...(def.model ? { model: def.model } : {}),
        ...(def.effort ? { effort: def.effort } : {}),
        ...(def.system_prompt ? { appendSystemPrompt: def.system_prompt } : {}),
        // Resume the conversation's OWN thread, or null = fresh. NOT
        // default_brain.session_id — that would cross-wire every chat onto one
        // session; the auto-dispatch path keys the session per conversation
        // (dispatch.mjs: convEntry.threadId ?? null).
        sessionId: sessionId ?? null,
      };

      // Identity kickoff: prefix the first turn of a fresh thread with the feed,
      // framed as a plain live message (no "installing persona" preamble). The
      // overflow-reset retry re-wraps because its fresh session needs the identity.
      const line = ev.line ?? ev.body;
      const wrapFresh = async () => {
        if (isSibling) return line;   // siblings are engineers, not the persona — no identity feed
        let feed = (await loadFeed(personality)) || '';
        if (!feed.trim()) feed = (await _loadManifest()) || '';
        if (!feed.trim()) return line;   // no identity configured → raw line
        return `${feed.trim()}\n\n---\n\nLive message from the chat (envelope \`Sender@[Chat or group name] (HH:MM): body\`):\n${line}`;
      };

      // Per-conversation warm-idle override (operator 2026-07-02): this
      // conversation's own config.yaml `warm: { idle_ttl }` overrides the class TTL
      // (0 = keep it always warm). Read per turn — the file is tiny and a turn
      // already does heavier IO — and re-stamped on the warm entry every run so an
      // edited config takes effect next turn. Applied to BOTH the normal turn and
      // the overflow retry below. (compaction.afterTurn's own pool.run reuses this
      // same warm entry but OMITS idleTtlMs, so it keeps the ttl stamped here — no
      // need to thread the override through it.)
      const idleTtlMs = await readWarmTtl(convDir);
      const run = (msg, opts) => pool.run(key, msg, onPartial, { brainOptions: opts, klass: 'conversation', idleTtlMs });

      let r, overflow = false;
      try { r = await run(sessionId ? line : await wrapFresh(), baseOpts); }
      catch (e) { if (isOverflow(e?.message)) overflow = true; else throw e; }
      // overflow can also arrive as the RESULT text (returned, not thrown).
      if (!overflow && isOverflow(typeof r === 'string' ? r : r?.text)) overflow = true;
      if (overflow) {
        onLog(`brainpool: context overflow on ${key} — reset + retry once fresh`);
        pool.evict?.(key);
        r = await run(await wrapFresh(), { ...baseOpts, sessionId: null });
      }

      const text = typeof r === 'string' ? r : (r?.text ?? '');
      const newSession = (r && typeof r === 'object' && r.sessionId) || null;
      // Persist a freshly-minted session so the next turn resumes it — being-aware:
      // flat threadId for 'e', a nested <being> block for a sibling.
      if (newSession && newSession !== sessionId) {
        await writeState(recordThread(await loadState(), ev.surface, ev.chatId, newSession, undefined, being));
      }
      // Auto-compaction hook: after a cooling period the service /compacts this
      // session in place if it grew past ratio. Fire-and-forget — never block the reply.
      try { afterTurn?.({ key, sessionId: newSession ?? sessionId ?? null, model: def.model, cwd, allowedTools: baseOpts.allowedTools }); } catch { /* non-fatal */ }
      return { text, sessionId: newSession ?? sessionId ?? null, being };
    },
  };
}
