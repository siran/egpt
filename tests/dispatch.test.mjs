import { existsSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDispatchRuntime } from '../dispatch.mjs';
import { parse, serialize } from '../conversations-state.mjs';

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
    recordDefaultSession: opts.recordDefaultSession,
    resolveBrain: opts.resolveBrain,
    selfDmConfig: opts.selfDmConfig,
    stateDir,
    sysLog: opts.sysLog,
    systemCwd: opts.systemCwd,
  });
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
      { body: '🐶 egpt: done', opts: { chatId: 'chat-a' } },
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
      waChatName: 'Alice',
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
      waChatName: 'Alice',
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
    expect(state.contacts.whatsapp['chat-a'].slug).toMatch(/^alice-/);
    expect(state.contacts.whatsapp['chat-b'].slug).toMatch(/^bob-/);
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
});
