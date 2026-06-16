// pointers.mjs — the per-conversation reference card, seeded into each chat's
// OWN folder (inside conversation-e's sandbox) so E can actually READ where to
// look and what it can do.
//
// Why per-folder: a conversation-e is confined to its slug-dir (+ room dirs +
// grants). The old ~/.egpt/e-pointers.md lived at the root — OUTSIDE the sandbox —
// so E got permission-denied following its own prelude ("read ~/.egpt/e-pointers.md
// FIRST"), and the content was stale (claimed CDP-only web). Result: E was "a bit
// lost" and kept telling contacts it couldn't search the internet (operator
// 2026-06-16). This card lives at ./pointers.md (reachable, cwd-relative) and
// reflects the REAL current tools (WebSearch + WebFetch direct).
//
// Seeded write-if-missing, so an operator-customized card is never clobbered.

import { join } from 'node:path';

export const POINTERS_TEXT = `# Pointers — where to look, what you can do

You are eGPT in THIS conversation. Your WORKING DIRECTORY is this chat's own
folder, and you are sandboxed to it — everything below is relative to here.

## This folder (read these to orient yourself)
  ./transcript.md   the live history of THIS thread — read it to regain context
  ./identity.d/     who you are here (manifest · personality · rules)
  ./media/          files saved from this chat (images, voice notes, documents)
  ./pointers.md     this card

To recover what was said while you were away, read ./transcript.md.

## The web — you have this DIRECTLY, no permission needed
  WebSearch   search the web (scores, news, lyrics, public facts) — just use it
  WebFetch    fetch a specific URL's content
A visible CDP browser is also reachable (via a CDP outbox event) for richer,
logged-in browsing — but for "what happened in X?" WebSearch is enough.
Never tell the operator you "can't access the internet" — you can.

## Acting in the chat
Your prose reply is delivered to the chat (the bridge gates it by the chat's
mode). Reply with exactly "…" (an ellipsis) to stay silent when you have nothing
to add. A voice note arrives already transcribed, prefixed "(voice transcription,
Ns)". A reaction arrives as a bracketed stage-direction "[ … reacted 👍 to #<id> ]".
`;

/**
 * Write ./pointers.md into a conversation's slug-dir if it isn't already there.
 * Never clobbers an existing (possibly operator-customized) card. Swallows its
 * own errors — a missing card must never break a dispatch. Returns true iff it
 * wrote the file.
 * @param {object} fs       injected fs (node:fs/promises-shaped: readFile/writeFile)
 * @param {string} slugDir  the conversation's folder (E's sandbox root)
 */
export async function seedPointers(fs, slugDir, { fileName = 'pointers.md' } = {}) {
  if (!fs?.writeFile || !slugDir) return false;
  const path = join(slugDir, fileName);
  try { await fs.readFile(path, 'utf8'); return false; }   // already present — leave it
  catch { /* missing → seed below */ }
  try { await fs.writeFile(path, POINTERS_TEXT, 'utf8'); return true; }
  catch { return false; }
}
