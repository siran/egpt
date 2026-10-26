// per-chat-handles.test.mjs — a chat's conversations.yaml entry may set `agents.<being>.handles`
// (operator 2026-10-24): there it REPLACES the being's node-wide handles, `[]` = nothing names it
// there, absent = node-wide as before. kg's E answers to e/egpt/ekg node-wide; in a team chat it
// must answer to `ekg` only, so the team's habitual "e …" (meant for another node's being) stays theirs.
import { describe, it, expect } from 'vitest';
import { createRouter, agentsInChat } from '../src/spine/router.mjs';
import { getBeing } from '../src/conversations-state.mjs';

const ANYONE = { allowed_users: ['*'] };   // the team reaches both
const AGENTS = {
  egpt: { configuration: 'egpt', handles: ['e', 'egpt', 'ekg'], conversation_defaults: ANYONE },
  wren: { configuration: 'egpt', handles: ['w'], conversation_defaults: ANYONE },
};
const TEAM = 'team-tg';
const OTHER = 'other-chat';
const stateWith = (agents) => ({ contacts: { telegram: {
  [TEAM]: { slug: 'team', agents },
  [OTHER]: { slug: 'other', agents: { egpt: { mode: 'mention' } } },
} } });
const ev = (body, chatId = TEAM, over = {}) => ({
  surface: 'telegram', chatId, body, senderId: 'teammate',
  mention: { atEStart: false, atEAnywhere: false, replyToBot: false }, ...over,
});
const routerOn = (state, agents = AGENTS, extra = {}) => createRouter({ getAgents: () => agents, loadState: async () => state, ...extra });
const beings = async (r, e) => (await r.resolve(e)).targets.map((t) => t.being);

describe('per-chat handles: the router', () => {
  const state = stateWith({ egpt: { handles: ['ekg'] } });

  // contract 6.6
  it('REPRODUCE-FIRST: where the entry says handles [ekg], "e hola" addresses nobody and "ekg hola" addresses E', async () => {
    const r = routerOn(state);
    expect(await beings(r, ev('e hola'))).toEqual([]);
    expect(await beings(r, ev('@egpt hola'))).toEqual([]);
    expect(await beings(r, ev('ekg hola'))).toEqual(['egpt']);
    expect(await beings(r, ev('@ekg hola'))).toEqual(['egpt']);
  });

  // contract 6.6
  it('LOCK: every other chat keeps the node-wide handles', async () => {
    const r = routerOn(state);
    expect(await beings(r, ev('e hola', OTHER))).toEqual(['egpt']);
    expect(await beings(r, ev('ekg hola', OTHER))).toEqual(['egpt']);
    expect(await beings(r, ev('e hola', 'no-entry-chat'))).toEqual(['egpt']);
  });

  it('LOCK: the override is one being\'s — another being in the same chat keeps its node-wide handles', async () => {
    expect(await beings(routerOn(state), ev('w hola'))).toEqual(['wren']);
  });

  it('handles [] there: no name addresses E; a quote-reply to E\'s own post still does', async () => {
    const r = routerOn(stateWith({ egpt: { handles: [] } }));
    for (const body of ['e hola', 'egpt hola', 'ekg hola', '@ekg hola']) expect(await beings(r, ev(body)), body).toEqual([]);
    expect(await beings(r, ev('si', TEAM, { replyToBeing: 'egpt' }))).toEqual(['egpt']);
  });

  it('the override drops the being\'s fallback_handle there too (kg\'s live shape: e as a fallback token)', async () => {
    const kg = { egpt: { configuration: 'egpt', handles: ['ekg', 'egptkg'], fallback_handle: { handle: ['e', 'egpt'], unless_present: '+13472576794' }, conversation_defaults: ANYONE } };
    const r = routerOn(state, kg, { isPresent: async () => false });
    expect(await beings(r, ev('e hola'))).toEqual([]);
    expect(await beings(r, ev('ekg hola'))).toEqual(['egpt']);
    expect(await beings(r, ev('egptkg hola'))).toEqual([]);
    expect(await beings(r, ev('e hola', OTHER))).toEqual(['egpt']);   // elsewhere the fallback still wakes it
  });

  it('a tunnelled line uses the ARRIVAL chat\'s handles (ev.origin), not the room it re-enters', async () => {
    const r = routerOn(state);
    const tunnelled = (body) => ev(body, 'lobby', { surface: 'room', origin: { surface: 'telegram', chatId: TEAM } });
    expect(await beings(r, tunnelled('e hola'))).toEqual([]);
    expect(await beings(r, tunnelled('ekg hola'))).toEqual(['egpt']);
  });

  it('agentsIn(ev) is the same view, for the command parser', async () => {
    const r = routerOn(state);
    expect((await r.agentsIn(ev('x'))).egpt.handles).toEqual(['ekg']);
    expect(await r.agentsIn(ev('x', OTHER))).toBe(AGENTS);
    expect(await createRouter({ getAgents: () => AGENTS }).agentsIn(ev('x'))).toBe(AGENTS);
  });
});

describe('per-chat handles: agentsInChat + getBeing', () => {
  it('no override (or no state) → the very same map object, so callers are unchanged', () => {
    const st = stateWith({ egpt: { mode: 'on' } });
    expect(agentsInChat(AGENTS, st, 'telegram', TEAM)).toBe(AGENTS);
    expect(agentsInChat(AGENTS, null, 'telegram', TEAM)).toBe(AGENTS);
    expect(agentsInChat(AGENTS, { contacts: {} }, 'telegram', TEAM)).toBe(AGENTS);
  });

  it('an override replaces handles on a copy; the node registry is not touched', () => {
    const st = stateWith({ egpt: { handles: ['ekg'] } });
    const here = agentsInChat(AGENTS, st, 'telegram', TEAM);
    expect(here).not.toBe(AGENTS);
    expect(here.egpt).toEqual({ configuration: 'egpt', handles: ['ekg'], conversation_defaults: ANYONE });
    expect(here.wren).toBe(AGENTS.wren);
    expect(AGENTS.egpt.handles).toEqual(['e', 'egpt', 'ekg']);
  });

  it('getBeing reports the raw per-chat handles; null when the block states none', () => {
    const st = stateWith({ egpt: { handles: ['ekg'] } });
    expect(getBeing(st, 'telegram', TEAM, 'egpt').handles).toEqual(['ekg']);
    expect(getBeing(st, 'telegram', OTHER, 'egpt').handles).toBeNull();
  });
});
