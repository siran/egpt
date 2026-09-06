// sender.mjs — the §2c sender service: the reply train (operator 2026-06-30).
// ONE message: post "⏳ Thinking…" eagerly as a REPLY to the question — the instant
// ack AND the streaming target in one. FIXED placeholder text so the bridge resolves
// its id before any edit (and during spin-up → smooth edits, no stutter). Once tokens
// arrive it edits in place into the answer. A send failure ends it with
// "… ❌ Sending failed."; an 'on'-mode '...' silence deletes it (posts nothing).
//
// No SEPARATE knee-jerk message: a per-turn "📨 Sending to E..." piled up and
// cross-deleted in busy chats (its id-resolution races the next turn's). The reply's
// own reply-to quote is the ack; nothing to linger. body_emoji is enforced by the
// bridge; the train markers (⏳ / failure) are owned here. The reply carries NO inline
// end-marker: the historical signature train end-marker was REMOVED (operator
// 2026-07-12) — its successor is the `agent_signature_close` layer, applied downstream
// in beeper-port (default EMPTY → a reply renders with no end-marker unless the operator
// sets agent_signature_close).
// The live-frame marker is defined ONCE, in dispatch-line.mjs, where its recogniser
// (isLiveStreamFrame) lives — this file is the STAMPER and imports it. They were two
// independent literals, so changing either silently stopped the guard recognising real
// frames while every fixture-built test stayed green.
import { LIVE_FRAME_MARK } from '../dispatch-line.mjs';

const FAIL_SUFFIX = '… ❌ Sending failed.';
// A turn that was MEANT to surface but produced no deliverable text (brainpool
// returned '' / whitespace, OR the spine blanked a failure-shaped result) must
// resolve its placeholder VISIBLY — never a silent delete or a forever "⏳ Thinking…"
// (operator 2026-07-04, DEFECT 1: turn 1 vanished with its placeholder stuck). Its own
// "⚠️ …" marker; distinct from FAIL_SUFFIX (a SEND fault). It still flows through the
// port's wrapPersona, so a configured agent_signature_close layer still appends — the
// marker no longer carries a signature itself.
const noReplyMark = () => `⚠️ no reply (turn failed/empty)`;
// '…' is the MODEL's word (40-rules.md). The bridge must never fabricate it:
// a silence the bridge invented is indistinguishable from one the being chose.
// When the bridge has nothing from the model, it says so in its OWN voice.
const BRIDGE_SILENCE = '<received silence (error?)>';
// A LIMB-ONLY turn is not silence (operator 2026-09-01, reading his own SPOILER transcript:
// "the bridge acted on it but forgot that the reply was non empty" ... "then bridge can say
// 'processing command' (/react is a command), something like that, so that there is legible
// record of what happened"). The model DID speak — in commands — so resolving its placeholder
// with BRIDGE_SILENCE told the chat the opposite of what happened, right beside the 🤝 the same
// turn had just landed. The bridge names what it is DOING instead, in its own voice, listing the
// verbs it is about to run (the spine calls finish() BEFORE actions.execute, so "processing" is
// literally true at that instant; whether each limb LANDED is what the transcript's
// stage-direction records afterwards — dispatch-line.limbAction).
const commandMark = (verbs = []) => `⚙️ processing ${verbs.length > 1 ? 'commands' : 'command'} (${verbs.map((v) => `/${v}`).join(' ')})`;
const THINKING = `${LIVE_FRAME_MARK} Thinking…`;   // NOT a lone emoji (renders oversized in some clients)
// A mention that arrives while THIS conversation's train is still running gets its
// OWN placeholder immediately (the operator's per-message ack), opened in the QUEUED
// state — `ahead` = how many trains run before it. When its turn starts it flips to
// THINKING (activate) and then streams. The DISTINCT text is not cosmetic only: the
// bridge resolves a placeholder's id by matching the newest message with identical
// text, so two coexisting "⏳ Thinking…" placeholders would collapse onto one id (the
// live "stuck placeholder" bug). A queued placeholder's text differs from THINKING
// and — via `ahead` — from every other queued one, so each resolves to its own id.
const QUEUED = (ahead) => `${LIVE_FRAME_MARK} Queued (${ahead} ahead)…`;

// THE MESSAGE IS APPEND-ONLY (operator 2026-08-28: "the message is replaced for a 'final'
// message, and the in-transit thinking is deleted … sometimes it is writing something and
// then boom, it changes … the messages should also be stable").
//
// The living mirror is ONE message edited in place, and every edit used to SUPERSEDE the
// last: `update()` assigned the whole partial, `finish()` posted the settled text whole.
// When the settled text is not an EXTENSION of what streamed — warm-cli resolves with
// `ev.result` (the LAST assistant message, not the accumulated train) and codex assigns
// `currentTurn.text = item.text` wholesale on item/completed — the last edit ERASED what a
// human had already read.
//
// So the message is now kept append-only: an extension grows the tail in place (the ordinary
// token stream, unchanged), a DIVERGENCE seals what was already read above this seam and
// writes the new text below it. Every value the message takes has its predecessor as a
// literal PREFIX — which is exactly what "nothing shown is ever removed" reduces to.
// The settled answer is therefore always the LAST block, where a chat reader's eye lands.
//
// IT CARRIES NO LIVE_FRAME_MARK, and that is load-bearing, not cosmetic: a peer node
// classifies a streaming frame by that marker's PRESENCE (dispatch-line.isLiveStreamFrame,
// 372c17f) and drops it from the record. A seam containing ⏳ would make every settled
// message look transient to an observing node and vanish from its transcript.
export const RETAINED_SEAM = '\n\n— ↓ reply —\n\n';

// ── WHICH MOUTH SAYS IT (operator 2026-09-05, the peer-spine mouth link) ──────────────────────
// One machine, two spines, one Beeper account each, differing only by EGPT_HOME. The PRIMARY is
// the ear and the brain — it receives, logs, gates and runs the turn exactly as it always has —
// and when it wants to reply it hands the finished text to the SECONDARY over a loopback link,
// and the secondary says it on the OTHER account (src/shell/peer-mouth.mjs; the whole arrangement
// is in src/shell/mouth.mjs's header).
//
// THE DECISION IS MADE HERE AND NOWHERE ELSE, because this is THE reply path: every persona reply
// on every surface is opened by open() below. `peerMouth` is boot's injected pair — route(chatId)
// answers "should the peer say this one?" (it does when the peer's account is a participant of
// the chat) with the RAW chat payload the key is computed from, and startStream(chat, init, …)
// opens the reply on that account. ABSENT (the ordinary single-account node) ⇒ not one line of
// this runs and the sender behaves byte-identically, which is the whole additivity requirement.
//
// FALL BACK, NEVER GO SILENT — the INVERSE of the fail-closed rule the mouth's own refusals
// follow, and the difference is worth stating. Refusing to POST INTO A CHAT is fail-closed
// because a reply in the wrong chat is public before anyone notices and cannot be taken back.
// Refusing to REPLY AT ALL is not the same trade: a reply that comes out of the wrong mouth is
// cosmetic. So every failure the link can produce — unreachable, no-key, no-match, ambiguous,
// send-failed, a handler that threw — falls back to posting on THIS node's own account, loudly
// logged. The transport reports every refusal back over the same socket for exactly this.
//
// THE TRAIN GOES WHEREVER THE MOUTH IS (operator 2026-09-05, "it's working, but please let's
// recover the thinking train"). The first cut of the link carried a FINISHED line and nothing
// else, so a peer-routed reply had no placeholder at all: silence, then the whole answer at once,
// while a local one shows "⏳ Thinking…" immediately and edits it in place as the tokens land.
// The link carries the train now — src/shell/peer-mouth.mjs startPeerStream — and it does so
// WITHOUT any message identity crossing the wire: the receiver keeps the live stream object and
// hands back an opaque id of its own (src/shell/mouth.mjs).
//
// WHICH IS WHY THE ONLY THING THE ROUTE DECIDES HERE IS WHICH FACTORY MINTS THE STREAM. A peer
// stream implements the SAME surface a local one does — update / awaited finish / delivered /
// confirmedId — so everything past that line is the code this file already had, the §7 fallback
// included: `delivered === false` means "it was not said", whether the stream was this account's
// or the peer's, and it has always meant "send it fresh here". There is no second finish path.
//
// THE STREAM IS STILL OPENED LAZILY on a peer-configured node, because the route has to settle
// before there is a factory to choose — a cached membership read, normally landing before the
// first token. What changed is what happens when it says "peer": the placeholder used to be
// SUPPRESSED (nothing was posted anywhere until the answer was finished) and is now OPENED ON THE
// PEER'S ACCOUNT. THE SEAM, stated plainly: a node with a peer pays the membership read plus one
// loopback hop before its "⏳" appears; a node without one is untouched.
//
// bridgeOf (operator 2026-08-30, multi-connection Beeper): OPTIONAL (being) => Bridge, resolved
// PER open() CALL (open() already receives `being`) — a node wired to more than one Beeper
// connection routes each being's reply through its OWN bridge. Absent, or returning nullish for
// a given being, falls straight back to the single `bridge` above — BYTE-IDENTICAL to before for
// every caller that only passes `bridge` (memberSender, every existing test).
export function createSender({ bridge, bridgeOf = null, bodyEmojiOf = () => null, labelOf = () => null, agentSignatureOpenOf = () => '', agentSignatureCloseOf = () => '', defaultKey = 'e', peerMouth = null, onLog = () => {} } = {}) {
  if (!bridge) throw new Error('createSender: bridge is required');
  const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? '');
  return {
    open(chatId, { being = defaultKey, replyTo = null, queued = false, queuedAhead = 0, auto = false } = {}) {
      const bridgeForThisBeing = bridgeOf ? (bridgeOf(being) ?? bridge) : bridge;
      // mode:auto — E impersonates the operator, so the reply is PLAIN operator text:
      // NO persona line (no body_emoji/label tag passed → the port stamps nothing), no
      // end-marker, and NO thinking scaffold — no "⏳ Thinking…" placeholder, no streamed
      // edits, no queued placeholder. It posts ONCE, complete, when the turn finishes, the
      // way a human types a single message. A withheld ('…' silence, surface:false) or
      // empty reply posts NOTHING — silence is a valid operator move.
      //
      // AND IT IS NEVER ROUTED THROUGH THE PEER MOUTH: the point of mode:auto is that the reply
      // looks like the OPERATOR typed it, on the operator's own account. Saying it from the
      // second account would defeat exactly the thing the mode exists for.
      if (auto) {
        // sendResult (operator 2026-08-10, voice-reply-as-a-reply-to-the-text chunk): the
        // delivered message's own confirmedId, exposed so a caller can thread a FOLLOW-UP
        // send (the synthesized voice note) as a reply TO this text once it's out.
        let sendResult = null;
        return {
          activate() {},
          update() {},
          async finish(reply, { surface = true } = {}) {
            const t = textOf(reply);
            if (!surface || !t.trim()) return;          // withheld / empty → post nothing
            sendResult = await bridgeForThisBeing.send(chatId, t, { replyTo });   // plain text: no bodyEmoji/label, no end-marker
          },
          async fail() { /* a human doesn't post a typing/failure scaffold — stay silent */ },
          get confirmedId() { return sendResult?.confirmedId ?? null; },
        };
      }
      const bodyEmoji = bodyEmojiOf(being);
      const label = labelOf(being);
      // The per-AGENT signature WRAP (operator 2026-07-12): agent_signature_open/close bracket the
      // stamped reply as the INNER layer (the bridge does the concentric wrap in beeper-port). Resolved
      // per-being here (agent → node → ''); default empty → nothing added. agent_signature_close is the
      // SOLE agent close now — the historical inline signature end-marker was removed 2026-07-12.
      const agentSigOpen = agentSignatureOpenOf(being);
      const agentSigClose = agentSignatureCloseOf(being);
      const tag = { bodyEmoji, label, replyTo, agentSigOpen, agentSigClose };   // the bridge enforces the persona stamp (emoji + label) + wraps the layers from these
      // WHICH MOUTH SAYS IT (header). Started HERE, at the top of the reply, so the answer is in
      // hand by the time there is anything to show. A route that throws — or a peerMouth that
      // throws synchronously — reads as "no peer": never a lost reply. Absent peerMouth ⇒ null ⇒
      // the local stream opens immediately below, exactly as it always has.
      const route = peerMouth ? Promise.resolve().then(() => peerMouth.route(chatId)).catch((e) => { onLog(`mouth: could not decide the route for ${chatId} — posting locally: ${e?.message ?? e}`); return null; }) : null;
      // What the human has already read, in two parts: `tail` is the block the current
      // frame extends, `head` everything sealed behind a seam. See RETAINED_SEAM.
      let head = '';
      let tail = '';
      const shown = () => (head ? `${head}${RETAINED_SEAM}${tail}` : tail);
      // Absorb the message's next value and return the text to display. EXTENSION → the tail
      // grows in place (the common case: no seam, no duplication, the settled answer reads as
      // the whole message). DIVERGENCE → seal the tail into `head` and start a new one below
      // the seam. Never removes; the previous rendering is always a prefix of the new one.
      const absorb = (next) => {
        const t = String(next ?? '');
        if (!t) return shown();
        if (t.startsWith(tail)) { tail = t; return shown(); }
        head = head ? `${head}${RETAINED_SEAM}${tail}` : tail;
        tail = t;
        return shown();
      };
      // THE PLACEHOLDER, opened once. With NO peer this runs on the next line, at the exact moment
      // it always has, with `shown()` still empty — so the call is byte-identical to the one that
      // used to sit here. With a peer it waits for the route and then opens on whichever account
      // is going to say this reply, replaying whatever streamed in the meantime so nothing a human
      // should have seen is lost.
      let activated = false;
      let stream = null;
      let streamOpened = false;
      // The text the placeholder opens with. A QUEUED one differs from THINKING and, via `ahead`,
      // from every other queued one, which is what keeps two coexisting placeholders resolvable to
      // their own message ids (see QUEUED).
      const placeholderText = () => ((queued && !activated) ? QUEUED(queuedAhead) : THINKING);
      // THIS ACCOUNT'S OWN STREAM — and also the LAST RESORT the peer stream falls back to when it
      // can neither stream nor speak through the peer (peer-mouth.startPeerStream, tier 3), which
      // is why it is a factory rather than an inline call: only this file knows the chat, the tag
      // and the placeholder, so it is this file that hands the fallback over.
      const openLocalStream = () => bridgeForThisBeing.startStream?.(chatId, placeholderText(), { ...tag, persona: being });
      // THE ONE DECISION (header): which factory mints the stream. Both hand back the same surface,
      // so nothing below this line knows or cares which mouth it is driving.
      const openStream = (peerChat = null) => {
        if (streamOpened) return stream;
        streamOpened = true;
        stream = peerChat ? peerMouth.startStream(peerChat, placeholderText(), { fallback: openLocalStream }) : openLocalStream();
        const already = shown();
        if (already) stream?.update?.(`${already} ${LIVE_FRAME_MARK}`);
        return stream;
      };
      if (!route) openStream();
      // …and a placeholder that cannot be opened is LOGGED, never an unhandled rejection: on the
      // no-peer path a throwing startStream propagates out of open() as it always has, but on this
      // path there is no caller left to catch it. finish() then finds no stream and posts the
      // reply fresh, which is the branch it already has for a bridge with no streaming at all.
      else route.then((peerChat) => openStream(peerChat)).catch((e) => onLog(`mouth: could not open the placeholder for ${chatId} — the reply will be posted whole: ${e?.message ?? e}`));
      // fallbackResult (operator 2026-08-10, voice-reply-as-a-reply-to-the-text chunk): set
      // ONLY when the §7 fallback below fires (a FRESH send, not an edit-in-place) — its own
      // confirmedId then supersedes the stream's, which never delivered.
      let fallbackResult = null;
      return {
        // A queued placeholder flips from the queue into the live train the instant
        // its turn starts (before the first token), so the user sees it move. No-op
        // for a placeholder that was never queued.
        activate() { activated = true; if (queued) stream?.update?.(THINKING); },
        // absorb() runs UNCONDITIONALLY, before the push. `stream?.update?.(`${absorb(t)} …`)`
        // reads as if it did, but optional chaining short-circuits the WHOLE call expression —
        // arguments included — so with no stream yet (a peer route being resolved, or a peer
        // route outright) the running text was silently never accumulated, and a fallback post
        // would have carried only the settled value with the narration above it lost.
        update(partial) { const t = textOf(partial); if (!t) return; const frame = `${absorb(t)} ${LIVE_FRAME_MARK}`; stream?.update?.(frame); },
        // `commands` (operator 2026-09-01): the verbs of a LIMB-ONLY reply — the turn's whole
        // answer was action commands, so there is no prose to deliver but plenty happened. Null
        // for every other turn, which is why a reply with no action and a genuinely empty reply
        // both resolve byte-identically to before.
        async finish(reply, { surface = true, commands = null } = {}) {
          // Settle the mouth decision before anything is written anywhere. With no peer this is
          // null and costs nothing; with one, the `route.then` above has already opened the stream
          // by the time this resolves (microtask order), so every branch below sees the same
          // `stream` it always did. Still read here for the withheld branch, which may be reached
          // before any token arrived and therefore before anything opened it.
          const peerChat = route ? await route : null;
          const t = textOf(reply);
          // Gate-withheld ('on'-mode silence / not surfaced). NOTHING IS EVER
          // DELETED (operator 2026-08-24): the placeholder resolves to the
          // silence mark instead of vanishing. 40-rules.md already names it —
          // "A polite silence is '...' or '…'" — so the withheld turn reads as
          // a deliberate silence rather than a message that disappeared.
          if (!surface) {
            // A WITHHELD TURN RESOLVES THE PLACEHOLDER IT ACTUALLY OPENED — which, on a peer
            // route, is the one on the peer's account. The rule this branch exists for is that a
            // placeholder must never be left stuck (operator 2026-08-24, "nothing is ever
            // deleted"), and that rule follows the message, not the account. Idempotent: the
            // stream is normally already open by now, and this only matters when the turn was
            // withheld before the route settled.
            openStream(peerChat);
            // A LIMB-ONLY turn says what it is DOING, never that it heard nothing (commandMark).
            if (commands?.length) { if (stream) await stream.finish?.(absorb(commandMark(commands))); return; }
            // The model's own words if it produced any (its '…' is ITS silence);
            // otherwise the bridge says, in its own voice, that nothing arrived.
            // Absorbed like any other value: a silence that ARRIVES after the model
            // narrated does not erase the narration — it lands under the seam.
            //
            // ...BUT IT NEVER LANDS BESIDE PROSE (operator 2026-09-01). BRIDGE_SILENCE means one
            // thing only — "the bridge got NOTHING from the model" — and the message is
            // append-only, so appending it under a seam to text a human has ALREADY READ asserts
            // a silence that visibly did not happen (live: "...doesn't need a reply from me. — ↓
            // reply — <received silence (error?)>", which is what the operator diagnosed as "the
            // bridge acted on it but forgot that the reply was non empty"). With something already
            // shown there is nothing to resolve: the placeholder settles on exactly what was read,
            // the ⏳ comes off, nothing is erased and nothing is invented. Nothing shown ⇒ the
            // mark, unchanged.
            const settled = t.trim() ? t : (shown() ? '' : BRIDGE_SILENCE);
            if (stream) await stream.finish?.(absorb(settled));
            return;
          }
          // Surfaced: deliver the reply, OR — when it came back empty — the no-reply
          // marker (a turn meant to reply that produced nothing is resolved VISIBLY,
          // not silently deleted / left stuck).
          const body = absorb(t.trim() ? t : noReplyMark());
          // AND THAT IS THE WHOLE MOUTH DECISION, spent. A peer stream settles the message the peer
          // has been editing; a local one settles this account's. Either way `delivered` says
          // whether it was said, and the §7 line below — unchanged, and the only fallback in this
          // file — sends the reply fresh HERE when it was not. Every reason it might not have been
          // (link dropped, peer refused, unknown verb, timeout, handler threw) is logged by name
          // inside the stream that hit it, so an operator reading the chat can see which mouth
          // spoke and why. NEVER a silent drop, and never a lost reply.
          if (stream) {
            await stream.finish?.(body);
            if (!stream.delivered) fallbackResult = await bridgeForThisBeing.send(chatId, body, tag);   // §7 fallback
          } else {
            fallbackResult = await bridgeForThisBeing.send(chatId, body, tag);
          }
        },
        async fail() {                                 // visible failure: the message ends with ❌
          try {
            if (route) await route;                    // …after the mouth decision, so the placeholder that was opened is the one this EDITS rather than posting a fresh ❌ beside it
            // The failure ends the placeholder wherever it lives — the peer's account on a peer
            // route, this one otherwise — because that is where a human is watching a "⏳" that
            // must not be left thinking forever. Only a turn that never opened a stream at all
            // (no streaming bridge) posts the ❌ fresh, which is the branch this always had.
            if (stream) await stream.finish?.(`${shown() ? `${shown()} ` : ''}${FAIL_SUFFIX}`);
            else await bridgeForThisBeing.send(chatId, FAIL_SUFFIX, tag);
          } catch { /* best effort */ }
        },
        // null after a PEER-said reply: the delivered message lives on the other account, in the
        // other spine's id namespace, and an id from there means nothing here (mouth.mjs). Its
        // one consumer threads a follow-up voice note as a reply to the text — with no local id
        // that follow-up simply goes out unthreaded, which is the same thing it already does
        // whenever a stream fails to resolve its placeholder.
        get confirmedId() { return fallbackResult ? (fallbackResult?.confirmedId ?? null) : (stream?.confirmedId ?? null); },
      };
    },
  };
}
