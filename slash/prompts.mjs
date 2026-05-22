// slash/prompts.mjs — toggle "show full operator prompt before each turn",
// and list the prompt templates that drive @-commands like /browse,
// /send-file, /summarize, /inject, /codex-task.

import { loadTemplate } from '../src/tools/template.mjs';

export const meta = {
  cmd: '/prompts',
  section: 'MISC',
  surface: 'shell',
  usage: '/prompts [on|off]',
  desc: 'show operator prompt templates; toggle whether they print before each turn',
};

const KNOWN_TEMPLATES = ['browse', 'send-file', 'summarize', 'inject', 'codex-task'];

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   getShowPrompts() / setShowPrompts(bool)  — getter/setter for the
  //                                              mutable _showPrompts let in egpt.mjs
  //   dp(path)        — path display formatter (POSIX-style under unix_paths)
  const { sysOut, getShowPrompts, setShowPrompts, dp } = ctx;
  const a = arg.trim();

  if (a === 'on')  { setShowPrompts(true);  sysOut('prompt display on — full task text shown before each operator turn'); return true; }
  if (a === 'off') { setShowPrompts(false); sysOut('prompt display off'); return true; }

  // No arg: show templates + current toggle state.
  const parts = [`prompt display is ${getShowPrompts() ? 'ON' : 'OFF'}  (/prompts on|off to toggle)\n`];
  for (const c of KNOWN_TEMPLATES) {
    const tpl = await loadTemplate(c);
    if (tpl) {
      parts.push(`── /${c} ── (${dp(tpl.path)})`);
      parts.push(tpl.body.length > 1200 ? tpl.body.slice(0, 1200) + '\n...[truncated]' : tpl.body);
      parts.push('');
    } else {
      parts.push(`── /${c} ── (no template file found)`);
      parts.push('');
    }
  }
  sysOut(parts.join('\n'));
  return true;
}
