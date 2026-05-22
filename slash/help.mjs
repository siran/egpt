// slash/help.mjs — show shell-side commands; optionally address one user.
//
// Respects outputSinkRef like sysOut does: local-issued /help stays in
// the shell; bridge-issued /help goes back only to the originating
// bridge (not flood-mirrored to the other surfaces).
//
// /help @<who> prepends an @-mention. On Telegram that becomes a
// clickable mention (notifies the user); on WhatsApp it's plain text
// today — native mention notifications need mentionedJid wiring.

import { helpText, helpHtml } from '../src/interpreter.mjs';

const _escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const meta = {
  cmd: '/help',
  section: 'MISC',
  surface: 'shell',
  usage: '/help',
  desc: 'show available commands',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   setItems(updater)
  //   outputSinkRef                  — local | bridge target ('telegram' | 'whatsapp')
  //   brainNamesForHelp()            — filtered brain-name list for help substitutions
  const { setItems, outputSinkRef, brainNamesForHelp } = ctx;

  const bt = brainNamesForHelp();
  const recipient = arg.trim().match(/^@(\S+)$/)?.[1] ?? null;
  const prefix = recipient ? `(for @${recipient})\n\n` : '';
  const tgPrefix = recipient ? `<i>(for @${_escapeHtml(recipient)})</i>\n\n` : '';
  const sink = outputSinkRef.current;
  const localityMeta = sink === 'local'
    ? { _localOnly: true }
    : { _target: sink };
  setItems(p => [...p, {
    id: Date.now() + Math.random(),
    author: 'system', _bright: true,
    body: prefix + helpText(bt),
    _tgBody: tgPrefix + helpHtml(bt),
    ...localityMeta,
  }]);
  return true;
}
