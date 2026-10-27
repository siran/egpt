// limb-intake.mjs — what every limb does with an inbound once its bytes are local, shared by the
// Beeper limb (beeper.mjs) and the Telegram limb (telegram.mjs): the voice note (transcription,
// 🎧, 👂 echo, its two lines) and the bare-name readback (contract 8.4). Moved here verbatim from
// beeper.mjs dispatchMessage; each limb supplies its own sends and lookups. Log lines carry no
// limb prefix: the caller's onLog adds it.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeVoiceNote, voiceTranscriptBody, voiceArrivalBody, voiceFailedBody, VOICE_ARRIVAL_MARK, VOICE_FAILED_MARK, ECHO_MARKER } from '../incoming-media.mjs';
import { bodyForMessageId } from '../transcript-log.mjs';
import { MEDIA_LINE } from '../media-kind.mjs';
import { sha256Hex } from '../tools/decode-once.mjs';
import { cleanForSpeech } from '../speech-clean.mjs';
import { relMediaPath } from '../media-path.mjs';

// 🎧 THE LISTENING ACK (operator 2026-09-15: "put a reaction on voice message when listening, then
// remove reaction when done"). Transcription runs HERE, in the bridge, before the spine ever sees
// the message, and whisper-cli spends ~10s+ loading its model per note — so until this, a long
// voice note left the chat with nothing on it at all for tens of seconds. ONE module-level
// constant, so turning the ack into a SEQUENCE later is a one-place change.
//
// NOT 👂 (ECHO_MARKER): that is the transcript echo, a committed message saying
// what was heard. This says only "I am listening", and comes off the moment it is no longer true.
// The two must not look alike.
//
// Wholly BRIDGE-SIDE (operator: "bridge can react to ack, not model. model can't delete") — the
// hand that adds it is the hand that removes it, so there is nothing a model can emit or forget.
// Since 2026-09-16 that hand says it through the mouth, and only where the decode runs
// (`listening`, startVoiceNote below).
export const LISTENING_REACTION = '🎧';

// REUSE the ALREADY-MADE arrival transcription (operator 2026-07-20). A received
// voice note is transcribed ONCE when it lands (dispatchMessage) and, since 2026-10-16,
// recorded as TWO lines — its arrival under its id, then the marked transcript answering it:
//   Sender@[chat].node (HH:MM) #<id>: (voice note, Ns — being transcribed…)
//   Sender@[chat].node (HH:MM): [re #<id>] (voice transcription, Ns) <text…>
// (bodyForMessageId resolves #<id> to the second; notes recorded earlier are one
// `#<id>: (voice transcription, Ns) …` line, read the same way). The bare-@e
// reply branch looks THAT text up by the quoted id instead of re-transcribing the audio
// (which was a wasteful DOUBLE transcription).
//
// THE WALK IS NOT HERE ANY MORE (operator 2026-07-26): reading one recorded entry back by its
// id is what a REPLY needs too (the quoted message's content, which Beeper never inlines), so
// the walk moved to transcript-log.bodyForMessageId, beside the module that defines
// the shape of a transcript line. It was voice-specific for exactly ONE reason — this marker
// test — so that is all that stayed behind. Returns the transcription text, or null when the id
// has no VOICE-transcription entry (→ the branch falls through to @e→E; it never re-transcribes).
const _VOICE_MARK = /^\(voice transcription(?:,[^)]*)?\)\s*/;
// MEDIA-ANNOUNCEMENT line (operator 2026-08-10): the exact shape a limb announces a saved
// non-voice attachment with — `(image foo.png) [saved: media/...]` — so the
// bare-@e TEXT-mirror branch below can tell a real quoted PROSE reply apart from a quoted
// image/video/audio/document announcement (which must never be synthesized to audio verbatim).
const _MEDIA_MARK = MEDIA_LINE;
// THE VOICE-NOTE PLACEHOLDERS — what the arrival path records when a voice note produced NO
// transcript: the transcriber failed, or transcription is not running on this node. ONE
// definition, used at BOTH ends: the arrival WRITES these strings and the bare-wake-word reply
// gate READS them, so the two can never drift into disagreeing about what a placeholder
// looks like.
//
// THE BUG THIS CLOSES: neither placeholder carries _VOICE_MARK, so the gate's text-mirror branch
// took `[voice note — transcription failed]` for ordinary PROSE and had the synthesizer read that
// bookkeeping line aloud — the exact failure its own comment forbids ("a voice note … must never
// be read aloud as if it were plain text"). A quoted placeholder IS a voice note with no
// transcript, so it falls through to the normal @e→E turn on the existing "no voice-transcript
// entry" line, the same way a quoted id with no entry at all does.
// Since 2026-10-16 a failure is the note's outcome line (voiceFailedBody) and a note still being
// transcribed reads as its arrival (voiceArrivalBody); the old failed placeholder is only READ now,
// from history.
export const VOICE_NOTE_PLACEHOLDER = '[voice note]';
const VOICE_NOTE_FAILED_PLACEHOLDER = '[voice note — transcription failed]';
const _isVoicePlaceholder = (body) => {
  const t = String(body ?? '').trim();
  return t === VOICE_NOTE_PLACEHOLDER || t === VOICE_NOTE_FAILED_PLACEHOLDER || VOICE_ARRIVAL_MARK.test(t) || VOICE_FAILED_MARK.test(t);
};

export function transcriptionForNoteId(doc, noteId) {
  const body = bodyForMessageId(doc, noteId);
  const vm = body?.match(_VOICE_MARK);
  if (!vm) return null;                                      // no entry, or the entry isn't a voice note
  return body.slice(vm[0].length).trim() || null;
}

/**
 * A voice/audio note whose file is local (`path`). Returns { text, pending, listening }: `text` is
 * its arrival line (or the placeholder when transcription is off), `pending` resolves to its outcome
 * { body, caption } (null when off), `listening` whether a 🎧 may be up on it.
 * The limb supplies: svc (resolveTranscriptionService's verdict for this chat), echoPlan (audioHash →
 * { rank }), ownEcho(audioHash) (true = our own voice reply re-entered), reply (the 👂 send),
 * checkCovered, outboundFor (the one placement), serial (the whisper slot), and the note's facts.
 */
export async function startVoiceNote({
  path, chatId, title, msgId, tsMs, durationSec, author, muted = false, operatorSent = () => false,
  svc, echoPlan, ownEcho = () => false, echoMaxAgeMs, echoTimeoutMs, postsBackDelayMs, audioCfg,
  transcribe, outboundFor, reply, checkCovered, scheduler, serial = (k, fn) => fn(), onLog = () => {},
}) {
  const vmeta = {};
  // 👂 ECHO AGE BOUND (operator 2026-07-09, Zohykar incident): gate on the NOTE'S OWN
  // timestamp vs now — NOT bridge start, so a note that arrived during sleep still echoes on wake
  // if the note itself is within the bound. No parseable timestamp -> fail-open (echo), same as
  // the backlog gate.
  const tooOldForEcho = echoMaxAgeMs > 0 && tsMs != null && (Date.now() - tsMs) > echoMaxAgeMs;
  if (tooOldForEcho) onLog(`echo suppressed - note older than bound [${title}] (${new Date(tsMs).toISOString()}, bound ${echoMaxAgeMs}ms)`);
  // 👂 ECHO PLAN (operator 2026-07-24; REAL HRW on a node-stable audio hash): this node's rank
  // for the note over the co-account peer set, picked PER NOTE by rendezvous hashing. The key is
  // the sha256 of the DOWNLOADED AUDIO BYTES at `path` — byte-identical on both co-account nodes
  // (same Beeper attachment), so the two nodes compute the SAME ordering and AGREE on the winner:
  // exactly ONE rank-1 posts now, a lower rank promotes only if the higher ranks are silent (NOT
  // dedup). rank 0 = echo:false hard opt-out. The age bound is ORTHOGONAL — tooOldForEcho
  // suppresses ANY post/promotion regardless of rank.
  //
  // NO KEY ⇒ NO ECHO (operator 2026-09-12). A fallback key would be node-local and double-👂 on a
  // co-account pair, so an unreadable audio is rank 0, i.e. the echo:false verdict — still
  // transcribed + logged, never posted, never promoted. A peer that CAN read the audio still
  // echoes on its own rank.
  let audioHash = null;
  try { audioHash = sha256Hex(await readFile(path)); }
  catch (e) { onLog(`👂 NOT echoed [${title}] — the note's audio is unreadable, so this node cannot compute the co-account-stable echo key, and echoing on a node-local one double-👂s. Still transcribed + logged; a peer that can read the audio echoes it (${e?.message ?? e})`); }
  // BASELINE OWN-VOICE FALLBACK (operator 2026-10-13): a being's own .ogg re-entering on a
  // single-account install (the limb's ownEcho) is recorded as ours, prompts nobody, rank 0 → no 👂.
  const ownVoiceEcho = audioHash != null && ownEcho(audioHash);
  const plan = (audioHash == null || ownVoiceEcho) ? { rank: 0, winner: false } : echoPlan(audioHash);
  const echoOn = plan.rank >= 1 && !tooOldForEcho;   // is an echo POSSIBLE at all for this note on this node?
  // 🎧 LISTENING (operator 2026-09-15; re-homed 2026-09-16). Placed by the node that DECODES the
  // note: the transcriber calls `listening` when a decode starts ON THIS NODE
  // (src/transcription-pipeline.mjs `walk`) and calls what it returns when that decode ends, a
  // throw included. Placement and removal both go through THE one placement (outboundFor →
  // src/spine/sender.mjs makeOutbound `react`). A mark that cannot be placed is no mark anywhere,
  // and says why there. A chat with transcription off never reaches the transcriber.
  const listening = async () => {
    const out = outboundFor?.(chatId);
    if (!out) return null;
    let key = null;
    const keyOf = () => (key ??= out.keyOf(msgId, 'listening')());   // read once, for both halves
    if (!(await out.react(msgId, LISTENING_REACTION, keyOf, 'listening', { temporary: true }))) return null;
    return () => out.react(msgId, LISTENING_REACTION, keyOf, 'listening', { remove: true });
  };
  // …only where transcription_service.listening_reaction allows it (operator 2026-10-18): true, or
  // `operator` for a note the operator sent. Off: nothing placed or removed.
  const listens = svc.listeningReaction === true || (svc.listeningReaction === 'operator' && !!operatorSent());
  const transcription = serial('whisper', () => transcribeVoiceNote({
    localPath: path, audioCfg,
    transcribe: (p, c, l, m) => transcribe(p, c, l, m, listens ? listening : null),
    reply,
    enabled: svc.enabled,
    // rank 1 → post now (immediate/debounced); rank>1 → HOLD + arm a promotion at
    // (rank-1)*echoTimeoutMs (incoming-media). rank 0 / too-old → neither posts nor promotes.
    postsBack: echoOn ? svc.postsBack : false,
    echoRank: plan.rank,
    echoTimeoutMs,
    checkCovered,
    scheduler,
    muted,
    author,
    // PER-NOTE key: each voice note gets its OWN delayed 👂, posted as a reply to ITSELF.
    debounceKey: `${chatId}:${msgId}`,
    // PER-CONVERSATION echo delay (operator 2026-07-16), the boot-global when the resolver has none.
    postsBackDelayMs: svc.postsBackDelayMs ?? postsBackDelayMs,
    onLog,
    meta: vmeta,
  }));
  // A VOICE NOTE IS TWO LINES (operator 2026-10-16): its ARRIVAL is delivered now, and the
  // transcription — or why there is none — follows as its own line once whisper is done. A chat
  // with transcription off has nothing pending: one `[voice note]` line, as before.
  if (!svc.enabled) { await transcription; return { text: VOICE_NOTE_PLACEHOLDER, pending: null, listening: listens }; }
  const pending = transcription.catch((e) => { vmeta.error ??= String(e?.message ?? e); return null; }).then((transcript) => {
    if (!transcript) return { body: voiceFailedBody(vmeta.error ?? 'no transcript'), caption: null };
    onLog(`voice transcribed [${chatId}] → ${JSON.stringify(transcript.slice(0, 80))}`);
    // The body is marked AS audio (GENOME §4 / C7.6); the bare transcript still feeds the 👂 ack
    // + the media sidecar caption.
    return { body: voiceTranscriptBody(transcript, { durationSec: vmeta.durationSec }), caption: transcript };
  });
  return { text: voiceArrivalBody({ durationSec }), pending, listening: listens };
}

/**
 * BARE NAME REPLY (contract 8.4). A reply whose WHOLE text is a local being's token, from the
 * owner, to a voice note posts its 👂 transcript (reused from transcript.md, never re-transcribed);
 * to a text, on a node with a voice service, the 🔊 reading; to a media announcement, it becomes a
 * describe turn. Neither of the first two wakes anyone and the trigger is never touched.
 * Returns { done: true } when the reply replaced the turn, else { text } (maybe rewritten).
 * `quoted()`: the quoted message's text when transcript.md has none (Beeper: its seen cache;
 * Telegram: the reply's inlined copy). `send` returns { confirmedId } (a value or a promise).
 */
export async function readBack({
  text, replyToId, ownerSent, replyWake, readTranscript, chatId, title, network, msgId,
  quoted = () => null, send, sendMedia, editMessage, synthesize = null, voice = null, onLog = () => {},
}) {
  const bareReply = (text || '').trim().toLowerCase();
  // BOTH forms accepted (operator 2026-08-10): '@e'/'@egpt' AND the bare 'e'/'egpt' — the gate
  // requires the WHOLE reply to be nothing but the token. The list is `replyWake`, NOT `wakeWords`
  // (operator 2026-09-01): a fallback token is the ROUTER's to judge for a turn.
  const isReplyWakeWord = (w) => bareReply === `@${String(w).toLowerCase()}` || bareReply === String(w).toLowerCase();
  if (!(replyToId && ownerSent() && replyWake.some(isReplyWakeWord))) return { text };
  const doc = await readTranscript(chatId, { chatName: title, network });
  const t = transcriptionForNoteId(doc, replyToId);
  if (t) {
    const sent = await send(chatId, `${ECHO_MARKER} ${t}`, { replyToMessageID: replyToId });
    const confirmedId = sent ? await sent.confirmedId : null;
    if (confirmedId) {
      onLog(`👂 transcript sent [${title}] ↩${replyToId} (reused from transcript.md; trigger #${msgId} untouched)`);
      return { done: true };   // substitution replaces the @e→E routing for this message
    }
    onLog(`👂 transcript send FAILED to confirm [${title}] #${msgId} ↩${replyToId} — falling through to @e→E`);
    return { text };
  }
  // MIRROR (operator 2026-08-10): the quoted id isn't a VOICE note — try it as ordinary TEXT. Skip
  // a hit that IS a voice-transcription entry or a placeholder: a voice note must never be read
  // aloud as text. synthesize/voice unwired (no voice_service) → this branch no-ops. An immediate
  // '🔊 reading…' ack (OUR OWN message) replies to the quoted text first and is EDITED, never deleted
  // (operator 2026-10-27): to '🔊' once the audio lands below it, or to say it could not be read.
  // E's own lines carry no id in transcript.md (record-first), so `quoted()` supplies their text.
  const quotedText = bodyForMessageId(doc, replyToId) ?? quoted() ?? null;
  if (quotedText && _MEDIA_MARK.test(quotedText)) {
    // A MEDIA-ANNOUNCEMENT line, not prose: never synthesized. The bare token becomes a vision
    // instruction and falls through to a normal turn. THE TOKEN IS KEPT AT THE HEAD (operator
    // 2026-09-01) so the router can still read who it addresses.
    text = `${(text || '').trim()} Describe what you see in the message you're replying to.`;
    onLog(`👁 quoted media announcement ↩${replyToId} [${title}] — falling through to @e→E with a describe instruction`);
  } else if (quotedText && !_VOICE_MARK.test(quotedText) && !_isVoicePlaceholder(quotedText) && synthesize && voice) {
    const ack = await send(chatId, '🔊 reading…', { replyToMessageID: replyToId });
    const ackId = ack ? await ack.confirmedId : null;
    if (ackId) {
      let audio = null;
      try { audio = await synthesize(cleanForSpeech(quotedText), voice, onLog); }
      catch (e) { onLog(`🔊 synthesize threw ↩${replyToId} [${title}] — ${e?.message ?? e}`); }
      if (audio) {
        const tmpPath = join(tmpdir(), `egpt-voice-quote-${randomBytes(8).toString('hex')}.ogg`);
        let sent = false;
        try {
          await writeFile(tmpPath, audio);
          sent = !!(await sendMedia(chatId, tmpPath, { replyTo: replyToId }));
        } catch (e) { onLog(`🔊 media send failed ↩${replyToId} [${title}] — ${e?.message ?? e}`); }
        finally { try { await unlink(tmpPath); } catch { /* ignore */ } }
        if (sent) {
          await editMessage(chatId, ackId, '🔊');
          onLog(`🔊 quoted text synthesized + sent [${title}] #${msgId} ↩${replyToId} (ack edited; trigger untouched)`);
          return { done: true };   // substitution replaces the @e→E routing for this message
        }
        await editMessage(chatId, ackId, '🔊 could not read it aloud');
        onLog(`🔊 quoted-text audio send FAILED ↩${replyToId} [${title}] — ack edited to say so, falling through to @e→E`);
      } else {
        await editMessage(chatId, ackId, '🔊 could not read it aloud');
        onLog(`🔊 quoted-text synthesis declined/failed ↩${replyToId} [${title}] — ack edited to say so, falling through to @e→E`);
      }
    } else {
      onLog(`🔊 ack send FAILED to confirm ↩${replyToId} [${title}] — falling through to @e→E`);
    }
  }
  // No transcript for the quoted id (voice OR text) → normal @e→E. A note whisper is still
  // chewing on reads "being transcribed" (2026-10-16), which is what this says.
  onLog(VOICE_ARRIVAL_MARK.test(String(quotedText ?? '').trim())
    ? `👂 ↩${replyToId} is still being transcribed [${title}] — falling through to @e→E`
    : `👂 no voice-transcript entry for ↩${replyToId} [${title}] — falling through to @e→E`);
  return { text };
}

// What a limb's onMedia answered, as one saved entry: the saved path (string) OR, for a video
// (Route A), { savedPath, framePaths, transcript } — the host extracted keyframes + transcribed the
// audio so they can be handed to E.
export function savedEntry(r, { kind, localPath, fileName = null, isVoiceNote = false, inText = false }) {
  const savedPath = (r && typeof r === 'object') ? r.savedPath : r;
  const framePaths = (r && typeof r === 'object' && Array.isArray(r.framePaths)) ? r.framePaths : [];
  const transcript = (r && typeof r === 'object') ? (r.transcript ?? null) : null;
  return { kind, savedPath: savedPath ?? localPath, fileName, isVoiceNote, inText, framePaths, transcript };
}

// Surface non-voice media to the model (operator 2026-06-16 regression): a
// photo / gif / video / document must be ANNOUNCED so E sees it arrived and a
// vision brain can Read the saved file. Voice is already in `text` (the
// transcript), and audio is the transcribe path — skip both here. Without
// this, media was saved to disk but the bridge returned before onIncoming, so
// E never knew (e.g. "puedes ver lo que posteó ron?").
// Surface media paths RELATIVE to the chat's conversation folder
// (`media/<file>`), NEVER the absolute host path (GENOME §2.5; shared
// `relMediaPath`). Applies to the saved attachment AND the Route-A frames.
export function withMediaLines(body, saved) {
  const lines = saved
    // Announce every saved attachment EXCEPT the voice note already in `text`.
    // (Was: `m.kind !== 'audio'` — which silently dropped a shared AUDIO FILE
    // like an .mp3 that wasn't a voice note, so E never knew it arrived and it
    // wasn't even logged — operator 2026-06-16. `inText` now excludes only the
    // transcribed voice note, so non-voice audio files surface like any media.)
    .filter((m) => m.savedPath && !m.isVoiceNote && !m.inText)
    .map((m) => {
      let line = `(${m.kind}${m.fileName ? ` ${m.fileName}` : ''}) [saved: ${relMediaPath(m.savedPath)}]`;
      // ROUTE A: a video is handed to E on a silver platter — keyframes the
      // host already extracted (Read them with your vision) + the audio
      // transcript. E never had to run anything.
      if (m.kind === 'video') {
        if (Array.isArray(m.framePaths) && m.framePaths.length) line += `\nframes (Read these): ${m.framePaths.map(relMediaPath).join('  ')}`;
        if (m.transcript) line += `\n(video transcription) ${m.transcript}`;
      }
      return line;
    });
  return lines.length ? [body, ...lines].filter(Boolean).join('\n') : body;
}
