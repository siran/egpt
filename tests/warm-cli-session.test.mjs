// Locks the Unit 4 warm-CLI primitive (operator 2026-06-13): ONE resident
// `claude` process answers many turns (residency = warmth), captures the minted
// session id, streams text deltas, and fails the in-flight turn on an error
// result or a mid-turn process crash. Uses an injectable fake `claude` that
// speaks stream-json — no real CLI / network.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createWarmCliSession, renderToolUse, redactSecrets } from '../src/warm-cli-session.mjs';

function fakeClaude({ failOn = null, hang = false, sessionId = 'sess-123' } = {}) {
  let spawnCount = 0;
  let lastProc = null;
  let turnNo = 0;
  const calls = [];
  const spawn = () => {
    spawnCount++;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    proc.stdin = {
      write: (line) => {
        const text = JSON.parse(line).message.content.map((c) => c.text).join('');
        calls.push(text);
        turnNo++;
        if (hang) return;
        setImmediate(() => {
          if (turnNo === 1) proc.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
          if (failOn && text.includes(failOn)) {
            proc.stderr.emit('data', 'boom\n');
            proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'error_during_execution' }) + '\n');
            return;
          }
          const reply = `echo:${text}`;
          // split the reply across two delta chunks to exercise line buffering
          proc.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(0, 5) } } }) + '\n');
          proc.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(5) } } }) + '\n');
          proc.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: reply }) + '\n');
        });
      },
      end: () => {},
    };
    lastProc = proc;
    return proc;
  };
  return { spawn, calls, getProc: () => lastProc, spawnCount: () => spawnCount };
}

describe('warm-cli-session — resident multi-turn', () => {
  it('ONE process answers many turns (residency = warmth) + captures the session id', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    const r1 = await s.turn('ONE');
    const r2 = await s.turn('TWO');
    expect(r1.text).toBe('echo:ONE');
    expect(r2.text).toBe('echo:TWO');
    expect(r1.sessionId).toBe('sess-123');
    expect(f.calls).toEqual(['ONE', 'TWO']);
    expect(f.spawnCount()).toBe(1);   // not re-spawned per turn — warm
    s.close();
  });

  it('streams text deltas to onUpdate, resolves with the full text', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    const updates = [];
    const r = await s.turn('HI', (t) => updates.push(t));
    expect(r.text).toBe('echo:HI');
    expect(updates.length).toBeGreaterThanOrEqual(2);          // split deltas
    expect(updates[updates.length - 1]).toBe('echo:HI');       // last snapshot = full
    s.close();
  });

  it('an error result rejects the in-flight turn (pool then evicts)', async () => {
    const f = fakeClaude({ failOn: 'BAD' });
    const s = createWarmCliSession({ spawn: f.spawn });
    await expect(s.turn('a BAD one')).rejects.toThrow(/error_during_execution/);
    s.close();
  });

  it('a mid-turn process crash rejects the turn (no silent hang)', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    const pr = s.turn('X');
    await new Promise((r) => setImmediate(r));   // let spawn + stdin.write run
    f.getProc().emit('close', 1);
    await expect(pr).rejects.toThrow(/exited 1/);
    s.close();
  });

  it('close() ends the process and refuses further turns', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    await s.turn('ONE');
    s.close();
    expect(f.getProc().killed).toBe(true);
    await expect(s.turn('TWO')).rejects.toThrow(/closed/);
  });
});

// inject() — STEER THE TURN THAT IS ALREADY STREAMING (operator 2026-08-30, measured against
// the real `claude --input-format stream-json` CLI: an AGENTIC turn absorbs a second user line
// written to its stdin at a tool boundary — one result, answering the new instruction; a
// pure-text turn instead finishes and answers twice. See the module header).
//
// The invariants that matter here: the wire format is BYTE-IDENTICAL to a turn's (the CLI
// cannot tell them apart, and must not), NO second `pending` is created (the live turn's one
// result is the combined reply — a second pending would be a promise nothing can settle), and
// it NEVER throws: every "nothing to steer" is a plain `false`, because a false NEGATIVE only
// costs a queued turn while a false POSITIVE silently swallows the message.
describe('warm-cli-session — inject (steer the live turn, operator 2026-08-30)', () => {
  it('writes ONE user line to the SAME stdin, in the same wire format a turn uses', async () => {
    const f = fakeClaude({ hang: true });                 // hang: the turn stays in flight
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL');
    await new Promise((r) => setImmediate(r));
    expect(s.inject('ACTUALLY DO X')).toBe(true);
    expect(f.calls).toEqual(['ORIGINAL', 'ACTUALLY DO X']);   // parsed by the fake as a user msg
    expect(f.spawnCount()).toBe(1);                            // the SAME process
    s.close();
  });

  it('creates NO second pending — the live turn resolves ONCE, with the combined reply', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    let settled = 0;
    const pr = s.turn('ORIGINAL').then(() => { settled++; });
    await new Promise((r) => setImmediate(r));
    expect(s.inject('AND ALSO Y')).toBe(true);
    // ONE result event, and it settles the ONE pending the turn made.
    f.getProc().stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'combined' }) + '\n');
    await pr;
    expect(settled).toBe(1);
    // A second result would have nothing to settle — no throw, no double-resolve.
    f.getProc().stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: 'stray' }) + '\n');
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(1);
    s.close();
  });

  it('false when there is NO turn in flight (nothing to steer) — and no process is spawned', async () => {
    const f = fakeClaude();
    const s = createWarmCliSession({ spawn: f.spawn });
    expect(s.inject('too early')).toBe(false);            // never turned: no proc, no pending
    expect(f.spawnCount()).toBe(0);
    await s.turn('ONE');                                   // turn settled → pending is null again
    expect(s.inject('too late')).toBe(false);
    expect(f.calls).toEqual(['ONE']);
    s.close();
  });

  it('false on a CLOSED session', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL');
    await new Promise((r) => setImmediate(r));
    s.close();
    expect(s.inject('x')).toBe(false);
  });

  it('false — never a throw — when the stdin write itself fails', async () => {
    const f = fakeClaude({ hang: true });
    const s = createWarmCliSession({ spawn: f.spawn });
    s.turn('ORIGINAL');
    await new Promise((r) => setImmediate(r));
    f.getProc().stdin.write = () => { throw new Error('EPIPE'); };
    expect(s.inject('x')).toBe(false);                     // swallowed, reported as false
    s.close();
  });
});

// A fake AGENTIC turn: reason+tool_use -> tool_result -> reason again -> stream the final
// text -> a mirrored final assistant text block -> result. Models what a real ccode turn
// actually emits (multiple `assistant` events before `result`), which the plain fakeClaude()
// above (single result, no assistant/thinking/tool_use events) does not exercise.
function fakeClaudeAgentic({ sessionId = 'sess-agentic' } = {}) {
  const spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    proc.stdin = {
      write: () => {
        setImmediate(() => {
          const emit = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
          emit({ type: 'system', subtype: 'init', session_id: sessionId });
          emit({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'thinking', thinking: 'THINK1: let me check the directory' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
          ] } });
          emit({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'DIRLISTING-secret-output' },
          ] } });
          emit({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'thinking', thinking: 'THINK2: now I can answer' },
          ] } });
          emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
          emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } });
          emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
          emit({ type: 'result', subtype: 'success', result: 'Hello' });
        });
      },
      end: () => {},
    };
    return proc;
  };
  return { spawn };
}

describe('warm-cli-session — verboseThinking (operator 2026-08-29, wren\'s "full chain of thought")', () => {
  it('OFF (default): same text as today on a multi-assistant-event agentic turn (regression lock)', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn });
    const r = await s.turn('what is in the dir?');
    expect(r.text).toBe('Hello');
    s.close();
  });

  // Was `Bash()` until 2026-08-30; the operator then asked to "reveal a bit more on what
  // inside the parenthesis". The stub now summarizes the INPUT — the invariant that did NOT
  // change, and is the one that matters, is that the tool RESULT is still never included.
  it('ON: thinking verbatim + ToolName(<input summary>) + final text, in order, never the tool result', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    const r = await s.turn('what is in the dir?');
    expect(r.text).toBe(
      'THINK1: let me check the directory\n\nBash(ls -la)\n\nTHINK2: now I can answer\n\nHello'
    );
    expect(r.text).not.toContain('DIRLISTING');    // tool_result content never included
    s.close();
  });

  it('ON: a tool_use carrying a credential reaches the reply REDACTED', async () => {
    const spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      proc.stdin = {
        write: () => setImmediate(() => {
          const emit = (o) => proc.stdout.emit('data', JSON.stringify(o) + '\n');
          emit({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl -u radio:hunter2 https://station.local/now' } },
          ] } });
          emit({ type: 'result', subtype: 'success', result: 'done' });
        }),
        end: () => {},
      };
      return proc;
    };
    const s = createWarmCliSession({ spawn, verboseThinking: true });
    const r = await s.turn('play something');
    expect(r.text).toBe('Bash(curl -u *** https://station.local/now)');
    expect(r.text).not.toContain('hunter2');
    s.close();
  });

  // Was "identical in both modes" until the progressive-preview fix below: ON mode now ALSO
  // gets a preview per assistant event, so the two can no longer match exactly. What must
  // still hold is that OFF stays byte-identical (regression lock), and ON's text-delta-driven
  // updates are the SAME ones OFF gets — verbose previews are additive, not a replacement.
  // Was "ON gets the SAME text-delta updates PLUS progressive verbose previews" — that
  // assertion was itself checking the bug (operator 2026-08-30): branch 2's bare pending.acc
  // updates and branch 1's THINK1-prefixed updates diverged, which made sender.mjs's absorb()
  // seal one behind RETAINED_SEAM and start a new tail, producing visible duplicate text in
  // WhatsApp. Fix: branch 2's onUpdate is suppressed when verboseThinking is on, so ON mode's
  // updates are fed by the verbose-block branch only.
  it('OFF is unchanged; ON only gets verbose-block previews (plain-delta updates suppressed to avoid a divergence/duplicate in sender.mjs)', async () => {
    const updatesOff = [];
    const sOff = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn });
    await sOff.turn('x', (t) => updatesOff.push(t));
    sOff.close();

    const updatesOn = [];
    const sOn = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    await sOn.turn('x', (t) => updatesOn.push(t));
    sOn.close();

    expect(updatesOff).toEqual(['Hel', 'Hello']);            // regression lock: OFF path byte-identical
    expect(updatesOn.length).toBeGreaterThan(0);
    for (const u of updatesOn) {
      expect(u.startsWith('THINK1')).toBe(true);              // every ON update is a verbose-block preview
    }
    for (const off of updatesOff) {
      expect(updatesOn).not.toContain(off);                   // bare delta strings never reach onUpdate in ON mode
    }
  });

  // Reproduces the production duplicate-text bug (operator 2026-08-30, live WhatsApp
  // screenshot: "ListAgents()\n\nI'll start by reading...\n\n— ↓ reply —\n\nI'll start by
  // reading..."). Before the fix, branch 1 (verbose-block preview) and branch 2 (bare
  // text-delta / pending.acc preview) both called onUpdate for the same turn, feeding
  // sender.mjs's absorb() two independently-growing strings. absorb() seals the current tail
  // behind RETAINED_SEAM and starts a new one whenever the next value does NOT start with the
  // current one — so any such interruption here would reproduce the visible duplicate. Post-fix
  // there must be exactly ONE growing sequence, fed only by the verbose-block branch.
  it('ON: every onUpdate value monotonically extends the previous one (no divergence for sender.mjs to duplicate)', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    const updates = [];
    await s.turn('what is in the dir?', (t) => updates.push(t));
    s.close();
    expect(updates.length).toBeGreaterThan(1);
    for (let i = 1; i < updates.length; i++) {
      expect(updates[i].startsWith(updates[i - 1])).toBe(true);
    }
  });

  // The gap this fix closes: today the verbose transcript is only ever delivered ONCE,
  // at `result`. The operator wants it to grow message-by-message (edited in place in
  // WhatsApp) the same way plain streaming already does via pending.acc. So onUpdate
  // must fire on EVERY assistant event that pushes new verbose blocks, each call
  // carrying the transcript accumulated so far, and the last such call must equal the
  // turn's final resolved text.
  it('ON: onUpdate also fires progressively with the growing verbose transcript (not just once at the end)', async () => {
    const s = createWarmCliSession({ spawn: fakeClaudeAgentic().spawn, verboseThinking: true });
    const updates = [];
    const r = await s.turn('what is in the dir?', (t) => updates.push(t));
    const verboseUpdates = updates.filter((u) => u.startsWith('THINK1'));
    // fakeClaudeAgentic emits 3 assistant events that each push new verbose blocks
    // (thinking+tool_use, then thinking, then the final text) — expect a preview per event.
    expect(verboseUpdates.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < verboseUpdates.length; i++) {
      expect(verboseUpdates[i].startsWith(verboseUpdates[i - 1])).toBe(true);   // strictly growing
    }
    expect(verboseUpdates[verboseUpdates.length - 1]).toBe(r.text);   // last preview == final resolved text
  });
});

// renderToolUse — the pure stub renderer (operator 2026-08-30: "reveal a bit more on what
// inside the parenthesis of 'Bash()'"). Tested directly, not through a fake CLI, because
// the rules that matter (headline field, whitespace, truncation, REDACTION) are per-block.
describe('renderToolUse — headline field per tool', () => {
  const t = (name, input) => renderToolUse({ type: 'tool_use', name, input });

  it('picks the one field that says what the call does', () => {
    expect(t('Bash', { command: 'ls -la', description: 'list' })).toBe('Bash(ls -la)');
    expect(t('Read', { file_path: '/a/b.mjs', offset: 3 })).toBe('Read(/a/b.mjs)');
    expect(t('Write', { file_path: '/a/b.mjs', content: 'x'.repeat(400) })).toBe('Write(/a/b.mjs)');
    expect(t('Edit', { file_path: '/a/b.mjs', old_string: 'x', new_string: 'y' })).toBe('Edit(/a/b.mjs)');
    expect(t('MultiEdit', { file_path: '/a/b.mjs', edits: [] })).toBe('MultiEdit(/a/b.mjs)');
    expect(t('NotebookEdit', { file_path: '/a/n.ipynb' })).toBe('NotebookEdit(/a/n.ipynb)');
    expect(t('Glob', { pattern: '**/*.mjs', path: 'src' })).toBe('Glob(**/*.mjs)');
    expect(t('Grep', { pattern: 'verbose_thinking', path: 'src' })).toBe('Grep(verbose_thinking)');
    expect(t('WebFetch', { url: 'https://x/y', prompt: 'summarize' })).toBe('WebFetch(https://x/y)');
    expect(t('WebSearch', { query: 'vitest snapshot' })).toBe('WebSearch(vitest snapshot)');
    expect(t('Task', { description: 'audit the redactor', prompt: 'long...' })).toBe('Task(audit the redactor)');
    expect(t('Agent', { description: 'audit the redactor', prompt: 'long...' })).toBe('Agent(audit the redactor)');
  });

  it('NotebookEdit also accepts the notebook_path alias', () => {
    expect(t('NotebookEdit', { notebook_path: '/a/n.ipynb' })).toBe('NotebookEdit(/a/n.ipynb)');
  });

  it('the headline field wins over an earlier-declared field', () => {
    // `description` comes first in insertion order but `command` is what Bash DOES.
    expect(t('Bash', { description: 'list the dir', command: 'ls -la' })).toBe('Bash(ls -la)');
  });

  it('unknown tool: first COMPACT string field; a payload blob is skipped', () => {
    expect(t('mcp__thing__do', { big: 'x'.repeat(500), tiny: 'ok' })).toBe('mcp__thing__do(ok)');
    expect(t('Whatever', { name: 'alpha', other: 'beta' })).toBe('Whatever(alpha)');
  });

  it('no usable field -> exactly today\'s bare stub', () => {
    expect(t('Nope', {})).toBe('Nope()');
    expect(t('Nope', { n: 5, ok: true, list: ['a'] })).toBe('Nope()');
    expect(t('Nope', { blob: 'x'.repeat(500) })).toBe('Nope()');   // nothing compact
    expect(t('Nope', undefined)).toBe('Nope()');
    expect(t('Nope', 'not-an-object')).toBe('Nope()');
    expect(t('Bash', { timeout: 5 })).toBe('Bash()');              // known tool, field missing
    expect(t('Bash', { command: '   ' })).toBe('Bash()');          // blank is not a summary
  });

  it('a nameless block renders nothing', () => {
    expect(renderToolUse({ type: 'tool_use', input: { command: 'ls' } })).toBe('');
    expect(renderToolUse(null)).toBe('');
  });
});

describe('renderToolUse — whitespace + truncation', () => {
  const t = (name, input) => renderToolUse({ type: 'tool_use', name, input });

  it('collapses newlines/tabs so a heredoc stays ONE line', () => {
    expect(t('Bash', { command: 'cat <<EOF\n\thello\n  world\nEOF' })).toBe('Bash(cat <<EOF hello world EOF)');
    expect(t('Bash', { command: '  leading and trailing  ' })).toBe('Bash(leading and trailing)');
  });

  it('truncates at the 60-char budget with a trailing ellipsis (boundary exact)', () => {
    expect(t('Bash', { command: 'a'.repeat(60) })).toBe(`Bash(${'a'.repeat(60)})`);   // 60 = untouched
    expect(t('Bash', { command: 'a'.repeat(61) })).toBe(`Bash(${'a'.repeat(59)}…)`);  // 61 = cut
    // the ellipsis lives INSIDE the budget: the rendered field is never longer than 60
    const long = t('Bash', { command: 'b'.repeat(5000) });
    expect(long.slice('Bash('.length, -1)).toHaveLength(60);
  });

  it('collapse happens before the budget, so a wrapped command is measured as one line', () => {
    const cmd = 'curl \\\n  --silent \\\n  https://station.local/api/queue/next-track-please';
    const out = t('Bash', { command: cmd });
    expect(out).not.toContain('\n');
    expect(out.endsWith('…)')).toBe(true);
  });
});

// The part that matters most: this text is posted into a WhatsApp chat.
describe('redactSecrets — every pattern (a leaked stub cannot be unposted)', () => {
  const gone = (raw, secret, expected) => {
    const out = redactSecrets(raw);
    expect(out).toBe(expected);
    expect(out).not.toContain(secret);
  };

  it('curl basic auth: -u / --user, spaced, =-joined, and glued', () => {
    gone('curl -u radio:hunter2 https://station.local/now', 'hunter2', 'curl -u *** https://station.local/now');
    gone('curl --user radio:hunter2 https://x', 'hunter2', 'curl --user *** https://x');
    gone('curl --user=radio:hunter2 https://x', 'hunter2', 'curl --user *** https://x');
    gone('curl -uradio:hunter2 https://x', 'hunter2', 'curl -u *** https://x');
    gone("curl -u 'radio:hunter 2' https://x", 'hunter 2', 'curl -u *** https://x');
  });

  it('Authorization headers (Bearer / Basic), keeping the enclosing quote', () => {
    gone('curl -H "Authorization: Bearer abc.def.ghi" https://api', 'abc.def.ghi',
      'curl -H "Authorization: Bearer ***" https://api');
    gone("curl -H 'Authorization: Basic Zm9vOmJhcg==' https://api", 'Zm9vOmJhcg==',
      "curl -H 'Authorization: Basic ***' https://api");
    gone('curl -H "Authorization: raw-token-value" https://api', 'raw-token-value',
      'curl -H "Authorization: ***" https://api');
  });

  it('a bare Bearer token, but not the English word', () => {
    gone('curl -H "Bearer abcdefghijklmnop" https://api', 'abcdefghijklmnop',
      'curl -H "Bearer ***" https://api');
    expect(redactSecrets('the bearer of bad news')).toBe('the bearer of bad news');
  });

  it('password=/passwd=/token=/api_key=/secret= in query strings AND env assignments', () => {
    gone("curl 'https://x/api?password=hunter2&q=1'", 'hunter2', "curl 'https://x/api?password=***&q=1'");
    gone('curl -d "api_key=abc123&x=1" https://x', 'abc123', 'curl -d "api_key=***&x=1" https://x');
    gone('EGPT_RELAY_PASSWORD=hunter2 node egpt.mjs', 'hunter2', 'EGPT_RELAY_PASSWORD=*** node egpt.mjs');
    gone('BEEPER_TOKEN=bpr_abc123 node x', 'bpr_abc123', 'BEEPER_TOKEN=*** node x');
    gone("SPEAKER_SECRET='s3 cr3t' ./play.sh", 's3 cr3t', 'SPEAKER_SECRET=*** ./play.sh');
    gone('psql "passwd=hunter2"', 'hunter2', 'psql "passwd=***"');
  });

  it('--password <x> / --token <x> flag forms', () => {
    gone('mysqldump --password hunter2 db', 'hunter2', 'mysqldump --password *** db');
    gone('cli --token abc123 --api-key=XYZ789', 'abc123', 'cli --token *** --api-key ***');
    gone('cli -token abc123', 'abc123', 'cli -token ***');
    // the separator is required, so a longer flag that merely STARTS with one is untouched
    expect(redactSecrets('cli --passthrough on')).toBe('cli --passthrough on');
  });

  it('credentials inline in a URL', () => {
    gone('git clone https://an:ghp_ABCDEFGHIJKL@github.com/siran/x.git', 'ghp_ABCDEFGHIJKL',
      'git clone https://***@github.com/siran/x.git');
    gone('curl http://admin:admin@speaker.local/play', 'admin:admin', 'curl http://***@speaker.local/play');
    // a bare username (no ':') is not a credential — keep it readable
    expect(redactSecrets('ssh://an@dolly')).toBe('ssh://an@dolly');
  });

  it('self-identifying key shapes with nothing to anchor on', () => {
    gone('node x.mjs sk-ant-api03-AAAABBBBCCCC', 'sk-ant-api03-AAAABBBBCCCC', 'node x.mjs ***');
    gone('gh auth login --with-token ghp_ABCDEFGHIJKLMNOP', 'ghp_ABCDEFGHIJKLMNOP', 'gh auth login --with-token ***');
    gone('curl -d eyJhbGciOiJIUzI1.cGF5bG9hZA.c2ln https://x', 'eyJhbGciOiJIUzI1.cGF5bG9hZA.c2ln', 'curl -d *** https://x');
  });

  it('leaves an innocent command completely alone', () => {
    const plain = 'git log --oneline -5 && npx vitest run tests/warm-cli-session.test.mjs';
    expect(redactSecrets(plain)).toBe(plain);
  });

  it('redaction runs BEFORE truncation — the ellipsis is never what hides a secret', () => {
    // The credential sits inside the first 60 chars: only the redactor can remove it.
    const cmd = 'curl -u radio:hunter2 https://station.local/api/queue?track=all-the-things';
    const out = renderToolUse({ type: 'tool_use', name: 'Bash', input: { command: cmd } });
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***');
    expect(out.endsWith('…)')).toBe(true);   // still truncated, on the redacted text
  });
});
