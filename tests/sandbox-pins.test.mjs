// sandbox-pins (operator 2026-10-27: "this E should be tied only to this sandbox account, sticky...
// when the account is released all access permission is reset"). src/spine/sandbox-pins.mjs — the pin
// key, which pins conversations.yaml still asks for, and the releaser on the spine's tick — plus the
// launcher's pin wiring, locked on its source (a .ps1 with a param block cannot run here). The pin
// functions themselves grant and revoke for real in setup/sandbox-account.Tests.ps1.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, ensureContact, patchBeing } from '../src/conversations-state.mjs';
import { createSandboxPinReleaser, isSandboxPin, optedInPinKeys, readPinKeys, sandboxPinKeyOf, SANDBOX_PINS_DIR } from '../src/spine/sandbox-pins.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = () => readFileSync(join(REPO, 'setup', 'sandbox-logon-launcher.ps1'), 'utf8');
const accountLib = () => readFileSync(join(REPO, 'setup', 'sandbox-account.ps1'), 'utf8');

function stateWith(rows) {
  let s = emptyState();
  for (const { chatId, being, fields } of rows) {
    s = ensureContact(s, 'whatsapp', chatId, { pushedName: chatId, slugHint: chatId }).state;
    s = patchBeing(s, 'whatsapp', chatId, being, fields);
  }
  return s;
}

const pinFile = (key) => `# egpt sandbox pin - header\r\nkey=${key}\r\nC:\\Users\\an\\Documents|grant=Read\r\n`;

describe('the pin key and the opt-in walk', () => {
  it('a pin is a map (the allowed_paths shape); {} pins with no paths', () => {
    expect(isSandboxPin({})).toBe(true);
    expect(isSandboxPin({ 'C:/x': null })).toBe(true);
    for (const v of [undefined, null, true, 'C:/x', ['C:/x']]) expect(isSandboxPin(v)).toBe(false);
  });

  it('optedInPinKeys names exactly the being-in-conversation blocks that carry one', () => {
    const state = stateWith([
      { chatId: 'A', being: 'egpt', fields: { sandbox_pin: { 'C:/Users/an/Documents': { allowed_tools: ['Read'] } } } },
      { chatId: 'A', being: 'eplus', fields: { mode: 'on' } },
      { chatId: '!b:beeper.com', being: 'egpt', fields: { sandbox_pin: {} } },
      { chatId: 'C', being: 'egpt', fields: { threadId: 't' } },
    ]);
    expect([...optedInPinKeys(state)].sort()).toEqual([sandboxPinKeyOf('egpt', 'whatsapp', '!b:beeper.com'), sandboxPinKeyOf('egpt', 'whatsapp', 'A')].sort());
  });

  it('readPinKeys reads the key= line of each .pin, and nothing else in the directory', () => {
    const files = { 'egpt-sbx-04.pin': pinFile('egpt:whatsapp:A'), 'egpt-sbx-05.pin.tmp': pinFile('egpt:whatsapp:T'), 'egpt-sbx-06.lock': 'x' };
    const keys = readPinKeys('D:\\pins', { readdir: () => Object.keys(files), readFile: (p) => files[p.split(/[\\/]/).pop()] });
    expect(keys).toEqual(['egpt:whatsapp:A']);
  });

  it('no pins directory is no pins; any other read failure is loud', () => {
    const fail = (code) => () => { const e = new Error(code); e.code = code; throw e; };
    expect(readPinKeys('D:\\pins', { readdir: fail('ENOENT') })).toEqual([]);
    expect(() => readPinKeys('D:\\pins', { readdir: fail('EACCES') })).toThrow(/EACCES/);
  });

  it('the Node pins directory is the one setup/sandbox-account.ps1 derives', () => {
    expect(accountLib()).toMatch(/^\$CredDir = Join-Path \$env:ProgramData 'egpt'$/m);
    expect(accountLib()).toMatch(/^\$SandboxPinsDir = Join-Path \$CredDir 'sandbox-pins'$/m);
    expect(SANDBOX_PINS_DIR).toBe(join(process.env.ProgramData || 'C:\\ProgramData', 'egpt', 'sandbox-pins'));
  });
});

describe('createSandboxPinReleaser — a pin whose opt-in is gone is released on the tick', () => {
  function rig({ pins = {}, state = emptyState(), codes = [0], platform = 'win32', everyMs = 60_000 } = {}) {
    const spawned = [], evicted = [], logs = [];
    let loads = 0, reads = 0, n = 0;
    const spawn = (bin, args, opts) => {
      spawned.push({ bin, args, opts });
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      const code = codes[Math.min(n++, codes.length - 1)];
      setImmediate(() => { proc.stderr.emit('data', 'sandbox-logon-launcher: pin release: done\n'); proc.emit('close', code); });
      return proc;
    };
    const releaser = createSandboxPinReleaser({
      loadState: async () => { loads++; return state; },
      evictWarm: (being, ev) => { evicted.push({ being, ...ev }); },
      platform, everyMs, spawn,
      readdir: () => { reads++; return Object.keys(pins); },
      readFile: (p) => pins[p.split(/[\\/]/).pop()],
      onLog: (l) => logs.push(String(l)),
    });
    return { releaser, spawned, evicted, logs, loads: () => loads, reads: () => reads };
  }
  const STALE = 'egpt:whatsapp:!room:beeper.com';

  it('a stale pin: that being\'s warm session there is ended, then the release script runs with its key', async () => {
    const r = rig({ pins: { 'egpt-sbx-04.pin': pinFile(STALE) } });
    expect(await r.releaser.sweep()).toEqual([{ key: STALE, code: 0 }]);
    expect(r.evicted).toEqual([{ being: 'egpt', surface: 'whatsapp', chatId: '!room:beeper.com' }]);
    expect(r.spawned).toHaveLength(1);
    const { bin, args, opts } = r.spawned[0];
    expect(bin).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
    expect(args[4]).toMatch(/[\\/]setup[\\/]release-sandbox-pin\.ps1$/);
    expect(existsSync(args[4])).toBe(true);
    expect(args.slice(5)).toEqual(['-Key', STALE]);
    expect(opts).toMatchObject({ windowsHide: true });
    expect(r.logs.some((l) => l.includes(`${STALE}: release exited 0`))).toBe(true);
  });

  it('a pin conversations.yaml still asks for is left alone', async () => {
    const state = stateWith([{ chatId: 'A', being: 'egpt', fields: { sandbox_pin: {} } }]);
    const r = rig({ pins: { 'egpt-sbx-04.pin': pinFile(sandboxPinKeyOf('egpt', 'whatsapp', 'A')) }, state });
    expect(await r.releaser.sweep()).toEqual([]);
    expect(r.spawned).toEqual([]);
    expect(r.evicted).toEqual([]);
  });

  it('no pin files: conversations.yaml is not even read', async () => {
    const r = rig();
    await r.releaser.sweep();
    expect(r.loads()).toBe(0);
    expect(r.spawned).toEqual([]);
  });

  it('a busy release is retried on the next sweep without ending the session again; a finished one forgets it', async () => {
    const r = rig({ pins: { 'egpt-sbx-04.pin': pinFile(STALE) }, codes: [2, 1, 0] });
    await r.releaser.sweep();
    await r.releaser.sweep();
    await r.releaser.sweep();
    expect(r.spawned).toHaveLength(3);
    expect(r.evicted).toHaveLength(1);
  });

  it('the tick runs once per interval, never two sweeps at once, and only on Windows', async () => {
    const r = rig({ pins: { 'egpt-sbx-04.pin': pinFile(STALE) } });
    const first = r.releaser.tick(1_000);
    expect(r.releaser.tick(70_000), 'a second sweep started while the first was still running').toBeNull();
    await first;
    expect(r.releaser.tick(30_000)).toBeNull();
    expect(r.reads()).toBe(1);
    await r.releaser.tick(61_001);
    expect(r.reads()).toBe(2);
    const linux = rig({ pins: { 'egpt-sbx-04.pin': pinFile(STALE) }, platform: 'linux' });
    expect(linux.releaser.tick(1_000)).toBeNull();
    expect(linux.reads()).toBe(0);
  });
});

describe('the launcher pin wiring (source locks)', () => {
  it('the walk is handed the pin key and the node\'s pins, re-read every sweep', () => {
    expect(launcher()).toMatch(/\$sweepOrder = Get-SandboxPoolLeaseOrder -Folder \$TargetFolder -PinKey \$PinKey -Pins @\(Get-SandboxPins\)/);
  });

  it('BOTH lease opens are followed by the exact pin check before the account is taken', () => {
    const src = launcher();
    const opens = [...src.matchAll(/\$lockStream = \[System\.IO\.File\]::Open\(\$candidatePath[^\n]*\n/g)];
    expect(opens).toHaveLength(2);
    for (const m of opens) {
      const after = src.slice(m.index, src.indexOf('$leasedName = $name', m.index));
      expect(after, 'a lease is taken without asking whether the account is pinned to someone else').toMatch(/Test-SandboxPinAllows -Account \$name -PinKey \$PinKey/);
    }
  });

  it('(c2) claims the pin after the SID is known and before any per-turn grant, and never on the lease ledger', () => {
    const src = launcher();
    const c2 = src.indexOf('# ---- (c2)');
    expect(c2).toBeGreaterThan(src.indexOf('$leasedSid = (New-Object'));
    expect(c2).toBeLessThan(src.indexOf("Grant-SandboxPoolAce -Path $TargetFolder -Grant 'Modify'"));
    const step = src.slice(c2, src.indexOf('# ---- (d)', c2));
    expect(step).toMatch(/Sync-SandboxPin -Account \$leasedName -Sid \$leasedSid -Key \$PinKey -Modify \$PinSharePathList -Read \$PinSharePathReadOnlyList/);
    expect(step).not.toMatch(/Add-SandboxLeaseLedgerPath|acesGranted/);
    expect(src.split('\n').filter((l) => /acesGranted/.test(l) && /PinSharePath/.test(l))).toEqual([]);
  });

  it('a per-turn share naming a pinned path is skipped, so the turn\'s revoke cannot take the standing ACE', () => {
    const src = launcher();
    const d2 = src.slice(src.indexOf('# ---- (d2)'), src.indexOf('# ---- (e)'));
    const seed = d2.indexOf('foreach ($pp in @($PinSharePathList) + @($PinSharePathReadOnlyList))');
    expect(seed).toBeGreaterThan(0);
    expect(d2.slice(seed, seed + 300)).toMatch(/\$sharesSeen\.Add/);
    expect(seed).toBeLessThan(d2.indexOf('foreach ($shareClass in'));
  });

  it('pin paths without a key are refused before any lease', () => {
    const src = launcher();
    const guard = src.indexOf('need -PinKey');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf('# ---- (a) lease one pool account'));
  });

  it('the release script is Remove-SandboxPin, with the exit codes the releaser reads', () => {
    const ps = readFileSync(join(REPO, 'setup', 'release-sandbox-pin.ps1'), 'utf8');
    expect(ps).toMatch(/Remove-SandboxPin -Key \$Key/);
    expect(ps).toMatch(/'released' -or \$r\.Status -eq 'absent'\) \{ exit 0 \}/);
    expect(ps).toMatch(/'busy'\) \{ exit 2 \}/);
    expect(existsSync(join(REPO, 'setup', 'release-sandbox-pin.cmd'))).toBe(true);
  });
});
