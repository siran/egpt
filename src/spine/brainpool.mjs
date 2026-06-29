// brainpool.mjs — the §2b Brain port: run a being's turn through the warm pool
// and return { text, sessionId }. Thin wrapper over the KEPT primitives
// (createWarmPool + the conversation's stored claude session), carrying the §7
// invariants that live at the turn boundary:
//
//   - warm key  `<being>:ccode:<surface>:<slug>`  (matches dispatch.mjs + compact-
//     being + the warm-sessions tests — the compactor reseeds the SAME key).
//   - session-identity guard: we pass the conversation's stored sessionId as
//     brainOptions.sessionId, which is what arms createWarmPool's re-pin guard
//     (evict+reopen when a different session is requested — the /e-new fix).
//   - context-overflow backstop: "Prompt is too long" — THROWN by the CLI on a
//     result error, OR returned verbatim as the result text — evicts the warm
//     entry and retries ONCE on a FRESH session (no resume). The transcript is
//     the durable record; the chat never sees the overflow string.
//
// v1 is the E persona on the ccode engine. Sibling beings (per-being session
// persistence) and codex/URL brains layer in later; emitted-command stripping is
// the comm-handler's job (Phase 4), not the brain's.
import { slugDir, getContact, ensureContact, getBeing, recordThread } from '../../conversations-state.mjs';
import { isContextOverflowError } from '../../dispatch.mjs';
import { mkdir as fsMkdir } from 'node:fs/promises';

export function createBrainPool({
  pool,                              // a createWarmPool instance ({ run, evict })
  getConfig = () => ({}),
  loadState, writeState,            // conversations-state YAML IO (injected)
  brainType = 'ccode',
  io = {},
  isOverflow = isContextOverflowError,
  onLog = () => {},
} = {}) {
  if (!pool || typeof pool.run !== 'function') throw new Error('createBrainPool: pool (createWarmPool) is required');
  if (typeof loadState !== 'function' || typeof writeState !== 'function') throw new Error('createBrainPool: loadState + writeState are required');
  const mkdir = io.mkdir ?? fsMkdir;

  // chatId → { slug, sessionId }, registering the contact on first sight (the
  // brain runs before transcript.log, so it can be the one that registers).
  async function resolveConv(ev, being) {
    let state = await loadState();
    let slug = getContact(state, ev.surface, ev.chatId)?.slug ?? null;
    if (!slug) {
      const ens = ensureContact(state, ev.surface, ev.chatId, { pushedName: ev.chatName, slugHint: ev.chatName });
      slug = ens?.slug ?? null;
      if (slug && ens.state !== state) { state = ens.state; await writeState(state); }
    }
    const b = slug ? getBeing(state, ev.surface, ev.chatId, being) : null;
    return { slug, sessionId: b?.threadId ?? null };
  }

  return {
    /** @returns {Promise<{ text: string, sessionId: string|null, being: string }>} */
    async turn(being, ev, onPartial = () => {}) {
      const { slug, sessionId } = await resolveConv(ev, being);
      if (!slug) throw new Error(`brainpool: no slug for ${ev.surface}/${ev.chatId}`);

      const db = (getConfig() ?? {}).default_brain ?? {};
      // E works inside the conversation's own folder unless a fixed workspace is
      // configured. The dir must exist before the CLI spawns (warm-cli throws on a
      // missing cwd), and the brain runs before transcript creates it — so mkdir here.
      const cwd = db.cwd ?? slugDir(ev.surface, slug);
      await mkdir(cwd, { recursive: true });

      const key = `${being}:${brainType}:${ev.surface}:${slug}`;
      const baseOpts = {
        cwd,
        allowedTools: db.allowed_tools ?? 'all',
        ...(db.model ? { model: db.model } : {}),
        ...(db.system_prompt ? { appendSystemPrompt: db.system_prompt } : {}),
        sessionId: sessionId ?? db.session_id ?? null,
      };
      const run = (opts) => pool.run(key, ev.line ?? ev.body, onPartial, { brainOptions: opts, klass: 'conversation' });

      let r, overflow = false;
      try { r = await run(baseOpts); }
      catch (e) { if (isOverflow(e?.message)) overflow = true; else throw e; }
      // overflow can also arrive as the RESULT text (returned, not thrown).
      if (!overflow && isOverflow(typeof r === 'string' ? r : r?.text)) overflow = true;
      if (overflow) {
        onLog(`brainpool: context overflow on ${key} — reset + retry once fresh`);
        pool.evict?.(key);
        r = await run({ ...baseOpts, sessionId: null });
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
