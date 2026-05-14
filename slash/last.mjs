// slash/last.mjs — re-render the tail of the conversation in the shell.
//
// VIEW command: must NOT mirror to bridges (flood) and must NOT
// re-append to the .md (duplicate). Both protections are toggled on
// the way in: re-injected items get _localOnly so the items-mirror
// effect skips them, and suppressTranscriptRef makes sysOut + the
// echo path skip the append queue during this command.
//
// Operator-tool noise (slash command echoes, lifecycle messages,
// bus/telegram/whatsapp state events, previous /last headers) is
// filtered out — the room .md still records everything for
// forensics, but /last shows the actual conversation.

import { readFile } from 'node:fs/promises';

export const meta = {
  cmd: '/last',
  section: 'ROOM',
  surface: 'shell',
  usage: '/last [N]',
  desc: 'tail N messages (default 10)',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   setItems(updater)
  //   getFile()                  — current conversation md path
  //   suppressTranscriptRef      — set during the command so sysOut
  //                                + the echo path skip the append queue
  //   parseMessages(text)        — module-internal parser shared via ctx
  //                                until extracted to a shared util
  //   isMetaMessage(body)        — operator-tool noise classifier
  //   dp(path)                   — path display formatter
  const { sysOut, setItems, getFile, suppressTranscriptRef,
          parseMessages, isMetaMessage, dp } = ctx;

  const n = parseInt(arg, 10) || 10;
  suppressTranscriptRef.current = true;
  try {
    const FILE = getFile();
    const text = await readFile(FILE, 'utf8');
    const all = parseMessages(text);
    const meaningful = all.filter(m => !isMetaMessage(m.body));
    const msgs = meaningful.slice(-n);
    if (!msgs.length) { sysOut('(no messages yet)'); return true; }
    const hiddenCount = all.length - meaningful.length;
    const hiddenNote = hiddenCount > 0
      ? ` (${hiddenCount} system / operator-tool line${hiddenCount === 1 ? '' : 's'} hidden)`
      : '';
    sysOut(`--- last ${msgs.length} message(s) from ${dp(FILE)}${hiddenNote} ---`);
    setItems(p => [...p, ...msgs.map((m, i) => ({
      id: Date.now() + i / 1000,
      author: m.author,
      body: m.body,
      _localOnly: true,
    }))]);
  } catch (e) {
    sysOut(`!! ${e.message}`);
  } finally {
    suppressTranscriptRef.current = false;
  }
  return true;
}
