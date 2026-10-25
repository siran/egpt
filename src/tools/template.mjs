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
  'heartbeats.<name>.post': { stdout: "the command's output, trimmed" },
};

// Only known variables are filled; an unknown {x} stays as written, so a typo shows.
export const fill = (tpl, vars) => tpl.replace(/\{([\w-]+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k] ?? '') : m));
