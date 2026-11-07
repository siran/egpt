// allowed_users lists JOIN by inheritance, never replace (operator 2026-11-07). The Operator is defined at
// the ROOT of config.yaml (conversation_defaults.allowed_users) and is always allowed; every list below the
// root only ADDS people. Effective list for (being, chat, surface) = root ∪ networks.<surface> ∪
// agents.<being>.conversation_defaults ∪ the chat entry's list (∪ a new chat's seed). '*' anywhere = anyone;
// [] adds nobody. The account-owner / console flags (isSender, authorized) speak for a PERSON's line only: on
// Telegram every being posts through one bot, whose echo arrives isSender + authorized + fromBeing, and a being's
// line must never count as the Operator (a being→being wake is the question, not a pass).
import { describe, it, expect } from 'vitest';
import { createRouter, mayWake, ownersOf, isOwner, configWarnings } from '../src/spine/router.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

const ROOT = 'root-op';        // the Operator
const NET = 'net-op';          // added by networks.<surface>
const AGENT = 'agent-friend';  // added by agents.<being>.conversation_defaults
const CHAT = 'chat-friend';    // added by the chat entry
const SEED = 'seed-friend';    // added by a new chat's seed
const STRANGER = 'stranger';
const SURFACE = 'telegram';
const CHAT_ID = 'tg:1';

const lineOf = (senderId, body = '@finch hola', over = {}) => ({
  surface: SURFACE, chatId: CHAT_ID, body, senderId, isSender: false, authorized: false,
  mention: { atEStart: false, atEAnywhere: true, replyToBot: false }, raw: { chatType: 'group' }, ...over,
});
// What the Telegram limb hands the spine for a being's settled post (src/bridges/telegram.mjs echo): our own
// account, signed with this node and the being.
const echoOf = (fromBeing = 'lark', over = {}) => lineOf('99', `🐦 Lark: @finch hola`, { isSender: true, authorized: true, fromNode: 'nodeA', fromBeing, recorded: true, ...over });

// The four levels, as a config + state the router and mayWake both read.
const LEVELS = ['root', 'network', 'agent', 'chat'];
const IDS = { root: ROOT, network: NET, agent: AGENT, chat: CHAT };
function world(lists = {}) {
  const config = {
    ...(lists.root ? { conversation_defaults: { allowed_users: lists.root } } : {}),
    ...(lists.network ? { networks: { [SURFACE]: { allowed_users: lists.network } } } : {}),
    agents: { finch: { handles: ['finch'], ...(lists.agent ? { conversation_defaults: { allowed_users: lists.agent } } : {}) } },
  };
  const state = lists.chat ? { contacts: { [SURFACE]: { [CHAT_ID]: { slug: 'c', agents: { finch: { allowed_users: lists.chat } } } } } } : { contacts: {} };
  const router = createRouter({ getAgents: () => config.agents, getConfig: () => config, loadState: async () => state });
  const may = (ev, extra = {}) => mayWake('finch', config.agents.finch, ev, { state, config, ...extra });
  const wakes = async (ev) => (await router.resolve(ev)).targets.map((t) => t.being);
  const refused = async (ev) => ((await router.resolve(ev)).refused ?? []).map((t) => t.being);
  return { config, state, router, may, wakes, refused };
}

describe('the lists join: root ∪ network ∪ agent ∪ chat, in every combination that used to replace', () => {
  const subsets = LEVELS.reduce((all, l) => all.flatMap((s) => [s, [...s, l]]), [[]]);   // all 16
  it.each(subsets.map((s) => [s.join('+') || '(none)', s]))('set at %s: each level\'s own id wakes finch, a stranger never does', async (_name, set) => {
    const w = world(Object.fromEntries(set.map((l) => [l, [IDS[l]]])));
    for (const level of LEVELS) {
      const expected = set.includes(level);
      expect(w.may(lineOf(IDS[level])), `${level} id`).toBe(expected);
      expect(await w.wakes(lineOf(IDS[level])), `${level} id via the router`).toEqual(expected ? ['finch'] : []);
    }
    expect(w.may(lineOf(STRANGER))).toBe(false);
    expect(await w.wakes(lineOf(STRANGER))).toEqual([]);
  });

  it('a new chat\'s seed list joins too', () => {
    const w = world({ root: [ROOT], agent: [AGENT] });
    const seed = { allowed_users: [SEED] };
    for (const id of [ROOT, AGENT, SEED]) expect(w.may(lineOf(id), { seed }), id).toBe(true);
    expect(w.may(lineOf(STRANGER), { seed })).toBe(false);
  });

  it('REPRODUCTION: a lower list never takes the Operator out — each level that replaced now keeps the root owner', async () => {
    for (const level of ['network', 'agent', 'chat']) {
      const w = world({ root: [ROOT], [level]: [IDS[level]] });
      expect(w.may(lineOf(ROOT)), `${level} list set`).toBe(true);
      expect(w.may(lineOf(IDS[level])), `${level} list's own id`).toBe(true);
    }
  });

  it('ownersOf: the node lists joined (the surface\'s first), "*" names nobody; commands authorize the root owner on a surface with its own list', () => {
    const { config } = world({ root: [ROOT, '*'], network: [NET] });
    expect(ownersOf(config, SURFACE)).toEqual([NET, ROOT]);
    expect(ownersOf(config, 'whatsapp')).toEqual([ROOT]);
    expect(ownersOf({}, SURFACE)).toEqual([]);
    expect(isOwner(lineOf(ROOT), config)).toBe(true);
    expect(isOwner(lineOf(NET), config)).toBe(true);
    expect(isOwner(lineOf(STRANGER), config)).toBe(false);
  });
});

describe('[] at any level adds nobody and still admits the root Operator', () => {
  it.each(['network', 'agent', 'chat'])('[] at %s', async (level) => {
    const w = world({ root: [ROOT], [level]: [] });
    expect(w.may(lineOf(ROOT))).toBe(true);
    expect(await w.wakes(lineOf(ROOT))).toEqual(['finch']);
    expect(w.may(lineOf(STRANGER))).toBe(false);
    expect(await w.wakes(lineOf(STRANGER))).toEqual([]);
  });
  it('[] at every level at once', () => {
    const w = world({ root: [], network: [], agent: [], chat: [] });
    expect(w.may(lineOf(STRANGER))).toBe(false);
    expect(w.may(lineOf('acct', '@finch hi', { isSender: true, authorized: true }))).toBe(true);   // the account owner still passes
  });
});

describe('"*" at any level means anyone', () => {
  it.each(LEVELS)('["*"] at %s', async (level) => {
    const w = world({ root: [ROOT], [level]: ['*'] });
    expect(w.may(lineOf(STRANGER))).toBe(true);
    expect(await w.wakes(lineOf(STRANGER))).toEqual(['finch']);
  });
  it('"*" in the root opens beings but does not make a stranger an owner (commands, the stranger rule)', () => {
    const { config } = world({ root: ['*'] });
    expect(ownersOf(config, SURFACE)).toEqual([]);
    expect(isOwner(lineOf(STRANGER), config)).toBe(false);
  });
  it('a stranger stays refused wherever no "*" and no id names it', () => {
    const w = world({ root: [ROOT], network: [NET], agent: [AGENT], chat: [CHAT] });
    expect(w.may(lineOf(STRANGER))).toBe(false);
    expect(w.may(lineOf(null))).toBe(false);
  });
});

describe('a being\'s own line is never the Operator', () => {
  it('isOwner: the flags count for a person only — not the Telegram echo, not a being, not a node\'s frame', () => {
    const config = { conversation_defaults: { allowed_users: [ROOT] } };
    expect(isOwner(lineOf('acct', 'x', { isSender: true }), config)).toBe(true);                    // the account owner typed it
    expect(isOwner(lineOf('op', 'x', { authorized: true }), config)).toBe(true);                    // its bridge authorized the id
    expect(isOwner({ surface: 'room', chatId: 'lobby', senderId: 'operator', authorized: true }, config)).toBe(true);   // the console
    expect(isOwner(lineOf('acct', 'x', { isSender: true, backlog: true }), config)).toBe(true);     // a replayed person's line is still a person's
    expect(isOwner(echoOf(), config)).toBe(false);                                                   // the echo: isSender + authorized + frame + being
    expect(isOwner(lineOf('99', 'x', { isSender: true, authorized: true, fromBeing: 'lark' }), config)).toBe(false);
    expect(isOwner(lineOf('99', 'x', { isSender: true, authorized: true, fromNode: 'nodeB' }), config)).toBe(false);   // another node's frame
    expect(isOwner(lineOf('99', `x${encodeNodeSignature('nodeB', 'ren')}`, { isSender: true, authorized: true }), config)).toBe(false);   // a frame in the text
    expect(isOwner(lineOf('99', 'x', { isSender: true, authorized: true, fromMember: { id: 'm', kind: 'brain' } }), config)).toBe(false);
  });

  it.each([
    ['with no list of its own', {}],
    ['with an id list', { agent: [AGENT] }],
    ['with a chat list', { chat: [CHAT] }],
  ])('a Telegram echo naming a being %s is refused (never the Operator), so the chat is asked', async (_name, lists) => {
    const w = world({ root: [ROOT], network: [NET], ...lists });
    expect(w.may(echoOf())).toBe(false);
    expect(await w.wakes(echoOf())).toEqual([]);
    expect(await w.refused(echoOf())).toEqual(['finch']);   // router `refused` is what spine classify hands to boot's askMention
  });

  it('…unless the being\'s own lists admit the bot ("*"), as before', async () => {
    const w = world({ root: [ROOT], agent: ['*'] });
    expect(w.may(echoOf())).toBe(true);
    expect(await w.wakes(echoOf())).toEqual(['finch']);
    expect(await w.refused(echoOf())).toEqual([]);
  });

  it('LOCK: the same line from a person passes — the Beeper account owner, the Operator by id, the console', async () => {
    const w = world({ root: [ROOT], agent: [AGENT] });
    const beeperOwner = lineOf('@acct:beeper.com', '@finch hola', { surface: 'whatsapp', isSender: true, authorized: true });   // a human typing on the account
    expect(w.may(beeperOwner)).toBe(true);
    expect(await w.wakes(beeperOwner)).toEqual(['finch']);
    expect(w.may(lineOf(ROOT))).toBe(true);
    expect(w.may({ surface: 'room', chatId: 'lobby', senderId: 'operator', authorized: true, body: '@finch hi' })).toBe(true);
  });

  it('a being\'s echo naming a being with NO list used to pass by isSender; now it asks like any refused mention', async () => {
    const w = world({ root: [ROOT] });   // finch states no list
    expect(await w.wakes(echoOf())).toEqual([]);
    expect(await w.refused(echoOf())).toEqual(['finch']);
    expect(w.may(lineOf(ROOT))).toBe(true);
  });
});

describe('configWarnings — a stranger agent needs a "*" somewhere that joins', () => {
  const cfg = (over = {}) => ({ agents: { mk: { handles: [] } }, dispatch: { stranger_agent: { secondary: 'mk' } }, ...over });
  it('warns with no "*", stays quiet with one on the agent or the root', () => {
    expect(configWarnings(cfg()).join('\n')).toMatch(/stranger_agent\.secondary: mk does not allow/);
    expect(configWarnings(cfg({ agents: { mk: { handles: [], conversation_defaults: { allowed_users: ['*'] } } } }))).toEqual([]);
    expect(configWarnings(cfg({ conversation_defaults: { allowed_users: ['*'] } }))).toEqual([]);
  });
});
