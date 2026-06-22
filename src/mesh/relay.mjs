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
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');
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
  isLocalBeing = () => false,        // (being) => bool
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
  const seen = new Set();       // tiny replay guard (content keys already acted on)
  const SEEN_CAP = 500;
  const mark = (k) => { seen.add(k); if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value); };
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
  async function forwardToward(destNode, prov, fromRoute, dir) {
    if (!destNode || !prov.mid) return false;
    if (fwdSeen.checkAndMark(`${dir}:${prov.mid}`)) { log(`mesh: drop ${dir} ${prov.mid} — already forwarded`); return false; }
    const dest = resolveRoute(destNode);
    if (!dest || _routeKey(dest) === _routeKey(fromRoute)) return false;   // no onward route / would echo back
    log(`mesh: forward ${dir} ${prov.mid} → ${destNode}`);
    return guardedSend(dest, encodeMesh({
      from: prov.from, from_node: prov.from_node, by: prov.by, to: prov.to, re: prov.re,
      post_id: prov.post_id, mid: prov.mid, body: prov.body, done: prov.done,
    }));
  }

  // ── ORIGIN: relay a human's @being message to the channel where its node listens ──
  async function relayOut({ being, toNode, body = '', origin = null, sender = '' } = {}) {
    const route = resolveRoute(toNode);
    if (!route) { await surface(origin, `!! mesh: no route to ${toNode}`); return false; }
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
      const ok = await guardedSend(route, encodeMesh({ by: sender || 'someone', body, from: fromName, from_node: String(node), to: `${being}.${toNode}`, post_id: postId || '', mid }));
      if (!ok) { await surface(origin, `!! mesh: too many sends to ${being}.${toNode}'s channel — paused (loop guard)`); return false; }
    }
    catch (e) { await surface(origin, `!! mesh relay to ${being}.${toNode} failed: ${e?.message ?? e}`); return false; }
    if (fromName && origin) awaiting.set(fromName, origin);
    return true;
  }

  // ── INBOUND: any observed message. Returns true iff it was mesh traffic we
  //    consumed (caller then skips normal handling). ──
  async function onRoomMessage({ route, text, msgId = null } = {}) {
    const prov = parseMesh(text);
    if (!prov) return false;                       // ordinary message — not ours

    // A REPLY (carries `re:`) — a LIVING MIRROR carried by EDITS (rate-free, unlike posts):
    //   ORIGIN  (we're awaiting it): mirror every edit onto the origin placeholder.
    //   TRANSIT (we're a hop toward the origin node): re-mirror — post a forwarded copy in
    //           the next room and EDIT it as the upstream streams, chaining the stream on.
    // Correlate by the upstream message's OWN id (msgId), stable across first sight + every
    // later edit (onRoomMessageEdit). Only the FIRST forward (a new post) is loop-guarded
    // (forward-once per mid); the edits that follow can't loop.
    if (prov.re) {
      const dotIdx = prov.re.lastIndexOf('.');
      const reChatId = dotIdx >= 0 ? prov.re.slice(0, dotIdx) : prov.re;
      const reNode = (dotIdx >= 0 ? prov.re.slice(dotIdx + 1) : '').toLowerCase();
      const back = awaiting.get(reChatId) || awaiting.get(prov.re);
      log(`mesh: reply re:${prov.re} mid:${prov.mid || '-'} msgId:${msgId ?? '-'} back:${back ? 'yes' : 'NO'} tracked:${streamingIn.has(String(msgId)) ? 'yes' : 'no'}`);

      if (msgId != null) {
        let s = streamingIn.get(String(msgId));
        if (!s) {
          if (back && openOriginStream) {
            // ORIGIN: edit the origin placeholder (post_id) in place.
            const handle = openOriginStream(back, { by: prov.by, msgId: prov.post_id || null });
            if (handle) { s = { handle }; awaiting.delete(reChatId); }
          } else if (!back && openRelayStream && prov.mid && reNode && reNode !== String(node).toLowerCase()
                     && !fwdSeen.checkAndMark(`rep:${prov.mid}`)) {
            // TRANSIT: post a forwarded copy toward the origin node, then edit it as the
            // upstream streams. forward-once per mid guards only this initial post.
            const dest = resolveRoute(reNode);
            if (dest && _routeKey(dest) !== _routeKey(route)) {
              log(`mesh: transit-mirror rep ${prov.mid} → ${reNode}`);
              const handle = openRelayStream(dest, { by: prov.by, re: prov.re, mid: prov.mid });
              if (handle) s = { handle };
            }
          }
          if (s) {
            streamingIn.set(String(msgId), s);
            if (streamingIn.size > STREAM_CAP) { const k = streamingIn.keys().next().value; streamingIn.delete(k); }
          }
        }
        if (s) {
          if (prov.done) { streamingIn.delete(String(msgId)); await s.handle.finish?.(prov.body); }
          else await s.handle.update?.(prov.body);
          return true;
        }
      }

      // No msgId / no stream primitive: the ORIGIN surfaces once (a transit can't mirror).
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
    if (target) {
      if (target !== String(node).toLowerCase()) { await forwardToward(target, prov, route, 'req'); return true; }
      if (!isLocalBeing(being)) {
        await guardedSend(route, encodeMesh({ by: `${being}.${node}`, body: `no ${being}.${node} here`, re: reAddress, mid: prov.mid }));
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
      relayDispatch({ being, prompt, route, re: reAddress, post_id: prov.post_id, by: `${being}.${node}`, mid: prov.mid })
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
    await guardedSend(route, encodeMesh({ by: `${being}.${node}`, body: _stamp ? `${_stamp} ${_fbBody}` : _fbBody, re: reAddress, post_id: prov.post_id, mid: prov.mid, done: true }));
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
    const s = streamingIn.get(String(msgId));
    if (!s) return false;                          // not a tracked relay reply — bridge handles it
    const prov = parseMesh(text);
    if (!prov) return true;
    if (prov.done) { streamingIn.delete(String(msgId)); await s.handle.finish?.(prov.body); }
    else await s.handle.update?.(prov.body);
    return true;
  }

  return { relayOut, onRoomMessage, onRoomMessageEdit, awaiting };
}
