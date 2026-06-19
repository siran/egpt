// Human-first mesh relay. The carrier is an ordinary, visible chat message; the
// only machine bit is a trailing, human-READABLE provenance block (fenced YAML),
// so a human — and any spine watching — can always see where a relayed message
// came from and who sent it. No cryptic tags, no minted ids, no ttl.
//
//   An: hi @don
//
//   ---
//   ```
//   from: HFM
//   by: An
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
const PROV_KEYS = new Set(['from', 'by', 'to', 're', 'sig']);
const MENTION_RE = /(?:^|\s)@([a-z0-9_-]+)\b/i;

// `to` (target node) is what makes "never silence" work without a chorus: only
// the named node answers (or says "no <being>.<node> here"); every other spine
// stays quiet. It rides the provenance, not the body, so "@don" stays "@don"
// (a limb can't linkify "don.do").
export function encodeMesh({ by = '', body = '', from = '', to = '', re = '' } = {}) {
  const lines = [`from: ${from}`, `by: ${by}`];
  if (to) lines.push(`to: ${to}`);
  if (re) lines.push(`re: ${re}`);
  const head = by ? `${by}: ${String(body).trim()}` : String(body).trim();
  return `${head}\n\n---\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

// Tolerant of bridge transmutation: fences may arrive literal, re-rendered, or
// stripped; the divider and trailing `key: value` lines are what we trust.
export function parseMesh(text) {
  const raw = String(text ?? '');
  const parts = raw.split(DIVIDER);
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1].replace(/`{1,3}/g, '').trim();
  const prov = {};
  let any = false;
  for (const line of tail.split(/\r?\n/)) {
    const kv = line.match(/^[ \t>*_~-]*([a-zA-Z]+)[ \t]*:[ \t]*(.+?)[ \t]*$/);
    if (kv && PROV_KEYS.has(kv[1].toLowerCase())) { prov[kv[1].toLowerCase()] = kv[2]; any = true; }
  }
  if (!any) return null;
  let body = parts.slice(0, -1).join('\n---\n').trim();
  if (prov.by) {
    const esc = prov.by.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp('^' + esc + '[ \\t]*:[ \\t]*', 'i'), '').trim();
  }
  return { body, from: prov.from || '', by: prov.by || '', to: prov.to || '', re: prov.re || '', sig: prov.sig || '' };
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
  runBeing = async () => '',         // (being, prompt, ctx) => Promise<string>
  resolveRoute = () => null,         // (toNode) => route | null
  isLocalBeing = () => false,        // (being) => bool
  log = () => {},
} = {}) {
  const awaiting = new Map();   // origin name -> returnTo (so a reply's `re:` surfaces home)
  const seen = new Set();       // tiny replay guard (content keys already acted on)
  const SEEN_CAP = 500;
  const mark = (k) => { seen.add(k); if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value); };
  const notify = ack || surface;

  // ── ORIGIN: relay a human's @being message to the channel where its node listens ──
  async function relayOut({ being, toNode, body = '', origin = null, sender = '' } = {}) {
    const route = resolveRoute(toNode);
    if (!route) { await surface(origin, `!! mesh: no route to ${toNode}`); return false; }
    const fromName = (origin && origin.name) || '';
    try { await send(route, encodeMesh({ by: sender || 'someone', body, from: fromName, to: toNode })); }
    catch (e) { await surface(origin, `!! mesh relay to ${being}.${toNode} failed: ${e?.message ?? e}`); return false; }
    if (fromName && origin) awaiting.set(fromName, origin);
    // honest status — we relayed and are waiting; we do NOT claim the being is "thinking".
    await notify(origin, `↪ relayed to ${being}.${toNode} — waiting for a reply…`);
    return true;
  }

  // ── INBOUND: any observed message. Returns true iff it was mesh traffic we
  //    consumed (caller then skips normal handling). ──
  async function onRoomMessage({ route, text } = {}) {
    const prov = parseMesh(text);
    if (!prov) return false;                       // ordinary message — not ours

    // A REPLY (carries `re:`) — surface home if we're the origin awaiting it.
    if (prov.re) {
      const back = awaiting.get(prov.re);
      if (back) { awaiting.delete(prov.re); await surface(back, prov.body); }
      else log(`mesh: reply re:${prov.re} not awaited here`);
      return true;                                 // consume either way (never re-relay)
    }

    // A REQUEST. `to` (target node) decides who is on the hook:
    //   - to == me   → I answer (the being, or "no <being>.<node> here").
    //   - to != me   → not my job; stay quiet (this also silences the relayer's
    //                  own echo, since to is the OTHER node).
    //   - no `to`    → open shared chat: only the owner answers, others silent.
    const being = mentionedBeing(prov.body);
    if (!being) return true;
    const target = (prov.to || '').toLowerCase();
    if (target) {
      if (target !== String(node).toLowerCase()) return true;
      if (!isLocalBeing(being)) {
        await send(route, encodeMesh({ by: `${being}.${node}`, body: `no ${being}.${node} here`, re: prov.from }));
        return true;
      }
    } else if (!isLocalBeing(being)) {
      return true;
    }

    const key = `${being}${prov.from}${prov.body}`;
    if (seen.has(key)) { log(`mesh: replay dropped for ${being}`); return true; }
    mark(key);

    const prompt = prov.body.replace(MENTION_RE, '').trim() || prov.body.trim();
    let reply;
    try { reply = await runBeing(being, prompt, { from: prov.from, by: prov.by }); }
    catch (e) { reply = `(${being}.${node} error: ${e?.message ?? e})`; }
    if (reply == null || String(reply).trim() === '') reply = '…';
    await send(route, encodeMesh({ by: `${being}.${node}`, body: String(reply).trim(), from: '', re: prov.from }));
    return true;
  }

  return { relayOut, onRoomMessage, awaiting };
}
