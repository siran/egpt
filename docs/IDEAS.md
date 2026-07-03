# eGPT — Ideas backlog

Seeds parked for later. Not active work; pulled out of the live surface so the
operator console stays lean.

## `/e butler` — ephemeral sub-agent (removed from `/e` 2026-06-25)
An ephemeral haiku sub-agent: no session memory, default all-tools, one-shot
(`/e butler <prompt>`). Good seed for an on-demand "do this one thing" worker that
doesn't pollute a conversation's thread. Revisit as a first-class capability (a tool
E itself can call, or `/e do`) rather than an operator slash command.

## `@l` local-brain — its own research line
The local llama.cpp brain (`@l`) is **disabled for now** (operator 2026-06-25) and is a
separate research direction: local/offline inference, abliterated models on DOLLY's GPU.
Infra stays dormant (`local_llm`, the supervised llama-server); the `/e llama` toggle was
removed. Revisit when we take local inference on as a real thread.

## Key-value storage in eGPT
Operator idea (2026-06-25): eGPT could provide a key-value store. The operator tends to
stash things (secrets, notes, config) by writing + pasting into conversations; a
first-class KV (per-node and/or per-conversation) would organize that. The manual
`~/.egpt/secrets/` file (DOLLY admin creds) is the current stopgap.

## Permissions belong in config, not `/e`
`/e tool` / `/e cmd` / `/e path` were removed (2026-06-25). Per-being permissions (tools,
runnable commands, path grants) belong in the **siblings registry** or a **conversations.yaml
override**, not in transient operator slash commands. Fold them into the per-being config
shape (#2) instead.

## Live mic capture (DEFERRED 2026-05-23)
Operator: "for eGPT it would be supercool to connect a mic to the PC." A local-mic input
source that captures audio (any OS), transcribes it live, and dispatches the text as if the
operator typed it. Shape: spawn a live-transcription child (whisper-stream handles the audio
device + sliding-window natively via `--step/--length/--vad-thold`), parse finalized segments,
dispatch them into the currently-active chat (the one set by `/use`, so "@e XYZ" spoken out loud
lands there). Wake-word / push-to-talk gating (VAD threshold + a coarse keyword-spot) keeps it
from transcribing the whole day. Closes the loop on eGPT as an ambient assistant (voice in / voice
out). Pending: mic-bridge skeleton, device-selection UX, wake detection.

## Reconnect burst-digest (DEFERRED 2026-05-23)
When a surface reconnects and delivers a backlog, the brain should get ONE digest dispatch
("while you were offline these arrived: …") rather than N individual turns. The pattern: after
a burst of backlog goes quiet (~5s), fire a single formatted recap the brain can answer once or
iterate per chat. Guards against a reconnect firehose bombarding the persona. (The original
baileys `_heldMessages`/`/wa-pending` implementation retired with the transport; the digest idea
is the reusable part.)

## Streaming voice perception (DEFERRED 2026-05-22)
Feed a voice note to the brain frame-by-frame as it is transcribed (sliding-window), so a single
reply message evolves as understanding forms — the "alien arc" but for audio. An end-to-end build
shipped and reverted: the model kept treating each window as a NEW question instead of a continuation
of one utterance. Root finding: without structural "this is a stream" knowledge, an envelope-shaped
dispatch reads as a separate user turn. The honest fix is SDK streaming-input mode — `query()` accepts
an async-iterable prompt, so all windows append to the SAME growing user turn (one message in, one
message out) rather than N dispatches. Batch mode (one accurate full-transcript dispatch per note) is
the shipped default; the open question is how to make the model perceive a stream.

## Read-receipt "doorbell" (DEFERRED 2026-05-16)
A message that animates per-viewer via read receipts — lands static, then rewrites/animates as each
member opens the chat, resting on a line that knows who's been by (`👋 hi, Alice and Bob · 👁 3 seen`).
Needs a transport that exposes per-participant read receipts; the original WhatsApp build stalled on
unreliable receipt events + WA read-receipt privacy (a fraction of users disable it, firing no event).
Revisit if/when a surface gives clean read-receipt signals. Privacy rule to carry forward: resolve a
reader's display name from the pushname only, never the address book, and never render a raw phone number.
