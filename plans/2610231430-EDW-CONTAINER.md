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

## Rulings, 10-23 22:15
- **lark:** node-wide like wren (`scope: agent/lark`, applied), `access_level: all`, living in `agents/` as the meta engineer.
- **Reactions:** the bot reacts the way E does on kg, following its pointers ("it's all like KG"). A Telegram bot is the being's own account, so the single-account suppression doesn't apply to it. Build dispatched on `edw`.
- **Voice and media on Telegram:** turned on (whisper-cli and piper are local in the image). Build dispatched on `edw`.
- **EDW's public beings, marketer and support (`ed`), stay at `regular` at most.** So the per-conversation Unix-user wall is not needed for them now.
  - Note: `regular` confines them through the Claude CLI's permission rules. The tools are Read, Write, Edit, Glob, Grep, WebSearch, WebFetch and Task; there is no Bash; file tools are limited to the conversation folder. It is not an OS wall: they run as the same Unix user as the spine.

## 10-24 — queued after the wall: a browser screen per conversation (operator: "yes")
1. Each conversation's Chrome gets its own virtual display (chrome-host sets DISPLAY per group; today every Chrome inherits :99).
   → verify: one conversation's VNC never shows another's window.
2. Each display gets its own noVNC with its own password, handed out as a short-lived link in that chat (e.g. `/ed screen`).
   → verify: the link stops working when it expires.
3. A way in from outside: **one HTTPS port** (operator: no Cloudflare). It is also the entry the website chatbox (limbs.http) needs, so a single HTTPS front (Caddy, automatic TLS) serves both.
   - Behind it: the screen proxy and the chatbox endpoint only, never the spine.
   - Links: long random tokens, short-lived; an empty 404 when no link is live; rate limits.
   - It needs an Elastic IP and a name in Route 53 (EduWeb's account hosts eduweb.com.ve, eserviciosat.net, …). Proposed: `edw.eduweb.com.ve`.

## 10-24 04:30 — ED in SI+EduWeb gets full access, inside the wall (operator)
- Only ED in SI+EduWeb gets full access. "SI+EduWeb is a circle of trust group: EduWeb developers and admins."
- "We don't want SI+EduWeb to access all my claude conversations (which include my personal egpt usage). ED needs to be like E on my laptop, full access." That is kg's level `sandbox`: all's capability inside an OS box. On Linux this needs the per-conversation Unix-user wall (dispatched on `edw`).
- ED stays `regular` until the wall lands, then `sandbox` in SI+EduWeb. It gets its own new ssh key (the operator authorizes it on EduWeb's servers); E's key stays on kg.
- After the AWS cutover, refresh the SI+EduWeb history from kg, one way, through the transfer bucket.

## 10-24 — AWS (operator: "the power is on the anthropic side; traffic is very low")
- **Account:** EduWeb's, profile `eduweb` (331665579468, us-east-1, ECR `egpt` exists). Production runs there, so EDW gets its own VPC/SG with no inbound, tags Project=egpt-edw, and the scripts never touch untagged resources.
- **Instance: t3a.medium** (2 vCPU / 4 GB, ~$27/mo on-demand, Pricing API 10-24) with a 4 GB swap file. Operator: "we need to keep transcriptions". t3.small (~$15) was too small for large-v3. t3a.large (~$55) if voice notes struggle.
  - Measured idle use of `edw`: ~390 MB (Claude session ~125 MB, Beeper ~130 MB, which will be off).
- **Plain EC2 + Docker, scripted** (build-push, provision, migrate, run; dry run by default). EGPT_BRANCH=edw, EGPT_BEEPER=off. Cutover: stop local `edw` first (one bot poller), move the volumes through a private encrypted S3 bucket, delete the objects. Scripts dispatched on feat/edw-aws.

## 10-24 03:30 — SI+EduWeb on Telegram; a real group per chatbox conversation
- **SI+EduWeb on Telegram exists** (`tg:-5239545023`). The operator created it and added @edwsi_bot, and ED answered there.
  - ED is set as kg's E is in WhatsApp SI+EduWeb: `opus-xhigh`, `warm.keep`.
  - **History copied one way from kg's WhatsApp SI+EduWeb** (snapshot to 10-23 23:55) into `transcripts/whatsapp/`, `media/whatsapp/`, `files/whatsapp/` and `handoffs/whatsapp-egpt.*`. ED's handoff `ed.261024-0330.handoff.md` points at it.
  - **Not copied, pending the operator:** E's `desktop/` (2.8 GB) and `.ssh` (E's EduWeb server key `egpt_edw`, plus an `aws` file).
- **Support and marketing: a REAL Telegram group per conversation** (operator), so the team can reply from Telegram even when the conversation started in a website chatbox. Bots can't create groups (Bot API: no such method; bots can only leave), so a **user account (+1 646 598 7553) is the group factory**: it creates the group, adds @edwsi_bot as admin and adds the team, and later deletes the group.
  - This needs our own api_id/api_hash: awaiting the operator's go.
  - Caveats: Telegram watches automated user accounts (pace the factory); each member's membership cap (~500, to verify) makes deleting old groups necessary.
- **kg sees both new Telegram chats** (the operator's Telegram is in kg's Beeper). The operator is to send `/e agents mode off` in each.

## ED, one being with use-cases (operator 10-23 23:00, SUPERSEDES the three-beings table below)
- **ED** is the container's E: one being in every chat (🦉, handle `ed`, opus-high, E's identity). Applied, `regular` until the wall.
- **Its use-cases differ by chat:**
  - **IT support:** the SI+EduWeb group, recreated on **Telegram** by the operator with the team. Needs `all` behind the wall.
  - **marketer and client support:** **HTTP chatboxes** (website and logged-in area), not Telegram. Each chatbox conversation is a ROOM instance, a folder under `conversations/http/`, one per chat session.
- **lark** also answers to `l`. Applied.
- **Hazard when the operator joins the Telegram SI+EduWeb group:** kg's Beeper also has the operator's Telegram, so kg sees the group too, and kg's E could answer "e …" there from the operator's account. Turn kg's E off in that group (`/e agents mode off`). ED's handle is `ed` only, so it never collides with kg's `e`.

## Three beings on EDW (operator 10-23 22:30)

| Being | Serves | Access |
|---|---|---|
| marketer | public marketing chat with strangers | `regular` |
| `ed` (support) | EduWeb's **clients** | `regular` |
| E (name pending) | EduWeb's **IT staff**: the technical work E does in SI+EduWeb today (ssh to EduWeb servers, portals, git) | needs `all` |

E needs `all`, so the per-conversation Unix-user wall (step 4) is its prerequisite. Its ssh key lives under its own user. All three speak through @edwsi_bot, each with its own stamp. Each chat's modes decide who answers.

Open questions: E's name/handle; where E talks (a Telegram group with the IT staff, or SI+EduWeb on WhatsApp, which is backburnered); order (wall first).

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
