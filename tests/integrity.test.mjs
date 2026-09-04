// tests/integrity.test.mjs — static-source integrity checks for the v2 spine.
//
// Catches the class of bug where config-schema drifts from what the spine reads.
// NOT execution tests — they parse source files as text and assert that read
// config keys have a home in CONFIG_SCHEMA. Cheap, no boot-up, runs with the rest.
//
// The old-spine scans (launcher/spine boundary, EGPT_CONFIG anti-drift, command-
// dispatch coverage — everything reading egpt-spine.mjs) were retired 2026-07-02 with
// the config-legacy excision: they guarded dead code on the v2 path (operator: "no
// baggage"). They come back only if the old spine does — which is a separate deletion.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_SCHEMA } from '../config/config-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('/config schema vs. v2 spine config references', () => {
  // The v2 spine (spine.mjs + src/spine/*.mjs) reads config two ways: boot() holds the
  // raw object as `const cfg = readConfig()` and reads top-level keys as `cfg.<key>`;
  // the services receive `getConfig` and read `getConfig().<key>`. Scan both forms — no
  // static analyzer, just a cheap regex — and hold every top-level key to the schema.
  const SPINE_DIR = join(ROOT, 'src/spine');
  const referencedKeys = new Set();
  // boot's raw-config reads: `cfg.<key>`. Case-sensitive, so it never matches the
  // `getConfig` closure nor capital-C ...Cfg locals (transcribeCfg / tx.cliCfg).
  const BOOT_SRC = readFileSync(join(SPINE_DIR, 'boot.mjs'), 'utf8');
  for (const m of BOOT_SRC.matchAll(/\bcfg\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    referencedKeys.add(m[1]);
  }
  // service reads: `getConfig().<key>` / `getConfig()?.<key>` across src/spine/*.mjs.
  // The `\??\.` requires a real property access, so `getConfig() ?? {}` (and the
  // `(getConfig() ?? {}).<key>` fallback form) do NOT match — only direct reads.
  for (const f of readdirSync(SPINE_DIR)) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(join(SPINE_DIR, f), 'utf8');
    for (const m of src.matchAll(/\bgetConfig\(\)\s*\??\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      referencedKeys.add(m[1]);
    }
  }

  it('finds at least the known v2 config references (sanity)', () => {
    expect(referencedKeys.size).toBeGreaterThanOrEqual(4);
  });

  for (const key of [...referencedKeys].sort()) {
    it(`v2 spine config.${key} is registered in CONFIG_SCHEMA`, () => {
      expect(CONFIG_SCHEMA, `${key} read by the v2 spine but not in CONFIG_SCHEMA`).toHaveProperty(key);
    });
  }
});

describe('no literal NUL bytes under src/', () => {
  // A literal 0x00 byte in a tracked source file makes ripgrep (and Claude Code's Grep
  // tool, which is ripgrep under the hood) classify the whole file as BINARY — matches
  // stop silently at the first NUL, so everything after it is invisible to every future
  // `rg`/Grep search. This happened for real in src/conversations-state.mjs: six NULs
  // used as composite-map-key separators hid 164 lines (including several exported
  // functions) from every text search. Use the `\0` escape inside strings/template
  // literals instead — runtime-identical, but visible to tooling.
  const files = execSync('git ls-files src', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);

  it('finds at least the known src/ files (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const rel of files) {
    it(`${rel} has no literal NUL byte`, () => {
      const buf = readFileSync(join(ROOT, rel));
      const nulAt = buf.indexOf(0);
      expect(
        nulAt,
        `${rel} contains a literal 0x00 byte at offset ${nulAt} — this makes ripgrep/Grep ` +
        `treat the file as binary and silently truncate searches there, hiding the rest of ` +
        `the file from every audit. Use the "\\0" escape sequence instead (runtime-identical ` +
        `inside strings/template literals).`
      ).toBe(-1);
    });
  }
});

// ── the OS-agnostic guard ───────────────────────────────────────────────────────────────
//
// Operator, 2026-09-04: "egpt as a tool must remain agnostic to OS. that is why we use node
// and beeper. only one desktop UI is necessary. we built S0,S1 as an enhancement. two nodes
// also is an enhancement over one node, and it can operate as before with just one account."
//
// eGPT is node + Beeper Desktop PRECISELY so it runs on Windows, macOS and Linux. The Session
// 0 work brought in a lot of Windows machinery — NSSM services, PowerShell setup scripts,
// scheduled tasks. That is fine where it lives (setup/*.ps1, *.cmd, guarded helpers under
// src/tools/). It is not fine in the spine's runtime path, because then eGPT quietly acquires
// a platform and nobody notices until it is run somewhere else.
//
// The bug this scan is shaped after was real: src/tools/beeper-whoami.mjs detected "am I main?"
// with a hand-built `import.meta.url === \`file:///${process.argv[1]...}\`` — a Windows-shaped
// string compare. On POSIX argv[1] is ALREADY absolute, so it renders file:////home/... and
// never matches: the CLI silently did nothing, with no error to notice. The fix (pathToFileURL,
// the idiom compact-being.mjs already used) is one line — FINDING it was the expensive part.
// That is why this is a test and not a note in a doc.
//
// Scans src/**/*.mjs EXCLUDING src/tools/** (tools may be platform-specific when guarded).
const stripComments = (() => {
  // COMMENTS MUST BE EXEMPT. This repo comments heavily and says "Windows" constantly in prose;
  // a scan that trips on comments is noise, and the next person deletes it. So strip line and
  // block comments — but keep STRINGS, TEMPLATE LITERALS and REGEX LITERALS, because that is
  // where every offender actually lives ('powershell.exe', 'Scripts', a C:\ path).
  //
  // Naive `s.replace(/\/\/.*$/gm, '')` is worse than useless here: it would eat the rest of any
  // line containing `file:///` or 'http://…' — including rule 1's exact target. Hence the small
  // state machine. Regex literals are recognised by the standard prev-token heuristic (a `/`
  // after an operator/open-bracket/keyword cannot be division) so a regex containing `//` or
  // `/*` can never open a phantom comment. Comment bodies are blanked, not deleted, so line
  // numbers in failure messages point at the real line.
  const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|in|of|do|else|yield|void|delete|throw|new)$/;
  return function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    const blank = (s) => s.replace(/[^\n]/g, ' ');
    const regexOk = () => {
      const before = out.replace(/\s+$/, '');
      if (!before) return true;
      if ('(,=:[!&|?{};+-*%~^<>'.includes(before[before.length - 1])) return true;
      return KEYWORD_BEFORE_REGEX.test(before);
    };
    while (i < n) {
      const c = src[i], c2 = src[i + 1];
      if (c === '/' && c2 === '/') {
        let j = i; while (j < n && src[j] !== '\n') j++;
        out += blank(src.slice(i, j)); i = j; continue;
      }
      if (c === '/' && c2 === '*') {
        let j = src.indexOf('*/', i + 2); j = j === -1 ? n : j + 2;
        out += blank(src.slice(i, j)); i = j; continue;
      }
      if (c === '"' || c === "'" || c === '`') {   // kept verbatim — offenders live in strings
        let j = i + 1;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === c) { j++; break; }
          j++;
        }
        out += src.slice(i, j); i = j; continue;
      }
      if (c === '/' && regexOk()) {
        let j = i + 1, inClass = false, closed = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) { j++; closed = true; break; }
          j++;
        }
        if (closed) { out += src.slice(i, j); i = j; continue; }
      }
      out += c; i++;
    }
    return out;
  };
})();

const PORTABILITY_RULES = [
  // 1. The exact bug above: a hand-built file:/// URL, which only ever matches on Windows.
  //    Use pathToFileURL(process.argv[1]).href instead — it is correct on every platform.
  { id: 'hand-built file:/// URL', re: /file:\/\/\//, fix: 'use pathToFileURL(...).href — a hand-built file:/// string only matches on Windows' },
  // 2. A hardcoded absolute Windows path. `X:\` is not valid JS outside a string, so the
  //    drive-letter+backslash form has no false positives; C:/ is spelled out separately
  //    because a bare `x:/` would collide with object literals like `{ re:/foo/ }`.
  { id: 'hardcoded absolute Windows path', re: /(?:^|[^\w$])(?:[A-Za-z]:\\|[Cc]:\/)/, fix: 'derive it — homedir()/EGPT_HOME/env, or take it from config' },
  // 3. Windows shells, service managers and binary names. `\bcmd\.exe\b` and `\.exe\b` are
  //    both anchored so `SINGULAR_CMD.exec(...)` (commands.mjs:692) is not a match.
  { id: 'Windows shell/service/binary literal', re: /powershell|\bcmd\.exe\b|\.exe\b|\bnssm\b|\bschtasks\b/i, fix: 'branch on process.platform, or move it under src/tools/ behind a guard' },
  // 4. The Windows venv layout. POSIX puts the interpreter at venv/bin/python, not
  //    venv/Scripts/python.exe — this one is a silent ENOENT everywhere but Windows.
  { id: 'Windows-only venv/binary path segment', re: /['"`]Scripts['"`]|python\.exe/, fix: "resolve the layout at runtime: 'Scripts'/'python.exe' on win32, 'bin'/'python' elsewhere" },
];

// THE ALLOWLIST — exact path + exact code snippet, never a pattern, so a NEW offender in an
// allowlisted file still trips. Every entry is asserted below to STILL match something, so the
// list cannot rot into a silent blanket.
//
// Group 1: matches that are PORTABILITY-CORRECT code. The scan sees the literal; the code is
// already doing the right thing. These are the scan's own false positives.
const PORTABLE_BY_DESIGN = [
  {
    file: 'src/warm-cli-session.mjs',
    code: "process.platform === 'win32' ? 'claude.exe' : 'claude'",
    why: 'the guard itself — this line is what portability looks like. Flagged only because it names the Windows binary in order to NOT use it elsewhere.',
  },
  {
    file: 'src/video-frames.mjs',
    code: '/ffmpeg(\\.exe)?$/i',
    why: 'the `.exe` is OPTIONAL in this regex on purpose: ffprobeFromFfmpeg() derives the sibling binary from whatever ffmpeg path it was given, with or without a Windows suffix. Removing it would BREAK Windows without helping POSIX.',
  },
  {
    file: 'src/spine/seed.mjs',
    code: '#- PowerShell(Get-ChildItem *)',
    why: 'not code — a COMMENTED-OUT line inside the seeded YAML tool-grant template, listing a CLI tool an operator may uncomment, already labelled "Windows-only tool" right there. Nothing here runs.',
  },
];

// Group 2: genuine platform coupling in the scanned tree. NOT excused — recorded, so the suite
// stays green while the list itself is the to-do. Delete an entry when the code is fixed; the
// rot check below will fail if you delete the code and leave the entry.
const KNOWN_PLATFORM_DEBT = [
  {
    file: 'src/spine/synthesizer-worker.mjs',
    code: "join(radioPiper, 'venv', 'Scripts', 'python.exe')",
    why: 'PRE-EXISTING, named by the operator 2026-09-04 and deliberately left alone (CLAUDE.md §3: do not fix adjacent code). `Scripts/` + `python.exe` is the WINDOWS venv layout; POSIX is `bin/python`, so a synthesizer worker on Linux/macOS spawns a path that does not exist. REAL FIX: resolve the layout at runtime — join(radioPiper, "venv", "Scripts", "python.exe") on win32, join(radioPiper, "venv", "bin", "python") elsewhere.',
  },
  {
    file: 'src/sandbox-cli-session.mjs',
    code: "_spawn('powershell.exe', psArgs, spawnOpts)",
    why: 'FOUND BY THIS SCAN 2026-09-04, GUARDED THE SAME DAY. createSandboxCliSession now throws BEFORE this spawn whenever the platform is not win32 ("sandboxed: true does not support platform=<p> - OS-level sandboxing is Windows-only on this build (set sandboxed: false for this agent, or run this node on Windows)"), the same loud shape as the engine check above it, and brainpool.mjs no longer DEFAULTS anyone into it off Windows (unset at both tiers now resolves to true on win32, false elsewhere). So the bare ENOENT is gone and an explicit sandboxed:true is REFUSED rather than silently downgraded. REMAINING DEBT, and why this entry stays: the line itself is still Windows-only machinery, so the feature is simply unavailable on Linux/macOS until setup/sandbox-logon-launcher.ps1 grows a POSIX equivalent.',
  },
  {
    file: 'src/spine/commands.mjs',
    code: "spawnSync('schtasks', ['/run', '/tn', CHROME_LAUNCH_TASK]",
    why: 'FOUND BY THIS SCAN 2026-09-04. Windows-only (schtasks triggers the Session-1 Chrome task), but it DEGRADES rather than breaks: the try/catch turns a POSIX ENOENT into { ok: false }, which is already /chrome\'s graceful-fallback path. Soft debt — it is the launch SEAM that is Windows-shaped, and the seam is injectable, so the real fix is a per-platform default launcher rather than a branch here.',
  },
];

const ALLOWLIST = [...PORTABLE_BY_DESIGN, ...KNOWN_PLATFORM_DEBT];

describe('the spine stays OS-agnostic (src/**, src/tools/** excluded)', () => {
  const files = execSync('git ls-files src', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('src/tools/'));

  // rel → [{ line, rule, code }]
  const hits = new Map();
  for (const rel of files) {
    const codeLines = stripComments(readFileSync(join(ROOT, rel), 'utf8')).split('\n');
    const found = [];
    codeLines.forEach((line, idx) => {
      for (const rule of PORTABILITY_RULES) {
        if (rule.re.test(line)) found.push({ line: idx + 1, rule, code: line.trim() });
      }
    });
    if (found.length) hits.set(rel, found);
  }

  const excused = (rel, hit) => ALLOWLIST.some((a) => a.file === rel && hit.code.includes(a.code));

  it('finds at least the known src/ files, tools excluded (sanity)', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.startsWith('src/tools/'))).toBe(false);
  });

  it('the scan is alive: every rule fires on code, and none of them on a comment', () => {
    // Proves both halves at once — that the rules match at all, and that the comment stripper
    // is what stands between them and this repo's very chatty Windows prose.
    const asCode = [
      'const isMain = import.meta.url === `file:///${process.argv[1]}`;',
      "const p = 'C:\\\\Users\\\\an\\\\bin\\\\whisper.exe';",
      "spawnSync('powershell.exe', a); spawnSync('nssm', b); spawnSync('schtasks', c);",
      "join(root, 'venv', 'Scripts', 'python.exe');",
    ].join('\n');
    const asComment = asCode.split('\n').map((l) => `// ${l}`).join('\n') + '\n/* ' + asCode + ' */\n';
    for (const rule of PORTABILITY_RULES) {
      const codeLines = stripComments(asCode).split('\n');
      expect(codeLines.some((l) => rule.re.test(l)), `rule "${rule.id}" matched nothing in the fixture — it is dead`).toBe(true);
      const commentLines = stripComments(asComment).split('\n');
      expect(commentLines.some((l) => rule.re.test(l)), `rule "${rule.id}" fired on a COMMENT — the stripper is broken and this scan is now noise`).toBe(false);
    }
  });

  it('does not trip on the explorer.exe mentioned in a comment in src/spine/commands.mjs', () => {
    // The operator's named canary: commands.mjs explains the Session 0 / Session 1 split in
    // prose and says "explorer.exe" while doing it. If this scan ever flags that line, the
    // comment stripping has regressed and the whole guard is worthless.
    const raw = readFileSync(join(ROOT, 'src/spine/commands.mjs'), 'utf8');
    expect(raw, 'canary gone — commands.mjs no longer mentions explorer.exe, so this test proves nothing').toContain('explorer.exe');
    expect(stripComments(raw)).not.toContain('explorer.exe');
  });

  for (const rel of files) {
    it(`${rel} keeps the spine OS-agnostic`, () => {
      const offenders = (hits.get(rel) ?? []).filter((h) => !excused(rel, h));
      expect(
        offenders.map((h) => `  ${rel}:${h.line}  [${h.rule.id}]  ${h.code}\n     → ${h.rule.fix}`).join('\n'),
        `${rel} puts a platform in the spine's runtime path. eGPT is node + Beeper so it runs on ` +
        `Windows, macOS AND Linux; a Windows literal here is usually a SILENT failure elsewhere ` +
        `(wrong path, ENOENT, or a comparison that never matches), not a loud one. Fix it, or — if ` +
        `it is genuinely correct — add an exact-path + exact-snippet entry with a reason to ` +
        `PORTABLE_BY_DESIGN / KNOWN_PLATFORM_DEBT above. Windows-specific machinery belongs in ` +
        `setup/*.ps1, *.cmd, or a guarded helper under src/tools/.`
      ).toBe('');
    });
  }

  // ANTI-ROT. An allowlist entry whose code is gone is a hole with nothing behind it: the next
  // Windows literal in that file can drift toward the same shape and hide. Each entry must
  // still match a real, still-flagged line.
  for (const entry of ALLOWLIST) {
    it(`allowlist entry ${entry.file} :: ${entry.code.slice(0, 48)} still matches something`, () => {
      const matched = (hits.get(entry.file) ?? []).some((h) => h.code.includes(entry.code));
      expect(
        matched,
        `stale allowlist entry: ${entry.file} no longer contains a flagged line with \`${entry.code}\`. ` +
        `If it was fixed, DELETE this entry — leaving it behind means the next offender in that file ` +
        `is one edit away from being excused by accident.`
      ).toBe(true);
    });
  }
});

describe('src/tools/beeper-whoami.mjs gives the spine no platform', () => {
  // boot.mjs imports this tool for probe() — plain fetch, runs anywhere. The Windows half
  // (localOwners: Get-NetTCPConnection via powershell.exe) is guarded by process.platform AND
  // imports node:child_process INSIDE the function. Both halves matter: a top-level
  // `import { execFile } from 'node:child_process'` would be loaded by the spine on every
  // platform at boot, which is exactly how a tool's platform leaks into the spine.
  const WHOAMI = join(ROOT, 'src/tools/beeper-whoami.mjs');

  it('importing it does not load node:child_process', () => {
    // Measured in a clean child process: vitest's own runner has child_process loaded long
    // before we get here, so an in-process check would always pass and prove nothing. The
    // child imports the tool, snapshots the native-module list, THEN imports child_process
    // and snapshots again — so the same run proves the probe can see it when it is there.
    const script =
      `const seen = () => process.moduleLoadList.filter((m) => m.includes('child_process'));\n` +
      `await import(${JSON.stringify(pathToFileURL(WHOAMI).href)});\n` +
      `const before = seen();\n` +
      `await import('node:child_process');\n` +
      `console.log(JSON.stringify({ before, after: seen() }));\n`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(r.status, `child failed: ${r.stderr}`).toBe(0);
    const { before, after } = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(after.length, 'probe is broken: child_process was not detected even after importing it').toBeGreaterThan(0);
    expect(
      before,
      `importing beeper-whoami loaded node:child_process (${before.join(', ')}). boot.mjs imports this ` +
      `module for probe(), so a top-level platform import here hands the spine a platform on every OS. ` +
      `Keep the child_process import INSIDE localOwners(), behind its process.platform guard.`
    ).toEqual([]);
  });

  it('localOwners() is a no-op off win32 — it never reaches for PowerShell', async () => {
    const { localOwners } = await import('../src/tools/beeper-whoami.mjs');
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const owners = await localOwners([23373, 23374]);
      expect(owners).toBeInstanceOf(Map);
      expect(owners.size, 'localOwners returned data off win32 — the platform guard is gone').toBe(0);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('detects "am I main?" with pathToFileURL, not a hand-built file:/// string', () => {
    // The original bug, locked. `import.meta.url === \`file:///${argv[1]}\`` is false on POSIX
    // (argv[1] is already absolute → file:////home/...), so the CLI did nothing, silently.
    const src = stripComments(readFileSync(WHOAMI, 'utf8'));
    expect(src).toContain('pathToFileURL(process.argv[1]).href');
    expect(src, 'the hand-built file:/// main-check is back — it never matches on Linux/macOS').not.toMatch(/file:\/\/\//);
  });
});
