// The Windows half of src/spine/sandbox-pins.mjs: where the launcher keeps pins, and the release
// script (setup/release-sandbox-pin.ps1). The spine only calls these on win32.
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// setup/sandbox-account.ps1 $SandboxPinsDir.
export const SANDBOX_PINS_DIR = join(process.env.ProgramData || 'C:\\ProgramData', 'egpt', 'sandbox-pins');
const RELEASE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'setup', 'release-sandbox-pin.ps1');

export function spawnPinRelease(key, spawn = nodeSpawn) {
  return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RELEASE_SCRIPT, '-Key', key], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
}
