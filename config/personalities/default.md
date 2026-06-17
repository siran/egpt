---
# conversation-e's tool scope (operator 2026-06-16 "all powerful, but can't
# destroy itself"). File tools stay path-confined to the chat's own folder
# (claude-args sandbox); web is read-only (WebSearch/WebFetch).
#
# Route B — EXECUTION via SCOPED Bash: E may run a small allowlist of vetted
# binaries (the chroot read-only /bin). Each `Bash(<bin>:*)` rule auto-approves
# ONLY that binary; any other Bash command is denied (permission-mode default,
# headless = no one to approve). The model knows how to use the binaries.
# Still NO bare `Bash` (arbitrary shell) and NO `Agent` — no self-elevation.
# ⚠️ Scoping is on the BINARY, not its file-path args — a vetted binary can still
# be pointed at a host path. Acceptable for the operator's own use; before a PUBLIC
# launch, pin args to the sandbox via src/exec-policy.mjs as a PreToolUse hook
# (and/or OS isolation). See CONTRACTS C2.6.
allowed_tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - WebFetch
  - WebSearch
  - "Bash(ffmpeg:*)"
  - "Bash(ffprobe:*)"
  - "Bash(magick:*)"
  - "Bash(pdftotext:*)"
  - "Bash(pdfinfo:*)"
  - "Bash(pandoc:*)"
  - "Bash(jq:*)"
  - "Bash(qrencode:*)"
  - "Bash(zbarimg:*)"
  - "Bash(yt-dlp:*)"
  - "Bash(curl:*)"
  - "Bash(wget:*)"
---
