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
  telegram:     'telegram bridge config: { bot_token, allowed_users, chat_id, mirror, node_name, client_name (default "tg", appears in handle@client tags) }',
  // whatsapp: nested object with keys { enabled, allowed_users, chat_id }.
  // The bridge starts when this block is present (and not enabled:false).
  // First run: scans QR; auth persists at ~/.egpt/wa-auth/.
  whatsapp:     'whatsapp bridge config: { enabled, allowed_users, chat_id (auto-captured), mirror_chat_id (default: self-DM), awareness {...}, client_name (default "wa", appears in handle@client tags), max_backlog_seconds (default 0, drops pre-connect bursts older than N seconds), egpt_chats [...JIDs treated as full-mirror egpt chats; self-DM is always one], mirror_headers ("all" default | "brain_only" — only persona/session items carry headers | "none"), follow_join ("never" default | "from_shell" adopt wa-join announces from a shell peer | "always" adopt from any peer) }',
  whatsapp_cdp: 'extension-only WhatsApp via a content script in web.whatsapp.com. v1: { enabled (set to false to opt out), chat_id (auto-captured), chat_name (the visible label of your self-DM. When set, dispatch fires for every message in THAT chat; in OTHER chats a leading "@egpt"/"@e" wake-word is required), client_name (default "wa-cdp"), channels_default (default 10), allowed_users (array of additional WA-side display names allowed to issue commands/mentions from non-self-DM chats. Default — list unset — only the main user (userName) can dispatch; everyone else is observe-only) }.',
  // default_brain: the persona that responds to @egpt mentions. Lives
  // outside any room — has its own persistent conversation thread.
  // session_id is auto-populated on first @egpt and reused thereafter.
  default_brain: 'default brain (the @egpt persona — same machinery as /attach, just node-global): { type: "claude-code"|"codex", session_id: "<auto>", cwd?: "...", allowed_tools?: "all" | "<space-sep>" (claude-code only; default "all" auto-answers \'yes\' to permission prompts), system_prompt?: "..." (opt-in; absent = brain default) }',
  emojis:       'author-emoji defaults for cross-surface mirroring (TG/WA): { user: "🦅" (shell user — USER_NAME), egpt: "🧠" (egpt status/system voice), persona: "🐶" (egpt persona reply — @egpt answers), human: "🌐" (extension\'s default \'human\' tag — distinct surface) }. Read once at shell startup; restart to apply.',
};
