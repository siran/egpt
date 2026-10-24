# EDW — eGPT in a Linux container (operator 2026-10-23)

Goal: eGPT stops depending on the laptop. A blueprint image carries the same stack as kg: Beeper, Chrome, whisper-cli large-v3, piper, and the claude/codex CLIs. A node, EDW, is built from it: first locally on reve, later on AWS.

## Shape (operator: "on point on all counts")
- **Blueprint image, no secrets:** Linux, Node, an eGPT checkout, Xvfb, Beeper Desktop (Linux build), Chrome, whisper-cli + the large multilingual model, piper, the claude and codex CLIs.
- **A node** = the image + a volume (EGPT_HOME: config, conversations, Beeper and Chrome profiles) + secrets given at start. A descendant is a volume and a config, never an image with tokens in a layer.
- **One container per node**, never two copies of it (both would answer).
- **Upgrades as today:** git pull inside the container on `/upgrade`. The image is rebuilt only for OS or tool updates.
- **Network:** the node dials out only; no inbound ports.
- **Beeper sign-in:** the first sign-in goes through a temporary VNC over an ssh tunnel, which is then turned off.

## Rulings
- **Node:** EDW, single account (primary only).
- **Being:** ed, mode `accum`, in SI+EduWeb.
- **First primary:** Rodz's number, which today is the mouth on kg and do. Later, EduWeb's own number takes over; the operator is then just a group member. The number switches before AWS.
- **Sandbox:** one Unix user per conversation, built into the runtime. Beings then get `access_level: all` inside it.
  - The wall is structural and OS-provided: a chroot (or equivalent) that holds the tools, the being's conversation folder, and nothing else.
  - A being cannot read config.yaml, the Beeper profile, or another conversation.
- **Whisper:** whisper-cli with the large multilingual model, as on kg (en/es).
- **Claude:** the operator's subscription.
- **Where it runs:** locally first, on reve (Docker Desktop 29.4 installed, its engine not running; WSL2 Ubuntu-22.04 present). AWS later. Note: SSM values are visible to AWS admin users.

## Rulings, 10-23 afternoon
- **Base:** built in WSL2 on reve (native Docker 28.3), starting from the operator's own container work. `docker/` was committed as built (da18640).
- **Code:** the code becomes a git checkout at `~/src/egpt` on a volume, so `/upgrade` and in-container edits work. The repo is public, so it pulls without credentials.
- **Beings:** `ed` is the container's E. `lark` (🐦) is the container's wren: `access_level: all`, unsandboxed, answering only the operator. The container is its box.
- **No codex** in the container.
- **Account:** Rodz's number only (primary), later a custom number (a Beeper account exists on soporte@eserviciosat.net). Telegram could replace Beeper later; no change now.
- **lark rebuilds its own image (idea, not built):**
  - Local: a cron builds the image. A host-side job that rebuilds when `docker/` changes on main is safer than handing lark the Docker socket, which is root on WSL, where `~/.aws` and `~/.claude` live.
  - AWS: lark builds a new image, pushes it to ECR, points the task definition at it, and ends its own task ("harakiri").
- **Live fix:** the egpt-dev container's config said `node_name: kg`; it is now EDW (backup `config.yaml.pre-edw-20261023T200627`).

## Ruling, 10-23 evening
- **WhatsApp in the container is backburnered.** EDW talks over **Telegram** with a regular user account; no bots (operator: "we don't use bots in whatsapp" — the beings are the agents).
- **Linked devices:** Beeper's WhatsApp link belongs to the Beeper account, not to each install. kg and do share Rodz's Beeper account, so they count as one linked device on Rodz's WhatsApp.
- **VNC stays:** noVNC (http://localhost:6080/vnc.html) is the window into the container's screen, for watching eGPT's per-conversation browsers. Telegram sign-in doesn't need it.
- **Native Telegram limb now** (operator: "native telegram, of course"), on branch `edw` for the container. kg/do Beeper unchanged; SI+EduWeb not touched.
- **It is a Telegram BOT** (operator, after learning a user login needs our own api_id/api_hash: "we need a bot for EDW"). Bot API over HTTPS long polling, so the node dials out. Every being on EDW speaks through the one bot with its own stamp. Bots never see other bots' messages; privacy mode off (or admin) to read whole groups; one poller per token.
- **Tokens live in a folder, not in config.yaml** (operator): `$EGPT_HOME/secrets/telegram-<connection>.token`, 0600. config.yaml names only the connection. Beeper tokens on kg/do stay as they are for now.
- History: the earlier Telegram use was a Bot API bridge (removed fa208ca, never enabled) and, since July, the operator's Telegram inside Beeper on kg.
- **Telegram today rides Beeper** (reve's Beeper has Telegram; `conversations/telegram/`). A direct Telegram-bot transport existed and was removed in fa208ca. A native Telegram limb (MTProto user client, `limbs.telegram`, no Beeper) would be new code.

## Status 2026-10-23 22:05 (EDT)
- **EDW is live on Telegram.** lark answered the operator in the bot's DM at 22:01 (first round trip through the container).
- **Container:**
  - `edw` from image `egpt:edw-dev`: seccomp unconfined, hostname `edw`, restart unless-stopped.
  - Ports: noVNC on 127.0.0.1:6080 and VNC on :5900.
  - Volumes: egpt-home, egpt-beeper, egpt-claude, egpt-src. The checkout is on branch `edw` (42ec953 + a7c180e).
- **EDW config:**
  - one bot, `limbs.telegram.main: @edwsi_bot`, with its token in `secrets/telegram-main.token` (0600); no Beeper;
  - lark is the only being; the operator's Telegram id is the only one allowed;
  - transcription off.
- **Claude** is signed in with the operator's subscription (egpt-claude volume).
- **Open:**
  - should lark be node-wide like wren (`scope: agent/lark`)? Today it has one thread per chat;
  - should the bot place reactions? (single-account rule today);
  - Telegram media and voice;
  - ed + the per-conversation Unix-user wall;
  - when to merge `edw` into main.

## Steps
0. **Linux inventory**, read-only.
   → verify: every Windows-only path in `src/` and `setup/` is listed with its Linux replacement.
1. **Blueprint boots with no accounts.**
   → verify:
   - the spine starts;
   - verify-install passes;
   - Chrome runs under Xvfb;
   - piper speaks;
   - whisper-cli transcribes an en and an es sample;
   - claude answers on the subscription.
2. **Rodz's Beeper as EDW's primary**, no beings on.
   → verify: EDW hears SI+EduWeb and answers nothing; kg and do are unchanged (no doubles, 👂 as before).
3. **ed in SI+EduWeb**, `accum`. A one-way copy of the SI+EduWeb folder goes into EDW. ed stays at `regular` until step 4's wall exists.
   → verify: ed answers when named and has the history; E is unaffected.
4. **Per-conversation Unix user + chroot wall**, then `access_level: all`.
   → verify: a test shows that, from a being's Bash, config.yaml, the Beeper profile and other conversations cannot be read.
5. **AWS**: later, its own step; everything stays local until then. No CloudFormation (operator 10-23: "we can just script our way to build, push, run image"). The template the operator drafted on 10-19 was removed and is still in da18640.
6. **Number switch:** EduWeb's number signs into EDW, SI+EduWeb is re-linked to its new chat id, and E steps back.
   → verify: the group continues and ed has the history.

## Open checks
- **Rodz's WhatsApp linked devices (before step 2).** If Beeper runs the WhatsApp connection on each device, each install is one linked device, and WhatsApp allows 4. Count them on Rodz's phone: WhatsApp → Linked devices.
- **The Claude token is visible to beings.** A being's CLI runs on the subscription token, so the being can read it. This is inherent. The token unlocks Claude only, not WhatsApp or the config.
- **EDW stops at sign-out while it is local.** Docker Desktop runs in the operator's session, so EDW stops when the operator signs out. That lasts until EDW moves to a host that runs without a login.
