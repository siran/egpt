// room-relay.mjs — the §Phase-4 room brain-member fan-out (design B: re-entry).
//
// A room (a conversation) holds members[] (src/room-core.mjs); a `brain` member is a
// Chrome tab driven by a web-brain adapter (config/brains/*-cdp.mjs). This service
// delivers a RECEIVED room message to each brain member whose MODE admits it, relays
// the message through the member's adapter + streamFromTab, streams the reply into the
// room, and — the crux of design B — RE-ENTERS that finalized reply as a synthetic
// inbound event so it naturally reaches the OTHER brain members AND the persona E (each
// per its own mode). The synthetic carries `from.fromBrain` = the producing member, which
// (a) classifies it NON-human to the guard so it is counted EXACTLY ONCE at the spine's
// chokepoint (never here), and (b) stops the relay feeding a reply back to its own author.
//
// The loop is bounded by the ONE guard: each re-entered reply is a non-human turn, so a
// two-brain room answering itself trips guard.turns and `blocked()` short-circuits the
// fan-out. This service NEVER counts and NEVER logs the transcript — the re-entry does both
// once, at the chokepoint (spine.mjs), which is what keeps "count/log exactly once" honest.
//
// Everything external is injected so the whole fan-out is exercisable against fakes (no live
// Chrome, no socket): resolveMembers (the room roster), adapterOf (the driver module),
// streamFromTab (the CDP relay engine), openStream (the member-stamped sender).

export function createRoomRelay({
  resolveMembers,   // (surface, chatId) => Promise<member[]> — the room's members[] (room-core)
  adapterOf,        // (adapterName) => Promise<{ injectScript, pollScript }|null> — the web-brain driver
  streamFromTab,    // ({ targetId, injectScript, pollScript, onUpdate }) => Promise<text> — CDP engine (fake in tests)
  openStream,       // (memberId, chatId, { replyTo }) => { update, finish, fail } — member-stamped sender
  onLog = () => {},
} = {}) {
  if (typeof resolveMembers !== 'function') throw new Error('createRoomRelay: resolveMembers is required');
  if (typeof adapterOf !== 'function') throw new Error('createRoomRelay: adapterOf is required');
  if (typeof streamFromTab !== 'function') throw new Error('createRoomRelay: streamFromTab is required');
  if (typeof openStream !== 'function') throw new Error('createRoomRelay: openStream is required');

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Does member m's MODE admit event ev? Returns the TEXT to relay, or null when the mode
  // doesn't admit it. muted → never; active → the whole body; mention → only when @<id>
  // addresses it, with the addressing @<id> stripped (so `@chatgpt hello` relays `hello`).
  function admits(m, ev) {
    const body = String(ev.body ?? '');
    if (m.state === 'active') return body;
    if (m.state === 'mention') {
      const at = new RegExp('@' + esc(m.id) + '\\b', 'i');
      if (!at.test(body)) return null;
      return body.replace(new RegExp('@' + esc(m.id) + '\\b', 'ig'), '').replace(/\s{2,}/g, ' ').trim();
    }
    return null;   // muted / off / accum / unknown → nothing reaches it
  }

  // A synthetic inbound payload ({ body, from }) for a member's reply. from.network = the
  // origin surface (a surface name is a recognized network prefix, so identity.build re-derives
  // the SAME surface + chatId → the same room). msgKey:null → not addressable (like an advice
  // relay). from.fromBrain = the producing member — the PROVENANCE the guard + this relay read.
  function syntheticOf(m, ev, body) {
    return {
      body,
      from: {
        network: ev.surface, chatId: ev.chatId, chatName: ev.chatName,
        userId: `brain:${m.id}`, senderName: m.id,
        authorized: false, isSender: false, msgKey: null,
        fromBrain: m.id,
      },
    };
  }

  return {
    // Deliver a received room message to each admitting brain member. `blocked()` (the guard's
    // per-channel stop) short-circuits a channel the counter tripped mid-fan-out — so a runaway
    // multi-brain room halts at guard.turns. `reenter` = the spine's handleInbound: a member's
    // finalized reply re-enters the pipe (counted once, reaching the others + E). Never throws.
    async fanOut(ev, { blocked = () => false, reenter } = {}) {
      let members;
      try { members = await resolveMembers(ev.surface, ev.chatId); }
      catch (e) { onLog(`resolveMembers ${ev.surface}/${ev.chatId}: ${e?.message ?? e}`); return; }
      for (const m of (Array.isArray(members) ? members : [])) {
        if (blocked()) break;                                 // guard tripped — stop fanning
        if (m.kind !== 'brain' || !m.targetId) continue;      // not a live web-brain member (no open tab)
        if (ev.fromBrain && ev.fromBrain === m.id) continue;  // never feed a reply back to its own author
        const text = admits(m, ev);
        if (text == null) continue;                           // this member's mode doesn't admit the message
        const adapter = await adapterOf(m.adapter);
        if (!adapter?.injectScript || !adapter?.pollScript) { onLog(`no adapter '${m.adapter}' for member '${m.id}'`); continue; }
        const out = openStream(m.id, ev.chatId, { replyTo: ev.msgId ?? null });
        let reply = '';
        try {
          reply = await streamFromTab({
            targetId: m.targetId,
            injectScript: adapter.injectScript(text),
            pollScript: adapter.pollScript,
            onUpdate: (p) => { try { out.update(p); } catch {} },
          });
        } catch (e) { onLog(`relay '${m.id}': ${e?.message ?? e}`); try { await out.fail?.(e); } catch {} continue; }
        const finalText = String(reply ?? '').trim();
        if (!finalText) { try { await out.finish({ text: '' }, { surface: false }); } catch {} continue; }  // brain said nothing → post nothing
        try { await out.finish({ text: finalText }); } catch (e) { onLog(`post '${m.id}': ${e?.message ?? e}`); }
        // Re-enter the reply as a synthetic NON-human turn: the guard counts it ONCE at the
        // chokepoint, it reaches the other brains (this same fanOut, minus the author) and E.
        try { if (typeof reenter === 'function') await reenter(syntheticOf(m, ev, finalText)); }
        catch (e) { onLog(`reenter '${m.id}': ${e?.message ?? e}`); }
      }
    },
  };
}
