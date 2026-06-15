import { existsSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDispatchRuntime, isBrainFailureResult } from '../dispatch.mjs';
import { parse, serialize } from '../conversations-state.mjs';

describe('isBrainFailureResult — tool/infra errors are NOT a sibling reply', () => {
  it('detects the failure shapes that must not be emitted/recirculated', () => {
    expect(isBrainFailureResult('!! spawn claude ENOENT')).toBe(true);   // the Don loop (2026-06-14)
    expect(isBrainFailureResult('!! @l: llama: fetch failed')).toBe(true);
    expect(isBrainFailureResult('[claude exit 1]')).toBe(true);
    expect(isBrainFailureResult('[codex timed out]')).toBe(true);
    expect(isBrainFailureResult('boom: invalid_request_error')).toBe(true);
  });
  it('treats a real reply OR the bridge failure-notice as NOT a failure (so they still emit)', () => {
    expect(isBrainFailureResult('¡Hola hermano! Wren aquí.')).toBe(false);
    expect(isBrainFailureResult('…')).toBe(false);
    expect(isBrainFailureResult('⚠️ couldn\'t answer (bridge): spawn claude ENOENT')).toBe(false);
    expect(isBrainFailureResult('')).toBe(false);
  });
});

const fixedClock = () => new Date('2026-05-21T12:00:00.000Z');

const tempDirs = [];

async function makeTempDir() {
  const dir = await realFs.mkdtemp(join(tmpdir(), 'egpt-dispatch-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir =>
    realFs.rm(dir, { recursive: true, force: true })));
});

async function readActivity(dir) {
  return realFs.readFile(join(dir, 'state', 'e-activity.log'), 'utf8');
}

async function readConvState(dir) {
  return parse(await realFs.readFile(join(dir, 'conversations.yaml'), 'utf8'));
}

async function makeRuntime(opts = {}) {
  const stateDir = opts.stateDir ?? await makeTempDir();
  const sends = [];
  const brainCalls = [];
  const errors = [];
  const bridge = opts.bridge ?? {
    send: async (body, sendOpts) => {
      sends.push({ body, opts: sendOpts });
      return Object.hasOwn(opts, 'sendResult') ? opts.sendResult : { ok: true };
    },
  };
  const brain = opts.brain ?? {
    stream: async (payload, onPartial, sessionOpts) => {
      brainCalls.push({ payload, sessionOpts });
      if (opts.brainError) throw opts.brainError;
      const reply = typeof opts.reply === 'function'
        ? await opts.reply({ payload, sessionOpts })
        : (opts.reply ?? 'hello back');
      return reply;
    },
  };
  const runtime = createDispatchRuntime({
    brain,
    bridge,
    clock: opts.clock ?? fixedClock,
    findThreadJsonl: opts.findThreadJsonl,
    fs: opts.fs,
    getSelfDmConfig: opts.getSelfDmConfig,
    logger: { error: (msg) => errors.push(String(msg)) },
    migrations: opts.migrations,
    notifyOperator: opts.notifyOperator,
    personaEmoji: opts.personaEmoji ?? '🐶',
    personaName: opts.personaName ?? 'egpt',
    readPersonality: opts.readPersonality,
    readPersonalityMeta: opts.readPersonalityMeta,
    recordDefaultSession: opts.recordDefaultSession,
    resolveBrain: opts.resolveBrain,
    runWarmBrainTurn: opts.runWarmBrainTurn,
    selfDmConfig: opts.selfDmConfig,
    sessionOptions: opts.sessionOptions,
    stateDir,
    sysLog: opts.sysLog,
    systemCwd: opts.systemCwd,
  });
  // Mirror the production bridge: the runtime's WA reply gate now fails CLOSED
  // (replyAllowed must be EXPLICITLY true), so supply replyAllowed from the
  // message's @e mention when a test didn't set it — exactly what the bridge
  // (egpt.mjs onIncoming) computes before calling the runtime.
  const _origSubmitIncoming = runtime.submitIncoming.bind(runtime);
  runtime.submitIncoming = (text, meta = {}) => {
    const replyAllowed = meta.replyAllowed
      ?? (meta.fromWhatsApp ? /(^|\s)@(?:egpt|e)\b/i.test(String(text ?? '')) : undefined);
    return _origSubmitIncoming(text, { ...meta, replyAllowed });
  };
  return { brainCalls, bridge, errors, runtime, sends, stateDir };
}

describe('dispatch runtime', () => {
  it('routes one bridge message to the brain and sends the reply', async () => {
    const { brainCalls, runtime, sends, stateDir } = await makeRuntime({
      reply: { text: 'done', optionsPatch: { sessionId: 'sess-a' } },
    });

    const result = await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waChatName: 'Alice',
      waSlug: 'alice',
    });

    expect(result.kind).toBe('reply');
    expect(brainCalls).toHaveLength(1);
    expect(brainCalls[0].payload.message).toBe('hello');
    expect(sends).toEqual([
      // personaReply marks this as a provable persona reply on the WA bridge
      // (operator 2026-06-08 anti-leak rewrite) so a later quote-reply to it
      // authorizes reply-to-E; system/raw sends omit it.
      { body: '🐶 egpt: done', opts: { chatId: 'chat-a', personaReply: 'egpt' } },
    ]);
    const activity = await readActivity(stateDir);
    expect(activity).toContain('\tRECV\twa/chat-a\t5ch');
    expect(activity).toContain('\tREPLY\twa/chat-a\t4ch\t0ms');
  });

  it('wraps the first turn for a new contact with the lineage prelude', async () => {
    const { brainCalls, runtime } = await makeRuntime({
      readPersonality: async () => 'PERSONALITY BODY',
    });

    await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waChatName: 'Alice',
      waSlug: 'alice',
    });

    expect(brainCalls).toHaveLength(1);
    const wrappedText = brainCalls[0].payload.message;
    expect(wrappedText).toContain('You are eGPT');
    expect(wrappedText).toContain('The following profile describes your current operating mode');
    expect(wrappedText).toContain('PERSONALITY BODY');
    expect(wrappedText).toContain('Live message from the chat follows');
    expect(wrappedText).toMatch(/hello\s*$/);
  });

  it('runs ccode conversation-e through the warm runner and persists the minted thread', async () => {
    const coldCalls = [];
    const warmCalls = [];
    const stateDir = await makeTempDir();
    const runtime = createDispatchRuntime({
      brain: {
        stream: async (...args) => {
          coldCalls.push(args);
          throw new Error('cold path should not run');
        },
      },
      clock: fixedClock,
      logger: { error: () => {} },
      resolveBrain: () => ({
        brain: { stream: async () => 'cold' },
        brainType: 'ccode',
        dbCfg: { type: 'ccode', model: 'haiku', allowed_tools: 'all' },
      }),
      runWarmBrainTurn: async (call) => {
        warmCalls.push(call);
        return { text: 'warm hello', optionsPatch: { sessionId: 'warm-e-thread' } };
      },
      sessionOptions: ({ dbCfg }) => ({
        sessionId: dbCfg.session_id ?? null,
        model: dbCfg.model,
        allowedTools: dbCfg.allowed_tools,
      }),
      stateDir,
    });

    const reply = await runtime.runDefaultBrainTurn('Alice@[Auge].wa (12:00): hi', () => {}, {
      threadId: 'wa-chat-1',
      surface: 'wa',
      slug: 'auge',
      name: 'Auge',
    });

    expect(reply).toBe('warm hello');
    expect(coldCalls).toHaveLength(0);
    expect(warmCalls).toHaveLength(1);
    const state = await readConvState(stateDir);
    const slug = state.contacts.whatsapp['wa-chat-1'].slug;
    expect(warmCalls[0]).toMatchObject({
      key: `e:ccode:whatsapp:${slug}`,
      klass: 'conversation',
      brainType: 'ccode',
      sessionOpts: { sessionId: null, model: 'haiku', allowedTools: 'all' },
    });
    expect(warmCalls[0].text).toContain('Alice@[Auge].wa');
    expect(state.contacts.whatsapp['wa-chat-1'].threadId).toBe('warm-e-thread');
  });

  it('auto-elevates configured operator DMs to system personality', async () => {
    const stateDir = await makeTempDir();
    await realFs.writeFile(join(stateDir, 'conversations.yaml'), serialize({
      contacts: {
        whatsapp: {
          'wa-self': { slug: 'wa-self', personality: 'default', threadId: 'old-wa' },
        },
        telegram: {
          'tg-self': { slug: 'tg-self', personality: 'default', threadId: 'old-tg' },
        },
      },
    }), 'utf8');
    const logs = [];
    const { runtime } = await makeRuntime({
      stateDir,
      selfDmConfig: { whatsapp: 'wa-self', telegram: 'tg-self' },
      sysLog: (msg) => logs.push(msg),
    });

    const state = await runtime.readState();

    expect(state.contacts.whatsapp['wa-self'].personality).toBe('system');
    expect(state.contacts.whatsapp['wa-self'].threadId).toBeNull();
    expect(state.contacts.telegram['tg-self'].personality).toBe('system');
    expect(state.contacts.telegram['tg-self'].threadId).toBeNull();
    expect(logs.some(line => line.includes('auto-elevated whatsapp self-DM'))).toBe(true);
    expect(logs.some(line => line.includes('auto-elevated telegram self-DM'))).toBe(true);
  });

  it('recovers a moved thread cwd and retries the brain turn', async () => {
    const stateDir = await makeTempDir();
    const oldCwd = join(stateDir, 'old-cwd');
    const newCwd = join(stateDir, 'new-cwd');
    await realFs.writeFile(join(stateDir, 'conversations.yaml'), serialize({
      contacts: {
        whatsapp: {
          'chat-a': {
            slug: 'alice',
            personality: 'default',
            threadId: 'thread-old',
            threadCwd: oldCwd,
          },
        },
      },
    }), 'utf8');

    let replyAttempts = 0;
    let candidateCwds = null;
    const { brainCalls, runtime, sends } = await makeRuntime({
      stateDir,
      findThreadJsonl: (threadId, candidates) => {
        candidateCwds = candidates;
        expect(threadId).toBe('thread-old');
        return { cwd: newCwd };
      },
      reply: () => {
        replyAttempts++;
        if (replyAttempts === 1) throw new Error('resume failed');
        return { text: 'recovered' };
      },
    });

    await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waChatName: 'alice',   // matches the pre-seeded slug so name-tracking doesn't re-slug mid-recovery
      waSlug: 'alice',
    });

    expect(brainCalls).toHaveLength(2);
    expect(brainCalls[0].sessionOpts.cwd).toBe(oldCwd);
    expect(brainCalls[1].sessionOpts.cwd).toBe(newCwd);
    expect(candidateCwds).toContain(join(stateDir, 'conversations', 'whatsapp', 'alice'));
    expect(sends[0].body).toContain('recovered');
    const state = await readConvState(stateDir);
    expect(state.contacts.whatsapp['chat-a'].threadCwd).toBe(newCwd);
  });

  it('clears a stale per-contact resume thread and retries fresh', async () => {
    const stateDir = await makeTempDir();
    await realFs.writeFile(join(stateDir, 'conversations.yaml'), serialize({
      contacts: {
        whatsapp: {
          '12345@lid': {
            slug: 'alice',
            personality: 'default',
            threadId: 'stale-thread',
          },
        },
      },
    }), 'utf8');

    let attempts = 0;
    const logs = [];
    const sends = [];
    const brainCalls = [];
    const runtime = createDispatchRuntime({
      stateDir,
      sysLog: (msg) => logs.push(msg),
      clock: fixedClock,
      logger: { error: () => {} },
      bridge: {
        send: async (body, opts) => {
          sends.push({ body, opts });
          return { ok: true };
        },
      },
      brain: {
        stream: async (payload, onPartial, sessionOpts) => {
          brainCalls.push({ payload, sessionOpts });
          attempts++;
          if (attempts === 1) {
            return {
              text: 'thread/resume failed: no rollout found for thread id stale-thread',
              optionsPatch: { sessionId: 'stale-thread' },
            };
          }
          return { text: 'fresh ok', optionsPatch: { sessionId: 'fresh-thread' } };
        },
      },
    });

    await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      replyAllowed: true,   // this test builds its own runtime (not the wrapped makeRuntime one)
      waChatId: '12345@lid',
      waChatName: 'alice',   // matches the pre-seeded slug so name-tracking doesn't re-slug mid-recovery
      waSlug: 'alice',
    });

    expect(brainCalls).toHaveLength(2);
    expect(brainCalls[0].sessionOpts.sessionId).toBe('stale-thread');
    expect(brainCalls[1].sessionOpts.sessionId).toBe(null);
    expect(sends[0].body).toContain('fresh ok');
    expect(logs.some(line => line.includes('could not be resumed'))).toBe(true);
    const state = await readConvState(stateDir);
    expect(state.contacts.whatsapp['12345@lid'].threadId).toBe('fresh-thread');
  });

  it('notifies the operator when a contact turn fails without recovery', async () => {
    const stateDir = await makeTempDir();
    await realFs.writeFile(join(stateDir, 'conversations.yaml'), serialize({
      contacts: {
        whatsapp: {
          'chat-a': {
            slug: 'alice',
            personality: 'default',
            threadId: 'thread-old',
            threadCwd: join(stateDir, 'old-cwd'),
          },
        },
      },
    }), 'utf8');
    const notices = [];
    const { runtime, sends } = await makeRuntime({
      stateDir,
      brainError: new Error('brain exploded'),
      notifyOperator: async (message) => notices.push(message),
    });

    const result = await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waChatName: 'alice',   // matches the pre-seeded slug so name-tracking doesn't re-slug mid-failure
      waSlug: 'alice',
    });

    expect(result.kind).toBe('silence');
    expect(sends).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('[egpt] contact "alice" turn failed.');
    expect(notices[0]).toContain('threadId: thread-old');
    expect(notices[0]).toContain('brain exploded');
  });

  it('preserves both contacts during concurrent two-chat arrivals', async () => {
    let sessionCounter = 0;
    const { brainCalls, runtime, stateDir } = await makeRuntime({
      reply: async ({ sessionOpts }) => ({
        text: `ok ${sessionOpts.cwd}`,
        optionsPatch: { sessionId: `sess-${++sessionCounter}` },
      }),
    });

    await Promise.all([
      runtime.submitIncoming('@e first', {
        fromWhatsApp: true,
        waChatId: 'chat-a',
        waChatName: 'Alice',
        waSlug: 'alice',
      }),
      runtime.submitIncoming('@e second', {
        fromWhatsApp: true,
        waChatId: 'chat-b',
        waChatName: 'Bob',
        waSlug: 'bob',
      }),
    ]);

    const state = await readConvState(stateDir);
    expect(Object.keys(state.contacts.whatsapp).sort()).toEqual(['chat-a', 'chat-b']);
    expect(state.contacts.whatsapp['chat-a'].slug).toMatch(/^Alice-/);   // slug preserves the title's case
    expect(state.contacts.whatsapp['chat-b'].slug).toMatch(/^Bob-/);
  });

  it('retries an interrupted migration and recovers idempotently', async () => {
    let attempts = 0;
    const migration = async ({ readState, writeState }) => {
      attempts++;
      const state = await readState();
      const whatsapp = state.contacts?.whatsapp ?? {};
      if (!whatsapp['legacy-chat']) {
        await writeState({
          ...state,
          contacts: {
            ...(state.contacts ?? {}),
            whatsapp: {
              ...whatsapp,
              'legacy-chat': { slug: 'legacy-chat', personality: 'default' },
            },
          },
        });
      }
      if (attempts === 1) throw new Error('migration interrupted');
    };
    const { runtime, stateDir } = await makeRuntime({ migrations: [migration] });

    await expect(runtime.submitIncoming('@e first try', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waSlug: 'alice',
    })).rejects.toThrow(/migration interrupted/);

    await runtime.submitIncoming('@e retry', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waSlug: 'alice',
    });

    const state = await readConvState(stateDir);
    expect(attempts).toBe(2);
    expect(state.contacts.whatsapp['legacy-chat']).toBeTruthy();
    expect(state.contacts.whatsapp['chat-a']).toBeTruthy();
  });

  it('continues dispatch when transcript writes fail and logs the error', async () => {
    const failingFs = {
      ...realFs,
      existsSync,
      appendFile: async (path, body, enc) => {
        if (String(path).endsWith('transcript.md')) {
          throw new Error('transcript write denied');
        }
        return realFs.appendFile(path, body, enc);
      },
    };
    const { errors, runtime, sends } = await makeRuntime({
      fs: failingFs,
      reply: 'still delivered',
    });

    await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waSlug: 'alice',
    });

    expect(sends).toHaveLength(1);
    expect(sends[0].body).toContain('still delivered');
    expect(errors.some(e => e.includes('transcript') && e.includes('write denied'))).toBe(true);
  });

  it('does not call bridge.send when the brain returns silence', async () => {
    const { brainCalls, runtime, sends } = await makeRuntime({ reply: '…' });

    const result = await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waSlug: 'alice',
    });

    expect(result.kind).toBe('silence');
    expect(brainCalls).toHaveLength(1);
    expect(sends).toHaveLength(0);
  });

  it('the MODE GATE is authoritative: a non-silence reply is suppressed when replyAllowed is not true (no leak)', async () => {
    // The leak (operator 2026-06-04, Joyce, mention mode, no @e): the gate was
    // fail-OPEN (`replyAllowed === false`) and checked AFTER the silence test,
    // so a "…\n\n<reflection>" reply — NOT pure silence — sailed through and was
    // sent. The model's reply text must be IRRELEVANT: anything other than an
    // explicit replyAllowed:true on WA gets nothing delivered.
    const reflection = '…\n\nAnd here we see the caring side of collaboration.';
    const { brainCalls, runtime, sends } = await makeRuntime({ reply: reflection });
    const result = await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      replyAllowed: false,   // mention-mode with no @e: the bridge says do-not-reply
      waChatId: 'chat-a',
      waSlug: 'alice',
    });
    expect(result.kind).toBe('suppressed');   // NOT 'reply', NOT 'silence' — the body is irrelevant
    expect(brainCalls).toHaveLength(1);        // E still READ it for context
    expect(sends).toHaveLength(0);             // but nothing reached the chat
  });

  it('records SEND-FAIL activity when bridge.send returns null', async () => {
    const { runtime, sends, stateDir } = await makeRuntime({
      reply: 'cannot deliver',
      sendResult: null,
    });

    await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-a',
      waSlug: 'alice',
    });

    expect(sends).toHaveLength(1);
    const activity = await readActivity(stateDir);
    expect(activity).toContain('\tSEND-FAIL\twa/chat-a\twa bridge.send returned null');
  });

  it('skips muted contacts without dispatching the brain', async () => {
    const stateDir = await makeTempDir();
    await realFs.writeFile(join(stateDir, 'conversations.yaml'), serialize({
      contacts: {
        whatsapp: {
          'chat-muted': { slug: 'muted-chat', personality: 'mute' },
        },
      },
    }), 'utf8');
    const { brainCalls, runtime, sends } = await makeRuntime({ stateDir });

    const result = await runtime.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-muted',
      waChatName: 'Muted',
      waSlug: 'muted-chat',
    });

    expect(result.kind).toBe('silence');
    expect(brainCalls).toHaveLength(0);
    expect(sends).toHaveLength(0);
    const activity = await readActivity(stateDir);
    expect(activity).toContain('\tSKIP\twa/chat-muted\tmuted');
  });

  it('skips observe-only non-persona messages and logs the skip', async () => {
    const { brainCalls, runtime, sends, stateDir } = await makeRuntime();

    const result = await runtime.submitIncoming('plain chatter', {
      fromWhatsApp: true,
      observeOnly: true,
      waChatId: 'chat-observed',
      waSlug: 'observed',
    });

    expect(result.kind).toBe('skip');
    expect(brainCalls).toHaveLength(0);
    expect(sends).toHaveLength(0);
    const activity = await readActivity(stateDir);
    expect(activity).toContain('\tSKIP\twa/chat-observed\tobserve-only empty');
  });

  // Security: per-personality tool allowlist (task #25). Without this,
  // every conversation-e inherited the brain's full tool set, meaning
  // a contact could in principle talk the model into shelling out
  // (running outbox-write commands, etc.).
  it('per-personality allowed_tools scopes sessionOpts.allowedTools', async () => {
    // Default personality on a fresh contact → restrictive tool set.
    const { brainCalls: defCalls, runtime: defRt } = await makeRuntime({
      reply: 'ok',
      readPersonalityMeta: async (name) => ({
        allowed_tools: name === 'system' ? 'all' : ['Read', 'Grep', 'Glob'],
      }),
    });
    await defRt.submitIncoming('@e hello', {
      fromWhatsApp: true,
      waChatId: 'chat-default',
      waSlug: 'def',
    });
    expect(defCalls[0].sessionOpts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);

    // System personality (via pre-seeded contact) → 'all' tools.
    const stateDir = await makeTempDir();
    await realFs.writeFile(join(stateDir, 'conversations.yaml'), serialize({
      contacts: {
        whatsapp: {
          'chat-sys': { slug: 'sys-chat', personality: 'system' },
        },
      },
    }), 'utf8');
    const { brainCalls: sysCalls, runtime: sysRt } = await makeRuntime({
      stateDir,
      reply: 'ok',
      readPersonalityMeta: async (name) => ({
        allowed_tools: name === 'system' ? 'all' : ['Read', 'Grep', 'Glob'],
      }),
    });
    await sysRt.submitIncoming('@e hola', {
      fromWhatsApp: true,
      waChatId: 'chat-sys',
      waSlug: 'sys-chat',
    });
    expect(sysCalls[0].sessionOpts.allowedTools).toBe('all');
  });

  it('falls back to the configured default-brain fallback when the primary throws', async () => {
    const calls = [];
    const recorded = [];
    const primary = {
      stream: async () => {
        calls.push({ brain: 'primary' });
        throw new Error('primary down');
      },
    };
    const fallback = {
      stream: async (_payload, _onPartial, sessionOpts) => {
        calls.push({ brain: 'fallback', sessionOpts });
        return { text: 'fallback ok', optionsPatch: { sessionId: 'fallback-thread' } };
      },
    };
    const { runtime } = await makeRuntime({
      resolveBrain: () => ({
        brain: primary,
        brainType: 'codex',
        dbCfg: { type: 'codex', session_id: 'codex-thread', model: 'gpt-5.4-mini' },
        fallback: {
          brain: fallback,
          brainType: 'claude-sdk',
          dbCfg: { type: 'claude-sdk', session_id: 'haiku-thread', model: 'haiku' },
        },
      }),
      sessionOptions: ({ dbCfg }) => ({ sessionId: dbCfg.session_id ?? null, model: dbCfg.model }),
      recordDefaultSession: async (entry) => recorded.push(entry),
    });

    const reply = await runtime.runDefaultBrainTurn('hello', () => {}, { threadId: 'shell', surface: 'shell' });

    expect(reply).toBe('fallback ok');
    expect(calls.map(c => c.brain)).toEqual(['primary', 'fallback']);
    expect(calls[1].sessionOpts.sessionId).toBe('haiku-thread');
    expect(calls[1].sessionOpts.model).toBe('haiku');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].sessionId).toBe('fallback-thread');
    expect(recorded[0].brainType).toBe('claude-sdk');
  });

  it('falls back when the primary returns a failure-looking text result', async () => {
    const calls = [];
    const primary = {
      stream: async () => {
        calls.push('primary');
        return { text: '!! primary unavailable' };
      },
    };
    const fallback = {
      stream: async () => {
        calls.push('fallback');
        return { text: 'fallback text' };
      },
    };
    const { runtime } = await makeRuntime({
      resolveBrain: () => ({
        brain: primary,
        brainType: 'claude-sdk',
        dbCfg: { type: 'claude-sdk', model: 'haiku' },
        fallback: {
          brain: fallback,
          brainType: 'codex',
          dbCfg: { type: 'codex', model: 'gpt-5.4-mini' },
        },
      }),
      sessionOptions: ({ dbCfg }) => ({ model: dbCfg.model }),
    });

    const reply = await runtime.runDefaultBrainTurn('hello', () => {}, { threadId: 'shell', surface: 'shell' });

    expect(reply).toBe('fallback text');
    expect(calls).toEqual(['primary', 'fallback']);
  });
});
