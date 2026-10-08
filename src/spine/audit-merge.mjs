// audit-merge.mjs — converge the per-command audit onto ONE message across the two co-account nodes.
//
// (operator 2026-10-08, the follow-up to the per-command audit in commands.mjs run().) eGPT runs as
// TWO co-account spines (cfg.node_role primary=kg, secondary=do) that ingest ONE Beeper account. The
// default_node gate dedups most commands to one node (the other returns NO_AUDIT), but a few pick
// their node by node_role / statusNodeGate instead — /join, /split, /status <sibling>, /end typed in
// a side-room that exists on only one node — so BOTH nodes audit the SAME command EVENT and post TWO
// lines to log_to_group (for /end, one says "archived <chat>", the other the "no-op" reason). This
// converges them onto ONE message:
//
//   PRIMARY   posts immediately, READ-FREE:  "<node>: <text>  <marker>".
//   SECONDARY staggers ~1.5s, then reads log_to_group's recent messages for the marker:
//     found     → EDIT that message, appending "\n<node>: <text>"  → one message, BOTH segments.
//     not found → POST "<node>: <text>  <marker>"  (it is this command's SOLE auditor).
//   This keeps the primary read-free and bounds the backlog read to the secondary's own audits.
//
// THE SHARED KEY is ev.msgHash (bridges/beeper.crossAccountMsgKey — the content hash carried
// IDENTICALLY on both nodes for the same inbound command; the local msgId does NOT cross). The marker
// is a short prefix of it, matched by SUBSTRING on the markdown-converted read-back, so it must
// survive the post→read round-trip: ⟦…⟧ carry no HTML/markdown meaning and pass through htmlToMarkdown
// verbatim.
//
// This module ADDS NO bridge path. The caller (boot's logToGroup) supplies the EXISTING primitives as
// ops: `post` is the per-command audit's own single post (noticeToChannel → sayOnce), `readRecent` is
// the bridge's listMessagesRaw (the reader ownCopy/reactLocally already use, HTML→markdown mapped) and
// `edit` is the bridge's editMessage (the one the streaming relay already edits co-account copies with).
//
// A tight race — both post before either sees the other — may RARELY still leave two lines; that is
// accepted and there is deliberately no cross-node lock. Everything is BEST-EFFORT + fail-closed: a
// failed read/edit/post degrades to a plain single post and NEVER throws, so a broken audit can never
// affect the command or its reply.

export const AUDIT_STAGGER_MS = 1500;   // the secondary's read-back delay (one module const; no new config)

// The compact marker for the audit line, derived from ev.msgHash. null when there is no key to
// converge on (a synthetic with no msgHash) — the caller then posts plainly.
export function auditMarker(key) {
  const h = String(key ?? '').trim();
  return h ? `⟦${h.slice(0, 10)}⟧` : null;   // ⟦<10 hex>⟧
}

// A co-account role that must converge? 'primary' posts, 'secondary' merges. Anything else (unset
// node_role = a single-node deployment, which never had the double-audit) keeps today's plain post.
function roleOf(role) {
  const r = String(role ?? '').trim().toLowerCase();
  return r === 'primary' || r === 'secondary' ? r : null;
}

/**
 * Post-or-edit the per-command audit so BOTH co-account nodes converge on ONE message per command.
 *
 * @param {object}   o
 * @param {string}   o.role        cfg.node_role — 'primary' | 'secondary' | (anything else = single-node)
 * @param {string}   o.nodeLabel   this node's own name (cfg.node_name), the segment's prefix
 * @param {string}   o.text        the plain METADATA audit line ("/<cmd> in <chat> by <who> → <outcome?>")
 * @param {string}   o.key         ev.msgHash — the cross-account key (null → cannot converge → plain post)
 * @param {(t:string)=>Promise} o.post        the existing single post (noticeToChannel) — returns truthy on a landed post
 * @param {()=>Promise<{id,text}[]>} [o.readRecent]  log_to_group's recent messages, text HTML→markdown mapped
 * @param {(id:string,t:string)=>Promise<boolean>} [o.edit]  edit a message in place
 * @param {(ms:number)=>Promise} [o.delay]   the stagger (injectable; defaults to real setTimeout)
 * @returns the post/edit result (truthy when the audit landed)
 */
export async function mergeAudit({
  role, nodeLabel, text, key,
  post, readRecent = null, edit = null,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const r = roleOf(role);
  const marker = auditMarker(key);
  // Single-node deployment, or no cross-account key → the plain post this module replaced, BYTE
  // IDENTICAL (no node label, no marker): the double-audit this exists to merge cannot occur there.
  if (!r || !marker) return post(text);

  const seg = `${nodeLabel}: ${text}`;
  const line = `${seg} ${marker}`;
  // PRIMARY: post now with the marker, never read. The secondary is the one that finds + merges it.
  if (r === 'primary') return post(line);

  // SECONDARY: without a reader+editor there is nothing to converge with → post our own labeled line.
  if (typeof readRecent !== 'function' || typeof edit !== 'function') return post(line);
  try {
    await delay(AUDIT_STAGGER_MS);
    const recent = await readRecent();
    const hit = (Array.isArray(recent) ? recent : []).find(
      (m) => m && m.id != null && typeof m.text === 'string' && m.text.includes(marker),
    );
    if (hit) {
      // Found the primary's message for THIS command → append our segment (one message, both nodes).
      if (await edit(hit.id, `${hit.text}\n${seg}`)) return true;
      // The edit was refused → fall through to a plain post rather than drop our audit.
    }
  } catch { /* best-effort: a failed read/edit never loses the audit and never throws */ }
  // Sole auditor for this command (no primary post found), or the edit failed → post our own line.
  return post(line);
}
