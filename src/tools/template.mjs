// tools/template.mjs — THE fill for every text template a user writes in config: {var} → its value.

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

// ── log_messages: every line the node posts to its log channel (log_to_group, else admin_channel) ──
// config.yaml `log_messages.<kind>`: unset → the built-in default below (today's text, byte for byte);
// a blank string → that line is not posted; anything else goes through fill. A line built from many
// optional parts is templated by its frame, the assembled body arriving as {details}.
const NODE = "this node's name (node_name)";
const DETAILS = 'the assembled body, with its own leading separator; may be empty';
export const LOG_MESSAGES = {
  command_audit: { default: '{command} in {chat} by {sender}{details}', vars: { command: "the command, `/name`, or `alias 'x' → /name`; never its arguments", chat: 'the conversation it was typed in', sender: 'who typed it', outcome: 'what a silent handler reports (/end); may be empty', details: "' → {outcome}', or empty" } },
  going_down: { default: '↻ {kind}… (pid {pid})', vars: { kind: 'the lifecycle command: /restart, /upgrade, /upgrade full, /rewind, /standdown', pid: 'the process that is going down' } },
  started: { default: '✅ egpt started ({sha}) pid {pid}{details}', vars: { sha: 'the commit the node came up on', pid: 'the new process', subject: "the commit's subject line", details: "blank line + {subject}, or empty" } },
  back_up: { default: '✅ egpt back up! ({head}) {pids}{details}', vars: { head: "the commit, or 'old → new' when it changed", pids: "'pid N', or 'pid old → new'", kind: 'the lifecycle command that led here; may be empty', outcome: 'what /upgrade or /rewind did, from the daemon; may be empty', note: "the daemon's ⚠️ paragraph (a recovery, a migration that needs the operator); may be empty", subject: "the commit's subject line", details: "' — {kind}: {outcome}', then the ⚠️ {note} paragraph, then the {subject} paragraph; each only when present" } },
  pending_updates: { default: '⬆ pending: {details}{ask}', vars: { details: 'what is pending, joined with " · "', ask: "'. Apply now?' when a human still has to type something, else empty" } },
  egpt_update_notice: { default: '⬆ {node} · {details}', vars: { node: NODE, details: 'eGPT N new commits on <branch> (from → to): <subjects> — what happens next' } },
  egpt_update_stuck: { default: '⬆ {node} · {details}', vars: { node: NODE, details: 'why the daemon cannot be renewed automatically' } },
  beeper_update_notice: { default: '⬆ {node} · {details}', vars: { node: NODE, details: 'Beeper <version> downloaded (running …) — what happens next' } },
  beeper_update_start: { default: '🔄 {node} · Beeper {from} → {to} · restarting for update… {marker}', vars: { node: NODE, from: 'the version before', to: 'the version after', marker: 'the tag the result line replaces this one by; keep it in the template, else the result is posted as a new line' } },
  beeper_update_result: { default: '🔄 {node} · Beeper {from} → {to}{details}', vars: { node: NODE, from: 'the version before', to: 'the version after', details: "' · restarted in N s · <connection> ✓ …', or ' · FAILED at <step>: <why>' …" } },
  beeper_update_refused: { default: '{node} · {details}', vars: { node: NODE, details: 'why an automatic Beeper update did not start' } },
  beeper_connection_gone: { default: "{node} · ⚠ Beeper connection '{connection}' has answered on no port for {minutes} min — no install answers its token (Beeper not running, a service that can no longer log on, or a revoked token)", vars: { node: NODE, connection: 'the connection name', minutes: 'how long it has been silent' } },
  beeper_connection_back: { default: "{node} · ✓ Beeper connection '{connection}' answers again ({url})", vars: { node: NODE, connection: 'the connection name', url: 'where it answers' } },
  media_flood: { default: '{node} · {details}', vars: { node: NODE, details: 'the new-chat burst notice' } },
  send_rate_guard: { default: '{node} · send-rate guard paused {chat} — {why}', vars: { node: NODE, chat: 'the chat that was paused', why: 'what tripped the guard' } },
  lag_probe: { default: '{node} · {details}', vars: { node: NODE, details: 'the lag / recovered / sleep report' } },
  undelivered: { default: '{node} · ⚠ {what}{being} not delivered to {title}{chat} — {reason}', vars: { node: NODE, what: 'opener, reply, limb …', being: "' (handle)' of the being sending, or empty", title: "'\"name\" ' of the chat when it has one, or empty", chat: "the chat's id", reason: 'why it was not delivered' } },
  public_error: { default: '{being} in {chat}: {text}', vars: { being: 'the public being', chat: 'the chat', text: 'the error line that would have gone to the chat' } },
  drain_waiting: { default: '{node} · restart waiting {elapsed} for {details}. Send /restart force to proceed.', vars: { node: NODE, elapsed: 'how long the restart has waited', details: 'the turns and background work it waits for' } },
  config_refused: { default: '{node} · config.yaml change refused, the running config stays: {error}', vars: { node: NODE, error: 'why the new config.yaml was refused' } },
  background_unanswered: { default: '{node} · {being} in {chat}: background task(s) {what} running {elapsed}, the being did not answer whether they are still needed.', vars: { node: NODE, being: "the being's name", chat: 'the conversation', what: 'the background work', elapsed: 'how long it has run' } },
  login_captcha: { default: 'login {site}: a CAPTCHA is blocking sign-in — solve it in the brain Chrome, then re-run /login {site}. (screenshot {bytes}B captured; image delivery pending)', vars: { site: 'the site', bytes: 'the screenshot size' }, note: 'goes to captcha_channel (default admin_channel)' },
  compacted: { default: '🗜️ {who}{where} compacted its context{was}. The full history stays in its transcript.md.', vars: { node: NODE, label: "the being's display name", chat: 'the conversation; may be empty', tokens: 'the size it was decided at, in tokens; may be empty', who: "'{node} · {label}', or {label} alone", where: "' in {chat}', or empty", was: "' (was Nk tokens)', or empty" } },
  compaction_frame: { default: '🗜️ {who}{where}: {text}', vars: { node: NODE, label: "the being's display name", chat: 'the conversation; may be empty', who: "'{node} · {label}', or {label} alone", where: "' in {chat}', or empty", text: 'compaction_warn_notice / compaction_alert_notice, already filled' }, note: 'the frame of the pre-compaction warning and alert; their bodies stay compaction_warn_notice and compaction_alert_notice' },
};
for (const [k, m] of Object.entries(LOG_MESSAGES)) TEMPLATES[`log_messages.${k}`] = m.vars;

// The text to post for `kind`, or null when the operator blanked it. cfg = the parsed config.yaml.
export function logLine(cfg, kind, vars = {}) {
  const def = LOG_MESSAGES[kind]?.default;
  if (def == null) throw new Error(`unknown log message kind: ${kind}`);
  const raw = cfg?.log_messages?.[kind];
  const tpl = raw == null ? def : typeof raw === 'string' ? raw : String(raw);
  return tpl.trim() ? fill(tpl, vars) : null;
}
