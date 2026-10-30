# eGPT

eGPT is a **being, not a session**: a persistent SI presence that lives in the
channels you already use — WhatsApp, Telegram, Signal, the shell, the browser —
where it hears everything, remembers everything, and acts through real limbs on
your behalf. The mission is a public tool that is **secure and powerful**: the
power (full tools, real limbs, self-modification) is exactly why the security is
structural, not bolted on.

It reaches the world through **Beeper Desktop's local API** — one login, one
node, every network Beeper bridges. A voice note arrives, gets transcribed, is
answered in the same chat; you drive the node from your own Self-DM.

**eGPT is OS-agnostic, and that is the reason it is built the way it is.** node
plus Beeper Desktop, and nothing else: both run on Windows, macOS and Linux, so
eGPT does too. **One desktop UI is all that is required.** The spine's runtime
path carries no platform — the Windows-specific machinery in `setup/` (services,
scheduled tasks, PowerShell) belongs to the OPTIONAL Session 0 expansion, never
to running eGPT, and `tests/integrity.test.mjs` scans `src/` to keep it that way.

Three things are enhancements, not requirements, and each can be skipped
independently: **a second node**, **a second Beeper account**, and **running the
Desktop as a Session 0 service**. One node, one account, one logged-in desktop is
the whole product.

> Deeper reading: [`GENOME.md`](GENOME.md) (what eGPT is at heart),
> [`CONTRACTS.md`](CONTRACTS.md) (test-locked behavior), [`ROADMAP.md`](ROADMAP.md)
> (state + what's next).

## Run eGPT on your laptop (quickstart)

1. ⭐ **Star** this repo.
2. To be honest: **tell your SI to read and install this.** Tell it to do it *for you*, and
   don't end up working for it: they're too cautious, too prudish. Make it run the steps on
   your command. Ride your horse with confidence. 🐎
3. **Fork** it (the **Fork** button, top right on GitHub).
4. **Clone your own copy**: your fork, not `siran/egpt`. You are master of your domain.
   In a terminal (Windows: **PowerShell**; macOS: **Terminal**; needs **Git**):

   ```bash
   git clone git@github.com:<you>/egpt.git
   cd egpt
   ```

   No SSH key on GitHub? Use `https://github.com/<you>/egpt.git` instead.

This is the shortest way to get eGPT answering you in a chat on one laptop. Pick
**A (WhatsApp, through Beeper)** or **B (a Telegram bot)**. You can add the other one later.
Nothing else in this README is needed for a first run.

### What you need

1. **Node.js 22 or newer.** Check with `node --version`.
2. **Git**, to download eGPT.
3. **Claude Code**, installed and signed in on this laptop, so that `claude` works in a terminal.
   eGPT uses your Claude login. You don't need an API key.
   Install and sign in: https://code.claude.com/docs/en/setup
4. **Only for A:** a phone with WhatsApp, and **Beeper Desktop** installed on the laptop.
   **Only for B:** a Telegram account.

### Install

1. In your clone (the `egpt` folder), run:

   ```bash
   npm install
   ```

2. Create your settings file from the template.

   macOS:

   ```bash
   mkdir -p ~/.egpt/config
   cp config/skeletons/config.yaml ~/.egpt/config/config.yaml
   ```

   Windows (PowerShell):

   ```powershell
   mkdir "$env:USERPROFILE\.egpt\config" -Force
   copy config\skeletons\config.yaml "$env:USERPROFILE\.egpt\config\config.yaml"
   ```

3. Open that `config.yaml` in a text editor and change these lines:
   - `node_name:` a short name for this laptop, e.g. `studio`.
   - `user_name:` your name.
   - Under `agents:`, delete the whole `ken:` and `wren:` blocks. Keep only `egpt:`.
     (`wren` has full access to your computer. A first setup doesn't need it.)
   - Under `agents:` → `egpt:`, add these lines. Line them up with `handles:`:

     ```yaml
         conversation_defaults:
           access_level: regular
           sandboxed: false
     ```

     Without these lines eGPT tries to use a Windows sandbox that this quickstart doesn't
     set up, and it can't answer on a Mac. (To use the sandbox, see `setup/SANDBOX.md`.)

### A. WhatsApp through Beeper (your phone number)

eGPT answers **from your own WhatsApp number**, so your contacts see its replies as coming from you.

1. Open **Beeper Desktop**, sign in, and add your WhatsApp account.
   Beeper shows a QR code: scan it from WhatsApp on your phone (Settings → Linked devices → Link a device).
2. In Beeper Desktop go to **Settings → Developer → Desktop API** and copy the token.
3. In `config.yaml`, under `limbs:` → `beeper:` → `main:`, paste the token in place of
   `PASTE_YOUR_TOKEN_HERE`, and put your Beeper login email after `account:`.
4. Keep Beeper Desktop open while eGPT runs.

### B. A Telegram bot

1. In Telegram, open **@BotFather**, send `/newbot`, and follow the steps. It gives you a **bot token**.
2. Save the token. In the `egpt` folder, run the command below and paste the token when it asks
   (you won't see it as you paste):

   ```bash
   node setup/telegram-token.mjs main
   ```

   Windows: you can also double-click `setup\telegram-token.cmd`.
   The token is saved to `~/.egpt/secrets/telegram-main.token`, not to `config.yaml`.
3. In `config.yaml`, under `limbs:`, remove the `#` from these three lines and put your bot's username after `account:`:

   ```yaml
     telegram:
       main:
         account: "my_egpt_bot"
   ```
4. Tell eGPT who it may answer. Under `networks:`, change the `telegram:` line to:

   ```yaml
     telegram: { chat_ids: [], allowed_users: ["YOUR_TELEGRAM_NUMERIC_ID"] }
   ```

   To find your numeric id, send any message to @userinfobot in Telegram.
5. **If you're not using A:** put a `#` at the start of the `beeper:` line and of each line under it
   (`main:`, `account:`, `token:`). eGPT then runs on Telegram only.

### Start eGPT

In the `egpt` folder, run:

```bash
node egpt-daemon.mjs
```

Leave this window open. eGPT runs as long as it's open. To stop eGPT, press **Ctrl+C** in this window.

### Check that it works

1. Look at the messages in the terminal window:
   - A: a line containing `beeper: subscribed to all chats`.
     If you see `NO TOKEN`, check the token in step A3.
   - B: a line like `[telegram] 'main' is @my_egpt_bot`.
     If you see `rejected the token`, run step B2 again.
2. Send a message that starts with `@e`, for example `@e hello`:
   - A: send it in WhatsApp, for example in the chat with yourself.
   - B: send it in a private chat with your bot.

   eGPT answers in the same chat.
3. Send `/e status`. eGPT replies with a short health report.
4. Optional, on macOS: run `node setup/verify-install.mjs` in a second terminal. `Exit 0` means all good.
   On Windows this check also looks for background services that this quickstart doesn't install,
   so it reports them as missing. That's expected here.

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
   `peer_nodes`) or hold one each. Neither is required to start.

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
   `user_name`, add each surface's `chat_id`, and put your ids in the top-level
   `conversation_defaults.allowed_users` (empty = nobody; your own account-owner
   messages are always authorized): beings answer only those owners by default. Every key is
   documented inline and registered in [`config/config-schema.mjs`](config/config-schema.mjs).
   The `agents:` block is required — the shipped default makes `egpt` the persona
   (the warm Claude Code CLI, using your `claude` login; no API key for the core
   flow). Skeletons seed the rest of the profile (agent types, identities,
   heartbeats, room template) copy-if-missing on first boot.

3. **Install the runners.** On Windows, register the Session 1 logon task
   `egpt-daemon`: `powershell -ExecutionPolicy Bypass -File setup\register-session1-daemon-task.ps1`,
   and, at the console, the Session 0 service of the same name: `setup\install-nssm-service.cmd`
   (it asks your password, checked and never stored). The service runs the node while nobody
   is logged on; the task takes it over at logon, with the browsers. `setup\start-egpt.cmd`
   starts both, `setup\stop-egpt.cmd` stops both.
   macOS/Linux: run `node egpt-daemon.mjs` from the checkout under your own supervisor
   (the container in `docker/` does this from its entrypoint). The
   daemon keeps the node running and respawns it on the lifecycle exit codes below.

4. **Verify the install:**

   ```bash
   node setup/verify-install.mjs
   ```

   Read-only. Checks the live node — the Session 1 task and the `egpt-daemon` service
   (Automatic, as you, AppExit 0 = Exit, yours to stop and start), or off Windows a live
   daemon (`state/daemon-*.pid` with a fresh beat), profile shape, liveness
   (`state/spine.pid` + `state/alive.txt`), `claude` on PATH. Exit 0 = all good.

## Operating the node

You drive eGPT from your **Self-DM** on any authorized surface (or as an
authorized sender). Slash commands typed there are intercepted by the node, not
answered by the persona. A command names a being — `/<handle> <command>`, e.g.
`/e restart` — and only that being's node runs it; a bare `/restart` in a chat is
ordinary text (the editor shell console still takes it):

```text
/<handle> status              compact node health (git sha, pid, uptime, liveness,
                              heartbeats, conversation + this chat's mode)
/<handle> agents[=<slug>] <handle>|all
                              manage ANY resident being (the persona, or a sibling
                              like wren) on any conversation. Bare: live status
                              (fenced yaml — engine/model/effort/allowed_tools,
                              resolved fresh from config, never a stale snapshot).
                              `all` applies to every resident being on the entry.
                              omit `=<slug>` for this chat; from Self-DM name the
                              target (slug/name fragment or @jid)
/<handle> agents[=<slug>] refresh <handle>|all
                              SMALLEST: keep the running thread and re-feed it.
                              <chat>/directives/ is re-copied from the current
                              template immediately; the identity goes back into
                              the LIVE thread on its next turn. Nothing moved, no
                              new thread, the model keeps its context
/<handle> agents[=<slug>] rethread <handle>|all
                              MIDDLE: clear ONLY this being's threadId (mode,
                              access_level, and every other field survive
                              untouched) and roll transcript.md into
                              transcripts/<retiring-thread>.md. The conversation
                              FOLDER is never archived or moved. Identity
                              reseeding happens on the being's next message, not
                              as part of this command. Was `restart` until
                              2026-09-10 — that word is /restart, the NODE's
                              lifecycle, and is refused here
/<handle> agents[=<slug>] reset <handle>|all
                              BIG: archive this being's whole conversation folder
                              aside (transcript.md, media/, files/, directives/ —
                              everything), wipe ITS registry block (mode,
                              threadId, all of it — a sibling's own state
                              survives untouched) EXCEPT access_level and
                              allowed_users, which are durable operator grants and
                              survive the reset, reseed a pristine tree at the
                              same path
/<handle> agents[=<slug>] auto <mode> <handle>|all
                              set a chat's reply mode. modes: on · mute (log only,
                              never a turn) ·
                              mention-direct · mention · accum (mention + the turn
                              is prompted with what was said since the being's
                              last turn) · off
/<handle> agents[=<slug>] access_level <regular|all|sandbox> <handle>|all
                              point a being at a confinement tier: regular (the
                              node's confined default), all (unconfined), or
                              sandbox (all's capability, only inside the OS box)
/<handle> restart             bounce the node (daemon respawns the current checkout)
/<handle> upgrade             git pull + npm install + rebuild, then respawn
/<handle> rewind <ref>        check out <ref>, reinstall, respawn
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
reference, [`OPERATIONS.md`](OPERATIONS.md) for deploying to the live nodes and getting a shell that can,
and [`TESTING.md`](TESTING.md) for the manual verification tiers.

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
