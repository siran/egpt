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

// resolveConfigKey — /config set's key resolver (src/spine/commands.mjs configCmd). Turns the
// operator's typed key into a registered dotted path, or a refusal:
//   { path }                                  resolved
//   { error: 'unregistered', message }        top segment (dotted) or the bare leaf itself
//                                              isn't in CONFIG_SCHEMA anywhere
//   { error: 'ambiguous', message, candidates } a bare leaf matches more than one block's KEYS:
//
// A dotted input (has a '.') is accepted AS-IS once its top segment is a registered top-level
// key — the tail is NOT validated against that block's KEYS: prose (not reliably parseable to
// arbitrary depth; "used as-is" is the ruling). A bare leaf with no '.' first checks whether it
// IS itself a top-level key (e.g. node_name); otherwise it is looked up in the leaf index below.
export function resolveConfigKey(input) {
  const key = String(input ?? '').trim();
  if (!key) return { error: 'unregistered', message: `"${key}" is not a registered config key` };
  if (key.includes('.')) {
    const top = key.split('.')[0];
    if (!Object.prototype.hasOwnProperty.call(CONFIG_SCHEMA, top)) {
      return { error: 'unregistered', message: `"${top}" is not a registered top-level config key` };
    }
    return { path: key };
  }
  if (Object.prototype.hasOwnProperty.call(CONFIG_SCHEMA, key)) return { path: key };
  const matches = leafIndex().get(key.toLowerCase()) ?? [];
  if (matches.length === 1) return { path: matches[0] };
  if (matches.length > 1) {
    return { error: 'ambiguous', message: `"${key}" matches more than one config key: ${matches.join(', ')} — use the full dotted path`, candidates: matches };
  }
  return { error: 'unregistered', message: `"${key}" is not a registered config key` };
}

// Lazy, memoized bare-leaf -> [<topKey>.<leaf>, ...] index, built by scanning every block's
// KEYS: section per the SHAPE convention documented above the file (a KEYS: line, then the
// indent of its first non-blank line is the base — every subsequent line AT exactly that indent
// matching a bare identifier is a leaf name; the section ends the moment a non-blank line's
// indent drops below the base).
let _leafIndex = null;
function leafIndex() {
  if (_leafIndex) return _leafIndex;
  const index = new Map();
  for (const [topKey, block] of Object.entries(CONFIG_SCHEMA)) {
    const lines = block.split('\n');
    const keysAt = lines.findIndex((l) => l.trim() === 'KEYS:');
    if (keysAt === -1) continue;
    let j = keysAt + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length) continue;
    const baseIndent = lines[j].match(/^(\s*)/)[1].length;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent < baseIndent) break;
      if (indent === baseIndent && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(line.trim())) {
        const leaf = line.trim();
        const dotted = `${topKey}.${leaf}`;
        const lk = leaf.toLowerCase();
        if (!index.has(lk)) index.set(lk, []);
        index.get(lk).push(dotted);
      }
    }
  }
  _leafIndex = index;
  return index;
}

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

    REQUIRED (operator 2026-07-26: "spine doesn't boot without the invisible
    ones"). node_name IS the STRUCTURAL node signature: every frame a spine
    commits to a surface carries it TAG-ENCODED into invisible characters
    (src/node-signature.mjs), machine-readable, and the transcript decodes it
    back to a legible <node>. There is deliberately no separate signature key —
    it could only ever hold a redundant copy of this one. Absent or blank =
    boot refuses to start.

    The VISIBLE bridge_signature_open / bridge_signature_close are a SEPARATE,
    OPTIONAL layer for human eyes only; empty is fine and never blocks boot.
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

  wake_up: `
    This node's PERIODIC WAKE DUTY (operator 2026-10-08) — a scheduled task that
    wakes the machine from sleep on a fixed cadence to run ONE eGPT work cycle
    (revive the daemon if it died, let the resumed spine drain backlogs and run
    due turns), then releases so the machine sleeps again.

    READ ONLY BY setup/register-wake-duty-task.ps1 — no spine path reads this
    block; the duty itself is setup/egpt-wake-duty.ps1. It is registered here so
    the skeleton can ship it and /config does not reject it as unknown.

    KEYS:
      enabled
        DEFAULT: true
        false => the registrar REMOVES the task (same as its -Remove), so a node
        can decline the wake duty by config without deleting the block.
      frequency_minutes
        DEFAULT: 30
        The task's repeat interval, in minutes — how often the machine wakes to
        check around (heartbeats, pending interactions). The registrar's
        -RepeatMinutes flag, when passed, OVERRIDES this value.
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
        A SHELL line spawned on each due tick. POSIX: on Windows it runs as
        <bash> -c <command> with msys64's (else Git's) bash — never System32's
        WSL bash; no POSIX bash installed → cmd.exe, logged loudly. Elsewhere
        /bin/sh. The bash in use is  shell:  in heartbeats.readonly.yaml.
        The default alive command (boot's, or a declared alive: with no command:)
        stays on the native shell: liveness never depends on msys starting in the
        daemon's session.
      post
        "<template>" beside command: — on exit 0 with non-empty stdout, posts
        the template with {stdout} (trimmed) into the chat the beat was declared
        in. Failure or empty stdout posts nothing (logged). Invalid without
        command:, with agent:/script_path:, or on a node-level beat.
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
      silent
        true → the WHOLE beat goes to eGPT Admin (config admin_channel), not the
        beat's own chat: the firing announcement AND the output (a command
        post:'s text, or an agent beat's reply) both land there, nothing in the
        own chat. Default false. admin_channel unset/unresolvable → nothing is
        posted (fail-closed) and a warning logs; it never falls back to the own
        chat. A non-boolean skips the entry.

    FIRING ANNOUNCEMENT (operator 2026-09-30):
      Every beat that SENDS into a chat — a post: command, an agent: turn — posts
      a one-line "🫀 <name>" notice (the beat's OWN short name, never the
      <ns>:<name> form) into that chat just before it runs, so an unattended beat
      is visible the instant it fires, not only in the run log.
      A plain command beat (no chat output) and a node-level beat (no chat) do
      not announce. With silent: true the announcement — and the output — go to
      eGPT Admin instead (see silent above).

    TRIGGER (operator 2026-07-02):
      An entry may use  when: <M/D/YYYY H:MMa | 24h | ISO>  INSTEAD of
      frequency: — a ONE-SHOT that fires once at/after that wall-clock time then
      never again. Timezone from default_time_zone, else machine local. Both
      frequency + when set → invalid, skipped.
      Once means once across reloads and restarts (2026-09-28): the instant it
      fired for is kept in state/heartbeats-daily.json beside the daily: rows,
      so a when: left in place never fires again; an edited when: is a new
      one-shot. Due while the node was down: daily:'s rule — up within the
      2-minute grace it fires late, once; later it is skipped (logged once per
      beat per process), never fired.
      Or  daily: "HH:MM"  (24-hour, operator 2026-09-16) — EVERY day at that
      wall-clock time in  time_zone:  (IANA name or a default_time_zone alias;
      absent → default_time_zone; invalid → entry skipped). At most once per
      local day, within the same 2-minute grace as when: — a node down through
      the window skips the day. DST follows the zone. The date each beat last
      fired lives in state/heartbeats-daily.json, so a restart or reload inside
      the window never re-fires. (frequency: 24h is anchored to registration: it
      fires at every boot and reload.) More than one trigger set → invalid,
      skipped; time_zone: without daily: → invalid, skipped.

    ACTION:
      script_path: <script.x.md>  may replace  command:  — sugar the loader
      expands to  node <src/tools/textecute.mjs> <script>  to run a
      TEXTECUTABLE. Both command + script_path set → invalid, skipped.
      WHAT THE PATH IS RELATIVE TO: the folder the beat was DECLARED in — the
      entity folder (~/.egpt/conversations/<surface>/<slug>/, a room being
      surface 'room') for an entity beat, the CHECKOUT for a node-level one.
      NOT a scripts/ subfolder: a bare  dj.x.md  means <that folder>/dj.x.md,
      and a script kept in a subfolder must say so (scripts/dj.x.md). Same root
      whichever action kind runs it. A wrong path is ENOENT on every tick — the
      beat dies before it does anything, and only the log says so.
      RENAMED (operator 2026-08-22): this key was  ai_run:  . An entry still
      carrying  ai_run:  is INVALID — skipped + logged naming the replacement,
      never silently actionless.

    WHO RUNS IT (operator 2026-08-22):
      agent: <being-id>   alongside script_path: — the beat runs as that BEING
      instead of as a bare textecute session.
        VALUE: a KEY of the  agents:  map above (egpt, pi, wren, …) — a being-id,
        NEVER a handle (@p).
      WHY: a bare script_path spawns textecute.mjs, which opens its own CLI session
      OUTSIDE the being system — no persona, no transcript, and no access_level,
      allowed_users or sandboxed. With agent: the loader dispatches a TURN
      through the same path an inbound message takes (src/spine/brainpool.mjs),
      in the conversation/room the beat was declared in, so every confinement
      gate that guards a message turn guards this one.
      The PROMPT is identical either way (textecute's own framing + the script),
      so a *.x.md script behaves the same whichever runs it.
      prompt: "<one line>"  (2026-09-16) may replace script_path: — the line is the
      turn's trigger text as is, no script file, no textecute frame. agent: needs
      exactly one of script_path: / prompt:.
      THE REPLY IS POSTED (2026-09-16) into the conversation/room, as that being
      (its stamp), said by the mouth, once — no ⏳ placeholder. An empty or "…"
      reply posts nothing; a failed turn posts nothing and logs FAILED.
      A turn beat is NOT an inbound message: it never touches gating, so a
      being with  mode: mention  runs its own beat without that making it answer
      un-addressed messages.
      INVALID (skipped + logged, like every other malformed entry):
        agent: + command:            a shell line has no being
        agent: without script_path: or prompt:
        prompt: with command: or script_path:, or without agent:
        agent: naming an unknown being
        agent: on a NODE-level beat  a turn needs an entity to run in — declare
                                     the beat in that conversation/room's own
                                     config.yaml
        a script_path that is not a *.x.md (the extension is consent, as for
                                     textecute itself)
      OVERLAP GUARD: unchanged — a still-running previous turn skips the tick and
      logs, so a slow being never stacks beats.
      browser: true  (2026-09-28) beside agent: — before the turn the spine
      starts its CDP browser through /chrome's own launch path (nothing launched
      when it already answers). If it will not come up the turn still runs, its
      prompt opening with one line saying why, and the log says so. browser:
      false = no browser; any other value, or browser: true without agent:, is
      invalid.

    THE DEFAULT BEAT is alive:
      When this block declares no alive, the spine injects one at boot's aliveMs
      (DEFAULT 60000) as  command: echo beat > state/alive.txt  — run with
      cwd = the profile, so the relative state/ resolves there. A plain shell
      one-liner: no hidden builtin, and the exact command is visible in
      ~/.egpt/heartbeats.readonly.yaml.
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
      (conversations/<surface>/<slug>/config.yaml) — including an operator-named
      room, which is one on surface 'room' (conversations/room/<slug>/config.yaml)
      — may carry its own heartbeats: block. Entity beats are namespaced
      <surface>/<slug>:<name> so they cannot collide.

    A BEING'S OWN BEATS (<entity>/heartbeats/<name>.yaml, 2026-09-25/28):
      One file per beat, written by the being; the operator's rungs keep any name
      they declare. Every one runs BOXED OR NOT AT ALL, in three kinds:
        structural  a trigger + command: (or a bare script_path:), optionally
                    post: "{stdout}" — run by setup/sandbox-logon-launcher.ps1
                    as the conversation's pool account, cwd its room, with the
                    global_read_paths mounts; stdout posts to that chat only.
                    Refused (a FAILED run, logged) unless every being resident
                    in the conversation resolves sandboxed. A command too long
                    for the launcher's 1024-character command line runs from
                    heartbeats/<name>.command.sh, written beside the beat.
                    Every one is handed sandbox_oauth_token, as a boxed
                    turn is, when it is set; unset, a script_path: beat is
                    refused (its textecute needs it) and a command: beat
                    runs without it.
        browser     browser: true + agent: + prompt: (above)
        pure AI     agent: + prompt: — a turn, refused unless that being
                    resolves sandboxed and is not access_level: all.
      agent: + script_path: stays invalid here: the spine reads that script as
      the operator. frequency: has a 60 s floor here — finer is clamped, logged
      once per beat — so a being's file never tightens the node's tick.

    RESOLVED SET:
      At boot the spine materializes the full resolved set to
      ~/.egpt/heartbeats.readonly.yaml — at the PROFILE ROOT, beside
      config.readonly.yaml and conversations.readonly.yaml (operator 2026-07-26:
      "state/ hides too much"). A spine-written snapshot: edit config.yaml / the
      entity config.yaml and /restart, do not edit the readonly file. Every row
      carries source:, the profile-relative file it was read from. The tick
      auto-tightens to the finest cadence, floored at 500ms.
      heartbeats is the config resolver's one UNION block: an entity declaring a
      beat CONTRIBUTES one, it never replaces the node's.
      CONFIG REFRESH: a config.yaml (or entity config.yaml) edit takes effect
      automatically on the next inbound message — no restart, no file to delete.
      New chat folders / edited entity config.yaml are picked up the same way.

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
        The absolute @e-emit kill-switch, toggled by /agents auto pause|resume <handle>.
        Layered OVER the per-conversation mode gate.
      auto_default_mode
        ENUM: "on" | "auto" | "mute" | "mention-direct" | "mention" | "accum" | "off"
        DEFAULT: "mention"
        The NODE-WIDE default reply mode: EVERY agent's mode in any chat where
        neither the conversation nor the agent's own agents.<name>.mode says
        one (src/spine/gating.mjs resolveMode). Set per chat via /agents auto
        <mode> <handle>. There is no default agent (2026-10-22): "on" or "auto"
        here means every agent answers every line in every chat the node
        hears — boot warns about it.
      address_without_at
        Boolean. DEFAULT: true
        May a BARE handle OPENING a message address its agent — "d hola",
        "e mirá", no '@' (operator 2026-07-27: "the '@' is not necessary at the
        beginning … they are all handles, and it's easy to write")?
          true   "d hola" addresses d, exactly as "@d hola" does
          false  the '@' is REQUIRED; "d hola" is ordinary text
        NODE-WIDE and nothing else — there is no per-conversation or per-agent
        rung, by ruling.
        It switches ONLY the bare form. The '@' form is untouched in both
        states, unicode word boundary included.
        Read once at boot and handed to BOTH callers of the one mention matcher
        (src/auto-mode.mjs mentionHits): the beeper + shell limbs' mention flag
        (mentionStatus) and the agent registry (src/spine/router.mjs addressed).
      default_node
        RETIRED (2026-10-19), ignored: a command names its being ("/e tabs"), and that
        being's node runs it, so no command is addressed to a node any more.
      stranger_agent
        Map — beeper connection name -> local agent key. DEFAULT: unset (off).
          stranger_agent: { secondary: edw-marketer }
        A NEW 1:1 (no conversations.yaml entry yet) arriving on that connection
        from a sender on NO allowed_users list (networks.*, agents.*.
        conversation_defaults; "*" names nobody) is created with
        agents.<agent>: { default: true, mode: on } — its OWNER, answering
        every line, and its stranger reaches that agent only (other handles are
        dropped). Do not set the agent's own agents.<agent>.mode to "on": that
        applies in every chat the node hears. Groups, existing chats, known senders,
        our own sends: untouched. See src/spine/router.mjs strangerAgentFor.
      send_to_egpt
        RETIRED (2026-10-23), ignored: an agent runs a turn only when it may
        reply; "accum" hands it the context it was not handed in between.
    Per-chat modes live in each conversation entry, PER AGENT
    (contacts.<surface>[<id>].<being>.mode, or the entry's agents.<name>.mode
    override, via /agents auto <mode> <handle>). There is no flat entry-level mode —
    getBeing() has had no flat fallback since 2026-07-10.
    Paste-ready reference: config/skeletons/conversations.yaml.

    BACK-COMPAT: each of these two reads falls back to its legacy home in the
    whatsapp block — so an un-migrated config is unchanged (src/spine/gating.mjs):
      auto_paused        <- whatsapp.auto_e_paused
      auto_default_mode  <- whatsapp.auto_e_default
  `,
  closed_chats: `
    Chats no being answers (operator 2026-10-25). Keyed like conversations.yaml:
    surface -> that chat's id. DEFAULT: unset (no chat closed). Applies live.

      closed_chats:
        whatsapp:
          AbCdEfGhIjKlMnOpQrSt: { message: "This group moved to ..." }
          ZyXwVuTsRqPoNmLkJiHg: {}          # closed, silent

    Every being's mode there is "off" (src/spine/gating.mjs resolveMode, above
    the conversation's own mode): no turn by mode, handle, quote or voice
    handle, and the line is not recorded. \`message\` (optional) is said there
    once by this node (src/spine/closed-chats.mjs; again when it changes) and
    again to a human line that names a being, at most once a day. Marker: the
    chat's own conversations.yaml entry, \`closed: { notice, at }\`. Removing
    the chat reopens it on its conversations.yaml settings. By the chat's own
    id: an alias side group is closed by its own id. Heartbeats are not gated.
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
        /agents auto <mode> <handle>, was /e auto <mode> <chat>) plus
        the Room members[] store (set via /e residents). The global default +
        pause MOVED 2026-06-25 to dispatch.auto_default_mode / dispatch.auto_paused
        (was /e auto <mode> all | pause | resume).
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

  limbs: `
    The node's conversational I/O transports, one block each (operator
    2026-10-23): beeper and telegram; an http chatbox will sit beside them.
    Restart-only.

    Not the /book and /email action limbs (agents.<name>.actions,
    src/spine/reply-actions.mjs): those are not configured here.

    KEYS:
      beeper
        The Beeper accounts block, documented under beeper: below. Read through
        src/tools/config-io.mjs beeperBlockOf alone.
      telegram
        <connection>: { account: <bot username, a label> } — a Telegram BOT on the
        Bot API (src/bridges/telegram.mjs), long polling, no Beeper. One bot per
        node for now (the first connection). The token is NOT in config: it is the
        file <EGPT_HOME>/secrets/telegram-<connection>.token, written by
        setup/telegram-token.mjs; boot checks it with getMe and logs the @username.
        Its chats are tg:<chat id>; networks.telegram.allowed_users (Telegram
        numeric user ids) may command. A node with no limbs.beeper connection and
        no Beeper token runs on Telegram alone.
  `,

  beeper: `
    Beeper accounts block (operator 2026-07-09; MULTI-CONNECTION operator 2026-08-30).

    LIVES AT limbs.beeper (2026-10-23). The top-level beeper: was evicted from
    code that day; configs keep it only as a deprecated copy for older code, and
    current code ignores it when limbs.beeper is set (one informational line per
    boot). Alone, it is still read, with one deprecation line per boot;
    migrations/0049 copies it under limbs:, comments included, and leaves it.

    SHAPE:
      use: <name>
        Which account below is this node's DEFAULT connection (every agent that
        doesn't name its own — agents.<name>.beeper_connection, below — rides
        this one).
      <name>:
        account   label — the Beeper address this token belongs to
        token     that account's Desktop API token
      auto_update:
        <os>: { method: auto | manual | none }      os = windows | linux | mac
        Keeping Beeper Desktop itself current (src/tools/beeper-update.mjs).
          none    no checks, no notices.
          manual  checks at boot, every 6 h and on /<handle> update beeper; ONE
                  line per newly downloaded version to log_to_group; installs
                  only on /<handle> update beeper (operator only).
          auto    as manual, then installs by itself at the next quiet moment.
        Installing is a controlled Beeper restart: it waits for turns like
        /restart, eGPT stays up, the result is one line in log_to_group.
        DEFAULT: windows manual. linux / mac: accepted, not implemented yet —
        treated as none (one log line at boot). Not a connection. beeper: is a
        restart-only key, so a change applies at the next restart.

    THE PORT IS DISCOVERED — there is none to configure (operator 2026-09-07).
    Beeper Desktop's local API binds the FIRST FREE PORT starting at 23373, so
    on a machine running more than one install the numbering follows START
    ORDER, not identity, and reshuffles whenever they restart in a different
    order. A pinned port is a guess with a shelf life: on 2026-09-06 one named
    the wrong install, every request 401'd, and the node was deaf for ~90
    minutes. But a TOKEN BELONGS TO AN INSTALL, not to an account — only the
    install a token was minted on answers 200, every other one answers 401 — so
    the spine probes 127.0.0.1:23373-23382 with the token at boot, and again on
    every reconnect, and the 401s identify the right install unambiguously. The
    winning port is logged. account + token is therefore a COMPLETE connection.

    OPTIONAL, only when a Desktop is NOT on this machine's default loopback:
      base_url  where that Desktop's API is, e.g. http://127.0.0.1:23380.
                SETTING IT SKIPS DISCOVERY entirely — the spine dials exactly
                what you named, at boot and on every redial.
      ws_url    the event socket. DERIVED from base_url unless given, so
                base_url alone is a complete answer.
      owner_node  which node WAKES on this connection when the same account is
                live on several nodes; every other node still SENDS on it.
                Absent = every node wakes, which is right for one node.

    DEPRECATED, still read: endpoints: — a list of (base_url, token) candidates
    tried in order, first 200 wins (operator 2026-09-03, for a Session 0 Desktop
    that changes identity at logon). Discovery answers that case with no port
    list at all; a list that repeats ONE token across several ports collapses to
    plain account + token. Boot logs a line naming any connection still on it.

    INGEST AND OUTPUT ARE TWO ANSWERS (operator 2026-09-10): "primary is the one
    to 'use' and secondary is the one to use as output".

      THE EAR — which connection this node WAKES on. In order:
        1. every connection whose owner_node names THIS node (the explicit
           claim, and the only way to hold TWO ears);
        2. 'primary';
        3. the ONE connection, if exactly one is declared, whatever its name;
        4. the default OUTPUT connection below (back-compat: a node carrying
           use: and several blocks keeps the ear it had).
      NEVER an ear: 'primary_gui' (the operator's own Beeper window — a second
      install of an account another connection already is; a node whose
      egpt-beeper-primary shares the window's profile has none, see
      setup/share-beeper-primary-profile.ps1), a connection owned
      by another node, and a connection whose account or token duplicates an ear
      already claimed. A node that resolves NO ear boots and says so loudly.

      THE MOUTH — which connection an agent SPEAKS on. In order: the agent's own
      use: (alias: beeper_connection), then beeper.use, then 'secondary',
      then 'primary', then the lone connection, then the legacy beeper_token.

    Neither can move the other. An agent's pin names its mouth and cannot make
    an ear; the ear is a node-level answer no agent participates in.

    …AND THE MOUTH SPEAKS ONLY WHERE IT CAN REACH (operator 2026-09-11: "self
    doesn't have mouth. if mouth is available always use mouth"). A chatId is a
    Matrix room on ONE account: two connection names declaring the same account:
    see the same rooms under the same ids, a different account cannot address
    that chat at all. So every outbound this node places — an agent's reply and
    the node's own announces alike — rides the mouth when the mouth can reach
    the chat, and otherwise the connection that holds it (the one it arrived on,
    or the ear for this node's own networks.<surface>.chat_ids). One rule, no
    exception for node-level sends. beeper.use is therefore an OPTIONAL override
    of the default mouth, never a requirement: with it absent the names decide,
    and no chat becomes unreachable either way.

    …AND "CAN REACH" IS RESOLVED, NOT INFERRED, FOR A REPLY (operator 2026-09-12:
    "whatever it is, if secondary is present it should be used as mouth. all
    agents have different wake words, but they all use secondary to speak, when
    present"). Comparing the two account: strings answers only whether one
    connection can be handed the OTHER's chat id — it cannot, ever. It does not
    answer whether the mouth's account is IN that chat, and usually it is: one
    real group is a different Matrix room per account, with its own id on each.
    So before a reply falls back to the connection holding the chat, the mouth
    is asked whether its account is a participant, and if it is, the chat is
    TRANSLATED to that account's own room id (matched by chat type + participant
    phone numbers with both accounts excluded — the same key the peer link uses,
    src/bridges/beeper.mjs crossAccountChatKey). The two identities are MEASURED,
    not configured: each install reports its own phone number on /v1/accounts.
    Nothing to declare, and nothing changes on a node with one connection or one
    account.

      the mouth is in the chat  → the reply goes out on the mouth, in the
                                  mouth's own room id.
      the mouth is NOT in it    → the connection holding the chat replies. The
                                  Self-DM is this case permanently: it is a
                                  1:1 on the ear's account and the mouth's
                                  account is not a participant.
      it IS in it but its room  → the connection holding the chat replies, and
      cannot be resolved           the [mouth] log says which refusal it was.
                                  Never a post into a room resolved by guess.

    Node-level announces are unchanged: they carry the arrival's own chat id and
    are not translated, so they ride the connection that holds the chat.

    MORE THAN ONE <name> block may be declared — e.g. a second Beeper Desktop
    login/WhatsApp number for a second being on the SAME node. One bridge
    instance is opened per DISTINCT (base_url, token) actually referenced — as
    an ear, or by some agent's use: — so a block that is neither is never
    dialled, and a node where the ear IS the mouth opens exactly one bridge.

    BACK-COMPAT: with no beeper: block (or no use), the bridge falls back to the
    top-level beeper_token key, then the BEEPER_ACCESS_TOKEN env var (unchanged).

    Keep tokens in config.local.json, never a shared config. Create a token in
    Beeper Desktop > Settings > Developer > Desktop API.
  `,

  radio_service: `
    Node-level config for relaying WhatsApp voice notes to internet radio
    stations. CONFIG + COMMAND ONLY for now (2026-08-08): no uploader, no HTTP
    client, no audio handling exists yet — this block and the /radio command
    are inert until that lands. Per-room relay STATE (which radio a given
    room relays to, and its sender-id -> speaker-name map) is NOT here — it
    lives in that room's own config.yaml under "radio:", beside "members:".

    A MAP of radio name -> per-station settings (operator ruling 2026-08-08:
    "radio_service can be a list of radios to which you can join"), one block
    per station, mirroring transcription_service's named profile blocks:

      radio_service:
        wildnloyal:
          name: "Wild n Loyal radio"
          listen_url: https://radio.wildnloyal.org/
          enabled: true
          endpoint: https://radio.wildnloyal.org
          relay_user: egpt
          relay_password: ""
          default_speaker: egpt

    Room configs are PER-NODE (each machine has its own conversation
    config.yaml), so this map is what makes "/<handle> radio join <name>" a real
    check rather than a dead one: it looks up <name> in the map of the handle's
    node only, and refuses when it's absent, naming what IS configured there —
    there is no cross-node lookup.

    KEYS, per <radio-name>:
      name
        Human-readable station name used in /radio's replies (e.g. "relaying
        to Wild n Loyal radio…"). Falls back to the config key (the radio's
        map key, e.g. "wildnloyal") when absent.
      listen_url
        Where a HUMAN listens (the public station page), e.g.
        https://radio.wildnloyal.org/. Included in /radio join's reply when
        set, omitted entirely when absent — never derived from endpoint, since
        the API base and the public listen page need not be the same host.
      enabled
        DEFAULT: false — off until the station route exists, and set PER
        STATION so one can go live while another is still being set up.
        /radio still reads/writes real per-room state either way; this only
        gates whether a reply reports relaying as LIVE.
      endpoint
        The station's API base URL, e.g. https://radio.example.org — may
        differ from listen_url (see above).
      relay_user
        Username this node authenticates to the station's (relays) realm as.
      relay_password
        The (relays) realm credential — a live secret. Keep it in
        config.local.json, NOT config.yaml. REDACTED wherever /config prints
        it (CONFIG_REDACT_RE matches "password").
      default_speaker
        Station speaker name used for a sender not found in a room's
        radio.hosts map.
  `,

  radio_blocked_senders: `
    Node-level list of BLOCKED sender ids (operator ruling 2026-08-08: "'/radio disable
    <slug>' matches my contact names, userid, radioname... blocks that person from
    relaying"). A blocked sender may not relay to ANY radio on THIS node.

      DEFAULT: [] — nobody blocked.

    Written by "/radio disable <person>" (src/spine/commands.mjs radio()), which resolves
    <person> in this order: a configured radio name or a known node name first (those
    disable the RADIO/NODE instead — see radio_service, above); then a room's radio.hosts
    speaker name; then a contact name resolved through the per-contact stats files under
    state/stats/<surface>/ (sender_id + name, src/conversations-state.mjs); then, only if
    nothing else matched and the slug already LOOKS like an id (same shape
    src/spine/commands.mjs resolveTarget uses for a verbatim jid), the raw id itself.

    Read by BOTH the voice-note relay (src/spine/boot.mjs createRadioNoteRelay.relay,
    which drops a blocked sender's note silently — logged, never uploaded) and
    "/radio say" (src/spine/commands.mjs, which replies that relaying is disabled and
    never uploads either) before every upload attempt.

    Since a bare "/radio disable" is heard by every node on the shared Beeper account
    independently (see radio_service, above — no mesh broadcast, no propagation), the
    block lands on every node without any cross-node write.

    LIVE IMMEDIATELY, no restart: the write both persists to config.yaml
    (tools/config-io.mjs writeConfigKey) and mutates the SAME live config object every
    reader (getConfig, and the radio relay's own cfg) already holds, so a relay/say
    attempt made right after "/radio disable <person>" is refused at once.
  `,

  peer_nodes: `
    Node identities sharing THIS Beeper account, INCLUDING self (operator
    2026-07-09) — a LIST of node names, e.g. [kg, do]. Co-account nodes collapse
    to ONE Beeper room member, so this completes the HRW candidate set the 👂
    echo rotation will use (a LATER phase consumes it; for now it is parsed +
    exposed only, NO behavior). Omit for a solo node.

    (Until 2026-10-19 /status <name> and /chrome <name> addressed a NODE by these names; a command
    now names its being instead — "/e status" — so they are ordinary conversation fragments there.)
  `,

  egpt_nodes: `
    The eGPT nodes the operator runs, and HOW TO REACH each one (operator
    2026-09-04: "the table needs to be outputted by a tool, not only here" —
    the topology had been living in chat, retyped as --host flags every time).

    A MAP of node key -> that node's entry, mirroring radio_service's named
    blocks. OPTIONAL, and inert when absent: a single-node install declares none
    of it and behaves EXACTLY as it did before this block existed — the baseline
    tests/single-account-node.test.mjs locks.

      egpt_nodes:
        node-one:
          type: self
          name: NODE-ONE
          ip: 192.0.2.11
          ip_type: reserved
        peer-two:
          type: peer
          name: PEER-TWO
          ip: 192.0.2.12
          ip_type: reserved
          host: peer-two.example.net

    WHAT READS IT: src/tools/beeper-whoami.mjs, the topology table, and nothing
    else — no spine path reads this block. Every entry that is not type: self is
    a PEER the table probes over ssh, so a configured node needs NO --host flag;
    --host still names a node this block does not, and the two are UNIONED and
    deduplicated by SSH TARGET.

    NOTHING HERE IS DISCOVERED. No subnet scan, no ARP, no broadcast, no
    192.168.* assumption: a peer exists because the operator named it. An eGPT
    node can be OFF-LAN entirely, so ip is never the way to reach one — host is.

    KEYS, per <node-key>:
      type
        self | peer — which entry is THIS machine. Exactly one self is expected.
        Two or more is a MISCONFIGURATION that is REPORTED, never resolved by
        picking one: the table says so in a note and leaves the local row
        auto-detected. DEFAULT: peer (an entry with no type is a peer).
      name
        The host name (e.g. NODE-ONE) — the label in the table's host column.
        DEFAULT: this machine's own hostname() for self, the ssh target for a peer.
      ip
        The address the operator knows this node by. On the SELF entry it
        OVERRIDES what os.networkInterfaces() reports: a machine has several
        addresses (LAN, VPN, hypervisor switches) and the operator knows which
        one is THE one. On a PEER it FILLS IN only where ssh did not report the
        address it actually connected to — measured beats declared.
        DEFAULT: what the tool measured, else ?. An off-LAN node may have
        nothing meaningful to put here, which is fine — see host.
      ip_type
        reserved | fixed | dhcp — how that address is held: a DHCP RESERVATION,
        a statically configured address, or an ordinary lease. DOCUMENTATION
        ONLY: nothing reads it and the table does not print it.
      host
        The ssh target — a hostname, a bare IP, an ssh alias, an overlay/VPN
        name. DEFAULT: the map key. THIS, never ip, is how a node is reached:
        an off-LAN node may be reachable only by a tailscale/DNS name.

    NOT peer_nodes, which answers a different question: that lists node
    IDENTITIES sharing ONE Beeper account (they collapse to a single room
    member); this lists MACHINES and how to ssh to them.
  `,

  shell: `
    The operator console — the spine's shell-port limb SERVES ws://127.0.0.1:23475
    from boot and holds it; the egpt editor dials in as a client (direction
    inverted 2026-08-26: the durable process serves, and a held port has no
    unbound window for a local squatter to take).

    SHAPE:
      shell:
        token: <32+ random chars>

    KEYS:
      token   The shared secret the spine challenges the editor with — a nonce
              HMAC handshake, defined once in src/shell/auth.mjs and imported by
              BOTH ends. The secret never rides the wire; a captured response is
              useless on the next connection.

    REQUIRED — with no token the spine does not SERVE the console AT ALL (fail
    closed, no unauthenticated fallback). That is deliberate (operator 2026-08-21):
    the socket used to trust the LOOPBACK itself, treating whatever answered as
    the operator, i.e. a peer authorized to run /upgrade (git pull + npm install,
    unsandboxed). Windows has no per-user loopback namespace and does not filter
    loopback, so a sandboxed CLI account (egpt-sbx-NN) can bind and dial the console
    freely — and back when the EDITOR served it, the port was usually UNBOUND,
    since the editor is only up when the operator opens it. A squatter could
    therefore take the port and wait for the spine to dial it. Loopback is not an
    authenticator; the token is, and holding the port from boot removes the
    squattable window as well.

    The SAME value goes to both ends: the spine reads it here, the editor reads
    it from this same file. Changing it means restarting the spine AND the editor.
  `,

  peer_spine: `
    THE MOUTH LINK (operator 2026-09-05) — the OTHER eGPT spine on this machine,
    the one holding the other Beeper account, and how to speak through it.

    THE ARRANGEMENT. One machine can run TWO spines, one per Beeper account,
    sharing one checkout and differing only by EGPT_HOME. The PRIMARY spine is
    the ear and the brain: it receives, logs, gates and runs the turn exactly as
    it always has. The SECONDARY is the MOUTH: instead of posting the finished
    reply on its own account, the primary hands the text over this link and the
    secondary says it on the other account. A message addressed to the secondary
    alone is answered by the secondary directly, with no link involved.

    SHAPE:
      peer_spine:
        console_port: 23377
        console_token: "<the PEER node's shell.token>"
        accounts: ["+15550000001", "+15550000002"]

    KEYS:
      console_port
              The PEER's console port — its shell.port (default 23475). The link
              rides the peer's console listener rather than a port of its own:
              the handshake, the bind-at-boot-and-HOLD property and the squatter
              protection are already solved there (see shell). A peer dials it on
              the path /peer, which is what tells the peer's limb it is a spine
              wanting a line said and not the operator's editor wanting a seat.
      console_token
              The PEER's shell.token — the secret this node proves it holds when
              it dials. Same nonce/HMAC challenge the editor answers, same module
              (src/shell/auth.mjs), no relaxation: loopback is not an
              authenticator, since a sandboxed local account can dial 127.0.0.1
              as freely as the peer spine can. Wrong or unset = refused.
      accounts
              The phone identities of BOTH accounts, in any form (+1 555 000
              0001, +15550000001, 15550000001 - compared on digits). These are
              EXCLUDED when a chat is keyed across the two accounts, and that
              exclusion is the whole reason two views of one group compare equal.
              Beeper is Matrix, so each account sees the same real group as its
              OWN room: nothing in the two payloads is shared and a chatId cannot
              cross the link. What can is the set of participant PHONE NUMBERS
              (src/bridges/beeper.mjs crossAccountChatKey). An account's own entry
              in its own roster carries no phone number at all, so dropping SELF
              is automatic - but each account sees the OTHER as an ordinary member
              WITH a number, and that is the one difference left between the two
              views. List both, on BOTH nodes: the values must match or the two
              spines cannot agree on which chat is which. Fewer than two
              identities is refused rather than half-working.

    WHEN THE PEER SPEAKS, decided per reply in the reply path itself
    (src/spine/sender.mjs, the one place): if this block is set AND one of the
    accounts identities is a participant of the chat being replied in - i.e.
    the co-account is in that chat - the finished text is handed over the link
    and said there. Otherwise the reply is posted on this node's own account,
    unchanged, with no dial at all. Membership that cannot be READ (a failed
    chat GET, a payload with no roster) counts as absent: this node says it
    itself. A mode:auto reply is never routed - the whole point of that mode is
    that it reads as the operator's own typing, on the operator's own account.

    AND IT ALWAYS ARRIVES. Every refusal listed above falls back to a post on
    this node's own account, logged loudly under [mouth]. That is the INVERSE of
    the fail-closed rule the refusals themselves follow, deliberately: a reply
    said by the wrong mouth is cosmetic, a reply that never arrives is not.

    THE PLACEHOLDER IS NOT ROUTED, IT IS SUPPRESSED. A reply normally posts a
    "thinking" placeholder and edits it in place as the turn streams. On a
    peer-routed chat that placeholder is never opened, because opening it would
    stream the whole answer on THIS account and then say it again on the other.
    So nothing at all is posted here. The price is that the instant ack waits
    for the membership answer (normally a cached read).

    ABSENT = NO PEER: no dialling, no link, and a /peer dial to this node's own
    console is closed on the spot. A node that configures none of this behaves
    exactly as it did before the block existed (tests/peer-mouth.test.mjs locks
    that first; tests/mouth-routing.test.mjs locks the reply path's half).

    SYMMETRIC. Each node's block names the OTHER node's console port and token,
    and both carry the same accounts list, so either spine can be the mouth.

    FAIL CLOSED, LOUDLY. A reply in the wrong chat is worse than no reply - it is
    public before anyone notices. So the receiving node refuses to post when NO
    chat of its own keys to what it was sent, and refuses just as hard when MORE
    THAN ONE does; the speaking node refuses before it dials when its own chat
    cannot be keyed at all (no roster, or fewer than two identities left after
    the exclusions). Every refusal is reported back over the same socket so the
    caller can fall back to speaking on its own account.

    NOT peer_nodes, which answers a different question: that lists node
    IDENTITIES sharing ONE Beeper account. This names a spine on ANOTHER account.

    FINAL TEXT ONLY. The link carries a finished line. Streaming a reply across
    it (the thinking placeholder and its in-place edits) means relaying a message
    IDENTITY across two accounts, and is deliberately out of scope.
  `,

  networks: `
    Per-surface config wrapper (operator 2026-07-09).

    SHAPE:
      whatsapp | telegram | signal:
        chat_ids
          STABLE command-channel ids — chats that accept /agents, /restart, … ; a
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

    FALLBACK CHAIN: this key → peer_nodes → [node_name] (a solo node is
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
        RETIRED AS A FLAT REGISTRY KEY (operator ruling 2026-07-26, ONE key).
        This block is the LEGACY engine shape; the live home for the whole
        concern — engines, paths and the post-back variables — is
        transcription_service:, resolved across the THREE rungs of
        src/spine/config-resolver.mjs:
          config/config.yaml < config/conversations.yaml (the entry)
                             < <entity>/config.yaml     — nearest wins.
        So a conversation now writes transcription_service.posts_back_delay_ms
        at whichever rung it wants, not a flat posts_back_delay_ms on its
        registry record. Value semantics are unchanged:
          unset/null        = the rung above
          -1 (any negative) = NEVER echo the 👂 (still HEARD: the model +
                              transcript.md get it, it is just not SPOKEN)
          0                 = immediate
          N                 = N ms debounce
        The old PRECEDENCE is gone with the old key: a registry delay used to
        force posts_back TRUE even against a folder's posts_back:false. That was
        back-compat, and it is plain rung order now — nearest the room wins.
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
    THE ONE TRANSCRIPTION KEY (operator ruling 2026-07-26: "on transcriptions
    can be joined under the same key; the configurations 'remote', 'cli', etc,
    the paths, the post-back variables, etc"). Declarative per-note fallback
    (docs/TRANSCRIPTION-SERVICE-PLAN.md; supersedes the transcription.mode
    shape).

    IT IS A RUNG-RESOLVED KEY, not a node-only one. The same name is read at all
    three rungs of src/spine/config-resolver.mjs, deep-merged per leaf so a
    folder pinning one flag keeps the node's engine chain:
      config/config.yaml < config/conversations.yaml (the entry)
                         < <entity>/config.yaml      — nearest the room wins.
    It replaced the three differently-named homes this concern used to have: the
    node's transcription_service:, the entity folder's transcription:, and a
    flat posts_back_delay_ms on the conversations.yaml record. No migration
    (operator: "do not concern about live profiles") — the old names are simply
    not read any more.

    KEYS:
      enabled
        On/off at this rung. DEFAULT: on. HEARD — transcribe at all.
      posts_back
        SPOKEN — echo the 👂 transcript into the chat. DEFAULT: OFF, OPT-IN —
        only an explicit true (the boolean; a stringy yes is not one) turns it
        on. Typically set at an entity rung. Operator ruling 2026-09-13
        ("postback must default to false, true is an 'unsafe' default"): it used
        to default on, and a profile carrying no transcription_service: block at
        all auto-enrolled and posted 👂 transcripts into real group chats.
        Hearing is invisible and stays default-on; speaking into a chat is not.
      posts_back_delay_ms
        Trailing debounce before the echo. Negative = never echo (still HEARD).
        0 = immediate. Absent = the rung above, then the shared floor.
      listening_reaction
        🎧 on a voice note while this node decodes it, off when done.
        ENUM: false (DEFAULT) | true | "operator" — operator = only notes the
        operator sent (isSender or networks.<surface>.allowed_users, the same
        check that authorizes commands). Operator 2026-10-18: an automatic
        reaction reaches whoever sent the note. Per chat, on its
        conversations.yaml entry: transcription_service: { listening_reaction: true }
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
          type: "whisper-server-ecs"
            whisper-server in an ECS service that sleeps at desired count 0.
              cluster, service, region, port (DEFAULT 8089)
              credentials         secrets/<name>: line 1 key id, line 2 secret
              wake_timeout_ms     a note waits at most this for a ready task,
                                  then the next engine. DEFAULT: 240000
              idle_stop_ms        desired 0 after this long with no note in
                                  flight (also armed at boot). DEFAULT: 1200000
              cooldown_ms         after a failed wake: one quick check per note
                                  (a task already up?), no wait, no wake.
                                  DEFAULT: 600000
              poll_ms             task poll while waking. DEFAULT: 5000
              connect_timeout_ms  GET / readiness probe. DEFAULT: 3000
              timeout_ms          DECODE budget. DEFAULT: 120000
              language            wins over the cli's language on this rung
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
      peer_priority  <- legacy top-level echo_priority → peer_nodes →
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

  synthesizer: `
    WORKER-spine role block (the GPU box, e.g. DOLLY; REVE must NOT set this) — the
    text-to-speech counterpart to transcriptor: above. Piper renders the text, ffmpeg
    transcodes to Opus/ogg.

    KEYS:
      enabled
        true = this egpt service answers POST /v1/synthesize for a main spine; it holds
        NO conversation context and sends NOTHING outbound.
      port
        DEFAULT: 23391 — what a remote spine's voice_service endpoint points at.
      bind
        DEFAULT: "127.0.0.1" — set "0.0.0.0" or this machine's LAN ip to accept the main
        spine. NEVER expose to the internet.
      server
        token  HMAC auth (same value on the worker + the main spine's voice_service
               engine block); unsigned/stale requests are rejected and logged.
      ffmpeg_command
        ffmpeg path for the WAV->Opus/ogg transcode. DEFAULT: "ffmpeg" (PATH lookup).
        Deliberately NOT shared with transcription.cli.ffmpeg_command — set it again
        here if the same binary should serve both.

    The piper binary + voice models are NOT config: pythonPath and voicesDir are derived
    from the RADIO_PIPER environment variable (venv/Scripts/python.exe and voices/ under
    it) — machine-local layout, not a portable config value. Missing RADIO_PIPER refuses
    to start (logged), same as a missing token.

    voice is whitelisted per-request against the .onnx files actually present in
    voicesDir — an unrecognized voice is a 400, never an attempted file open.
  `,

  voice_service: `
    Client-side TTS config — the voice_service.js analog of transcription_service: above
    (rung-resolved the same way, across config/config.yaml < config/conversations.yaml
    < <entity>/config.yaml, nearest the room wins), minus the echo/HRW section (that
    problem is specific to transcription's double-post race and does not apply here —
    a voice reply is sent by exactly one spine, the one running the turn).

    KEYS:
      use_config
        Name of the active profile.
      <profile-name>
        voice
          The voice name this profile renders replies as by default (e.g.
          "es_MX-claude-high") — must match a model file the worker's
          voicesDir actually contains.
        fallback_order
          [<engine-name>...] — tried in order, first successful render wins.
        <engine-name>
          type: "piper-server-remote"
            POST to endpoint + token (HMAC), the same scheme transcription's
            whisper-server-remote uses.
              endpoint            e.g. "http://192.168.1.102:23391"
              token               HMAC auth; SAME value as the worker's synthesizer.server.token
              connect_timeout_ms  liveness probe — fail fast if the endpoint is down.
                                  DEFAULT: 3000
              timeout_ms          render/decode budget. DEFAULT: 20000
              cooldown_ms         circuit-breaker — a failed/unreachable remote is
                                  SKIPPED until it elapses. DEFAULT: 30000
  `,

  rooms: `
    Multi-member rooms config.

    KEYS:
      routing_enabled
        Boolean. DEFAULT: FALSE — the MASTER SAFETY SWITCH for live room
        fan-out. While false, /rooms commands still configure rooms but NO
        message routing happens. Flip true to let a contributing member message
        fan to the room's other members + shared transcript. Default off because
        a routing loop bug would spam real groups; enable + verify on a test
        room first.

    A room's roster lives in the ROOM'S OWN config.yaml — a room is a
    conversation on surface "room", so that is
    ~/.egpt/conversations/room/<name>/config.yaml (managed via /members), not
    here.
  `,
  agents: `
    Unified agent registry (operator 2026-07-02, new-config-only) — the ONE
    block for local beings + mesh addressing.

    REQUIRED: boot fails without an agents block. There is NO default agent
    (operator 2026-10-22): every agent whose mode in a chat is on/auto takes
    every line there, a named one takes it by its own mode, nobody on and
    nobody named → recorded, no reply.

    A map of canonical name -> the fields below.

    AGENT FIELDS:
      configuration
        The agent's brain def, in ONE of TWO forms (operator 2026-09-07). Both
        resolve through the SAME registry entry point (src/spine/brains.mjs
        resolve).

        1. A STRING — the bare NAME of an agent-type file,
           config/agents/<name>.yaml, merged across the layers:
             src/brains built-in < config/agents < a conversation's brains/
           e.g. configuration: "sonnet-high" points at
           config/agents/sonnet-high.yaml. A NAME, never a path: a value
           carrying / or \\ is rejected loudly, not joined.

        2. An INLINE MAP — the def written straight here:
             configuration:
               type: ccode
               model: haiku
               effort: low
               verbose_thinking: true
               personality: egpt
           An inline map has no filename, so it is NOT merged with any layer —
           not the shipped src/brains file, not config/agents/<x>.yaml, not a
           conversation's brains/, even if one shares its name. What is written
           here is the whole def.

        For a relay agent, configuration is the literal "relay" (a STRING; an
        inline map is never a relay), or simply absent.

        A configuration that is neither — a list, a number, an empty map, a
        path-shaped string — THROWS at resolution, naming the agent. It is
        never silently swapped for a default.

        OVERRIDDEN PER CONVERSATION (operator 2026-09-17) in conversations.yaml:
        contacts.<surface>[<id>].agents.<name>.configuration, in either form.
        It joins the room scope like access_level. An unusable value there (the
        refusals above, or a name with no file) is logged on every turn and
        the agent runs on this configuration instead.
      handles
        ["e","egpt",...] — the @<token>s that WAKE this agent (operator
        2026-07-26: "the yaml key can be discarded, an agent reacts if its
        handle is invoked").

        DECLARED  = the COMPLETE wake list; the map KEY does NOT route.
        ABSENT    = the map key serves as the handle.
        []        = a complete list that is empty: NO @token reaches this
                    agent.

        The map KEY is still the BEING-ID (warm sessions / thread blocks /
        transcripts) — it simply stopped being an address. This is what lets a
        node keyed "egpt" display and answer as "don" WITHOUT also answering
        @egpt, which is how one message got two replies across the two spines.
      voice_handles
        ["perrito","perro",...] — SPOKEN aliases that wake this agent from a
        voice note's whisper TRANSCRIPT, matched at the START of the transcript
        (never \`@\`-prefixed — whisper output never produces one; the start is
        the same rule a bare \`handles\` token follows. Operator 2026-09-09: it
        used to match anywhere in the sentence, which woke beings on ordinary
        words — "el rey", "un perro"). A sibling list to \`handles\`, not an
        extension of it: text and voice wake independently.

        DECLARED  = the COMPLETE spoken-alias list.
        ABSENT    = no spoken alias reaches this agent — unlike \`handles\`,
                    there is NO map-key fallback.
        []        = same as absent: no voice wake.
      fallback_handle
        OPTIONAL (operator 2026-08-31) — ONE MORE @token this agent wakes on,
        but ONLY where a named OTHER identity is not in the chat:

          fallback_handle: { handle: e,        unless_present: "+13472576794" }
          fallback_handle: { handle: [d, don], unless_present: "+13472576794" }

        reads "also wake on @e, unless +1347… is a participant here". Where
        that identity IS present the token belongs to the OTHER account's
        agent and this node stays silent — which is what keeps one @e from
        waking two spines.

        WHY IT EXISTS: kg and do stopped sharing one Beeper account. do runs on
        a second account (+1 347…, "Rodz") and carries a relay agent \`e\` that
        forwards to ekg.kg, so @e is ANSWERED by kg's brain but POSTED from a
        visibly different account — the point of the arrangement. The cost is
        that \`e\` became a handle on do ONLY, so in every chat the 347 account
        never joined — most chats, and every room — @e reached nobody.

        SHAPE: both keys REQUIRED. A declaration missing either is IGNORED —
        a \`handle\` with no \`unless_present\` would be an unconditional extra
        wake token, which is what \`handles\` is for.
        \`handle\` is a STRING **or a LIST** (operator 2026-09-01), the same
        shape \`handles\` has: each node reaches the other's persona through a
        relay agent gated by this token, and a persona answers to more than one
        name — do's to \`d\` AND \`don\`, kg's to \`e\` AND \`egpt\`. Every token
        in the list carries the SAME unless_present, because the list is ONE
        peer agent's addresses, not several policies. Blank entries are dropped;
        an all-blank list is the same as declaring no fallback.
        unless_present takes a PHONE NUMBER (compared on digits only, so any
        punctuation works) — the one identifier that means the same thing on
        both accounts — or a raw participant id (shortChatId-normalized, same
        as allowed_users).

        SELF-CONTAINED: this node declares only the handle and the identity
        that pre-empts it. It reads nothing of the other node's config.

        MEMBERSHIP, NOT LIVENESS: "did the other node answer?" is unusable —
        it may just be slow, so every message would carry a timeout.
        Membership is static and answered LOCALLY from this account's copy of
        the chat (bridge chatHasParticipant: cached, 15m TTL, no round trip
        for a 1:1). A ROOM (surface \`room\`) has no participants at all, so
        the peer is DEFINITELY absent there and the fallback always applies.
        If membership cannot be established at all, the agent does NOT wake
        (the token stays its owner's) and the reason is logged — the declared
        \`handles\` above are unconditional and always work.
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
      use   (alias, older spelling: beeper_connection)
        OPTIONAL (operator 2026-08-30; spelled use: since 2026-09-10) — names
        a <name> block under the top-level beeper: (above) this agent's outbound
        replies ride, for a node wired to MORE THAN ONE Beeper account. use:
        wins if an agent carries both. OUTPUT ONLY: it cannot make that
        connection an ear, and the node still hears where beeper:'s ear rules
        say it does. ABSENT ⇒ this node's ordinary
        single-connection resolution (beeper.use) — NOT the literal 'main':
        a beeper: { main: {...} } block with no use key falls through to
        beeper_token/the BEEPER_ACCESS_TOKEN env var today, and an absent
        beeper_connection must keep landing there too, never on a guessed
        'main' entry. One bridge instance is opened per DISTINCT TOKEN actually
        referenced across every agent (dedup by the resolved token, not the
        connection name) — a node where no agent sets this collapses to
        exactly one bridge, byte-identical to before. Applies to this agent's
        own OUTBOUND sends (the sender + reply-actions limbs); inbound
        dispatch, mesh relay, and node-lifecycle posts (restart announce, /ask
        advice channel, operator commands) are unaffected and still ride the
        node's single default connection.
      name
        Display label the bridge stamps as "<body_emoji> <name>: <reply>".
        DEFAULT: the map key.
      default
        RETIRED (2026-10-22), ignored — boot logs one line per agent carrying it.
        (A conversation's OWN agents.<name>.default: true in conversations.yaml
        is a different thing: that chat's owner; see heartbeats.)
      heartbeats
        OPTIONAL Boolean (operator 2026-10-15). false = a conversation whose
        own default agent this is (conversations.yaml agents.<name>.default:
        true, e.g. one dispatch.stranger_agent seeded) loads NO heartbeats —
        neither its rungs' blocks nor its heartbeats/*.yaml files are read.
        See src/spine/config-resolver.mjs.
      actions
        OPTIONAL list (operator 2026-10-15) of the spine-executed limbs this
        agent may emit: book, email (top-level book: / email:). Absent = none:
        the verb is refused and logged, never run.
      public
        OPTIONAL Boolean (operator 2026-10-15). true = a public-facing agent
        (edw-marketer): the person in its chat sees only its reply text - no
        "⏳ Thinking…" placeholder, no persona prefix, no visible signature
        (the invisible node frame stays), no error line. A failed or empty
        turn is noticed in admin_channel instead (src/spine/sender.mjs plain
        branch, src/bridges/persona-wrap.mjs).
      mode
        OPTIONAL (operator 2026-07-25) — THIS agent's own default reply-mode.
        ENUM: on | auto | mute | mention-direct | mention | accum | off

        'mute' (operator 2026-10-16) is LOG ONLY: the chat is recorded like
        any non-off mode (transcript, media, voice), but the agent runs no
        turn at all - not even when an allowed user calls it by handle.
        'off' records nothing.

        'accum' (operator 2026-07-26) GATES EXACTLY LIKE 'mention' — same
        answer for every mention state — and additionally PROMPTS the turn it
        allows with everything this conversation recorded SINCE THIS AGENT'S
        LAST TURN, labelled beside the triggering line ("THIS LINE IS THE
        PROMPT … THE FOLLOWING IS ACCUMULATED CONTEXT"). Why: send_to_egpt:
        'mode' means the agent only runs a turn on messages it will ANSWER, so
        everything in between never reaches it — the 2026-07-26 incident, an
        un-@mentioned message about skin cells then "@e da una opinión bien
        fundamentada", answered from the topic of twenty minutes earlier.
        (send_to_egpt itself is retired, 2026-10-23.)
        ⚠ THE NAME IS REUSED, THE MECHANISM IS NOT: the ORIGINAL accum (retired
        2026-07-01) buffered a chat's bursts and flushed the batch once per
        heartbeat. This one does NOT batch, does NOT touch the heartbeat and
        does NOT change WHEN a turn runs — only what it is prompted with.
        The window is the GAP, not a time span: the boundary is this agent's own
        reply LINE in transcript.md, read backwards from the end (a withheld
        reply counts — that turn ran; an agent that never replied here gets the
        whole tail). No clock parsed, no state kept, no second store. Bounded
        by an 8000-character CONSTANT that keeps the MOST RECENT part and says
        so. Source: src/transcript-log.mjs, src/spine/spine.mjs runReplyTurn.

        It is the rung between the per-conversation mode and the node-wide
        dispatch.auto_default_mode, so two agents can hold DIFFERENT modes in
        the SAME chat — e.g.  e: {mode: mention}  answers a mid-sentence @e
        while  don: {mode: mention-direct}  stays silent unless named at the
        head. Applies to a RELAY agent too: a mesh target is gated as its OWN
        agent.
        DEFAULT: absent ⇒ dispatch.auto_default_mode, for every agent alike.
        ⚠ It applies in EVERY chat the node hears: "on"/"auto" here means this
        agent answers every line everywhere (boot warns). Set those per
        conversation instead.
        OVERRIDABLE PER CONVERSATION in conversations.yaml under the entry's
        agents: block — contacts.<surface>[<id>].agents.<name>.mode — which
        layers over the entry's existing <name>: block field-by-field, so an
        operator can pin one agent's mode in one chat without disturbing the
        threadId/readonly the spine writes there.
      paths
        Marks a MULTIPATH relay - a LIST of single-key maps
        { <label>: { relay_channel, network?, to? } }, one per path; every
        message goes through every path (operator 2026-07-06). The agent is an
        ordinary map, so it carries handles:/surface:/mode: like any other
        (operator 2026-07-26). Multipath used to be the agent VALUE itself
        being that list, which left it addressable only by its map key.
      conversation_defaults
        OPTIONAL (operator 2026-08-15) - a sub-block of this agent's GLOBAL
        defaults for the fields below, each overridable per conversation. The
        NESTING is deliberate and IS the allowlist: only a field living inside
        conversation_defaults ever gets the two-tier "global default,
        per-conversation override" treatment; a REGISTRY/structural field
        sitting as this agent's direct sibling (handles, configuration,
        relay_channel, default, name, body_emoji, …) never does, by
        construction - no code-side allowlist to keep in sync as fields are
        added. A third two-tier field needs no code change to become one:
        just nest it here and read it the same generic way.
          allowed_users
            A list of sender ids (same shape/normalization as
            networks.*.allowed_users - matched via shortChatId, so a short or
            legacy full-form id both work). UNSET = reachable by anyone who
            could normally address this agent (today's ordinary default for a
            plain agent). Set = ONLY a sender whose id is in the list can
            reach it; every other sender's @mention falls through exactly as
            if it never matched (silent, same convention as the surface pin).
            No mode is above it (operator 2026-10-16): such a sender never
            wakes this agent, not by handle, quote-reply, the persona
            fall-through or an 'on' chat; the line is still recorded.

            Replaces the retired TYPE-FILE dangerous: true reachability
            mechanism (meta-engineer.yaml, evicted 2026-08-15 - "i think the
            'dangerous' key is mistake"). dangerously_skip_permissions: true on
            a type file is STILL a real, meaningful flag - see CONFINEMENT
            below - it is just no longer a reachability gate; who may trigger an agent is
            controlled here and by access_level instead. Independent of
            ev.authorized/isSender (the existing per-NETWORK allowed_users/
            account-owner concept, networks.*.allowed_users) - this is a
            narrower, per-being gate and never reuses that signal.
          access_level
            ENUM: regular | all | sandbox. Points this agent at
            config/permissions/<level>.md (src/spine/permission-levels.mjs),
            resolved fresh every turn (brainpool.mjs) - never a freeze.

            UNSET = 'sandbox' (operator 2026-09-23: "all agents sandboxed, but
            the meta engineers"). Silence is not an absence of a level: it
            resolves to the OS box, which resolveSandboxed then FORCES on (its
            rung 1), so a being that declares nothing runs inside a Windows
            logon session whose ACEs are its only boundary. It was 'regular'
            until that ruling, i.e. silence meant a CLI-flag boundary that the
            being's own Bash walks past. A meta engineer must therefore declare
            access_level: all explicitly - the shipped skeleton's wren does.

            A ccode TYPE FILE that declares its own top-level allowed_tools
            NARROWS the level's list to (level ∩ type), sent to the CLI as
            --tools so unlisted tools do not exist, boxed or not (2026-10-15).
            A type with no list gets the level's whole list.

            All three are the SAME values /agents <handle>|all
            access_level <level> writes per-conversation - that validator and
            this enum are the same list, ACCESS_LEVELS in
            src/spine/permission-levels.mjs, so a fourth tier cannot reach one
            without the other (2026-09-05).

            regular
              The confined tier. config/permissions/regular.md is a LIST grant
              (DEFAULT_ALLOWED_TOOLS), so brainpool's confinementFor pins the
              file tools to the conversation's own folder: no bare Bash, no
              bare Agent, no filesystem beyond the room.

            all
              Unconfined at the CLI level - dangerously_skip_permissions plus
              bare Bash/Agent and no path confinement, exactly like an
              interactive claude session. STRUCTURALLY REFUSED when no
              allowed_users is set at either tier (brainpool.mjs's gate): it is
              unconfined capability AND reachable-by-anyone TOGETHER that is
              dangerous, so an 'all' being must name who may reach it (['*'] is
              the explicit "anyone").

            sandbox
              (operator 2026-09-05) all's CAPABILITY, but only ever inside the
              OS sandbox. config/permissions/sandbox.md is all.md's grant
              verbatim - same flag, same tool list - and this level additionally
              FORCES sandboxed: true, ahead of the whole two-tier walk below, so
              no rung can run a 'sandbox' being unboxed and (like every explicit
              request) it is not downgraded per platform. The reasoning is ONE
              boundary instead of two overlapping ones: the kernel-enforced box
              REPLACES the CLI-enforced confinement rather than layering over
              it, so the CLI-level one is dropped on purpose.

              EXEMPT from the allowed_users requirement 'all' carries, also on
              purpose: the blast radius of a 'sandbox' turn is one ACL'd folder,
              so such a being may be left reachable by anyone with no list set.
              brainpool.mjs's gate therefore tests === 'all' and must keep
              testing exactly that.

          sandboxed
            boolean (operator 2026-08-20). UNSET is PLATFORM-AWARE (operator
            2026-09-04): true on Windows, false everywhere else. IGNORED
            ENTIRELY when access_level is 'sandbox' (operator 2026-09-05) -
            that level forces true ahead of both tiers, because a 'sandbox'
            being running unboxed would make the level's name a lie.

            WRITING IT THERE ANYWAY IS A FATAL BOOT (operator 2026-09-13):
            access_level 'sandbox' + sandboxed: false in one
            conversation_defaults block is a DEAD line that reads exactly like
            an override, which is how this field got explained wrongly twice in
            one session, so the spine refuses to start until the line is removed
            or the level is changed. conversations.yaml's per-conversation copy
            of the same field cannot be caught at boot (hand-edited, never
            frozen) - brainpool logs that contradiction on every turn instead.

            The isolation below is Windows machinery, so a default of true
            failed a fresh clone on macOS/Linux on its FIRST turn. A DEFAULT
            may be platform-aware because nobody asked for it; an EXPLICIT true
            may not be - it resolves true on every platform, and a non-Windows
            node then REFUSES the session loudly rather than run unsandboxed
            behind a key that claims otherwise. false = the being's warm CLI
            process runs like any other, confined only by whatever
            access_level/allowed_tools already apply. true (meaningful when
            access_level is 'all'; FORCED, and so redundant to write, when it
            is 'sandbox'): the being's warm CLI process is launched under a
            dedicated Windows logon session - LogonUser against the one shared local
            'egpt-sandbox' account (a fresh, unique logon SID every warm
            session) + a read/write ACE scoped to exactly that conversation's
            own folder - via setup/sandbox-logon-launcher.ps1. This is OS-
            level confinement, layered UNDERNEATH access_level:'all' (and the
            ONLY confinement under access_level:'sandbox'), which
            already grants unconfined Bash / no path confinement at the
            CLI-flag level (dangerously_skip_permissions) - sandboxed:true
            does not change that CLI-flag grant, it bounds what the OS itself
            will let the process touch on disk regardless of it.

          verbose_thinking
            boolean (operator 2026-08-29 for the field, 2026-08-30 for THIS
            tier - "verbose thinking should be controlled from config.yaml
            rather than the agent.yaml"). UNSET/false = the reply is the
            engine's final answer only. true = this agent's replies also carry
            its chain of thought - warm-cli-session taps every assistant
            event's thinking blocks and renders them above the answer, with
            tool calls collapsed to bare stubs (wren's "see your full chain of
            thought").

            THE ONE conversation_defaults field with a THIRD tier BELOW these
            two: the same key on the AGENT-TYPE FILE (config/agents/<type>.yaml
            - the field's original and still-supported home, see the type-file
            note under CONFINEMENT below). Full precedence, highest first:
            conversations.yaml agents.<name>.verbose_thinking, then this key,
            then the type file's, then false. Each tier is consulted only when
            the one above it is UNSET - an explicit  verbose_thinking: false
            here is a real opt-out that stops the walk, and does NOT fall
            through to a type file that says true. That is the point of this
            tier: a type file is shared by every agent pointed at it, so it
            could not express "verbose for THIS agent" (or "for this one
            conversation") on its own.

          allow_new_input
            none | same_sender | any  -  DEFAULT same_sender, AND THAT DEFAULT
            HAS ONLY BEEN TESTED WITH ccode (operator 2026-08-30). An ORDERED
            enum (widest last) deciding what happens to a message that arrives
            while this agent is ALREADY streaming a turn in that conversation:

              none         today's behavior - the message QUEUES on the
                           per-conversation FIFO and is prompted into the NEXT
                           turn, under its own placeholder.
              same_sender  a message from the SAME sender whose message
                           triggered the in-flight turn STEERS it: the line is
                           written into the live CLI session's stdin and the
                           running turn answers it, in ONE reply, with NO
                           second placeholder. Anyone else queues.
              any          ANY sender in the conversation steers the in-flight
                           turn (a bystander can redirect someone else's live
                           answer). Everything else is as same_sender.

            WHY IT WORKS, AND WHY THE ccode CAVEAT: measured 2026-08-30 against
            the real "claude --input-format stream-json" CLI. A second user
            line written to a live stdin mid-turn is ABSORBED by an AGENTIC
            turn at a tool boundary - one result, answering the NEW
            instruction, the rest of the original plan abandoned - while a
            PURE-TEXT turn instead finishes its original task and answers the
            new message separately (two replies, nothing lost). Only ccode was
            driven: pi is a different harness and is UNTESTED, llama is plain
            HTTP request/response with no stream to interrupt. Neither exports
            the session-level inject() this rides on, so with either brain
            EVERY value here behaves exactly like none. The enum is the POLICY;
            the session primitive is the CAPABILITY, and the capability is what
            actually gates it.

            An unrecognized value is NOT fatal: it logs and falls back to the
            default (a typo in config.yaml must not take a conversation down).

        OVERRIDDEN PER CONVERSATION in conversations.yaml under the entry's
        agents: block - contacts.<surface>[<id>].agents.<name>.allowed_users /
        .access_level / .sandboxed / .verbose_thinking / .allow_new_input - FLAT there (no conversation_defaults
        wrapper: that block is already scoped to one being in one
        conversation, so there is no registry-field ambiguity to guard
        against). When set, the per-conversation value REPLACES this global
        default for that one conversation (never merged/unioned with it);
        unset there falls back to this global default, then to "no override"
        (today's behavior).

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

    EVERY AGENT is its own identity source (label = its name, emoji = its
    body_emoji); routing to it yields its MAP KEY as the being-id, which keys
    warm sessions / threads / transcripts — no hardcoded e/egpt anywhere, so
    renaming the key is a NEW identity, resetting that agent's warm session +
    threads. There is no default agent (2026-10-22).

    CONFINEMENT (2026-07-02): a type file's allowed_tools value sets the honest
    contract — the norm is to list tools explicitly.

    ENGINE-SPECIFIC TOOL NAMES (operator 2026-08-25). allowed_tools is a list of
    THIS ENGINE's tool names, and they are not shared across engines:
      ccode / codex  Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task
      pi             read, bash, edit, write, grep, find, ls   (lowercase)
      llama          none — the llama brain is a chatter, its tool loop is the
                     separate local_llm.agentic switch
    pi-cli-session reads the list ALL-OR-NOTHING: a list naming any non-pi tool
    is ignored and pi's own defaults (all seven) stay on. That is deliberate —
    a ccode list lowercases 'Read' onto pi's 'read', and honouring that partial
    overlap would silently leave the being READ-ONLY, which is worse than
    ignoring the list. Note 'bash' is in pi's default set: a pi-engined being
    can run commands unless the type file says otherwise.
      a LIST (a YAML vertical list of tool names)
        = CONFINED: its file tools are path-limited to the conversation
        directory (the one listed in conversations.yaml) plus any allowed_paths.
      "all" (or "*")
        Accepted but discouraged — TRUSTED/unconfined (full filesystem, no
        prompts) except bare Bash and Agent. Never implicit (operator
        2026-07-03).
      dangerously_skip_permissions: true (on the TYPE FILE, not here) is the ONE exception to
        this whole confinement model — full filesystem, its allowed_tools
        list runs verbatim (no coercion, no cap), no sandbox, exactly like an
        interactive claude-code session. A pure CAPABILITY declaration (what
        the type CAN do) — it grants no reachability by itself; WHO may
        trigger an agent carrying it is controlled by this agent's own
        conversation_defaults.allowed_users / .access_level fields above
        (operator 2026-08-15 — the type-file "dangerous" flag used to ALSO
        gate reachability; that conflation was retired as a mistake).
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
    set  personality: <name>  to pin the config/agents/identities/<name>.md feed
    a fresh conversation boots from; absent ⇒ "egpt". There is no
    per-conversation personality key.

    VERBOSE_THINKING is ALSO settable on the TYPE FILE (operator 2026-08-29):
    verbose_thinking: true  in config/agents/<type>.yaml makes every agent
    pointed at that type render its chain of thought above its answers. Unlike
    personality this is NOT type-file-only — it is the LOWEST of three tiers,
    outranked by conversation_defaults.verbose_thinking above and by the
    per-conversation override in conversations.yaml (operator 2026-08-30:
    "verbose thinking should be controlled from config.yaml rather than the
    agent.yaml"). Prefer the config.yaml tier: the type file cannot say
    "verbose for this ONE agent/chat", because a type is shared by every agent
    that names it. Kept working for the profiles that already set it here.

    EXAMPLE:
      { egpt: { configuration: sonnet-high, handles: [e, egpt], default: true },
        don:  { configuration: relay, relay_channel: Rodz } }
  `,

  allowed_paths: `
    The NODE-WIDE read/write grant (operator 2026-09-20: "all agents see an
    src/ directory ... we can 'leak' my own src/ to the agent (read-only for
    now)"). One place to grant a folder to EVERY being on this node, and one
    place to revoke it.

      DEFAULT: unset - no being is granted anything it did not declare
      itself, which is exactly the behaviour before this key existed.

    SAME SHAPE as a type file's own allowed_paths (see agents above):

      allowed_paths:
        C:/Users/an/src:
          allowed_tools: [ Read, Glob, Grep ]   # read-only
        C:/shared/scratch:                      # empty value = full access

    HOW IT APPLIES: src/spine/brainpool.mjs's resolveBeingDef merges this map
    into EVERY being's resolved def (withNodeAllowedPaths), UNDER the def's
    own entries, so the one allowed_paths walk has one map.

    WHERE IT LANDS depends on whether the being is OS-sandboxed, and since
    2026-09-23 it is one place or the other, never both. SANDBOXED: the OS
    layer only - sandboxSharePathsFor, i.e. the launcher's per-turn
    -SharePath / -SharePathReadOnly ACE. No --add-dir and no deny rules are
    emitted at all; the ACE is the boundary and the kernel checks it on every
    open. NOT SANDBOXED (access_level regular on a node with no box): the CLI
    layer only - confinementFor's --add-dir and read-only deny rules, which
    are then that being's only boundary and are untouched.

    THE DEF WINS. A being whose type file names the SAME path keeps its own,
    possibly narrower, grant - a node-wide line added later never widens it.
    Paths are compared as the walk reads them (msys /c/Users/.. and windows
    forms are one path, not two).

    THE OS HALF IS SEPARATE. Under the sandbox the leased pool account also
    needs a real filesystem ACE on the folder; that is what the share list
    above grants per turn, but the folder must still be reachable by the pool
    group at all (setup/SANDBOX.md).
  `,

  global_read_paths: `
    Folders EVERY sandboxed being on this node can read, each mounted in its
    home beside \`src\` under the name given here (operator 2026-09-28: "please
    frame this in config.yaml as global_read_paths list"). A LIST of one-key
    maps, <mount name>: <path>:

      global_read_paths:
        - repos: C:/Users/an/src/siran      # ~/repos in every pool profile

      DEFAULT: unset (or empty) - no extra mount and no grant, exactly the
      behaviour before this key existed.

    HOW IT DIFFERS FROM allowed_paths ABOVE. allowed_paths is PER TURN: a
    share ACE for the leased pool account, granted at launch and revoked with
    the lease (and --add-dir for an unboxed being). global_read_paths is
    STANDING: setup/provision-sandbox-account.ps1 grants the pool GROUP
    inheritable ReadAndExecute on each path ONCE - a DACL write on a big tree
    re-propagates over all of it, which a turn cannot afford - and the
    launcher plants a junction of that name in every pool profile on every
    lease. For big trees read by every being; the grant is read-only.
    Unboxed beings get nothing from it.

    EXCEPT SECRETS: before granting, the provisioner takes the pool off every
    .env / .env.* under each path, and it stops - granting none of them - while
    a .env there is readable by Everyone / Users / Authenticated Users. A .env
    created later is readable until the provisioner runs again.

    A PATH IS ONLY MOUNTED ONCE ITS GRANT IS ON IT: an entry the provisioner
    has not run for yet (or whose folder is absent on this node) plants no
    junction, and the launcher logs why. Re-run the provisioner after adding
    or changing an entry. Removing one stops the mount; the standing grant
    stays until taken off by hand (icacls <path> /remove:g egpt-sandbox-pool).

    VALIDATED, and an invalid entry is SKIPPED with one log line naming it: the
    mount name is letters, digits, - or _ and not \`src\` or \`egpt\` (the
    built-in mounts) or a name listed earlier; the path is absolute with a
    drive letter (msys /c/... and windows forms both accepted) and holds no
    quote. brainpool.mjs globalReadPathsOf is the one reading of it, for the
    spine and for the provisioner (setup/global-read-paths.mjs).
  `,

  outbox_targets: `
    THE APPROVED DESTINATIONS a room's outbox/ may be drained to (operator
    2026-09-22: "we have to configure a map: acim-drive -> G:/My Drive/
    jose-lorenzo/ACIM-ES.v2 ... key -> path/ per conversation, configured by
    meta engineer or by hand"). A map of NAME -> absolute path.

      DEFAULT: unset - no conversation can drain anywhere, which is the
      behaviour before this key existed. There is NO default destination.

      outbox_targets:
        acim-drive: G:/My Drive/jose-lorenzo/ACIM-ES.v2

    WHY IT EXISTS. A sandboxed being runs as a leased pool account, and the
    folder it was asked to deliver to can be absent from that account's world
    entirely - measured 2026-09-22: a FAT32 volume (no ACL exists to grant)
    whose drive letter lives in the operator's own session (GoogleDriveFS.exe
    runs as the logged-in user), so the pool account has no G: at all. There
    was no permission to grant, so the copy moved to the side that already has
    one: the being writes files into its room's own outbox/ (src/room-core.mjs
    - part of the Room tree, so every room and conversation has one) and the
    SPINE, running as the operator, drains it (src/room-outbox.mjs).

    THIS MAP IS THE ONLY PLACE A PATH IS EVER WRITTEN, and that is the whole
    point of it. A conversation SELECTS a target by name -
    outbox_to: <key> on the room's per-being block in config/rooms.yaml (see
    agents above; same rung compaction uses) - and the key is used as a LOOKUP
    and nothing else: it never contributes a fragment, a suffix or a '..' to
    the answer. With a raw path there, anything able to write a conversation
    record could name any directory on this disk; with a key it can only
    choose among the folders named here, and an unrecognised name resolves to
    nothing rather than to a traversal.

      unset outbox_to        the feature is off for that conversation
      unknown key            the drain does not run AND says so, naming the
                             key - a typo must be visible, not mysterious
      known key              drained to EXACTLY the path written here

    SIBLING OF allowed_paths BELOW, deliberately: one place the node grants a
    folder, one place to revoke it.

    THE KEY IS WHAT THE CHAT IS TOLD; THE PATH GOES IN THE LOG (operator
    2026-09-22). A room can hold people who are not the operator - the first
    room this ships to has an invited WhatsApp group in it - so a line there
    says "delivered 3 files to \`acim-drive\`" and never where that is on disk.
    The spine log carries the resolved path, the per-file detail and the whole
    error, for every drain including the boot sweep.

    THE PATH IS NEVER CREATED. A target that is missing, is not a directory or
    cannot be written refuses the WHOLE drain and names itself; nothing moves.
    Files are moved (not copied) one level, files only - a directory, symlink
    or junction in an outbox is skipped, never followed - and a name already
    present at the destination is never overwritten.
  `,

  sandbox_oauth_token: `
    The Claude credential a SANDBOXED turn runs on (operator 2026-09-05) - a
    long-lived OAuth token from "claude setup-token", i.e. the operator's own
    SUBSCRIPTION, not an API key.

      DEFAULT: unset - nothing is injected and NOTHING about the launch
      changes. src/sandbox-cli-session.mjs passes no -SetEnv at all in that
      case, so the powershell/launcher argv is byte-identical to what it was
      before this key existed. That is the common case, and it is the one
      this key must never disturb.

    ONLY CONSULTED FOR A SANDBOXED SESSION, and src/spine/brainpool.mjs gates
    the read on exactly that - the RESOLVED "sandboxed" (see
    agents.<name>.conversation_defaults.sandboxed, which access_level
    "sandbox" forces true). WHY THE GATE: a NON-sandboxed turn runs as the
    operator's own Windows account and reads ~/.claude directly, so it
    already has a credential and needs nothing from here. Only a sandboxed
    turn has none - it runs as a leased pool account (egpt-sbx-NN) with its
    own empty profile, denied the operator's ~/.claude/.credentials.json by
    the very ACLs that make the sandbox a sandbox.

    HOW IT REACHES THE TURN: setup/sandbox-logon-launcher.ps1's
    "-SetEnv CLAUDE_CODE_OAUTH_TOKEN=<value>", overlaid onto that ONE child's
    environment block. Deliberately NOT the two easier routes, both of which
    outlive the turn: writing it into the pool account's profile leaves it on
    disk for the NEXT lease of that account, and a machine-wide environment
    variable hands it to every process on the box.

    KEEP IT IN config.local.json, NOT config.yaml - it is a live credential.
    REDACTED wherever /config prints it (the bare dump, a GET, and the SET
    echo): CONFIG_REDACT_RE matches "token" in the key name, exactly as it
    does for beeper_token.

    NEVER LOGGED. src/warm-cli-session.mjs's "warm-cli: spawn ..." line prints
    the INNER claude argv, which is built AND logged before sandboxSpawn wraps
    it; the -SetEnv pair is added inside that wrapper, and the launcher's own
    New-SandboxEnvironmentBlock logs nothing either.
  `,

  radio_quick_reply_string: `
    Token that reads a QUOTED message aloud on the radio this conversation's room
    is joined to — reply to any message with just this token (operator
    2026-08-08). Equivalent to "/radio say <that message's text>": same room/
    joined/enabled/blocked-sender/speaker checks, same uploader+gate.
      DEFAULT: "rs"      "" disables the feature
    The WHOLE message must equal the token (case-insensitive): it takes no
    trailing argument — the text comes from the reply-to, not from what follows
    the token. It is a top-level key of its own so the radio upload stays
    nameable/disableable on its own terms; it triggers through the SAME
    isOperator-gated path /radio say does (src/spine/commands.mjs
    radioQuickReply).
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
    configured). PRESCINDABLE (operator 2026-07-26): this layer is decoration
    for human purviews — the layer that actually IDENTIFIES the node is the
    invisible, mandatory one encoded from node_name, which rides every frame
    whether or not this is set.

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
          "eager" auto-/attach every saved session on /rooms join — opens Chrome
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
      bin
        Path to the Chrome executable. UNSET = the platform default lookup.
        A being is TOLD this path (30-pointers.md) so it can launch Chrome with
        its own tools instead of guessing where Chrome lives.
      profile_dir
        Path to the --user-data-dir a being should use for CDP.
        Chrome refuses CDP on its own DEFAULT profile (an anti-hijack guardrail,
        not a permissions problem), and a blank profile launches fine but is
        logged in to nothing. So this names a REAL, already-logged-in profile
        kept for the purpose. UNSET = no CDP profile is advertised and the
        pointers card omits it, rather than naming a path that does not exist.
      focus_on_dispatch
        ENUM: "on" (DEFAULT) | "off\"
        Bring the brain Chrome window to the foreground before each brain
        dispatch. CDP Target.activateTarget + Page.bringToFront fire regardless;
        this knob controls the OS-level fallback that breaks past Windows
        SetForegroundWindow restrictions / macOS / X11 anti-focus-stealing
        rules. Targets the brain Chrome by PID when egpt spawned it (/chrome);
        falls back to app-name on macOS / Linux. Set to "off" if the focus theft
        becomes intrusive (e.g. mid-typing in another app).
      launch_estimate_mb
        INT MB (DEFAULT 500). The deterministic per-Chrome memory COST used for
        group-Chrome launch admission (chrome-pool.estimateChromeBytes floor) when
        no group Chrome is running to measure. With one or more running, the
        measured MAX working-set RSS supersedes this. Node-level.
      memory_margin_mb
        INT MB (DEFAULT 1024). The free physical memory a group-Chrome launch must
        leave (chrome-pool.admitLaunch): launch if available − estimate >=
        this margin; below it, evict the idlest group Chrome and retry, else
        launch anyway with one log line — a browser is never denied (operator
        2026-10-24). NEVER gates or evicts the brain Chrome. Node-level.

    NOTE: which Chrome a CHAT uses is not a chrome key. It is config/browsers.yaml
    (skeleton: config/skeletons/browsers.yaml): groups of chat names; group
    brain = profile_dir, any other group = chrome/profiles/<group>, unlisted =
    shared. chrome.dedicated is retired. Its optional colors: { <group>: "#RRGGBB" }
    overrides the palette color each group's profile is themed with at launch.
    Its optional uploads: { <group>: false } turns uploads off for that group
    (operator 2026-10-17). DEFAULT: every group, shared included, lets a BOXED
    being attach files to web forms (DOM.setFileInputFiles,
    Page.handleFileChooser, Input.dispatchDragEvent with files;
    src/spine/being-link.mjs). Any value but true is off, and so is every group
    when the file will not parse or uploads: is not a map. Read per upload, no
    restart. Only plain files really inside that conversation's folder: no
    links, junctions or hardlinks, no .., UNC, \\\\?\\ / \\\\.\\ device paths or
    :streams, and the file must exist. Chrome is handed a checked COPY under
    <EGPT_HOME>/state/uploads/, never the being's own path.
    HISTORY: the per-conversation browser_uploads key (2026-10-17) is retired
    and ignored; the group decides.
  `,

  privileged_browser: `
    Serves a BOXED being the same full CDP an unboxed being gets: no filter
    at all, so file:/chrome:/devtools: pages, uploads of ANY file of the
    operator's, and every method the filter refuses (operator 2026-10-17).
    Set it on ONE conversation's entry in config/conversations.yaml. Wins
    over its browser group's uploads: false.
    DEFAULT: absent = filtered. Only exactly true turns it on.
    The spine logs "<being> (<surface>/<slug>) privileged browser — no CDP
    filter" on every tunnel it opens. Unboxed beings are never filtered.
    TRAP: it resolves across the rungs like every key, so setting it in
    config/config.yaml unfilters EVERY conversation.
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

  ear_probe: `
    THE DEAF-BRIDGE DETECTOR (src/ear-probe.mjs, wired into the Beeper limb by
    src/spine/boot.mjs).

    WHY IT EXISTS — a MEASURED outage, 2026-07-07: the Beeper limb was DEAF for ~8.5
    HOURS. The process was alive, the spine tick was beating, the WebSocket reported
    "open", the machine was confirmed not asleep — and ZERO inbound arrived on real
    traffic, so operator commands were silently unheard. Nothing in the system could
    see it: the daemon's deadman only proves the LOOP runs, and the bridge's own
    isAlive() IS that "open" flag — the one thing that stays true through this exact
    failure. So the probe never reads it.

    A PASSIVE last-inbound-age check was REJECTED by the operator: it false-alarms on
    a quiet night, and a draining backlog masks real deafness (lines scroll while the
    ear is broken — both happened that day). The check is ACTIVE.

    THE SENDER IS OUT OF BAND (operator 2026-07-26: "a deaf-bridge detection (beeper)
    could be done using telegram api and self sending a message to spine"). The probe
    injects a message with TELEGRAM'S OWN API — not through Beeper — into a Telegram
    chat this Beeper account bridges, and requires it to come back THROUGH the Beeper
    WebSocket within \`timeout\`. It does not arrive ⇒ the ear is deaf ⇒ drop the
    socket, and the bridge's existing reconnect dials a fresh session (which is what
    fixed the live incident: a fresh session delivered in 17s).

    Send and receive therefore share NO machinery, and the probe message is not "ours"
    as far as the bridge is concerned — it travels the ordinary inbound path a human
    message takes, which is exactly the path the outage broke. There is NO marker in
    the body: the probe compares against the exact nonce it injected, only while a
    probe is in flight, and that comparison decides nothing about any other message.

    REQUIRES TELEGRAM. A node whose Beeper account does not bridge Telegram cannot run
    this probe at all. FAIL CLOSED: no bot token, no chat id, or a non-positive
    cadence and the probe is simply OFF — silently, never a boot error, and never a
    fallback to some other transport.

    KEYS:
      every
        DEFAULT: 30m — how often to probe (\`45s\` / \`30m\` / \`1.5h\`, or a number of
        ms). 0 or false = OFF. At 30m a deaf window is bounded to about half an hour
        (the measured outage was 8.5 hours) and the probe costs 48 messages a day in
        the probe chat. THIS is the number to tune.
      timeout
        DEFAULT: 45s — how long the injected message may take to come back before the
        ear is called deaf, measured from the moment Telegram accepted it. Live, a
        healthy session delivered a fresh message's event in ~17s; during the outage
        nothing arrived in ~4 min. A false positive costs one WS redial: messages from
        a deaf window are HELD on reconnect by design, so nothing is lost.
      telegram.token
        A Telegram BOT token (BotFather). No default — absent = the probe is off.
      telegram.chat_id
        The Telegram chat the bot posts into. It MUST be a chat this Beeper account
        bridges, or the message can never come back and every probe reads deaf. No
        default — absent = the probe is off. Prefer a quiet chat: the probe message IS
        an ordinary inbound, so it lands in that chat's transcript, and a chat in
        \`on\` mode would have a being answer it.

    IT CANNOT STORM: one probe in flight at a time (a tick during a probe is dropped,
    not queued) and one tick per \`every\`, so at most one message per window whatever
    happens. NOTE: this send does NOT pass through \`loop_guard.outbound\` — that regulates
    what the spine emits to its LIMBS, and this leaves via Telegram, beside them. The
    cadence and the non-overlap rule are the whole bound, which is why the cadence is
    minutes. An injection that FAILS (Telegram unreachable, bot not in the chat) is
    INCONCLUSIVE, never "deaf": a broken sender cannot restart the bridge.

    ALSO THE POST-DEPLOY SMOKE: the first probe runs ~20s after start rather than a
    full cadence later, so every deploy/respawn is followed within seconds by a real
    end-to-end delivery check, recorded in EGPT_HOME/config/logs/beeper.log ("ear
    probe OK" / "EAR DEAF"). It verifies DELIVERY, not that a being answered.
  `,

  loop_guard: `
    THE LOOP GUARD — one block, two halves (operator 2026-10-18: "one loop_guard block
    for both"):
      inbound   bot↔bot CONVERSATION loops: non-human turns at the prompt chokepoint
                (src/stop-guard.mjs createStopGuard). A trip PAUSES that channel.
      outbound  the node's EMIT rate at its limb ports (src/loop-guard.mjs
                createSendGuard). Over the node-wide ceiling STOPS the node; a per-chat
                rule PAUSES that chat (the inbound half's pause, cleared by RESUME).
    Nested, not flat: the halves count different things over different windows
    (inbound.window is MINUTES, outbound.window_ms is ms). Both are restart-only
    (src/spine/config-swap.mjs RESTART_KEYS).

    SHAPE:
      loop_guard:
        inbound:  { turns: 6, window: 2 }
        outbound: { messages: 18, window_ms: 10000, edits: 4000, chat_messages: 5,
                    chat_window_ms: 3000, chat_similar_count: 5, chat_similar_window_ms: 2000,
                    chat_similar_ratio: 0.85, chat_burst_count: 10, chat_burst_window_ms: 2000 }

    BACK-COMPAT (one release): a half absent here is read from its pre-0044
    top-level block, and an entry's override from its pre-0044 entry-level block,
    with one deprecation line each per boot. migrations/0044 moves them all under
    loop_guard:.

    KEYS:
      inbound.turns
        DEFAULT: 6 — non-human turns within \`window\` that pause the channel.
        -1 or 0 = the WHOLE inbound half off (repetition included).
      inbound.window
        DEFAULT: 2 — MINUTES the rate is measured over. -1 or 0 = pure
        consecutive count, whatever the elapsed time.
      outbound.messages
        DEFAULT: 18 — committed messages allowed per window. 0 or negative =
        the outbound half OFF (both counters).
      outbound.window_ms
        DEFAULT: 10000 — the sliding window, in ms, for both counters.
      outbound.edits
        DEFAULT: 4000 — edits allowed per window. 0 or negative = the EDIT counter
        only is off. Large on purpose: edits are counted at the port, ABOVE the
        limb's 400ms edit debounce, so one streamed reply is already several
        hundred (one per streamed token delta) and a room fan-out multiplies that.
        A runaway is unbounded by definition and crosses it in milliseconds anyway.
      outbound.chat_messages
        DEFAULT: 5 — PER CHAT, SUSTAINED (operator 2026-10-18: "a mere sustained rate
        of 5msg every 3 secs should be stopped"): messages to ONE Beeper chat in each
        of two consecutive chat_window_ms windows pause THAT chat — the inbound
        half's pause, cleared by RESUME / RESUME ALL — instead of stopping the node.
        Every chat_* rule pauses the same way: while paused its new lines are
        dropped; one line naming the rule goes to log_to_group and the pause notice
        to the chat. System lines (command replies, alerts, log_to_group/admin
        notices) are neither counted nor held. 0 or negative = off (each chat_*
        count/window).
      outbound.chat_window_ms
        DEFAULT: 3000 — the sustained rule's window, in ms.
      outbound.chat_similar_count
        DEFAULT: 5 — PER CHAT, SIMILAR ("five equal sends or more in 2s"; "just
        changing a timestamp … should also trip it"): near-identical messages inside
        chat_similar_window_ms. Near-identical = equal after folding case, spacing,
        ids and every digit-bearing token, or word overlap ≥ chat_similar_ratio.
        Text only: a ⏳ placeholder or a captionless media post is no line.
      outbound.chat_similar_window_ms
        DEFAULT: 2000.
      outbound.chat_similar_ratio
        DEFAULT: 0.85 — word-token overlap (src/text-similarity.mjs similarity).
        0 or negative = the fold alone.
      outbound.chat_burst_count
        DEFAULT: 10 — PER CHAT, BURST ("even 12 in a second … it MUST" trip):
        messages of any content inside chat_burst_window_ms. A requested burst
        trips too — safety first.
      outbound.chat_burst_window_ms
        DEFAULT: 2000.

    ═══ INBOUND — the loop-breaker ═══

    The SINGLE loop-breaker (src/stop-guard.mjs, wired at the spine prompt
    chokepoint src/spine/spine.mjs; replaces the old flood-guard + mesh circuit
    breaker).

    ONE GUARD, TWO TRIGGERS (operator 2026-09-20, after "🌴FAMILIA PALMA🌴" sat
    paused for eight hours):

      · RATE — \`turns\` non-human turns within \`window\` MINUTES. "a hard limit of
        turns is only effective on a rapid succession … six spread over a day is
        the kind of conservatism we must avoid."
      · REPETITION — "pause on repetition, not chatter." The same normalized line
        said 3× by the same author within 10 minutes, or two lines alternating
        A,B,A,B. Bots saying NEW things never trip it: "a chatter between bots is
        desired, and even encouraged."

    A genuine human message resets both. "human" is decided by PROVENANCE, not
    display name — a mesh message posted AS the operator parses as relay traffic
    (an envelope) and is NON-human, so it counts toward the cap instead of
    resetting it (closes the 2026-06-19 hole).

    THIS NODE'S OWN ECHO IS NEITHER. A frame this spine committed (its own node
    signature, or a send the bridge knows by id) coming back through the bridge is
    BOOKKEEPING: it does not count and does not reset. E's own "⏳ Thinking…" /
    "⏳ Queued…" placeholders, posted through the mouth account, are what filled
    PALMA's cap in five seconds. ANOTHER node's being still counts — that is real
    chatter.

    A PAUSE ANNOUNCES ITSELF in the channel, once, naming what tripped it (the
    repeated line, or the rate with its numbers) and how to recover — \`resume\`
    there, or \`resume all\`. Only the stop; the warn stays in the log.

    Repetition's own numbers (3 repeats / 10 minutes) are not config: they are
    what "said the same thing again" means, not a tuning knob.

    PER-CONVERSATION OVERRIDE: a contact/room entry in conversations.yaml may
    carry its own  loop_guard: { inbound: { turns: -1 } }  to loosen or disable it
    for that channel (e.g. a busy relay room).

    RESUME / RESUME ALL (from an authorized sender, on any surface) clear a
    channel this counter auto-stopped — the only way back short of a restart.
    RESUME clears the channel it was typed in; RESUME ALL clears every channel the
    counter stopped (it can stop several independently).

    THE SAFE WORD IS SEPARATE, AND IT IS THE KILL SWITCH (operator 2026-07-25):
    a bare  stop  IN THE SELF CHAT writes  EGPT_HOME/STOP  with its reason +
    provenance, posts a one-line warning back into Self (best-effort, capped — it
    can never delay the stop) and stops the SERVICE (a clean exit 0, which
    egpt-daemon does not respawn). It does NOT pause a channel. While that file
    exists the node refuses to boot, and a RUNNING node halts on its next tick — so
    touch ~/.egpt/STOP  stops egpt too, as does double-clicking
    setup\\stop-egpt.cmd. Recovery is  rm ~/.egpt/STOP  (or setup\\start-egpt.cmd)
    and nothing else: the file is the whole state.

    WHERE IT WORKS: **THE SELF CHAT ONLY** (operator 2026-07-26: "is must be a
    single word message in Self, 'stop', case insensitive") — that is
    networks.<surface>.chat_ids[0] on whatsapp, the same Self-DM the restart
    announce posts to. It used to fire from ANY chat on ANY surface, which made one
    stray "stop" in a group — or anyone at the operator console, which is
    unconditionally authorized — enough to take the node down. In every OTHER chat,
    group, and on the shell surface, "stop" is now ordinary text. No Self chat
    configured → the chat safe word is simply unavailable (fail-closed); the STOP
    file is still the way out. The other admin chats (chat_ids[1..]) and every
    group take stop_phrase instead (operator 2026-10-18, superseding 0a2fc04's
    2026-10-15 widening of the bare word to every chat_ids entry).

    WHAT COUNTS AS THE WORD: the WHOLE trimmed message, case-insensitive, trailing
    '.'/'!' tolerated. "stop it", "please stop", "stopping" are ordinary text.

    WHO MAY PULL IT: an authorized sender (per-surface allowed_users, or the Beeper
    account owner) AND a genuine HUMAN turn. On a shared Beeper account every send
    from the account reads as authorized, so the safe word is additionally gated on
    the same PROVENANCE predicate this counter uses — our own output, a brain
    member's re-entered reply, relay envelopes and backlog replay can never pull it.

    THE COMPLETE SAFE-WORD VOCABULARY IS:  STOP | RESUME | RESUME ALL.
    "STOP ALL" was unwired on 2026-07-26 — it is ordinary text now, not an alias.
    (RESUME / RESUME ALL are NOT Self-scoped: they only clear a loop-counter pause,
    so they stay usable in the channel that got paused.)

    ═══ OUTBOUND — the emit ceiling ═══

    A node-wide hard ceiling on how much egpt may EMIT per time window (wired in
    src/spine/boot.mjs around every limb port) — brain replies, command replies,
    mesh envelopes, 👂 echoes, heartbeat posts, error lines, on every surface.
    Operator 2026-07-26: "under no reason must the bridge exceed a normal sending
    rate. that is a self-regulated existance."

    IT TRIPS, IT DOES NOT THROTTLE (operator 2026-07-26: "by throttle i did actually
    mean stop. there is probably a bug if there is flooding" / "bridge stops looping
    until human intervention"). There is NO queue: the emit that would exceed the
    ceiling is not sent late, it STOPS THE NODE — through the same kill switch the
    STOP safe word pulls (EGPT_HOME/STOP + clean exit, so the daemon does not
    respawn and only a human restart clears it). The STOP file's \`reason:\` names
    the flood and the rate, so a flood-stop is distinguishable from a safe-word stop
    without reading code.

    TWO COUNTERS, ONE TRIP ACTION (operator: "only count outbound messages or
    edits"). They are not peers, because the harm is not the same ("endless edit is
    not annoying, 100 messages are"):
      MESSAGES — a NEW line in someone's chat: send / startStream (its placeholder)
        / postStatus / sendMedia. Tight, because this is the damage.
      EDITS — a PUT into a message already counted: stream.update / stream.finish /
        stream.fail / editStatus / editOwn. Loose, because it only makes ONE line
        flicker; it is a backstop against an infinite-edit runaway, nothing more.
    REACTIONS AND DELETES COUNT AS NEITHER (react / deleteStatus / deleteOwn) — no
    text, so neither a new line nor an edit of one.
    NOTHING INBOUND IS COUNTED — that is the inbound half's job (above).

    THE STOP PATH IS NEVER GATED — a send carrying bypassLoopGuard gets out even
    after a trip, or the node could not announce its own halt.

    18/10000ms (operator 2026-07-26) is NOT a loosening of the prior 20/5000ms: that allowed a
    sustained 4 messages/second, this allows 1.8/s — less than half — while the longer window
    gives a legitimate flurry (a voice-note reply flurry, a mesh exchange, two agents answering
    at once) room to land inside one window. edits scaled to 4000 to hold the SAME rate as the
    old 2000/5000ms rather than quietly halving it on a now-twice-as-long window.

    VISIBLE ON DISK: a trip is published to EGPT_HOME/state/loop-guard.json ({ state:
    tripped, limit, messages_in_window, edits_in_window, tripped: { kind, count,
    limit, window_ms, at, reason } }), so "why did egpt stop" is answerable with
    cat. Written on the trip only — the send path never does IO.

    NOT THE LOOP-BREAKER. The inbound half bounds a bot↔bot CONVERSATION by
    counting inbound non-human turns at the prompt chokepoint; this bounds the
    node's EMIT RATE whatever the cause. Since a64b209 the inbound half finally sees
    a peer node's turns (ev.fromNode), so bot↔bot loops are ITS job and this is the
    catastrophic backstop for a runaway that outruns even that — which is why this
    ceiling is set above ordinary traffic rather than at the incident's rate.
  `,

  stop_phrase: `
    THE KILL PHRASE (src/stop-guard.mjs isStopPhrase, gated in src/spine/spine.mjs
    classify). Operator 2026-10-18: "a keyword, say EGPT STOP if on allowed_users
    should stop that node". A message that IS the phrase (whole text, case- and
    spacing-insensitive), in ANY chat, from an allowed user's human turn (the STOP
    safe word's own test: authorized + provenance) pulls the same kill switch:
    EGPT_HOME/STOP + clean exit. Every node hearing the chat stops. Not on the
    shell console. A non-allowed sender's phrase is logged and ignored.
    ALLOWED USER = the message's \`authorized\` flag (src/bridges/beeper.mjs): the
    sender id is on networks.<the chat's own network>.allowed_users (no borrowing
    another network's list), or the sender is the owner (isSender) of the Beeper
    account the message arrived on.
    DEFAULT: "EGPT STOP". "" = off.
  `,

  turn_timeout_ms: `
    Per-turn backstop (DEFECT 2; src/spine/spine.mjs runTurnWithTimeout, the
    turnTimeoutMs factory param wired at boot's createSpine). Milliseconds a single
    brain turn may run before it is failed VISIBLY and its wedged warm entry
    EVICTED, so the chat's queue drains onto a fresh session. A node-wide scalar —
    there is deliberately no per-being / per-chat rung.

      DEFAULT: 600000 (10 min) when the key is ABSENT — today's behavior exactly.
      -1 (or ANY value <= 0, including 0) = INFINITE: no per-turn cap. It flows
        through to runTurnWithTimeout's \`!(turnTimeoutMs > 0)\` check, which skips
        the race entirely, so the turn runs to completion and is never killed.

    The default is a WEDGE GUARD: a genuinely hung CLI session is evicted so the
    queue can drain. Disabling it (-1) means a wedged turn will NOT self-heal until
    a restart — a per-node operator choice, not the shipped default. A legitimately
    long tool-heavy turn finishes well under 10 min; this is the higher bridge-level
    backstop, NOT the warm pool's own timeout-free design (left untouched).
  `,

  liveness: `
    A running turn's "⏳ Thinking…" placeholder stays visibly alive
    (src/spine/liveness.mjs): re-edited with ⤴️ / ↪️ alternating and the elapsed
    time, never past the 13-min edit window (sender LIVE_EDIT_MS).

    KEYS:
      every_ms
        DEFAULT: 15000 (operator 2026-10-16: "all updates every 15s").
        The spine tick is sized down to it (boot effectiveTickMs). Read at boot.
        Background status lines share it.
  `,

  lag_probe: `
    Is the spine's one event loop keeping up? (src/spine/lag-probe.mjs, operator
    2026-10-18.) Lag = the worst loop delay in a sample, or the fast pump's oldest
    wait, whichever is larger. Over threshold: ONE line to log_to_group with the
    attribution (spine/node CPU, top processes, queues, slowest spine steps),
    repeated at most every 10 min, then one "recovered" line after a clean minute.
    A baseline line goes to the node log every 5 min. Both keys read live.

    KEYS:
      threshold_ms
        DEFAULT: 10000.
      every_ms
        DEFAULT: 5000. The sample cadence.
  `,

  auto_restart_on_config_change: `
    Restart to apply a config.yaml edit that touches a RESTART-ONLY key
    (operator 2026-10-09; step B 2026-10-16; src/spine/spine.mjs
    maybeApplyConfigChange, boot's applyConfig). Every other edit is applied
    WITHOUT a restart, flag or not: the spine's tick (and each message arrival)
    swaps the new config in, and a being whose spawn options changed reopens its
    own warm session on its next turn. The restart-only keys are the ones boot
    binds once (Beeper connections, shell, node identity, the transcription and
    voice services, …) — the list is src/spine/config-swap.mjs RESTART_KEYS.
    When ON, such an edit triggers the SAME drain+respawn the ingest /restart
    does (exit 43); the value read is the one in the NEW file. An edit that
    fails boot's assertions is refused: the running config stays and the
    logging group (log_to_group) is told.

      ENUM: true | false
      DEFAULT: false (ABSENT or any non-true value) — a generic node does not
        auto-restart; the operator opts in explicitly per node.

    Keyed on the config.yaml CONTENT hash, not mtime — a no-op save (identical
    bytes) does nothing. Parse-gated: a mid-write or malformed config is
    IGNORED (the spine waits). Acted on ONCE per content — the respawned spine
    captures the new content as its boot hash.
    Only operator-triggered writes touch config.yaml (/config set, /radio
    disable); nothing automatic does, so there is no restart loop.
  `,

  media_flood: `
    The MEDIA-FLOOD auto-ban (src/flood-ban.mjs, wired in src/spine/boot.mjs into the
    Beeper bridge dispatch). A single sender dumping a BURST of media (GIFs / stickers
    / images — "a whatsapp virus") into one chat pollutes E's accumulated context and
    bloats the chat's media/ folder; this mutes that sender automatically.

    (NOT \`loop_guard.outbound\`'s "flooding" — that is the node's OUTBOUND emit ceiling.
    This is an INBOUND per-sender mute, a different concept with its own key.)

    TRIGGER: one sender posting >= \`count\` media attachments within \`window_ms\`, in
    one (surface, chat) → that (surface, chat, sender) is BANNED for \`cooldown_ms\`.

    WHILE BANNED: EVERY inbound message from that sender in that chat — media AND plain
    text — is DROPPED in the bridge BEFORE persistMedia + onIncoming: no media/ save, no
    transcript write, no dispatch. The one message that TIPS the ban is dropped too.

    AUTO-UNBAN: the ban expires \`cooldown_ms\` after it tripped, lazily (checked on the
    next message / isBanned — no timer). A node restart re-arms detection from empty
    (the bans are in-memory, never persisted), same as the loop \`guard\`.

    A ban logs ONE line when it trips and one when it lifts; it posts NOTHING into any
    chat. \`/bans\` lists active bans; \`/unban [name]\` clears the ban(s) in the chat it
    is typed in (there is no manual \`/ban\` — detection is automatic). Our own sends
    never reach the counter (the bridge's wasSentByUs own-send gate drops them upstream).

    KEYS:
      count
        DEFAULT: 5 — media attachments within \`window_ms\` that trip the ban.
        0 or negative = the whole feature OFF.
      window_ms
        DEFAULT: 20000 — the sliding window, in ms.
      cooldown_ms
        DEFAULT: 600000 (10 min) — how long the sender stays muted before auto-unban.
      never_ban
        DEFAULT: [] — senders that can NEVER be banned, each matched against the
        sender's id OR display name (case-insensitive). Add the operator here to be
        safe from a self-ban on a legitimate media burst.

    The same mute serves agents_list's /agents flood ban (reason shown in /bans); count
    does not switch that one off.
  `,

  public_commands: `
    The commands ANYONE in a chat may run (operator 2026-10-19); every other command is
    the node's allowed users' only (Self DM, networks.<surface>.allowed_users, the owner).
    Command words, with or without the '/'. A node-signed line is never admitted.
      config.yaml, root key:           DEFAULT [join, split, send, end]
      conversations.yaml, a chat's own entry: REPLACES the root list there; [] = none.
    A listed agents opens only the bare /agents list (agents_list); its verbs stay
    allowed-users only. Each command's own rules still apply (/end only in a side group).
  `,

  agents_list: `
    Bare /agents from a NON-operator (operator 2026-10-16; only where public_commands lists agents): a short public list of this
    node's local agents (the persona first) that read the chat — emoji + name, handles, voice handles, the reply
    mode in plain words, and whether THAT sender can call it (its allowed_users). Relays,
    public agents and 'off' beings are not listed. The operator's /agents is unchanged
    and never throttled. Read live.
    KEYS:
      every_ms
        DEFAULT: 60000 — at most one public list per chat per node in this window;
        calls inside it get no reply.
      ban_after
        DEFAULT: 5 — a sender with this many ignored calls within ban_window_ms is
        muted through the media_flood ban (its cooldown_ms, /bans, /unban). 0 = never.
      ban_window_ms
        DEFAULT: 600000 (10 min).
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
        DEFAULT: { system: 43200000, resident: 43200000, conversation: 900000,
                   sibling: 43200000 }

    TTL DIALECT (operator 2026-07-26 — the same one posts_back_delay_ms and
    loop_guard.inbound.turns speak): -1 = never idle-evict (warm forever), 0 = always evict
    (dropped the moment its turn ends, so every turn is a cold --resume), N =
    evict after N ms idle. An ABSENT class falls through to idle_ttl_ms; absent
    never means 0.

    CONVERSATION DEFAULT = 15m (operator 2026-07-02: "keep any conversation as a
    background agent 15m after the last message, configurable"): a conversation
    goes cold 15 min after its last turn, then idle-evicts (the transcript +
    --resume make the next turn correct, just colder). This SUPERSEDES the
    earlier never-evict default.

    EVERYTHING ELSE IDLES OUT AT 12h (operator 2026-09-20: "let them idle out,
    12h"). system/resident/sibling used to default to -1 — never — which left
    one live claude.exe per warm session (13 of them on kg) until the pool hit
    max, or the spine restarted. Evicting is cheap: the thread id lives in the
    conversation record, so the next turn resumes the same session. A node whose
    config.yaml already spells these out is brought forward by migrations/0013.

    PER-CONVERSATION OVERRIDE: a conversation folder's own config.yaml (the same
    file that carries the transcription: / heartbeats: blocks) may set
    warm: { idle_ttl: 1h } — a ms number or a "<qty><unit>" duration
    (ms/s/m/h) — to override the class TTL for THAT conversation only;
    idle_ttl: -1 there = keep this conversation always warm.
    RESOLUTION: per-conversation override > class TTL.

    KEEP (operator 2026-10-22: "that group should be kept always on"):
    warm: { keep: true } on a conversation's conversations.yaml entry (or its
    folder config.yaml) — its sessions are never idle-evicted and never LRU-evicted;
    only a stop, a rethread/re-pin, a configuration reopen or a failure ends one.
    A pool full of kept or busy sessions grows past max. Read live: an edit
    applies at the next idle check / LRU pass, no turn and no restart needed.
    idle_ttl: -1 alone still yields to max (LRU); keep does not. At the node
    rung it would keep EVERY conversation — set it per conversation.
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
    /agents auto <handle> auto); the turn-counter guard bounds runaway unchanged.
  `,

  admin_channel: `
    The node's admin channel (operator 2026-09-24: "make it's posted on admin
    channel, eGPT Admin. BTW the 'admin channel' must be defined in config.yaml")
    - the ONE chat this node posts its own notices to. Today that is the
    compaction notice: "🗜️ <node> · <being> in <chat> compacted its context
    (was Nk tokens)...", said after a /compact that succeeded
    (src/spine/compaction.mjs, boot.mjs noticeToAdmin). Every node may name the
    same chat; the line says which node it came from.

    VALUE: a chat NAME or a raw Beeper room id in SHORT form, exactly like
    advice_channel. A name is resolved to its room by the bridge's own
    resolveChatId before the line is said, so the being's mouth can say it in
    its own room. Unset (or empty): nothing is posted, the notice stays in the
    daemon log. Operator alerts are NOT sent here; they stay on the Self chat.
  `,

  log_to_group: `
    The per-command audit channel (operator 2026-10-08): the ONE group this node
    posts a compact, METADATA-ONLY line to for EVERY slash command that runs —
    "/<cmd> in <chat> by <sender> → <outcome?>" — so a command that otherwise does
    its work silently (notably /end's no-op outside a /join or /split side channel,
    and a successful archive) is still visible. The reply BODY is NEVER included: a
    /config dump, a /recap listing or a contact list can never leak into this group.
    <outcome> is appended only where a silent/side-effecting handler returns one
    (today: /end); every other command is just its invocation line.

    VALUE: a chat NAME or a raw Beeper room id in SHORT form, resolved to its room
    EXACTLY like admin_channel — the SAME boot.mjs resolver + poster (noticeToChannel),
    fail-closed, said from the being's own mouth. It MAY name the same chat as
    admin_channel or a different one. Unset (or empty): auditing is OFF — nothing is
    posted and no command's behavior changes (src/spine/commands.mjs run() chokepoint,
    boot.mjs logToGroup).
  `,

  login: `
    The auto-login limb (operator 2026-10-08, plan plans/2610082200-EGPT-LOGIN-PLAN.md,
    approach (2)). /login <site> — and the being-facing requestLogin(domain) the spine exposes —
    sign a being in to <site> on the brain Chrome profile using CHROME'S OWN saved password. The
    spine READS the saved credential straight out of Chrome's store (the DPAPI master key + the
    AES-256-GCM 'logins' table, the same way Chrome keeps it), TYPES the username + password over
    the CDP it already holds, and drives the one TRUSTED submit click. The credential is a local:
    it is typed and nulled, and NEVER returned, logged, or posted. The limb's only output is an
    outcome token (logged-in | needs-2fa | captcha-posted | failed | no-credential) — never a
    credential, never the 2FA OTP it reads and enters. (Approach (ii), "ride Chrome's autofill",
    was abandoned: no CDP command triggers Chrome's saved-password autofill.)

    Every key is OPTIONAL; an unset block uses the defaults below, and a node that never runs
    /login pays nothing for it.

    KEYS:
      chrome_profile_path
        DEFAULT: chrome.profile_dir, else the discovered brain profile (chromeProfileOf)
        The Chrome user-data-dir whose saved logins are read. Unset derives from the SAME place
        /chrome launches into — chrome.profile_dir when set, else the auto-discovered brain profile
        (typically <egptHome>/chrome/profiles/brain) — so there is no second source of truth; set
        this only to read a DIFFERENT profile than the one the spine drives.
      otp_sources
        DEFAULT: [gmail, google_voice]
        The tabs the 2FA branch reads the one-time code from, in order (gmail =>
        mail.google.com, google_voice => voice.google.com). The code is read inside the limb and
        entered; it is NEVER logged, returned, or posted.
      captcha_channel
        DEFAULT: admin_channel
        The CONFIG KEY whose channel the CAPTCHA branch posts to — resolved by the SAME
        noticeToChannel the compaction notice and the per-command audit use. Default points at
        admin_channel; set it to another registered channel key to divert captcha notices. The
        post is metadata only (the domain + a screenshot size); the screenshot IMAGE itself is
        not yet delivered (noticeToChannel has no attachment path — see the plan).
      submit_overrides
        DEFAULT: {} (none)
        Per-domain overrides for sites the generic form detector misreads:
        { "<domain>": { url: "<login URL>", submit: "<CSS selector of the submit control>" } }.
        Added as needed; the generic heuristics handle the common case.
  `,

  book: `
    The /book limb (operator 2026-10-15; src/spine/book.mjs). A being whose
    agents.<name>.actions lists book may emit  /book <YYYY-MM-DD> <HH:MM> <summary>.
    The spine reads the team calendar's SECRET iCal address; a free slot is booked
    by an iCalendar invitation (METHOD:REQUEST) to calendar_email, sent over the
    email: SES path; a taken one returns the nearest free slots inside working
    hours. Outcome booked | busy (+ slots) | not-configured | failed, returned to
    the being as a wake turn (spine.wakeOnBackground). A missing ics_url,
    calendar_email, email.from or SES key = not-configured, one log line.

    KEYS:
      ics_url
        SECRET. The calendar's "Secret address in iCal format" (Google Calendar,
        the calendar's settings, Integrate calendar). Spine-only: never logged,
        returned or shown to a being; /config redacts it. Use the calendar the
        invitations land in (calendar_email's own), so a booked demo reads busy.
      calendar_email
        The attendee every invitation goes to. Fixed here; the being never
        chooses it.
      timezone
        DEFAULT: America/Caracas. The IANA zone the requested time, the working
        hours, and the feed's all-day/floating events are read in.
      duration_minutes
        DEFAULT: 30.
      working_hours
        DEFAULT: { days: [mon, tue, wed, thu, fri], start: "08:00", end: "17:00" }
        A request outside them is answered busy, with the nearest free slots.

    FEED: VEVENT DTSTART/DTEND in UTC, TZID and all-day forms; STATUS:CANCELLED and
    TRANSP:TRANSPARENT are skipped. RRULE FREQ=DAILY|WEEKLY with INTERVAL / BYDAY /
    UNTIL / COUNT / WKST is expanded; any other rule is busy at its first instance
    only. EXDATE and moved instances (RECURRENCE-ID) leave the original busy.
  `,

  email: `
    The Amazon SES path (SES v2 SendEmail, SigV4; src/spine/email.mjs) and the
    /email limb on it (operator 2026-10-15). A being whose agents.<name>.actions
    lists email may emit  /email <text>: the spine sends <text> FROM from TO the
    fixed to: list, subject = subject_prefix + the chat's name. The being never
    chooses recipients, sender or subject. The spine attaches that conversation's
    transcript.md (text/markdown, transcript-<chat>-<date>.md; over 1 MB, its last
    1 MB, and the body says so). /book's invitation rides the same path.
    Outcome sent | not-configured | failed, returned to the being as a wake turn.

    KEYS:
      region
        DEFAULT: us-east-1.
      from
        The verified SES sender: "Name <addr@domain>" (ASCII name) or a bare
        address. Also the ORGANIZER of /book invitations.
      to
        The /email recipient list. Empty = not-configured.
      subject_prefix
        DEFAULT: "[eGPT]".
      aws_access_key_id
        SECRET (/config redacts it). An IAM key allowed ses:SendEmail only.
      aws_secret_access_key
        SECRET.
      credentials_file
        Instead of the two keys: a path to an AWS shared-credentials file with
        aws_access_key_id = ... and aws_secret_access_key = ... lines.
  `,

  node_role: `
    The role THIS node plays: 'primary' | 'secondary', set PER NODE (operator 2026-10-03). Both nodes
    ingest the same primary Beeper account. Since 2026-10-19 a command names its being ("/e join"),
    so the being's node runs it — and makes a /join or /split group — and the role picks nothing
    there. The log_to_group audit merge reads it (the secondary edits the primary's line). The other
    node links a side group from its opener: /join as an alias of the chat, /split as its own
    conversation with its own beings' threads forked.
  `,

  group_title: `
    The title of the side-group /join or /split creates (operator 2026-10-03). A template:
      {group}  the parent chat's title
      {name}   the command's optional <name> arg ("/e join spoiler" → {name}=spoiler; absent → 5
               random lowercase letters/digits, e.g. "k7f2q")
    Every side group's title starts with "SI+" (fixed, not part of the template; 2026-10-18).
    Unset → "{group}-{name}", so "SI+<group>-<name>". Replaces the old fork.title.
  `,

  join: `
    /join — the SUPERPOSITION side-group (operator 2026-10-03). "/<handle> join [<name>]" (e.g.
    "/e join viaje"; the handle's node runs it) creates a
    private group whose chatId is ALIASED to this chat's conversation — one shared on-disk thread, two
    chat surfaces, nothing copied. It is a VIEW, not a branch. Anyone in a group chat may run it
    (2026-10-18): the primary account creates it, inviting the secondary (Rodz) and that person; the
    operator's own join invites Rodz alone; no secondary → just that person. Reply
    "/<handle> send" to relay a chosen message back to the original chat; "/<handle> end" to archive
    the group and drop the alias. The two accounts' phones come from beeper.primary.phone /
    beeper.secondary.phone; the group title is config.group_title ({name} absent → a random 5-character
    name); and the texts that live here are:
      default_name: RETIRED (2026-10-19), ignored — a nameless join gets a random name.
      placeholder: what the operator's join message is edited into (a member's gets it as a
                   reply). A template (2026-10-16): {name} the join name, {title} the group title,
                   {group} the parent chat's title, {by} the sender, {handle} the handle it was typed
                   to; no braces → used as-is. Unset → a built-in default naming the group and the
                   command to join it.
      exists:      the reply when /join <name> matches a live side-room of this chat the sender is not
                   in (no second group is created; the Desktop API cannot add a member). placeholder's
                   variables ({by} = who made it). Unset → a built-in default.
      member_cap:  how many live side-rooms ONE non-operator may hold per chat (rooms they made or are
                   in; /end-ed and deleted rooms do not count). A number. DEFAULT -1 = unlimited; N >= 1
                   = at most N, every create being the operator's own WhatsApp account. The operator is
                   never capped. (operator 2026-10-16)
      limit:       the reply when member_cap is reached; placeholder's variables, {name} lists that member's rooms. Unset → a
                   built-in default.
      opener:      the one message posted by the primary into the new group right after it is created, so
                   the otherwise-empty group surfaces in Beeper (Beeper hides chats with no messages).
                   Rodz's copy of it tells the node Rodz's own room for the group, by id.
                   A template: {group} = the parent chat's title, {handle} = the handle the command
                   was typed to. Unset → a small built-in default.

    ALIASES (operator 2026-10-19) — config/commands_alias.yaml, not a config.yaml key (skeleton:
    config/skeletons/commands_alias.yaml). A map of alias → "/<handle> <command> [args]", for ANY
    command:
      aparte: /e join
      nos vamos aparte: /e join
      reinicia: /e restart force
    A message that STARTS with an alias (case-insensitive, whole words; the longest alias wins) runs
    that command line with the rest of the message appended: "aparte viaje" → /e join viaje. It is
    exactly the typed command: the same node (the handle's — any node's being may be named, and every
    other node ignores it), the same gates (an alias works for whoever may type its command), the
    same placeholder edit; the transcript keeps the words as said, the audit line names the alias.
    A node-signed line (a being's output) never triggers one. Refused at load, one log line each: an
    alias starting with "/", an alias starting with a being handle, a target that is a bare command
    ("/join": no being) or not "/<handle> <known command>". Read on change, no restart. Absent or empty
    file → no aliases. Replaces join/split/send/end.triggers (retired; ignored).
  `,

  split: `
    /split — the REAL-FORK side-group (operator 2026-10-03). "/<handle> split [<name>]" creates a private
    group backed by a NEW conversation (its own folder/entry, NOT an alias) whose resident beings'
    threads are COPIED from this chat so it DIVERGES. Who may run it, which node creates it and whom it
    invites: as join. Reply "/<handle> send" to relay a chosen message back to the original chat;
    "/<handle> end" to archive the group and retire the split conversation's mapping. Group title is
    config.group_title ({name} absent → a random 5-character name); the texts that live here are:
      default_name: RETIRED (2026-10-19), ignored — a nameless split gets a random name.
      placeholder: what the operator's split message is edited into. Unset → a small built-in default.
      opener:      the one message posted by the primary into the new group right after it is created, so
                   the otherwise-empty group surfaces in Beeper (Beeper hides chats with no messages).
                   Rodz's copy of it tells the node Rodz's own room for the group, by id.
                   A template: {group} = the parent chat's title, {handle} = the handle the command
                   was typed to. Unset → a small built-in
                   default.
  `,

  send: `
    /send — "/<handle> send", replying to a message in a join or split group, relays it back to the
    ORIGINAL chat (operator 2026-10-03); the handle's node posts it. Repeatable; posts nothing to the
    group and never closes it. Anyone in the
    side group may run it (2026-10-18); a non-operator's relay is posted by the secondary, signed, in
    its own room for the original (found by id, never by title; else the primary), never as the operator.
      post_back_from: which account posts the operator's relayed message to the original chat —
                      'primary' (the operator's OWN account; the DEFAULT) posts so it appears from the
                      operator; 'secondary' (the mouth) makes it appear from the bot's secondary
                      account. Unset/invalid → primary.
      origin:         whether the relay says which side group it came from (2026-10-16).
                      ENUM: auto | always | never. DEFAULT auto (also for an invalid value).
                      auto = prefix origin_template unless the side group is a legacy DISCREET one
                      (made by the retired join/split phrase triggers: discreet: true on its
                      conversations-state entry, or, made before that flag, a 5-hex random token in
                      its title's {name} slot). always = prefix even when discreet. never = no
                      prefix.
      origin_template: the prefix; {group} = the side group's title (live chat name, else the stored
                      title). DEFAULT "↪ from {group}:\\n". "" = no prefix.
  `,

  end: `
    /end — "/<handle> end" archives a join or split group (both kinds) and drops its mapping on the
    handle's node, closing it (operator 2026-10-03). Anyone in the side group may run it (2026-10-18);
    the group is archived on the
    account it was heard on. Posts nothing; silent outside a join/split group. Off in the
    reply_in_side_group group: there it does nothing.
  `,

  reply_in_side_group: `
    The automatic side group (operator 2026-10-18). Set it on ONE conversation's OWN entry in
    config/conversations.yaml. Read nowhere else: in config/config.yaml, on a side group's entry or in
    a folder config.yaml it does nothing. There is no trigger phrase.

    VALUE:
      true / yes / on / 1 (any case)   → on; the group is titled "SI+<chat title>".
      false / no / off / 0 / "" / unset → off: replies in place (the DEFAULT).
      any other text                   → on; that text (trimmed) is the group's title, as is.

    On: no being replies in this chat, in any mode; every reply (its limbs and voice too) goes to the
    side group, unquoted. The node whose being is about to reply creates it when it holds none, on its
    primary account, inviting Rodz (the secondary) and every
    member of the chat it can see; no secondary → the members alone. An addressed reply makes it
    before the turn; any other (on/auto) only once the reply has something to post, so a silence
    makes nothing. It is a /join-kind alias of the chat (same folder and thread, its own transcript),
    marked automatic: true. /send works in it; /end does nothing there. Once the group is gone the
    next reply opens a new one. A title may repeat: the group is known by its id. The other node links
    it from the opener and, when its own entry for the chat says nothing, sets reply_in_side_group: on
    there too — so only the creating node needs configuring (2026-10-19). Both nodes making one at
    once is fine: two groups, each node links the other's, and each keeps replying in the first it
    holds (its own); a line in either reaches both, as an alias of the chat.
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
    TWO triggers since 2026-09-14: that cooling wait, and critical_ratio —
    a session already near the window is compacted immediately, because the
    cooling timer re-arms on every turn and a busy conversation would otherwise
    never reach quiet.

    KEYS:
      enabled
        DEFAULT: on; false disables.
      ratio
        DEFAULT: 0.20 — compact once the session passes this fraction of the
        context window. This is the COMPACT threshold; warn_gap below sets a
        second, lower WARN threshold a few % under it.
      warn_gap
        DEFAULT: 0.03 (operator 2026-10-08). The WARN threshold sits this fraction
        of the window BELOW ratio: warn_threshold = (ratio - warn_gap) of the
        window, clamped at >= 0. At the warn threshold the being writes its handoff
        and the admin channel gets the pre-compaction notice (compaction_warn_notice,
        a top-level key), ONCE per thread; at ratio the actual /compact runs. So the
        operator is warned and the handoff exists ~warn_gap of the window before the
        context compacts. Per-being/room overridable, same place as ratio. A
        non-negative number (0 = warn coincides with compact, i.e. no early warning);
        booleans and negatives are rejected and fall back to the default.
      cooling_ms
        DEFAULT: 120000 — quiet period after the last reply before the size
        check runs.
      critical_ratio
        DEFAULT: unset — disabled, and the cooling wait is the only trigger.
        When set, a session ALREADY past this (higher) fraction of the window is
        compacted with NO wait at all. The cooling timer is re-armed on every
        turn, so a conversation that never goes quiet never compacts — and
        overshooting is not "compacted late", it is LOST: brainpool's overflow
        backstop RESETS to a fresh session. The probe reads a bounded tail of
        the session jsonl (compact-being.mjs criticallyOver), because unlike the
        cooling check it runs after every turn.
      context_window
        Override the per-model window token count.
        DEFAULT: windowForModel(model)
      handoff_prompt
        GRACEFUL COMPACTION, step ① (operator 2026-10-04; moved to the WARN threshold
        2026-10-08). An instruction given to the being on its OWN warm session at the
        WARN threshold (warn_gap below ratio), while it still holds its full pre-compact
        context, so it can write its working state to handoffs/{agent}.handoff.md in its
        conversation folder and resume from there after the /compact at ratio. It fires
        ONCE per thread, not on every loop tick between warn and compact. {agent} is
        replaced with the being's handle, {YYMMDD-HHMM} with the node-local time of the
        warn (stamped once: the welcome and the notice's {path} reuse it). The file the
        prompt names (its first *.md token, relative to the being's cwd) IS the handoff
        path the notice and the welcome point at. The handoff turn is
        NON-FATAL: a failed one logs a line and the compaction proceeds (losing a
        handoff never blocks the compact), and its output is not posted to chat.
        DEFAULT: unset — no handoff turn (today's behaviour). The reference text is:
        "You are about to be compacted. Write a concise handoff of your current
        working state - what you are doing, the key context, and your next steps -
        to handoffs/{agent}.handoff.md, so you can pick up seamlessly after
        compaction."
      welcome
        GRACEFUL COMPACTION, step ③ (operator 2026-10-04). Appended AFTER the re-fed
        identity on the FIRST post-compact turn (the identity re-feeds on compaction
        as it does at start/refresh/rethread), pointing the being at the handoff it
        wrote. {agent} is replaced with the being's handle, {YYMMDD-HHMM} with the
        stamp of the warn that wrote the handoff. It rides ONLY a
        compaction-triggered re-feed, never a plain /agents refresh.
        DEFAULT: unset — re-feed with no welcome (today's behaviour). The reference
        text is: "hi, you have just been compacted. please read your handoff at
        handoffs/{agent}.handoff.md and continue where you left off."
      compact_after_handoff
        DEFAULT: true (operator 2026-10-17). When the handoff turn succeeds (it ran and
        replied with text) and the conversation is idle — no turn in flight or queued
        on its warm session, no live background task — the /compact (and then the
        welcome) runs right away instead of waiting for ratio. With work pending, it
        compacts at the next quiet tick past the warn threshold. A failed or empty
        handoff turn waits for ratio. false = compact only at ratio. critical_ratio is
        unaffected.
  `,

  compaction_warn_notice: `
    The PRE-COMPACTION notice posted to the admin channel at the WARN threshold
    (compaction.warn_gap below compaction.ratio), operator 2026-10-08 — the PRIMARY
    compaction notice now, said a few % before the context compacts so the operator
    is warned AND the handoff already exists. The node still prefixes its own
    "node · chat" line (src/spine/compaction.mjs warnNotice), as it does for the
    post-hoc "compacted" confirmation.

    PLACEHOLDERS (resolved like {agent} already is elsewhere):
      {agent}    the being's handle (first segment of the warm key)
      {percent}  current fullness = round(tokens / window * 100)
      {path}     the handoff file the being writes — the file compaction.handoff_prompt
                 names, resolved and joined to the being's cwd, so the operator can open
                 it (handoffs/{agent}.handoff.md when the prompt names none)

    DEFAULT: unset — the operator's reference wording is used:
    "the conversation is at {percent}%, handoff being written, compaction next. you
    can read the handoff here: {path}". A blank/whitespace string SKIPS the notice
    (same degrade as handoff_prompt / welcome); no admin_channel sink also skips it.
  `,
};
