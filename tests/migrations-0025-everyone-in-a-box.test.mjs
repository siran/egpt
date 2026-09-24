// tests/migrations-0025-everyone-in-a-box.test.mjs — migrations/0025-everyone-in-a-box.mjs.
//
// ONE ruling in four independent parts, and every one of them is asked as a PROPERTY of what is in
// the file: the blanket `~/src` grant goes (A), a being that declares no level states the one it
// already resolves to (B), the tier with nothing holding it is switched off (C), and a `regular`
// carrying a `sandboxed:` line has BOTH lines corrected at once (D). No node name appears in the
// migration and none is needed here: the kg-shaped fixture qualifies for A, B and C because of what
// it holds, and the do-shaped one for D alone.
//
// THE FIXTURES ARE MINIATURES OF REAL STATE, in temp dirs, and every one of them is a node that
// every EARLIER migration has nothing left to do on (the runner describe at the bottom proves
// exactly that — a fixture an earlier migration acts on fails these tests for the wrong reason,
// which is how the 0003, 0010, 0018, 0019, 0021, 0022 and 0024 fixtures broke in turn). kg reads as
// it does after 0015/0022/0023: the node-wide read grant written as 0015 writes it, comment block
// and all, `wren`'s pinned ratio, and its own `chrome:` block.
//
// THE GRANT'S PATH IS DERIVED, never spelled, because the MIGRATION derives it — `dirname(
// EGPT_HOME) + '/src'`, 0015's own reading. A fixture in a temp dir therefore states ITS OWN src/
// path, which is the point: a spelled `C:/Users/an/src` would pass on one machine and be a lie
// everywhere else.
//
// The assertions are on the FULL text, never a re-parse: the comments beside these blocks and every
// other byte are what the splice layer exists to protect. CRLF throughout, as the live files are.
//
// AND THE EVIDENCE TESTS DO NOT READ THE FILE AT ALL — they drive the node's own readState/getBeing
// (getBeing RENAMES the stored `access_level` to `accessLevel`, which is the name asserted below)
// and then the two PURE functions src/spine/brainpool.mjs's resolveConv hands the turn:
// resolveSandboxed, whose rung 1 is the whole reason `access_level` is the tier that was written,
// and isSandboxContradiction, which is the predicate src/spine/boot.mjs makes FATAL. That pair is
// what proves D's two lines have to move together: the level alone IS the contradiction.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0025-everyone-in-a-box.mjs';
import { runMigrations } from '../setup/migrate.mjs';
import { readState, getBeing } from '../src/conversations-state.mjs';
import { resolveSandboxed, isSandboxContradiction } from '../src/spine/brainpool.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
// The path 0015 granted and this retires, as the migration derives it: the profile's parent is the
// operator's home, so its `src/` is the node's own.
const srcOf = (h) => `${dirname(h).replace(/\\/g, '/')}/src`;

// ── what the migration writes, at the columns it writes it at ────────────────────────────────
const LEVEL_LINES = (pad) => [
  `${pad}# BOXED UNLESS IT SAYS OTHERWISE (0025, operator 2026-09-23: "all agents sandboxed, but the`,
  `${pad}# meta engineers"). This being declared no level at all, and silence RESOLVES to this one`,
  `${pad}# (src/spine/brainpool.mjs resolveConv) - so the line states what already governs its turns`,
  `${pad}# rather than changing them. \`sandbox\` is all's capability inside a Windows logon session`,
  `${pad}# whose ACEs are the entire boundary; it FORCES the OS box on (resolveSandboxed's rung 1),`,
  `${pad}# above any \`sandboxed:\` a lower rung could state - which is why no such line is written`,
  `${pad}# beside it, and why one that IS written beside it is refused at boot.`,
  `${pad}access_level: sandbox`,
];
const CD_LINES = (pad) => [
  `${pad}# THE FIELDS THIS BEING LETS A CONVERSATION OVERRIDE, and its own defaults for them - the`,
  `${pad}# nesting IS the allowlist (src/spine/brainpool.mjs resolveConv reads this rung and no`,
  `${pad}# other; a flat sibling of \`handles:\` would be read by nothing).`,
  `${pad}conversation_defaults:`,
  ...LEVEL_LINES(`${pad}  `),
];
const MODE_LINES = (pad) => [
  `${pad}# OFF UNTIL SOMETHING HOLDS IT (0025, operator 2026-09-23: "for now we can disable L, P, and`,
  `${pad}# C", "backburn them for now"). A \`regular\` being gets NO OS box - resolveSandboxed never`,
  `${pad}# reaches the rung that forces one - and since 33c9eb5 the CLI is no longer a fence for`,
  `${pad}# anyone: no --add-dir, no deny rules. So this is the one tier with nothing holding it.`,
  `${pad}# \`off\` is the mode the gate already has (src/auto-mode.mjs): it neither receives nor`,
  `${pad}# replies, so the being never sees the chat. Its level and any \`sandboxed:\` line beside it`,
  `${pad}# are left EXACTLY as they are - a being being switched off keeps whatever tier it had, and`,
  `${pad}# on this node that line is what makes the being work at all.`,
  `${pad}mode: off`,
];

// ── the block 0015 left on kg, comment and all: what A takes back off ────────────────────────
const GRANT_LINES = (h) => [
  '# NODE-WIDE READ GRANT (0015, operator 2026-09-20: "we can \'leak\' my own src/ to the agent',
  '# (read-only for now)"). ONE place to grant a folder to EVERY being here, and one place to',
  '# revoke it - src/spine/brainpool.mjs resolveBeingDef merges this into every being\'s def, UNDER',
  '# the def\'s own allowed_paths, so a being that names the same path keeps its own narrower grant.',
  'allowed_paths:',
  `  ${srcOf(h)}:`,
  '    allowed_tools: [ Read, Glob, Grep ]',
];

// ── kg's config.yaml as it reads after 0015/0022/0023 ────────────────────────────────────────
const OPERATOR = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com" ]';
const DRIVEN = '[ "16468217865", "34836563681438", "@anrodriguez:beeper.com", "@dolly-egpt:beeper.com" ]';
// The beings that already state a tier - left exactly as they are, whichever tier it is.
const KG_DECLARED = [
  '  egpt:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ e, egpt, ekg ]',
  '    default: true',
  '    name: "E"',
  '    conversation_defaults:',
  '      access_level: sandbox',
  `      allowed_users: ${OPERATOR} # who may wake E`,
  '  wren:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: wren # config/agents/identities/wren.md',
  '    handles: [ wren, w ]',
  '    name: "Wren"',
  '    scope: agent/wren # one agent/wren node-wide',
  '    sandboxed: false',
  '    conversation_defaults:',
  '      access_level: all',
  `      allowed_users: ${DRIVEN} # who may drive this being`,
  '      compaction:',
  '        ratio: 0.50',
];
// The two `regular` beings C answers, IN THEIR LIVE SHAPE - one with no `mode:` at all, one
// carrying a stale mode, and BOTH carrying the `sandboxed: false` that is the reason they work at
// all. C must switch them off and leave everything else byte-identical: boxing `codex` would put
// it in a logon session that cannot read CODEX_HOME, and boxing `llama` would confine an HTTP call.
const KG_REGULAR = [
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  '    conversation_defaults:',
  '      access_level: regular',
  '      sandboxed: false # authenticates from CODEX_HOME, which a pool account cannot read',
  '  llama:',
  '    configuration: llama',
  '    handles: [ llama, l ]',
  '    mode: mention # answers when addressed',
  '    conversation_defaults:',
  '      access_level: regular',
  '      sandboxed: false # HTTP, so there is no process to confine',
];
// The three that state nothing: a relay with no `conversation_defaults:` at all, a being that has
// the block but no level in it, and a second relay.
const KG_UNDECLARED = [
  '  carol:',
  '    relay_channel: rodz1',
  '    to: don.do',
  '    handles: [ carol ]',
  '  cara:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ cara ]',
  '    conversation_defaults:',
  `      allowed_users: ${OPERATOR} # who may wake cara`,
  '  don:',
  '    configuration: relay',
  '    relay_channel: dolly1',
  '    to: don.do',
  '    handles: [ don, d, rodz ] # 0020 gave the mouth to the being that answers `don`',
];
const KG_TAIL = [
  '# kg names its own browser already - a 64-bit install, and its own brain profile',
  'chrome:',
  '  bin: C:/Program Files/Google/Chrome/Application/chrome.exe',
  '  profile_dir: C:/Users/an/.egpt/chrome/profiles/brain',
];
const KG_FOOT = [
  'compaction:',
  '  ratio: 0.80 # the node default',
  '  cooling_ms: 600000',
  '',
  '# nothing below this line is read by the spine',
];
const KG_LINES = (h) => [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  ...KG_DECLARED,
  ...KG_REGULAR,
  ...KG_UNDECLARED,
  ...KG_TAIL,
  ...GRANT_LINES(h),
  ...KG_FOOT,
];
const KG = (h) => crlf(KG_LINES(h));

// The same node once every part that applies to it has run: the grant block gone whole, `mode: off`
// on both `regular` beings, and a stated level on all three that stated none.
const KG_AFTER_LINES = () => [
  '# config.yaml - kg (fixture)',
  'node_name: kg',
  'agents:',
  ...KG_DECLARED,
  '  codex:',
  '    configuration: codex',
  '    handles: [ codex ]',
  '    conversation_defaults:',
  '      access_level: regular',
  '      sandboxed: false # authenticates from CODEX_HOME, which a pool account cannot read',
  ...MODE_LINES('    '),
  '  llama:',
  '    configuration: llama',
  '    handles: [ llama, l ]',
  '    mode: off # answers when addressed',
  '    conversation_defaults:',
  '      access_level: regular',
  '      sandboxed: false # HTTP, so there is no process to confine',
  '  carol:',
  '    relay_channel: rodz1',
  '    to: don.do',
  '    handles: [ carol ]',
  ...CD_LINES('    '),
  '  cara:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ cara ]',
  '    conversation_defaults:',
  `      allowed_users: ${OPERATOR} # who may wake cara`,
  ...LEVEL_LINES('      '),
  '  don:',
  '    configuration: relay',
  '    relay_channel: dolly1',
  '    to: don.do',
  '    handles: [ don, d, rodz ] # 0020 gave the mouth to the being that answers `don`',
  ...CD_LINES('    '),
  ...KG_TAIL,
  ...KG_FOOT,
];
const KG_AFTER = crlf(KG_AFTER_LINES());

// ── do: the one being whose level and whose second opinion about the box are BOTH wrong ──────
const DO_LINES = [
  '# config.yaml - do (fixture)',
  'node_name: do',
  'agents:',
  '  don:',
  '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
  '    handles: [ d, don, rodz ] # 0020 gave the mouth to the being that answers `don`',
  '    default: true',
  '    name: "Don"',
  '    conversation_defaults:',
  '      access_level: regular',
  '      sandboxed: false # no sandbox pool provisioned on dolly yet',
  `      allowed_users: ${OPERATOR} # who may wake don`,
  '  dren:',
  '    configuration: sonnet-high # config/agents/sonnet-high.yaml',
  '    personality: dren # config/agents/identities/dren.md',
  '    handles: [ dren ]',
  '    name: "Dren"',
  '    conversation_defaults:',
  '      access_level: all',
  `      allowed_users: ${DRIVEN} # who may drive this being`,
  '  djh:',
  '    configuration: haiku-low # config/agents/haiku-low.yaml',
  '    handles: [ djh ]',
  '    mode: off # 0006 - off until dj pi replaces it',
  '    conversation_defaults:',
  '      access_level: sandbox',
  '',
  '# nothing below this line is read by the spine',
];
const DO = crlf(DO_LINES);
const DO_AFTER = crlf(DO_LINES
  .filter((l) => !l.startsWith('      sandboxed: false'))
  .map((l) => (l === '      access_level: regular' ? '      access_level: sandbox' : l)));

// ── conversations.yaml: the room rows that make readState/getBeing resolve at all ────────────
const KG_CHAT = '0MP97ovrD6XvVovMVx6v';
const CONV = crlf([
  'contacts:',
  '  whatsapp:',
  `    ${KG_CHAT}: # perrito traduciones`,
  '      conversation_path: .egpt/conversations/whatsapp/perrito-traduciones',
  '      home_dir: /c/Users/an',
]);

// The type files the `configuration:` lines name. None pins a `cwd:`, so 0014 has nothing to move.
const TYPES = {
  'sonnet-default': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'sonnet-high': 'type: ccode\nmodel: sonnet\neffort: high\n',
  'haiku-low': 'type: ccode\nmodel: haiku\neffort: low\n',
};
const IDENTITIES = { wren: '# I am Wren\n', dren: '# I am Dren\n' };

// `.egpt` nested inside the temp dir, so `<parent>/src` does not exist on disk - which is what
// keeps 0015 satisfied on these fixtures while the GRANT for that same path is still in the file.
function home({ config = KG, conversations = CONV } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0025-')), '.egpt');
  mkdirSync(join(h, 'config', 'agents', 'identities'), { recursive: true });
  if (config !== null) writeFileSync(join(h, 'config', 'config.yaml'), typeof config === 'function' ? config(h) : config);
  if (conversations !== null) writeFileSync(join(h, 'config', 'conversations.yaml'), conversations);
  for (const [name, text] of Object.entries(TYPES)) writeFileSync(join(h, 'config', 'agents', `${name}.yaml`), text);
  for (const [name, text] of Object.entries(IDENTITIES)) writeFileSync(join(h, 'config', 'agents', 'identities', `${name}.md`), text);
  return h;
}
const cfgPath = (h) => join(h, 'config', 'config.yaml');
const convPath = (h) => join(h, 'config', 'conversations.yaml');
const baks = (h) => readdirSync(join(h, 'config')).filter((f) => f.includes('.bak-'));
const ctxFor = (h) => ({
  egptHome: h,
  log: () => {},
  backup: (f) => { const to = `${f}.bak-0025-test`; writeFileSync(to, readFileSync(f)); return to; },
});
const read = (h) => readFileSync(cfgPath(h), 'utf8');
const parsed = (h) => YAML.parse(read(h));

// THE NODE'S OWN READING of a being's tier, spelled exactly as src/spine/brainpool.mjs's resolveConv
// spells it: the per-conversation override first (getBeing, which renames the stored key to
// `accessLevel`), then this node's agent default, then the 2026-09-23 fallback.
const resolvedLevel = (b, cfg, being) => b?.accessLevel ?? cfg?.agents?.[being]?.conversation_defaults?.access_level ?? 'sandbox';
// ...and the box that level lands the turn in, through the ONE function that answers it.
const resolvedBox = (b, cfg, being, platform = 'win32') => resolveSandboxed({
  accessLevel: resolvedLevel(b, cfg, being),
  conversationValue: b?.sandboxed ?? null,
  agentDefaultValue: cfg?.agents?.[being]?.conversation_defaults?.sandboxed ?? null,
  platform,
});
const beingIn = async (h, being) => getBeing(await readState(convPath(h)), 'whatsapp', KG_CHAT, being);

describe('0025 on kg - the grant goes, the undeclared say what they are, the unheld tier goes off', () => {
  it('plans A, B and C, each named, and nothing for the beings that already state a tier', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);

    // A: the whole mapping, because that one grant was its only entry - comment block included.
    expect(p.changes.some((l) => l.endsWith(
      `remove the node's whole \`allowed_paths:\` mapping - ${srcOf(h)} was its only entry, and an empty one would read like a grant and grant nothing`,
    ))).toBe(true);
    expect(p.changes.filter((l) => l.startsWith('  - '))).toEqual([
      ...GRANT_LINES(h).map((l) => `  - ${l}`),
      '  -     mode: mention # answers when addressed',
    ]);

    // C: one insert and one scalar, one per `regular` being.
    expect(p.changes.some((l) => l.endsWith(
      'insert `mode: off` at agents.codex - a `regular` being has no OS box and the CLI is no longer a fence; it is switched off, not re-tiered',
    ))).toBe(true);
    expect(p.changes.some((l) => l.endsWith(
      '`agents.llama.mode`: mention -> off - a `regular` being has no OS box and the CLI is no longer a fence; it is switched off, not re-tiered',
    ))).toBe(true);
    // ...and each is TOLD that its `sandboxed:` line stays, which is the whole of C-beats-D.
    for (const n of ['codex', 'llama']) {
      expect(p.changes).toContain(
        `agents.${n}.conversation_defaults.sandboxed in ${cfgPath(h)} stays exactly as it is, comment and all - a being being switched off keeps whatever tier it had, and that line is not dead config on a being that is not meant to keep taking turns`,
      );
    }

    // B: the whole block for the two that have none, the one line for the one that has it.
    expect(p.changes.some((l) => l.endsWith('insert `conversation_defaults.access_level: sandbox` at agents.carol - the tier it already resolves to, written down'))).toBe(true);
    expect(p.changes.some((l) => l.endsWith('insert `access_level: sandbox` at agents.cara.conversation_defaults - the tier it already resolves to, written down'))).toBe(true);
    expect(p.changes.some((l) => l.endsWith('insert `conversation_defaults.access_level: sandbox` at agents.don - the tier it already resolves to, written down'))).toBe(true);

    // ...and the two that DO state one are named as left alone, whichever tier they state.
    expect(p.changes).toContain(`agents.egpt in ${cfgPath(h)} already states \`access_level: "sandbox"\`, which is a tier its operator chose - left exactly as it is`);
    expect(p.changes).toContain(`agents.wren in ${cfgPath(h)} already states \`access_level: "all"\`, which is a tier its operator chose - left exactly as it is`);
    expect(p.changes.at(-1)).toBe('backup first, beside it: config.yaml.bak-0025-<timestamp>');
    // Six edits in one file: one removal, two modes, three levels.
    expect(p.changes.filter((l) => l.includes(`${cfgPath(h)}:`)).length).toBe(6);
  });

  it('apply: the file reads exactly as intended, and every other byte - comments, CRLF, the pinned ratio - is untouched', async () => {
    const h = home();
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(read(h)).toBe(KG_AFTER);
    // The comments this walked over, at the top, in the middle and at the very bottom.
    expect(read(h)).toContain('# config.yaml - kg (fixture)\r\n');
    expect(read(h)).toContain('# kg names its own browser already - a 64-bit install, and its own brain profile\r\n');
    expect(read(h)).toContain('\r\n\r\n# nothing below this line is read by the spine\r\n');
    // The operator's own end-of-line comment on the line C rewrote: the VALUE moved, the comment
    // did not - a splice rewrites a comment only when it is asked to, and it never invents one.
    expect(read(h)).toContain('    mode: off # answers when addressed\r\n');
    // conversations.yaml is not this migration's file and is not opened for writing.
    expect(readFileSync(convPath(h), 'utf8')).toBe(CONV);
    expect(baks(h)).toEqual(['config.yaml.bak-0025-test']);
    expect(readFileSync(`${cfgPath(h)}.bak-0025-test`, 'utf8')).toBe(KG(h));
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  it('nothing else moved: every other key of every other being reads the same', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const cfg = parsed(h);
    expect(cfg.allowed_paths).toBeUndefined();
    expect(cfg.agents.egpt.conversation_defaults).toEqual({ access_level: 'sandbox', allowed_users: JSON.parse(OPERATOR) });
    expect(cfg.agents.wren.conversation_defaults).toEqual({ access_level: 'all', allowed_users: JSON.parse(DRIVEN), compaction: { ratio: 0.5 } });
    expect(cfg.agents.wren.sandboxed).toBe(false);          // a flat one, on an `all` being: not D's, not touched
    expect(cfg.agents.codex).toEqual({ configuration: 'codex', handles: ['codex'], mode: 'off', conversation_defaults: { access_level: 'regular', sandboxed: false } });
    expect(cfg.agents.llama.mode).toBe('off');
    expect(cfg.agents.llama.conversation_defaults).toEqual({ access_level: 'regular', sandboxed: false });
    expect(cfg.agents.carol).toEqual({ relay_channel: 'rodz1', to: 'don.do', handles: ['carol'], conversation_defaults: { access_level: 'sandbox' } });
    expect(cfg.agents.cara.conversation_defaults).toEqual({ allowed_users: JSON.parse(OPERATOR), access_level: 'sandbox' });
    expect(cfg.agents.don.conversation_defaults).toEqual({ access_level: 'sandbox' });
    expect(cfg.chrome.bin).toBe('C:/Program Files/Google/Chrome/Application/chrome.exe');
    expect(cfg.compaction).toEqual({ ratio: 0.8, cooling_ms: 600000 });
    // AND NOT ONE `sandboxed:` LINE WAS WRITTEN - the two that carry one are the two that already
    // did, both switched off rather than re-tiered. Where this migration WRITES a level it never
    // writes a second opinion beside it: that is the contradiction the boot gate refuses.
    expect(Object.entries(cfg.agents).filter(([, a]) => Object.hasOwn(a.conversation_defaults ?? {}, 'sandboxed')).map(([n]) => n))
      .toEqual(['codex', 'llama']);
    expect(Object.entries(cfg.agents).filter(([, a]) => a.conversation_defaults?.access_level === 'sandbox')
      .every(([, a]) => !Object.hasOwn(a.conversation_defaults, 'sandboxed'))).toBe(true);
  });

  // THE EVIDENCE TEST. Not "is the key in the file" but "does the node READ it, and to what": the
  // same readState/getBeing pair boot.mjs hands brainpool (which renames the stored key to
  // `accessLevel`), then the pure resolver the turn actually walks.
  it('the node READS it: an undeclared being resolved `sandbox` by default and now resolves it from the file', async () => {
    const h = home();
    const before = parsed(h);
    const b = await beingIn(h, 'carol');
    expect(b.accessLevel).toBeNull();                                  // no per-conversation override, either way
    expect(before.agents.carol.conversation_defaults).toBeUndefined(); // ...and nothing in the file
    expect(resolvedLevel(b, before, 'carol')).toBe('sandbox');         // the 2026-09-23 default, and only that

    await (await plan(ctxFor(h))).apply();

    const after = parsed(h);
    expect((await beingIn(h, 'carol')).accessLevel).toBeNull();        // the conversation tier is still silent
    expect(after.agents.carol.conversation_defaults.access_level).toBe('sandbox');
    expect(resolvedLevel(await beingIn(h, 'carol'), after, 'carol')).toBe('sandbox');  // same answer, now stated
    // ...and the tier is the one that FORCES the box, which is why it was the tier written.
    expect(resolvedBox(await beingIn(h, 'carol'), after, 'carol', 'linux')).toBe(true);
    expect(isSandboxContradiction(resolvedLevel(await beingIn(h, 'carol'), after, 'carol'), after.agents.carol.conversation_defaults.sandboxed ?? null)).toBe(false);
  });

  it('the beings that state a tier keep answering exactly what they answered', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    const cfg = parsed(h);
    expect(resolvedLevel(await beingIn(h, 'wren'), cfg, 'wren')).toBe('all');
    expect(resolvedLevel(await beingIn(h, 'egpt'), cfg, 'egpt')).toBe('sandbox');
    // The `regular` beings are still `regular` - C switches them off, it does not re-tier them.
    expect(resolvedLevel(await beingIn(h, 'codex'), cfg, 'codex')).toBe('regular');
    expect(resolvedBox(await beingIn(h, 'codex'), cfg, 'codex', 'linux')).toBe(false);
  });

  // The being is found by HANDLE through router.mjs's wakeTokens, never by map key - `don` on do is
  // keyed `don` today and that is 0018's doing, not a thing this may assume.
  it('C finds its beings by handle: a being KEYED something else but answering `llama` is the one switched off', async () => {
    const h = home({ config: (hh) => KG(hh).replace('  llama:\r\n', '  ollama-box:\r\n') });
    await (await plan(ctxFor(h))).apply();
    const cfg = parsed(h);
    expect(cfg.agents['ollama-box'].mode).toBe('off');
    expect(cfg.agents.llama).toBeUndefined();
  });

  it('and a being KEYED `llama` that answers to something else entirely is left alone', async () => {
    const h = home({ config: (hh) => KG(hh)
      .replace('    handles: [ llama, l ]\r\n', '    handles: [ ollama ]\r\n')
      // ...and without its `sandboxed:` line, which is what would otherwise hand it to D: the
      // question this test asks is C's alone.
      .replace('      sandboxed: false # HTTP, so there is no process to confine\r\n', '') });
    const p = await plan(ctxFor(h));
    expect(p.changes).toContain(
      `agents.llama in ${cfgPath(h)} states \`access_level: regular\` and answers to none of [ codex, llama ] - which beings run unheld is the operator's call and this names only the ones it was given`,
    );
    await p.apply();
    expect(parsed(h).agents.llama.mode).toBe('mention');
  });
});

describe('0025 on do - the level and the line beside it, corrected together', () => {
  it('plans exactly D, and the change is two lines', async () => {
    const h = home({ config: DO });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    expect(p.changes).toEqual([
      `${cfgPath(h)}:10-10  \`agents.don.conversation_defaults.access_level\`: regular -> sandbox, which FORCES the OS box on (resolveSandboxed rung 1) - this being is not one of [ codex, llama ], so it keeps taking turns and its \`sandboxed:\` line is dead config`,
      '  -       access_level: regular',
      '  +       access_level: sandbox',
      `${cfgPath(h)}:11-11  remove the now-dead \`sandboxed: false\` at agents.don.conversation_defaults - under \`sandbox\` it is unreachable, and src/spine/boot.mjs makes it FATAL rather than let it read like an override`,
      '  -       sandboxed: false # no sandbox pool provisioned on dolly yet',
      `${cfgPath(h)} states no \`allowed_paths:\` at all, so there is no blanket grant here to retire`,
      `agents.dren in ${cfgPath(h)} already states \`access_level: "all"\`, which is a tier its operator chose - left exactly as it is`,
      `agents.djh in ${cfgPath(h)} already states \`access_level: "sandbox"\`, which is a tier its operator chose - left exactly as it is`,
      'backup first, beside it: config.yaml.bak-0025-<timestamp>',
    ]);
  });

  it('apply: both lines move, the false comment goes with the line it was on, and nothing else does', async () => {
    const h = home({ config: DO });
    const ctx = ctxFor(h);
    await (await plan(ctx)).apply();
    expect(read(h)).toBe(DO_AFTER);
    expect(read(h)).not.toContain('no sandbox pool provisioned on dolly yet');
    expect(read(h)).toContain('    mode: off # 0006 - off until dj pi replaces it\r\n');
    expect(read(h)).toContain('\r\n\r\n# nothing below this line is read by the spine\r\n');
    const cfg = parsed(h);
    expect(cfg.agents.don.conversation_defaults).toEqual({ access_level: 'sandbox', allowed_users: JSON.parse(OPERATOR) });
    expect(cfg.agents.dren.conversation_defaults.access_level).toBe('all');
    expect(cfg.agents.djh.mode).toBe('off');
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
  });

  // WHY BOTH LINES MOVE TOGETHER, through the predicate that decides it: the level alone IS the
  // contradiction src/spine/boot.mjs throws for, and the removal alone leaves a `regular` being
  // unboxed. Neither half is a state this migration may leave a node in.
  it('the level alone would be the contradiction boot refuses, and the removal alone would leave it unboxed', async () => {
    const h = home({ config: DO });
    const before = parsed(h);
    const cd = before.agents.don.conversation_defaults;
    expect(resolvedLevel(await beingIn(h, 'don'), before, 'don')).toBe('regular');
    expect(resolvedBox(await beingIn(h, 'don'), before, 'don')).toBe(false);          // regular + sandboxed:false = no box at all
    expect(isSandboxContradiction('sandbox', cd.sandboxed)).toBe(true);               // ...and the level ALONE is refused at boot
    expect(isSandboxContradiction('regular', undefined)).toBe(false);                 // ...while the removal alone is merely unboxed
    expect(resolveSandboxed({ accessLevel: 'regular', conversationValue: null, agentDefaultValue: null, platform: 'linux' })).toBe(false);

    await (await plan(ctxFor(h))).apply();

    const after = parsed(h);
    const cdAfter = after.agents.don.conversation_defaults;
    expect(Object.hasOwn(cdAfter, 'sandboxed')).toBe(false);
    expect(resolvedLevel(await beingIn(h, 'don'), after, 'don')).toBe('sandbox');
    expect(isSandboxContradiction(resolvedLevel(await beingIn(h, 'don'), after, 'don'), cdAfter.sandboxed ?? null)).toBe(false);
    expect(resolvedBox(await beingIn(h, 'don'), after, 'don', 'linux')).toBe(true);   // rung 1, platform-blind
  });

  // A `regular` being whose block cannot take BOTH edits gets NEITHER. This is the one fixture
  // where writing half the correction would stop the node at boot.
  it('a flow `conversation_defaults:` cannot take the pair, so NEITHER line is written', async () => {
    const flow = crlf([
      'node_name: do',
      'agents:',
      '  don:',
      '    handles: [ d, don ]',
      '    conversation_defaults: { access_level: regular, sandboxed: false }',
    ]);
    const h = home({ config: flow });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes.some((n) => n.startsWith(`agents.don.conversation_defaults in ${cfgPath(h)} cannot take both lines of this correction`)
      && n.endsWith('so NEITHER line is written here'))).toBe(true);
    expect(read(h)).toBe(flow);                       // byte for byte
    expect(baks(h)).toEqual([]);
    // And what the node still reads is the state it was already in - not half of the correction.
    expect(isSandboxContradiction(parsed(h).agents.don.conversation_defaults.access_level, parsed(h).agents.don.conversation_defaults.sandboxed)).toBe(false);
  });

  // C AND D CAN ONLY EVER WANT THE SAME BEING when it is `regular`, states a `sandboxed:` AND
  // answers to one of C's handles. C TAKES IT - a `sandboxed: false` is dead config only on a
  // being meant to keep taking turns, and this one is being switched off instead.
  it('a `regular` being that both answers `codex` and states a `sandboxed:` is switched off, not boxed', async () => {
    const both = crlf([
      'node_name: kg',
      'agents:',
      '  codex:',
      '    handles: [ codex ]',
      '    conversation_defaults:',
      '      access_level: regular',
      '      sandboxed: true',
    ]);
    const h = home({ config: both });
    const p = await plan(ctxFor(h));
    expect(p.changes).toContain(
      `agents.codex.conversation_defaults.sandboxed in ${cfgPath(h)} stays exactly as it is, comment and all - a being being switched off keeps whatever tier it had, and that line is not dead config on a being that is not meant to keep taking turns`,
    );
    await p.apply();
    const cfg = parsed(h);
    expect(cfg.agents.codex).toEqual({ handles: ['codex'], mode: 'off', conversation_defaults: { access_level: 'regular', sandboxed: true } });
  });

  // THE LOCK ON THE INVERSION, in the live shape the dry run caught: both beings carry the
  // `sandboxed: false` that is the reason they work at all - `codex` authenticates from a
  // CODEX_HOME a pool account cannot read, `llama` is an HTTP call with no process to confine.
  // Boxing either would break it. Exactly ONE line is added to each, and every byte of the tier
  // and of the comment beside it survives.
  it('codex and llama, live shape: ONLY `mode: off` is added - level, `sandboxed:` line and comment byte-identical', async () => {
    const h = home();
    const before = read(h);
    await (await plan(ctxFor(h))).apply();
    const after = read(h);

    for (const line of [
      '      access_level: regular\r\n',
      '      sandboxed: false # authenticates from CODEX_HOME, which a pool account cannot read\r\n',
      '      sandboxed: false # HTTP, so there is no process to confine\r\n',
    ]) {
      expect(before).toContain(line);
      expect(after).toContain(line);            // byte for byte, comment included
    }
    const cfg = parsed(h);
    for (const n of ['codex', 'llama']) {
      // Neither tier moved and neither line was taken out - the only difference is the mode...
      expect(cfg.agents[n].conversation_defaults.access_level).toBe('regular');
      expect(cfg.agents[n].conversation_defaults.sandboxed).toBe(false);
      expect(cfg.agents[n].mode).toBe('off');
      // ...so the node still reads them exactly as it did: NOT in a box, which is the whole point.
      expect(resolvedLevel(await beingIn(h, n), cfg, n)).toBe('regular');
      expect(resolvedBox(await beingIn(h, n), cfg, n)).toBe(false);
      expect(isSandboxContradiction(resolvedLevel(await beingIn(h, n), cfg, n), cfg.agents[n].conversation_defaults.sandboxed)).toBe(false);
    }
  });
});

describe('0025: each part is independently satisfiable', () => {
  // A alone: the grant is there and every being already states a tier.
  it('A alone - the grant goes and no being is touched', async () => {
    const only = (h) => crlf([
      'node_name: kg',
      'agents:',
      ...KG_DECLARED,
      ...GRANT_LINES(h),
    ]);
    const h = home({ config: only });
    const p = await plan(ctxFor(h));
    expect(p.changes.filter((l) => l.includes(`${cfgPath(h)}:`)).length).toBe(1);
    await p.apply();
    expect(read(h)).toBe(crlf(['node_name: kg', 'agents:', ...KG_DECLARED]));
  });

  // The grant is one of SEVERAL: only its entry goes, and the map it lived in stays.
  it('A with a neighbour - only the one entry goes, and the map stays', async () => {
    const two = (h) => crlf([
      'node_name: kg',
      'agents:',
      ...KG_DECLARED,
      ...GRANT_LINES(h),
      '  D:/shared/reference:',
      '    allowed_tools: [ Read ]',
    ]);
    const h = home({ config: two });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((l) => l.endsWith(`remove \`allowed_paths.${srcOf(h)}\` - the rest of the map is left exactly as it is`))).toBe(true);
    await p.apply();
    expect(read(h)).toBe(crlf([
      'node_name: kg',
      'agents:',
      ...KG_DECLARED,
      ...GRANT_LINES(h).slice(0, 5),       // the comment block and `allowed_paths:` stay
      '  D:/shared/reference:',
      '    allowed_tools: [ Read ]',
    ]));
    expect(parsed(h).allowed_paths).toEqual({ 'D:/shared/reference': { allowed_tools: ['Read'] } });
  });

  // B alone: no grant, nobody `regular`, one being stating nothing.
  it('B alone - the undeclared being states its tier and nothing else changes', async () => {
    const only = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, '  carol:', '    handles: [ carol ]', '    relay_channel: rodz1']);
    const h = home({ config: only });
    const p = await plan(ctxFor(h));
    expect(p.changes.filter((l) => l.includes(`${cfgPath(h)}:`)).length).toBe(1);
    expect(p.changes).toContain(`${cfgPath(h)} states no \`allowed_paths:\` at all, so there is no blanket grant here to retire`);
    await p.apply();
    expect(read(h)).toBe(crlf([
      'node_name: kg', 'agents:', ...KG_DECLARED,
      '  carol:', '    handles: [ carol ]', '    relay_channel: rodz1', ...CD_LINES('    '),
    ]));
  });

  // C alone: no grant, nobody undeclared, one `regular` being answering a named handle.
  it('C alone - the unheld tier goes off and nothing else changes', async () => {
    const only = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, '  codex:', '    handles: [ codex ]', '    conversation_defaults:', '      access_level: regular']);
    const h = home({ config: only });
    const p = await plan(ctxFor(h));
    expect(p.changes.filter((l) => l.includes(`${cfgPath(h)}:`)).length).toBe(1);
    await p.apply();
    expect(read(h)).toBe(crlf([
      'node_name: kg', 'agents:', ...KG_DECLARED,
      '  codex:', '    handles: [ codex ]', '    conversation_defaults:', '      access_level: regular', ...MODE_LINES('    '),
    ]));
  });
});

describe('0025: "nothing to do here" is a note, never a refusal', () => {
  it('already applied: satisfied, naming every being, and nothing is written', async () => {
    const h = home({ config: KG_AFTER });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toContain(`${cfgPath(h)} states no \`allowed_paths:\` at all, so there is no blanket grant here to retire`);
    expect(p.notes).toContain(`agents.carol in ${cfgPath(h)} already states \`access_level: "sandbox"\`, which is a tier its operator chose - left exactly as it is`);
    expect(p.notes).toContain(`agents.codex.mode in ${cfgPath(h)} is already \`off\`, so this being already takes no turns`);
    expect(read(h)).toBe(KG_AFTER);
    expect(baks(h)).toEqual([]);
  });

  it('an `allowed_paths:` that does not name THIS node\'s src/ is not this migration\'s to touch', async () => {
    const other = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, 'allowed_paths:', '  D:/shared/reference:', '    allowed_tools: [ Read ]']);
    const h = home({ config: other });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toContain(`${cfgPath(h)} does not grant ${srcOf(h)} node-wide, so there is no blanket grant here to retire - the entry it does state is not this migration's to touch`);
    expect(read(h)).toBe(other);
  });

  // The grant is compared the way brainpool.mjs's normalizeCwd reads an allowed_paths key, so the
  // msys spelling of the same folder is the same grant and is retired too.
  it('the msys spelling of this node\'s src/ is the same grant', async () => {
    const msys = (h) => crlf([
      'node_name: kg', 'agents:', ...KG_DECLARED,
      'allowed_paths:',
      `  ${srcOf(h).replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`)}:`,
      '    allowed_tools: [ Read, Glob, Grep ]',
    ]);
    const h = home({ config: msys });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(false);
    await p.apply();
    expect(parsed(h).allowed_paths).toBeUndefined();
  });

  it('a config with no `agents:` mapping at all owes nothing but A', async () => {
    const bare = (h) => crlf(['node_name: kg', ...GRANT_LINES(h)]);
    const h = home({ config: bare });
    const p = await plan(ctxFor(h));
    expect(p.changes).toContain(`${cfgPath(h)} has no \`agents:\` mapping, so there is no being here to box, to switch off or to correct`);
    await p.apply();
    expect(read(h)).toBe(crlf(['node_name: kg']));
  });

  it('a flow being block has no column to match and no sibling to follow', async () => {
    const flow = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, '  carol: { relay_channel: rodz1, to: don.do }']);
    const h = home({ config: flow });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toContain(
      `agents.carol in ${cfgPath(h)} is an empty or flow mapping - there is no column to match and no sibling to follow, so where an \`access_level:\` line belongs would be a guess; the being still resolves to \`sandbox\` by default`,
    );
    expect(read(h)).toBe(flow);
  });

  it('a `conversation_defaults:` that is not a mapping is named and left alone', async () => {
    const odd = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, '  carol:', '    handles: [ carol ]', '    conversation_defaults: none']);
    const h = home({ config: odd });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toContain(
      `agents.carol.conversation_defaults in ${cfgPath(h)} is "none", not a mapping - no level can be written into it, and the being still resolves to \`sandbox\` by default; only the file does not say so`,
    );
    expect(read(h)).toBe(odd);
  });

  it('a `mode:` that is not a mode name is left alone rather than overwritten', async () => {
    const odd = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, '  codex:', '    handles: [ codex ]', '    mode: 3', '    conversation_defaults:', '      access_level: regular']);
    const h = home({ config: odd });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes).toContain(`agents.codex.mode in ${cfgPath(h)} is 3, not a mode name - left alone rather than overwritten`);
    expect(read(h)).toBe(odd);
  });

  // A `_`-prefixed key is a comment, not a being - src/spine/router.mjs's own guard before it will
  // advertise a token. It is skipped, not refused, and nothing is written into it.
  it('a `_`-prefixed key in `agents:` is not a being', async () => {
    const commented = crlf(['node_name: kg', 'agents:', '  _note: "the beings below are kg\'s"', ...KG_DECLARED]);
    const h = home({ config: commented });
    const p = await plan(ctxFor(h));
    expect(p.satisfied).toBe(true);
    expect(p.notes.some((n) => n.includes('_note'))).toBe(false);
    expect(read(h)).toBe(commented);
  });

  // The agent default this writes is silent only where no conversation re-enables the being
  // (src/spine/gating.mjs resolves that tier first). 0006 REFUSED over this; a refusal here would
  // stop every later migration on the node, so the chat is NAMED instead.
  it('a conversation that re-enables a switched-off being is named, and the default is still written', async () => {
    const conv = crlf([
      'contacts:',
      '  whatsapp:',
      `    ${KG_CHAT}: # perrito traduciones`,
      '      conversation_path: .egpt/conversations/whatsapp/perrito-traduciones',
      '      home_dir: /c/Users/an',
      '      agents:',
      '        codex:',
      '          mode: on',
    ]);
    const h = home({ conversations: conv });
    const p = await plan(ctxFor(h));
    expect(p.changes.some((l) => l.startsWith(`${convPath(h)} overrides it at contacts.whatsapp.${KG_CHAT}.agents.codex.mode = "on"`))).toBe(true);
    await p.apply();
    expect(parsed(h).agents.codex.mode).toBe('off');
    expect(readFileSync(convPath(h), 'utf8')).toBe(conv);   // and it is never edited
  });
});

describe('0025 refuses, naming the place, only on what it cannot honestly read or edit', () => {
  it('no config.yaml at all', async () => {
    const h = home({ config: null });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0025 refuses: there is no .*config\.yaml/);
  });

  it('a config.yaml that does not parse, and one that is not valid UTF-8', async () => {
    const bad = home({ config: 'agents: [ broken\n' });
    await expect(plan(ctxFor(bad))).rejects.toThrow(/0025 refuses: .*config\.yaml does not parse/);

    const raw = home({ config: null });
    writeFileSync(cfgPath(raw), Buffer.from([0x61, 0x67, 0x65, 0x6e, 0x74, 0x73, 0x3a, 0x20, 0xff, 0x0a]));
    await expect(plan(ctxFor(raw))).rejects.toThrow(/0025 refuses: .*config\.yaml is not valid UTF-8/);
  });

  it('an `allowed_paths:` that EXISTS but is not a mapping', async () => {
    const scalar = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, 'allowed_paths: C:/Users/an/src']);
    const h = home({ config: scalar });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0025 refuses: `allowed_paths:` in .*config\.yaml is "C:\/Users\/an\/src", not a mapping of paths/,
    );
    expect(read(h)).toBe(scalar);
  });

  it('a being block that is not a mapping - a level cannot be read out of a scalar', async () => {
    const ghost = crlf(['node_name: kg', 'agents:', ...KG_DECLARED, '  ghost: null']);
    const h = home({ config: ghost });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0025 refuses: agents\.ghost in .*config\.yaml is null, not a being block/,
    );
    expect(read(h)).toBe(ghost);
  });

  it('a `sandboxed:` that is not a boolean - the one value D reasons about, and it will not guess', async () => {
    const odd = crlf(['node_name: kg', 'agents:', '  don:', '    handles: [ d, don ]', '    conversation_defaults:', '      access_level: regular', '      sandboxed: "false"']);
    const h = home({ config: odd });
    await expect(plan(ctxFor(h))).rejects.toThrow(
      /0025 refuses: `sandboxed:` at agents\.don\.conversation_defaults in .*config\.yaml is "false", not a boolean/,
    );
    expect(read(h)).toBe(odd);
  });

  it('a file edited between plan and apply, and nothing is written', async () => {
    const h = home();
    const p = await plan(ctxFor(h));
    const edited = KG(h).replace('# config.yaml - kg (fixture)', '# config.yaml - kg (edited)');
    writeFileSync(cfgPath(h), edited);
    await expect(p.apply()).rejects.toThrow(/0025 refuses: .*config\.yaml changed since it was planned - re-run/);
    expect(read(h)).toBe(edited);
    expect(baks(h)).toEqual([]);
  });
});

describe('0025 through the runner', () => {
  // The Windows probes of 0001/0002/0004/0005 are told "nothing there", localAddresses is empty so
  // 0007 reads nothing as this node's own, Chrome is handed in (as tests/migrations-0021-*), and
  // 0024's destination is handed in so the chain never stats a real drive.
  const ctx = {
    ps: () => JSON.stringify({ map: [], services: [], from: { exists: false }, to: { exists: false } }),
    localAddresses: new Set(),
    findChrome: () => null,
    isDirectory: () => false,
  };
  const dir = join(import.meta.dirname, '..', 'migrations');
  const ledgerOf = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'));
  const ID = '0025-everyone-in-a-box';

  it('kg: applied and recorded, one file changed and one backup beside it', async () => {
    const h = home();
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {}, through: '0025' });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('applied');
    expect(read(h)).toBe(KG_AFTER);
    expect(baks(h).map((f) => f.replace(/\d{8}T\d{6}$/, '<stamp>'))).toEqual(['config.yaml.bak-0025-<stamp>']);
  });

  it('do: applied and recorded, and D is the only part that acted', async () => {
    const h = home({ config: DO });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {}, through: '0025' });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('applied');
    expect(read(h)).toBe(DO_AFTER);
  });

  it('a node this has already run on converges too, recorded as already-satisfied with nothing written', async () => {
    const h = home({ config: KG_AFTER });
    const { exitCode } = await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {}, through: '0025' });
    expect(exitCode).toBe(0);
    expect(ledgerOf(h)[ID].outcome).toBe('already-satisfied');
    expect(read(h)).toBe(KG_AFTER);
    expect(baks(h)).toEqual([]);
  });

  it('EVERY earlier migration reads satisfied on these fixtures - one that acted would invalidate them', async () => {
    for (const h of [home(), home({ config: DO }), home({ config: KG_AFTER })]) {
      await runMigrations({ dir, egptHome: h, elevated: false, platform: 'win32', ctx, log: () => {}, through: '0025' });
      const earlier = Object.entries(ledgerOf(h)).filter(([id]) => id < '0025');
      expect(earlier.length).toBeGreaterThanOrEqual(24);
      expect(earlier.filter(([, e]) => e.outcome !== 'already-satisfied')).toEqual([]);
      // At most one backup in the whole chain, and it is this migration's: nothing earlier wrote.
      expect(baks(h).map((f) => f.split('.bak-')[1]?.replace(/\d{8}T\d{6}$/, '<stamp>'))).toEqual(
        ledgerOf(h)[ID].outcome === 'applied' ? ['0025-<stamp>'] : [],
      );
      rmSync(dirname(h), { recursive: true, force: true });
    }
  });
});
