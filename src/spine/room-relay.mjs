// room-relay.mjs — the §Phase-4 room brain-member fan-out (design B: re-entry).
//
// A room (a conversation) holds members[] (src/room-core.mjs); a `brain` member is a
// Chrome tab driven by a web-brain adapter (config/brains/*-cdp.mjs). This service
// delivers a RECEIVED room message to each brain member whose MODE admits it, relays
// the message through the member's adapter + streamFromTab, streams the reply into the
// room, and — the crux of design B — RE-ENTERS that finalized reply as a synthetic
// inbound event so it naturally reaches the OTHER brain members AND the persona E (each
// per its own mode). The synthetic carries `from.fromMember` = { id, kind } of the producing
// member, which (a) classifies a BRAIN member's reply NON-human to the guard so it is counted
// EXACTLY ONCE at the spine's chokepoint (never here), and (b) stops the relay feeding a turn
// back to its own author.
//
// The loop is bounded by the ONE guard: each re-entered brain reply is a non-human turn, so a
// two-brain room answering itself trips guard.turns and `blocked()` short-circuits the
// fan-out. This service NEVER counts and NEVER logs the transcript — the re-entry does both
// once, at the chokepoint (spine.mjs), which is what keeps "count/log exactly once" honest.
//
// A CHAT MEMBER (operator 2026-08-29: *"implement wa-group membership … a room works as a
// communication tunnel between groups, since whatever is said in the room is fanned out to
// members, this also includes under the same open umbrella members like chatgpt tabs"*). A
// `wa-group` member is a WhatsApp group INVITED into the room (`/members add group <chatId>`);
// several groups may join one room. It is fanned out to by the same loop, gated by the same
// admits(), from the same roster — only the DELIVERY differs: a plain send to that group's OWN
// chat id (m.id) instead of an injection into a CDP tab.
//
// AND THE TUNNEL RUNS THROUGH THE ROOM (operator 2026-08-31: *"if there is nobody connected in
// the shell to a room, fanning out is to write on their transcript. an advanced feature is what
// it does now, that is shows the messages that arrived to the group/room while you were absent.
// a delivery IS a turn then, so that the group can trigger the room's agents. i want precisely
// for the group to trigger acim's E, which has been doing good work."*). A message arriving in an
// invited group used to be delivered from the GROUP's own fan-out (the reverse lookup handed this
// service the room's members) and merely LOGGED into the room, so the room's own agents were
// never woken by it — the tunnel was one-directional in effect. It is RE-ENTERED into the room
// now, addressed at `room/<name>`, through the SAME `reenter` a brain member's reply already
// travels. The room becomes an ordinary turn, and everything follows from that:
//   · the ingestion chokepoint writes the room's ONE transcript record (so this service is back
//     to never logging — the logRoomTranscript seam and its second writer are gone);
//   · the room's AGENTS run per their own mode, exactly as for any other message in the room —
//     which is the whole ask;
//   · the room's own fan-out — this same loop, one level down — delivers to the OTHER groups and
//     the brain tabs. Delivery happens ONCE, from the room, never twice from both ends (which is
//     why the reverse lookup no longer concatenates the room's members into the GROUP's roster:
//     boot.mjs createMemberResolver).
//
// LOOP SAFETY — four locks, none of which is the guard (the guard BOUNDS a runaway; it does not
// make the design correct):
//   1. SELF-ECHO. The origin is skipped by IDENTITY, read two ways: `m.id === ev.chatId` when the
//      member IS this conversation, and `ev.fromMember.id === m.id` when this turn is that
//      member's line re-addressed into the room. A group never gets its own line handed back.
//   2. TWO GROUPS PING-PONGING. B's copy is one of OUR OWN sends, and the bridge drops its echo
//      by exact (chat, id) after waiting out the in-flight confirm (beeper.mjs wasSentByUs /
//      _awaitSends) — it never becomes an inbound at all, so there is no second turn to fan back.
//      Should one ever escape that gate it carries this node's structural signature, and the
//      synthetic carries `fromNode` across the re-addressing (identity has already RENDERED the
//      invisible frame away, so the fact cannot be re-read from the body) — non-human all the way
//      through the tunnel, counted rather than resetting, and the guard bounds it.
//   3. ONE HOP. A turn this service already re-entered is never tunnelled onward (`!ev.fromMember`
//      below) — so the chain is finite in the module that takes the hop. The reverse lookup ALSO
//      declines to run for surface `room` (boot.mjs createMemberResolver), because a tunnel starts
//      at a surface chat and ends in a room; two rooms listing each other therefore cannot chain
//      even before this lock is reached.
//   4. AN AGENT'S OWN REPLY re-triggering itself — `ev.fromMember.id === m.id`, the pre-existing
//      skip, unchanged.
//
// Everything external is injected so the whole fan-out is exercisable against fakes (no live
// Chrome, no socket): resolveMembers (the room roster), adapterOf (the driver module),
// streamFromTab (the CDP relay engine), openStream (the member-stamped sender).

export function createRoomRelay({
  resolveMembers,   // (surface, chatId) => Promise<member[]> — the room's members[] (room-core)
  adapterOf,        // (adapterName) => Promise<{ injectScript, pollScript }|null> — the web-brain driver
  streamFromTab,    // ({ targetId, injectScript, pollScript, onUpdate }) => Promise<text> — CDP engine (fake in tests)
  openStream,       // (memberId, chatId, { replyTo }) => { update, finish, fail } — member-stamped sender
  activateTarget = async () => {},  // (targetId) => Promise<void> — best-effort tab focus before inject (CDP, fake in tests)
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

  // WHO IS SPEAKING, for a delivery into another chat. openStream's first argument is the
  // member-stamped sender's `being` — the label the receiving chat sees beside the 🤖 glyph —
  // so a line tunnelled into another group must carry the ORIGIN's voice, never the receiving
  // group's own chat id. A person's name for a human turn; for a brain member's re-entered
  // reply syntheticOf already set senderName = the member id, so it lands stamped `chatgpt`.
  const speakerOf = (ev) => String(ev.senderName || ev.chatName || ev.chatId || '');

  // A synthetic inbound payload ({ body, from }) for a member's reply. from.network = the
  // origin surface (a surface name is a recognized network prefix, so identity.build re-derives
  // the SAME surface + chatId → the same room). msgKey:null → not addressable (like an advice
  // relay). from.fromMember = { id, kind } of the producing member — the ONE provenance the guard
  // and this relay both read, each asking its own question of it: the relay reads the ID (never
  // feed a turn back to its own author), the guard reads the KIND (only a `brain` member's reply
  // is OUR OWN output, hence non-human — see stop-guard.isHumanTurn).
  function syntheticOf(m, ev, body) {
    return {
      body,
      from: {
        network: ev.surface, chatId: ev.chatId, chatName: ev.chatName,
        userId: `brain:${m.id}`, senderName: m.id,
        authorized: false, isSender: false, msgKey: null,
        fromMember: { id: m.id, kind: m.kind },
      },
    };
  }

  // The synthetic that carries an invited group's message INTO the room it joined, addressed at
  // the room's OWN conversation — `{ network: 'room', chatId: <room name> }`, byte-for-byte the
  // re-addressing boot.mjs's redirectShellToRoom already applies when the console fans prose into
  // the room it has joined, and the very address the retired logRoomTranscript wrote its record
  // to (so the room's transcript.md is the same file it always was). Everything else is the
  // ORIGIN's: the body, and who said it.
  //
  // `authorized`/`isSender` stay FALSE, as they do for a brain reply: a tunnelled line is not the
  // operator commanding THIS node. Otherwise commands.isOperator would read a `/status` typed in
  // the group as an operator command in the room too, and run it a second time.
  //
  // `fromNode` rides along because it CANNOT be re-derived: identity renders the invisible node
  // frame into a legible `<node>` when it first builds the event, so by the time this service
  // holds ev.body the structural signature is gone. Without carrying it, one of our own sends
  // that escaped the bridge's echo gate would read HUMAN inside the room and reset the very
  // counter that has to bound it (lock 2 in the header).
  const tunnelOf = (roomName, ev) => ({
    body: ev.body,
    from: {
      network: 'room', chatId: roomName, chatName: roomName,
      userId: ev.senderId, senderName: ev.senderName,
      authorized: false, isSender: false, msgKey: null,
      // kind is 'wa-group' BY CONSTRUCTION: the reverse lookup that produced tunnelRooms matches
      // only wa-group members (boot.mjs createMemberResolver). A person talking, so the guard
      // keeps counting it human — six group messages must not auto-STOP the room they were
      // invited to wake.
      fromMember: { id: ev.chatId, kind: 'wa-group' },
      fromNode: ev.fromNode,
      // WHERE IT ACTUALLY ARRIVED (operator 2026-08-31). The re-addressing above is right for
      // IDENTITY — the turn runs on the ROOM's thread, warm process, queue and access_level,
      // which is a569ada's whole point and does not change. It is WRONG for GATING, and one
      // live message proved it: `@e` in "perrito traducciones" is Rodz's to answer, so kg's
      // fallback_handle guard sees the peer account present in that GROUP and correctly stays
      // quiet — but the tunnelled copy presents as a room event, a room has no roster, and the
      // guard re-read that as "peer absent" and woke kg's E anyway. ONE message, TWO turns.
      // Same shape for the surface pin: a `surface: shell` agent must not match a message that
      // arrived on WhatsApp just because the tunnel re-addressed it onto surface `room`.
      //
      // It rides the payload for the same reason fromNode does — by the time this service holds
      // ev, the origin address has been replaced, so it cannot be re-derived downstream. It is
      // READ ONLY by the gates that ask "where did this arrive" (src/spine/router.mjs); nothing
      // dispatches, keys or files on it, so identity stays exactly what a569ada made it.
      origin: { surface: ev.surface, chatId: ev.chatId, chatName: ev.chatName },
    },
  });

  return {
    // Deliver a received room message to each admitting brain member. `blocked()` (the guard's
    // per-channel stop) short-circuits a channel the counter tripped mid-fan-out — so a runaway
    // multi-brain room halts at guard.turns. `reenter` = the spine's handleInbound: a member's
    // finalized reply re-enters the pipe (counted once, reaching the others + E). Never throws.
    async fanOut(ev, { blocked = () => false, reenter } = {}) {
      let members;
      try { members = await resolveMembers(ev.surface, ev.chatId); }
      catch (e) { onLog(`resolveMembers ${ev.surface}/${ev.chatId}: ${e?.message ?? e}`); return; }
      // THE TUNNEL, first: every room this chat was INVITED into hears the message as a turn of
      // its own (see the header). ONE re-entry per room this event tunnels into — not per member
      // delivered to, and independent of any member's admit()/mode, because the room hearing it
      // is about what happened at the origin, not about who received it. The room's ONE transcript
      // record and its agents' wake-up both come out of that turn, at the ingestion chokepoint
      // every other message goes through. A plain roster with no `tunnelRooms` (every non-tunnel
      // case, every existing caller/test) skips this entirely — byte-identical to before it existed.
      //
      // ONE HOP, ENFORCED HERE (`!ev.fromMember`): a turn this service already re-entered is never
      // tunnelled onward. THIS is what makes the chain finite, in the module that takes the hop,
      // rather than trusting the resolver never to hand back a tunnel for a room turn (it does not
      // — boot.mjs skips the reverse lookup on surface `room` — but a fan-out that recurses only
      // because its roster source is well-behaved is not a design). It is also what keeps
      // tunnelOf's `kind` honest: only a GENUINE inbound is ever tunnelled, so the member it comes
      // from is always the wa-group the reverse lookup matched.
      if (!ev.fromMember && typeof reenter === 'function' && Array.isArray(members?.tunnelRooms)) {
        for (const roomName of members.tunnelRooms) {
          if (blocked()) break;                               // guard tripped — stop tunnelling
          try { await reenter(tunnelOf(roomName, ev)); }
          catch (e) { onLog(`tunnel '${roomName}': ${e?.message ?? e}`); }
        }
      }
      for (const m of (Array.isArray(members) ? members : [])) {
        if (blocked()) break;                                 // guard tripped — stop fanning
        // NEVER HAND A TURN BACK TO ITS AUTHOR — the ONE skip, read two ways because a member
        // reaches this loop two ways. `m.id === ev.chatId`: the member IS this conversation (a
        // wa-group member's id is a chat id, so the group a message arrived in is exactly "its own
        // author"). `ev.fromMember.id === m.id`: this turn is that member's own output re-entered
        // — a brain member's finalized reply, or an invited group's line re-addressed into the
        // room, where the chatId is the room's and no longer the group's.
        if (m.id === ev.chatId) continue;
        if (ev.fromMember && ev.fromMember.id === m.id) continue;
        // A CHAT member (a WhatsApp group invited into this room): the room is the tunnel, so the
        // message is SENT to that group's own chat id — not injected into ev.chatId the way a
        // brain member's tab is driven.
        if (m.kind === 'wa-group') {
          const text = admits(m, ev);
          if (text == null) continue;                         // this member's mode doesn't admit the message
          const out = openStream(speakerOf(ev), m.id, {});    // replyTo omitted: ev.msgId belongs to ANOTHER chat
          try { await out.finish({ text }); }
          catch (e) { onLog(`send '${m.id}': ${e?.message ?? e}`); }
          continue;
        }
        if (m.kind !== 'brain' || !m.targetId) continue;      // not a live web-brain member (no open tab)
        const text = admits(m, ev);
        if (text == null) continue;                           // this member's mode doesn't admit the message
        const adapter = await adapterOf(m.adapter);
        if (!adapter?.injectScript || !adapter?.pollScript) { onLog(`no adapter '${m.adapter}' for member '${m.id}'`); continue; }
        const out = openStream(m.id, ev.chatId, { replyTo: ev.msgId ?? null });
        // Focus the tab before injecting: Chrome throttles background tabs, so a backgrounded
        // brain can miss the send or never stream a reply. Best-effort — never blocks the send.
        try { await activateTarget(m.targetId); } catch {}
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
