#!/usr/bin/env node
// egpt.mjs -- role launcher.
//
// The visible terminal UI is the shell limb. The spine/engine owns bridges,
// routing, transcripts, rooms, and brain dispatch. This launcher keeps the old
// `egpt` command stable while choosing the right role:
//   - --client: run only the Ink shell limb and attach to an existing spine.
//   - --headless/--spine/--engine: run the legacy spine entry directly.
//   - default: attach to a live spine; if none exists, start a headless spine
//     and then run the shell limb.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readNucleusInfo, loadOrCreateBusKey } from './src/attach/discovery.mjs';
import { connectAttachClient } from './src/attach/client.mjs';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const SPINE_ENTRY = join(APP_DIR, 'egpt-spine.mjs');
const rawArgs = process.argv.slice(2);

const has = (flag) => rawArgs.includes(flag);
const CLIENT = has('--client');
const HEADLESS = has('--headless');
const FORCE_SPINE = has('--spine') || has('--engine');
const cliArgs = rawArgs.filter(a => !['--client', '--headless', '--spine', '--engine'].includes(a));

async function runSpineInThisProcess() {
  process.env.EGPT_LAUNCHED_AS_SPINE = '1';
  await import('./egpt-spine.mjs');
}

async function runShellLimb() {
  const { runInkShellLimb } = await import('./src/shell/ink-limb.mjs');
  await runInkShellLimb({ version: 'egpt-shell-limb' });
}

async function spineIsLive() {
  let info = null;
  try { info = await readNucleusInfo(); } catch { return false; }
  if (!info?.port) return false;
  try {
    const keyB64 = await loadOrCreateBusKey();
    const probe = await connectAttachClient({
      host: info.host ?? '127.0.0.1',
      port: info.port,
      keyB64,
      kind: 'shell',
      version: 'egpt-launcher-probe',
      onFrame: () => {},
      onClose: () => {},
    });
    try { probe.close(); } catch {}
    return true;
  } catch {
    return false;
  }
}

function startHeadlessSpine() {
  const child = spawn(process.execPath, [SPINE_ENTRY, '--headless', ...cliArgs], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, EGPT_LAUNCHED_AS_SPINE: '1' },
  });
  child.unref();
  return child.pid;
}

// Keep one-shot legacy CLI subcommands in the spine entry for now; they reuse
// profile helpers that still live beside the old engine code.
if (cliArgs[0] === 'profile' || cliArgs[0] === 'profile-url' || cliArgs[0] === '--help' || cliArgs[0] === '-h') {
  await runSpineInThisProcess();
} else if (HEADLESS || FORCE_SPINE) {
  await runSpineInThisProcess();
} else if (CLIENT) {
  await runShellLimb();
} else if (await spineIsLive()) {
  console.log('egpt: spine is already running; opening shell limb');
  await runShellLimb();
} else {
  const pid = startHeadlessSpine();
  console.log(`egpt: started headless spine pid ${pid}; opening shell limb`);
  await runShellLimb();
}

