// Human-first mesh relay. The carrier is an ordinary, visible chat message; the
// only machine bit is a trailing, human-READABLE provenance block (fenced YAML),
// so a human — and any spine watching — can always see where a relayed message
// came from and who sent it. No cryptic tags, no minted ids, no ttl.
//
//   ```
//   hi @don
//
//   ---
//   from: HFM
//   by: An
//   to: do
//   ```
//
// Principles (An/e7, 2026-06-19):
//   - The body is the human's OWN message, unchanged — "@don" stays "@don" (so a
//     limb can't linkify "don.do"). The owning spine self-selects: it runs the
//     being it owns that is @mentioned.
//   - A message that already carries a provenance block is relay traffic: consume
//     it, NEVER re-relay (loop-safe).
//   - Asked ⇒ answer. The peer either runs the being or says "no <being>.<node>
//     here" — never silence.
//   - The reply echoes `re: <origin>` so the relaying spine surfaces it home,
//     correlated without any minted id.
//   - On relay, the origin gets an HONEST "↪ relayed — waiting…" — not a faked
//     "thinking…" the relayer can't actually know.

import { makeMeshRequestId, createMeshSeenCache } from './envelope.mjs';

// ── provenance encode / parse ─────────────────────────────────────────────
const DIVIDER = /\n[ \t]*---[ \t]*\n/;
// 'done' marks the final frame. The being's body_emoji is stamped INTO the body by
// the responder (it owns the emoji), not carried as a key.
const PROV_KEYS = new Set(['from', 'by', 'to', 're', 'sig', 'done', 'enc', 'post_id', 'from_node', 'mid']);
const MENTION_RE = /(?:^|\s)@([a-z0-9_-]+)\b/i;

// Body codec (An 2026-06-20): base64 so the transport can't mangle the body. Beeper
// renders ``` → <pre><code> → `` and a CODE-bearing reply (Don writes code!) collides
// with the fence → the mirror edit breaks ("Failed to edit"). base64 is markdown-inert
// (no backticks / --- / <>) → delivered verbatim; the TAIL stays readable. node-only
// module → Buffer is available.
const b64encode = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const b64decode = (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf8');

// `to` (target node) is what makes "never silence" work without a chorus: only
// the named node answers (or says "no <being>.<node> here"); every other spine
// stays quiet. It rides the provenance, not the body, so "@don" stays "@don"
// (a limb can't linkify "don.do").
export function encodeMesh({ by = '', body = '', from = '', from_node = '', to = '', re = '', post_id = '', mid = '', done = false } = {}) {
  const lines = [];   // omit EMPTY keys — an empty "from:" on a reply leaked into the surfaced body
  if (from) lines.push(`from: ${from}`);
  // `from_node` rides the REQUEST so the responder can build a node-qualified return
  // address: `re: ${from}.${from_node}` (e.g. "HFM.kg"). The origin parses the node
  // suffix to resolve the return route; without it, replies can't stream back.
  if (from_node) lines.push(`from_node: ${from_node}`);
  if (by) lines.push(`by: ${by}`);
  if (to) lines.push(`to: ${to}`);
  if (re) lines.push(`re: ${re}`);
  // `mid` = minted request id (origin), preserved across forwards. A spine forwards a
  // given `mid` at most once → multi-hop transit is loop-safe and self-terminating.
  if (mid) lines.push(`mid: ${mid}`);
  // `post_id` is the Beeper msgId of the origin placeholder ("🤔") that was posted in
  // the origin chat. The responder echoes it back in EVERY reply frame so the origin
  // knows WHICH message to edit as the mirrored reply streams.
  const _pid = typeof post_id === 'string' ? post_id : '';
  if (_pid) lines.push(`post_id: ${_pid}`);
  // `done` marks the FINAL frame so the origin finalizes the mirror (appends "✅ Done").
  // It is a DISPLAY finish marker, not a teardown that drops edits: every non-done frame
  // still flows onto the mirror (the living pipe); done only says "the turn is complete".
  if (done) lines.push(`done: true`);
  // Body is base64 (An 2026-06-20): markdown-inert, so the transport can't mangle it
  // and a code-bearing reply can't collide with the fence. The TAIL stays readable
  // for routing + light provenance; only the body is opaque (a privacy bonus in the
  // relay channel). `enc: b64` marks it so parseMesh decodes; un-tagged = legacy raw.
  lines.push('enc: b64');
  // Fence keeps the structure delivered verbatim (the --- divider intact).
  return '```\n' + `${b64encode(String(body).trim())}\n\n---\n${lines.join('\n')}` + '\n```';
}

// A bridge may deliver our own echo RENDERED as HTML — the 2026-06-19 loop was
// exactly this: "<p>An: hi <a href='http://don.do'>@don</a></p><hr><pre>from: …"
// went unrecognised, so the message was re-relayed forever (each pass prepending
// another "An:"). Strip the markup first.
function stripRender(s) {
  return String(s ?? '')
    .replace(/<\s*(?:br|hr|p|div)\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
    // Beeper auto-linkifies `don.do`/`wren.kg` → `[don.do](http://don.do)`, which would
    // mangle a `to:`/`re:` value in the (plaintext) tail. Collapse markdown links to text.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

// Tolerant of bridge transmutation (HTML, mangled/stripped fences, no divider):
// we trust the trailing run of `key: value` provenance lines, found by scanning
// UP from the end — so we ALWAYS recognise our own relayed message (and never
// re-relay it), divider or no divider.
export function parseMesh(text) {
  const lines = stripRender(text).split(/\r?\n/);
  const prov = {};
  let i = lines.length - 1;
  let provStart = lines.length;
  while (i >= 0) {
    const line = lines[i];
    const kv = line.match(/^[ \t>*_~`-]*([a-zA-Z][a-zA-Z_]*)[ \t]*:[ \t]*(.+?)[ \t]*$/);
    if (kv && PROV_KEYS.has(kv[1].toLowerCase())) { prov[kv[1].toLowerCase()] = kv[2]; provStart = i; i--; continue; }
    if (line.trim() === '' || /^-{3,}$/.test(line.trim()) || /^`+$/.test(line.trim())) { i--; continue; }
    break;
  }
  if (Object.keys(prov).length === 0) return null;
  // body = everything above the provenance, minus the outer fence / divider edges.
  const bodyLines = lines.slice(0, provStart);
  // edge = fence / divider / blank / a stray EMPTY provenance key ("from:") — none
  // of which belong in the surfaced body.
  const edge = (l) => /^(?:`+|-{3,}|\s*|(?:from|by|to|re|sig|done|enc)\s*:\s*)$/i.test(String(l).trim());
  while (bodyLines.length && edge(bodyLines[0])) bodyLines.shift();
  while (bodyLines.length && edge(bodyLines[bodyLines.length - 1])) bodyLines.pop();
  let body = bodyLines.join('\n').trim();
  if (prov.enc === 'b64') {
    try { body = b64decode(body); } catch { /* malformed — leave as-is */ }
  } else if (prov.by) {   // legacy un-encoded: peel an old-format "by:" (or "An: An:") prefix
    const esc = prov.by.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp('^(?:' + esc + '[ \\t]*:[ \\t]*)+', 'i'), '').trim();
  }
  return { body, from: prov.from || '', from_node: prov.from_node || '', by: prov.by || '', to: prov.to || '', re: prov.re || '', sig: prov.sig || '', done: prov.done === 'true', enc: prov.enc || '', post_id: prov.post_id || '', mid: prov.mid || '' };
}

export function mentionedBeing(text) {
  const m = MENTION_RE.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export function createMeshRelay({
  node,                              // this spine's node_name (e.g. "kg", "do")
  send,                              // (route, text) => Promise — post into the relay channel
  surface = async () => {},          // (returnTo, text) => Promise — deliver to an origin chat
  ack = null,                        // (origin, text) => Promise — status on the origin msg; defaults to surface
  // ackWithPostId: like ack but returns the Beeper msgId of the posted placeholder, so it
  // can ride the relay request as `post_id`. The responder echoes it back in every reply
  // frame; the origin uses it to EDIT (not re-post) the placeholder as the stream arrives.
  // Null → ack/surface fallback (no streaming edit, one-shot surfacing only).
  ackWithPostId = null,              // (origin, text) => Promise<string|null>
  runBeing = async () => '',         // (being, prompt, ctx) => Promise<string>
  beingEmoji = () => '',             // (being) => body_emoji — stamps the relayed reply (contract)
  resolveRoute = () => null,         // (toNode) => route | null
  // isSelfNode(name) — is this node-name ONE OF OURS? node_name ∪ node_alias (operator
  // 2026-07-05): one process may answer to several node identities, so a REQUEST whose
  // target node is any self-name is handled locally (never forwarded to ourselves), and
  // the reply is stamped with the identity it was ADDRESSED AS. Defaults to plain
  // equality with `node` so a single-identity node is unchanged.
  isSelfNode = (n) => String(n).toLowerCase() === String(node).toLowerCase(),
  isLocalBeing = () => false,        // (being) => bool
  resolveBeingRelay = () => null,    // (being) => {being,node}|null — relay-record: re-resolve to another node
  // STREAMING — a relayed reply is a LIVING MIRROR (An 2026-06-21). Edit-streaming
  // is a bridge property, so a relayed reply streams for free; the relay just mirrors.
  //   RESPONDER: relayDispatch({being,prompt,route,re,post_id,by}) → edit-stream ONE
  //     relay-room message wrapped in the mesh tail (by/emoji/re/post_id). The responder's
  //     OWN edits are suppressed locally by the bridge but propagate to the origin.
  //     Null → one-shot runBeing fallback.
  //   ORIGIN: openOriginStream(returnTo, info{by,emoji,msgId}) → {update,finish}. info.msgId
  //     is the origin placeholder (post_id) to edit IN PLACE; emoji stamps identity. We
  //     mirror the responder's first send + every later edit onto it, correlated by the
  //     relay message's OWN id; the `done` frame finalizes (✅ Done). Null → one-shot.
  relayDispatch = null,
  openOriginStream = null,
  // (route, info{by,re,mid}) => {update,finish} — TRANSIT: post a forwarded reply copy into
  // `route` and EDIT it as the upstream streams (chained-edit mirror, one hop onward).
  openRelayStream = null,
  log = () => {},
} = {}) {
  const awaiting = new Map();   // origin name -> returnTo (so a reply's `re:` surfaces home)
  // ORIGIN-side: relayRoomMsgId -> { handle } for an in-flight relayed reply we're
  // mirroring (the responder edits its relay-room message; we edit ours in the origin
  // chat). Capped; entries cleared on the `done` frame.
  const streamingIn = new Map();
  const STREAM_CAP = 50;
  // A streamed reply mirror is keyed by `${mid}@${room}` (mid stable across a transport that
  // re-delivers a self-relayed post under changing ids; room keeps each hop's reverse-mirror
  // stage distinct in a single-process chain). A two-process responder streams its reply via
  // EDITS that reach us as onRoomMessageEdit under a STABLE raw msgId — which carries no room —
  // so index msgId → the stream key its opening post registered, so an edit finds its mirror.
  const msgIdToKey = new Map();
  const MSGID_KEY_CAP = 200;
  const rememberMsgKey = (msgId, key) => {
    if (msgId == null || key == null) return;
    msgIdToKey.set(String(msgId), key);
    if (msgIdToKey.size > MSGID_KEY_CAP) msgIdToKey.delete(msgIdToKey.keys().next().value);
  };
  const seen = new Set();       // tiny replay guard (content keys already acted on)
  const SEEN_CAP = 500;
  const mark = (k) => { seen.add(k); if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value); };
  // Reply-mirror STAGES already FINALIZED (a done frame was delivered), keyed the SAME way
  // streamingIn is (`${mid}@${room}`, else `x:${msgId}`). A single-process self-relay re-observes
  // its OWN reply posts under several transport ids even AFTER a stage's mirror finished; this
  // makes those late re-deliveries inert — no duplicate finish, no spurious return-mirror.
  // Per-STAGE (per room), so a genuine next hop of the same mid in another room still fires.
  const repliesDone = new Set();
  const REPLIES_DONE_CAP = 500;
  const markReplyDone = (k) => { repliesDone.add(k); if (repliesDone.size > REPLIES_DONE_CAP) repliesDone.delete(repliesDone.values().next().value); };
  const notify = ack || surface;

  // CIRCUIT BREAKER — a hard, mesh-local bound that no parse bug can defeat: cap
  // mesh sends per channel per window. If the cap trips, mesh sends to that
  // channel STOP (logged loudly). This is the fail-safe the bot↔bot loop-guard
  // could NOT provide (the mesh path runs before it AND posts as the operator, so
  // the guard never saw it). Belt to the parser's suspenders.
  const _sendLog = new Map();   // routeKey -> [ts]
  const SEND_CAP = 5, SEND_WINDOW = 20_000;
  async function guardedSend(route, text) {
    const key = String(route?.room_id ?? route?.chat ?? JSON.stringify(route ?? null));
    const t = Date.now();
    const arr = (_sendLog.get(key) || []).filter((x) => t - x < SEND_WINDOW);
    if (arr.length >= SEND_CAP) {
      _sendLog.set(key, arr);
      log(`mesh: ⛔ CIRCUIT BREAKER tripped — ${arr.length}+ sends in ${SEND_WINDOW / 1000}s to ${key}; mesh sends PAUSED (loop guard)`);
      return false;
    }
    arr.push(t); _sendLog.set(key, arr);
    await send(route, text);
    return true;
  }

  // ── MULTI-HOP TRANSIT (loop-safe): a spine that isn't the destination forwards the
  //    message one hop toward it, via resolveRoute(destNode). `mid` (minted at the origin)
  //    is forwarded at most ONCE per direction (fwdSeen) — so the message reaches every
  //    reachable node ~once and self-terminates; a loop can't run away. No mid ⇒ never
  //    forwarded.
  const fwdSeen = createMeshSeenCache();
  const _routeKey = (r) => String(r?.room_id ?? r?.chat ?? JSON.stringify(r ?? null));
  // Reverse path for replies, ROOM-SCOPED so it chains through ARBITRARILY MANY hops even
  // inside ONE process (operator 2026-07-05: an N-hop relay-record chain relayed through a
  // single node's several aliases). At each forward, remember: a reply for `mid` that comes
  // back in the room we forwarded INTO (`outRoute`) must re-mirror into the room the request
  // ARRIVED in (`inRoute`). Key = `${mid}@${outRoom}` → inRoute. Each hop records only ITS OWN
  // pair — it never needs to know how many hops came before/after, so the mechanism is fully
  // general (no depth limit; the mesh.ttl hop-cap in mesh.mjs bounds total hops). A mid-only
  // map would COLLIDE across hops in one process (every hop overwriting the same slot); the
  // room scope keeps each hop's reverse leg distinct. Bounded LRU.
  const fwdArrival = new Map();   // `${mid}@${outRoom}` -> inRoute (the room to mirror the reply back into)
  const FWD_ARRIVAL_CAP = 500;
  const rememberArrival = (mid, outRoute, inRoute) => {
    if (!mid || !outRoute || !inRoute) return;
    fwdArrival.set(`${String(mid)}@${_routeKey(outRoute)}`, inRoute);
    if (fwdArrival.size > FWD_ARRIVAL_CAP) fwdArrival.delete(fwdArrival.keys().next().value);
  };
  async function forwardToward(destNode, prov, fromRoute, dir) {
    if (!destNode || !prov.mid) return false;
    if (fwdSeen.checkAndMark(`${dir}:${prov.mid}`)) { log(`mesh: drop ${dir} ${prov.mid} — already forwarded`); return false; }
    const dest = resolveRoute(destNode);
    if (!dest || _routeKey(dest) === _routeKey(fromRoute)) return false;   // no onward route / would echo back
    if (dir === 'req') rememberArrival(prov.mid, dest, fromRoute);         // reply comes back in dest's room → mirror to fromRoute
    log(`mesh: forward ${dir} ${prov.mid} → ${destNode}`);
    return guardedSend(dest, encodeMesh({
      from: prov.from, from_node: prov.from_node, by: prov.by, to: prov.to, re: prov.re,
      post_id: prov.post_id, mid: prov.mid, body: prov.body, done: prov.done,
    }));
  }

  // ── ORIGIN: relay a human's @being message to the channel where its node listens ──
  // `route` (route-direct) short-circuits resolveRoute(toNode): a `type: relay` agent
  // supplies the relay_channel directly, with no node. When there's no toNode the
  // envelope carries an EMPTY `to:` — the open-channel path (the owner of `being` on the
  // other end answers, everyone else stays silent) — and the labels drop the `.node`.
  async function relayOut({ being, toNode, route: directRoute = null, to: explicitTo = '', body = '', origin = null, sender = '' } = {}) {
    const route = directRoute ?? resolveRoute(toNode);
    const tgt = explicitTo || (toNode ? `${being}.${toNode}` : being);   // human-readable label
    if (!route) { await surface(origin, `!! mesh: no route to ${tgt}`); return false; }
    const fromName = (origin && origin.name) || '';
    // Post the placeholder FIRST so we can capture its msgId as post_id. The responder
    // echoes post_id back in every reply frame so the origin knows which message to edit
    // as the stream arrives. The placeholder carries TEXT (not a lone emoji) — a bare
    // emoji renders jumbo-big on WhatsApp/Beeper; it's edited in place into the reply.
    let postId = null;
    const statusText = '🤔 thinking…';
    if (ackWithPostId) {
      try {
        const _raw = await ackWithPostId(origin, statusText);
        postId = typeof _raw === 'string' ? _raw : null;
      } catch { /* best-effort */ }
    } else {
      await notify(origin, statusText);
    }
    try {
      // `from_node` lets the responder build `re: ${fromName}.${node}` (e.g. "HFM.kg")
      // so the origin can parse the return-node and look up the right route + awaiting entry.
      // `to: being.node` (e.g. "don.do") encodes both target being and node so the responder
      // can identify without relying on @mention parsing.
      const mid = makeMeshRequestId({ node });
      // A relay agent's declarative `to: <being>.<node>` names the next hop (chain); else a
      // node-qualified target (mesh.nodes scheme); else empty = open-channel (no target node).
      const to = explicitTo || (toNode ? `${being}.${toNode}` : '');
      const ok = await guardedSend(route, encodeMesh({ by: sender || 'someone', body, from: fromName, from_node: String(node), to, post_id: postId || '', mid }));
      if (!ok) { await surface(origin, `!! mesh: too many sends to ${tgt}'s channel — paused (loop guard)`); return false; }
    }
    catch (e) { await surface(origin, `!! mesh relay to ${tgt} failed: ${e?.message ?? e}`); return false; }
    if (fromName && origin) awaiting.set(fromName, origin);
    return true;
  }

  // ── INBOUND: any observed message. Returns true iff it was mesh traffic we
  //    consumed (caller then skips normal handling). ──
  async function onRoomMessage({ route, text, msgId = null } = {}) {
    const prov = parseMesh(text);
    if (!prov) return false;                       // ordinary message — not ours

    // A REPLY (carries `re:`) — a LIVING MIRROR:
    //   ORIGIN  (we're awaiting it): mirror the reply onto the origin placeholder, then finish.
    //   TRANSIT (we forwarded this mid's request): re-mirror one hop back toward the origin,
    //           chaining hop-by-hop for an arbitrarily long chain (rodz3→rodz2→rodz1).
    // Correlate a mirror stage by `${mid}@${room}` (see below): the mid is stable across a
    // transport re-delivering the same post under changing ids, and the room keeps each reverse
    // stage of a single-process chain distinct. A two-process responder's streamed EDITS reach
    // us via onRoomMessageEdit under one stable msgId, resolved through msgIdToKey.
    if (prov.re) {
      const dotIdx = prov.re.lastIndexOf('.');
      const reChatId = dotIdx >= 0 ? prov.re.slice(0, dotIdx) : prov.re;
      // The return address is `<origin-chat>.<origin-node>` (e.g. "HFM.kg") — the node
      // suffix is the ORIGIN node a transit hop must carry the reply back toward.
      const originNode = dotIdx >= 0 ? prov.re.slice(dotIdx + 1).toLowerCase() : '';
      const back = awaiting.get(reChatId) || awaiting.get(prov.re);
      const roomKey = _routeKey(route);
      // Correlate every frame of ONE reply-mirror STAGE by `${mid}@${room}`. The mid is stable
      // across all frames AND across a transport that re-delivers the SAME post under several ids
      // (single-process self-relay, 2026-07-05: our OWN mesh posts are re-observed — envelopes
      // bypass echo suppression — and Beeper hands each one back under a pending THEN a confirmed
      // id, two upserts with DIFFERENT ids, while our streaming EDITS are self-suppressed). The
      // ROOM disambiguates the SAME mid arriving at DIFFERENT reverse-mirror stages of one N-hop
      // chain inside one process (rodz3→rodz2→rodz1): each stage is its own mirror. Fallback to
      // the raw msgId for a legacy/mid-less reply (a single stable id anyway).
      const key = prov.mid ? `${prov.mid}@${roomKey}` : (msgId != null ? `x:${String(msgId)}` : null);
      log(`mesh: reply re:${prov.re} mid:${prov.mid || '-'} msgId:${msgId ?? '-'} room:${roomKey} back:${back ? 'yes' : 'NO'} tracked:${key != null && streamingIn.has(key) ? 'yes' : 'no'}`);

      if (key != null) {
        // This stage already finalized → a redundant re-delivery of an old frame; inert.
        // Never re-open a mirror, never re-fire a return-mirror, never double-finish.
        if (repliesDone.has(key)) { rememberMsgKey(msgId, key); return true; }
        let s = streamingIn.get(key);
        if (!s) {
          // RETURN HOP takes precedence over origin resolution: in a single-process chain the
          // origin's `awaiting` entry matches at EVERY reverse stage (it's process-global), so a
          // room-scoped reverse leg must win until the reply reaches the ORIGIN's own room (where
          // no forward was recorded → falls through to origin). `${mid}@${room}` = the reverse
          // room this hop recorded when it forwarded INTO `room`. The mesh.nodes multi-process
          // fallback (resolveRoute of the origin node) is gated on !back so it never hijacks a
          // real origin's resolution; it only serves a transit node that isn't the origin.
          const revTo = prov.mid
            ? (fwdArrival.get(key) || (!back && fwdSeen.has(`req:${prov.mid}`) ? resolveRoute(originNode) : null))
            : null;
          if (revTo && openRelayStream) {
            // TRANSIT: re-mirror the reply one hop back toward the origin, into `revTo`.
            log(`mesh: return-mirror rep ${prov.mid} @${roomKey} → ${_routeKey(revTo)} (I forwarded its request)`);
            const handle = openRelayStream(revTo, { by: prov.by, re: prov.re, mid: prov.mid });
            if (handle) s = { handle };
          } else if (back && openOriginStream) {
            // ORIGIN: edit the origin placeholder (post_id) in place.
            const handle = openOriginStream(back, { by: prov.by, msgId: prov.post_id || null });
            if (handle) { s = { handle }; awaiting.delete(reChatId); }
          }
          if (s) {
            streamingIn.set(key, s);
            if (streamingIn.size > STREAM_CAP) { const k = streamingIn.keys().next().value; streamingIn.delete(k); }
          }
        }
        rememberMsgKey(msgId, key);                  // let a later onRoomMessageEdit under this id find the mirror
        if (s) {
          if (prov.done) { streamingIn.delete(key); markReplyDone(key); await s.handle.finish?.(prov.body); }
          else await s.handle.update?.(prov.body);
          return true;
        }
      }

      // No stream primitive / no mirror could open: the ORIGIN surfaces once (a transit can't mirror).
      if (back) { awaiting.delete(reChatId); await surface(back, prov.body, { by: prov.by }); return true; }
      log(`mesh: reply re:${prov.re} not awaited here`);
      return true;                                   // consume either way (never re-relay)
    }

    // A REQUEST. `to` (target) decides who is on the hook:
    //   - to == "being.node" (new)  → I answer if my node matches and being is local.
    //   - to == "node" (legacy)     → I answer if my node matches; being from @mention.
    //   - no `to`                   → open shared chat: only the owner answers, others silent.
    // Build return address before the target check so "no being here" carries it.
    const reAddress = prov.from && prov.from_node ? `${prov.from}.${prov.from_node}` : prov.from;
    const toParts = (prov.to || '').split('.');
    let being, target;
    if (prov.to && toParts.length >= 2) {
      being = toParts[0].toLowerCase();
      target = toParts[toParts.length - 1].toLowerCase();
    } else {
      being = mentionedBeing(prov.body);
      target = (prov.to || '').toLowerCase();
    }
    if (!being) return true;
    // The self-name we were ADDRESSED AS: the `to`-node when it's ours (guaranteed self by
    // the check below), else node_name for open-channel (no `to`). This is what the reply is
    // stamped `by: <being>.<asNode>` with, so the wire story stays coherent per-identity when
    // one process wears several node names (operator 2026-07-05).
    const asNode = target || String(node).toLowerCase();
    if (target) {
      if (!isSelfNode(target)) { await forwardToward(target, prov, route, 'req'); return true; }
      // RELAY-RECORD: `being` is configured here as a relay to ANOTHER node's being — ALWAYS
      // re-address and forward into its OWN configured route (no self/local "collapse": mesh
      // envelopes are echo-suppression-exempt now, so a chain relayed through one process posts a
      // REAL, visible envelope at every hop — the collapse was a premature optimization that is
      // no longer even true). This generalizes to an ARBITRARY-length chain: each hop only knows
      // its OWN relay-record and forwards one step; the mesh.ttl hop-cap (mesh.mjs) bounds total
      // hops. Forward-once is scoped to THIS hop's identity (`being`) — NOT just the mid — because
      // a single process relaying a chain through itself checks/marks forward-once for the SAME
      // mid at EVERY hop (mid is preserved verbatim), so an unscoped `req:${mid}` would let hop 1
      // silently swallow hop 2's legitimate forward of the same mid. `req:${mid}:${being}` gives
      // each hop its own gate while still blocking a given hop from re-forwarding the same mid.
      const _rec = resolveBeingRelay(being);
      if (_rec) {
        if (prov.mid && !fwdSeen.checkAndMark(`req:${prov.mid}:${being}`)) {
          const dest = _rec.route ?? resolveRoute(_rec.node);   // relay agent's own channel, else mesh.nodes
          if (dest) {
            rememberArrival(prov.mid, dest, route);             // reply for mid coming back in dest's room → mirror to this arrival room
            log(`mesh: relay-record ${being}.${node} → ${_rec.being}.${_rec.node}`);
            await guardedSend(dest, encodeMesh({ from: prov.from, from_node: prov.from_node, by: prov.by, to: `${_rec.being}.${_rec.node}`, re: prov.re, post_id: prov.post_id, mid: prov.mid, body: prov.body }));
          }
        }
        return true;
      }
      if (!isLocalBeing(being)) {
        await guardedSend(route, encodeMesh({ by: `${being}.${asNode}`, body: `no ${being}.${asNode} here`, re: reAddress, mid: prov.mid }));
        return true;
      }
    } else if (!isLocalBeing(being)) {
      return true;
    }

    const key = `${being}${prov.from}${prov.body}`;
    if (seen.has(key)) { log(`mesh: replay dropped for ${being}`); return true; }
    mark(key);

    const prompt = prov.body.replace(MENTION_RE, '').trim() || prov.body.trim();
    // RESPONDER: edit-stream the being's reply into the relay room as ONE message
    // wrapped in the mesh tail (re/by/post_id, NO done). The responder's own edits
    // are suppressed locally by the bridge but propagate to the origin, which mirrors
    // them onto its placeholder. Non-blocking: relayDispatch fires the dispatch; we
    // don't await the whole turn here.
    if (relayDispatch) {
      relayDispatch({ being, prompt, route, re: reAddress, post_id: prov.post_id, by: `${being}.${asNode}`, mid: prov.mid })
        .catch((e) => log(`mesh: relayDispatch ${being} failed: ${e?.message ?? e}`));
      return true;
    }
    // Fallback (no relayDispatch wired): run the being one-shot and post the reply.
    let reply;
    try { reply = await runBeing(being, prompt, { from: prov.from, by: prov.by }); }
    catch (e) { reply = `(${being}.${node} error: ${e?.message ?? e})`; }
    if (reply == null || String(reply).trim() === '') reply = '…';
    const _stamp = beingEmoji(being);
    const _fbBody = String(reply).trim() || '…';
    await guardedSend(route, encodeMesh({ by: `${being}.${asNode}`, body: _stamp ? `${_stamp} ${_fbBody}` : _fbBody, re: reAddress, post_id: prov.post_id, mid: prov.mid, done: true }));
    return true;
  }

  // ── ORIGIN: the responder edit-streamed its relay-room message. Mirror the new
  //    version onto the origin placeholder, correlated by the relay message's own id
  //    (the same id its first sight opened the stream under). Every edit flows onto the
  //    mirror (the living pipe); the `done` frame finalizes it (origin appends "✅ Done").
  //    Returns true iff it's a relayed reply we track (the caller then skips its normal
  //    incoming-edit handling).
  //
  //    NOTE: the responder NEVER sees this for its own reply — the bridge suppresses a
  //    node's own streaming edits before the edit hook fires (_ourStreamIds). So there
  //    is no "forward my own edit" path: in a shared relay room the origin observes the
  //    responder's edits directly.
  async function onRoomMessageEdit({ msgId, text } = {}) {
    // A responder's streamed reply reaches us as EDITS under the SAME raw msgId its opening post
    // was seen under (onRoomMessage). That post registered the stream's `${mid}@${room}` key in
    // msgIdToKey, so resolve through it — the edit itself carries no room to rebuild the key.
    const key = msgId != null ? msgIdToKey.get(String(msgId)) : null;
    const s = key != null ? streamingIn.get(key) : null;
    if (!s) return false;                          // not a tracked relay reply — bridge handles it
    const prov = parseMesh(text);
    if (!prov) return true;                        // tracked but unparseable — consume, don't mirror garbage
    if (prov.done) { streamingIn.delete(key); markReplyDone(key); await s.handle.finish?.(prov.body); }
    else await s.handle.update?.(prov.body);
    return true;
  }

  return { relayOut, onRoomMessage, onRoomMessageEdit, awaiting };
}
