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
// 'done' marks the final frame. The being's body_emoji is stamped INTO the body by
// the responder (it owns the emoji), not carried as a key.
const PROV_KEYS = new Set(['from', 'by', 'to', 're', 'sig', 'done', 'enc', 'post_id', 'from_node']);
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
export function encodeMesh({ by = '', body = '', from = '', from_node = '', to = '', re = '', post_id = '', done = false } = {}) {
  const lines = [];   // omit EMPTY keys — an empty "from:" on a reply leaked into the surfaced body
  if (from) lines.push(`from: ${from}`);
  // `from_node` rides the REQUEST so the responder can build a node-qualified return
  // address: `re: ${from}.${from_node}` (e.g. "HFM.kg"). The origin parses the node
  // suffix to resolve the return route; without it, replies can't stream back.
  if (from_node) lines.push(`from_node: ${from_node}`);
  if (by) lines.push(`by: ${by}`);
  if (to) lines.push(`to: ${to}`);
  if (re) lines.push(`re: ${re}`);
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
  beingEmoji = () => '',             // (being) => body_emoji — stamps the relayed reply (contract)
  resolveRoute = () => null,         // (toNode) => route | null
  // isSelfNode(name) — is this node-name ONE OF OURS? node_name ∪ node_alias (operator
  // 2026-07-05): one process may answer to several node identities, so a REQUEST whose
  // target node is any self-name is handled locally (never forwarded to ourselves), and
  // the reply is stamped with the identity it was ADDRESSED AS. Defaults to plain
  // equality with `node` so a single-identity node is unchanged.
  isSelfNode = (n) => String(n).toLowerCase() === String(node).toLowerCase(),
  isLocalBeing = () => false,        // (being) => bool
  // resolveLocalBeing(being) => canonical being to RUN. A being addressed by a HANDLE (e.g.
  // `ed` for the egpt persona) runs the resolved persona being `e` (stable warm keys/threads,
  // same as the router maps persona handles → defaultBeing); a LOCAL sibling agent's handle
  // runs that sibling being. The reply is still STAMPED with the addressed-as handle (the
  // engine keeps `by: <handle>.<node>`), only the RUN-being is resolved. Default: identity.
  resolveLocalBeing = (name) => name,
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
  log = () => {},
} = {}) {
  const awaiting = new Map();   // origin name -> returnTo (so a reply's `re:` surfaces home)
  // ORIGIN-side: relayRoomMsgId -> { handle } for an in-flight relayed reply we're
  // mirroring (the responder edits its relay-room message; we edit ours in the origin
  // chat). Capped; entries cleared on the `done` frame.
  const streamingIn = new Map();
  const STREAM_CAP = 50;
  // A streamed reply mirror is keyed by the reply message's OWN id (`x:${msgId}`): its opening
  // post AND every later streamed EDIT arrive under the SAME raw msgId, so an edit finds the
  // mirror its opening post registered. (mid removed 2026-07-06 — the origin correlates the
  // reply solely by the `re:` return-address + its `awaiting` map.)
  const seen = new Set();       // tiny replay guard (content keys already acted on)
  const SEEN_CAP = 500;
  const mark = (k) => { seen.add(k); if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value); };
  // Reply-mirror stages already FINALIZED (a done frame was delivered), keyed the SAME way
  // streamingIn is (`x:${msgId}`). Makes any late re-delivery of an old frame inert — no
  // duplicate finish.
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

  // ── MULTI-HOP TRANSIT: a spine that isn't the destination forwards the message one hop
  //    toward it, via resolveRoute(destNode). No engine-level forward-once is needed — each
  //    node observes a given envelope ONCE (a node never re-sees its own posts: bridge echo
  //    suppression; and a foreign re-delivery dedups by message id at the bridge). The
  //    guardedSend circuit breaker is the hard backstop. It never forwards back the way the
  //    message came (that would echo).
  const _routeKey = (r) => String(r?.room_id ?? r?.chat ?? JSON.stringify(r ?? null));
  async function forwardToward(destNode, prov, fromRoute) {
    if (!destNode) return false;
    const dest = resolveRoute(destNode);
    if (!dest || _routeKey(dest) === _routeKey(fromRoute)) return false;   // no onward route / would echo back
    log(`mesh: forward req → ${destNode}`);
    return guardedSend(dest, encodeMesh({
      from: prov.from, from_node: prov.from_node, by: prov.by, to: prov.to, re: prov.re,
      post_id: prov.post_id, body: prov.body, done: prov.done,
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
      // A relay agent's declarative `to: <being>.<node>` names the next hop (chain); else a
      // node-qualified target (mesh.nodes scheme); else empty = open-channel (no target node).
      const to = explicitTo || (toNode ? `${being}.${toNode}` : '');
      const ok = await guardedSend(route, encodeMesh({ by: sender || 'someone', body, from: fromName, from_node: String(node), to, post_id: postId || '' }));
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

    // A REPLY (carries `re:`) — a LIVING MIRROR at the ORIGIN: mirror the reply onto the
    // origin placeholder (post_id) as it streams, then finish. Correlation is the `re:`
    // return-address + this node's `awaiting` map alone (mid removed 2026-07-06). The reply
    // reaches the origin because the ORIGIN node is present in the terminal's room (the
    // operator's chains bounce back to the origin — e.g. carol.kg→don.do→wren.kg→ed.do: the
    // origin kg forwarded the wren→ed.do hop into rodz3, so it is there to catch ed's reply).
    // LIMITATION (out of scope): a chain that TERMINATES in a room the origin is NOT in would
    // need reply-forwarding along the reverse path — deliberately not implemented.
    if (prov.re) {
      const dotIdx = prov.re.lastIndexOf('.');
      const reChatId = dotIdx >= 0 ? prov.re.slice(0, dotIdx) : prov.re;
      const back = awaiting.get(reChatId) || awaiting.get(prov.re);
      // One reply-mirror stage is keyed by the reply message's OWN id: the opening post and
      // every later streamed EDIT arrive under the SAME raw msgId, so an edit finds the mirror.
      const key = msgId != null ? `x:${String(msgId)}` : null;
      log(`mesh: reply re:${prov.re} msgId:${msgId ?? '-'} back:${back ? 'yes' : 'NO'} tracked:${key != null && streamingIn.has(key) ? 'yes' : 'no'}`);

      if (key != null) {
        if (repliesDone.has(key)) return true;       // this stage finalized → late re-delivery is inert
        let s = streamingIn.get(key);
        if (!s && back && openOriginStream) {
          // ORIGIN: edit the origin placeholder (post_id) in place as the reply streams home.
          const handle = openOriginStream(back, { by: prov.by, msgId: prov.post_id || null });
          if (handle) {
            s = { handle }; awaiting.delete(reChatId);
            streamingIn.set(key, s);
            if (streamingIn.size > STREAM_CAP) { const k = streamingIn.keys().next().value; streamingIn.delete(k); }
          }
        }
        if (s) {
          if (prov.done) { streamingIn.delete(key); markReplyDone(key); await s.handle.finish?.(prov.body); }
          else await s.handle.update?.(prov.body);
          return true;
        }
      }

      // No stream primitive / no mirror could open: the ORIGIN surfaces once.
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
      if (!isSelfNode(target)) { await forwardToward(target, prov, route); return true; }
      // RELAY-RECORD: `being` is configured here as a relay to ANOTHER node's being — re-address
      // and forward into its OWN configured route (relay agent's channel, else mesh.nodes). This
      // generalizes to an ARBITRARY-length chain: each hop only knows its OWN relay-record and
      // forwards one step. No engine-level forward-once is needed — each node observes a given
      // envelope once (self-echo suppression + the bridge's per-id dedup); the guardedSend
      // circuit breaker is the hard backstop.
      const _rec = await resolveBeingRelay(being);
      if (_rec) {
        const dest = _rec.route ?? resolveRoute(_rec.node);   // relay agent's own channel, else mesh.nodes
        if (dest) {
          log(`mesh: relay-record ${being}.${node} → ${_rec.being}.${_rec.node}`);
          await guardedSend(dest, encodeMesh({ from: prov.from, from_node: prov.from_node, by: prov.by, to: `${_rec.being}.${_rec.node}`, re: prov.re, post_id: prov.post_id, body: prov.body }));
        }
        return true;
      }
      if (!isLocalBeing(being)) {
        await guardedSend(route, encodeMesh({ by: `${being}.${asNode}`, body: `no ${being}.${asNode} here`, re: reAddress }));
        return true;
      }
    } else if (!isLocalBeing(being)) {
      return true;
    }

    const key = `${being}${prov.from}${prov.body}`;
    if (seen.has(key)) { log(`mesh: replay dropped for ${being}`); return true; }
    mark(key);

    // Run the RESOLVED being: a being addressed by a HANDLE (e.g. `ed` for the egpt persona)
    // runs the canonical persona being `e`; a local sibling's handle runs that sibling. The
    // reply is still STAMPED with the addressed-as identity (`by: <being>.<asNode>`).
    const runB = resolveLocalBeing(being);
    const prompt = prov.body.replace(MENTION_RE, '').trim() || prov.body.trim();
    // RESPONDER: edit-stream the being's reply into the relay room as ONE message
    // wrapped in the mesh tail (re/by/post_id, NO done). The responder's own edits
    // are suppressed locally by the bridge but propagate to the origin, which mirrors
    // them onto its placeholder. Non-blocking: relayDispatch fires the dispatch; we
    // don't await the whole turn here.
    if (relayDispatch) {
      relayDispatch({ being: runB, prompt, route, re: reAddress, post_id: prov.post_id, by: `${being}.${asNode}` })
        .catch((e) => log(`mesh: relayDispatch ${runB} failed: ${e?.message ?? e}`));
      return true;
    }
    // Fallback (no relayDispatch wired): run the being one-shot and post the reply.
    let reply;
    try { reply = await runBeing(runB, prompt, { from: prov.from, by: prov.by }); }
    catch (e) { reply = `(${runB}.${node} error: ${e?.message ?? e})`; }
    if (reply == null || String(reply).trim() === '') reply = '…';
    const _stamp = beingEmoji(runB);
    const _fbBody = String(reply).trim() || '…';
    await guardedSend(route, encodeMesh({ by: `${being}.${asNode}`, body: _stamp ? `${_stamp} ${_fbBody}` : _fbBody, re: reAddress, post_id: prov.post_id, done: true }));
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
    // was seen under (onRoomMessage) — so the stream key (`x:${msgId}`) rebuilds directly.
    const key = msgId != null ? `x:${String(msgId)}` : null;
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
