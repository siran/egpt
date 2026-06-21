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

// ── provenance encode / parse ─────────────────────────────────────────────
const DIVIDER = /\n[ \t]*---[ \t]*\n/;
// Keep 'emoji' in PROV_KEYS so old messages with emoji: in the tail still parse
// correctly (the bottom-up scan stops at unrecognised keys). We no longer emit it.
const PROV_KEYS = new Set(['from', 'by', 'to', 're', 'sig', 'emoji', 'done', 'enc', 'post_id', 'from_node']);
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
export function encodeMesh({ by = '', body = '', from = '', from_node = '', to = '', re = '', done = false, post_id = '' } = {}) {
  const lines = [];   // omit EMPTY keys — an empty "from:" on a reply leaked into the surfaced body
  if (from) lines.push(`from: ${from}`);
  // `from_node` rides the REQUEST so the responder can build a node-qualified return
  // address: `re: ${from}.${from_node}` (e.g. "HFM.kg"). The origin parses the node
  // suffix to resolve the return route; without it, replies can't stream back.
  if (from_node) lines.push(`from_node: ${from_node}`);
  if (by) lines.push(`by: ${by}`);
  if (to) lines.push(`to: ${to}`);
  if (re) lines.push(`re: ${re}`);
  // `post_id` is the Beeper msgId of the origin placeholder ("↪ relayed — waiting…")
  // that was posted in the origin chat. The responder echoes it back in every reply
  // frame so the origin knows WHICH message to edit as the stream progresses.
  const _pid = typeof post_id === 'string' ? post_id : '';
  if (_pid) lines.push(`post_id: ${_pid}`);
  // `done` (An 2026-06-20): marks the FINAL frame of a streamed reply, so the
  // origin knows when to finalize the mirrored stream (vs keep editing).
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
  return { body, from: prov.from || '', from_node: prov.from_node || '', by: prov.by || '', to: prov.to || '', re: prov.re || '', sig: prov.sig || '', done: prov.done === 'true', enc: prov.enc || '', post_id: prov.post_id || '' };
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
  resolveRoute = () => null,         // (toNode) => route | null
  isLocalBeing = () => false,        // (being) => bool
  // STREAMING (An 2026-06-20): edit-streaming is a bridge property, so a relayed
  // reply streams for free — the relay just routes.
  //   RESPONDER: relayDispatch({being,prompt,route,re,by,emoji}) → hand the prompt
  //     to the host's NORMAL dispatch; the being replies like any prompt (universal
  //     streaming) and the host wraps each frame in the mesh tail. Null → one-shot
  //     runBeing fallback.
  //   ORIGIN: openOriginStream(returnTo, info) → {update,finish} that edit-streams
  //     the surfaced reply INTO the origin chat. Null → one-shot surface.
  relayDispatch = null,
  openOriginStream = null,
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

  // ── ORIGIN: relay a human's @being message to the channel where its node listens ──
  async function relayOut({ being, toNode, body = '', origin = null, sender = '' } = {}) {
    const route = resolveRoute(toNode);
    if (!route) { await surface(origin, `!! mesh: no route to ${toNode}`); return false; }
    const fromName = (origin && origin.name) || '';
    // Post the "waiting" placeholder FIRST so we can capture its msgId as post_id.
    // The responder echoes post_id back in every reply frame so the origin knows
    // which message to edit as the stream arrives (streaming relay).
    let postId = null;
    const statusText = `↪ relayed to ${being}.${toNode} — waiting for a reply…`;
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
      const ok = await guardedSend(route, encodeMesh({ by: sender || 'someone', body, from: fromName, from_node: String(node), to: `${being}.${toNode}`, post_id: postId || '' }));
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

    // A REPLY (carries `re:`) — surface home if we're the origin awaiting it.
    if (prov.re) {
      // re: may be "chatname.node" (streaming relay) or bare "chatname" (legacy one-shot).
      // Parse the chat name for the awaiting lookup; the node suffix is routing metadata.
      const dotIdx = prov.re.lastIndexOf('.');
      const reChatId = dotIdx >= 0 ? prov.re.slice(0, dotIdx) : prov.re;

      // STREAMING via post_id: each frame arrives as a NEW message (DOLLY forwards
      // each echoed edit to the return channel). post_id is the Beeper msgId of the
      // origin placeholder — use it to correlate frames to the open origin stream.
      if (prov.post_id && openOriginStream) {
        let s = streamingIn.get(prov.post_id);
        if (!s && !prov.done) {
          const back = awaiting.get(reChatId);
          if (back) {
            const handle = openOriginStream(back, { by: prov.by, msgId: prov.post_id });
            if (handle) {
              s = { handle };
              streamingIn.set(prov.post_id, s);
              if (streamingIn.size > STREAM_CAP) { const k = streamingIn.keys().next().value; streamingIn.delete(k); }
              awaiting.delete(reChatId);
            }
          }
        }
        if (s) {
          if (prov.done) { streamingIn.delete(prov.post_id); await s.handle.finish?.(prov.body); }
          else { s.handle.update?.(prov.body); }
          return true;
        }
      }

      const back = awaiting.get(reChatId) || awaiting.get(prov.re);
      if (!back) { log(`mesh: reply re:${prov.re} not awaited here`); return true; }
      // STREAMING (legacy — relay-channel-edit path): a non-final frame opens an
      // origin-chat stream correlated by the relay message's msgId.
      if (openOriginStream && msgId != null && !prov.done) {
        const handle = openOriginStream(back, { by: prov.by });
        if (handle) {
          handle.update?.(prov.body);
          streamingIn.set(String(msgId), { handle });
          if (streamingIn.size > STREAM_CAP) { const k = streamingIn.keys().next().value; streamingIn.delete(k); }
          awaiting.delete(reChatId);
          return true;
        }
      }
      // Carry the being's identity (by + emoji) so the surfacer can stamp it — a
      // bare body would read as the operator's own message in a self-chat.
      awaiting.delete(reChatId);
      await surface(back, prov.body, { by: prov.by });
      return true;                                 // consume either way (never re-relay)
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
      if (target !== String(node).toLowerCase()) return true;
      if (!isLocalBeing(being)) {
        await guardedSend(route, encodeMesh({ by: `${being}.${node}`, body: `no ${being}.${node} here`, re: reAddress }));
        return true;
      }
    } else if (!isLocalBeing(being)) {
      return true;
    }

    const key = `${being}${prov.from}${prov.body}`;
    if (seen.has(key)) { log(`mesh: replay dropped for ${being}`); return true; }
    mark(key);

    const prompt = prov.body.replace(MENTION_RE, '').trim() || prov.body.trim();
    // RESPONDER: hand the prompt to the host's NORMAL dispatch so the being replies
    // like ANY prompt (the universal editor), and the host wraps each streamed frame in
    // the mesh tail (re/by/post_id, done on the last). Non-blocking: relayDispatch
    // fires the dispatch; we don't await the whole turn here.
    if (relayDispatch) {
      relayDispatch({ being, prompt, route, re: reAddress, post_id: prov.post_id, by: `${being}.${node}` })
        .catch((e) => log(`mesh: relayDispatch ${being} failed: ${e?.message ?? e}`));
      return true;
    }
    // Fallback (no relayDispatch wired): run the being one-shot and post the reply.
    let reply;
    try { reply = await runBeing(being, prompt, { from: prov.from, by: prov.by }); }
    catch (e) { reply = `(${being}.${node} error: ${e?.message ?? e})`; }
    if (reply == null || String(reply).trim() === '') reply = '…';
    await guardedSend(route, encodeMesh({ by: `${being}.${node}`, body: String(reply).trim() || '…', re: reAddress, post_id: prov.post_id, done: true }));
    return true;
  }

  // ── ORIGIN: a relayed reply's relay-room message was EDITED (the responder is
  //    streaming). Mirror it onto the origin-chat stream. Returns true iff it was a
  //    relayed reply we track (caller then skips its normal incoming-edit handling).
  //
  // ── RESPONDER: Beeper echoes back our own streaming edits (Don editing his reply
  //    in the relay channel). Each edit carries the mesh tail; we decode it and
  //    forward the frame to the origin node via the return route — one new relay
  //    message per frame, keyed by post_id so the origin edits the right placeholder.
  async function onRoomMessageEdit({ msgId, text } = {}) {
    // ORIGIN path: we're tracking this relay message's edits (legacy streaming).
    const s = streamingIn.get(String(msgId));
    if (s) {
      const prov = parseMesh(text);
      if (!prov) return true;
      if (prov.done) { streamingIn.delete(String(msgId)); await s.handle.finish?.(prov.body); }
      else await s.handle.update?.(prov.body);
      return true;
    }

    // RESPONDER path: Beeper echoed back our own outgoing edit. The tail has
    // re: chatname.originNode — if the node suffix is not ours, forward the frame
    // to the origin node via the return route so it can update the placeholder.
    const prov = parseMesh(text);
    if (!prov || !prov.re) return false;
    const dotIdx = prov.re.lastIndexOf('.');
    if (dotIdx < 0) return false;                  // no node suffix — not a streaming relay reply
    const reNode = prov.re.slice(dotIdx + 1);
    if (reNode === String(node).toLowerCase()) return false;  // points back at us — ignore
    const returnRoute = resolveRoute(reNode);
    if (!returnRoute) { log(`mesh: no return route to ${reNode} for relay frame re:${prov.re}`); return false; }
    await guardedSend(returnRoute, encodeMesh({
      by: prov.by, body: prov.body, re: prov.re, post_id: prov.post_id, done: prov.done,
    }));
    return true;
  }

  return { relayOut, onRoomMessage, onRoomMessageEdit, awaiting };
}
