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
const SIG_KG = encodeNodeSignature('kg');
const SIG_DO = encodeNodeSignature('do');
// boot.mjs's undelivered notice as kg posted it in eGPT Admin, 2026-11-21 13:46 (🏰: kg's visible close).
const NOTICE = 'kg · ⚠ reply (egpt) not delivered to 89xiq… — POST … → 401 {"message":"Token expired",…} 🏰';

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

describe('a framed line addressed at its start wakes that being (operator 2026-11-21)', () => {
  it("REPRODUCE: 'w why does this happen?' over a pasted kg node line wakes wren", async () => {
    for (const mode of ['mention', 'mention-direct', 'on']) {
      const { spine, brain } = buildSpine({ mode });
      await spine.handleInbound({ body: `w why does this happen?\n\n${NOTICE}${SIG_KG}`, from: from({ msgKey: `paste-${mode}`, isSender: true, senderName: 'An' }) });
      expect(woke(brain), mode).toEqual(['wren']);
    }
  });

  it("LOCK: kg's own node notice wakes nobody", async () => {
    for (const mode of ['mention', 'on']) {
      const { spine, brain, transcript } = buildSpine({ mode });
      await spine.handleInbound({ body: `${NOTICE}${SIG_KG}`, from: from({ msgKey: `notice-${mode}`, isSender: true }) });
      expect(woke(brain), mode).toEqual([]);
      expect(transcript.logged.at(-1)?.body).toBe(`${NOTICE}<kg>`);
    }
  });

  it("LOCK: a being's own line addressed to itself wakes nobody", async () => {
    for (const body of [`🐦 wren: w nota${SIG_KG_W}`, `w nota${SIG_KG_W}`]) {
      const { spine, brain } = buildSpine({ mode: 'mention' });
      await spine.handleInbound({ body, from: from({ msgKey: 'self-w' }) });
      expect(woke(brain), body).toEqual([]);
    }
  });

  it('LOCK: a kg node line naming a being mid-text wakes nobody', async () => {
    for (const body of [`${NOTICE} — @wren mira${SIG_KG}`, `aviso: w revisa esto${SIG_KG}`]) {
      const { spine, brain } = buildSpine({ mode: 'mention' });
      await spine.handleInbound({ body, from: from({ msgKey: 'mid-kg', isSender: true }) });
      expect(woke(brain), body).toEqual([]);
    }
  });

  it("LOCK: a peer node's line addressed at its start wakes the being", async () => {
    for (const body of [`w revisa esto${SIG_DO}`, `@wren revisa esto${SIG_DO_DON}`]) {
      const { spine, brain } = buildSpine({ mode: 'mention' });
      await spine.handleInbound({ body, from: from({ msgKey: 'peer-w', isSender: true }) });
      expect(woke(brain), body).toEqual(['wren']);
    }
  });

  it('kg node lines addressing w and e in turn stop at loop_guard.inbound', async () => {
    const g = createStopGuard({ turns: 4 });
    const { spine, brain } = buildSpine({ mode: 'mention', guard: g });
    for (let i = 0; i < 6; i++) {
      await spine.handleInbound({ body: `${i % 2 ? 'e' : 'w'} turno ${i}${SIG_KG}`, from: from({ msgKey: `nl${i}`, isSender: true }) });
    }
    expect(g.blocked('whatsapp:c')).toBe(true);
    expect(woke(brain)).toEqual(['wren', 'egpt', 'wren', 'egpt']);
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
