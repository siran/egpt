# Transcription Service — declarative fallback pipeline (design note / build gate)

Locked design (operator + agent, 2026-06-25). Supersedes the `transcription.mode` +
`server`/`cli` shape from the `mode:` round. Config stays **fully commented**.

## Why
The engine choice (remote worker / local resident server / cli) should be **declarative,
ordered, per-note, and visible** — not buried in boot-time branching. A named, ordered
fallback chain reads straight off the config and auto-recovers (each note re-tries from the
top, so when a downed remote returns, notes use it again with no `/restart`).

## Shape
```yaml
transcription_service:
  enabled: true                 # global; overridable per-conversation (conversations.yaml transcription block)
  use_config: reve              # active profile. THE one line that differs REVE vs DOLLY (same mirrored config.yaml)
  reve:                         # a named profile (names are free)
    fallback_order: [remote, local, cli]   # tried per note, in order, until one succeeds
    remote:
      type: whisper-server-remote
      endpoint: http://192.168.1.102:23390
      token: <shared HMAC secret>
      timeout_ms: 4000          # fail FAST (a down remote must not stall each note)
      cooldown_ms: 30000        # circuit-breaker: after a failure, skip this engine for N ms, then re-probe
    local:
      type: whisper-server-local
      command: …whisper-server.exe
      model: …ggml-large-v3.bin
      host: 127.0.0.1
      port: 8089
      anti_repetition: true
      # lazy-spawn: started when first REACHED (i.e. remote failed); resident after; reaped on /restart.
      # while it is still spawning, the cascade naturally falls through to cli.
    cli:
      type: whisper-cli
      command: …whisper-cli.exe
      model_path: …ggml-large-v3.bin
      language: es
      ffmpeg_command: …ffmpeg.exe
      threads: 12
  dolly:                        # DOLLY's profile — no remote, runs its own resident server
    fallback_order: [local, cli]
    local: { type: whisper-server-local, command: …, model: …, host: 127.0.0.1, port: 8089 }
    cli:   { type: whisper-cli, command: …, model_path: …, language: es, ffmpeg_command: …, threads: 12 }
```

## Semantics
- **Per note**: walk `fallback_order`; first engine that returns a transcript wins.
- **Engine `type`** (explicit — names are free labels):
  - `whisper-server-remote` — POST to `endpoint` (HMAC `token`, `transcribeViaEndpoint`). Has `timeout_ms` (fail fast) + `cooldown_ms` (circuit-breaker: a recently-failed remote is SKIPPED until cooldown elapses, then re-probed — no per-note stall).
  - `whisper-server-local` — resident whisper.cpp server (`startWhisperServer` + `makeWhisperServerTranscriber`). **Lazy-spawn** when first reached; resident after; port reaped on `/restart`. Not-yet-ready ⇒ this engine "fails" and the cascade falls to the next (cli).
  - `whisper-cli` — `transcribeAudioFile`, per-note spawn. Always available — the natural floor.
- **Self warnings — on TRANSITION only** (not per note): when the *winning* engine changes
  (e.g. remote → local, or → cli) post one `⚠️ transcription fell back: <from> → <to>` to the
  operator Self DM; post `✅ transcription back on <engine>` on recovery. (Optional later:
  rate-limited heartbeat while degraded.) Avoids flooding Self in a busy voice-note group.
- **Global + per-conversation enabled**: `transcription_service.enabled` is the global gate;
  each conversation/room can still override via its own `transcription` block (existing
  `resolveTranscriptionService`).

## Build
- New `src/transcription-pipeline.mjs`: `buildTranscriptionPipeline({ profile, signAudio, startWhisperServer, makeWhisperServerTranscriber, transcribeViaEndpoint, cli, onTransition })` → `{ transcribe(audioPath, cfg, log, meta), stop() }`. Holds circuit-breaker state + the lazy local-server handle + last-winning-engine for transition detection.
- Spine: resolve active profile (`svc[svc.use_config]`), build the pipeline, feed its `transcribe` to the bridge + `_mediaTranscribe`; `stop()` on teardown; reap the local-server port at boot.
- `onTransition` posts the ⚠️/✅ to Self via the outbox (`{type:'wa-send', from:'system', jid:self_dm}`).
- Read-fallbacks: when `transcription_service` is absent, synthesize a profile from the legacy
  `transcription.{mode,server,cli}` so an un-migrated node is unchanged.
- Tests for: order honored; remote-fail → next; circuit-breaker skips within cooldown; lazy
  local spawn falls to cli while warming; transition fires once, not per note.
- Migrate live `config.yaml` → `transcription_service` (`use_config: reve`); deploy; verify.
