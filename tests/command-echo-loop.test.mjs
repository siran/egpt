// command-echo-loop.test.mjs — the 2026-07-25 LIVE INCIDENT lock: two nodes on one Beeper
// account traded hundreds of messages, one colon per hop, until the service was killed.
//
// The mechanism, verbatim from the transcript:
//   #175483: /status do
//   #175484: /status: "do" matches 9: …            <- the ambiguity reply, itself a command
//   #175486: /status:: recognized — …              <- the catch-all echoes the token + a colon
//   #175488: /status::: recognized — …             <- …and the peer node answers that
//
// TWO defects, locked separately here:
//   (A) a command reply that itself PARSES as a command (isCommand admits any operator line
//       starting with '/'), so our own output re-enters as a new command;
//   (B) commands returned from classify BEFORE the guard block, so the loop was unbounded —
//       a STOPped channel kept answering commands, and STOP could not end the flood.
import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/spine/commands.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createStopGuard } from '../src/stop-guard.mjs';
import { emptyState, ensureContact } from '../src/conversations-state.mjs';

// A profile whose contacts make "do" AMBIGUOUS — the live seed (`do` matched 9 chats).
function ambiguousState() {
  let st = emptyState();
  for (let i = 1; i <= 9; i++) {
    st = ensureContact(st, 'whatsapp', `!do${i}`, { pushedName: `do-chat-${i}`, slugHint: `do-chat-${i}` }).state;
  }
  return st;
}

function commandsHarness({ state = null } = {}) {
  const sent = [];
  const cmds = createCommands({
    getConfig: () => ({ whatsapp: { chat_id: '!self' } }),
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: () => {},
    loadState: state ? async () => state : null,
    writeState: state ? async () => {} : null,
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
  });
  // ONE hop of the live loop: a message lands in the operator's Self DM; if the node treats
  // it as a command it answers, and THAT answer is what the peer node sees next.
  const hop = async (body) => {
    const ev = { body, chatId: '!self', surface: 'whatsapp' };
    if (!cmds.isCommand(ev)) return null;      // not a command → no command reply → loop dies
    const before = sent.length;
    await cmds.run(ev);
    return sent.length > before ? sent.at(-1).text : null;
  };
  return { cmds, sent, hop };
}

describe('(A) a command reply never parses as a command', () => {
  // PRE-FIX this test failed on the second hop with, verbatim:
  //   hop 2 → "/status:: recognized — lifecycle (/restart, /upgrade, /rewind) + /e auto <mode>
  //            + /status are wired in v2 so far."
  // and then ran forever, one colon per hop.
  it('the /status ambiguity reply (the live seed) does not feed itself', async () => {
    const { hop } = commandsHarness({ state: ambiguousState() });
    const seed = await hop('/status do');
    expect(seed).toMatch(/matches 9/);              // the ambiguity reply, unchanged in substance
    expect(seed.startsWith('/')).toBe(false);       // …but it can no longer BE a command
    expect(await hop(seed)).toBeNull();             // the peer node has nothing to answer
  });

  it('the catch-all reply to an unrecognized /foo does not feed itself', async () => {
    const { hop } = commandsHarness();
    const first = await hop('/foo');
    expect(first).toMatch(/recognized/);
    expect(first.startsWith('/')).toBe(false);
    expect(await hop(first)).toBeNull();
  });

  // The loop as it actually ran: feed every reply straight back in. It must die on hop 2.
  it('the two-node echo terminates instead of escalating', async () => {
    const { hop } = commandsHarness({ state: ambiguousState() });
    let body = '/status do', hops = 0;
    while (body && hops < 50) { body = await hop(body); hops++; }
    expect(hops).toBe(2);                            // seed answered, its reply answered nothing
  });

  // The CLASS, not the two known offenders: every operator-facing reply this module can emit
  // is checked at the one reply chokepoint, so a message added later cannot reopen the hole.
  it('no reply from any command path begins with a slash', async () => {
    const state = ambiguousState();
    const { cmds, sent } = commandsHarness({ state });
    const lines = [
      '/status do',                 // /status target: ambiguous
      '/status zzz',                // /status target: no match
      '/agents e auto loud',        // /agents ... auto: unknown mode
      '/agents=zzz e auto on',      // /agents=<slug>: unresolvable target
      '/agents',                    // bare /agents usage reply (no handle)
      '/agents e badsub',           // /agents ...: unknown subcommand
      '/e do',                      // /e carries no special meaning any more — generic catch-all
      '/e zzz',                     // /e carries no special meaning any more — generic catch-all
      '/chrome',                    // /chrome usage line
      '/room x badverb',            // /room: unknown subcommand
      '/unmapped-command',          // the catch-all
    ];
    for (const body of lines) await cmds.run({ body, chatId: '!self', surface: 'whatsapp' });
    expect(sent.length).toBeGreaterThanOrEqual(lines.length);
    for (const s of sent) {
      expect(s.text.startsWith('/'), `reply must not start with '/': ${s.text}`).toBe(false);
      expect(cmds.isCommand({ body: s.text, chatId: '!self', surface: 'whatsapp' })).toBe(false);
    }
  });
});

// --- (B) the spine chokepoint: a command turn is guarded like any other turn --------------
function buildSpine({ guard, stopSwitch = null, isCommand = (ev) => String(ev.body ?? '').startsWith('/') } = {}) {
  const ran = [];
  const bridge = { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false };
  const brain = { async turn() { return { text: 'x' }; } };
  const identity = { build: (msg) => ({ ...msg }) };
  const router = { resolve: () => 'e' };
  const gating = { async decide() { return { mode: 'on', receives: true, mayReply: false, sendToEgpt: 'mode' }; }, surfaces: () => false };
  const transcript = { logged: [], async log(ev) { this.logged.push(ev); } };
  const heartbeats = { runDue() {} };
  const sender = { open() { return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const commands = { isCommand, run: async (ev) => { ran.push(ev.body); } };
  // Every message below is the operator's Self DM (opCmd: chatId 'self'), which is where the
  // safe word lives since 2026-07-26 — so the Self predicate boot wires is modelled here as
  // "chatId is 'self'". Anywhere else "stop" is ordinary text (tests/stop-file.test.mjs (D)).
  const spine = createSpine({ bridge, brain, identity, router, gating, sender, transcript, heartbeats, commands, guard, stopSwitch, isSelfChat: (ev) => ev?.chatId === 'self', clock: { now: () => 1000 } });
  return { spine, ran, transcript };
}
// The boot-wired kill switch, faked: records what would have been written to EGPT_HOME/STOP
// before boot's exit(0). tests/stop-file.test.mjs owns the real file + exit contract.
const fakeSwitch = (pulls) => ({ present: () => false, pull: (why) => pulls.push(why) });

// The operator's Self DM. `fromBrain` is the provenance the room relay stamps on our OWN
// output when it re-enters — a NON-human turn, exactly what a command echo is.
const opCmd = (body, extra = {}) => ({ surface: 'wa', chatId: 'self', chatName: 'self', senderName: 'An', isSender: true, authorized: true, msgId: null, body, kind: 'text', raw: {}, ...extra });
const echoed = (body) => opCmd(body, { fromBrain: 'chatgpt' });

describe('(B) command turns pass through the loop guard', () => {
  it('a burst of non-human command turns trips the guard; further commands are suppressed', async () => {
    const guard = createStopGuard({ turns: 3 });
    const { spine, ran } = buildSpine({ guard });
    for (let i = 0; i < 6; i++) await spine.handleInbound(echoed('/status'));
    expect(ran).toHaveLength(3);                 // the 3rd trips and still runs; the rest never do
    expect(guard.blocked('wa:self')).toBe(true);
  });

  it('a genuinely typed operator command burst never trips it (provenance resets)', async () => {
    const guard = createStopGuard({ turns: 3 });
    const { spine, ran } = buildSpine({ guard });
    for (let i = 0; i < 10; i++) await spine.handleInbound(opCmd('/status'));
    expect(ran).toHaveLength(10);
    expect(guard.blocked('wa:self')).toBe(false);
  });

  // THE ASSERTION THAT MATTERS MOST: a guard that can strand the operator is worse than the
  // bug. Lifecycle + the safe-word are the recovery path and stay reachable with the channel
  // stopped — that is what makes the guard above safe to have at all.
  it('/restart and the STOP/RESUME safe-word still work with the guard tripped', async () => {
    const guard = createStopGuard({ turns: 3 });
    const { spine, ran } = buildSpine({ guard });
    for (let i = 0; i < 6; i++) await spine.handleInbound(echoed('/status'));
    expect(guard.blocked('wa:self')).toBe(true);

    await spine.handleInbound(opCmd('/restart'));
    expect(ran).toContain('/restart');           // recovery always lands
    await spine.handleInbound(opCmd('/upgrade'));
    await spine.handleInbound(opCmd('/rewind abc123'));
    expect(ran).toContain('/upgrade');
    expect(ran).toContain('/rewind abc123');

    const statusRuns = () => ran.filter((b) => b === '/status').length;
    const before = statusRuns();                 // the 3 that ran before the guard tripped
    await spine.handleInbound(opCmd('/status'));
    expect(statusRuns()).toBe(before);           // …while ordinary commands stay suppressed

    await spine.handleInbound(opCmd('RESUME'));  // the operator's way back
    expect(guard.blocked('wa:self')).toBe(false);
    await spine.handleInbound(opCmd('/status'));
    expect(statusRuns()).toBe(before + 1);
  });

  // The incident's missing recovery: mid-flood the operator types STOP. Before 2026-07-25 STOP
  // did not stop commands at all — killing the service was the only way out. It IS that now
  // (operator: "stop, stops egpt service point blank"): it pulls the kill switch, so the flood
  // ends by construction — exit(0), which the daemon does not respawn.
  it('STOP ends a command flood — it pulls the kill switch', async () => {
    const guard = createStopGuard({ turns: -1 });   // counter disabled: STOP alone must bound it
    const pulls = [];
    const { spine, ran } = buildSpine({ guard, stopSwitch: fakeSwitch(pulls) });
    await spine.handleInbound(opCmd('/status'));
    await spine.handleInbound(opCmd('STOP'));
    expect(pulls).toHaveLength(1);                 // the whole service goes down
    expect(ran).toEqual(['/status']);              // STOP itself never ran as a command
  });

  // An armed `/e` wizard makes isCommand true for ANY operator line, which used to swallow a
  // bare STOP — the one word that must always land.
  it('STOP lands even while an /e wizard is armed (isCommand claims every line)', async () => {
    const guard = createStopGuard({ turns: 6 });
    const pulls = [];
    const { spine, ran } = buildSpine({ guard, stopSwitch: fakeSwitch(pulls), isCommand: () => true });
    await spine.handleInbound(opCmd('STOP'));
    expect(pulls).toHaveLength(1);
    expect(ran).toHaveLength(0);                  // never swallowed by the wizard
  });

  // C1.2: a suppressed command is still RECORDED — the record stays complete.
  it('a suppressed command is still transcript-logged', async () => {
    const guard = createStopGuard({ turns: 1 });   // the first non-human command turn stops the channel
    const { spine, transcript } = buildSpine({ guard });
    await spine.handleInbound(echoed('/status'));  // trips the counter
    await spine.handleInbound(opCmd('/status'));   // suppressed…
    expect(guard.blocked('wa:self')).toBe(true);
    expect(transcript.logged.map((e) => e.body)).toEqual(['/status', '/status']);   // …but recorded
  });
});
