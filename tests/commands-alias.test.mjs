// commands-alias.test.mjs — config/commands_alias.yaml (operator 2026-10-19): a line that STARTS with an
// alias runs its command line plus the rest of the line, down the typed command's own path and gates.
// Real spine + real commands over in-memory state; the transcript keeps the words as said.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-commands-alias-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { createSpine } from '../src/spine/spine.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { COMMANDS } from '../src/interpreter.mjs';
import { ensureContact, recordThread } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';

const GROUP = 'grpC';
const SIDE = shortChatId('!side1:beeper.local');
const RODZ_ID = '@whatsapp_lid-69433129173200:beeper.local';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const AGENTS = { e: { handles: ['e'], mode: 'on' }, don: { handles: ['d', 'don'] } };
const CONFIG = {
  networks: { whatsapp: { chat_ids: ['!self'] } }, agents: AGENTS,
  beeper: { primary: { phone: '+16468217865' }, secondary: { phone: '+13472576794' } },
  node_name: 'kg', node_role: 'primary', group_title: '{group}-{name}',
};
const ALIASES = join(HOME, 'config', 'commands_alias.yaml');
const writeAliases = (text) => { mkdirSync(join(HOME, 'config'), { recursive: true }); writeFileSync(ALIASES, text, 'utf8'); };
const DEFAULT_ALIASES = [
  'aparte: /e split',
  'nos vamos aparte: /e split',
  'nos vamos: /e end',
  'reinicia: /e restart force',
  '',
].join('\n');

let seq = 0;
const member = (body, over = {}) => ({
  surface: 'whatsapp', chatId: GROUP, chatName: 'C', ts: 1, kind: 'text', raw: { chatType: 'group' },
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false },
  senderId: LULU, senderName: 'Lulu', msgId: `m-${++seq}`, isSender: false, authorized: false, body, ...over,
});
const operator = (body, over = {}) => member(body, { senderId: '@an:beeper.com', senderName: 'An', isSender: true, authorized: true, ...over });

function build() {
  let st = ensureContact({ contacts: {} }, 'whatsapp', GROUP, { pushedName: 'C' }).state;
  st = recordThread(st, 'whatsapp', GROUP, 'thread-1', '2026-10-19T00:00:00Z', 'e');
  const calls = { create: [], edit: [], exit: [], audit: [], logs: [], transcript: [], brain: [], ran: [], sent: [] };
  const real = createCommands({
    getConfig: () => CONFIG, send: async (chatId, text) => { calls.sent.push({ chatId, text }); },
    exit: async (code, o = {}) => { calls.exit.push({ code, force: !!o.force }); },
    loadState: async () => st, writeState: async (s) => { st = s; },
    forkBridge: {
      editMessage: async (chatId, msgId, text) => { calls.edit.push({ chatId, msgId, text }); return true; },
      createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: '!side1:beeper.local' }; },
      postReply: async () => ({ ok: true, confirmedId: Promise.resolve('op-1') }),
      archiveChat: async () => true,
      chatAccountId: async () => 'whatsapp',
      chatRaw: async () => null,
      chatTitle: async () => null,
      resolveUserIdByPhone: async (digits) => (digits === '13472576794' ? RODZ_ID : null),
      awaitMouthMessage: async () => null,
    },
    logToGroup: async (text) => { calls.audit.push(text); return true; },
    onLog: (m) => calls.logs.push(m),
  });
  // ran: the command line each run() receives (the audit carries no arguments).
  const commands = { ...real, run: (e) => { calls.ran.push(e.body); return real.run(e); } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain: { async turn(being, ev) { calls.brain.push(ev.body); return { text: 'ok', sessionId: 'thread-1', being }; }, async accessLevel() { return 'regular'; } },
    commands,
    heartbeats: { runDue() {} },
    identity: { build: (m) => ({ ...m }) },
    router: createRouter({ getAgents: () => AGENTS }),
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: true }; }, surfaces: (d) => d.mayReply },
    sender: { open() { return { update() {}, activate() {}, fail() {}, async finish() {} }; } },
    transcript: { async log(ev, reply) { if (reply == null) calls.transcript.push(ev.body); } },
    clock: { now: () => 1 }, turnTimeoutMs: 0,
  });
  const say = (ev) => spine.handleInbound(ev);
  return { say, calls, getState: () => st };
}
const aliasLogs = (calls) => calls.logs.filter((l) => l.includes('commands_alias'));

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  writeAliases(DEFAULT_ALIASES);
});

describe('an alias runs its command line, with the rest of the message as arguments', () => {
  it('a member\'s "aparte viaje" is /split viaje: the primary makes SI+C-viaje with Rodz + the member, forked from C', async () => {
    const { say, calls, getState } = build();
    await say(member('aparte viaje'));
    expect(calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [RODZ_ID, LULU], type: 'group', title: 'SI+C-viaje' }]);
    expect(getState().contacts.whatsapp[SIDE]).toMatchObject({ parent_chat: GROUP });
    expect(calls.brain).toEqual([]);
  });

  it('not discreet: the operator\'s own alias edits his message into the placeholder, as typing /split does', async () => {
    const { say, calls } = build();
    const ev = operator('aparte viaje');
    await say(ev);
    expect(calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [RODZ_ID], type: 'group', title: 'SI+C-viaje' }]);
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0]).toMatchObject({ chatId: GROUP, msgId: ev.msgId });
  });

  it('a multi-word alias; the longest alias that fits wins', async () => {
    const { say, calls } = build();
    await say(member('nos vamos aparte playa'));
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-playa']);
    await say(member('Nos  vamos   ya'));
    expect(calls.ran).toEqual(['/split playa', '/end ya']);
    expect(calls.audit).toEqual([
      "alias 'nos vamos aparte' → /split in C by Lulu",
      "alias 'nos vamos' → /end in C by Lulu → no-op — not a /join or /split side channel",
    ]);
  });

  it('case-insensitive: "APARTE Viaje" is /split Viaje', async () => {
    const { say, calls } = build();
    await say(member('APARTE Viaje'));
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-Viaje']);
  });

  it('only at a word boundary: "apartemento" is not an alias, "aparte, viaje" is', async () => {
    const { say, calls } = build();
    await say(member('apartemento nuevo'));
    expect(calls.create).toEqual([]);
    expect(calls.brain).toEqual(['apartemento nuevo']);
    await say(member('aparte, viaje'));
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
  });
});

describe('who may use an alias: whoever may type its command', () => {
  it('"reinicia" from a member is refused exactly as a typed /e restart is; from the operator it runs', async () => {
    const { say, calls } = build();
    await say(member('/e restart'));
    await say(member('reinicia'));
    expect(calls.exit).toEqual([]);
    expect(calls.audit).toEqual([]);
    expect(calls.brain).toEqual(['/e restart', 'reinicia']);   // both are ordinary text for the being
    await say(operator('reinicia'));
    expect(calls.exit).toEqual([{ code: 43, force: true }]);
  });

  it('"reinicia" from the operator is /restart force, audited as the alias', async () => {
    const { say, calls } = build();
    await say(operator('reinicia'));
    expect(calls.ran).toEqual(['/restart force']);
    expect(calls.exit).toEqual([{ code: 43, force: true }]);
    expect(calls.audit).toEqual(["alias 'reinicia' → /restart in C by An"]);
  });

  it('a node-signed line starting with an alias runs nothing (being output is never input)', async () => {
    const { say, calls } = build();
    await say(member('aparte viaje', { fromNode: 'do' }));
    await say(operator('reinicia', { fromNode: 'kg' }));
    expect(calls.create).toEqual([]);
    expect(calls.exit).toEqual([]);
    await say(member('aparte viaje'));
    await say(operator('reinicia'));
    expect(calls.create).toHaveLength(1);
    expect(calls.exit).toEqual([{ code: 43, force: true }]);
  });
});

describe('the file: live, validated, optional', () => {
  it('an edit to commands_alias.yaml applies on the next message, with no restart', async () => {
    const { say, calls } = build();
    await say(member('fuera viaje'));
    expect(calls.create).toEqual([]);
    writeAliases('fuera: /e split\n');
    await say(member('fuera viaje'));
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
    await say(member('aparte playa'));                 // gone with the edit
    writeAliases('');
    await say(member('fuera otra'));
    expect(calls.create).toHaveLength(1);
  });

  it('refuses, one log line each, an alias that starts with "/", starts with a being handle, maps to a bare command, or maps to no command; keeps the rest', async () => {
    writeAliases([
      '/join: /split',
      'e: /end',
      'don ya: /end',
      'hola: /nonexistent',
      'bueno: hola',
      'fuera: /split',
      'aparte: /e split',
      '',
    ].join('\n'));
    const { say, calls } = build();
    await say(member('aparte viaje'));
    await say(member('hola mundo'));
    const logs = aliasLogs(calls);
    expect(logs).toHaveLength(6);
    for (const [alias, why] of [['/join', /starts with "\/"/], ['e', /being handle/], ['don ya', /being handle/], ['fuera', /no being/], ['hola', /not \/<handle> <known command>/], ['bueno', /not \/<handle> <known command>/]]) {
      const about = logs.filter((l) => l.startsWith(`commands_alias.yaml: "${alias}" `));
      expect(about, alias).toHaveLength(1);
      expect(about[0]).toMatch(why);
    }
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
    expect(calls.brain).toEqual(['hola mundo']);
  });

  it('no file, or an empty one: no aliases and nothing logged', async () => {
    rmSync(ALIASES, { force: true });
    const { say, calls } = build();
    await say(member('aparte viaje'));
    writeAliases('# nothing here\n');
    await say(member('aparte playa'));
    expect(calls.create).toEqual([]);
    expect(calls.brain).toEqual(['aparte viaje', 'aparte playa']);
    expect(aliasLogs(calls)).toEqual([]);
  });

  it('the shipped skeleton is all comments; its examples, uncommented, load with no refusal', async () => {
    const skel = readFileSync(new URL('../config/skeletons/commands_alias.yaml', import.meta.url), 'utf8');
    expect(YAML.parse(skel)).toBe(null);
    writeAliases(skel.replace(/^# ([a-z][a-z ]*: \/.*)$/gm, '$1'));
    const { say, calls } = build();
    await say(member('nos vamos aparte viaje'));
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
    expect(aliasLogs(calls)).toEqual([]);
  });

  it('the transcript keeps the words as said; the audit names the alias and the command, never its arguments', async () => {
    const { say, calls } = build();
    await say(member('aparte viaje'));
    expect(calls.transcript).toEqual(['aparte viaje']);
    expect(calls.ran).toEqual(['/split viaje']);
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
    expect(calls.audit).toEqual(["alias 'aparte' → /split in C by Lulu"]);
  });

  it('an alias to the retired /e join still loads, and answers with /split, making nothing', async () => {
    writeAliases('aparte: /e join\n');
    const { say, calls } = build();
    await say(operator('aparte viaje'));
    expect(aliasLogs(calls)).toEqual([]);
    expect(calls.ran).toEqual(['/join viaje']);
    expect(calls.create).toEqual([]);
    expect(calls.sent).toEqual([{ chatId: GROUP, text: expect.stringContaining('/e split viaje') }]);
  });
});

// Dispatched by the spine but unregistered until 2026-10-19: an alias to one was refused, /help omitted them.
describe('/tab /close /activate /bans /unban are registry commands', () => {
  const ALIASED = [['pestaña', '/tab', '1'], ['cierra', '/close', '2'], ['activa', '/activate', 'cgpt1'], ['baneos', '/bans', ''], ['perdona', '/unban', 'Lulu']];

  it('each is a wired registry entry, and an alias to each is accepted and runs it', async () => {
    for (const [, cmd] of ALIASED) expect(COMMANDS.find((e) => e.cmd === cmd), cmd).toMatchObject({ wired: true });
    writeAliases(ALIASED.map(([alias, cmd]) => `${alias}: /e ${cmd.slice(1)}`).join('\n') + '\n');
    const { say, calls } = build();
    for (const [alias, , rest] of ALIASED) await say(operator(`${alias} ${rest}`.trim()));
    expect(aliasLogs(calls)).toEqual([]);
    expect(calls.ran).toEqual(ALIASED.map(([, cmd, rest]) => `${cmd} ${rest}`.trim()));
    expect(calls.audit).toEqual(ALIASED.map(([alias, cmd]) => `alias '${alias}' → ${cmd} in C by An`));
    expect(calls.brain).toEqual([]);
  });
});

describe('regression locks', () => {
  it('typed /<handle> commands are unchanged', async () => {
    const { say, calls } = build();
    await say(member('/e split viaje'));
    await say(operator('/e restart'));
    expect(calls.create.map((c) => c.title)).toEqual(['SI+C-viaje']);
    expect(calls.exit).toEqual([{ code: 43, force: false }]);
    expect(calls.audit).toEqual(['/split in C by Lulu', '/restart in C by An']);
    expect(calls.transcript).toEqual(['/e split viaje', '/e restart']);
  });

  it('"e aparte" addresses the being, not the alias', async () => {
    const { say, calls } = build();
    await say(member('e aparte'));
    expect(calls.create).toEqual([]);
    expect(calls.brain).toEqual(['e aparte']);
    await say(member('aparte'));
    expect(calls.create).toHaveLength(1);
  });
});
