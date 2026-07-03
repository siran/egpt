# eGPT

eGPT is a **being, not a session**: a persistent AI presence that lives in the
channels you already use — WhatsApp, Telegram, Signal, the shell, the browser —
where it hears everything, remembers everything, and acts through real limbs on
your behalf. The mission is a public tool that is **secure and powerful**: the
power (full tools, real limbs, self-modification) is exactly why the security is
structural, not bolted on.

It reaches the world through **Beeper Desktop's local API** — one login, one
node, every network Beeper bridges. A voice note arrives, gets transcribed, is
answered in the same chat; you drive the node from your own Self-DM.

> Deeper reading: [`GENOME.md`](GENOME.md) (what eGPT is at heart),
> [`CONTRACTS.md`](CONTRACTS.md) (test-locked behavior), [`ROADMAP.md`](ROADMAP.md)
> (state + what's next).

## Setup

eGPT runs as a background service against a **profile directory** (`EGPT_HOME`,
default `~/.egpt`).

1. **Run Beeper Desktop** and get its API token: Beeper Desktop → Settings →
   Developer → Desktop API. This is the one credential eGPT needs (it talks to
   `127.0.0.1:23373`). Every node needs its own Beeper account.

2. **Create the profile config.** Copy the shipped skeleton to your profile and
   fill it in:

   ```bash
   mkdir -p ~/.egpt/config
   cp config/skeletons/config.yaml ~/.egpt/config/config.yaml
   ```

   Then edit `~/.egpt/config/config.yaml`: paste your `beeper_token`, set
   `user_name`, and add each surface's `chat_id` + `allowed_users` (empty =
   deny; your own account-owner messages are always authorized). Every key is
   documented inline and registered in [`config/config-schema.mjs`](config/config-schema.mjs).
   The `agents:` block is required — the shipped default makes `egpt` the persona
   (the warm Claude Code CLI, using your `claude` login; no API key for the core
   flow). Skeletons seed the rest of the profile (agent types, identities,
   heartbeats, room template) copy-if-missing on first boot.

3. **Install the service.** On Windows, double-click
   `setup\install-nssm-service.cmd` (auto-elevates, registers `egpt-daemon` as an
   NSSM Windows Service, starts it). macOS/Linux: `./setup/install-service.sh`
   (launchd / systemd user service). The daemon keeps the node running and
   respawns it on the lifecycle exit codes below.

4. **Verify the install:**

   ```bash
   node setup/verify-install.mjs
   ```

   Read-only. Checks the live node — service log paths, profile shape, liveness
   (`state/spine.pid` + `state/alive.txt`), `claude` on PATH. Exit 0 = all good.

## Operating the node

You drive eGPT from your **Self-DM** on any authorized surface (or as an
authorized sender). Slash commands typed there are intercepted by the node, not
answered by the persona:

```text
/status               compact node health (git sha, pid, uptime, liveness,
                      heartbeats, conversation + this chat's mode)
/e auto <mode> [chat] set a chat's reply mode. modes: on · mute ·
                      mention-direct · mention · off. omit <chat> for this chat;
                      from Self-DM name the target (slug/name fragment or @jid)
/e                    arm the re-point WIZARD for this chat (guided: agent
                      type → model → effort, or build a custom type)
/e <fragment>         arm the wizard for another chat (resolved like /e auto's)
/restart              bounce the node (daemon respawns the current checkout)
/upgrade              git pull + npm install + rebuild, then respawn
/rewind <ref>         check out <ref>, reinstall, respawn
```

Restarts also work headlessly via the **ingest box**: drop a file whose content
is the command line into `~/.egpt/state/ingest/` (write temp, then rename for
atomicity) — the spine consumes it once. Hot-reload heartbeats by deleting
`~/.egpt/state/heartbeats.readonly.yaml`.

Per-chat behavior, warm-session TTLs, flood/compaction guards, transcription,
and heartbeats are all configured in `config/config.yaml` (and per-conversation
`config.yaml` overrides). See [`MANUAL.md`](MANUAL.md) for the full operator
reference and [`TESTING.md`](TESTING.md) for the manual verification tiers.

## Requirements

- Node ≥ 22, npm
- Beeper Desktop (the transport)
- `claude` CLI on PATH (the default persona engine — your Claude login)
- optional: a whisper build for voice-note transcription; Chrome with
  `--remote-debugging-port` for the browser/CDP limbs

## License

eGPT is released under the **MIT License** — use it, fork it, ship it, keep the
notice. **No warranty, no liability**: it drives a browser, chat accounts, and
your machine; run it at your own risk. See [`LICENSE`](LICENSE).
