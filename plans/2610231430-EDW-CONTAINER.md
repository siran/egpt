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

## 10-24 ~13:50 UTC — SI+EduWeb seeded; heartbeats moved to AWS
- **Seed:** kg's whole WhatsApp SI+EduWeb folder went into ED's Telegram folder on AWS (3.1 GB): desktop/, scripts/, .tools/, .ssh/ (E's key, now owned by ED's box uid 200000, 0600), the history in whatsapp/ subfolders, all granted to the box. The Windows Chrome profile `.tools/chrome-headless-perfil` was left out (unreadable, and useless on Linux).
- **Wall:** proven live. "ed ejecuta whoami" → `egpt-box-0`. ED is `sandbox` in SI+EduWeb. On EC2 it needed `--security-opt systempaths=unconfined` (c0db3ff) for the box's /proc.
- **Heartbeats** (operator: "let it be AWS's container, disable KG's; KG is the working backup"):
  - AWS: the 7 are active as `agent: ed` with `python3`. Only 2 are daily (chequeos-bd 06:30, agenda-diaria 07:45 Caracas); the 5 one-shot `when` beats are stale.
  - kg: the 7 are paused in `heartbeats.paused/`. **To fall back:** move them back into `heartbeats/` on kg.
  - First AWS run is tomorrow. E's scripts may need Python packages on Linux; ED can install them in its box.
- Follow-ups: "❌ Sending failed" shown for a failed turn (wrong words); the readback falls into a turn while a note is still being transcribed (wait instead).

## Next project (operator 10-24): a 3rd personal node in the cloud, VA
- Like DO: the same two Beeper accounts (primary ear and secondary mouth, signed in over VNC), its own node name and its own beings with their own handles. It runs in the operator's **personal** AWS account (480854905773, profile default/anmichel), so EduWeb's admins cannot read it.
- kg keeps wren, Drive and the laptop's files. kg/do config gains the third node in its node lists (e.g. echo peer_priority).
- Needs: two Beeper profiles in one container (second API port), Beeper tokens in secrets/, the scripts pointed at the personal account, local transcription sized for personal voice traffic.
- Names (operator 10-24): node **`VA`** (pronounceable; was `wb`); main being **Nova** ✨, handles `nova` + `v`, voice handle `nova` (written the same in es/en). Checked against every handle in use on kg/do/EDW: no collision.
- Open: other beings; always-on duties or a plain peer.

## Status 10-24 05:45 — EDW runs on AWS
- **Instance:** i-02476c2d8b9173596, now **t3a.large** (~$55). It was resized after t3a.medium thrashed: two notes ran large-v3 CLI copies at once, plus a being's own whisper. Data volume `edw-data` vol-0c60425dcce01918b, 30 GB at /srv/egpt (egpt-home, egpt-claude, egpt-src).
- **Image:** egpt:16597095 (= :edw, from branch edw): the wall, sudo/acl/openssh, Xvfb `-nolisten local`, the Claude token from secrets/. Checkout at 16597095.
- **Transcription:** resident whisper-server (large-v3 loaded once, one note at a time, `-t 2`), CLI as fallback. Still slow on 2 vCPUs; improve later ("EDW is mostly text and images"). Ear-transcripts are not posted (`posts_back_delay_ms: -1`).
- **lark → leo** 🦁 (handles leo, l). kg's llama dropped `l`, so leo owns it on kg/do/EDW. Cause: kg's llama `l` fired kg's readback into EDW's Telegram group, posting as the operator.
- **SI+EduWeb history** refreshed from kg on AWS (to 10-23 22:55).
- **Waiting on the operator:** `claude setup-token` → secrets/claude-oauth.token, then ED in SI+EduWeb goes to `sandbox`.

## 10-24 — the chatbox (limbs.http), when built (operator)
- It behaves as eGPT does now: each chatbox session is a conversation (a ROOM folder `conversations/http/<client>-<id>`, the session token is its chat id). ED answers within it, with memory and tools. The team watches and replies in the conversation's Telegram group. "Not a Claude proxy."
- On EDW the being answers to `ed` (E's role, ED's handle).
- Replies: SSE streaming plus a plain JSON reply.
- The logged-in visitors' in-context info is discussed after SI+EduWeb is fully up.

## 10-24 — queued after the wall: a browser screen per conversation (operator: "yes")
1. Each conversation's Chrome gets its own virtual display (chrome-host sets DISPLAY per group; today every Chrome inherits :99).
   → verify: one conversation's VNC never shows another's window.
2. Each display gets its own noVNC with its own password, handed out as a short-lived link in that chat (e.g. `/ed screen`).
   → verify: the link stops working when it expires.
3. A way in from outside: **one HTTPS port** (operator: no Cloudflare). It is also the entry the website chatbox (limbs.http) needs, so a single HTTPS front (Caddy, automatic TLS) serves both.
   - Behind it: the screen proxy and the chatbox endpoint only, never the spine.
   - Links: long random tokens, short-lived; an empty 404 when no link is live; rate limits.
   - It needs an Elastic IP and a name in Route 53 (EduWeb's account). Name: **`edw.eduweb.com.ve`** (operator, 10-24).

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

## 10-24 ~15:00 — Telegram deleted two groups; fixes
- Telegram deleted SI+EduWeb twice (tg:-5239545023, tg:-5347384406: "the group chat was deleted"). The operator's account is clear (@SpamBot). The third group is "EduWeb" (tg:-5256478300), joined by invite link. It is re-pointed to ED's seeded folder (thread, sandbox, warm.keep, heartbeats).
- **edw eaaa6cc: no invisible characters on Telegram.** No node/being frame, canary, zero-width, BOM or bidi; ZWJ/VS16 kept inside emoji. The bot's own messages are known by sender, the being by its visible stamp. Beeper signing unchanged (locked). Deployed to EDW.
- **main b68356f: per-chat handles.** `agents.<being>.handles` in a chat's entry replaces the node-wide list there; `[]` = no name. One resolver (agentsInChat) for the router, commands, mention flags and readback. Deployed to kg and do.
- **kg is fully silent in EduWeb** (fb85ZpUsf8lUl8jGjbU7): all 12 beings `mode: off` + `handles: []`. Operator: "the mouth has to be the bot, not my account". On Telegram, kg's only mouth is the operator's own account.
- **Structural follow-up:** every new EDW Telegram group the operator joins is also seen by kg (his Telegram is in kg's Beeper). Either kg goes silent automatically in chats where an EDW bot is a member, or EduWeb's groups use a Telegram account that is not bridged into kg.

## 10-24 ~15:15 — alignment (operator) and the rename lesson
- **Groups:** EduWeb (Telegram, tg:-5256478300) is the team's main group: ED + leo through @edwsi_bot. WhatsApp SI+EduWeb is no longer the team's main group but still live: kg's E and the other beings answer there as before (heartbeats moved to ED). The operator disconnected Telegram from kg's Beeper, so kg sees no Telegram chats now.
- **No ongoing sync** of WhatsApp SI+EduWeb into ED (E/ED recover context from files when needed). Later, not primary: maybe Telegram back on kg to keep conversations in sync.
- **Cleanup:** the two orphan folders from the deleted groups were moved to conversations/archive/telegram/ on EDW.
- **The courtesy rename exists** ([contacts] re-slug on name change; the path follows the folder). At 14:31 it renamed ED's folder SI+EduWeb-2610240312 → EduWeb-2610240312. It does NOT carry:
  1. the box registry (state/box-users.tsv, root-owned, keyed by path). ED's next turn would have got a new uid that can't read its own .ssh or grants. Fixed by hand: 200000 → new path.
  2. the boxed Claude session dir (projects/<cwd-slug>). Fixed by hand: copied under the new slug.
  → **To build:** the launcher resolves a box uid by the folder's inode when the path is unknown, and moves the registry entry; the re-slug (or the launcher) links the session dir to the new slug.
- **fd07259:** boxed beings' Claude sessions (~/.egpt-jsonl) live on the data volume (/srv/egpt/egpt-jsonl), so a recreate no longer wipes them.

## 10-24 ~15:30 — EDW access and housekeeping
- **f59fc6f (edw):** the shell/being-link token may live in secrets/shell.token. EDW had none, so the console port was off and a boxed ED got ECONNREFUSED on 127.0.0.1:23475 (no browser, no spine). Token generated on EDW (0600); the port now serves.
- **ED's reach:**
  - default `allowed_users: [88164392]` (the operator only), so a stranger's group or DM gets nothing;
  - the EduWeb group allows everyone in it (`['*']`); its membership is the operator's.
- **Operator to do:** @BotFather `/setjoingroups` → Disable, turned on only while adding the bot to a group.
- **To build:** the bot leaves any group added by a non-allowed user.
- **Next image:** unzip, gnupg, jq, awscli, plus ED's proposals (ED writes them in its folder; the box sees the repo read-only).

## 10-24 ~16:35 — EDW small, no transcription (operator)
- **EDW is t3a.small on-demand** with `transcription_service.enabled: false`. Idle use: 361 MB of 1.9 GB, swap unused. NV and EDW run without transcription; kg keeps DO's worker → its CLI.
- **Monthly cost of ED in EduWeb's account** (Pricing API, us-east-1): EC2 13.72 + gp3 60 GB 4.80 + public IPv4 3.65 + ECR ~0.5–0.9 + egress ~0.1–0.5 ≈ **$23**. On Spot ≈ $14–16. Trimming volumes saves ~$2; deleting the old images ~$0.40.
- **Operator direction:** "moving away from managing our EC2 boxes, moving to virtual when possible". Fargate can't host the box (no seccomp/systempaths unconfined); ECS on EC2 is the nearest step.
- **Lambda** (asked): it doesn't fit a node's core (always-on, stateful, 15-min cap, no GUI/warm sessions). It may fit edges: Telegram webhook or chatbox front, occasional jobs.
- **Encryption** (asked): no disk/KMS setting keeps an account's own admins out (they hold the keys and can open a shell). The boundary is the account. NV goes in the personal account (MFA on root and anmichel; note WSL ~/.aws holds long-lived admin keys).

## 10-24 ~16:50 — NV backburnered; ECS on EC2 (operator prefers it to managing EC2)
- **NV:** backburnered (operator).
- **The box needs, from the kernel:**
  1. user namespaces: Docker's default seccomp blocks unshare/clone flags, so the container runs seccomp=unconfined; Chrome's own sandbox needs the same;
  2. a fresh /proc in the box: EC2 Docker masks /proc/acpi,/proc/scsi, so the container runs systempaths=unconfined;
  3. pivot_root and bind mounts inside the namespace.
  Fargate allows neither 1 nor 2.
- **ECS on EC2:** orchestration is free; instances cost what EC2 costs (EDW ~$23, ~$14–16 on Spot). Its value is lifecycle (restarts, task revisions, an ASG replacing instances).
  - ECS `dockerSecurityOptions` accepts only no-new-privileges / apparmor / label / credentialspec (API docs, ContainerDefinition). There is no seccomp or systempaths. Only `privileged: true` (EC2 launch type) gives the box what it needs, at the cost of root-level power over the host. Fine with EDW alone on its instance; not when packed with EduWeb's other containers.
  - **Proposed later**, after ED is tested on the current setup: an ECS cluster with one t3a.small Spot instance in an ASG; EDW as one privileged task; its data on an EBS volume the instance re-attaches at boot.

## 10-24 ~16:50 — edw merged into main; one branch for every node
- 95d3af4 merge (one conflict: the per-chat readback list now goes to the shared readBack via wake.replyWakeWords). Full suite green except the known beeper-bridge load flake (304/304 alone).
- Deployed: kg and do at 95d3af4 (both Beeper connections open, heartbeats fresh); EDW checkout switched to main (45bcbb6, run.sh EGPT_BRANCH=main). The `edw` branch is retired and kept on GitHub as history.
- Gap: Telegram readback uses node-wide replyWake (no per-chat override there yet).

## 10-24 ~17:00 — rulings: never deny a browser; ECS over EC2 go
- **"Don't deny browsers to conversations."** ED was refused a Chrome: commands.mjs ensureChrome declined when os.freemem() minus the estimate fell under the ~1 GB margin. The fix keeps eviction of an idle Chrome, then launches anyway with one log line (fix/never-deny-browser, agent).
- **ECS over EC2: go** (feat/edw-ecs, agent; scripts only, dry run first):
  - cluster `edw`; ASG of 1 (t3a.small Spot by default, `--on-demand` switch) in us-east-1a; ECS-optimized AL2023;
  - user data re-attaches edw-data and mounts /srv/egpt;
  - task privileged + host network + host mounts; service min 0 / max 100 (never two pollers);
  - VNC password read from secrets/ on the volume; ecs-provision / ecs-deploy / ecs-cutover (+ rollback).
- Also in flight: Telegram HTML rendering (feat/telegram-html, agent): mdToTgHtml brought back from 25176248, parse_mode HTML, plain fallback.

## 10-24 ~17:20 — Nova lives on EDW (test; operator)
- **Nova ✨** is a being on EDW (handles nova, v; E's identity, opus-high; `regular`; allowed_users [operator]). She speaks through @edwsi_bot in the operator's own Telegram groups ("for a test… I can later move Nova"). Each group is its own conversation; leo can read them all; EduWeb's AWS admins could read them while she lives on EDW.
- Her own group: `/nova agents mode on` there. Own bot later = multi-bot support for the Telegram limb (today one bot per node); then move her to her own node/account.
- Also live (c5e62041 on all nodes): Telegram renders beings' Markdown (mdToTgHtml back, parse_mode HTML, plain fallback); browsers are never denied (8b21c11).

## 10-24 ~23:35 — ECS scripts ready; many bots; what the Claude token exposes
- **ECS scripts (bc197b83, main), not applied.** Run order, on the operator's go:
  1. `bash docker/aws/ecs/ecs-provision.sh --apply`: cluster, launch template, ASG at 0, role, task def, service at 0. No downtime.
     → verify: an `ecs-cutover.sh` dry run prints the plan.
  2. `bash docker/aws/ecs/ecs-cutover.sh --apply`: 5–10 min down; beings restart mid-conversation.
     → verify: task RUNNING, alive.txt fresh, ED answers in EduWeb, Nova in her group, "ed ejecuta whoami" → egpt-box-0.
  3. `ecs-cutover.sh --rollback --apply` if the box or the first boot fails. edw-node stays stopped (not terminated) until the operator says.
  - Untested: user-data first boot, the box under `privileged`, Spot capacity in us-east-1a.
- **Many bots per node (operator):** each bot is a connection under `limbs.telegram`, like Beeper's primary/secondary (edw_marketing_bot, edw_support_bot, egpt_reve_bot…), each being speaking through its own. Build: the limb wires only the first connection today.
- **"Are my personal conversations visible?" (the Claude token):** no. The setup-token runs new requests on the subscription. Claude Code sessions are local files per machine, so kg's stay on reve; to my knowledge the token can't list claude.ai chats. The exposure is usage: whoever holds it (EduWeb's admins, leo) can spend the subscription's limits. Revoke and reissue if that worries. Nova's test chats on EDW are readable by EduWeb's admins and leo.
- **EDW at 23:34:** container up 11 h, heartbeat fresh, 884 of 1915 MB used, swap 379 MB.
