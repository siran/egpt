// slash/continue.mjs — resume an operator that paused via browser.waitForHuman().
//
// Drops a sentinel at ~/.egpt/browser-continue.txt which browser-tools.mjs
// polls; presence of the file releases the waiting tool back to the
// operator subprocess. Also clears the in-process "waiting" UI flag.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const meta = {
  cmd: '/continue',
  section: 'BRAINS',
  surface: 'shell',
  usage: '/continue',
  desc: 'resume a browser operator waiting on the human',
};

export async function run({ ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   EGPT_HOME           — for the sentinel file path
  //   setBrowserWaiting   — React state setter to clear the waiting label
  const { sysOut, EGPT_HOME, setBrowserWaiting } = ctx;
  const continueFile = join(EGPT_HOME, 'browser-continue.txt');
  try { writeFileSync(continueFile, '1', 'utf8'); }
  catch (e) {
    sysOut(`!! /continue: ${e.message}`);
    return true;
  }
  setBrowserWaiting(null);
  sysOut('browser resumed');
  return true;
}
