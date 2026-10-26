// A being answers only its owners by default (operator 2026-10-26: "E must only listen to its owner
// by default"; "join networks.telegram.allowed_users into conversation_defaults.allowed_users").
// Rungs for who may wake a being: the chat's list → agents.<b>.conversation_defaults.allowed_users →
// [owner], where `owner` = networks.<surface>.allowed_users ?? the node's conversation_defaults
// .allowed_users ?? nobody. ['*'] anyone, [] nobody, explicit ids as written.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { createRouter, mayWake, ownersOf, isOwner, isKnownSender, configWarnings } from '../src/spine/router.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AN = '@an:beeper.com';
const TG_AN = '5551234';
const STRANGER = '@whatsapp_lid-999:beeper.local';

const line = (senderId, body, over = {}) => ({
  surface: 'whatsapp', chatId: '!dm', body, senderId, isSender: false, authorized: false,
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false }, raw: { chatType: 'private' }, ...over,
});
const group = (senderId, body, over = {}) => line(senderId, body, { chatId: '!grp', raw: { chatType: 'group' }, ...over });
const woken = async (router, ev) => (await router.resolve(ev)).targets.map((t) => t.being);
const routerOf = (config, state = null) => createRouter({ getAgents: () => config.agents, getConfig: () => config, ...(state ? { loadState: async () => state } : {}) });

describe('ownersOf — the one owner list (commands and beings)', () => {
  const cfg = { conversation_defaults: { allowed_users: [AN, TG_AN] }, networks: { whatsapp: { chat_ids: [] }, telegram: { allowed_users: ['tg-only'] } } };
  it('a surface with no list of its own uses the node list; one with a list uses only its own', () => {
    expect(ownersOf(cfg, 'whatsapp')).toEqual([AN, TG_AN]);
    expect(ownersOf(cfg, 'googlevoice')).toEqual([AN, TG_AN]);
    expect(ownersOf(cfg, 'telegram')).toEqual(['tg-only']);
  });
  it('no list anywhere = nobody; "*" and `owner` name nobody in it', () => {
    expect(ownersOf({}, 'whatsapp')).toEqual([]);
    expect(ownersOf({ conversation_defaults: { allowed_users: ['*', 'owner', AN] } }, 'whatsapp')).toEqual([AN]);
  });
  it('the legacy top-level <surface>: block still overrides, as boot read it', () => {
    expect(ownersOf({ conversation_defaults: { allowed_users: [AN] }, whatsapp: { allowed_users: ['old'] } }, 'whatsapp')).toEqual(['old']);
  });
  it('isKnownSender counts the node list (the stranger rule)', () => {
    expect(isKnownSender(AN, { conversation_defaults: { allowed_users: [AN] } })).toBe(true);
    expect(isKnownSender(STRANGER, { conversation_defaults: { allowed_users: [AN] } })).toBe(false);
  });
});

describe('isOwner', () => {
  const cfg = { conversation_defaults: { allowed_users: [AN] } };
  it('an id on the list, the account owner, the authenticated console are owners; a stranger is not', () => {
    expect(isOwner(line(AN, 'x'), cfg)).toBe(true);
    expect(isOwner(line('@me:beeper.com', 'x', { isSender: true }), {})).toBe(true);
    expect(isOwner({ surface: 'room', chatId: 'lobby', senderId: 'operator', authorized: true }, {})).toBe(true);
    expect(isOwner(line(STRANGER, 'x'), cfg)).toBe(false);
  });
  it('a tunnelled line is judged on the surface it ARRIVED on', () => {
    const tunnelled = { surface: 'room', chatId: 'acim', senderId: AN, authorized: false, origin: { surface: 'whatsapp', chatId: '!grp' } };
    expect(isOwner(tunnelled, { networks: { whatsapp: { allowed_users: [AN] } } })).toBe(true);
    expect(isOwner({ ...tunnelled, origin: undefined }, { networks: { whatsapp: { allowed_users: [AN] } } })).toBe(false);
  });
});

describe('mayWake — the rungs, nearest first', () => {
  const base = { conversation_defaults: { allowed_users: [AN] }, networks: { telegram: { allowed_users: [TG_AN] } } };
  const state = (list) => ({ contacts: { whatsapp: { '!dm': { slug: 'dm', agents: { e: { allowed_users: list } } } } } });
  const may = (agent, ev, { config = base, st = null } = {}) => mayWake('e', agent, ev, { state: st, config });

  it('no list at either tier → the owners only', () => {
    expect(may({}, line(AN, 'x'))).toBe(true);
    expect(may({}, line(STRANGER, 'x'))).toBe(false);
    expect(may({}, line(AN, 'x'), { config: {} })).toBe(false);   // no owners configured: nobody
  });
  it('networks.<surface>.allowed_users replaces the node list for its surface', () => {
    expect(may({}, line(TG_AN, 'x', { surface: 'telegram' }))).toBe(true);
    expect(may({}, line(AN, 'x', { surface: 'telegram' }))).toBe(false);
  });
  it('the agent list beats the owners; the chat list beats the agent list', () => {
    const agent = { conversation_defaults: { allowed_users: [STRANGER] } };
    expect(may(agent, line(STRANGER, 'x'))).toBe(true);
    expect(may(agent, line(AN, 'x'))).toBe(false);
    expect(may(agent, line(STRANGER, 'x'), { st: state(['friend']) })).toBe(false);
    expect(may(agent, line('friend', 'x'), { st: state(['friend']) })).toBe(true);
  });
  it('[owner] = the owners; [owner, id] adds that id; [owner] with no owners = nobody but the account owner', () => {
    const owner = { conversation_defaults: { allowed_users: ['owner'] } };
    const plus = { conversation_defaults: { allowed_users: ['owner', 'x'] } };
    expect(may(owner, line(AN, 'h'))).toBe(true);
    expect(may(owner, line('x', 'h'))).toBe(false);
    expect(may(plus, line('x', 'h'))).toBe(true);
    expect(may(plus, line(AN, 'h'))).toBe(true);
    expect(may(plus, line(STRANGER, 'h'))).toBe(false);
    expect(may(owner, line(AN, 'h'), { config: {} })).toBe(false);
    expect(may(owner, line('@me', 'h', { isSender: true }), { config: {} })).toBe(true);
  });
  it('REGRESSION LOCKS: ["*"] anyone, [] nobody, ids as written (an owner not on an id list is refused)', () => {
    expect(may({ conversation_defaults: { allowed_users: ['*'] } }, line(STRANGER, 'h'))).toBe(true);
    expect(may({ conversation_defaults: { allowed_users: [] } }, line(AN, 'h', { authorized: true }))).toBe(false);
    expect(may({ conversation_defaults: { allowed_users: ['boss'] } }, line('boss', 'h'))).toBe(true);
    expect(may({ conversation_defaults: { allowed_users: ['boss'] } }, line(AN, 'h', { authorized: true }))).toBe(false);
    expect(may({}, line(STRANGER, 'h'), { st: state(['*']) })).toBe(true);
  });
});

describe('the router — E with [owner]', () => {
  const config = { conversation_defaults: { allowed_users: [AN] }, agents: { egpt: { handles: ['e'], conversation_defaults: { allowed_users: ['owner'] } } } };
  // contract 7.5
  it('the owner wakes it in a DM and in a group; a stranger does not, in either', async () => {
    const r = routerOf(config);
    expect(await woken(r, line(AN, 'e hola'))).toEqual(['egpt']);
    expect(await woken(r, group(AN, 'e hola'))).toEqual(['egpt']);
    expect(await woken(r, line(STRANGER, 'e hola'))).toEqual([]);
    expect(await woken(r, group(STRANGER, 'e hola'))).toEqual([]);
  });
  it('the same with no list at all (the default)', async () => {
    const r = routerOf({ ...config, agents: { egpt: { handles: ['e'] } } });
    expect(await woken(r, group(AN, 'e hola'))).toEqual(['egpt']);
    expect(await woken(r, group(STRANGER, 'e hola'))).toEqual([]);
  });
});

describe('a fresh profile seeded from the skeleton', () => {
  const skeleton = YAML.parse(readFileSync(join(ROOT, 'config', 'skeletons', 'config.yaml'), 'utf8'));
  it('ships the node owner list at the top level, and no networks.* list overriding it', () => {
    expect(skeleton.conversation_defaults).toEqual({ allowed_users: [] });
    for (const n of Object.values(skeleton.networks)) expect(n).not.toHaveProperty('allowed_users');
  });
  it('its egpt answers neither a stranger nor a listed-nowhere sender; the account owner, yes', async () => {
    const r = routerOf(skeleton);
    expect(await woken(r, line(STRANGER, 'e hola'))).toEqual([]);
    expect(await woken(r, group(STRANGER, 'e hola'))).toEqual([]);
    expect(await woken(r, line('@me:beeper.com', 'e hola', { isSender: true, authorized: true }))).toEqual(['egpt']);
  });
  it('once the owner adds an id, that id wakes egpt', async () => {
    const r = routerOf({ ...skeleton, conversation_defaults: { allowed_users: [AN] } });
    expect(await woken(r, line(AN, 'e hola'))).toEqual(['egpt']);
    expect(await woken(r, line(STRANGER, 'e hola'))).toEqual([]);
  });
  it('wren (access_level all) states its list, so brainpool runs it', () => {
    expect(skeleton.agents.wren.conversation_defaults).toMatchObject({ access_level: 'all', allowed_users: ['owner'] });
  });
});

describe('configWarnings — a stranger agent that does not allow anyone', () => {
  it('warns, since a stranger then reaches nobody', () => {
    const cfg = (cd) => ({ agents: { mk: { handles: [], ...(cd ? { conversation_defaults: cd } : {}) } }, dispatch: { stranger_agent: { secondary: 'mk' } } });
    expect(configWarnings(cfg(null)).join('\n')).toMatch(/dispatch\.stranger_agent\.secondary: mk does not allow \['\*'\]/);
    expect(configWarnings(cfg({ allowed_users: ['*'] }))).toEqual([]);
  });
});
