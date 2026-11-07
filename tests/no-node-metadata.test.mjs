// tests/no-node-metadata.test.mjs — no node's or person's particulars in the PUBLIC repo.
//
// The operator, 2026-11-05: "debemos aislar lo que es egpt de la configuración en EDW o KG/DO".
// Phone numbers, chat and account ids, AWS account numbers, personal mail addresses and home
// folders belong to a node's profile (~/.egpt), never to the tree. Fixtures use obvious fakes:
// phones +1 555 01xx-style (or long runs of one digit), ids like 100000001, mail @example.com,
// hosts *.example, IPs from 192.0.2.0/24 and 198.51.100.0/24, AWS account 123456789012, paths
// C:\Users\user.
//
// Two layers:
//   1. GENERIC SHAPES, below: anything shaped like a real value that is not an obvious fake.
//   2. THE NODE'S OWN DENYLIST: literals only the node knows (its names, hosts, ids), one per line
//      in <EGPT_HOME>/config/leak-denylist.txt (# comments), case-insensitive. The suite refuses a
//      live EGPT_HOME (tests/setup-egpt-home.mjs), so on a node point at it explicitly:
//        env -u EGPT_HOME EGPT_LEAK_DENYLIST=~/.egpt/config/leak-denylist.txt npx vitest run tests/no-node-metadata.test.mjs
//      Absent, this layer is skipped. A hit names the entry's line number, never the literal.
//
// Scans `git ls-files` (stage a new file before trusting a green run).
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tests/no-node-metadata.test.mjs';
const BINARY = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|zip|gz|wav|mp3|ogg|opus|m4a|pdf|exe|dll)$/i;
// Not ours to scrub: the lockfile's hashes and a third party's public signing key.
const SKIP = new Set(['package-lock.json', 'docker/awscli.asc', SELF]);

const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map((f) => f.trim()).filter(Boolean)
  .filter((f) => !SKIP.has(f) && !BINARY.test(f) && existsSync(join(ROOT, f)));
const texts = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));

// An obvious fake number: the NANP 555 exchange (+1 555 …, +1 NXX 555 …), a run of one digit
// (+34600000000, 10000000000011, -1009999), or a counting run (12345).
const fakeDigits = (d) => /^1(?:\d{3})?555/.test(d) || /(\d)\1{3,}/.test(d) || /0123|1234|2345|3456|4567|5678|6789|9876/.test(d);

// Intentional fakes that the shapes below would otherwise flag. Keep it short.
const ALLOW = new Set([
  'userbinegpt',        // setup/upgrade.ps1: how a quoted C:\Users\user\bin\egpt arrives mangled
]);

// [name, regex (global), value -> true when it IS a leak]
const SHAPES = [
  ['E.164 phone', /(?<![\w/.:#+-])\+(\d{10,15})(?![\d])/g, (m) => !fakeDigits(m[1])],
  ['formatted phone', /(?<![\w/.:#+-])\+(\d{1,3})[ .-]?\(?(\d{3})\)?[ .-](\d{3})[ .-](\d{4})(?!\d)/g, (m) => !fakeDigits(m[1] + m[2] + m[3] + m[4])],
  ['WhatsApp id', /(?<!\d)(\d{10,16})@(?:s\.whatsapp\.net|c\.us|lid)\b|whatsapp_(?:lid-)?(\d{10,16})(?!\d)/g, (m) => !fakeDigits(m[1] ?? m[2])],
  ['Telegram id', /tg:-?(\d{7,})|(?<![\w-])-100(\d{9,})(?!\d)|telegram_(\d{6,})/g, (m) => !fakeDigits(m[1] ?? m[2] ?? m[3])],
  ['AWS account id', /arn:aws:[a-z0-9-]*:[a-z0-9-]*:(\d{12})|(?<!\d)(\d{12})\.dkr\.ecr|\bACCOUNT=(\d{12})\b|\baccount[ _-]?(?:id)?[ :=(]+(\d{12})\b/gi,
    (m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) !== '123456789012'],
  ['personal mail address', /[\w.+-]+@((?:gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|mac|proton|protonmail|aol|msn|gmx|yandex)\.[a-z.]{2,})\b/gi, () => true],
  ['Windows/mac home folder', /(?:[A-Za-z]:(?:\\{1,4}|\/)|(?<![\w:./-])\/)(?:Users|users|USERS)(?:\\{1,4}|\/)([^\\/\s"'`<>()|,;:]+)/g,
    (m) => {
      const name = m[1].replace(/[.…]+$/, '');
      return !(name === '' || /^(?:user|User|you|Default|Public|runner|fixture|nobody|somebody-else|op|O|x)$/.test(name)
        || /^(?:egpt-|\$|<|\*|\.\.)/.test(name) || ALLOW.has(name));
    }],
];

const scan = (shape) => {
  const [, re, leak] = shape;
  const hits = [];
  for (const [f, t] of texts) {
    for (const m of t.matchAll(re)) {
      if (!leak(m)) continue;
      const line = t.slice(0, m.index).split('\n').length;
      hits.push(`${f}:${line}: ${m[0]}`);
    }
  }
  return hits;
};

describe('no node or personal metadata in tracked files', () => {
  it('scans the tracked text files (sanity)', () => {
    expect(texts.size).toBeGreaterThan(300);
  });

  it('the shapes are alive: each flags a real-looking value and passes its fake', () => {
    const t = (name, s) => { const [, re, leak] = SHAPES.find(([n]) => n === name); return [...s.matchAll(new RegExp(re.source, re.flags))].some(leak); };
    // Assembled, so this file never spells one; area code 097 does not exist, so no one's number.
    const real = (...d) => d.join('');
    expect(t('E.164 phone', `+${real('1', '097', '482', '6130')}`)).toBe(true);
    expect(t('E.164 phone', '+15550100001 +34600000000')).toBe(false);
    expect(t('formatted phone', `+1 (${real('097')}) ${real('482')}-${real('6130')}`)).toBe(true);
    expect(t('formatted phone', '+1 (555) 010-0001')).toBe(false);
    expect(t('WhatsApp id', `${real('1097482', '6130')}@s.whatsapp.net`)).toBe(true);
    expect(t('WhatsApp id', '15550100001@s.whatsapp.net 10000000000011@lid')).toBe(false);
    expect(t('Telegram id', `tg:-100${real('47213', '98061')}`)).toBe(true);
    expect(t('Telegram id', 'tg:-1000000000101 tg:-1001234')).toBe(false);
    expect(t('AWS account id', `ACCOUNT=${real('4729', '1035', '8861')}`)).toBe(true);
    expect(t('AWS account id', 'ACCOUNT=123456789012')).toBe(false);
    expect(t('personal mail address', `someone@${real('gm', 'ail')}.com`)).toBe(true);
    expect(t('personal mail address', 'someone@example.com')).toBe(false);
    expect(t('Windows/mac home folder', 'C:\\Users\\jdoe\\src')).toBe(true);
    expect(t('Windows/mac home folder', 'C:\\Users\\user\\src C:/Users/egpt-sbx-08 /Users/you')).toBe(false);
  });

  for (const shape of SHAPES) {
    it(`no ${shape[0]} outside the obvious fakes`, () => {
      expect(scan(shape)).toEqual([]);
    });
  }

  // THE NODE'S DENYLIST: the literals the generic shapes cannot know.
  const denyFile = [process.env.EGPT_LEAK_DENYLIST, process.env.EGPT_HOME && join(process.env.EGPT_HOME, 'config', 'leak-denylist.txt')]
    .find((p) => p && existsSync(p));
  it.skipIf(!denyFile)('no literal from the node\'s leak-denylist.txt is in a tracked file', () => {
    const entries = readFileSync(denyFile, 'utf8').split(/\r?\n/)
      .map((l, i) => ({ n: i + 1, v: l.trim() }))
      .filter((e) => e.v && !e.v.startsWith('#'));
    const hits = [];
    const lowered = new Map([...texts].map(([f, t]) => [f, t.toLowerCase()]));   // once per file, not once per entry
    for (const { n, v } of entries) {
      const needle = v.toLowerCase();
      for (const [f, t] of texts) {
        const low = lowered.get(f);
        let at = low.indexOf(needle);
        while (at !== -1) {
          hits.push(`${f}:${t.slice(0, at).split('\n').length}: denylist line ${n}`);
          at = low.indexOf(needle, at + needle.length);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
