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

## 10-25 ~00:00 — EDW runs on ECS over EC2
- **Cutover done** (23:41–23:49, ~5 min down): edw stopped on edw-node (i-02476c2d8b9173596, now stopped, not terminated), edw-data moved, ASG edw-ecs-asg launched i-08ea6b24bff581adc (**t3a.small Spot**, ECS agent 1.108.0), service edw at 1 (task def edw:1, image d8ec5f50…).
- **Verified:** daemon up, @edwsi_bot polling, heartbeat fresh, 455 of 1919 MB used, 4 GB swap; only root reaches IMDS (iptables).
- **The box works under `privileged`:** egpt-box as ED's folder → uid 200000 egpt-box-0; config, /srv and other conversations invisible; IMDS unreachable (000); pid 1 tini.
- **Found and fixed (200179a6):** host network gives the task the instance's hostname (ip-10-…). sudo couldn't resolve it, and Chrome would refuse chrome/profiles/shared (stale `SingletonLock -> edw-531` = "in use on another computer"). User data now sets hostname edw + /etc/hosts + preserve_hostname (launch template v2); applied by hand on the running host; task redeployed.
- **VNC:** the password now comes from secrets/vnc.password on the volume; /srv/egpt/vnc.env is unused.
- **Next:**
  1. Operator test: ED in EduWeb, Nova in her group, "ed ejecuta whoami" → egpt-box-0.
  2. Terminate edw-node once ECS has proven itself (operator's word): `aws ec2 terminate-instances --instance-ids i-02476c2d8b9173596` (its root volume goes with it; edw-data stays).
  3. Image updates: build-push.sh, then ecs-deploy.sh. Code updates: /upgrade as before (the checkout is on the volume).

## 10-25 ~00:30 — what a Spot replacement costs in downtime; EDW's monthly bill; transcription is on
- **No overlap on a replacement.** Two things allow one EDW at a time: the data volume attaches to one instance, and the bot token allows one poller. On a Spot reclaim (2-minute notice), ECS drains the task (SIGTERM, 30 s), the ASG launches a new instance (CapacityRebalance is off), and user data waits for the volume. The 4 GB image is pulled after the mount, then the task starts. Expect ~5–8 min down.
- **egpt does not finish its work on a container stop.** The drain (turns in flight, background agents, 30-min cap) exists only for /upgrade and /restart. A container stop is a SIGTERM that the entrypoint's bash doesn't pass on. tini exits, and everything in the container dies at once, so the turn in flight is lost. What survives: sessions and transcripts on the volume. Telegram keeps undelivered messages; on restart, those under 15 min old (WAKE_WINDOW_MS) are answered and older ones are backlog.
- **Spot Advisor, us-east-1 Linux:** t3a.small and t3.small sit in the 15–20 %/month interruption band, ~2 reclaims a year. The 24 h price in us-east-1a is $0.0058/h vs $0.0188 on-demand. CPU credits are unlimited; the 36 h average was 7 % (baseline 20 %), so there were no surplus charges.
- **Options to shorten or soften it** (not done):
  1. ASG Capacity Rebalancing.
  2. Pre-pull the image in user data, before the volume wait.
  3. Drop large-v3 from EDW's image: 4 GB → ~1 GB. Unused here, since leo moved transcription to small on the volume.
  4. The entrypoint forwards SIGTERM to the daemon, the spine drains on SIGTERM with a cap under the notice, and the task gets stopTimeout 120.
  5. `--on-demand` (+$9.5/mo) removes reclaims.
- **Monthly cost, measured 10-25** (730 h; Pricing API, Spot history, live volume and ECR sizes):

  | Item | Now | After cleanup |
  |---|---|---|
  | t3a.small Spot | $4.23 | $4.23 |
  | gp3 | 90 GB, $7.20 | 60 GB, $4.80 |
  | Public IPv4 | $3.65 | $3.65 |
  | ECR | 13 GB, $1.30 | 4 GB, $0.41 |
  | Egress | <$1 | <$1 |
  | ECS, SSM, ASG | $0 | $0 |
  | **Total** | **≈ $17** | **≈ $13.5** |

  "Now" still keeps the old instance's root volume (edw-root, 30 GB). "After cleanup" means the old instance is terminated and ECR keeps only the current image. On-demand instead of Spot: ≈ $23.
  - Seen, not ours (no Project tag): 5 unattached Elastic IPs in EduWeb's account, ~$3.65 each/mo.
- **Transcription is ON** (leo, 10-24 18:46–19:25, after the 16:33 "off"; backups pre-small, pre-audioctx):
  - whisper-cli only, ggml-small on the volume (~/.egpt/models/whisper), language es, 2 threads, audio_ctx auto (a 5.5 s note: 57 s → 20 s);
  - no resident server (small still held ~750 MB); ear posts -1.
  - Data volume 4.5 of 30 GB used.

## 10-25 ~00:50 — near-zero handover for the node; a worker for voice (proposed, operator)
- **Operator:** keep the node on a small Spot instance with no downtime when it is working; a separate, bigger ECS worker for voice (transcription es+en with a high model, piper, light ffmpeg).
- **What AWS offers:**
  - Capacity Rebalancing: the ASG replaces a Spot instance at elevated risk, usually before the 2-minute notice;
  - ECS managed draining and task scale-in protection (a busy task holds off OUR deploys and scale-ins).
  - Nothing defers a reclaim past its 2 minutes.
  - With one disk and one poller per bot, the old and new copies can't overlap, so the floor is ~1 min of silence (messages wait in Telegram), not zero.
- **Worker = the existing worker role** (transcriptor-worker.mjs: the same egpt serving signed POST /v1/transcribe, as dolly does for kg) plus the synthesizer worker role. EDW points `whisper-server-remote` at it, falling back to its local small CLI.
- **Worker prices** (Pricing API + 24 h Spot max, us-east-1a; Spot Advisor band):

  | Type | Cores, RAM | On-demand $/mo | Spot $/mo | Interrupt band |
  |---|---|---|---|---|
  | t3a.medium | 2 burst, 4 GB | 27.45 | 10.22 | >20% |
  | t3a.large | 2 burst, 8 GB | 54.90 | 19.93 | >20% |
  | c7a.large | 2, 4 GB | 74.93 | 24.53 | 5–10% |
  | m7a.large | 2, 8 GB | 84.62 | 30.81 | >20% |
  | c7a.xlarge | 4, 8 GB | 149.85 | 54.53 | 10–15% |
  | c6a.xlarge | 4, 8 GB | 111.69 | 55.41 | 5–10% |

  - Each instance adds ~$6/mo (30 GB root + IPv4).
  - No CPU timings measured for large-v3 on these. Known points: small took 20 s for a 5.5 s note on t3a.small (2 threads); large-v3 "swapped for minutes" on t3a.medium; "still slow" on t3a.large.

## 10-25 ~01:05 — rulings: always responsive; no container hand-off build
- **"egpt can't go silent. always responsive."** The node runs **on-demand** (no Spot reclaims): +$9.50/mo, EDW ≈ $23/mo. The voice worker may stay on Spot, because the node falls back to its local small CLI.
- **No container hand-off build** (operator): image updates will be rare in production; code changes go in place through /upgrade (it drains while still answering, then a ~2 s restart: spine start → bot listening in ~1.5 s on 10-25). Only root-level packages need a new image.
- Remaining silence: an AWS hardware failure (EC2 auto-recovery, minutes; rare), and an image update through ECS (~1 min; at quiet hours).
- Pending go: switch the ASG to on-demand and replace the Spot instance (one last ~5–8 min outage).
- **Cheaper no-reclaim options for the node** (10-25, Pricing API + RI Marketplace listing, t3a.small Linux us-east-1; per month at 730 h):

  | Option | Per month | Note |
  |---|---|---|
  | On-demand | $13.72 | |
  | 1-year reservation, no upfront | $8.61 | all upfront: $96 ≈ $8.00/mo |
  | 3-year reservation, no upfront | $5.91 | all upfront: $186 ≈ $5.17/mo |
  | Spot | ~$4.23 | reclaimable, ruled out |

  - **RI Marketplace** (other customers reselling the rest of their reservations): regional t3a.small at $0.0118/h with 90 and 180 days left. AZ-scoped ones (210 days, $37.92 / $61.25 all upfront) sit in us-east-1c and 1f; edw-data is in 1a.
  - A regional reservation is a billing discount the ASG's on-demand instance gets automatically. It is a purchase on EduWeb's bill: operator's call.

## 10-25 ~01:30 — one on-demand instance for the node and a whisper container (operator)
- **Operator:** ECS on EC2 capacity. The transcriptor runs as a second container on the node's instance (no extra instance), on-demand.
- **Shape:**
  - a whisper-server task on the same instance (host network, :8089), with a hard memory limit so it can't starve the node;
  - the node already adopts whatever answers on 127.0.0.1:8089 ("adopted the moment something answers, never spawned"), so this is config only: fallback_order [local, cli];
  - piper and ffmpeg stay in the node.
- **Fit:** the node idles at ~0.5 GB, plus Chrome and CLIs per active conversation.
  - Full large-v3 (~3.1 GB model) doesn't fit beside it in 4 GB; large-v3 quantized (q5) or large-v3-turbo does.
  - Full large-v3 needs t3a.large (8 GB).
  - Speed on 2 burstable cores is unmeasured → benchmark first.
- **Price per month** (Pricing API, us-east-1, 730 h):

  | Instance | On-demand | 1-yr reserved, no upfront | 3-yr reserved, no upfront |
  |---|---|---|---|
  | t3a.small | 13.72 | 8.61 | 5.91 |
  | t3a.medium | 27.45 | 17.23 | 11.83 |
  | t3a.large | 54.90 | 34.38 | 23.73 |

  - Plus ~$9 fixed: root + data gp3 60 GB $4.80, IPv4 $3.65, ECR ~$0.41 with one image (the worker reuses it).
  - Changing size and switching to on-demand are one instance swap, so one outage.

## 10-25 ~01:50 — EduWeb EB → ECS: shared reserved capacity (operator)
- **Operator:** EduWeb is moving from Elastic Beanstalk to ECS. Reserve 1-year capacity and run many containers on it, with vCPU set per container.
- **EduWeb today** (read-only, 10-25): Portales-new t3a.large (CPU avg 6 %, max 100 %), Portales(OLD) t3a.medium (0.7 %), edw-Sun260628 t2.medium (EB PHP 7.4, 2.1 %), edc5-api-prod t3.micro (EB Docker, 0.5 %); ≈ $124/mo on-demand. Memory unmeasured: EC2 doesn't report it without the CloudWatch agent.
  - DBs stay on RDS: educomp5-db Postgres 18.3, eduweb-2020 Aurora PG 17.7, portal-institutions MariaDB. Postgres ≥ 14, so pg_read_all_data works.
- **Keep EDW on its own instance** (same cluster, own capacity provider). EDW is `privileged` + host network. Root inside it is root over the host: every container's filesystem and env (DB passwords) and their ports. Today two layers stand in between (the box; the egpt user with one sudo line); client chatboxes will put strangers' text in front of beings.
- **Commitment:** one EC2 Instance Savings Plan for t3a in us-east-1 covers both instances whatever their sizes. 1-yr no upfront, t3a.large: $0.0471/h vs $0.0752 on-demand (−37 %). A Compute Savings Plan (any family/size, Fargate too): $0.0542 (−28 %).
- **Per-container limits (ECS on EC2):** container `cpu` = a share under contention (it may use idle CPU); task `cpu` = a hard ceiling; `memory` = a hard limit (only that container is OOM-killed); `memoryReservation` = soft.
- **Operator:** no Fargate; EC2 capacity under ECS.
- **Families** (AWS describe-instance-types + Pricing API, .large, us-east-1):

  | Type | Physical cores | Clock | RAM | Burstable | $/mo |
  |---|---|---|---|---|---|
  | t3a.large (AMD) | 1, 2 threads | 2.2 GHz | 8 GB | yes | 54.90 |
  | t3.large (Intel) | 1, 2 threads | 2.5 GHz | 8 GB | yes | 60.74 |
  | t4g.large (ARM) | 2 | 2.5 GHz | 8 GB | yes | 49.06 |
  | m6a.large | 1, 2 threads | 3.6 GHz | 8 GB | no | 63.07 |
  | m7i.large | 1, 2 threads | 3.2 GHz | 8 GB | no | 73.58 |
  | c7a.large | 2 | 3.7 GHz | 4 GB | no | 74.93 |
  | m7a.large | 2 | 3.7 GHz | 8 GB | no | 84.62 |
  | r7a.large | 2 | 3.7 GHz | 16 GB | no | 111.07 |

  - EDW's image is x86 (Chrome, Beeper builds), so t4g doesn't fit EDW as is.
  - Mixing families (t3a + c7a/m7a) → Compute Savings Plan, not an EC2 Instance one.

## 10-25 ~02:10 — PLAN: t3a, always responsive (operator: "let's go with the t3a")
**A. EDW (egpt node + voice), on its own on-demand t3a instance**
1. **Benchmark** (no effect on EDW): two tagged on-demand instances (t3a.medium, t3a.large, Name=edw-bench) run the egpt:edw image's whisper-server with large-v3, large-v3 q5_0 and large-v3-turbo on two real Spanish notes (~10 s, ~60 s) and one English note.
   → verify: a table of seconds per audio minute + peak memory per model × size; both instances terminated afterwards (< $0.20).
   → operator picks model and size.
2. **Next image** (once, rare from then on): models leave the image and live on the volume (as leo's small does), so 4 GB → ~1 GB and pulls are faster. Adds unzip, gnupg, jq, awscli + ED's proposals.
   → verify: image builds; same whoami/box test in a local run.
3. **Whisper container:**
   - a second ECS service (edw-whisper: same image, whisper-server on :8089 with the chosen model from the volume, host network, hard memory limit, CPU share below the node), placed on EDW's instance (attribute edw-data);
   - EDW config: fallback_order [local, cli]; the node adopts :8089 (never spawns it).
   → verify: a voice note in EduWeb transcribes through :8089 at the benchmarked speed; stopping edw-whisper falls back to the small CLI; the node is unaffected.
4. **The swap** (one outage, ~5–8 min, at a quiet hour): ASG on-demand, the chosen t3a size only, launch template with the new image; replace the Spot instance.
   → verify: on-demand t3a.X, hostname edw, task running, bot polling, box test, heartbeat; then edw-whisper starts beside it.
5. **Cleanup** (operator's word): terminate edw-node i-02476c2d8b9173596 (its root volume goes with it); keep one image in ECR.
   → verify: no stopped instances or orphan volumes tagged egpt-edw; ECR holds one image.
6. **Savings Plan** (purchase on EduWeb's bill: operator buys, or an explicit go): EC2 Instance Savings Plan, t3a, us-east-1, 1-year, no upfront, $/h = EDW's instance. A second plan stacks when EduWeb's production moves.

**B. EduWeb EB → ECS (its own project, after A)**
7. Measure memory on the production hosts for a week (CloudWatch agent) → choose the production t3a size.
8. Per app (edc5-api already Docker; edw PHP 7.4 on EB AL2; Portales-new): container image, ECS service with CPU share + hard memory limit, ALB, secrets; cut over DNS one app at a time; retire EB envs and Portales(OLD).
   → verify per app: same responses before/after; EB environment terminated only after a quiet week.
- Production gets its own capacity (a cluster or capacity provider), separate from EDW's privileged instance.

## 10-25 15:48 — t3a Savings Plan bought; EduWeb's migration is ED's
- **Bought** (operator "yes"): EC2 Instance Savings Plan 0ad87e23-04f4-4d02-a785-fa8b9ba15f86, t3a, us-east-1, 1 year, No Upfront, $0.0471/h ($34.38/mo, $412.60/yr). **Active** 2026-10-25 19:48 UTC → 2027-10-25.
  - Covers one t3a.large-equivalent of on-demand use (Portales-new today, the ECS production host later): $54.90 → $34.38/mo, ~ −$20.50 from November.
  - Not covered: Spot (EDW today), t2/t3 (the EB apps). The account had no prior plans or RIs. It is the Organization's management account, so the plan may also apply to member accounts' t3a.
- **EB → ECS (part B) belongs to ED**, in the EduWeb Telegram group. Part A (EDW) stays with the orchestrator. Add a second plan for EDW's on-demand t3a once its size is chosen.
- **ED's brief** (operator asked): conversations/telegram/EduWeb-2610240312/desktop/migracion-ecs/BRIEF.md on EDW (Spanish; ED's box has rw).
  - Covers: decided (ECS on EC2, t3a, the plan); today's inventory; rules: egpt-edw resources off limits and production on its own capacity; measure memory first; per-container cpu/memory; one app at a time with DNS rollback; one ALB or one proxy; secrets in SSM/Secrets Manager; PHP 7.4 EOL; AWS access requested from An.
- **Started 10-25 ~16:10:** step 1 (benchmark, agent) and step 2 (slim image, agent, worktree egpt-wt-slimimage, feat/edw-slim-image; no push).

## 10-25 ~16:40 — SI+EduWeb (WhatsApp) brought up to date in ED, then silenced
- **Synced kg → ED** (one way: tar → private S3 bucket → EDW host; object deleted, sha256 checked). Every file in kg's whatsapp/SI+EduWeb-2610111618 changed since the 10-24 seed, minus __pycache__, .ssh and the Windows Chrome profile: 10,136 files, 191 MB compressed. Jaime's work with E on 10-24: desktop/rds-educomp-20261024*, rds-explain-20261024, acumular-20261024, mr-fechgrab/edw-web (a git clone, 285 MB), CONTEXTO.md; one video; the group transcript.
  - Mapping: transcript.md → transcripts/whatsapp/; media/* → media/whatsapp/; desktop/* → desktop/.
  - Rule: new → copied; identical → skipped; ED's copy untouched since the seed → replaced; else → .from-kg beside it.
  - Result: 10,133 new, 3 replaced (CONTEXTO.md, media index, transcript), 0 conflicts. Owner egpt; ED's box has rwx through the folder's default ACL.
  - The transcript has had no messages since 10-24 21:16, so no top-up was needed.
- **Silenced:** kRFlexa40IXSXTYb5AOA, every being of the node `mode: off` + `handles: []` (backups conversations.yaml.pre-si-off-20261025T203550).
  - kg: egpt, eplus, ken, codex, sh, h, llama, pi, wren, carol, cara, don.
  - do: don, den, dren, djh, pi.
  - Live: conversations.yaml is re-read when its stat changes (stat-cache).
  - Side groups not touched: on kg they are aliases of this entry; on do, nue11 and emely are entries of their own.
- **Pending:** the "moved to Telegram" notice (needs the invite link; operator posts it, or an explicit go to send it as Rodz); then tell ED to read the new material and the brief.
- **Operator 10-25:** "disable a group with a message" must be configurable from config.yaml. Building `closed_chats` (agent, worktree egpt-wt-closed, feat/closed-chats):
  - shape: closed_chats.<network>.<conversations.yaml id>.message;
  - through agentsInChat / the per-chat mode resolution (no parallel gate);
  - the notice is posted once through boot's sayOnce, with a marker in the chat's entry; a reminder to anyone who addresses a being, at most once a day; applies live.
  - SI+EduWeb: kg carries the message (link https://t.me/+eotN-hXG5qUyNDlh); do carries it closed without one. The notice goes out when this deploys.

## 10-25 ~18:00 — Whisper benchmark on t3a (step 1 done); DB reservations
- **Benchmark** (agent; 2 tagged on-demand instances, 78 min; ~$0.14 + ~$0.16 surplus CPU credits; all terminated, S3 empty).
  - Notes: Spanish 11.3 s and 56.8 s, English jfk 11 s; whisper-server -t 2.
  - Medium and large give identical speed: one physical EPYC 7571 core, 2 threads. Size decides memory only.

  | Model | Short es / long es (s) | Peak MB | Word difference vs large-v3 |
  |---|---|---|---|
  | large-v3 f16 | 381 / 809 | 3433 | reference |
  | large-v3-q5_0 | 210 / 648 | 1504 | 0–3.8 % |
  | turbo f16 | 317 / 954 | 1747 | 10–18 % |
  | turbo-q5_0 | 174 / 522 | 741 | 10–18 % |
  | small | 55 / 118 | 647 | 17–24 % |

  - whisper-server always encodes full 30 s windows. EDW's CLI path trims the window (audio_ctx auto), which helps short notes; not measured with large models.
  - `-t 1` is 1.39× slower.
  - **On t3a, every high-quality model takes minutes per note.**
- **DB reservations** (operator: "reservation in-kind for db compute", since all EduWeb/Portales compute needs a DB). Three db.t4g.medium single-AZ instances:
  - eduweb-2020-instance-1: Aurora PG 17.7, standard storage; CPU 11 % avg, 27 conns max.
  - portal-institutions: MariaDB; 4 %, 99 conns max.
  - educomp5-db: Postgres 18.3, created 10-14; 4 %, 2 conns max.
  - The Database Savings Plan (1-yr no upfront) covers no db.t4g rates (m7g/r7g yes), so RDS Reserved Instances are the option. 1-yr no upfront:

  | Engine | Reserved | On-demand | Saves per month |
  |---|---|---|---|
  | Aurora PG | $0.057/h | $0.073 | $11.68 |
  | PostgreSQL | $0.047/h | $0.065 | $13.14 |
  | MariaDB | $0.047/h | $0.065 | $13.14 |

  - Total $148.19 → $110.23/mo (−$37.96/mo); $1,322.76 committed over the year.
  - Size-flexible within db.t4g for the same engine. An engine change or a move to another family drops the reservation.

## 10-25 17:48 — closed_chats live; SI+EduWeb notice posted
- **b56eb318 / 3f6471ea** (merged, deployed to kg and do; suite 334 files / 7566 tests green, run by the orchestrator):
  - `closed_chats.<surface>.<chat id>: { message? }` in config.yaml;
  - the closed rung is the top of gating.resolveMode (the one mode ladder);
  - the notice goes through boot's sayOnce, marked as `closed: { notice, at }` in the chat's entry; a reminder to a line that names a being, at most once a day; applies live.
- **Config:**
  - kg: SI+EduWeb with the message + its 4 alias side groups (nue11, emely, mejoras-egpt, an) closed silently, as they had been quiet since 16:35 by inheritance.
  - do: SI+EduWeb closed silently; do's own nue11/emely entries untouched (open).
  - The hand-set mode/handles from 16:35 were removed, so the entries are back to their threads (backups *.pre-closed-20261025T2147*).
- **Posted 17:47:54** by Rodz (the mouth, in its own room LZmluLTTwWUiy5ORT9AB) with kg's node signature: "📢 Este grupo se mudó a Telegram: https://t.me/+eotN-hXG5qUyNDlh. …"
- **Follow-ups:**
  1. Heartbeats aren't gated by closed_chats (they skip gating; a one-line check in heartbeatSay or the loader needs a ruling). SI+EduWeb has no live beats on kg.
  2. The 👂 voice transcript and `/e` commands still work in a closed chat.
  3. do's side groups: close them too?
- **18:09 — every EduWeb group closed on kg and do, silently** (operator). WhatsApp: Eduweb (An, Rodz, E, Maria Isabel Maggio), Diego Pérez-inspect-eduweb, the 4 SI+EduWeb side groups (now on do too). Telegram, as Beeper saw them: EduWeb SI, three old SI+EduWeb, EduWeb. One-to-one chats with EduWeb people (Diego Pérez, Angélica Vivas, Jaime Fernández, Jaime Lepage, +52 1 999…) stay open. Backups config.yaml.pre-closed-more-20261025T2209*.
- **/join and /split on Telegram don't work:** the limb's createGroup is a stub (bots can't create groups), so the command logs and aborts and the user sees nothing. Options: forum topics in the group (a bot that is admin with manage-topics can create them), or a user-account group factory (MTProto api_id/api_hash; parked 10-24).
- **DB merge (operator: "two are running postgres, can't we merge?"):** yes. educomp5-db (RDS PG 18.3, ~idle) goes into the Aurora PG 17.7 cluster eduweb-2020 as its own database + role, then a final snapshot and delete. Saves ~$51/mo (instance $47.45 + 30 GB). Watch: a dump from 18 into 17 (test; edc5 is new, so little to check); Aurora peaks at 99 % CPU (db.t4g.large later; RIs are size-flexible). Then reserve 2: Aurora PG + MariaDB.
- Voice via dolly: rejected (operator).

## 10-25 ~18:40 — Transcribe test; DB merge in ED's brief; Telegram groups
- **AWS Transcribe batch, es-US**, the operator's own EduWeb notes (S3 objects and jobs deleted):
  - 4.5 s note → 8.3 s; 5.4 s → 9.7 s; 56.8 s → 10.6–11.1 s;
  - 16.8 % of 137 words differ from kg's large-v3 text (short notes too short to judge). That is the small model's level (17–24 %) at about kg's speed (median 7 s).
  - Before production: Organizations AI-services opt-out policy (persistent org setting; needs a go). Building it = a transcription backend type in fallback_order.
- **ED's brief** gained "Bases de datos": the merge (Aurora 17.7 → 18 first, then dump/restore 18 → 18), the load caveat, and 2 reservations after the merge.
  - Aurora PG 17.7 offers 18.3/18.4/18.6 as in-place major upgrades. An RI follows engine + class, not version.
- **Telegram:**
  - No t.me link creates a group (`t.me/<bot>?startgroup=…` only opens "add the bot to a group", where a person can create one).
  - Topics belong to one group: every member sees every topic; outsiders need the group's link.
  - Operator offered his own account as group maker. Caution: a user-API session for his whole account would live in EduWeb's AWS account, and API-created groups + direct member adds are the suspected cause of the 10-24 deletions. A dedicated account + invite links is safer.
