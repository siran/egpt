// addressing-view.test.mjs — the router addresses the WORDS of a line, not what sits before them
// (operator 2026-11-04: "there is no reason a bot shouldn't answer a @mention or a 'e ' starting line
// just because of signature or opening, or even white characters"). The persona stamp ("🐶 E: "),
// the node frame and leading invisible characters are skipped for addressing only; the recorded
// text keeps them.
//
// Harness: the REAL spine + identity + router + gating, as tests/clean-ingest.test.mjs builds it.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';

const ANYONE = { allowed_users: ['*'] };
const AGENTS = {
  egpt: { name: 'E', body_emoji: '🐶', handles: ['e', 'egpt'], conversation_defaults: ANYONE },
  wren: { name: 'wren', body_emoji: '🐦', handles: ['wren', 'w'], conversation_defaults: ANYONE },
};
const fromThisNode = (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'kg';
const SIG_KG_E = encodeNodeSignature('kg', 'egpt');
const SIG_KG_W = encodeNodeSignature('kg', 'wren');
const SIG_DO_DON = encodeNodeSignature('do', 'don');

function buildSpine({ mode = 'mention', guard = null } = {}) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body }); return { text: 'x' }; } };
  const identity = createIdentity({ now: () => 1000 });
  const config = { dispatch: { auto_default_mode: mode } };
  const router = createRouter({ getAgents: () => AGENTS, getConfig: () => config });
  const gating = createGating({ getConfig: () => config, loadState: null });
  const transcript = { logged: [], async log(ev) { this.logged.push(ev); } };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain, identity, router, gating, sender, transcript,
    heartbeats: { runDue() {} }, mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode, guard, isSelfChat: () => false, clock: { now: () => 1000 },
  });
  return { spine, brain, transcript };
}
const from = (over = {}) => ({ chatId: 'c', chatName: 'admin', network: 'whatsapp', userId: 'u', senderName: 'x', msgKey: 'm1', ...over });
const woke = (brain) => brain.calls.map((c) => c.being);

describe('addressing view — a being wakes a being by an ordinary mention', () => {
  it("E's stamped line 'w please look at X' wakes wren", async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: `🐶 E: w please look at X${SIG_KG_E}`, from: from({ msgKey: 'e-1' }) });
    expect(woke(brain)).toEqual(['wren']);
  });

  it("E's stamped line '@wren …' wakes wren in a mention-direct chat", async () => {
    const { spine, brain } = buildSpine({ mode: 'mention-direct' });
    await spine.handleInbound({ body: `🐶 E: @wren please look at X${SIG_KG_E}`, from: from({ msgKey: 'e-2' }) });
    expect(woke(brain)).toEqual(['wren']);
  });
});

describe('addressing view — leading whitespace, invisible characters and a leading frame', () => {
  for (const [label, lead] of [['zero-width space', '​'], ['word joiner + spaces', ' ⁠ '], ['LRM + ZWNJ', '‎‌']]) {
    it(`a human line with a leading ${label} before 'e hola' wakes E (mention-direct)`, async () => {
      const { spine, brain } = buildSpine({ mode: 'mention-direct' });
      await spine.handleInbound({ body: `${lead}e hola`, from: from({ msgKey: `h-${label}`, senderName: 'Bob' }) });
      expect(woke(brain)).toEqual(['egpt']);
    });
  }

  it("a line that opens with an invisible signature frame and then 'e …' wakes E", async () => {
    const { spine, brain } = buildSpine({ mode: 'mention-direct' });
    await spine.handleInbound({ body: `${SIG_DO_DON}e ¿lo ves?`, from: from({ msgKey: 'don-1' }) });
    expect(woke(brain)).toEqual(['egpt']);
  });
});

describe('addressing view — a person\'s line that STARTS with a handle wakes that being, whatever frame it carries', () => {
  // Live 2026-11-13: An pasted E's own post (stamp … frame) after "e mira esto:". The frame names E as author.
  const pasted = `🐶 E: hola${SIG_KG_E}`;
  for (const lead of ['e mira esto', '@egpt mira esto']) {
    it(`'${lead}: "<E's post>"' wakes E even though the pasted frame names E as author`, async () => {
      const { spine, brain } = buildSpine({ mode: 'mention' });
      await spine.handleInbound({ body: `${lead}: "${pasted}"\n`, from: from({ msgKey: 'paste-1', senderName: 'An' }) });
      expect(woke(brain)).toEqual(['egpt']);
    });
  }

  it('LOCK: own echo with the frame LEADING (`<kg>` before the stamp) and its own handle after the stamp never wakes its author', async () => {
    for (const body of [`${SIG_KG_E}🐶 E: e hola`, `${SIG_KG_E}🐶 E: @egpt hola`]) {
      const { spine, brain } = buildSpine({ mode: 'mention' });
      await spine.handleInbound({ body, from: from({ msgKey: 'lead-frame' }) });
      expect(woke(brain)).toEqual([]);
    }
  });

  it('LOCK: the handle in the MIDDLE of a signed line is still author-excluded', async () => {
    const { spine, brain } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: `mira @egpt esto: "${pasted}"\n`, from: from({ msgKey: 'paste-2', senderName: 'An' }) });
    expect(woke(brain)).toEqual([]);
  });

  it('LOCK: a peer node\'s signed line that addresses nobody still prompts nobody', async () => {
    const { spine, brain } = buildSpine({ mode: 'on' });
    await spine.handleInbound({ body: `🐶 don: hola a todos${SIG_DO_DON}`, from: from({ msgKey: 'peer-1' }) });
    expect(woke(brain)).toEqual([]);
  });
});

describe('addressing view — regression locks', () => {
  it("E's own handle in its own stamped line never wakes E", async () => {
    for (const body of [`🐶 E: e hola${SIG_KG_E}`, `🐶 E: @egpt hola${SIG_KG_E}`]) {
      const { spine, brain } = buildSpine({ mode: 'mention' });
      await spine.handleInbound({ body, from: from({ msgKey: 'self' }) });
      expect(woke(brain)).toEqual([]);
    }
  });

  it('an unaddressed stamped, signed line only records — stamp and signature kept', async () => {
    const { spine, brain, transcript } = buildSpine({ mode: 'on' });
    await spine.handleInbound({ body: `🐶 E: terminé la tarea${SIG_KG_E}`, from: from({ msgKey: 'e-rec' }) });
    expect(woke(brain)).toEqual([]);
    expect(transcript.logged.at(-1)?.body).toBe('🐶 E: terminé la tarea<kg>');
  });

  it('the recorded and prompted text of an addressed stamped line keeps the stamp and signature', async () => {
    const { spine, brain, transcript } = buildSpine({ mode: 'mention' });
    await spine.handleInbound({ body: `🐶 E: w please look at X${SIG_KG_E}`, from: from({ msgKey: 'e-keep' }) });
    expect(transcript.logged.at(-1)?.body).toBe('🐶 E: w please look at X<kg>');
    expect(brain.calls[0]?.body).toBe('🐶 E: w please look at X<kg>');
  });

  it('E↔wren ping-pong trips loop_guard.inbound', async () => {
    const g = createStopGuard({ turns: 4 });
    const { spine } = buildSpine({ mode: 'mention', guard: g });
    for (let i = 0; i < 4; i++) {
      const body = i % 2 ? `🐦 wren: e turno ${i}${SIG_KG_W}` : `🐶 E: w turno ${i}${SIG_KG_E}`;
      await spine.handleInbound({ body, from: from({ msgKey: `pp${i}` }) });
    }
    expect(g.blocked('whatsapp:c')).toBe(true);
  });

  it('a human mid-sentence bare handle still does not address; a mid-sentence @handle is not a direct one', async () => {
    for (const [mode, body, want] of [
      ['mention', 'hola e cómo estás', []],
      ['mention-direct', 'hola @e cómo estás', []],
      ['mention', 'hola @e cómo estás', ['egpt']],
      ['mention-direct', '😀 hola e', []],
    ]) {
      const { spine, brain } = buildSpine({ mode });
      await spine.handleInbound({ body, from: from({ msgKey: `mid-${mode}-${body}`, senderName: 'Bob' }) });
      expect(woke(brain), `${mode}: ${body}`).toEqual(want);
    }
  });

  it("quoted-reply addressing is unchanged: a reply to E's post wakes E; a stamped reply from wren too", async () => {
    const a = buildSpine({ mode: 'mention-direct' });
    await a.spine.handleInbound({ body: 'gracias', from: from({ msgKey: 'q-1', senderName: 'Bob', replyToBeing: 'egpt' }) });
    expect(woke(a.brain)).toEqual(['egpt']);
    const b = buildSpine({ mode: 'mention-direct' });
    await b.spine.handleInbound({ body: `🐦 wren: hecho${SIG_KG_W}`, from: from({ msgKey: 'q-2', replyToBeing: 'egpt' }) });
    expect(woke(b.brain)).toEqual(['egpt']);
  });

  it("a command line ('/e …') addresses no being in the router, as today", async () => {
    const router = createRouter({ getAgents: () => AGENTS, getConfig: () => ({}) });
    for (const body of ['/e status', ' /e split viaje', '/w ping']) {
      expect((await router.resolve({ surface: 'whatsapp', chatId: 'c', senderId: 'u', body })).targets).toEqual([]);
    }
  });
});
