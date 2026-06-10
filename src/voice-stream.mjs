// src/voice-stream.mjs — WA voice-note streaming turn (operator 2026-05-22).
//
// When a WA voice note arrives in streaming mode, the bridge fires onIncoming
// immediately (before transcription completes) with a handle in
// meta.voiceStream. We subscribe to chunk events as the transcript builds,
// re-fire the brain on each new chunk with the cumulative transcript, and
// stream its EVOLVING reply into one WA message: 🎙 listening → 🐶 e: <reply>.
// The recipient watches the model's understanding form in real time, not the
// model parroting their words back. Modality-mirror of the /movie alien arc.
//
// Extracted verbatim from egpt.mjs submitInner (Phase C, ENGINE-SURFACE-
// SEPARATION.md) — pure logic over injected deps, no module-level state, so
// it is finally unit-testable. Behavior preserved except one fix: the
// transcription-ERROR path now also drains an in-flight brain pass before
// the final finish/cancel (previously a still-running pass could update the
// WA message after finish() had locked it).
//
// deps:
//   personaEmoji        emoji for the reply voice (e.g. 🐶)
//   eMayReplyToChat     (chatId, {replyAllowed, isReaction}) -> bool emit gate
//   openStream          (body, {chatId, replyAllowed, isReaction}) -> stream
//                       handle {update, finish, cancel} or null
//   getChatSlug/getChatName   chatId -> string|null (threadCtx enrichment)
//   runDefaultBrainTurn (prompt, onPartial, threadCtx) -> reply text
//   errOut              operator-visible error line
//   pushItem            engine output channel (shell item for the final body)
//   surfaceTag          this node's surface tag (item author suffix)

export const VOICE_TICK_MS = 250;

export async function runVoiceStreamTurn(meta, {
  personaName = 'e',
  personaEmoji = '🐶',
  eMayReplyToChat = () => true,
  openStream,
  getChatSlug = () => null,
  getChatName = () => null,
  runDefaultBrainTurn,
  errOut = () => {},
  pushItem = () => {},
  surfaceTag = '',
} = {}) {
  // Multi-call brain evolution (operator 2026-05-22): the WA message
  // shows ONLY the brain's reply, never the transcript itself. The
  // transcript stays internal.
  const handle = meta.voiceStream;
  const waPrefix = `${personaEmoji} ${personaName}\n`;
  // Lazy stream open (operator 2026-05-22: "is it sending '...' as a final
  // message?"). Only open the WA stream when the brain produces actual
  // non-silence content worth showing — all-silence voice notes leave NO
  // message in the chat.
  // Per-chat emit gate (operator 2026-05-28): E reads the voice note for
  // context (the brain still runs below), but in a muted / mention-not-met
  // chat it must NOT send a reply. Gating the stream-open here suppresses
  // every voice-path send (all sends go through _ensureStream first).
  const _voiceMayEmit = eMayReplyToChat(meta.waChatId, { replyAllowed: meta.replyAllowed, isReaction: meta.isReaction });
  let voiceStream = null;
  const _ensureStream = () => {
    if (!_voiceMayEmit) return;
    if (voiceStream) return;
    try {
      voiceStream = openStream?.(`${waPrefix}…`, { chatId: meta.waChatId, replyAllowed: meta.replyAllowed, isReaction: meta.isReaction });
    } catch (e) { console.error(`!! voice-stream lazy open: ${e?.message ?? e}`); }
  };
  const _isSilencePartial = (s) => {
    const t = String(s ?? '').trim();
    return !t || t === '...' || t === '…';
  };

  const idStr = String(meta.waChatId ?? '');
  const chatType = idStr.endsWith('@g.us')
    ? 'group'
    : idStr === 'status@broadcast' ? 'status' : 'private';
  void chatType;   // kept for parity with the inline original (currently unused)
  const threadCtx = {
    threadId: meta.waChatId ?? 'wa-unknown',
    surface: meta.waClientLabel ?? 'wa',
    slug: getChatSlug(meta.waChatId),
    name: getChatName(meta.waChatId),
  };

  let cumulativeTranscript = '';
  let cumulativeOffsetSec = 0;   // audio-internal timestamp of the latest window
  // Stack of completed brain replies — each pass appends here, and the WA
  // body shows them all joined by '---' (operator 2026-05-22). The recipient
  // sees the model's stream of consciousness as it hears more.
  const replyStack = [];
  let brainInFlight = false;
  let pendingNewChunk = false;
  const _sep = '\n---\n';

  // Millisecond-precision audio-internal time prefix, format [M:SS.mmm].
  // The brain doesn't get told this is voice — it just sees a ticking clock
  // + a sliding text frame that replaces with each pass.
  const _formatAudioTime = (sec) => {
    const total = Math.max(0, sec);
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    const ms = Math.floor((total - Math.floor(total)) * 1000);
    return `[${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}]`;
  };

  // Audio-side sliding windows (in bridges/whatsapp.mjs) give the brain a
  // coherent 6-second phrase per pass. Each pass: brain receives the full
  // transcript of the current audio window as a coherent input.
  const runBrainPass = async () => {
    if (brainInFlight) {
      pendingNewChunk = true;
      return;
    }
    brainInFlight = true;
    try {
      while (true) {
        pendingNewChunk = false;
        const snapshot = cumulativeTranscript;
        if (!snapshot) break;
        // Minimal envelope (operator 2026-05-22): ticker + sender name +
        // frame, e.g. `[0:05.177] An: hola`.
        const audioStamp = _formatAudioTime(cumulativeOffsetSec);
        const sender = (typeof meta.waSenderName === 'string' && meta.waSenderName.trim())
          ? meta.waSenderName.trim()
          : 'An';
        const personaPrompt = `${audioStamp} ${sender}: ${snapshot}`;
        try {
          const prefixBase = waPrefix + (replyStack.length ? replyStack.join(_sep) + _sep : '');
          const reply = await runDefaultBrainTurn(personaPrompt, (partial) => {
            // Gate partial updates on non-silence content so we don't open
            // the WA stream just to flash an '…' that never settles into a
            // real reply.
            if (_isSilencePartial(partial)) return;
            _ensureStream();
            try { voiceStream?.update?.(`${prefixBase}${partial}`); }
            catch (e) { console.error(`!! voice-stream brain partial: ${e?.message ?? e}`); }
          }, threadCtx);
          const trimmed = (reply ?? '').trim();
          if (trimmed && trimmed !== '...' && trimmed !== '…') {
            replyStack.push(trimmed);
            _ensureStream();
            try { voiceStream?.update?.(`${waPrefix}${replyStack.join(_sep)}`); }
            catch (e) { console.error(`!! voice-stream pass-end update: ${e?.message ?? e}`); }
          }
        } catch (e) {
          errOut(`!! voice-stream brain pass failed: ${e?.message ?? e}`);
        }
        if (!pendingNewChunk) break;
      }
    } finally {
      brainInFlight = false;
    }
  };

  // Fire the brain on every chunk — with 6s audio windows the first window
  // is already a coherent phrase; no buffering, so short voices (~3s,
  // single window) get an immediate pass.
  // Audio-time synchronized ticker (operator 2026-05-22): advances on the
  // latest window's endSeconds + wall-clock interpolation between chunks,
  // capped at the total audio duration. 250ms = 4 fps, matching the /movie
  // alien-frame cadence; brain coalescing limits actual brain calls, but
  // the recipient sees the ticker advancing at frame rate.
  const voiceStartMs = Date.now();
  let lastChunkAudioEndSec = 0;
  let lastChunkWallMs = voiceStartMs;
  let audioDurationSec = null;
  const _refreshOffset = () => {
    const nowMs = Date.now();
    const sinceChunkSec = (nowMs - lastChunkWallMs) / 1000;
    let estimated = lastChunkAudioEndSec + sinceChunkSec;
    if (audioDurationSec != null && estimated > audioDurationSec) {
      estimated = audioDurationSec;
    }
    cumulativeOffsetSec = Math.max(cumulativeOffsetSec, estimated);
  };
  const tickTimer = setInterval(() => {
    _refreshOffset();
    // Tick fires brain even when no transcript yet (silence window) —
    // perception of time passing while listening.
    runBrainPass().catch(e => console.error(`!! voice-stream tick: ${e?.message ?? e}`));
  }, VOICE_TICK_MS);

  const onChunk = ({ cumulative, spacedCumulative, endSeconds, audioDuration }) => {
    // Prefer the spaced representation — silence as whitespace gives the
    // model a visual map of audio-time position within the window.
    cumulativeTranscript = (typeof spacedCumulative === 'string' && spacedCumulative.length)
      ? spacedCumulative
      : cumulative;
    if (typeof audioDuration === 'number' && audioDuration > 0) {
      audioDurationSec = audioDuration;
    }
    if (typeof endSeconds === 'number') {
      lastChunkAudioEndSec = endSeconds;
      lastChunkWallMs = Date.now();
    }
    _refreshOffset();
    runBrainPass().catch(e => console.error(`!! voice-stream runBrainPass: ${e?.message ?? e}`));
  };
  handle.emitter?.on?.('chunk', onChunk);

  // Drain any in-flight pass — the last window's pass IS the conclusion;
  // no extra brain pass on done.
  const _drainBrain = async () => {
    while (brainInFlight) {
      await new Promise(r => setTimeout(r, 100));
    }
  };
  try {
    await handle.donePromise;
    handle.emitter?.off?.('chunk', onChunk);
    clearInterval(tickTimer);
    await _drainBrain();
  } catch (e) {
    handle.emitter?.off?.('chunk', onChunk);
    clearInterval(tickTimer);
    errOut(`!! voice-stream transcription failed: ${e?.message ?? e}`);
    // Drain here too: a still-running pass could otherwise update the WA
    // message AFTER the finish/cancel below has locked it.
    await _drainBrain();
  }

  const finalBody = replyStack.join(_sep).trim();
  if (!finalBody) {
    // All-silence voice note. With lazy open above, the WA stream never
    // opened — nothing to send, nothing to revoke. If it somehow did open
    // (race / edge), revoke it cleanly.
    if (voiceStream) {
      try { await voiceStream.cancel?.(); }
      catch (e) { console.error(`!! voice-stream silence-cancel: ${e?.message ?? e}`); }
    }
    return;
  }
  // Deterministic end-of-processing marker (operator 2026-05-22): a line
  // with only '.' tells the recipient (and any downstream parser) that
  // every chunk has been transcribed and the brain has done its final pass.
  // After this, the WA message body is locked.
  try { await voiceStream?.finish?.(`${waPrefix}${finalBody}${_sep}.`); }
  catch (e) { console.error(`!! voice-stream final finish: ${e?.message ?? e}`); }
  try {
    pushItem({
      id: Date.now() + Math.random(),
      author: `egpt@${surfaceTag}`,
      body: finalBody,
      _source: 'whatsapp',
      _sourceChatId: meta.waChatId,
    });
  } catch (e) { console.error(`!! voice-stream items push: ${e?.message ?? e}`); }
}
