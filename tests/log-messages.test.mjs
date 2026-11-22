// tests/log-messages.test.mjs — config.yaml log_messages: every log-channel line has today's text as its
// default (unset), a custom template is filled, a blank string posts nothing, an unknown {x} stays.
import { describe, it, expect } from 'vitest';
import { logLine, LOG_MESSAGES, TEMPLATES } from '../src/tools/template.mjs';
import { compactedNotice, warnNotice } from '../src/spine/compaction.mjs';
import { noticeLine as eNotice, askLine } from '../src/tools/egpt-update.mjs';
import { noticeLine as bNotice, noticeBody, resultLine, resultDetails, startLine } from '../src/tools/beeper-update.mjs';

const N = 'HQ';
// kind → [vars, the exact text the code posted before log_messages existed]
const LOCKED = {
  command_audit: [{ command: '/status', chat: 'Team', sender: 'ana', outcome: 'archived Team', details: ' → archived Team' }, '/status in Team by ana → archived Team'],
  going_down: [{ kind: '/upgrade full', pid: 4242 }, '↻ /upgrade full… (pid 4242)'],
  started: [{ sha: 'abc1234', pid: 77, subject: 'fix x', details: '\n\nfix x' }, '✅ egpt started (abc1234) pid 77\n\nfix x'],
  back_up: [{ head: 'a1 → b2', pids: 'pid 1 → 2', details: ' — /upgrade: pulled\n\n⚠️ migrate\n\nfix x' }, '✅ egpt back up! (a1 → b2) pid 1 → 2 — /upgrade: pulled\n\n⚠️ migrate\n\nfix x'],
  pending_updates: [{ details: 'eGPT 2 commits', ask: '. Apply now?' }, '⬆ pending: eGPT 2 commits. Apply now?'],
  egpt_update_notice: [{ node: N, details: 'eGPT 1 new commit' }, '⬆ HQ · eGPT 1 new commit'],
  egpt_update_stuck: [{ node: N, details: 'why' }, '⬆ HQ · why'],
  beeper_update_notice: [{ node: N, details: 'Beeper 2 downloaded' }, '⬆ HQ · Beeper 2 downloaded'],
  beeper_update_start: [{ node: N, from: '1', to: '2', marker: '⟦m⟧' }, '🔄 HQ · Beeper 1 → 2 · restarting for update… ⟦m⟧'],
  beeper_update_result: [{ node: N, from: '1', to: '2', details: ' · restarted in 7 s · a ✓' }, '🔄 HQ · Beeper 1 → 2 · restarted in 7 s · a ✓'],
  beeper_update_refused: [{ node: N, details: 'a restart is pending' }, 'HQ · a restart is pending'],
  beeper_connection_gone: [{ node: N, connection: 'main', minutes: 6 }, "HQ · ⚠ Beeper connection 'main' has answered on no port for 6 min — no install answers its token (Beeper not running, a service that can no longer log on, or a revoked token)"],
  beeper_connection_back: [{ node: N, connection: 'main', url: 'http://127.0.0.1:23373' }, "HQ · ✓ Beeper connection 'main' answers again (http://127.0.0.1:23373)"],
  media_flood: [{ node: N, details: 'burst' }, 'HQ · burst'],
  send_rate_guard: [{ node: N, chat: 'Team', why: 'too fast' }, 'HQ · send-rate guard paused Team — too fast'],
  lag_probe: [{ node: N, details: 'lag 12s' }, 'HQ · lag 12s'],
  undelivered: [{ node: N, what: 'opener', being: ' (e)', title: '"Team" ', chat: '!r:x', reason: 'blocked' }, 'HQ · ⚠ opener (e) not delivered to "Team" !r:x — blocked'],
  public_error: [{ being: 'e', chat: 'c1', text: 'boom' }, 'e in c1: boom'],
  drain_waiting: [{ node: N, elapsed: '2m', details: '1 turn(s): e' }, 'HQ · restart waiting 2m for 1 turn(s): e. Send /restart force to proceed.'],
  config_refused: [{ node: N, error: 'bad yaml' }, 'HQ · config.yaml change refused, the running config stays: bad yaml'],
  background_unanswered: [{ node: N, being: 'E', chat: 'Team', what: 'build', elapsed: '40m' }, 'HQ · E in Team: background task(s) build running 40m, the being did not answer whether they are still needed.'],
  login_captcha: [{ site: 'x.com', bytes: 12 }, 'login x.com: a CAPTCHA is blocking sign-in — solve it in the brain Chrome, then re-run /login x.com. (screenshot 12B captured; image delivery pending)'],
  compacted: [{ node: N, label: 'E', chat: 'Team', tokens: 150000, who: 'HQ · E', where: ' in Team', was: ' (was 150k tokens)' }, '🗜️ HQ · E in Team compacted its context (was 150k tokens). The full history stays in its transcript.md.'],
  compaction_frame: [{ node: N, label: 'E', chat: 'Team', who: 'HQ · E', where: ' in Team', text: 'at 18%' }, '🗜️ HQ · E in Team: at 18%'],
};

describe('log_messages', () => {
  it('every kind is locked here and documented in TEMPLATES', () => {
    expect(Object.keys(LOCKED).sort()).toEqual(Object.keys(LOG_MESSAGES).sort());
    for (const k of Object.keys(LOG_MESSAGES)) expect(TEMPLATES[`log_messages.${k}`]).toBeTruthy();
  });

  for (const [kind, [vars, text]] of Object.entries(LOCKED)) {
    it(`${kind}: unset = today's text, custom is filled, blank posts nothing`, () => {
      expect(logLine({}, kind, vars)).toBe(text);
      expect(logLine(undefined, kind, vars)).toBe(text);
      expect(logLine({ log_messages: {} }, kind, vars)).toBe(text);
      expect(logLine({ log_messages: { [kind]: null } }, kind, vars)).toBe(text);
      const k0 = Object.keys(vars)[0];
      expect(logLine({ log_messages: { [kind]: `X {${k0}} {nope}` } }, kind, vars)).toBe(`X ${vars[k0]} {nope}`);
      expect(logLine({ log_messages: { [kind]: '' } }, kind, vars)).toBeNull();
      expect(logLine({ log_messages: { [kind]: '  ' } }, kind, vars)).toBeNull();
    });
  }

  it('an unknown kind is a bug, not silence', () => {
    expect(() => logLine({}, 'nope', {})).toThrow();
  });
});

describe('the pure line builders keep today\'s text', () => {
  it('compactedNotice / warnNotice', () => {
    expect(compactedNotice({ node: N, label: 'E', chat: 'Team', tokens: 150000 })).toBe(LOCKED.compacted[1]);
    expect(compactedNotice({ label: 'E' })).toBe('🗜️ E compacted its context. The full history stays in its transcript.md.');
    expect(warnNotice({ node: N, label: 'E', chat: 'Team', text: 'at 18%' })).toBe('🗜️ HQ · E in Team: at 18%');
    expect(warnNotice({ label: 'E', text: 't' })).toBe('🗜️ E: t');
    expect(warnNotice({ node: N, label: 'E', text: 't', config: { log_messages: { compaction_frame: '' } } })).toBeNull();
    expect(compactedNotice({ node: N, label: 'E', config: { log_messages: { compacted: '{label} done' } } })).toBe('E done');
  });
  it('egpt-update / beeper-update', () => {
    const r = { behind: 1, subjects: ['s'], branch: 'main', from: 'aaaaaaaa', to: 'bbbbbbbb', how: 'manual', ahead: 0, upstream: 'origin/main' };
    expect(eNotice(N, r, '/upgrade')).toBe(`⬆ HQ · ${logLine({}, 'egpt_update_notice', { node: N, details: eNotice(N, r, '/upgrade').slice('⬆ HQ · '.length) }).slice('⬆ HQ · '.length)}`);
    expect(askLine([{ text: 'a', ask: true }, { text: 'b', ask: false }])).toBe('⬆ pending: a · b. Apply now?');
    expect(askLine([{ text: 'a', ask: false }])).toBe('⬆ pending: a');
    expect(askLine([])).toBeNull();
    expect(askLine([{ text: 'a', ask: false }], { log_messages: { pending_updates: '' } })).toBeNull();
    const d = { pending: { version: '2' }, running: [{ version: '1' }], installed: '1' };
    expect(bNotice(N, d, 'downloaded', { method: 'manual', hint: '/e update beeper' })).toBe(`⬆ HQ · ${noticeBody(d, 'downloaded', { method: 'manual', hint: '/e update beeper' })}`);
    expect(startLine(N, '1', '2', 'M')).toBe(logLine({}, 'beeper_update_start', { node: N, from: '1', to: '2', marker: 'M' }));
    const ok = { from: '1', to: '2', result: { ok: true, restartSec: 7, connections: [{ name: 'a', status: 'ok' }, { name: 'b', status: 'down' }] } };
    expect(resultLine(N, ok)).toBe('🔄 HQ · Beeper 1 → 2 · restarted in 7 s · a ✓ · b ✗ down');
    expect(logLine({}, 'beeper_update_result', { node: N, from: '1', to: '2', details: resultDetails(ok) })).toBe(resultLine(N, ok));
    const bad = { from: '1', to: '2', result: { ok: false, step: 'tool', error: 'x' } };
    expect(resultLine(N, bad)).toBe('🔄 HQ · Beeper 1 → 2 · FAILED at tool: x');
    expect(logLine({}, 'beeper_update_result', { node: N, from: '1', to: '2', details: resultDetails(bad) })).toBe(resultLine(N, bad));
  });
});
