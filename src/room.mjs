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
//   { kind: 'mesh-foreign', target, name, node, body }
//       The @name.node target is syntactically valid but belongs to another
//       node. Slice 0 callers intentionally no-op; a later relay slice can
//       route this decision across the mesh.
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
//   { kind: 'meta', body }
//       The user wrote `@me …` (or `@wren …`) — the engineer co-pilot,
//       a SIBLING of the operator's main Claude Code design conversation
//       (egpt0-branch). Resumed from EGPT_CONFIG.meta_brain.session_id,
//       which is pinned to a specific Claude Code conversation via the
//       /branch slash command run from that conversation. Reachable from
//       any surface (WA/TG/extension/shell); always the same thread.
//       See project-egpt-at-me-identity in memory for design context.
//
// The room module never touches React state, files, or networks. The caller
// owns the side effects.

import { parseMeshAddress, sameMeshNode } from './mesh/names.mjs';

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
 * @property {Map<string, SiblingEntry>} [siblings]  - optional registry
 *                                          mapping canonical persona / sibling
 *                                          name to its kind + aliases. When
 *                                          present, @<token> routing consults
 *                                          this map FIRST; when absent (or
 *                                          empty), the legacy hardcoded list
 *                                          (egpt/e → persona, me/wren → meta)
 *                                          applies for backwards compat.
 *
 * @typedef {object} SiblingEntry
 * @property {'persona'|'sibling'} kind  - 'persona' routes via runDefault-
 *                                         BrainTurn semantics (item-mirror,
 *                                         streaming, /rules); 'sibling'
 *                                         routes via runMetaBrainTurn (silent,
 *                                         tool-driven side-effects). The
 *                                         dispatch decision returns kind:
 *                                         'persona' or kind:'meta' to match
 *                                         the existing caller switch.
 * @property {string[]} [aliases]        - alternate names (e.g. ['me'] on
 *                                         the wren entry). Lowercase compared.
 */

/**
 * Resolve a parsed input against the current room. Pure function.
 *
 * @param {{type: string, cmd?: string, rest?: string, target?: string, body?: string}} parsed
 * @param {string} fullText  - original user input, used as broadcast payload
 * @param {RoomCtx} ctx
 * @returns {object} a decision the caller acts on
 */
/**
 * Look up `lower` (already lowercase) in the sibling registry. Returns
 * `{name, entry}` on hit, null on miss. Checks canonical names first,
 * then alias arrays. Pure function — no closure state.
 *
 * @param {string} lower
 * @param {Map<string, SiblingEntry>} [siblings]
 * @returns {{name: string, entry: object} | null}
 */
function resolveSibling(lower, siblings) {
  if (!siblings || siblings.size === 0) return null;
  if (siblings.has(lower)) return { name: lower, entry: siblings.get(lower) };
  for (const [name, entry] of siblings) {
    if (entry.aliases?.some(a => String(a).toLowerCase() === lower)) {
      return { name, entry };
    }
  }
  return null;
}

export function resolveRoute(parsed, fullText, ctx) {
  if (parsed.type === 'command') {
    return { kind: 'command', cmd: parsed.cmd, rest: parsed.rest ?? '' };
  }

  // forceTarget — dispatch the RAW message directly to a named being by
  // config, with NO @-text injection. Operator 2026-05-24 ("no faking
  // anymore"): auto_e chats broadcast every message to each resident
  // brain via forceTarget; each being self-selects whether to answer
  // (a '…' reply is dropped). The brain sees the full text — including
  // any "@<name>" in it — so it can tell whether it was addressed.
  if (ctx?.forceTarget) {
    const t = String(ctx.forceTarget).toLowerCase();
    const personaName = String(ctx.personaName ?? 'e').toLowerCase();
    const body = fullText || '?';
    return t === personaName
      ? { kind: 'persona', body }
      : { kind: 'meta', name: ctx.forceTarget, body };
  }

  if (parsed.type === 'mention') {
    const token = parsed.target;
    const body = parsed.body || '?';

    // Persona / sibling routing. When ctx.siblings is present, it's the
    // registry source of truth — @<token> resolves against the registry
    // (canonical name first, then any entry's aliases). Each entry
    // declares kind:'persona' (runDefaultBrainTurn semantics — item-
    // mirror, streaming, /rules awareness) or kind:'sibling' (run-
    // MetaBrainTurn — silent, tool-driven side-effects). The decision
    // carries the resolved canonical name so the caller can look up
    // the right session_id from the same EGPT_CONFIG.siblings block.
    //
    // Legacy fallback (ctx.siblings absent or empty): the historical
    // hardcoded list — egpt / e → persona, me / wren → meta — keeps
    // existing tests + pre-registry installs working unchanged.
    const rawLower = token.toLowerCase();
    const meshAddress = parseMeshAddress(rawLower);
    const localQualifiedTarget = !!(meshAddress?.qualified && ctx?.nodeName &&
      sameMeshNode(meshAddress.node, ctx.nodeName));
    if (meshAddress?.qualified && ctx?.nodeName && !localQualifiedTarget) {
      return {
        kind: 'mesh-foreign',
        target: meshAddress.fqid,
        name: meshAddress.name,
        node: meshAddress.node,
        body,
      };
    }
    const routeToken = localQualifiedTarget ? meshAddress.name : token;
    const routeLower = localQualifiedTarget ? meshAddress.name : rawLower;
    // @me is a PRONOUN, not a profile. It maps to whatever profile
    // ctx.mainEngineer names (operator 2026-05-23: "me: name1 ...
    // profiles are brains that can be mentioned"). Resolve the pronoun
    // to its target BEFORE the registry lookup, so the canonical
    // sibling answers. This replaces the old per-sibling aliases:[me]
    // pattern, which collided when two profiles both claimed "me".
    const lower = (routeLower === 'me' && ctx.mainEngineer)
      ? String(ctx.mainEngineer).toLowerCase()
      : routeLower;
    const sib = resolveSibling(lower, ctx.siblings);
    if (sib) {
      // Who talks in chat is a ROLE named by a top-level pointer
      // (ctx.personaName, default 'e'), NOT a class tag on the being
      // (operator 2026-05-23: "no personality wrappers on the team, we
      // are all pure and true beings"). The being the pointer names
      // routes to the persona/chat path; every other being is an
      // engineer (meta — silent, tool-driven). Same shape as
      // main_engineer naming @me.
      const personaName = String(ctx.personaName ?? 'e').toLowerCase();
      const kind = sib.name.toLowerCase() === personaName ? 'persona' : 'meta';
      return { kind, body, name: sib.name };
    }
    if (!ctx.siblings || ctx.siblings.size === 0) {
      if (lower === 'egpt' || lower === 'e') return { kind: 'persona', body };
      if (lower === 'me' || lower === 'wren') return { kind: 'meta', body };
    }

    // 1. Direct hit on a local session name.
    if (ctx.sessions.has(routeToken)) {
      return { kind: 'turn', recipients: [routeToken], payload: body, broadcast: false };
    }

    // 2. Token is a brain alias. Two sub-cases: local operator vs CDP brain.
    const brain = ctx.brainForName(routeToken);
    if (brain) {
      const brainCanonical = ctx.canonicalBrainName(routeToken);

      if (!brain.urlMatch) {
        // Local operator (codex, ccode) — auto-open a fresh session.
        return {
          kind: 'auto-open', brainName: brainCanonical, payload: body,
          originalToken: routeToken,
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
          message: `@${routeToken} is ambiguous; address one of: ${matches.join(', ')}`,
        };
      }
      return {
        kind: 'error',
        message: `no ${routeToken} session; /open ${routeToken} [name]`,
      };
    }

    // Bare @name that is not local but IS a being on exactly one known peer node
    // (the mesh registry) → relay to that node. Qualified @name.node took the
    // mesh-foreign path above; this lets a bare @don reach don.<peer>.
    if (meshAddress && !meshAddress.qualified && ctx?.meshNodes) {
      const peers = [];
      for (const [peerNode, info] of Object.entries(ctx.meshNodes)) {
        if (ctx.nodeName && sameMeshNode(peerNode, ctx.nodeName)) continue;
        if ((info?.beings ?? []).some(b => String(b).toLowerCase() === meshAddress.name)) {
          peers.push(String(peerNode).toLowerCase());
        }
      }
      if (peers.length === 1) {
        return { kind: 'mesh-foreign', target: `${meshAddress.name}.${peers[0]}`, name: meshAddress.name, node: peers[0], body };
      }
      if (peers.length > 1) {
        return { kind: 'error', message: `@${meshAddress.name} is on multiple nodes (${peers.join(', ')}) — qualify it, e.g. @${meshAddress.name}.${peers[0]}` };
      }
    }

    if (localQualifiedTarget) {
      return {
        kind: 'error',
        message: `@${meshAddress.fqid} targets this node, but no local participant @${routeToken} has joined the room - /sessions to see who's here`,
      };
    }

    // 3. Peer routing. Find which peer nodes have a session with this name.
    const peerMatches = [];
    for (const [nodeId, sessions] of ctx.peerSessions) {
      if (sessions.some(s => s.name === routeToken)) peerMatches.push(nodeId);
    }
    if (peerMatches.length === 1) {
      return { kind: 'peer-mention', target: routeToken, toNode: peerMatches[0], body };
    }
    if (peerMatches.length > 1) {
      return {
        kind: 'error',
        message: `@${routeToken} is ambiguous across peers: ${peerMatches.join(', ')}`,
      };
    }

    // 4. Nothing matched. Truthful framing: this token isn't a participant
    //    in the room, anywhere we can see. Don't suggest /open — that
    //    presumes the user wanted to address a brain type, but they may
    //    have misremembered a session name. /sessions tells the truth.
    return {
      kind: 'error',
      message: `no participant @${routeToken} has joined the room — /sessions to see who's here`,
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
