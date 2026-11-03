# Browser screens — one virtual screen per browser group, shared by link

Operator 11-02 (Node HQ / topic Ops, #96–#119): "make a structural command that when ran returns the
link"; "it has to be a structural command, no agentic run"; "can vnc close on browser/tab close? do
we even need a time limit?"; "if i type /n vnc in a group chat, many people can connect at once to the
same browser… collective browsing"; "yes, a screen per browser group"; "a profile per group, yes";
"only operator can drive by default with /n browser, /n browser all should let anyone drive".

## Why

Today a container node (nu, EDW) has ONE X screen, `:99`, with everything on it: both Beeper Desktops
(every WhatsApp chat), the eGPT Chromes, any sign-in window. x11vnc shares that whole screen with one
full-control password. A link posted in a group would show all of it, and let anyone drive it.

## Decisions

1. **A screen per browser group.** Each group in `config/browsers.yaml` (`brain`, `shared`, any named
   group) gets its own Xvfb display and its own x11vnc, started on first need. The group's Chrome, the
   eGPT one and the plain sign-in one alike, opens on THAT display (`DISPLAY=:<n>` in the launch env),
   never on `:99`. `:99` keeps Beeper and stays operator-only (today's `secrets/vnc.password`).
2. **A profile per group** — already true (plans/2610091931 rev 10-11). Unchanged: the screen follows
   the group, so what a group sees is exactly what that group is signed in to.
3. **The command is structural.** `/<handle> browser` is a spine command, like `/status`: no being turn,
   no model. It answers with the link itself.
4. **Who drives.**
   - `/<handle> browser` → the chat gets a **view-only** link (x11vnc `-viewpasswd`); the
     **control** link goes to the node's admin group (`admin_channel`), never into the chat. Typed in
     the admin group itself, both links land there.
   - `/<handle> browser all` → the chat gets the **control** link: anyone with it can drive.
   - `/<handle> browser stop` → closes this group's tunnel (the link) now; the browser stays.
   - `/<handle> browser close` → closes this group's browser: its Chrome (eGPT's or the sign-in one),
     its tunnel and its screen (operator #121). The next need starts them again.
   - Owners only (same gate as `/browser refresh`): the command hands out a password.
   - Passwords are per group and per OPENING: a fresh view and control password each time a tunnel
     opens, so an old link is dead even if the same tunnel URL ever came back.
5. **Lifetime: no time limit while watched.** The tunnel closes GRACE (120 s) after the last viewer of
   that screen disconnects, or IDLE (600 s) if nobody ever connects. "Viewer" = an established session
   on that screen's x11vnc port (not the noVNC/websockify port: cloudflared keeps HTTP keep-alives open
   there). Verified 11-02 with `~/.egpt/bin/vnc-link` on nu: 1 viewer with a real noVNC tab, tab
   closed, tunnel gone 15 s later (GRACE=15 for the test).
6. **The link.** A Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:<novnc port>`,
   no account, random `*.trycloudflare.com`) to the group's noVNC, as
   `<url>/vnc.html?autoconnect=1&resize=scale&view_only=<0|1>&password=<pw>`. One tunnel per group;
   asking again while it is open returns the same link. The binary lives in `~/.egpt/bin/cloudflared`
   (data volume, survives restarts); fetched on first use if missing.
7. **Which Chrome shows.** The group's screen shows whatever Chrome holds the group's profile: the eGPT
   (pipe) Chrome when a being is using it — so the group watches the being browse, and with `all`
   browses with it — or the plain window `/browser refresh` opens for a sign-in (Google refuses the
   pipe Chrome). `/browser refresh` now opens on the group's screen and its answer carries the link
   instead of "Open VNC (:6080)".
8. **By node, not by being.** The node that hosts the being runs the command (MANUAL §1), so the handle
   picks the node: `/n browser` runs on nu, `/e browser` on kg/do.
   - **Container node (Linux, no physical desktop):** everything above.
   - **Desktop node (Windows kg/do):** the group's Chrome opens as a normal window on the PC's own
     desktop and the answer says so — you are at that PC. No virtual screen, no tunnel: a Windows VNC
     server shares the WHOLE desktop, the exact exposure decision 1 removes. Phase 2 if wanted.

## Build

1. `src/tools/browser-screens.mjs` (new): per group, allocate a display number (`:100`+, kept in
   `state/browser-screens.json` so a group keeps its number), start Xvfb + x11vnc (`-rfbauth` +
   `-viewpasswd`, `-shared -forever`, localhost only) + websockify on its own port; report viewers;
   a screen stays up until `/browser close` (operator #121: "don't close anything automatically").
2. Chrome launch env: `chromeHost.launch*` take `display`; chrome-pool passes the group's.
3. `src/tools/screen-tunnel.mjs` (new): open/reuse/close the cloudflared quick tunnel per group, read
   the URL from its log, wait for `vnc.html` = 200, the GRACE/IDLE watcher. The shell prototype is
   `~/.egpt/bin/vnc-link` on nu.
4. `commands.mjs`: `browser` (bare), `browser all`, `browser stop` beside `browser refresh`; control
   link to `admin_channel`; refresh answers with the group's link.
5. Tests: display allocation is stable per group; view vs control link routing (chat / admin group /
   typed in the admin group); `all`; GRACE/IDLE closing with an injected viewer count; a desktop node
   answers "opened on this PC" and starts nothing.
6. MANUAL §1 rows + `/browser refresh` paragraph; docker/aws/README VNC section (`:99` stays the
   operator's Beeper screen).

## Limits / open

- **Memory (nu, t3a.small, 1.9 GB, ~0.6 GB free 11-02):** an Xvfb + x11vnc is tens of MB; a Chrome is
  150–300 MB. Operator #121: "we'll see about the memory, don't close anything automatically, let's see
  how ECS handles it" — this change adds NO memory-driven closing (screens, tunnels with viewers,
  Chromes). Only the tunnel's viewer-based GRACE/IDLE close stays (decision 5). chrome-pool's existing
  admission (`chrome.memory_margin_mb`, evicts the idlest non-brain group Chrome) is untouched here.
- **Android Chrome** drops the websocket when it sits long in the background; past GRACE the tunnel
  closes and you ask again.
- **Admin channel on nu = topic "eGPT Admin" in "Node HQ", tg:-1000000000104/124** (operator #121/#123;
  a bot cannot make groups, so N made it a topic 11-02 23:15). NOT the WhatsApp "eGPT Admin" nu also
  sees: name it by id, not by name. `admin_channel` today is a chat NAME or a Beeper room id resolved by
  the bridge — check it resolves a `tg:` id, else teach it to. Unset → `/n browser`
  refuses the view-only form and says why.
- Same change (operator #110): an immediate ack in mode `on` — a reaction on the message when the turn
  starts, removed when it ends. Telegram bots react only from a fixed emoji list; check whether ⏳ is on
  it, else 👀/✍. Separate commit.
