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
