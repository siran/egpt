// config-schema.mjs — the registered TOP-LEVEL keys of an egpt v2 config.
//
// WHAT THIS IS
//   Documentation. CONFIG_SCHEMA maps every top-level key a v2 config may set —
//   the config is YAML, at EGPT_HOME/config/config.yaml (src/spine/boot.mjs
//   CONFIG_FILE, src/tools/config-io.mjs CONFIG_YAML_PATH) — to a prose
//   description of what that key does.
//
// WHAT READS IT
//   Nothing at runtime. No file under src/ imports CONFIG_SCHEMA, and no command
//   renders these strings to an operator; the values exist for the human reading
//   this file. The KEY SET is what is enforced, by exactly two tests, and both
//   assert key PRESENCE only — never the value:
//     - tests/integrity.test.mjs — scans src/spine/*.mjs for cfg.<key> and
//       getConfig().<key> reads and fails if the v2 spine reads a top-level key
//       that is not registered here.
//     - tests/skeletons.test.mjs — fails if config/skeletons/config.yaml sets a
//       top-level key that is not registered here.
//   So: when the spine starts reading a new top-level key, register it here too.
//
// SHAPE
//   One multi-line template literal per key: a summary, then labelled blocks
//   (DEFAULT / ENUM / SHAPE / KEYS / BACK-COMPAT / TRAP / HISTORY / NOTE) and
//   indented sub-key bodies for nested blocks. Long, not wide, so the file stays
//   diffable and greppable — operator 2026-07-25: "i've been way long thinking
//   that config schema needs to be long rather than wide. easy to read,
//   structured yaml or whatever... it seems like a long line difficult to read".
//
// OUT OF SCOPE
//   Sub-keys of a nested block are documented inside that block's entry, not
//   registered as top-level keys of their own.

export const CONFIG_SCHEMA = {
  theme: `
    Color theme name (see /themes).
  `,

  show_prompts: `
    Show the full operator prompt before each turn.
      ENUM: true | false
  `,

  unix_paths: `
    Display filesystem paths in POSIX style.
      ENUM: true | false
  `,

  tz_label: `
    Short timezone label shown next to timestamps (e.g. NYC, MAD, BEI).
      DEFAULT: the system short tz
  `,

  user_name: `
    Handle for the human typing here, shown in cross-surface mirroring as
    <user_name>@<surface>.
      DEFAULT: "egptbot"
    Override via this config key, the EGPT_USER_NAME env var, or a per-bridge
    node_name in the telegram / whatsapp blocks.
  `,

  node_name: `
    Name this node uses on the bus (e.g. home, chr1).
    Takes effect on the next shell restart.
  `,

  node_alias: `
    Additional mesh identities this ONE node also answers to — a LIST, e.g.
    ["do","mo"]. Lets one process host several node identities.
    Takes effect on the next shell restart.

    SELF-SET (operator 2026-07-05): node_name ∪ node_alias is the node's
    SELF-set. An inbound relay envelope, or a fully-qualified @being.<name>,
    whose <name> is ANY self-name is handled LOCALLY — dispatched to the local
    being, never forwarded to ourselves — and the responder stamps the identity
    it was ADDRESSED AS (by: <being>.<self-name>; default node_name for an
    open-channel request).

    SELF-ECHO LIMIT: a node cannot relay to ITSELF across a real chat — the
    bridge suppresses a node re-seeing its own sends (src/bridges/beeper.mjs
    wasSentByUs, by the ids it sent). Genuine multi-hop transit between separate
    rooms therefore still needs distinct nodes/accounts; node_alias only
    collapses the LOCAL answering, not a real-room self-hop.
  `,

  heartbeat: `
    Supervisor liveness config.

    KEYS:
      interval_ms
        DEFAULT: 60000
        How often the daemon writes a tic/toc beat to state/alive.txt.
      stale_seconds
        DEFAULT: 90
        The watchdog kills + respawns the daemon if the newest beat is older
        than this. Should be a few × interval_ms/1000 for margin.
  `,

  heartbeats: `
    Declarative heartbeat registry (operator 2026-07-01; the v2 spine,
    src/spine/heartbeat-loader.mjs) — a map of <name> -> { frequency, command }.

    ENTRY FIELDS:
      frequency
        ms (number) or a "<qty><unit>" string (ms/s/m/h, integer or decimal:
        "500ms", "1s", "30s", "5m", "1.5h"). An unparseable frequency skips the
        entry (logged, never fatal).
      command
        A SHELL line spawned on each due tick.
          cwd = the checkout for node-level beats (the entity folder for entity
                beats)
          env = inherit + EGPT_HOME + EGPT_QUEUE_DEPTH / EGPT_QUEUE_OLDEST_MS
                from the pump
        A still-running previous spawn skips the tick (overlap guard); a
        non-zero exit only logs.
        A command can run any script — e.g. a TEXTECUTABLE, a plain-text *.x.md
        script AI executes:
          daily: { frequency: 24h,
                   command: node src/tools/textecute.mjs reports/daily.x.md }
        runs a plain-text script on cadence (the overlap guard covers a long
        browser run).

    TRIGGER (operator 2026-07-02):
      An entry may use  when: <M/D/YYYY H:MMa | 24h | ISO>  INSTEAD of
      frequency: — a ONE-SHOT that fires once at/after that wall-clock time then
      never again. Timezone from default_time_zone, else machine local. Both
      frequency + when set → invalid, skipped.

    ACTION:
      ai_run: <script.x.md>  may replace  command:  — sugar the loader expands
      to  node <src/tools/textecute.mjs> <script>  to run a TEXTECUTABLE. Both
      command + ai_run set → invalid, skipped.

    THE DEFAULT BEAT is alive:
      When this block declares no alive, the spine injects one at boot's aliveMs
      (DEFAULT 60000) as  command: echo beat > state/alive.txt  — run with
      cwd = the profile, so the relative state/ resolves there. A plain shell
      one-liner: no hidden builtin, and the exact command is visible in
      state/heartbeats.readonly.yaml.
      LIVENESS IS THE FILE MTIME: any command that writes state/alive.txt is a
      valid beat, and the written content is freeform (for humans) — the daemon
      deadman only reads the file's mtime.
      The long-lived spine pid the second-daemon guard needs lives in
      state/spine.pid (written once at boot), no longer in the beat.
      A declared alive WINS entirely: its frequency applies and, if it sets
      command:, that REPLACES the default alive command.
      alive: false DISABLES the deadman — documented consequence: the supervisor
      respawn-loops with escalating backoff until the beat is restored
      (src/daemon-runtime.mjs wedge path).

    ENTITY BEATS:
      Beyond the node block, every conversation
      (conversations/<surface>/<slug>/config.yaml) and room
      (rooms/<name>/config.yaml) may carry its own heartbeats: block. Entity
      beats are namespaced <surface>/<slug>:<name> and room/<name>:<name> so
      they cannot collide.

    RESOLVED SET:
      At boot the spine materializes the full resolved set to
      state/heartbeats.readonly.yaml (a spine-written snapshot: edit
      config.yaml / the entity config.yaml and /restart, do not edit the
      readonly file). The tick auto-tightens to the finest cadence, floored at
      500ms.
      HOT RELOAD: delete state/heartbeats.readonly.yaml and the spine re-reads
      every heartbeat within ~30s — no restart, and new chat folders / edited
      entity config.yaml are picked up.

    Paste-ready templates live in config/skeletons/ (script.x.md,
    heartbeats.yaml).
  `,

  default_time_zone: `
    IANA time zone used to interpret timezone-less heartbeat  when:  times
    (src/spine/heartbeat-loader.mjs, operator 2026-07-02).

    VALUE: canonically an IANA zone name (preferred: "America/New_York";
    validated via Intl).

    ALIASES (case-insensitive) also accepted:
      "New York"              → America/New_York
      "ET" / "EST" / "EDT"    → America/New_York
      "CT" / "CST" / "CDT"    → America/Chicago
      "MT" / "MST" / "MDT"    → America/Denver
      "PT" / "PST" / "PDT"    → America/Los_Angeles
      "UTC" / "GMT"           → UTC

    DEFAULT: invalid or absent → the machine's local zone (an invalid value is
    logged).

    DST is handled correctly: a July time resolves at the summer offset, a
    January time at the winter offset.
  `,

  local_llm: `
    Local llama.cpp server the daemon spawns + keeps alive for @l.

    KEYS:
      enabled
        DEFAULT: on when the block is present; false to disable.
      bin
        Path to llama-server.exe.
      cwd
        DEFAULT: the bin dir, so the exe finds its sibling DLLs.
      model_path
        GGUF.
      port
        DEFAULT: 11434 — must match siblings.l.url.
      threads
        DEFAULT: 8
      extra_args
        Array, e.g. ["-c","16384","--jinja","--reasoning","off"].
      agentic
        DEFAULT: false
        When true, @l runs the ReAct TOOL loop (src/tools/agent-loop.mjs)
        instead of a plain chat turn: it can call the permission-gated agent
        tools to actually do things. Requires --jinja for tool-calling. Tools
        are gated by the top-level tools config + /e tool. OFF keeps @l a pure
        chatter.
      agentic_max_iters
        DEFAULT: 8 — ReAct step cap, the runaway bound.

    Only the headless daemon supervises it (interactive shells skip, to avoid a
    duplicate fighting for the port); respawns on exit with backoff.
  `,

  telegram: `
    Telegram SURFACE authorization block (operator 2026-07-02 — per-surface
    auth, peer of whatsapp / signal).

    KEYS:
      chat_id
        Your Self-DM room on Telegram, the operator command channel.
        Auto-captured on first contact.
      allowed_users
        STABLE sender ids that may command this node ON TELEGRAM — a network
        jid / Beeper room id, NEVER a display name, since a chat title is
        attacker-controllable.
        EMPTY = deny (fail-closed). The account owner (isSender) is always
        authorized regardless.

    Ids are per-surface NAMESPACES — a WhatsApp jid authorizes NOTHING here.

    SHORT FORM (operator 2026-07-03): a Beeper room id here is written WITHOUT
    the Matrix decoration — no leading "!", no trailing ":beeper.local" (e.g.
    "yz3kJjWXsQJofK9naaVb", not "!yz3kJjWXsQJofK9naaVb:beeper.local"). egpt
    expands to the full form only at the Beeper API boundary
    (src/bridges/chat-id.mjs).

    HISTORY: the direct Telegram-bot transport was REMOVED 2026-06-24 (there is
    ONE channel, Beeper; telegram connected in Beeper arrives as
    network=telegram) — so this is no longer the old vestigial "do-not-add"
    block, it is now the telegram auth surface. whatsapp remains the
    TRANSPORT-config home (networks, media, client_name, …); this block
    carries only chat_id + allowed_users.
  `,

  signal: `
    Signal SURFACE authorization block (operator 2026-07-02 — per-surface auth,
    peer of whatsapp / telegram).

    KEYS:
      chat_id
        Your Self-DM room on Signal, the operator command channel.
        Auto-captured on first contact.
      allowed_users
        STABLE sender ids that may command this node ON SIGNAL — a network jid /
        Beeper room id, NEVER a display name.
        EMPTY = deny (fail-closed). The account owner (isSender) is always
        authorized regardless.

    Ids are per-surface NAMESPACES — a WhatsApp/Telegram id authorizes NOTHING
    here.

    SHORT FORM (operator 2026-07-03): same as telegram — a Beeper room id is
    written without the "!" / ":beeper.local" decoration.

    whatsapp remains the TRANSPORT-config home (networks, media, …); this
    block carries only chat_id + allowed_users.
  `,

  dispatch: `
    E-routing globals — OUT of the whatsapp transport block (E is a sibling, not
    a network; operator 2026-06-25).

    KEYS:
      auto_paused
        Boolean. DEFAULT: false
        The absolute @e-emit kill-switch, toggled by /e auto pause|resume.
        Layered OVER the per-conversation mode gate.
      auto_default_mode
        ENUM: "on" | "mute" | "mention-direct" | "mention" | "off"
        DEFAULT: "mention"
        The NODE-WIDE default reply mode: the persona's mode in any chat that
        sets none, and the last rung under the per-agent agents.<name>.mode
        (operator 2026-07-25). Set via /e auto <mode> all.
      send_to_egpt
        ENUM: "always" | "mode"
        DEFAULT: "mode"
        The GLOBAL send_to_egpt default: whether the persona stays in a chat's
        context even when it will not reply. A per-conversation override still
        lives in conversations.yaml
        (contacts.<surface>[<id>].<being>.send_to_egpt) and WINS over this
        global.

    Per-chat modes live in each conversation entry
    (contacts.<surface>[<id>].mode, via /e auto <mode> <chat>).

    BACK-COMPAT: each of these three reads falls back to its legacy home in the
    whatsapp block — so an un-migrated config is unchanged (src/spine/gating.mjs):
      auto_paused        <- whatsapp.auto_e_paused
      auto_default_mode  <- whatsapp.auto_e_default
      send_to_egpt       <- whatsapp.send_to_egpt
  `,
  whatsapp: `
    Beeper-transport bridge config — network-agnostic; the "whatsapp" name is
    legacy. A nested object; the bridge starts when this block is present (and
    not enabled:false).

    TRANSPORT: "beeper" is the ONLY transport — it rides the Beeper Desktop
    login and needs beeper_token. baileys was REMOVED 2026-06-10 ("remove
    baileys completely"); the CDP WhatsApp-Web transport was REMOVED 2026-06-21
    — no QR pairing and no in-Chrome WA-Web limb exist anymore.

    AUTHORIZATION: chat_id / auto_e_chats are AUTHORIZATION lists. Entries MUST
    be stable chat ids (a Beeper room id in SHORT form 'xxx' — no '!' /
    ':beeper.local', operator 2026-07-03 — or a WA jid), NEVER display names
    (operator 2026-06-10: a chat title is attacker-controllable). Deterministic
    contact NAMES are for conversation storage + outbound addressing only. Under
    beeper, the room id appears in the incoming line of ~/.egpt/logs/beeper.log;
    copy it into the list.

    KEYS:
      allowed_users
      chat_id
        Auto-captured.
      networks
        DEFAULT: [] = process EVERY network Beeper bridges —
        signal/telegram/whatsapp/…, the firehose. Network is metadata, not a
        gate; set ["whatsapp", ...] to restrict scope.
      enabled
        DEPRECATED 2026-06-25 — the transport is on iff a beeper_token is
        present. enabled:false is still honored as an explicit off.
      mirror_chat_id
        DEFAULT: self-DM
      awareness
        {...}
      client_name
        DEFAULT: "wa" — appears in handle@client tags.
      max_backlog_seconds
        DEFAULT: 5 — grace window in seconds; messages older than N seconds
        before bridge connect are HELD and reviewed via /wa-pending.
          0  = strict hold
          -1 = disable hold (legacy auto-dispatch)
      egpt_chats
        JIDs treated as full-mirror egpt chats; the self-DM is always one.
      auto_e_chats
        LEGACY write-whitelist only (bridge-bypass + busy-queue gate).
        Per-chat E modes + residents MIGRATED 2026-06-24 into each
        conversation's config.yaml: contacts.whatsapp[<jid>].mode (set via
        /e auto <mode> <chat>) plus the Room members[] store (set via
        /e residents). The global default + pause MOVED 2026-06-25 to
        dispatch.auto_default_mode / dispatch.auto_paused
        (/e auto <mode> all | pause | resume).
      e_commands
        Command names conversation-e may EXECUTE when it emits an own-line slash
        command in a reply.
        DEFAULT: ["react"]
        An allowlist gate: the resident output is model-generated and it reads
        chat-partner messages, so a crafted message could try to coax a command
        out of it. Known-but-unlisted commands are stripped + logged, never run,
        never leaked to the chat. Allowed commands run in the triggering message
        chat context via the same handleSlash pipeline (e.g. /react heart reacts
        to the message the resident is replying to). Managed via
        /e cmd allow|deny|status.
      resident_chain_cap
        DEFAULT: 10 — max hops a resident reply re-circulates to the OTHER
        residents before it stops being re-fed (it still posts to chat + Self).
        Residents see replies from the other residents as
        [being@chat (HH:MM)]: body  envelopes and may answer; this caps the
        ping-pong so two brains cannot converse forever. Only
        broadcast-originated turns re-circulate. A silence reply forwards only
        ONCE — the initial dots answering real content (the other being may get
        curious and ask) — but dots answering dots are received-and-shown yet
        NOT re-fed, so mutual shrugging cannot burn the chain on empty turns.
      resident_history_chars
        DEFAULT: 30000 — per-chat rolling transcript budget for SESSIONLESS
        residents like @l. @l has no server-side session like @e, so the host
        accumulates the chat envelope lines (human messages + every brain reply)
        and feeds the joined transcript as the prompt history each turn,
        mimicking @e session memory; oldest lines roll off past this many chars
        to stay within llama context. Bounded memory per chat.
      at_e_anywhere
        Boolean. DEFAULT: true
        When true, "@e" or "@egpt" appearing ANYWHERE in a WA message body is
        rewritten to a leading "@e " prefix before the host sees it, so the
        message routes to @e even when the mention is not at the start of the
        line. Without this, mid-sentence wake-words bypass awareness but fall
        through to plain-text routing. Set false to require @e at start, the
        legacy behavior.
      edit_cadence_ms
        DEFAULT: 2500 — min ms between persona stream-message edits during a
        streaming reply. WA rate-limits edits at ~1/2s sustained, so going below
        2000 risks rejected edits and silent stream stalls. Set higher for fewer
        edits per reply, lower at your own risk.
      typing_refresh_ms
        DEFAULT: 8000 — how often to re-emit the "composing" presence while a
        persona stream is open. WA times the indicator out around 15s without
        refresh; 8000 keeps it alive without spam.
      send_timeout_ms
        DEFAULT: 12000 — _timeBound wrapper around every sock.sendMessage so a
        flapping WS does not block the bridge. Catches stalls without aborting
        normal sends; lower means faster surfacing of WS hangs at the cost of
        false-positive aborts on slow networks.
      chunk_chars
        DEFAULT: 4000 — max chars per outbound text body; long replies split
        into multiple messages. WA protobuf supports ~65k but baileys / WA Web
        misbehave above ~5k; 4000 is the safe ceiling matching the TG chunk
        size.
      mirror_headers
        ENUM: "all" (DEFAULT) | "brain_only" (only persona/session items carry
        headers) | "none"
      follow_join
        ENUM: "never" (DEFAULT) | "from_shell" (adopt wa-join announces from a
        shell peer) | "always" (adopt from any peer)
      media
        download
          ENUM: "all" (DEFAULT — save every media type to
          ~/.egpt/media/<chatJid>/<msgId>.<ext>) | "images_docs" (only images +
          documents) | "off" (disable)
        max_size_mb
          DEFAULT: 25 — skip downloads larger than this.
        notify
          ENUM: "on" (DEFAULT — sysOut a 📎 line per save, but silence
          status@broadcast, which is high-volume) | "all" (notify for status
          too) | "off" (silent)
        summarize
          operator
            DEFAULT: null | a session-name like "cgpt1" — auto-run the operator
            on each downloaded image/document and save a .summary.md alongside.
            PENDING: operator wiring not built yet, leave null for now.
          types
            DEFAULT: ["image","document"]
        audio_transcribe
          enabled
            DEFAULT: false — when true, every saved audio gets a
            <base>.transcript.txt sidecar via whisper.cpp.
          command
            Path to the whisper.cpp binary — main.exe / whisper-cli.exe /
            whisper-cli depending on build/platform.
            DEFAULT: whisper-cli, assuming PATH.
          ffmpeg_command
            Path to the ffmpeg binary.
            DEFAULT: ffmpeg, assuming PATH — set an absolute path on Windows
            when ffmpeg lives outside PATH.
          model_path
            REQUIRED when enabled — absolute path to a GGML model file from
            huggingface.co/ggerganov/whisper.cpp/tree/main. ggml-medium.bin is a
            good Spanish-quality / speed balance, ggml-large-v3.bin is highest
            quality.
          language
            Optional ISO 639-1 hint, e.g. es for Spanish — when set, whisper
            skips its language detection pass, which is faster + more accurate
            for known-language chats.
          animation
            ENUM: "bar" (DEFAULT — the voice-note ack shows a determinate
            transcription progress bar driven by the whisper-server stderr
            progress callback: the ACTUAL decode percent, no simulation. It sits
            at 0% until whisper emits its first reading, then fills to the real
            percent, re-edited only when the percent actually changes, dropping
            to the transcript on done) | "emoji" (legacy hourglass/ear cycle)
          animation_ms
            Frame cadence. DEFAULT: 1500 for bar, 4800 for emoji.
          Requires ffmpeg in PATH for opus/m4a/mp3 → 16kHz mono WAV conversion
          (winget install Gyan.FFmpeg / brew install ffmpeg /
          apt install ffmpeg).
  `,

  beeper_token: `
    Beeper Desktop API access token (transport: whatsapp.transport "beeper").

    READ FROM: this top-level key, whatsapp.beeper_token, or the
    BEEPER_ACCESS_TOKEN env var.

    Keep it in config.local.json, NOT config.yaml, so it never lands in a
    shared/checked-in config. Create one in Beeper Desktop → Settings →
    Developer → Desktop API.

    NOTE (transport=beeper): auto_e_chats / chat_id entries must match the Beeper
    chatIDs the limb sees, in SHORT form (no "!" / ":beeper.local", operator
    2026-07-03) — the 👂-suppressed log line in ~/.egpt/logs/beeper.log prints
    the id to enroll.
  `,

  beeper: `
    Beeper accounts block (operator 2026-07-09).

    SHAPE:
      use: <name>
        Which account below this node connects with.
      <name>:
        account   label — the Beeper address this token belongs to
        token     that account's Desktop API token

    The node's ACTIVE token = beeper[beeper.use].token — switch accounts by
    changing use, no re-typing tokens. This REPLACES the top-level beeper_token.

    BACK-COMPAT: with no beeper: block (or no use), the bridge falls back to the
    top-level beeper_token key, then the BEEPER_ACCESS_TOKEN env var (unchanged).

    Keep tokens in config.local.json, never a shared config. Create a token in
    Beeper Desktop > Settings > Developer > Desktop API.
  `,

  account_peers: `
    Node identities sharing THIS Beeper account, INCLUDING self (operator
    2026-07-09) — a LIST of node names, e.g. [kg, do]. Co-account nodes collapse
    to ONE Beeper room member, so this completes the HRW candidate set the 👂
    echo rotation will use (a LATER phase consumes it; for now it is parsed +
    exposed only, NO behavior). Omit for a solo node.

    TRAP ⚠️ — THESE NAMES ARE RESERVED AS COMMAND TARGETS (2026-07-25):
      /status <name> and /chrome <name> address a NODE, and a node not addressed
      replies NOTHING — so a conversation SLUG equal to one of these names is
      unreachable by fragment, SILENTLY (the addressed node answers with node
      health; this one says nothing). Rename the slug, not the node.
      A collision with THIS node's own name is merely shadowed by a visible
      reply; a collision with a PEER's name is total silence, which is the
      harder failure to attribute.
  `,

  networks: `
    Per-surface config wrapper (operator 2026-07-09).

    SHAPE:
      whatsapp | telegram | signal:
        chat_ids
          STABLE command-channel ids — chats that accept /egpt, /restart, … ; a
          LIST; a node may own several.
        allowed_users
          STABLE sender ids that may command this node on THIS surface — jids /
          Beeper room ids, NEVER display names.
          [] = deny (fail-closed). The account owner is always allowed.

    Ids are per-surface NAMESPACES (a WhatsApp jid authorizes nothing on
    Telegram). ONE resolver reads this.

    BACK-COMPAT: the OLD top-level whatsapp: / telegram: / signal: blocks plus a
    SINGULAR chat_id are still accepted (a singular chat_id normalizes to a
    1-element chat_ids). Prefer networks: when present.
  `,

  echo: `
    Does THIS node post the 👂 transcript echo — operator
    2026-07-09.
      DEFAULT: true — posts a voice note's transcript back into the chat.
      false — transcribes + LOGS the note but NEVER posts the 👂.

    An interim per-node boolean (it repurposes the old transcribe_ack gate); a
    LATER phase rotates the echoer across co-account nodes via HRW (see
    echo_timeout_ms).

    NET: a node posts the 👂 iff echo is true AND the note is younger than
    echo_max_age_ms.
  `,

  echo_priority: `
    LEGACY back-compat for the 👂-echo candidate set — SUPERSEDED by
    transcription_service.echo.peer_priority (operator 2026-07-24, HRW revival).

    A LIST of node names, e.g. [do, kg]. Still READ as a fallback when
    transcription_service.echo.peer_priority is absent, so a not-yet-migrated
    config keeps booting through the deploy→migrate window; new configs put the
    list under transcription_service.echo.peer_priority.

    The winner is now picked PER NOTE by HRW keyed on the note's audio-byte
    sha256 (node-stable), NOT by a fixed list position — but the list order
    remains the HRW hash-collision tiebreak (earlier = higher).

    A node that echoes MUST appear in the resolved set or boot is FATAL (this
    kills the silent-divergence class).

    FALLBACK CHAIN: this key → account_peers → [node_name] (a solo node is
    always rank 1). echo:false opts this node out entirely.
  `,

  echo_timeout_ms: `
    LEGACY back-compat for the 👂-echo ordered-failover step — SUPERSEDED by
    transcription_service.echo.timeout_ms (operator 2026-07-24). Still READ as a
    fallback when transcription_service.echo.timeout_ms is absent.

    A lower-ranked co-account node posts a voice note's 👂 only if the higher
    ranks stay SILENT, waiting (rank-1)*timeout_ms first (rank-2 at 1×, rank-3
    at 2×, …) and standing down the instant it observes the note's 👂 from a
    higher rank. Covers an OFFLINE/silent picked node without dropping the echo
    — still exactly one poster, ordered.

      DEFAULT: 20000 — GENEROUS on purpose: a waiter cannot tell "rank-1 DOWN"
      from "rank-1 SLOW", so too-short pre-empts a merely-slow winner → DOUBLE
      👂; too-long = slow failover.
  `,

  echo_max_age_ms: `
    Never echo a voice note whose OWN timestamp is older than this (operator
    2026-07-09, Zohykar incident; renamed from the old
    network.transcribe_ack_max_age_ms).

    A Beeper resync can re-deliver ancient backlog notes, and the 👂 is a
    live-conversation courtesy, not an archaeology announcement.

      DEFAULT: 3600000 (1h)
      0 or negative = no bound

    The note is still transcribed + logged; only the in-chat 👂 is suppressed.
    A note with no parseable timestamp echoes normally (fail-open).
  `,

  echo_coverage_similarity: `
    Coverage threshold 0..1 for the content-similarity echo check (operator
    2026-07-12).

    Before this node posts a voice note's 👂, it queries the chat for replies to
    that note and compares their transcripts to this node's OWN transcription by
    normalized word-token overlap. A reply whose tokens overlap this node's
    transcription by >= this fraction counts the note as already-covered, so this
    node does NOT echo (and a pending failover promotion re-checks at fire time
    and stands down).

      DEFAULT: 0.6

    Same-model transcripts are near-identical; this is lenient enough for minor
    drift (a duration prefix, an emoji, a mis-heard tail).

    This ON-DEMAND query replaced the in-memory observed-set + arrival-lag/
    reconnect scaffold: the chat is the source of truth, so coverage is seen in
    any delivery order with no marker in the decision.
  `,

  transcription: `
    Transcription config block.

    KEYS:
      enabled
        Global on/off. DEFAULT: on. Also gated per-conversation.
      mode
        The ENGINE.
        ENUM: "whisper-server" | "whisper-cli"
        DEFAULT: inferred — server.endpoint + token present ⇒ whisper-server,
        else whisper-cli.
        whisper-server POSTs each note to server.endpoint; ANY failure/timeout
        falls back to whisper-cli, so a dead server only costs speed.
        whisper-cli spawns the binary per note.
      posts_back_delay_ms
        How long to HOLD a voice note's 👂 transcript before posting — the
        transcript reaches the model INSTANTLY, only the in-chat echo is
        delayed. Each note is INDEPENDENT, posted as a reply to itself this many
        ms after IT was recorded, never coalesced.
          0 = immediate (recommended — with per-note keys there is no burst to
              coalesce, and a long hold can drop the echo on a restart)
        PER-CONVERSATION OVERRIDE (operator 2026-07-16): a conversation may set
        posts_back_delay_ms on its OWN conversations.yaml record
        (contacts.<surface>[<id>].posts_back_delay_ms, sibling of mode) to
        override this global for that chat only:
          unset/null       = this global
          -1 (any negative) = NEVER echo the 👂 (still HEARD: the model +
                              transcript.md get it, it is just not SPOKEN)
          0                = immediate
          N                = N ms debounce
        The conversations.yaml value WINS for that conversation and REPLACES the
        folder-config.yaml posts_back approach for conversations (rooms keep the
        folder config.yaml).
      server
        The endpoint engine — a remote worker e.g. DOLLY, or a resident server.
          endpoint   URL, e.g. "http://192.168.1.50:23390"
          token      shared HMAC-SHA256 secret, SAME on both machines;
                     unsigned/stale >60s rejected
      cli
        The whisper-cli engine + universal fallback.
          command          whisper-cli path
          model_path       REQUIRED
          language         ISO 639-1, e.g. es
          ffmpeg_command   ffmpeg path
          threads
          server           {...resident whisper-server, worker-role
                           optimization...}

    MIGRATION READ-FALLBACKS:
      mode              <- endpoint presence
      server.endpoint   <- transcription.endpoint / transcription_endpoint
      server.token      <- transcription.token / transcription_token
      cli               <- transcription.whisper /
                           whatsapp.media.audio_transcribe
  `,

  transcription_service: `
    Declarative per-note transcription fallback
    (docs/TRANSCRIPTION-SERVICE-PLAN.md; supersedes the transcription.mode
    shape).

    KEYS:
      enabled
        Global on/off. DEFAULT: on. Overridable per-conversation.
      use_config
        Name of the active profile — THE one line that differs REVE vs DOLLY on
        a mirrored config.yaml.
      <profile-name>
        fallback_order
          [<engine-name>...] — tried per note in order, first transcript wins.
        <engine-name>
          type: "whisper-server-remote"
            POST to endpoint + token (HMAC).
              connect_timeout_ms  liveness probe — fail fast if the endpoint is
                                  down. DEFAULT: 3000
              timeout_ms          DECODE budget — a working server legitimately
                                  takes seconds on a long note.
                                  DEFAULT: 120000
              cooldown_ms         circuit-breaker — a failed/unreachable remote
                                  is SKIPPED until it elapses. DEFAULT: 30000
          type: "whisper-server-local"
            Resident whisper.cpp server: command, model, host, port, language,
            extra_args, anti_repetition. LAZY-spawned the first time it is
            reached; cli covers the warm-up.
          type: "whisper-cli"
            command, model_path, language, ffmpeg_command, threads — the
            always-available floor.

    A change of WINNING engine posts one ⚠️/✅ to the operator Self DM
    (transition-only, never per note).

    Absent → a profile is synthesized from the legacy
    transcription.{mode,server,cli}, so an un-migrated node is unchanged.

    WINNER-SELECTION (operator 2026-07-24): a nested echo block decides WHICH
    co-account spine posts a voice note's 👂 transcript when two spines share
    ONE Beeper account (else BOTH post → double-👂).
      echo:
        method
          hrw — the ONLY method implemented. A foreign value warns at boot and
          falls back to hrw (behavior does not branch on it yet).
        participants
          Descriptive only, e.g. group-members.
        peer_priority
          [do, kg] — the HRW candidate set AND the hash-collision tiebreak
          order. Write it IDENTICALLY in both co-account configs.
        timeout_ms
          Ordered-failover step. DEFAULT: 20000

    HRW (rendezvous hashing) picks the poster PER NOTE keyed on the sha256 of the
    DOWNLOADED AUDIO BYTES — byte-identical on both nodes (same Beeper
    attachment), so both nodes compute the SAME ordering and AGREE on the winner.
    This is the node-stable key that makes the revival safe: the removed HRW was
    keyed on the note's Beeper message id, which is NODE-LOCAL, so the two nodes
    diverged (~1/4 double-👂).

    Rank 1 posts now; a lower rank arms a promotion at (rank-1)*timeout_ms that
    stands down if the note is already covered — exactly one poster, ordered
    failover. A node that echoes MUST appear in peer_priority or boot is FATAL
    (kills the silent-divergence class).

    BACK-COMPAT:
      peer_priority  <- legacy top-level echo_priority → account_peers →
                        [node_name] (solo node = rank 1)
      timeout_ms     <- legacy echo_timeout_ms → 20000
    The top-level echo:false opts a node out entirely (transcribed + logged,
    never posts the 👂).
  `,

  transcriptor: `
    WORKER-spine role block (the GPU box, e.g. DOLLY; REVE must NOT set this).

    KEYS:
      enabled
        true = this egpt service answers POST /v1/transcribe for a main spine;
        it holds NO conversation context and sends NOTHING outbound.
      port
        DEFAULT: 23390 — what a remote spine's transcription.server.endpoint
        points at.
      bind
        DEFAULT: "127.0.0.1" — set "0.0.0.0" or this machine's LAN ip to accept
        the main spine. NEVER expose to the internet.
      server
        The resident whisper.cpp server the worker POSTs to — loads the model
        ONCE instead of per note, ~12s→~2s. Omit → per-note whisper-cli.
          enabled           true → the daemon spawns + supervises it
          command           whisper-server exe path
          model             GGUF; falls back to transcription.cli.model_path
          host              DEFAULT: 127.0.0.1
          port              DEFAULT: 8089
          language          falls back to transcription.cli.language
          extra_args        appended after -mc 0 -sns
          anti_repetition   DEFAULT: true — -mc 0 -sns at launch

    The cli binary/model come from transcription.cli (point it at the GPU build).

    AUTH via transcription.server.token (the same value on the worker + the main
    spine); unsigned/stale requests are rejected and logged to
    ~/.egpt/logs/transcriptor.log.

    Install on the worker with setup\\install-worker.cmd (firewall + service,
    self-elevating).

    LEGACY READ-FALLBACKS:
      server  <- whatsapp.media.audio_transcribe.server
      token   <- transcription_token
  `,

  rooms: `
    Multi-member rooms config.

    KEYS:
      routing_enabled
        Boolean. DEFAULT: FALSE — the MASTER SAFETY SWITCH for live room
        fan-out. While false, /room commands still configure rooms but NO
        message routing happens. Flip true to let a contributing member message
        fan to the room's other members + shared transcript. Default off because
        a routing loop bug would spam real groups; enable + verify on a test
        room first.

    The room roster lives in ~/.egpt/rooms/config.yaml (managed via /room), not
    here.
  `,
  agents: `
    Unified agent registry (operator 2026-07-02, new-config-only) — the ONE
    block for the persona identity + local beings + mesh addressing.

    REQUIRED: boot fails without an agents block, and exactly ONE agent must
    carry  default: true  (the persona — operator 2026-07-10; boot is FATAL on
    zero or more than one).

    A map of canonical name -> the fields below.

    AGENT FIELDS:
      configuration
        Names an AGENT-TYPE file — a brain def — in config/agents/<type>.yaml,
        resolved through the brain registry:
          src/brains built-in < config/agents < a conversation's brains/
        e.g. configuration: "sonnet-high" points at
        config/agents/sonnet-high.yaml. For a relay agent, configuration is the
        literal "relay".
      handles
        ["e","egpt",...] — alternate @<token> routes; the map KEY also routes.
      relay_channel
        Marks a RELAY agent — the chat this agent forwards to: a chat NAME or a
        raw Beeper room id in SHORT form (no "!" / ":beeper.local", operator
        2026-07-03). The bridge send/stream resolves names via resolveChatId, so
        BOTH work.
      to
        OPTIONAL (operator 2026-07-05) — a declarative NEXT HOP
        "<being>.<node>": the relay agent re-addresses the message onward to
        that being on that node, posting into this agent's relay_channel; the
        next node re-relays via ITS own agent entry, forming a chain
        (@carol→don.do→wren.kg→…) that terminates when a hop resolves to a LOCAL
        being, which answers; the reply routes back the way it came.
        Absent to = open-channel (the owner of this being on the far end
        answers).
      body_emoji
        Prefixes this agent's outbound messages.
      name
        Display label the bridge stamps as "<body_emoji> <name>: <reply>".
        DEFAULT: the map key.
      default
        Boolean; marks THE persona — EXACTLY ONE agent per node — the agent that
        answers un-@mentioned messages and terminates relay chains resolving to
        it. Its MAP KEY is the persona being-id that keys warm sessions /
        threads / transcripts.
      mode
        OPTIONAL (operator 2026-07-25) — THIS agent's own default reply-mode.
        ENUM: on | auto | mute | mention-direct | mention | off
        It is the rung between the per-conversation mode and the node-wide
        dispatch.auto_default_mode, so two agents can hold DIFFERENT modes in
        the SAME chat — e.g.  e: {mode: mention}  answers a mid-sentence @e
        while  don: {mode: mention-direct}  stays silent unless named at the
        head. Applies to a RELAY agent too: a mesh target is gated as its OWN
        agent, no longer as the persona.
        DEFAULT: absent ⇒ dispatch.auto_default_mode for the persona, "mention"
        for every other agent.
        OVERRIDABLE PER CONVERSATION in conversations.yaml under the entry's
        agents: block — contacts.<surface>[<id>].agents.<name>.mode — which
        layers over the entry's existing <name>: block field-by-field, so an
        operator can pin one agent's mode in one chat without disturbing the
        threadId/readonly the spine writes there.
      enabled
        false to disable routing to it.

    RESOLUTION of a leading @<token> (router.mjs):
      The token matches an agent's name or any handle (case-insensitive).
      A LOCAL agent (configuration ≠ relay) routes like a being
      (being = agent name).
      A RELAY agent (has a relay_channel, or the legacy configuration: relay)
      routes to a mesh target whose ROUTE is the relay_channel — posted straight
      into that chat as an envelope. With  to: <being>.<node>  it re-addresses
      onward: a declarative chain, each hop re-relayed by the next node's own
      agent entry until a terminal LOCAL being answers; without to,
      open-channel (the being's owner on the other end answers). The reply
      mirrors home the way it came.

    THE PERSONA AGENT (the one with default: true, operator 2026-07-10) is the
    persona identity source (label = its name, emoji = its body_emoji); routing
    to it yields its MAP KEY as the being-id, which keys warm sessions / threads
    / transcripts — no hardcoded e/egpt anywhere, so renaming the key is a NEW
    identity, resetting that agent's warm session + threads. The persona's
    fresh-conversation default brain comes from its configuration (else the
    shipped "egpt" type).

    CONFINEMENT (2026-07-02): a type file's allowed_tools value sets the honest
    contract — the norm is to list tools explicitly.
      a LIST (a YAML vertical list of tool names)
        = CONFINED: its file tools are path-limited to the conversation
        directory (the one listed in conversations.yaml) plus any allowed_paths.
      "all" (or "*")
        Accepted but discouraged — TRUSTED/unconfined (full filesystem, no
        prompts) except bare Bash and Agent. Never implicit (operator
        2026-07-03).
      allowed_paths (a type-file map) grants extra roots:
        path:                              empty/null value = full access
                                           (read + write)
        path: { allowed_tools: [...] }     a list that OMITS the write-class
                                           tools (Edit/Write/MultiEdit/
                                           NotebookEdit) = READ-ONLY (native
                                           permissions.deny under that root)
        a per-path list that INCLUDES write tools is granted full access
        (per-path tool granularity beyond read-only isn't native, logged).
        Path keys accept msys /c/Users/.. and windows forms.

    INSTANCING (2026-07-02): when a fresh conversation is instanced from an
    agent type, the brainpool freezes the def into conversations.yaml under
    readonly.agent.

    IDENTITY/PERSONALITY lives in the TYPE FILE: config/agents/<type>.yaml may
    set  personality: <name>  to pin the identities/<name>/ feed a fresh
    conversation boots from; absent ⇒ "egpt". There is no per-conversation
    personality key.

    EXAMPLE:
      { egpt: { configuration: sonnet-high, handles: [e, egpt], default: true },
        don:  { configuration: relay, relay_channel: Rodz } }
  `,

  quick_reply_string: `
    Token that addresses whoever spoke LAST in a conversation, so answering the
    last agent needs no @name: "r ok pero que no sea tan común".
      DEFAULT: "r"      "" disables the feature
    Fires only when an AGENT spoke last there (after a human line it is ordinary
    text), and only with whitespace + a body — "really?" and a bare "r" are not
    triggers. Case-insensitive. The agent is addressed as if @named at the head
    and receives the message minus the token (src/spine/router.mjs addressed).
  `,

  bridge_signature_open: `
    Per-NODE infra WRAP — OPENING line (operator 2026-07-12).

    A free-form/multiline string the BRIDGE prepends ABOVE a message it posts
    (persona reply + 👂 echo), identifying WHICH SPINE posted (e.g. REVE kg vs
    DOLLY do sharing one Beeper account). The OUTERMOST layer of the concentric
    signature wrap — see bridge_signature_close for the matching close.

    Applied ONLY where a persona/agent stamp OR the 👂 transcript echo is applied
    — NOT to mode:auto plain operator posts.

    DEFAULT: absent or empty = NOTHING prepended (zero behavior change until
    configured).

    SAFE to set on a multi-peer node: 👂 echo double-detection is now a
    content-similarity query over normalized WORD tokens (src/text-similarity.mjs),
    position- and marker-independent — an open prepended above the 👂 no longer
    affects it.
  `,

  bridge_signature_close: `
    Per-NODE infra WRAP — CLOSING line (operator 2026-07-12).

    A free-form/multiline string the BRIDGE appends as the FINAL line (below the
    agent's ∎/signature) of the messages it posts, identifying WHICH SPINE posted
    (e.g. REVE kg vs DOLLY do sharing one Beeper account). Distinct from the
    per-agent/node signature (the reply-train end-marker): this is the outer
    infra CLOSE, owned by the infra, not the agent.

    Appended ONLY where a persona/agent stamp OR the 👂 transcript echo is
    applied — NOT to mode:auto plain operator posts (they carry no stamp).

    May be multiline / markdown-ish (Beeper renders bold/italic/links).

    DEFAULT: absent or empty = NOTHING appended (zero behavior change until
    configured).

    SAFE to set on a multi-peer node — a CLOSE sits below the 👂, so the echo
    still leads with 👂 and observe-cancel is unaffected.
  `,

  agent_signature_open: `
    Per-AGENT signature WRAP — OPENING line (operator 2026-07-12).

    A free-form/multiline string bracketing a persona/being reply ABOVE the
    stamped core, the INNER layer of the concentric wrap (bridge_signature_* is
    the outer).

    FALLBACK: agents.<key>.agent_signature_open > this node-level key > ''
    (mirrors signature's agent→node fallback).

    Kept SEPARATE from the ∎/signature end-marker: ∎ stays inline INSIDE the
    reply as its end-mark; this is an ADDITIONAL wrapper line above it.

    Applied ONLY to a fully persona-stamped reply — NOT to mode:auto plain posts
    or the 👂 echo.

    DEFAULT: absent or empty = NOTHING added.
  `,

  agent_signature_close: `
    Per-AGENT signature WRAP — CLOSING line (operator 2026-07-12).

    A free-form/multiline string bracketing a persona/being reply BELOW the
    stamped core (above the outer bridge_signature_close), the INNER layer of
    the concentric wrap.

    FALLBACK: agents.<key>.agent_signature_close > this node-level key > ''
    (mirrors signature's agent→node fallback).

    Distinct from the ∎/signature end-marker (which stays inline inside the
    reply): this is an ADDITIONAL wrapper line below it.

    Applied ONLY to a fully persona-stamped reply — NOT to mode:auto plain posts
    or the 👂 echo.

    DEFAULT: absent or empty = NOTHING added.
  `,

  transcription_open: `
    Per-NODE 👂-echo WRAP — OPENING line (operator 2026-07-12).

    A free-form/multiline string bracketing the 👂 transcript echo ABOVE its
    '👂 <transcript>' core, the INNER layer of the echo's concentric wrap
    (bridge_signature_* is the outer).

    Applied ONLY to the 👂 echo — NOT to persona replies or plain posts.

    DEFAULT: absent or empty = NOTHING added.

    SAFE to set on a multi-peer node: 👂 echo double-detection is now a
    content-similarity query (src/text-similarity.mjs), position- and
    marker-independent — an open prepended above the 👂 no longer affects it.
  `,

  transcription_close: `
    Per-NODE 👂-echo WRAP — CLOSING line (operator 2026-07-12).

    A free-form/multiline string bracketing the 👂 transcript echo BELOW its
    '👂 <transcript>' core (above the outer bridge_signature_close), the INNER
    layer of the echo's concentric wrap.

    Applied ONLY to the 👂 echo — NOT to persona replies or plain posts.

    DEFAULT: absent or empty = NOTHING added.

    SAFE to set on a multi-peer node — a CLOSE sits below the 👂, so the echo
    still leads with 👂 and observe-cancel is unaffected.
  `,

  emojis: `
    Author-emoji defaults for cross-surface mirroring (TG/WA).

    KEYS:
      user      "🦅"  shell user — USER_NAME
      egpt      "🧠"  egpt status/system voice
      persona   "🐶"  egpt persona reply — @egpt answers
      human     "🌐"  the extension's default 'human' tag — a distinct surface

    Read once at shell startup; restart to apply.
  `,

  mesh: `
    Being-mesh relay config.

    KEYS:
      timeout_ms
        DEFAULT: 60000 — how long the origin waits before surfacing
        "<target> did not answer".

    ROUTING IS AGENT-BASED (operator 2026-07-25): the ONLY way a message leaves
    this node is a RELAY agent in the agents: block — its relay_channel IS the
    route, and its optional  to: <being>.<node>  names the next hop, each hop
    re-relayed by the next node's own agent entry.

    The old mesh.nodes routing table (a map of <node-name> -> { routes: [...] })
    was EVICTED as dysfunctional legacy: it minted @being.node targets carrying
    no route. A leftover nodes: block in a config is simply ignored — delete it.
  `,

  room: `
    Room behaviour.

    KEYS:
      on_join
        ENUM:
          "lazy"  (DEFAULT) saved sessions load as data; brains spin up on first
                  @session use
          "eager" auto-/attach every saved session on /room join — opens Chrome
                  tabs, starts codex processes
          "off"   do not load saved sessions at all on join — start clean
      max_chain
        DEFAULT: 3 — max brain-to-brain reply chain depth before the next
        dispatch returns "…" instead of calling the brain. Guards against
        orchestra-style runaway when one brain's reply triggers another's
        dispatch.
  `,

  chrome: `
    Chrome control.

    KEYS:
      focus_on_dispatch
        ENUM: "on" (DEFAULT) | "off"
        Bring the brain Chrome window to the foreground before each brain
        dispatch. CDP Target.activateTarget + Page.bringToFront fire regardless;
        this knob controls the OS-level fallback that breaks past Windows
        SetForegroundWindow restrictions / macOS / X11 anti-focus-stealing
        rules. Targets the brain Chrome by PID when egpt spawned it (/chrome);
        falls back to app-name on macOS / Linux. Set to "off" if the focus theft
        becomes intrusive (e.g. mid-typing in another app).
  `,

  mirror: `
    /mirror defaults.

    KEYS:
      tagged
        ENUM: "on" (DEFAULT) | "off"
        Whether /mirror prefixes the forwarded body with [author timestamp]:.
        The flag --tagged / --no-tag overrides per-call regardless of config.
        With tagged on, destinations see who originally said it; with off, the
        body reads like a fresh message.
  `,

  brains: `
    Brain identity / setup.

    KEYS:
      identity
        ENUM: "./e_identity.md" (DEFAULT) | "<path>" | "off"
        Read once per session and sent as a SILENT setup turn before the first
        real user message, framed as
        "... system restarted, new persona installed ...\\n\\n<content>".
        Persisted per session via session.options.identityInjected so a daemon
        restart does not re-inject. /identity [@<session>] forces a fresh inject
        any time (e.g. after editing the identity file).
  `,

  tools: `
    Per-tool permission for the agentic loop (the @l local operator + any future
    tool-using brain).

    SHAPE:
      default
        Mode for any tool not listed. DEFAULT: "ask" if unset.
      <toolname>
        ENUM: "allow" | "ask" | "deny"
          allow = runs freely
          ask   = the host pauses and asks the operator (Self DM) yes/no before
                  running
          deny  = blocked
      sandbox
        The file-tool root; an absolute path or relative-to-~/.egpt.
        DEFAULT: "agent-sandbox" — read_file/list_dir are confined here.

    RESOLVED AS: tools[name] ?? tools.default ?? "ask".

    The HOST enforces this — an unleashed local model will not self-refuse a
    destructive call, so this is the operator control surface over what @l may
    do.

    Toggle via /e tool allow|deny|ask [all|<toolname>] ("all" sets default —
    /e tool deny all  then  /e tool allow read_file  = whitelist mode).

    PHASE-1 TOOLS: read_file, list_dir, web_fetch, send_message
    (sandbox-confined); later write_file, bash gate behind ask/deny.
  `,

  streaming: `
    Persona-reply streaming knobs (Phase 2b stream-over-IPC; see
    egpt-comm-handler.mjs).

    KEYS:
      update_coalesce_ms
        DEFAULT: 0 — NO proxy-side cap on @e token rate; every stream update()
        fires immediately. Set to N > 0 if you want the handler-side proxy to
        debounce updates at N ms, e.g. to match a future file-IPC outbox cadence
        and reduce file churn.
      finish_timeout_ms
        DEFAULT: 30000 — how long the handler waits for a keeper
        wa-stream-result after finish() before resolving with
        {delivered:false, lastError:"stream-result timeout"}. NOT a speed cap on
        @e: it only kicks in if the keeper hangs after the reply is complete.
        Set higher for tolerant networks, lower for aggressive fallback.
  `,

  guard: `
    The SINGLE loop-breaker (src/stop-guard.mjs, wired at the spine prompt
    chokepoint src/spine/spine.mjs; replaces the old flood-guard + mesh circuit
    breaker).

    N consecutive NON-HUMAN turns on a channel pause it; a genuine human message
    resets the count. "human" is decided by PROVENANCE, not display name — a
    mesh message posted AS the operator parses as relay traffic (an envelope) and
    is NON-human, so it counts toward the cap instead of resetting it (closes the
    2026-06-19 hole).

    KEYS:
      turns
        DEFAULT: 6 — consecutive non-human turns that pause the channel.
        -1 or 0 = off.
      window
        DEFAULT: -1 = pure consecutive count. A positive value is MINUTES — only
        count turns within that span, an optional belt.

    PER-CONVERSATION OVERRIDE: a contact/room entry in conversations.yaml may
    carry its own  guard: { turns: -1 }  to loosen or disable it for that channel
    (e.g. a busy relay room).

    RESUME / RESUME ALL (from an authorized sender, on any surface) clear a
    channel this counter auto-stopped — the only way back short of a restart.
    RESUME clears the channel it was typed in; RESUME ALL clears every channel the
    counter stopped (it can stop several independently).

    THE SAFE WORD IS SEPARATE, AND IT IS THE KILL SWITCH (operator 2026-07-25):
    STOP from an authorized sender on ANY surface writes  EGPT_HOME/STOP  with its
    reason + provenance, posts a one-line warning back into that chat (best-effort,
    capped — it can never delay the stop) and stops the SERVICE (a clean exit 0,
    which egpt-daemon does not respawn). It does NOT pause a channel. While that
    file exists the node refuses to boot, and a RUNNING node halts on its next tick
    — so  touch ~/.egpt/STOP  stops egpt too. Recovery is  rm ~/.egpt/STOP  and
    nothing else: the file is the whole state.

    WHO MAY PULL IT: an authorized sender (per-surface allowed_users, or the Beeper
    account owner) AND a genuine HUMAN turn. On a shared Beeper account every send
    from the account reads as authorized, so the safe word is additionally gated on
    the same PROVENANCE predicate this counter uses — our own output, a brain
    member's re-entered reply, relay envelopes and backlog replay can never pull it.

    THE COMPLETE SAFE-WORD VOCABULARY IS:  STOP | RESUME | RESUME ALL.
    "STOP ALL" was unwired on 2026-07-26 — it is ordinary text now, not an alias.
  `,

  warm: `
    Warm-session pool for the resident brain processes (src/warm-sessions.mjs; E
    stays resident so its context lives in memory instead of re-spawning +
    --resume per message).

    KEYS:
      max
        DEFAULT: 6 — LRU cap on live sessions; the "keep a number — or, with a
        high max, all — agents warm" knob. It bounds how many warm sessions live
        at once, independent of the idle TTL.
      idle_ttl_ms
        DEFAULT: 1800000 — ms-of-idle before an unlisted class is evicted.
      idle_ttl_by_class
        Per-class idle TTL.
        DEFAULT: { system: 0, resident: 0, conversation: 900000, sibling: 0 }
        where 0 = never idle-evict.

    CONVERSATION DEFAULT = 15m (operator 2026-07-02: "keep any conversation as a
    background agent 15m after the last message, configurable"): a conversation
    goes cold 15 min after its last turn, then idle-evicts (the transcript +
    --resume make the next turn correct, just colder). This SUPERSEDES the
    earlier never-evict default (conversation: 0). system/resident stay
    persistent (0); sibling stays 0.

    PER-CONVERSATION OVERRIDE: a conversation folder's own config.yaml (the same
    file that carries the transcription: / heartbeats: blocks) may set
    warm: { idle_ttl: 1h } — a ms number or a "<qty><unit>" duration
    (ms/s/m/h) — to override the class TTL for THAT conversation only;
    idle_ttl: 0 there = keep this conversation always warm.
    RESOLUTION: per-conversation override > class TTL.
  `,

  advice_channel: `
    mode: auto consult channel (operator 2026-07-04) — names the ONE chat E posts
    its /ask questions to when it plays the operator's role in an auto
    conversation and is in doubt.

    VALUE: a chat NAME or a raw Beeper room id in SHORT form (no "!" /
    ":beeper.local") — the bridge send/postStatus resolves names via
    resolveChatId, so BOTH work (same trust shape as agents.relay_channel).

    This is the SOLE sanctioned cross-chat emit from a conversation being: the
    /ask limb (src/spine/reply-actions.mjs) can reach ONLY this channel, never an
    arbitrary chat, and is fail-closed (the question is dropped + logged, E's
    prose still surfaces) when this key is unset.

    The operator answers by QUOTE-REPLYING to E's question in the channel; that
    answer is routed back into the origin conversation as a turn
    (src/spine/advice.mjs).

    Per-conversation opt-in only (a chat is auto iff its mode is set to auto via
    /e auto auto <chat>); the turn-counter guard bounds runaway unchanged.
  `,

  aliases: `
    Display-name overrides for the /status member counters:
      { <sender-id>: <alias> }

    Any id form (phone, WhatsApp jid, Beeper id) seen in a chat's stats file
    (state/stats/<surface>/<chatId>.yaml) members: block maps to a stable label.

    Read at display time in src/spine/commands.mjs (the /status member line)
    only; never persisted into the stats file.

    Edit + /restart to apply (no hot-reload).
  `,

  compaction: `
    Auto-compaction of a conversation's warm session (src/spine/compaction.mjs;
    operator 2026-06-30): after a cooling period following the bot's last reply,
    if the session has grown past the configured ratio of the model window,
    native /compact it IN PLACE so warm turns + the first --resume after a
    restart stay fast (the full record lives in transcript.md, nothing lost).

    KEYS:
      enabled
        DEFAULT: on; false disables.
      ratio
        DEFAULT: 0.20 — compact once the session passes this fraction of the
        context window.
      cooling_ms
        DEFAULT: 120000 — quiet period after the last reply before the size
        check runs.
      context_window
        Override the per-model window token count.
        DEFAULT: windowForModel(model)
  `,
};
