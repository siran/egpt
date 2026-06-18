import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildReplyRaw,
  classifyGmailMessage,
  createGmailApi,
  extractDraftText,
  formatGmailNotification,
  normalizeGmailConfig,
  parseGmailMessage,
  startGmailBridge,
} from '../src/bridges/gmail.mjs';

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function gmailMessage({ id = 'm1', threadId = 't1', from = 'Boss <boss@example.com>', subject = 'Budget', body = 'Please review.' } = {}) {
  return {
    id,
    threadId,
    labelIds: ['INBOX', 'IMPORTANT'],
    snippet: body.slice(0, 80),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'An <an@example.com>' },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@mail.example>` },
      ],
      body: { data: b64url(body) },
    },
  };
}

describe('Gmail bridge helpers', () => {
  it('normalizes conservative defaults', () => {
    const cfg = normalizeGmailConfig({ enabled: true, poll_seconds: 10, important_from: 'boss@example.com,@example.org' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.pollMs).toBe(15000);
    expect(cfg.query).toBe('in:inbox newer_than:7d');
    expect(cfg.importantFrom).toEqual(['boss@example.com', '@example.org']);
    expect(cfg.createDrafts).toBe(false);
    expect(cfg.proposeResponse).toBe(true);
  });

  it('parses headers and plain-text body', () => {
    const mail = parseGmailMessage(gmailMessage({ body: 'Line one\nLine two' }));
    expect(mail.fromEmail).toBe('boss@example.com');
    expect(mail.subject).toBe('Budget');
    expect(mail.body).toBe('Line one\nLine two');
    expect(mail.messageIdHeader).toBe('<m1@mail.example>');
  });

  it('classifies by Gmail important label and configured sender/terms', () => {
    const mail = parseGmailMessage(gmailMessage({ subject: 'Urgent invoice' }));
    expect(classifyGmailMessage(mail, {}).important).toBe(true);
    expect(classifyGmailMessage(mail, { ignore_from: ['boss@example.com'] }).ignored).toBe(true);
    expect(classifyGmailMessage({ ...mail, labelIds: [] }, { important_subject: ['invoice'] }).important).toBe(true);
    expect(classifyGmailMessage({ ...mail, labelIds: [], fromEmail: 'a@vip.com' }, { important_from: ['vip.com'] }).important).toBe(true);
  });

  it('builds a thread reply draft raw payload', () => {
    const mail = parseGmailMessage(gmailMessage());
    const raw = buildReplyRaw({ mail, body: 'Thanks, I will review.' });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toContain('To: Boss <boss@example.com>');
    expect(decoded).toContain('Subject: Re: Budget');
    expect(decoded).toContain('In-Reply-To: <m1@mail.example>');
    expect(decoded).toContain('Thanks, I will review.');
  });

  it('extracts the DRAFT section from e triage output', () => {
    expect(extractDraftText('SUMMARY: ok\nACTION: draft reply\nDRAFT:\nHello there')).toBe('Hello there');
    expect(extractDraftText('DRAFT:\n(none)')).toBe('');
  });

  it('formats a WhatsApp-safe notification', () => {
    const mail = parseGmailMessage(gmailMessage());
    const msg = formatGmailNotification(mail, { verdict: { reasons: ['sender boss@example.com'] }, draftText: 'I can reply.' });
    expect(msg).toContain('Gmail: important email');
    expect(msg).toContain('Thread: gmail:t1');
    expect(msg).toContain('Proposed response:');
  });
});

describe('Gmail API and poller', () => {
  it('refreshes OAuth, lists messages, fetches full messages, and creates drafts', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (u.includes('/messages?')) {
        expect(init.headers.Authorization).toBe('Bearer tok');
        return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 });
      }
      if (u.includes('/messages/m1')) {
        return new Response(JSON.stringify(gmailMessage()), { status: 200 });
      }
      if (u.includes('/drafts')) {
        const body = JSON.parse(init.body);
        expect(body.message.threadId).toBe('t1');
        expect(body.message.raw).toBeTruthy();
        return new Response(JSON.stringify({ id: 'draft-1', message: { id: 'dm1' } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    const api = createGmailApi({
      config: { client_id: 'cid', client_secret: 'sec', refresh_token: 'rt' },
      fetchImpl,
      clock: { now: () => 1000 },
    });
    expect(await api.listMessageIds({ query: 'in:inbox', maxResults: 1 })).toEqual(['m1']);
    const mail = parseGmailMessage(await api.getMessage('m1'));
    const draft = await api.createDraftReply(mail, 'Reply body');
    expect(draft.id).toBe('draft-1');
    expect(calls.filter(c => c.url.startsWith('https://oauth2.googleapis.com/token'))).toHaveLength(1);
  });

  it('polls unseen messages once, calls onImportant, and persists seen IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'egpt-gmail-test-'));
    const statePath = join(dir, 'gmail.json');
    try {
      const fetchImpl = vi.fn(async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
        }
        if (u.includes('/messages?')) {
          return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }), { status: 200 });
        }
        if (u.includes('/messages/m1')) {
          return new Response(JSON.stringify(gmailMessage()), { status: 200 });
        }
        if (u.includes('/drafts')) {
          return new Response(JSON.stringify({ id: 'draft-1' }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${u}`);
      });
      const important = [];
      const bridge = startGmailBridge({
        config: {
          enabled: true,
          client_id: 'cid',
          client_secret: 'sec',
          refresh_token: 'rt',
          notify_all: true,
          create_drafts: true,
        },
        statePath,
        fetchImpl,
        autoStart: false,
        onImportant: async (mail, helpers) => {
          important.push(mail.id);
          await helpers.createDraft('Draft body');
        },
      });
      expect(await bridge.pollNow()).toEqual({ processed: 1, important: 1 });
      expect(await bridge.pollNow()).toEqual({ processed: 0, important: 0 });
      expect(important).toEqual(['m1']);
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      expect(state.seenMessageIds).toEqual(['m1']);
      bridge.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
