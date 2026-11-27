// reply-actions-msg.test.mjs — a being's "/<handle> msg <chat> <text>" (or a bare "/msg") is a reply ACTION, like /reply:
// parsed out of the reply, its text running on to the next action or the end, stripped from the prose, never half-shown
// while streaming. It is switched on by the being's handles (opts.handles); without them it is plain prose, as before.
import { describe, it, expect } from 'vitest';
import { parseReplyActions, partialProse, createReplyActions } from '../src/spine/reply-actions.mjs';

const EV = { surface: 'whatsapp', chatId: 'c1' };
const OPTS = { handles: ['e', 'egpt'] };
const parse = (t, o = OPTS) => parseReplyActions(t, EV, o);

describe('/msg as a parsed action', () => {
  it('prose + two msg lines + a /reply: three actions, the prose kept', () => {
    const r = parse('On it.\n/e msg Daniel hola\n/egpt msg "Quiet Room" otra cosa\n/reply #5 listo');
    expect(r.prose).toBe('On it.');
    expect(r.run).toEqual([
      { type: 'msg', chatId: 'c1', target: 'Daniel', text: 'hola' },
      { type: 'msg', chatId: 'c1', target: 'Quiet Room', text: 'otra cosa' },
      { type: 'reply', chatId: 'c1', targetId: '5', text: 'listo' },
    ]);
    expect(r.stripped).toEqual([]);
  });

  it('the text runs on over the lines below, to the next action or the end, line breaks kept', () => {
    const r = parse('Hi.\n/e msg Daniel first line\n\nsecond paragraph\n- a\n- b\n/e msg Mia short');
    expect(r.prose).toBe('Hi.');
    expect(r.run.map((a) => a.text)).toEqual(['first line\n\nsecond paragraph\n- a\n- b', 'short']);
  });

  it('a "quoted name" and a curly-quoted one are one target; the text follows on the next line too', () => {
    expect(parse('/e msg "Quiet Room" hello').run[0]).toMatchObject({ target: 'Quiet Room', text: 'hello' });
    expect(parse('/e msg “Quiet Room” hello').run[0]).toMatchObject({ target: 'Quiet Room', text: 'hello' });
    expect(parse('/e msg Daniel\nhello there').run[0]).toMatchObject({ target: 'Daniel', text: 'hello there' });
  });

  it('a bare /msg works, with no handle at all', () => {
    expect(parse('/msg Daniel hola', { handles: [] }).run).toEqual([{ type: 'msg', chatId: 'c1', target: 'Daniel', text: 'hola' }]);
  });

  it("ANOTHER being's handle is not this being's msg: it stays prose", () => {
    const r = parse('/other msg Daniel hola');
    expect(r.run).toEqual([]);
    expect(r.prose).toBe('/other msg Daniel hola');
  });

  it('without the being\'s handles (a heartbeat post, no being) msg is prose, as it always was', () => {
    for (const line of ['/e msg Daniel hola', '/msg Daniel hola']) {
      const r = parseReplyActions(line, EV, {});
      expect(r.run).toEqual([]);
      expect(r.prose).toBe(line);
    }
  });

  it('malformed: no target, no text, a placeholder: stripped with a reason, never run, not in the prose', () => {
    for (const line of ['/e msg', '/e msg Daniel', '/e msg <chat> <text>', '/msg "Quiet Room"']) {
      const r = parse(`Hi.\n${line}`);
      expect(r.run, line).toEqual([]);
      expect(r.prose, line).toBe('Hi.');
      expect(r.stripped, line).toHaveLength(1);
      expect(r.stripped[0].reason).toMatch(/^msg:/);
    }
  });

  it("its own /media lines are part of its text; any other action line ends it", () => {
    const r = parse('/e msg Daniel here you go\n/media out/a.png\n/react #3 👍');
    expect(r.run).toEqual([
      { type: 'msg', chatId: 'c1', target: 'Daniel', text: 'here you go\n/media out/a.png' },
      { type: 'react', chatId: 'c1', targetId: '3', emoji: '👍' },
    ]);
  });

  it('a sentence that merely mentions it is prose', () => {
    const r = parse('I will /e msg Daniel later.\n/e is my handle');
    expect(r.run).toEqual([]);
    expect(r.prose).toBe('I will /e msg Daniel later.\n/e is my handle');
  });
});

describe('/msg while streaming', () => {
  it('a half-typed msg line is never shown, whichever step it is at', () => {
    for (const tail of ['/', '/e', '/e ', '/e m', '/e ms', '/e msg', '/e msg Dan', '/msg Dan', '/e msg Daniel hola\nmore text']) {
      expect(partialProse(`Hi.\n${tail}`, EV, OPTS), tail).toBe('Hi.');
    }
  });
  it('a line that can no longer be one streams at once', () => {
    expect(partialProse('Hi.\n/e is', EV, OPTS)).toBe('Hi.\n/e is');
    expect(partialProse('Hi.\n/e msgx', EV, OPTS)).toBe('Hi.\n/e msgx');
  });
  it('the finished frame never shrinks the last streamed one', () => {
    const full = 'Hi.\n/e msg Daniel hola\nmás';
    let last = '';
    for (let i = 1; i <= full.length; i++) {
      const p = partialProse(full.slice(0, i), EV, OPTS);
      expect(p.startsWith(last.trimEnd()), `${i}`).toBe(true);
      last = p;
    }
    expect(last).toBe(parse(full).prose);
  });
});

describe('createReplyActions: the handles come from the being', () => {
  const mk = (limbs = {}) => createReplyActions({ bridge: {}, handlesOf: (b) => (b === 'egpt' ? ['e', 'EGPT'] : null), limbs });
  it('parse and partialProse take opts.being → its handles', () => {
    const a = mk();
    expect(a.parse('/e msg Daniel hola', EV, { being: 'egpt' }).run).toHaveLength(1);
    expect(a.parse('/e msg Daniel hola', EV, { being: 'nobody' }).run).toHaveLength(0);
    expect(a.parse('/e msg Daniel hola', EV, {}).run).toHaveLength(0);
    expect(a.partialProse('Hi.\n/e ms', EV, { being: 'egpt' })).toBe('Hi.');
  });
  it('execute runs the msg limb, with no agents.<b>.actions entry; no limb wired = dropped', async () => {
    const calls = [];
    const a = mk({ msg: async (act, ev, being) => { calls.push([act.target, act.text, being]); return true; } });
    const { run } = a.parse('/e msg Daniel hola', EV, { being: 'egpt' });
    expect((await a.execute(run, [], EV, { being: 'egpt' })).ran).toEqual(run);
    expect(calls).toEqual([['Daniel', 'hola', 'egpt']]);
    expect((await mk().execute(run, [], EV, { being: 'egpt' })).ran).toEqual([]);
  });
});
