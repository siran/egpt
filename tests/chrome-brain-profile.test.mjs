// tests/chrome-brain-profile.test.mjs — resolveBrainProfile() discovery + the /chrome
// hint dropping the extension.
//
// THE BUG (2026-07-22): /chrome hardcoded the brain profile to
// <EGPT_HOME>/chrome/profiles/brain — a BLANK fresh profile with no ChatGPT/Claude
// logins. The profile the operator actually used lives at a v1 path under
// ~/.egpt-v1/config/browser/<something> (usually `egpt-extension`). resolveBrainProfile()
// searches both roots and prefers the one that is actually logged in to an AI site.
//
// All fixtures are REAL temp dirs (mkdtempSync) + injected { egptHome, home } — no real
// profile is read. The locked-file case injects a throwing readFile instead of actually
// locking a file on Windows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBrainProfile, chromeArgs } from '../src/tools/chrome-launcher.mjs';

// Build a Chrome-shaped profile at `dir`. A REAL profile needs Default/Preferences OR
// Default/Network/Cookies; `history`/`cookies` (when non-null) seed the AI-marker files.
function mkProfile(dir, { preferences = true, history = null, cookies = null } = {}) {
  const def = join(dir, 'Default');
  mkdirSync(def, { recursive: true });
  if (preferences) writeFileSync(join(def, 'Preferences'), '{}');
  if (history !== null) writeFileSync(join(def, 'History'), history);
  if (cookies !== null) {
    mkdirSync(join(def, 'Network'), { recursive: true });
    writeFileSync(join(def, 'Network', 'Cookies'), cookies);
  }
}

let root, egptHome, home, v1Browser;
const v2Default = () => join(egptHome, 'chrome', 'profiles', 'brain');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egpt-brainprof-'));
  egptHome = join(root, 'egpthome');
  home = join(root, 'home');
  v1Browser = join(home, '.egpt-v1', 'config', 'browser');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveBrainProfile()', () => {
  it('picks the v1 AI-brain when the v2 default is blank', () => {
    // v2 default: real but blank (Preferences, no AI markers, no cookies).
    mkProfile(v2Default(), { preferences: true });
    // v1 egpt-extension profile: real AND logged in to ChatGPT (History has the domain).
    mkProfile(join(v1Browser, 'egpt-extension'), { preferences: true, history: 'visited chatgpt.com/c/abc' });

    expect(resolveBrainProfile({ egptHome, home })).toBe(join(v1Browser, 'egpt-extension'));
  });

  it('falls back to the v2 default when every candidate is blank', () => {
    mkProfile(v2Default(), { preferences: true });
    mkProfile(join(v1Browser, 'egpt-extension'), { preferences: true });
    mkProfile(join(v1Browser, 'chrome'), { preferences: true });

    expect(resolveBrainProfile({ egptHome, home })).toBe(v2Default());
  });

  it('prefers the v2 default when IT is the AI-brain, over a v1 AI-brain', () => {
    // Both are AI-brains → the v2 default wins.
    mkProfile(v2Default(), { preferences: true, cookies: 'session for claude.ai' });
    mkProfile(join(v1Browser, 'egpt-extension'), { preferences: true, history: 'chatgpt.com' });

    expect(resolveBrainProfile({ egptHome, home })).toBe(v2Default());
  });

  it('among multiple v1 AI-brains (v2 default not AI), picks the most-recently-active by Cookies mtime', () => {
    mkProfile(v2Default(), { preferences: true });                                    // real, not AI
    const older = join(v1Browser, 'chrome');
    const newer = join(v1Browser, 'egpt-extension');
    mkProfile(older, { preferences: true, cookies: 'openai.com session' });
    mkProfile(newer, { preferences: true, cookies: 'grok.x session' });
    // Force `newer`'s Cookies to be the most-recently-modified.
    const now = Date.now() / 1000;
    utimesSync(join(older, 'Default', 'Network', 'Cookies'), now - 100, now - 100);
    utimesSync(join(newer, 'Default', 'Network', 'Cookies'), now, now);

    expect(resolveBrainProfile({ egptHome, home })).toBe(newer);
  });

  it('does not throw and treats a locked/unreadable History as not-AI', () => {
    mkProfile(v2Default(), { preferences: true });
    mkProfile(join(v1Browser, 'egpt-extension'), { preferences: true, history: 'chatgpt.com' });

    // Simulate Chrome holding a lock: reading the History file throws.
    const throwingRead = (p) => {
      if (String(p).includes('History')) throw new Error('EBUSY: file is locked');
      return readFileSync(p, 'latin1');
    };

    let out;
    expect(() => { out = resolveBrainProfile({ egptHome, home, readFile: throwingRead }); }).not.toThrow();
    // The AI marker was unreadable → the v1 profile is NOT classified AI → fall back to v2 default.
    expect(out).toBe(v2Default());
  });

  it('returns a real USED profile (Cookies present) over the fresh default when none are AI', () => {
    mkProfile(v2Default(), { preferences: true });                                    // fresh, no cookies
    mkProfile(join(v1Browser, 'egpt-extension'), { preferences: true, cookies: 'example.com only' });  // used, not AI

    expect(resolveBrainProfile({ egptHome, home })).toBe(join(v1Browser, 'egpt-extension'));
  });

  it('never throws when neither root exists', () => {
    // No profiles created at all — the default dir doesn't even exist yet.
    let out;
    expect(() => { out = resolveBrainProfile({ egptHome, home }); }).not.toThrow();
    expect(out).toBe(v2Default());
  });
});

describe('chromeArgs() without an extension', () => {
  it('emits NO --load-extension when extensionDir is omitted', () => {
    const args = chromeArgs({ port: 9221, userDataDir: 'C:\\x\\brain' });
    expect(args.some((a) => a.startsWith('--load-extension'))).toBe(false);
    expect(args).toContain('--user-data-dir=C:\\x\\brain');
  });
});
