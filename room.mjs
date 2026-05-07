// room.mjs — pure routing nucleus shared between shell and extension.
//
// Given a parsed input plus a snapshot of the room (local sessions and peer
// sessions seen on the bus), decide what the caller should *do*:
//
//   { kind: 'command', cmd, rest }
//       Caller dispatches the slash command via its own handleSlash.
//
//   { kind: 'turn', recipients, payload, broadcast }
//       Run a brain turn for each name in `recipients` with `payload` as the
//       user-visible message body. `broadcast` is true when the user typed a
//       plain message (no @-mention) and there are multiple recipients.
//
//   { kind: 'auto-open', brainName, payload, originalToken }
//       The user @-mentioned a non-CDP brain alias (e.g. @codex) when no
//       session of that type exists yet. Caller creates a fresh session
//       and runs a turn against it.
//
//   { kind: 'peer-mention', target, toNode, body }
//       The @-target isn't local but exactly one peer node owns it. Caller
//       posts a 'mention' event on the bus to `toNode`.
//
//   { kind: 'error', message }
//       Unknown session, ambiguous match, etc. Caller displays `message`.
//
//   { kind: 'empty' }
//       Plain message but the room has no sessions. Caller displays a hint.
//
//   { kind: 'idle' }
//       Plain message and the room has sessions but no activeSession is
//       set. Caller does NOT call any brain — the user must @-mention or
//       `/use <name>` to consent to plain-text routing. Caller may still
//       have posted room-utterance for peer visibility before resolveRoute.
//
//   { kind: 'persona', body }
//       The user wrote `@egpt …` — the node-global "default brain"
//       persona. Caller routes to its persistent default-brain session
//       (auto-spawned on first use, resumed thereafter). Works in any
//       room including the default lobby; not tied to room sessions.
//
// The room module never touches React state, files, or networks. The caller
// owns the side effects.

/**
 * @typedef {object} LocalSession
 * @property {string} brainName  - e.g. 'codex', 'chatgpt-cdp'
 *
 * @typedef {object} PeerSession
 * @property {string} name
 * @property {string} brain  - the brain name (string), as broadcast on the bus
 *
 * @typedef {object} Brain
 * @property {string} name
 * @property {RegExp} [urlMatch]  - present iff this is a CDP brain
 *
 * @typedef {object} RoomCtx
 * @property {Map<string, LocalSession>} sessions
 * @property {Map<string, PeerSession[]>} peerSessions  - nodeId -> sessions list
 * @property {(name: string) => Brain | null | undefined} brainForName
 * @property {(name: string) => string} canonicalBrainName
 * @property {string[]} [activeSessions]  - sessions that plain-text routes
 *                                          to (multi-AI broadcast). Without
 *                                          any, plain text returns kind:'idle'
 *                                          — auto-routing requires explicit
 *                                          consent (/use).
 */

/**
 * Resolve a parsed input against the current room. Pure function.
 *
 * @param {{type: string, cmd?: string, rest?: string, target?: string, body?: string}} parsed
 * @param {string} fullText  - original user input, used as broadcast payload
 * @param {RoomCtx} ctx
 * @returns {object} a decision the caller acts on
 */
export function resolveRoute(parsed, fullText, ctx) {
  if (parsed.type === 'command') {
    return { kind: 'command', cmd: parsed.cmd, rest: parsed.rest ?? '' };
  }

  if (parsed.type === 'mention') {
    const token = parsed.target;
    const body = parsed.body || '?';

    // Special case: '@egpt' is the node-global default-brain persona.
    // Always returns kind:'persona' regardless of room state — works
    // even in the default lobby. The persona has its own persistent
    // conversation thread, separate from any room session.
    if (token.toLowerCase() === 'egpt') {
      return { kind: 'persona', body };
    }

    // 1. Direct hit on a local session name.
    if (ctx.sessions.has(token)) {
      return { kind: 'turn', recipients: [token], payload: body, broadcast: false };
    }

    // 2. Token is a brain alias. Two sub-cases: local operator vs CDP brain.
    const brain = ctx.brainForName(token);
    if (brain) {
      const brainCanonical = ctx.canonicalBrainName(token);

      if (!brain.urlMatch) {
        // Local operator (codex, ccode) — auto-open a fresh session.
        return {
          kind: 'auto-open', brainName: brainCanonical, payload: body,
          originalToken: token,
        };
      }

      // CDP brain — must use an existing matching session, or fail.
      const matches = [];
      for (const [name, s] of ctx.sessions) {
        if (ctx.canonicalBrainName(s.brainName) === brainCanonical) matches.push(name);
      }
      if (matches.length === 1) {
        return { kind: 'turn', recipients: [matches[0]], payload: body, broadcast: false };
      }
      if (matches.length > 1) {
        return {
          kind: 'error',
          message: `@${token} is ambiguous; address one of: ${matches.join(', ')}`,
        };
      }
      return {
        kind: 'error',
        message: `no ${token} session; /open ${token} [name]`,
      };
    }

    // 3. Peer routing. Find which peer nodes have a session with this name.
    const peerMatches = [];
    for (const [nodeId, sessions] of ctx.peerSessions) {
      if (sessions.some(s => s.name === token)) peerMatches.push(nodeId);
    }
    if (peerMatches.length === 1) {
      return { kind: 'peer-mention', target: token, toNode: peerMatches[0], body };
    }
    if (peerMatches.length > 1) {
      return {
        kind: 'error',
        message: `@${token} is ambiguous across peers: ${peerMatches.join(', ')}`,
      };
    }

    // 4. Nothing matched. Truthful framing: this token isn't a participant
    //    in the room, anywhere we can see. Don't suggest /open — that
    //    presumes the user wanted to address a brain type, but they may
    //    have misremembered a session name. /sessions tells the truth.
    return {
      kind: 'error',
      message: `no participant @${token} has joined the room — /sessions to see who's here`,
    };
  }

  // parsed.type === 'message' (plain text)
  if (ctx.sessions.size === 0) return { kind: 'empty' };
  // Plain text only auto-routes to a brain when the user has explicitly
  // chosen one or more with /use. Without that, the message stays in
  // the room (peers still see it via room-utterance posted by the
  // surface) but no brain runs. Multi-AI: /use a,b,c broadcasts plain
  // text to all of them.
  const active = (ctx.activeSessions ?? [])
    .filter(name => ctx.sessions.has(name));
  if (active.length > 0) {
    return {
      kind: 'turn',
      recipients: active,
      payload: fullText,
      broadcast: active.length > 1,
    };
  }
  return { kind: 'idle' };
}

/**
 * Given replies from a multi-recipient broadcast, decide which one-hop
 * mirror messages to send. Mirrors substantive replies between CDP brains
 * only (operators don't get mirrors), never to the original author, never
 * cascade beyond one hop.
 *
 * @param {Array<{author: string, text: string}>} replies
 * @param {string[]} recipients
 * @param {Map<string, LocalSession>} sessions
 * @param {(name: string) => Brain | null | undefined} brainForName
 * @returns {Array<{to: string, message: string}>}
 */
export function planMirrors(replies, recipients, sessions, brainForName) {
  const cdpRecipients = recipients.filter(
    r => brainForName(sessions.get(r)?.brainName)?.urlMatch,
  );
  if (cdpRecipients.length <= 1 || replies.length === 0) return [];

  const out = [];
  for (const { author, text } of replies) {
    if (!brainForName(sessions.get(author)?.brainName)?.urlMatch) continue;
    for (const other of cdpRecipients) {
      if (other === author) continue;
      out.push({ to: other, message: `[${author}]: ${text}` });
    }
  }
  return out;
}
