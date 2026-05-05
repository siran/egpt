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
  node_name:    'name this node uses on the bus (e.g. home, chr1); takes effect on next shell restart',
};
