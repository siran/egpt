// config-schema.mjs — registered top-level keys for ~/.egpt/config.json
// (and the local override at .egpt/config.json).
//
// Adding a new EGPT_CONFIG.<key> read in egpt.mjs without registering it
// here means /config rejects the key as 'unknown' — broken UX. The
// integrity test in tests/integrity.test.mjs catches that mismatch by
// grepping egpt.mjs for EGPT_CONFIG references and comparing with this
// schema. So: when you read a new key, register it here too.
//
// Nested config blocks (e.g. `telegram` with sub-keys bot_token,
// allowed_users, chat_id, mirror, node_name) are not validated by
// /config — those are read elsewhere via direct JSON parse — and are
// out of scope for this schema.

export const CONFIG_SCHEMA = {
  theme:        'color theme name  (see /themes)',
  show_prompts: 'show full operator prompt before each turn  (true/false)',
  unix_paths:   'display filesystem paths in POSIX style  (true/false)',
  tz_label:     'short timezone label shown next to timestamps (e.g. NYC, MAD, BEI; default = system short tz)',
  user_name:    'handle for the human typing here, shown in cross-surface mirroring as <user_name>@<surface>. Default: "egptbot". Override via this config key, EGPT_USER_NAME env var, or per-bridge node_name in telegram/whatsapp blocks.',
  node_name:    'name this node uses on the bus (e.g. home, chr1); takes effect on next shell restart',
  telegram:     'telegram bridge config: { bot_token, allowed_users, chat_id, mirror, node_name, client_name (default "tg", appears in handle@client tags), max_backlog_seconds (default 5 — grace window in seconds; messages with Telegram-side timestamps older than N seconds before bridge connect are HELD instead of auto-dispatched and reviewed via /tg-pending. 0 = strict (hold ANYTHING pre-connect). -1 = disable hold entirely (legacy behavior; not recommended — daemon restart auto-executes brain on every queued message)) }',
  // whatsapp: nested object with keys { enabled, allowed_users, chat_id }.
  // The bridge starts when this block is present (and not enabled:false).
  // First run: scans QR; auth persists at ~/.egpt/wa-auth/.
  whatsapp:     'whatsapp bridge config: { enabled, allowed_users, chat_id (auto-captured), mirror_chat_id (default: self-DM), awareness {...}, client_name (default "wa", appears in handle@client tags), max_backlog_seconds (default 5 — grace window in seconds; messages older than N seconds before bridge connect are HELD and reviewed via /wa-pending. 0 = strict hold; -1 = disable hold (legacy auto-dispatch)), egpt_chats [...JIDs treated as full-mirror egpt chats; self-DM is always one], mirror_headers ("all" default | "brain_only" — only persona/session items carry headers | "none"), follow_join ("never" default | "from_shell" adopt wa-join announces from a shell peer | "always" adopt from any peer), media { download ("all" default — save every media type to ~/.egpt/media/<chatJid>/<msgId>.<ext> | "images_docs" only images + documents | "off" disable), max_size_mb (default 25, skip downloads larger than this), notify ("on" default — sysOut a 📎 line per save, but silence status@broadcast which is high-volume; "all" notify for status too; "off" silent), summarize { operator (null default | session-name like "cgpt1" — auto-run the operator on each downloaded image/document and save a .summary.md alongside; PENDING — operator wiring not built yet, leave null for now), types (default ["image","document"]) }, audio_transcribe { enabled (default false — PENDING; Whisper/Claude-audio not wired; flagged to track interest) } } }',
  whatsapp_cdp: 'extension-only WhatsApp via a content script in web.whatsapp.com. v1: { enabled (set to false to opt out), chat_id (auto-captured), chat_name (the visible label of your self-DM. When set, dispatch fires for every message in THAT chat; in OTHER chats a leading "@egpt"/"@e" wake-word is required), client_name (default "wa-cdp"), channels_default (default 10), allowed_users (array of additional WA-side display names allowed to issue commands/mentions from non-self-DM chats. Default — list unset — only the main user (userName) can dispatch; everyone else is observe-only) }.',
  // default_brain: the persona that responds to @egpt mentions. Lives
  // outside any room — has its own persistent conversation thread.
  // session_id is auto-populated on first @egpt and reused thereafter.
  default_brain: 'default brain (the @egpt persona — same machinery as /attach, just node-global): { type: "claude-code"|"codex", session_id: "<auto>", cwd?: "...", allowed_tools?: "all" | "<space-sep>" (claude-code only; default "all" auto-answers \'yes\' to permission prompts), system_prompt?: "..." (opt-in; absent = brain default) }',
  emojis:       'author-emoji defaults for cross-surface mirroring (TG/WA): { user: "🦅" (shell user — USER_NAME), egpt: "🧠" (egpt status/system voice), persona: "🐶" (egpt persona reply — @egpt answers), human: "🌐" (extension\'s default \'human\' tag — distinct surface) }. Read once at shell startup; restart to apply.',
  room:         'room behaviour: { on_join: "lazy" (default — saved sessions load as data; brains spin up on first @session use), "eager" (auto-/attach every saved session on /room join — opens Chrome tabs, starts codex processes), "off" (do not load saved sessions at all on join — start clean), max_chain (default 3, max brain-to-brain reply chain depth before the next dispatch returns "…" instead of calling the brain; guards against orchestra-style runaway when one brain\'s reply triggers another\'s dispatch) }',
  chrome:       'chrome control: { focus_on_dispatch ("on" default | "off") — bring the brain Chrome window to the foreground before each brain dispatch. CDP Target.activateTarget + Page.bringToFront fire regardless; this knob controls the OS-level fallback that breaks past Windows SetForegroundWindow restrictions / macOS / X11 anti-focus-stealing rules. Targets the brain Chrome by PID when egpt spawned it (/chrome); falls back to app-name on macOS / Linux. Set to "off" if the focus theft becomes intrusive (e.g. mid-typing in another app). }',
  mirror:       '/mirror defaults: { tagged ("on" default | "off") — whether /mirror prefixes the forwarded body with [author timestamp]:. The flag --tagged / --no-tag overrides per-call regardless of config. With tagged on, destinations see who originally said it; with off, the body reads like a fresh message. }',
  brains:       'brain identity / setup: { identity ("./e_identity.md" default | "<path>" | "off") — read once per session and sent as a SILENT setup turn before the first real user message, framed as "... system restarted, new persona installed ...\\n\\n<content>". Persisted per session via session.options.identityInjected so a daemon restart does not re-inject. /identity [@<session>] forces a fresh inject any time (e.g. after editing the identity file). }',
};
