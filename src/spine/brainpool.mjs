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
// v1 is the E persona on the ccode engine. Sibling beings (per-being session
// persistence) and codex/URL brains layer in later; emitted-command stripping is
// the comm-handler's job (Phase 4), not the brain's.
import { slugDir, getContact, ensureContact, getBeing, recordThread, readIdentityFeed, patchContact } from '../../conversations-state.mjs';
import { isContextOverflowError } from '../../dispatch.mjs';
import { mkdir as fsMkdir, readFile as fsReadFile } from 'node:fs/promises';

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
  loadState, writeState,            // conversations-state YAML IO (injected)
  brains = null,                     // the brain registry (createBrains) — resolves the default a fresh conv is instanced from
  brainType = 'ccode',               // fallback engine when a brain def / registry is absent
  io = {},
  isOverflow = isContextOverflowError,
  loadFeed = readIdentityFeed,      // (personality) -> identities/<name>/ feed string
  loadManifest = null,              // () -> e_identity.md fallback (default below)
  onLog = () => {},
} = {}) {
  if (!pool || typeof pool.run !== 'function') throw new Error('createBrainPool: pool (createWarmPool) is required');
  if (typeof loadState !== 'function' || typeof writeState !== 'function') throw new Error('createBrainPool: loadState + writeState are required');
  const mkdir = io.mkdir ?? fsMkdir;
  const _loadManifest = loadManifest ?? (() => defaultLoadManifest(getConfig));

  // chatId → { slug, sessionId, personality }, registering the contact on first
  // sight (the brain runs before transcript.log, so it can be the registrar).
  async function resolveConv(ev, being) {
    let state = await loadState();
    let slug = getContact(state, ev.surface, ev.chatId)?.slug ?? null;
    if (!slug) {
      const ens = ensureContact(state, ev.surface, ev.chatId, { pushedName: ev.chatName, slugHint: ev.chatName });
      slug = ens?.slug ?? null;
      if (slug && ens.state !== state) { state = ens.state; await writeState(state); }
    }
    const b = slug ? getBeing(state, ev.surface, ev.chatId, being) : null;
    return {
      slug,
      sessionId: b?.threadId ?? null,
      personality: b?.personality ?? 'default',
      // The conversation's INSTANCED brain (frozen in readonly), or null on a fresh
      // conversation that hasn't been instanced from the default yet.
      brain: b?.brainType ? { name: b.brain, type: b.brainType, model: b.model, effort: b.effort, allowed_tools: b.allowedTools } : null,
    };
  }

  // The DEFAULT brain a fresh conversation is instanced from: config.default_brain
  // names a registry brain (string), or is an inline def (legacy object) merged over
  // the shipped 'default'. Falls back to a bare ccode def if the registry is absent.
  function resolveDefaultBrain(convDir) {
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
      // The conversation's brain: its instanced (frozen) brain, or — on the first
      // turn — the default, which we instance into conversations.yaml `readonly` now
      // so a later change to the default can't retro-alter this thread (and `/e` can
      // re-point it per-conversation).
      let def = instanced;
      if (!def) {
        def = resolveDefaultBrain(convDir);
        await writeState(patchContact(await loadState(), ev.surface, ev.chatId, {
          readonly: { brain: def.name, type: def.type ?? brainType, model: def.model ?? null, effort: def.effort ?? null, allowed_tools: def.allowed_tools ?? 'all', personality },
        }));
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
        let feed = (await loadFeed(personality)) || '';
        if (!feed.trim()) feed = (await _loadManifest()) || '';
        if (!feed.trim()) return line;   // no identity configured → raw line
        return `${feed.trim()}\n\n---\n\nLive message from the chat (envelope \`Sender@[Chat or group name] (HH:MM): body\`):\n${line}`;
      };

      const run = (msg, opts) => pool.run(key, msg, onPartial, { brainOptions: opts, klass: 'conversation' });

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
      // Persist a freshly-minted session so the next turn resumes it (flat 'e'
      // threadId; per-being persistence for siblings is a later concern).
      if (newSession && newSession !== sessionId) {
        await writeState(recordThread(await loadState(), ev.surface, ev.chatId, newSession));
      }
      return { text, sessionId: newSession ?? sessionId ?? null, being };
    },
  };
}
