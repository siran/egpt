# egpt ledger protocol — v0.1

Spec for the wire format that egpt nodes use to coordinate. This is the
protocol-shaped doc, separate from the implementation; if you want to
build a second implementation (different language, different surface,
different OS) you read this and the existing code becomes one reference
implementation among possibly many.

## Lineage

Borrowed wisdom from two prior arts; nothing in egpt is novel about the
room-protocol itself.

- **IRC** (RFC 1459, 1993) — the channel/presence model: nodes JOIN, PART,
  PRIVMSG to a channel; messages broadcast to all members; servers federate
  in a tree. egpt's `node-online` / `node-offline` / `room-utterance` are
  IRC's JOIN / QUIT / PRIVMSG translated into typed JSON events.
- **Matrix** (2014+) — typed events with a small envelope, federated rooms,
  bridges to other systems as first-class citizens. egpt's envelope shape
  and `via:` field for bridge attribution come straight from Matrix's
  `{ type, sender, content, room_id, origin_server_ts }` and bridge
  patterns. The "ledger" framing is Matrix's "room state plus event
  stream" framing, simplified.

What is **egpt-specific** and not borrowed:

- AI brains as first-class room participants (web-UI brains driven via
  CDP, plus local CLI subprocesses), addressed with `@<session>` and
  managed with `/open` / `/attach` / `/detach`.
- Markdown file as the conversation source of truth for the shell.
- Nodes coordinate via either an in-page CDP-driven event log
  (`bus.html`) on a LAN, or via an external chat bridge (Telegram today,
  others tomorrow) off-LAN. No homeserver, no daemon, no central authority.

Use Matrix if you need encrypted federation across organizations. Use
egpt if you want a one-human, multi-AI, multi-surface room without
running a server.

## Concepts

- **Node** — a running egpt nucleus. One process, one identity (its
  `node_name`). A node hosts zero or more sessions, may run a bridge,
  may participate in one or more rooms. Two egpt processes on one
  machine = two nodes.
- **Session** — a brain participant on a specific node, addressable as
  `@<session-name>`. Has a `brain` type (`chatgpt-cdp`, `claude-cdp`,
  `codex`, `claude-code`) and surface-specific state (a CDP target id,
  a subprocess handle).
- **Room** — a logical conversation. Today egpt has one implicit room
  per node (the surface's conversation ledger — `conversation.md`,
  IndexedDB, Telegram chat). The envelope reserves a `room` field for
  multi-room, but current implementations may ignore it (implicit
  default room).
- **Ledger** — the broadcast medium. Two flavors:
  - `bus-tab` — `bus.html` in a CDP-controlled Chrome on the local
    network. Events ride `Runtime.consoleAPICalled` with the literal
    arg string `egpt-bus` and a JSON payload. Posted via
    `Runtime.evaluate window.bus.post(ev)`.
  - `bridge` — an external chat (Telegram today) where every node with
    the same chat receives every message. Events today ride only as
    user-visible chat lines; control events do not yet cross bridges.
- **Event** — a typed JSON object with a fixed envelope plus type-specific
  fields. Section "Envelope" below.

## Envelope

Every event is a flat JSON object with at least these fields:

```jsonc
{
  "type": "<event-type>",   // string; namespaces by hyphen, e.g. 'mention-reply'
  "from": "<node_name>",    // sender node identity (its BUS_NODE_ID)
  "ts":   1730851234567,    // milliseconds since epoch (sender's clock)
  "room": "default",        // optional; absent = implicit default room
  "via":  "telegram[12345]" // optional; bridge attribution, see below
  // ... type-specific fields ...
}
```

- `type` is the only required field for routing. Unknown types MUST be
  ignored without error (forward-compat for new events).
- `from` MUST be present on every event; receivers filter their own
  echoes by comparing to their own `node_name`.
- `ts` is sender-local and used for display; receivers MUST NOT trust
  it for ordering across nodes. In-room order is the order events
  arrive at each receiver.
- `room` is reserved. If absent, the receiver SHOULD treat the event
  as belonging to the implicit default room.
- `via` indicates the event originated from a side channel carried by
  `from`. Used for bridge attribution: a Telegram user's message,
  carried by the shell node hosting the bot, has `from: "home"` and
  `via: "telegram[12345]"`. Author tags render as `<user>@<via>`,
  falling back to `<user>@<from>` when `via` is absent.

### Identifier formats

- **node_name**: `[a-z][a-z0-9_-]*` recommended. Default formats are
  `shell-<pid>` and `chrome-<rand4>`; user-set names override. Node
  names MUST be unique within a room; collision behavior is "last
  writer wins on the bus".
- **session name**: `[a-z][a-z0-9_-]*` recommended. Session names are
  unique within a node. Cross-node uniqueness is not required —
  `codex1@home` and `codex1@work` are different participants.
- **room id**: `[a-z][a-z0-9_-]*` recommended. Future namespacing
  (`#name@host` IRC-style or `!opaque:host` Matrix-style) is open.
- **via**: free-form bracket-tagged surface name. Convention:
  `telegram[<chatId>]`, `whatsapp[<chatId>]`, `signal[<group>]`.

## Ledger flavors

### bus-tab (on-LAN)

A `bus.html` page hosted in a CDP-controlled Chrome (one Chrome per
LAN, conventionally on port `:9221` private, exposed via a token-auth
proxy on `:9222`). The page exposes `window.bus.post(ev)` which:

1. Renders the event on a visible log (the bus tab is a debug surface).
2. Emits `console.log('egpt-bus', JSON.stringify(ev))`.

Subscribers attach a CDP session to the bus tab, enable `Runtime`
domain, and listen for `Runtime.consoleAPICalled` events whose first
arg is the literal string `egpt-bus`. The second arg is the JSON-encoded
event.

To post: subscribers call `Runtime.evaluate` with an expression that
invokes `window.bus.post(ev)`.

Multiple CDP sessions on the same target are supported by Chromium.
The shell attaches via the proxy's WebSocket; the extension attaches
via `chrome.debugger`. Both observe the same console events.

### bridge (off-LAN)

A chat hosted by an external service (Telegram now, WhatsApp / Signal /
Matrix later) where each node connects independently. Today only
human-visible chat lines cross bridges (mapped to `room-utterance`
on receive, plus brain replies sent as formatted messages). Control
events (`node-online`, `sessions-update`, etc.) do **not** yet cross
bridges; off-LAN nodes have a less rich picture of room state. See
"Open questions" below.

## Event vocabulary

All events as currently implemented. Each entry: purpose, fields,
required behavior on receive.

### `node-online`

Announces a node's presence in the room.

```jsonc
{
  "type": "node-online",
  "from": "home",
  "ts":   1730851234567,
  "role": "shell",         // 'shell' | 'chrome' | future
  "sessions": [ { "name": "codex1", "brain": "codex" }, ... ],
  "polling": false,        // true if this node is polling Telegram
  "pong": false            // true if this is a reply to another node-online
}
```

Behavior on receive: cache `from` in peer table with `role`,
`sessions`, `polling`, `lastSeen`. If `pong` is false, reply with a
`node-online` of your own with `pong: true` so the sender discovers
you too. (Matches IRC `WHO` reply semantics; symmetrical handshake.)

### `node-offline`

Announces a node's departure. Best-effort — sent on graceful shutdown,
may be missed on crash.

```jsonc
{ "type": "node-offline", "from": "home", "ts": ... }
```

Behavior on receive: drop `from` from peer table.

### `sessions-update`

Broadcasts a node's current session list when it changes (open / attach
/ detach). Idempotent.

```jsonc
{
  "type": "sessions-update",
  "from": "home",
  "ts":   ...,
  "sessions": [ { "name": "codex1", "brain": "codex" }, ... ]
}
```

Behavior on receive: replace `peer.sessions` for `from`.

### `telegram-status`

Broadcasts whether this node currently owns Telegram polling.

```jsonc
{ "type": "telegram-status", "from": "home", "ts": ..., "polling": true }
```

Behavior on receive: update `peer.polling` for `from`. Used by
`/telegram` (no-arg) to render the polling state across the room.

### `telegram-handoff`

Hands Telegram polling from one node to another. Sender is the node
giving up polling; `to` is the node taking over.

```jsonc
{ "type": "telegram-handoff", "from": "home", "ts": ..., "to": "chr1" }
```

Behavior on receive: if `to === self.node_name`, start the bridge.
Otherwise, if currently polling, stop.

### `mention`

Cross-node addressing of a session. The originator's `resolveRoute`
decided `@<session>` is on a peer, so it forwards.

```jsonc
{
  "type": "mention",
  "from": "chr1",          // originator
  "ts":   ...,
  "to_node": "home",       // destination node (must equal receiver's node_name)
  "target": "codex1",      // session name on the destination
  "body":   "exec: pwd",   // payload (the part after @target)
  "user":   "An"           // who originated the request (display only)
}
```

Behavior on receive: if `to_node !== self.node_name`, ignore.
Otherwise look up `target` in local sessions; run a brain turn; reply
with `mention-reply`.

### `mention-reply`

Response to a `mention`.

```jsonc
{
  "type": "mention-reply",
  "from": "home",
  "ts":   ...,
  "to_node": "chr1",       // back to the originator
  "target": "codex1",      // session that produced the reply (echoed for display)
  "body":   "C:/Users/an", // brain's response, or
  "error":  "no session 'codex1' on this node"
}
```

Behavior on receive: if `to_node !== self.node_name`, ignore.
Render in local UI as `<target>@<from>: <body>` (or `!! <error>`).
Implementations SHOULD NOT route this through `resolveRoute` — it's
a faithful echo, not user input.

### `command`

Forwards a slash command from a node that can't run it locally to one
that can. Used today by the extension to forward shell-only commands
(`/attach codex codex1`, `/save`, `/file`) to a shell node.

```jsonc
{
  "type": "command",
  "from": "chr1",          // originator
  "ts":   ...,
  "to_node": "home",       // destination node
  "cmd":    "/attach codex codex1",
  "user":   "An"           // who issued (display only)
}
```

Behavior on receive: if `to_node !== self.node_name`, ignore.
Otherwise pass `cmd` to local `handleSlash`. There is currently no
`command-reply` event; the originating node sees only its own
"`<cmd>` -> `<to_node>` via bus" confirmation. See "Open questions".

### `room-utterance`

Mirrors what a user typed on one surface to the room so peers see the
same conversation regardless of which surface they're looking at.

```jsonc
{
  "type": "room-utterance",
  "from": "home",
  "ts":   ...,
  "role": "shell",         // sender's role; redundant with peer cache
  "user": "An",            // who typed
  "body": "hello room",
  "via":  "telegram[12345]" // optional; present if input came from a bridge
}
```

Behavior on receive: filter self-echoes (`from === self.node_name`).
Render as `<user>@<via | from>: <body>` in the local UI / ledger.
Implementations MUST NOT route this through `resolveRoute` — it's
informational, not actionable. The originating surface already routed
to its own brains.

## Dispatcher contract

Implementations MUST:

1. **Filter self-echoes.** Every event with `from === self.node_name`
   is the dispatcher's own post bouncing back; ignore.
2. **Ignore unknown event types.** Forward-compat for new events.
3. **Honor `to_node` when present.** Events targeted to a specific
   node and not addressed to you are ignored.
4. **Prefer `via` over `from` for author tag rendering.** When `via`
   is set, the message originated from a side channel; tag accordingly.
5. **Treat events as faithful echoes.** Mirrored content
   (`room-utterance`, `mention-reply`) MUST NOT be routed through the
   local input router — it's already been routed by the originating
   node.

Implementations SHOULD:

- Pong back on receiving a `node-online` with `pong: false` so peers
  who joined late discover the existing room.
- Re-broadcast `node-online` on a slow heartbeat (e.g. every minute)
  so a node that joined after the burst still discovers everyone
  (IRC's reasoning: edge-triggered presence is brittle on flaky links).

## Adding new event types

When designing a new event:

1. Pick a hyphenated `type` name that reads as `subject-verb` or
   `subject-noun`: `command-reply`, `room-reply`, `session-renamed`.
2. Decide the addressing model: broadcast (no `to_node`) or directed
   (with `to_node`). Match the closest existing event.
3. Decide the ledger flavor: bus-tab only, bridge-eligible, or both.
   Today most events are bus-tab only; promoting to bridge requires a
   serialization convention that survives a chat message envelope.
4. Add to this doc with the same shape as existing entries, including
   "Behavior on receive".
5. Add a dispatch case in every implementation's bus handler.
6. Add an integration test exercising the new event end-to-end.

## Status table

What's implemented today (commit `36cd96f` and later) vs. planned.

| Event              | bus-tab | bridge | notes |
|--------------------|---------|--------|-------|
| node-online        | ✅      | ⏳     | bridge would let off-LAN nodes see who's around |
| node-offline       | ✅      | ⏳     | best-effort |
| sessions-update    | ✅      | ⏳     | promoting to bridge would let off-LAN address `@<session>` blind |
| telegram-status    | ✅      | n/a    | telegram-specific; not a candidate for bridge |
| telegram-handoff   | ✅      | n/a    | telegram-specific |
| mention            | ✅      | ⏳     | bridge form: addressed Telegram message → routed by recipient |
| mention-reply      | ✅      | ⏳     | bridge form: brain reply sent back through the chat |
| command            | ✅      | ⏳     | slash-command forwarding; bridge form needs reply event |
| room-utterance     | ✅      | ✅     | bridge: every chat message IS a room-utterance for the others |
| **command-reply** ⏳| ⏳      | ⏳     | shell sends back forwarded command output |

There is intentionally no `room-reply` event for auto-mirroring brain
replies to peers. The admin's tool for that is `/mirror` — explicit
agency over what gets shared, since brain replies can be long and not
always interesting to other nodes. Auto-broadcast every reply would
turn the bus into noise.

## Open questions

- **How do control events ride bridges?** Telegram is a chat. Embedding
  a JSON envelope in a chat message works but is ugly. One option: a
  reserved prefix (`#egpt-event:`) followed by a single-line JSON
  payload, formatted as a `<code>` block so it's collapsed in clients
  that support it. Another: a separate "control chat" per room. Open.
- **Multi-room**: how do nodes discover available rooms? IRC's `LIST`
  is per-server; in egpt with no server, peers would need to advertise
  which rooms they're in (e.g. extend `node-online` with `rooms: [...]`).
- **Authentication on the bridge**: today we trust that the Telegram
  chat is access-controlled by Telegram itself + `allowed_users` for
  command authorization. For other bridges (especially federation
  scenarios), per-event signing might be needed — see Matrix's signed
  events for the precedent.
