# tools/ — exploratory scripts

Small one-off scripts used while investigating features. Not part of
the daemon's runtime path. Kept in repo so findings survive across
sessions.

## probe-whisper-stream.mjs

Probe whether `whisper-cli` streams stdout segment-by-segment as it
processes (good for live transcription) or buffers everything until
exit (bad).

**Finding (2026-05-22)**: buffered. All segments emit at end. Cannot
use stdout for streaming.

```
$ node tools/probe-whisper-stream.mjs longer.wav
[+39648ms] <all segments arrive at once>
[+39818ms] [exit 0]
```

## probe-whisper-srt.mjs

Probe whether `whisper-cli --output-srt` writes its SRT file
incrementally during processing (good for polling/tailing) or
writes it all at the end.

**Finding (2026-05-22)**: also buffered. SRT file appears only at
exit. Cannot use file-tailing for streaming either.

## Streaming-transcription architecture choice

Given both probes failed:

| Approach | Status |
|---|---|
| whisper-cli stdout streaming | ✗ buffered |
| whisper-cli --output-srt incremental | ✗ buffered |
| whisper-stream.exe (mic input) | ✗ requires virtual audio device on Windows |
| whisper-server.exe | not built/installed on this machine |
| **ffmpeg-chunk + whisper-cli with smaller model** | ✓ chosen |

Cold-start times measured on a 3-second WAV chunk:

| Model | First invocation | Second invocation (hot cache) |
|---|---|---|
| ggml-large-v3.bin (2.9GB) | 27s | 20s |
| ggml-base.bin (142MB) | 1.3s | 1.3s |

`ggml-base.bin` is the right tool for the live-preview layer:
~2x realtime, multilingual (Spanish quality is rougher than
large but usable). `ggml-large-v3.bin` stays as the final pass
for the accurate persisted transcript.

For a truly persistent (server-mode) whisper that avoids the
1.3s cold-start, build/install `whisper-server.exe` from the
whisper.cpp source. Deferred — base model is fast enough for the
current live-edit demo.
