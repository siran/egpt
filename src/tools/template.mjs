// tools/template.mjs — THE fill for every text template a user writes in config: {var} → its value.
import { readFileSync } from 'node:fs';
import * as YAML from 'yaml';

const CHAT = "the original chat's name";
const HANDLE = 'the handle the command was typed to';
const STAMP = { agent: "the being's handle", 'YYMMDD-HHMM': 'the local time of the warning' };

// Each template key → its variables, in plain words. Docs: config/skeletons/config.yaml, MANUAL.md.
export const TEMPLATES = {
  group_title: { group: CHAT, name: 'the name typed after split (none: 5 random letters)' },
  'split.placeholder': { link: 'the link that opens the fork (a Telegram topic); empty where there is none' },
  'split.opener': { group: CHAT, handle: HANDLE },
  'send.origin_template': { group: "the side group's name" },
  'compaction.handoff_prompt': STAMP,
  'compaction.welcome': STAMP,
  compaction_warn_notice: { agent: "the being's handle", percent: 'how full the conversation is', path: 'the handoff file' },
  compaction_alert_notice: { agent: "the being's handle", chat: "the conversation's name", in: 'time left before the compaction, e.g. 10m', percent: 'how full the conversation is' },
  'heartbeats.<name>.post': { stdout: "the command's output, trimmed" },
};

// Only known variables are filled; an unknown {x} stays as written, so a typo shows.
export const fill = (tpl, vars) => tpl.replace(/\{([\w-]+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k] ?? '') : m));

// ── system_messages: every line the node posts to its log channel (log_to_group, else admin_channel) ──
// Lookup for a kind: config.yaml `system_messages.<kind>` → the pack of config `language` → en_US
// (config/locales/<language>.yaml, THE place the default texts live; the code holds only the variables).
// A blank string at any rung → that line is not posted; anything else goes through fill. A line built
// from many optional parts is templated by its frame, the assembled body arriving as {details}.
const NODE = "this node's name (node_name)";
const DETAILS = 'the assembled body, with its own leading separator; may be empty';
export const SYSTEM_MESSAGES = {
  command_audit: { vars: { command: "the command, `/name`, or `alias 'x' → /name`; never its arguments", chat: 'the conversation it was typed in', sender: 'who typed it', outcome: 'what a silent handler reports (/end); may be empty', details: "' → {outcome}', or empty" } },
  going_down: { vars: { kind: 'the lifecycle command: /restart, /upgrade, /upgrade full, /rewind, /standdown', pid: 'the process that is going down' } },
  started: { vars: { sha: 'the commit the node came up on', pid: 'the new process', subject: "the commit's subject line", details: "blank line + {subject}, or empty" } },
  back_up: { vars: { head: "the commit, or 'old → new' when it changed", pids: "'pid N', or 'pid old → new'", kind: 'the lifecycle command that led here; may be empty', outcome: 'what /upgrade or /rewind did, from the daemon; may be empty', note: "the daemon's ⚠️ paragraph (a recovery, a migration that needs the operator); may be empty", subject: "the commit's subject line", details: "' — {kind}: {outcome}', then the ⚠️ {note} paragraph, then the {subject} paragraph; each only when present" } },
  pending_updates: { vars: { details: 'what is pending, joined with " · "', ask: "'. Apply now?' when a human still has to type something, else empty" } },
  egpt_update_notice: { vars: { node: NODE, details: 'eGPT N new commits on <branch> (from → to): <subjects> — what happens next' } },
  egpt_update_stuck: { vars: { node: NODE, details: 'why the daemon cannot be renewed automatically' } },
  beeper_update_notice: { vars: { node: NODE, details: 'Beeper <version> downloaded (running …) — what happens next' } },
  beeper_update_start: { vars: { node: NODE, from: 'the version before', to: 'the version after', marker: 'the tag the result line replaces this one by; keep it in the template, else the result is posted as a new line' } },
  beeper_update_result: { vars: { node: NODE, from: 'the version before', to: 'the version after', details: "' · restarted in N s · <connection> ✓ …', or ' · FAILED at <step>: <why>' …" } },
  beeper_update_refused: { vars: { node: NODE, details: 'why an automatic Beeper update did not start' } },
  beeper_connection_gone: { vars: { node: NODE, connection: 'the connection name', minutes: 'how long it has been silent' } },
  beeper_connection_back: { vars: { node: NODE, connection: 'the connection name', url: 'where it answers' } },
  media_flood: { vars: { node: NODE, details: 'the new-chat burst notice' } },
  send_rate_guard: { vars: { node: NODE, chat: 'the chat that was paused', why: 'what tripped the guard' } },
  lag_probe: { vars: { node: NODE, details: 'the lag / recovered / sleep report' } },
  undelivered: { vars: { node: NODE, what: 'opener, reply, limb …', being: "' (handle)' of the being sending, or empty", title: "'\"name\" ' of the chat when it has one, or empty", chat: "the chat's id", reason: 'why it was not delivered' } },
  public_error: { vars: { being: 'the public being', chat: 'the chat', text: 'the error line that would have gone to the chat' } },
  drain_waiting: { vars: { node: NODE, elapsed: 'how long the restart has waited', details: 'the turns and background work it waits for' } },
  config_refused: { vars: { node: NODE, error: 'why the new config.yaml was refused' } },
  background_unanswered: { vars: { node: NODE, being: "the being's name", chat: 'the conversation', what: 'the background work', elapsed: 'how long it has run' } },
  login_captcha: { vars: { site: 'the site', bytes: 'the screenshot size' }, note: 'goes to captcha_channel (default admin_channel)' },
  compacted: { vars: { node: NODE, label: "the being's display name", chat: 'the conversation; may be empty', tokens: 'the size it was decided at, in tokens; may be empty', who: "'{node} · {label}', or {label} alone", where: "' in {chat}', or empty", was: "' (was Nk tokens)', or empty" } },
  compaction_frame: { vars: { node: NODE, label: "the being's display name", chat: 'the conversation; may be empty', who: "'{node} · {label}', or {label} alone", where: "' in {chat}', or empty", text: 'compaction_warn_notice / compaction_alert_notice, already filled' }, note: 'the frame of the pre-compaction warning and alert; their bodies stay compaction_warn_notice and compaction_alert_notice' },
};
for (const [k, m] of Object.entries(SYSTEM_MESSAGES)) TEMPLATES[`system_messages.${k}`] = m.vars;

// A language pack's texts, from the repo; an unknown language throws (boot's assertConfig surfaces it).
const packs = {};
export function languagePack(lang) {
  if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]+)?$/.test(String(lang))) throw new Error(`unknown language ${JSON.stringify(lang)}: no config/locales/${lang}.yaml`);
  try { return (packs[lang] ??= YAML.parse(readFileSync(new URL(`../../config/locales/${lang}.yaml`, import.meta.url), 'utf8'))?.system_messages ?? {}); }
  catch (e) { if (e.code === 'ENOENT') throw new Error(`unknown language ${JSON.stringify(lang)}: no config/locales/${lang}.yaml`); throw e; }
}

// The text to post for `kind`, or null when the operator blanked it. cfg = the parsed config.yaml.
export function logLine(cfg, kind, vars = {}) {
  if (!SYSTEM_MESSAGES[kind]) throw new Error(`unknown system message kind: ${kind}`);
  const tpl = cfg?.system_messages?.[kind] ?? (cfg?.language ? languagePack(cfg.language)[kind] : null) ?? languagePack('en_US')[kind];
  const text = typeof tpl === 'string' ? tpl : String(tpl);
  return text.trim() ? fill(text, vars) : null;
}
