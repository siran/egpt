// Per-chat auto-mode semantics: standalone @e detection (no email false
// positives) and the reply gate for each mode.
import { describe, it, expect } from 'vitest';
import { mentionStatus, replyAllowed, receives, isAutoMode, DEFAULT_AUTO_MODE, mayEmit, mayEmitChat, isSilenceReply, fanOutDecision } from '../src/auto-mode.mjs';

describe('mentionStatus', () => {
  it('detects @e as a standalone token, anywhere and at start', () => {
    expect(mentionStatus('@e hello')).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('To @e my assistant')).toEqual({ atEAnywhere: true, atEStart: false });
    expect(mentionStatus('@egpt do this')).toEqual({ atEAnywhere: true, atEStart: true });
  });
  it('does NOT match @e glued inside a word/email', () => {
    expect(mentionStatus('me@e.com')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('write to me@e.com please')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('hey@egpt')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('email')).toEqual({ atEAnywhere: false, atEStart: false });
  });
  it('handles leading whitespace for atEStart', () => {
    expect(mentionStatus('   @e hi').atEStart).toBe(true);
  });

  // WAKE-WORD SET honors configured handles (operator 2026-07-07, DOLLY sleep-test bug):
  // the gate was hardcoded to e/egpt, so a node configured with handles [ed, egptd] never
  // woke on @ed. mentionStatus now takes the wake set the bridge derives from the config.
  it('honors a configured wake-word set (@ed) while keeping the network-wide @e', () => {
    const wake = ['e', 'egpt', 'ed', 'egptd'];   // DOLLY-shaped: network defaults + persona handles
    // BEFORE (default set) the DOLLY handle failed the gate — this is the reproduce:
    expect(mentionStatus('@ed estás?')).toEqual({ atEAnywhere: false, atEStart: false });
    // AFTER (honoring the set) @ed wakes the node, at start and anywhere…
    expect(mentionStatus('@ed estás?', wake)).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('oye @egptd ayuda', wake)).toEqual({ atEAnywhere: true, atEStart: false });
    // …and the network-wide @e / @egpt still wake it (regression).
    expect(mentionStatus('@e estás?', wake).atEStart).toBe(true);
    expect(mentionStatus('@egpt hola', wake).atEAnywhere).toBe(true);
    // @egpt must match 'egpt', not the shorter 'e' then stop (no false glue).
    expect(mentionStatus('hey@ed', wake)).toEqual({ atEAnywhere: false, atEStart: false });
  });
  it('an empty/absent wake set falls back to the network default e/egpt', () => {
    expect(mentionStatus('@e hi', [])).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('@ed hi', [])).toEqual({ atEAnywhere: false, atEStart: false });   // no handles → @ed does not wake
  });

  // Real bug (operator 2026-07-24): /status emits a fenced ```yaml block whose
  // version line is a git commit SUBJECT — "refactor(bridge): @e voice-note
  // transcript reuses transcript.md" — a changelog line, not an address. The raw
  // matchers saw that fenced @e and woke E on its own /status output.
  describe('code-fence / inline-code stripping (operator 2026-07-24: /status false-wake)', () => {
    it('an @e inside a fenced code block does not wake', () => {
      const text = [
        'status:',
        '```yaml',
        'version: refactor(bridge): @e voice-note transcript reuses transcript.md',
        '```',
      ].join('\n');
      expect(mentionStatus(text)).toEqual({ atEAnywhere: false, atEStart: false });
    });
    it('an @e inside inline code does not wake', () => {
      expect(mentionStatus('use `@e` to mention')).toEqual({ atEAnywhere: false, atEStart: false });
    });
    it('an UNCLOSED fenced block strips to end-of-text — an @e after it is not detected', () => {
      const text = 'before the fence\n```\nsome code @e trailing, never closed';
      expect(mentionStatus(text)).toEqual({ atEAnywhere: false, atEStart: false });
    });
    // Regression: a genuine @e OUTSIDE any code region still wakes normally.
    it('a real @e outside code regions still wakes (regression)', () => {
      expect(mentionStatus('@e hello')).toEqual({ atEAnywhere: true, atEStart: true });
      expect(mentionStatus('please @e look')).toEqual({ atEAnywhere: true, atEStart: false });
      expect(mentionStatus('@egpt hi')).toEqual({ atEAnywhere: true, atEStart: true });
      expect(mentionStatus('me@e.com')).toEqual({ atEAnywhere: false, atEStart: false });
      expect(mentionStatus('hey@egpt')).toEqual({ atEAnywhere: false, atEStart: false });
    });
    it('custom wakeWords: a fenced @ed does not wake, but a live @ed does', () => {
      const wake = ['ed', 'egptd'];
      expect(mentionStatus('@ed estás?', wake)).toEqual({ atEAnywhere: true, atEStart: true });
      expect(mentionStatus('```\n@ed estás?\n```', wake)).toEqual({ atEAnywhere: false, atEStart: false });
    });
  });
});

describe('replyAllowed', () => {
  const M = (o) => ({ atEStart: false, atEAnywhere: false, replyToBot: false, ...o });
  it('on always allows (personality decides downstream)', () => {
    expect(replyAllowed('on', M())).toBe(true);
  });
  it('auto gates like on — always allows, mention-independent', () => {
    expect(replyAllowed('auto', M())).toBe(true);
    expect(replyAllowed('auto', M({ atEAnywhere: true }))).toBe(true);
  });
  it('legacy accum degrades to mention semantics (retired 2026-07-01, unknown→mention)', () => {
    // 'accum' is no longer a known mode; a value still stored in conversations.yaml
    // falls through replyAllowed's `default:`, which is identical to 'mention'.
    expect(replyAllowed('accum', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('accum', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('accum', M())).toBe(false);
    // proves it truly routes through default: same output as 'mention' in every case.
    expect(replyAllowed('accum', M({ atEAnywhere: true }))).toBe(replyAllowed('mention', M({ atEAnywhere: true })));
    expect(replyAllowed('accum', M())).toBe(replyAllowed('mention', M()));
  });
  it('mute / off never allow', () => {
    expect(replyAllowed('mute', M({ atEStart: true, atEAnywhere: true, replyToBot: true }))).toBe(false);
    expect(replyAllowed('off', M({ atEAnywhere: true }))).toBe(false);
  });
  it('mention-direct: only @e-at-start or reply-to-bot', () => {
    expect(replyAllowed('mention-direct', M({ atEStart: true }))).toBe(true);
    expect(replyAllowed('mention-direct', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('mention-direct', M({ atEAnywhere: true }))).toBe(false);   // mid-message ≠ start
    expect(replyAllowed('mention-direct', M())).toBe(false);
  });
  it('mention: @e anywhere or reply-to-bot', () => {
    expect(replyAllowed('mention', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('mention', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('mention', M())).toBe(false);
  });
  it('unknown mode falls back to mention semantics', () => {
    expect(replyAllowed('bogus', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('bogus', M())).toBe(false);
  });
});

describe('receives / isAutoMode', () => {
  it('receives is true for everything except off', () => {
    for (const m of ['on', 'auto', 'mute', 'mention-direct', 'mention']) expect(receives(m)).toBe(true);
    expect(receives('off')).toBe(false);
  });
  it('isAutoMode + default; auto is a known mode, retired accum is not', () => {
    expect(isAutoMode('mention')).toBe(true);
    expect(isAutoMode('auto')).toBe(true);     // new mode (operator 2026-07-04)
    expect(isAutoMode('nope')).toBe(false);
    expect(isAutoMode('accum')).toBe(false);   // retired 2026-07-01 → guards fall through to default
    expect(DEFAULT_AUTO_MODE).toBe('mention'); // auto is opt-in only, never the default
  });
});

// Regression: the WA bridge rewrites a mid-body "@e" to a LEADING "@e " prefix
// (at_e_anywhere, default on) purely so start-anchored parseInput ROUTES the
// message to @e. The per-chat reply gate must NOT be computed on that rewritten
// body — doing so promotes a mid-message @e to atEStart and silently collapses
// 'mention-direct' into 'mention'. The gate must read the user's ORIGINAL body.
// (Mirrors src/bridges/whatsapp.mjs: `_gateMs = mentionStatus(processed)` is
// taken BEFORE the `processed = '@e ' + processed` routing rewrite.)
describe('mention-direct gate is immune to the @e-routing rewrite', () => {
  // Minimal model of the bridge's at_e_anywhere expansion.
  const routeRewrite = (body) =>
    (!/^@\S/.test(body) && mentionStatus(body).atEAnywhere) ? `@e ${body}` : body;

  it('mid-body @e routes to @e but does NOT open mention-direct', () => {
    const original = 'hello @e are you up?';
    const routed = routeRewrite(original);
    expect(routed).toBe('@e hello @e are you up?');     // routing prepends for parseInput

    // WRONG (the bug): gate computed on the rewritten body → false-positive start.
    expect(mentionStatus(routed).atEStart).toBe(true);

    // RIGHT: gate computed on the original body → mention-direct stays closed,
    // mention still fires (the @e is genuinely present, just not at the start).
    const gate = mentionStatus(original);
    expect(gate).toEqual({ atEAnywhere: true, atEStart: false });
    expect(replyAllowed('mention-direct', gate)).toBe(false);
    expect(replyAllowed('mention', gate)).toBe(true);
  });

  it('genuine @e-at-start opens both mention and mention-direct', () => {
    const gate = mentionStatus('@e ping');
    expect(replyAllowed('mention-direct', gate)).toBe(true);
    expect(replyAllowed('mention', gate)).toBe(true);
  });
});

describe('fanOutDecision — single record-always / gate-on-mode chokepoint', () => {
  // The operator's rule (2026-06-02): gating is mode + per-turn replyAllowed
  // (from the INCOMING message), NEVER E's reply body — except the 'on'-mode
  // silence cosmetic. Nothing is dropped; non-sent replies are annotated.
  it('mute: NEVER fans out, whatever E said — recorded + annotated', () => {
    expect(fanOutDecision('mute', { replyAllowed: true, reply: 'a long real answer' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mute)' });
    expect(fanOutDecision('mute', { reply: '…' }).sent).toBe(false);
  });
  it('mention: fan-out follows replyAllowed, the reply BODY is irrelevant', () => {
    // replyAllowed true → sent, even if the reply is just "…"
    expect(fanOutDecision('mention', { replyAllowed: true, reply: '…' }))
      .toEqual({ sent: true, annotation: null });
    // replyAllowed false → NOT sent, even a long reply → recorded + annotated
    expect(fanOutDecision('mention', { replyAllowed: false, reply: 'a whole paragraph' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mention)' });
  });
  it('mention-direct: same — body never decides', () => {
    expect(fanOutDecision('mention-direct', { replyAllowed: true, reply: 'hi' }).sent).toBe(true);
    expect(fanOutDecision('mention-direct', { replyAllowed: false, reply: 'long reflection' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mention-direct)' });
  });
  it('fails CLOSED for mention modes when replyAllowed is absent (forgotten flag → recorded, not leaked)', () => {
    expect(fanOutDecision('mention', { reply: 'leak attempt' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mention)' });
    expect(fanOutDecision('mention-direct', { reply: 'leak attempt' }).sent).toBe(false);
  });
  it('on: fans out real replies; a pure-silence reply is the ONLY body-aware case (recorded, not pushed)', () => {
    expect(fanOutDecision('on', { reply: 'hello there' })).toEqual({ sent: true, annotation: null });
    expect(fanOutDecision('on', { reply: '…' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: on)' });
    expect(fanOutDecision('on', { reply: '...' }).sent).toBe(false);
  });
  it('auto: same as on — real replies fan out, a pure-silence reply is recorded not pushed', () => {
    expect(fanOutDecision('auto', { reply: 'on it' })).toEqual({ sent: true, annotation: null });
    expect(fanOutDecision('auto', { reply: '…' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: auto)' });
  });
  it('isSilenceReply only matches pure ellipsis/empty', () => {
    expect(isSilenceReply('…')).toBe(true);
    expect(isSilenceReply('...')).toBe(true);
    expect(isSilenceReply('   ')).toBe(true);
    expect(isSilenceReply('… and then')).toBe(false);   // the leak shape: NOT silence
    expect(isSilenceReply('ok')).toBe(false);
  });
});

describe('mayEmit — outbound backstop', () => {
  it('HARD-blocks mute/off even when replyAllowed is (wrongly) true', () => {
    expect(mayEmit('mute', { replyAllowed: true })).toBe(false);
    expect(mayEmit('off',  { replyAllowed: true })).toBe(false);
  });
  it('allows on unconditionally', () => {
    expect(mayEmit('on', {})).toBe(true);
    expect(mayEmit('on', { replyAllowed: false })).toBe(true);
  });
  it('allows auto unconditionally (gates like on)', () => {
    expect(mayEmit('auto', {})).toBe(true);
    expect(mayEmit('auto', { replyAllowed: false })).toBe(true);
  });
  it('mention modes defer to the per-turn replyAllowed flag', () => {
    expect(mayEmit('mention', { replyAllowed: true })).toBe(true);
    expect(mayEmit('mention', { replyAllowed: false })).toBe(false);
    expect(mayEmit('mention-direct', { replyAllowed: true })).toBe(true);
    expect(mayEmit('accum', { replyAllowed: true })).toBe(true);   // legacy accum → unknown-mode path, defers like mention
  });
  it('fails CLOSED for mention modes when the flag is absent', () => {
    expect(mayEmit('mention', {})).toBe(false);
    expect(mayEmit('mention-direct', {})).toBe(false);
  });
  // I5 REVISED (operator 2026-06-16, Phase 2): a reaction now follows the SAME
  // mode gate as any message — no longer hard-blocked, because it arrives as an
  // intelligible stage-direction. 'on' → E may answer; 'mention(-direct)' → only if
  // @-mentioned (a reaction can't, so replyAllowed stays false → silent);
  // 'mute'/'off' → never. (Was: a reaction NEVER emitted in any mode.)
  it('a reaction follows the normal mode gate (I5 revised) — no longer hard-blocked', () => {
    expect(mayEmit('on',      { isReaction: true })).toBe(true);                       // 'on' → may answer
    expect(mayEmit('on',      { replyAllowed: true, isReaction: true })).toBe(true);
    expect(mayEmit('mention', { isReaction: true })).toBe(false);                     // not mentioned → silent
    expect(mayEmit('mention', { replyAllowed: true, isReaction: true })).toBe(true);  // mentioned → may answer
    expect(mayEmit('mute',    { replyAllowed: true, isReaction: true })).toBe(false); // mute always silent
    expect(mayEmit('off',     { replyAllowed: true, isReaction: true })).toBe(false);
  });
});

// CONTRACT: whatsapp.auto_e_paused = absolute @e-emit kill. This is the one gate
// rule that lives in egpt.mjs `_eMayReplyToChat` (above the mode layer); locking
// it here guards against its silent removal. The wrapper delegates to this fn,
// so this IS the real gate, pause included — not a parallel copy.
describe('mayEmitChat — global pause kill over the mode gate', () => {
  it('paused BLOCKS every mode — even on, even with replyAllowed', () => {
    expect(mayEmitChat({ paused: true, mode: 'on' })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'on', replyAllowed: true })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'mention', replyAllowed: true })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'mention-direct', replyAllowed: true })).toBe(false);
    // A REACTION must not bypass any gate (operator 2026-06-16 nota bene): paused
    // kills a reaction-triggered emit too, even in 'on'.
    expect(mayEmitChat({ paused: true, mode: 'on', isReaction: true })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'on', replyAllowed: true, isReaction: true })).toBe(false);
  });
  it('not paused → identical to the per-chat mode gate (mayEmit)', () => {
    for (const mode of ['on', 'mute', 'off', 'mention', 'mention-direct', 'accum']) {
      for (const replyAllowed of [true, false, undefined]) {
        expect(mayEmitChat({ paused: false, mode, replyAllowed }))
          .toBe(mayEmit(mode, { replyAllowed }));
      }
    }
  });
  it('defaults are fail-safe (no args → no emit)', () => {
    expect(mayEmitChat()).toBe(false);                       // no mode, not paused → mayEmit(undefined) → false
    expect(mayEmitChat({ mode: 'mention' })).toBe(false);    // mention w/o replyAllowed → fails closed
  });
});
