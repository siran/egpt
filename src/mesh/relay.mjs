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
// `via` is the per-hop forwarding trail (operator 2026-07-06): a YAML flow list of the relay
// hops a request passed through (`<being>.<node>`, e.g. `via: [carol.kg, don.do]`), accumulated
// on the way OUT and echoed home in the reply so the origin can show the path (traceroute).
// WIRE-ONLY: it stays in the tail, never appended to the delivered body — hop names like
// `don.do` linkify in a message BODY (`.do` is a TLD; same reason `to`/`re` ride provenance
// instead of the body — see below). A planned `opts: show-hops` request flag (ROADMAP) will
// surface it at the origin later.
const PROV_KEYS = new Set(['from', 'by', 'to', 're', 'sig', 'done', 'enc', 'post_id', 'from_node', 'via']);
const MENTION_RE = /(?:^|\s)@([a-z0-9_-]+)\b/i;

// Body codec (An 2026-06-20): base64 so the transport can't mangle the body. Beeper
// renders ``` → <pre><code> → `` and a CODE-bearing reply (Don writes code!) collides
// with the fence → the mirror edit breaks ("Failed to edit"). base64 is markdown-inert
// (no backticks / --- / <>) → delivered verbatim; the TAIL stays readable. node-only
// module → Buffer is available.
const b64encode = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const b64decode = (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf8');

// b64 decode hardening (operator 2026-07-06/07: telegram renders the fence glued to the body).
// Node's base64 decoder SILENTLY skips any non-alphabet char, so a fence-mangled body can decode
// to garbage without ever throwing. Trust a decode only when the payload is CLEAN base64; else
// strip the non-base64 chars off the EDGES once (glued fences / whitespace / HTML remnants) and
// retry; else fall back to the raw string (never worse than before).
const B64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeB64Body(raw) {
  let s = String(raw ?? '');
  if (!B64_ONLY.test(s)) {
    const edges = s.replace(/^[^A-Za-z0-9+/]+/, '').replace(/[^A-Za-z0-9+/=]+$/, '');
    if (!B64_ONLY.test(edges)) return s;   // not base64 even after edge cleanup — leave raw
    s = edges;
  }
  return b64decode(s);
}

// `to` (target node) is what makes "never silence" work without a chorus: only
// the named node answers (or says "no <being>.<node> here"); every other spine
// stays quiet. It rides the provenance, not the body, so "@don" stays "@don"
// (a limb can't linkify "don.do").
export function encodeMesh({ by = '', body = '', from = '', from_node = '', to = '', re = '', post_id = '', via = '', done = false } = {}) {
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
  // `via` accumulates the forwarding hops; omitted when empty. Internal representation stays a
  // comma string (appendVia); the WIRE form is a YAML flow list — `via: [carol.kg, don.do]` —
  // per the operator's 2026-07-06 request (readable, no new syntax invented).
  if (via) lines.push(`via: [${String(via).split(',').map((s) => s.trim()).filter(Boolean).join(', ')}]`);
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

// via tolerates BOTH wire forms (operator 2026-07-06): the YAML flow list `[a.b, c.d]` (current)
// and the bare comma form `a.b,c.d` (older / hand-typed) — strip optional brackets, split, trim,
// rejoin bare-comma so the internal representation (appendVia) is unchanged either way.
function normalizeVia(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.replace(/^\[/, '').replace(/\]$/, '').split(',').map((x) => x.trim()).filter(Boolean).join(',');
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
    // The leading class peels bridge junk off the KEY; the trailing `[ \t`]*` now peels a glued
    // fence off the VALUE too (operator 2026-07-06/07: telegram renders the whole envelope as one
    // <pre><code> block, so htmlToMarkdown glues the CLOSING ``` — rendered `` — onto the last tail
    // line: "enc: b64``"). Un-glued, prov.enc === 'b64' matches and the body actually decodes; the
    // mangled enc had skipped the decode, so each telegram-parsed hop nested another base64 layer.
    const kv = line.match(/^[ \t>*_~`-]*([a-zA-Z][a-zA-Z_]*)[ \t]*:[ \t]*(.+?)[ \t`]*$/);
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
  // GLUED FENCE (operator 2026-07-06/07: telegram renders the whole envelope as one <pre><code>
  // block → htmlToMarkdown glues the OPENING ``` — rendered `` — onto the body's FIRST line with
  // no newline, so the whole-line edge() strip above misses it). Peel a backtick run stuck to the
  // first/last body line so the base64 payload is clean (not reliant on the decoder's lenient skip).
  if (bodyLines.length) {
    bodyLines[0] = bodyLines[0].replace(/^`+/, '');
    bodyLines[bodyLines.length - 1] = bodyLines[bodyLines.length - 1].replace(/`+$/, '');
  }
  let body = bodyLines.join('\n').trim();
  if (prov.enc === 'b64') {
    body = decodeB64Body(body);
  } else if (prov.by) {   // legacy un-encoded: peel an old-format "by:" (or "An: An:") prefix
    const esc = prov.by.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp('^(?:' + esc + '[ \\t]*:[ \\t]*)+', 'i'), '').trim();
  }
  return { body, from: prov.from || '', from_node: prov.from_node || '', by: prov.by || '', to: prov.to || '', re: prov.re || '', sig: prov.sig || '', done: prov.done === 'true', enc: prov.enc || '', post_id: prov.post_id || '', via: normalizeVia(prov.via) };
}

export function mentionedBeing(text) {
  const m = MENTION_RE.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}

// agentPaths(agent) — the relay PATHS an agent posts through (operator 2026-07-06: multipath is
// configuration — an agent is a list of paths, every message through every path). A SCALAR relay
// agent → ONE unlabeled path carrying its own {relay_channel, network, to}. A LIST agent → one
// path per element; each element is a SINGLE-KEY map { <label>: { relay_channel, network, to } }
// (the key is the human path label). Malformed list elements (not a single-key object) are skipped.
// Shared by the router (fan-out at the origin) and the mesh service (isLocalBeing/resolveBeingRelay).
export function agentPaths(agent) {
  if (Array.isArray(agent)) {
    return agent.map((el) => {
      if (!el || typeof el !== 'object' || Array.isArray(el)) return null;
      const label = Object.keys(el)[0];
      if (!label) return null;
      const cfg = el[label] ?? {};
      return { label, relay_channel: cfg.relay_channel, network: cfg.network, to: cfg.to };
    }).filter(Boolean);
  }
  if (agent && typeof agent === 'object') {
    return [{ label: '', relay_channel: agent.relay_channel, network: agent.network, to: agent.to }];
  }
  return [];
}

// appendVia adds THIS forwarding hop's identity to the trail (operator 2026-07-06). No body
// trailer is rendered here anymore (operator 2026-07-06 — removed): hop names like `don.do`
// linkify in a message BODY (`.do` is a TLD; the `to:` comment above notes the same reason
// `to`/`re` ride provenance, not the body). `via` stays wire-only, visible in the relay-channel
// envelopes' tails; a planned `opts: show-hops` request flag (ROADMAP) will surface it later.
const appendVia = (existing, hop) => { const e = String(existing ?? '').trim(); return e ? `${e},${hop}` : String(hop); };

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
  async function relayOut({ being, toNode, route: directRoute = null, to: explicitTo = '', body = '', origin = null, sender = '', paths = null } = {}) {
    // MULTIPATH (operator 2026-07-06: multipath is configuration — an agent is a list of paths,
    // every message through every path). `paths` = [{ route, to, label }] (routes already resolved
    // by the caller's canonRoute). Post the placeholder ONCE (one 🤔 / post_id for the human), then
    // ONE envelope per path — same body, same return-address, same post_id. A path failing (bad
    // route / breaker / throw) is logged and SKIPPED; only ALL paths failing surfaces the failure.
    // `awaiting` is registered ONCE (keyed by post_id) → first reply home wins; a later duplicate is
    // consumed. via seeds this local relay agent's identity (`being.node`) as the first hop.
    if (Array.isArray(paths)) {
      const fromName = (origin && origin.name) || '';
      let postId = null;
      const statusText = '🤔 thinking…';
      if (ackWithPostId) { try { const _raw = await ackWithPostId(origin, statusText); postId = typeof _raw === 'string' ? _raw : null; } catch { /* best-effort */ } }
      else await notify(origin, statusText);
      const viaSeed = `${being}.${node}`;
      let anyOk = false;
      for (const p of paths) {
        if (!p?.route) continue;
        const to = String(p?.to ?? '').trim();
        try {
          const ok = await guardedSend(p.route, encodeMesh({ by: sender || 'someone', body, from: fromName, from_node: String(node), to, post_id: postId || '', via: viaSeed }));
          if (ok) anyOk = true;
          else log(`mesh: multipath ${being} path ${p.label ?? '?'} — send paused (loop guard)`);
        } catch (e) { log(`mesh: multipath ${being} path ${p.label ?? '?'} failed: ${e?.message ?? e}`); }
      }
      if (!anyOk) { await surface(origin, `!! mesh: all paths to ${being} failed`); return false; }
      const awaitKey = postId || fromName;
      if (awaitKey && origin) awaiting.set(awaitKey, origin);
      return true;
    }
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
      // SEED via (operator 2026-07-06): a ROUTE-DIRECT relayOut posts a LOCAL relay agent's own
      // first hop (e.g. carol posting into Rodz1) — seed `via` with its own identity so the
      // traceroute lists every relay agent the request passed through, including the origin's.
      // The mesh.nodes path (no directRoute) must NOT seed: there `being` names the REMOTE being
      // being addressed, not a local relay agent.
      const viaSeed = directRoute != null ? `${being}.${node}` : '';
      const ok = await guardedSend(route, encodeMesh({ by: sender || 'someone', body, from: fromName, from_node: String(node), to, post_id: postId || '', via: viaSeed }));
      if (!ok) { await surface(origin, `!! mesh: too many sends to ${tgt}'s channel — paused (loop guard)`); return false; }
    }
    catch (e) { await surface(origin, `!! mesh relay to ${tgt} failed: ${e?.message ?? e}`); return false; }
    // MULTIPATH (operator 2026-07-06): key `awaiting` by the per-request placeholder id (post_id)
    // so TWO concurrent relays from the SAME origin chat (identical `re:`) hold DISTINCT return
    // routes — the first reply home no longer deletes the second's entry and strands it. Fall back
    // to the origin name when no placeholder id was captured (no ackWithPostId → non-streaming path).
    const awaitKey = postId || fromName;
    if (awaitKey && origin) awaiting.set(awaitKey, origin);
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
      // MULTIPATH (operator 2026-07-06): resolve the return route by the reply's OWN placeholder
      // id (post_id) first — unique per request, so concurrent relays from one origin chat don't
      // collide; fall back to the return-address (reChatId / full re:) for the no-post_id path.
      // Remember WHICH key matched so we delete only THAT request's entry (not a sibling's).
      const backKey = (prov.post_id && awaiting.has(prov.post_id)) ? prov.post_id
        : awaiting.has(reChatId) ? reChatId
        : awaiting.has(prov.re) ? prov.re : null;
      const back = backKey != null ? awaiting.get(backKey) : undefined;
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
            s = { handle }; awaiting.delete(backKey);
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

      // No stream primitive / no mirror could open: the ORIGIN surfaces once (done frame).
      if (back) { awaiting.delete(backKey); await surface(back, prov.body, { by: prov.by }); return true; }
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
        // MULTIPATH (operator 2026-07-06: an agent is a list of paths) — a list-shaped relay record
        // resolves to an ARRAY of next-hop records; forward into EVERY one. A scalar record stays a
        // single object (unchanged). via appends THIS hop's identity once; each envelope carries it.
        const recs = (Array.isArray(_rec) ? _rec : [_rec]).filter(Boolean);
        for (const rec of recs) {
          const dest = rec.route ?? resolveRoute(rec.node);   // relay agent's own channel, else mesh.nodes
          if (dest) {
            log(`mesh: relay-record ${being}.${node} → ${rec.being}.${rec.node}`);
            await guardedSend(dest, encodeMesh({ from: prov.from, from_node: prov.from_node, by: prov.by, to: `${rec.being}.${rec.node}`, re: prov.re, post_id: prov.post_id, body: prov.body, via: appendVia(prov.via, `${being}.${asNode}`) }));
          }
        }
        return true;
      }
      if (!isLocalBeing(being)) {
        await guardedSend(route, encodeMesh({ by: `${being}.${asNode}`, body: `no ${being}.${asNode} here`, re: reAddress, via: prov.via }));
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
      // `via` (the accumulated forward trail) rides to the dispatcher so it echoes the path home.
      relayDispatch({ being: runB, prompt, route, re: reAddress, post_id: prov.post_id, by: `${being}.${asNode}`, via: prov.via })
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
    await guardedSend(route, encodeMesh({ by: `${being}.${asNode}`, body: _stamp ? `${_stamp} ${_fbBody}` : _fbBody, re: reAddress, post_id: prov.post_id, via: prov.via, done: true }));
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
