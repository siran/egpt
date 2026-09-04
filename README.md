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
   `127.0.0.1:23373`), and it is genuinely the only one: **one token, one account,
   one node, running in your ordinary logged-in desktop session.** That is the
   baseline and it is meant to stay that way — locked by
   `tests/single-account-node.test.mjs`, which boots a node from exactly this and
   asserts none of the optional machinery below is reached.

   Nodes MAY share one Beeper account (list the co-account nodes in
   `account_peers`) or hold one each. Neither is required to start.

   > **Everything past this point is OPTIONAL EXPANSION, and none of it is needed
   > to run eGPT.** A node can additionally hold a SECOND Beeper account, and can
   > run its Beeper Desktop as a Windows SESSION 0 service so the agents answer
   > with nobody logged in — see `handoffs/2026-09-03-session-zero.md`. That
   > buys an unattended node and a reply that arrives from a visibly different
   > person. It also costs a second install, a second login, and a service to
   > supervise. Skip it. Add it the day you want what it buys.

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
/status                       compact node health (git sha, pid, uptime, liveness,
                              heartbeats, conversation + this chat's mode)
/agents[=<slug>] <handle>|all
                              manage ANY resident being (the persona, or a sibling
                              like wren) on any conversation. Bare: live status
                              (fenced yaml — engine/model/effort/allowed_tools,
                              resolved fresh from config, never a stale snapshot).
                              `all` applies to every resident being on the entry.
                              omit `=<slug>` for this chat; from Self-DM name the
                              target (slug/name fragment or @jid)
/agents[=<slug>] <handle>|all reset
                              BIG: archive this being's whole conversation folder
                              aside (transcript.md, media/, files/, identity.d/ —
                              everything), wipe ITS registry block (mode,
                              threadId, all of it — a sibling's own state
                              survives untouched) EXCEPT access_level and
                              allowed_users, which are durable operator grants and
                              survive the reset, reseed a pristine tree at the
                              same path
/agents[=<slug>] <handle>|all restart
                              NARROW: clear ONLY this being's threadId (mode,
                              access_level, and every other field survive
                              untouched) — the conversation folder is never
                              archived or touched. This is exactly what already
                              happens when threadId alone is cleared by hand;
                              transcript rolling + identity refresh happen
                              automatically on the being's next message, not as
                              part of this command
/agents[=<slug>] <handle>|all auto <mode>
                              set a chat's reply mode. modes: on · mute ·
                              mention-direct · mention · accum (mention + the turn
                              is prompted with what was said since the being's
                              last turn) · off
/agents[=<slug>] <handle>|all access_level <all|regular>
                              flip between the unconfined tier and the node's
                              regular confined default
/restart                      bounce the node (daemon respawns the current checkout)
/upgrade                      git pull + npm install + rebuild, then respawn
/rewind <ref>                 check out <ref>, reinstall, respawn
```

Restarts also work headlessly via the **ingest box**: drop a file whose content
is the command line into `~/.egpt/state/ingest/` (write temp, then rename for
atomicity) — the spine consumes it once. Hot-reload the whole config by deleting
any of `~/.egpt/{config,conversations,heartbeats}.readonly.yaml`.

Per-chat behavior, warm-session TTLs, flood/compaction guards, transcription,
and heartbeats live in ONE namespace resolved over THREE rungs — nearest the room
wins: `config/config.yaml` < `config/conversations.yaml` (the entry) <
the entity's own `conversations/<slug>/config.yaml` or `rooms/<name>/config.yaml`.
The spine dumps what it resolved, and the file each value came from, to those
three `*.readonly.yaml` aggregates at the profile root. See [`MANUAL.md`](MANUAL.md) for the full operator
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
