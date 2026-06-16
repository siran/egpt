// Locks bug 1 (operator 2026-06-16): the reply-mode note was re-announced on
// every restart because the chatId→mode map was in-memory only. Persisting it
// means a restart remembers the last-announced mode, so the note shows only on a
// genuine mode change — not on every boot.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAnnouncedModes, saveAnnouncedModes } from '../src/announced-modes.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'egpt-am-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('announced-modes — persists across restarts', () => {
  it('round-trips the chatId→mode map (a restart remembers → no re-announce)', () => {
    const path = join(tmp(), 'announced-modes.json');
    saveAnnouncedModes(path, new Map([['!a:beeper.local', 'on'], ['!b:beeper.local', 'mention']]));
    const reloaded = loadAnnouncedModes(path);   // simulates a daemon restart
    expect(reloaded.get('!a:beeper.local')).toBe('on');
    expect(reloaded.get('!b:beeper.local')).toBe('mention');
    // _modeChanged would be (reloaded.get(chat) !== mode) → false for an unchanged
    // mode, so the note is NOT re-announced after the restart.
  });

  it('absent or corrupt file → empty Map (best-effort, never throws)', () => {
    expect(loadAnnouncedModes(join(tmp(), 'missing.json')).size).toBe(0);
    const p = join(tmp(), 'corrupt.json');
    writeFileSync(p, 'not json {', 'utf8');
    expect(loadAnnouncedModes(p).size).toBe(0);
  });
});
