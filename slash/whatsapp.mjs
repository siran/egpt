// slash/whatsapp.mjs — manage the baileys bridge: start, pair, disconnect,
// allow/revoke specific phone numbers.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EGPT_HOME = join(homedir(), '.egpt');
const AUTH_DIR  = join(EGPT_HOME, 'wa-auth');
const CFG_PATH  = join(EGPT_HOME, 'config.json');

export const meta = {
  cmd: '/whatsapp',
  section: 'MISC',
  surface: 'shell',
  usage: '/whatsapp [start|pair|disconnect|allow <num>|revoke <num>|allowed]',
  desc:
    'manage whatsapp bridge: start (existing auth), pair (wipe + new QR), ' +
    'disconnect, allow/revoke numbers',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text), dp(p)
  //   waBridgeRef                      — React ref → bridge instance
  //   clearGlobalWaBridge()            — null out the SIGTERM-flush slot
  //   startWaBridge(forcePair: bool)   — host-side bridge bootstrap
  const { sysOut, dp, waBridgeRef, clearGlobalWaBridge, startWaBridge } = ctx;

  const argParts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = argParts[0];
  const subArg = argParts.slice(1).join(' ').trim();

  if (!sub) {
    const status = waBridgeRef.current
      ? `connected as ${waBridgeRef.current.myJid ?? '?'}\n  last chat: ${waBridgeRef.current.chatId ?? '(none)'}`
      : 'not running';
    sysOut(
      `whatsapp: ${status}\n` +
      `\n/whatsapp start               start the bridge with existing auth (use this first)` +
      `\n/whatsapp pair                ONLY when auth is expired/invalid: wipe + show new QR` +
      `\n/whatsapp disconnect          stop the bridge (auth preserved)` +
      `\n/whatsapp allow <number>      authorize a phone number for commands` +
      `\n/whatsapp revoke <number>     remove authorization` +
      `\n/whatsapp allowed             list authorized numbers`
    );
    return true;
  }

  if (sub === 'start' || sub === 'connect') {
    if (waBridgeRef.current) { sysOut('whatsapp: already running'); return true; }
    const ok = await startWaBridge(false);
    if (!ok) sysOut('whatsapp: start failed — auth may be missing. Run /whatsapp pair to (re-)pair.');
    return true;
  }

  if (sub === 'pair') {
    if (waBridgeRef.current) {
      try { waBridgeRef.current.stop(); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
      waBridgeRef.current = null;
      clearGlobalWaBridge();
    }
    try { await rm(AUTH_DIR, { recursive: true, force: true }); }
    catch (e) { sysOut(`!! couldn't wipe ${AUTH_DIR}: ${e.message}`); return true; }
    sysOut(`whatsapp: auth wiped at ${dp(AUTH_DIR)}; restarting bridge — QR coming up`);
    await startWaBridge(true);
    return true;
  }

  if (sub === 'disconnect') {
    if (!waBridgeRef.current) { sysOut('whatsapp: not running'); return true; }
    try { waBridgeRef.current.stop(); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
    waBridgeRef.current = null;
    clearGlobalWaBridge();
    sysOut('whatsapp: disconnected (auth preserved). /whatsapp pair to start over');
    return true;
  }

  if (sub === 'allow' || sub === 'revoke') {
    const number = subArg.replace(/[^\d]/g, '');
    if (!number) {
      sysOut(`!! /whatsapp ${sub} <number> — number must be the phone digits (with or without +, dashes, spaces)`);
      return true;
    }
    let cfg = {};
    try { cfg = JSON.parse(await readFile(CFG_PATH, 'utf8')); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
    if (!cfg.whatsapp || typeof cfg.whatsapp !== 'object') cfg.whatsapp = {};
    if (!Array.isArray(cfg.whatsapp.allowed_users)) cfg.whatsapp.allowed_users = [];
    if (sub === 'allow') {
      if (!cfg.whatsapp.allowed_users.some(u => String(u).replace(/[^\d]/g, '') === number)) {
        cfg.whatsapp.allowed_users.push(number);
      }
    } else {
      cfg.whatsapp.allowed_users = cfg.whatsapp.allowed_users.filter(
        u => String(u).replace(/[^\d]/g, '') !== number,
      );
    }
    await mkdir(EGPT_HOME, { recursive: true });
    await writeFile(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    sysOut(`whatsapp: ${sub === 'allow' ? 'allowed' : 'revoked'} ${number} (takes effect on /whatsapp pair or shell restart)`);
    return true;
  }

  if (sub === 'allowed') {
    let cfg = {};
    try { cfg = JSON.parse(await readFile(CFG_PATH, 'utf8')); } catch (e) { console.error(`!! whatsapp.mjs:[catch] ${e?.message ?? e}`); }
    const ids = cfg.whatsapp?.allowed_users ?? [];
    sysOut(ids.length === 0
      ? 'whatsapp: no allowed users — commands and mentions are rejected'
      : `whatsapp allowed users:\n${ids.map(id => `  ${id}`).join('\n')}`);
    return true;
  }

  sysOut(`!! unknown subcommand: ${sub}\n/whatsapp with no args lists subcommands`);
  return true;
}
