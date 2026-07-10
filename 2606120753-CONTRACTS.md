# egpt CONTRACTS — what the spine promises, one line each

Every line is an invariant a test must keep from regressing. Read the whole file
in two minutes. The *why* lives in [`GENOME.md`](GENOME.md); the config
surface in [`config/config-schema.mjs`](config/config-schema.mjs).

1. The spine is a loop that receives and dispatches messages through Beeper, as
   main transport.


2. Every loop iteration checks the heartbeats and runs what is due.


3. For every message received by the spine:

   3.1 passes asynchronously to a "stats collector" module

   3.2 is appended to the transcript of the conversation (see below) -- nothing
      is ever lost


4. Limbs of the spine — how a message gets in and out:

   4.1 Beeper delivers any message from any network the operator configured, and
       the spine replies back through Beeper the same way.

   4.2 A limb is a dumb pipe — it hands raw input to the nucleus and sends what
       the nucleus gives back; all thinking (routing, gating, transcription,
       memory) happens once, in the nucleus.

   4.3 The one transport-specific job is downloading the media bytes; everything
       after the local file exists is nucleus.

   4.4 The model sees `Sender@[chat].{node} (HH:MM): body` — `{node}` is
       the entry point (wa/tg/signal/kg), resolved from the surface, never
       hardcoded, never the operator's own contact label.

   4.5 A chat id is a short opaque string everywhere inside the spine — the
       Matrix decoration (`!…:beeper.local`) exists only at the Beeper API
       boundary, stripped on receipt and re-added on send.


5. Everything is heard and logged; only some of it is spoken.

   5.1 Every inbound message and every agent reply — surfaced OR withheld —
       is written to the conversation's `transcript.md`, tagged sent/not-sent;
       logging never depends on the mode.

   5.2 A withheld reply is byte-identical in the transcript to a sent one — the
       gate filters the surface step only, never the format or the logging.

   5.3 `transcript.md` is a rolling window opening with a YAML front-matter
       header; every reader strips the header so it never reaches the model as
       a turn.

   5.4 A message is built as a UNIT once, at the single dispatch entry,
       complete with its `#<id>`; both the persona path and the sibling path
       consume that one line.


6. The mode is the gate; one emit gate, fail-closed.

   6.1 Every agent reply passes one gate (`mayEmitChat`) before it can reach a
       chat — streaming replies fail closed through one factory, the few
       non-streaming sends call the same gate, raw transport-send is
       system/lifecycle-only.

   6.2 Per-chat mode (`on` / `mention` / `mention-direct` / `mute` / `off`)
       decides surfacing; `…` is a valid, logged silence.

   6.3 `paused` is an absolute kill that overrides the mode; `mute` and `off`
       never emit.

   6.4 A reaction and an edit follow the SAME mode gate as a message — each
       arrives as a stage-direction `[ … reacted 👍 to #<id> "…" ]` / `[ …
       edited #<id> "old" → "new" ]`, recorded always, answered only where the
       mode permits.

   6.5 Surfaced replies fan out only on the finished message, never the live
       stream (streaming is for the human; finished messages for other beings).


7. Authorization is provable and id-based, fail-closed.

   7.1 Each surface owns its own `{chat_id, allowed_users}`; an id is a
       per-surface namespace (a WhatsApp jid authorizes nothing on Signal);
       empty `allowed_users` = deny.

   7.2 The operator is a STABLE id, never a display name (a chat title is
       attacker-controllable); the account owner always passes.

   7.3 Emit authorization keys off genuine persona replies, never the echo set
       — no persona inference or fallback.

   7.4 An unauthorized slash command is dropped before it runs; commands are
       engine-first, never fanned to rooms or mirrored to another surface to
       re-interpret.


8. Media is saved, per conversation.

   8.1 Every attachment saves into that conversation's `media/` with a
       meaningful name + a sidecar caption + an `index.md` entry (policy
       `whatsapp.media.download`: all / images_docs / off).

   8.2 The bytes live once, in the originating conversation; a room references
       the path, never copies it.

   8.3 A voice note is saved AND transcribed — the old bug was
       transcribe-then-drop.

   8.4 A video is handed to the model cooked — the host (outside the sandbox)
       extracts keyframes into `media/` and transcribes the audio track; the
       model never runs ffmpeg.


9. Voice is transcribed before the model sees it.

   9.1 Every voice/audio note is transcribed at the nucleus and the model is
       fed the transcript, never raw audio.

   9.2 Transcription is a per-entity room service in the conversation's own
       `config.yaml` (`transcription: { enabled, posts_back }`, both
       default-on) — `enabled` = heard (model + transcript get it), `posts_back`
       = the `👂` ack spoken in-chat.

   9.3 A degenerate whisper repetition loop is mitigated at whisper's own
       decoder AND a backend-agnostic post-pass that flags any survivor before
       it reaches the model, transcript, or ack.


10. Beings run warm on the Claude Code CLI.

   10.1 Every being runs on the local `claude` CLI (`ccode`); the in-process
        SDK is retired — do not reintroduce it.

   10.2 A conversation runs as a resident background agent, warm ~15m after its
        last message (`warm.idle_ttl_by_class`, per-conversation override in the
        conv folder's `config.yaml`), then reaped; `--resume` restores context
        cold.

   10.3 A warm session grown past a ratio of the context window auto-compacts
        in place; the full record stays in `transcript.md`, nothing lost.


11. Confinement is structural, not policy.

   11.1 A conversation agent's file tools are confined to its own folder ∪ the
        rooms it belongs to ∪ operator grants — enforced by the Claude
        engine's OWN permission system (`--add-dir` + no `~/.claude` bypass +
        no bare `Bash` + no `Agent`), not a hand-rolled hook.

   11.2 An agent-type lists its tools explicitly (`allowed_tools`, a LIST) =
        confined; `all` is accepted but never produced by egpt (trusted/
        unconfined except bare Bash and Agent, never implicit);
        `allowed_paths` grants extra read-only or read-write roots.


12. Boot is fatal without a persona.

   12.1 A node with no `agents` block, or no persona agent (handles include
        `e`/`egpt`), refuses to boot.

   12.2 The persona's engine + model come from its agent-type file
        (`agents.<name>.configuration` → `config/agents/<type>.yaml`); there is
        no `default_brain`.

   12.3 A fresh conversation freezes its agent type into `conversations.yaml`
        `readonly` deterministically (concrete model/effort, never null).


13. The profile is one canonical layout.

   13.1 Config is `EGPT_HOME/config/config.yaml` ONLY — no legacy locations,
        no JSON, no boot migrations.

   13.2 Layout: `config/{config.yaml, conversations.yaml, agents/,
        identities/<name>.md, logs/, skeletons/}`; `state/{ingest/, alive.txt,
        spine.pid, stats/}`; `conversations/<surface>/<slug>/`; `rooms/<name>/`.

   13.3 Identities are flat `config/identities/<name>.md`; the shared
        identity/pointers/rules ship as the room template
        `config/skeletons/room/`, seeded copy-if-missing (operator edits
        sacred).


14. Lifecycle rides the ingest box.

   14.1 Drop a file into `state/ingest/` to command the live node; it is
        consumed once.

   14.2 `/restart` (exit 43) respawns from disk, `/upgrade` (42) git-pulls +
        installs + respawns, `/rewind` (44) checks out a ref + respawns — codes
        only mean something under the supervisor.

   14.3 The `/e` wizard repoints a being live (operator-only, guided
        agent-type → model → effort pick): it freezes the target's `readonly`
        and evicts its warm session; context survives via the kept thread.


15. Nothing is dropped, nothing runs away.

   15.1 On reconnect/wake the backlog drains PACED (as-if-always-on) — old
        messages are recorded-as-seen, only live traffic is dispatched.

   15.2 A flood guard at the send chokepoint pauses a chat that exceeds `limit`
        sends in `window_ms`; the process stays up, only that chat pauses.

   15.3 No error is silent — every failure goes to a sink and a durable log
        (`config/logs/`).


16. The mesh is a transport over chat.

   16.1 A relayed message is an ordinary visible chat message: a base64 body +
        a human-readable YAML provenance tail (`from`/`from_node`/`by`/`to`/
        `re`/`post_id`/`mid`/`done`/`enc`).

   16.2 A spine forwards a given `mid` at most ONCE — multi-hop transit is
        loop-safe and self-terminating, no ttl.

   16.3 A message carrying a provenance block is relay traffic — consume it,
        never re-relay; bot↔bot always rides a visible transport, never a
        backchannel.

   16.4 A service-level hop cap bounds multi-hop transit, and an origin that
        gets no reply surfaces "did not answer" after a timeout — addressed
        traffic is never silently lost.
