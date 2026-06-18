import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  applyLocalConfigOverlaySync,
  configLoadFailureAlertBody,
  configLoadFailureConsoleMessage,
  missingWhatsappConfigKeys,
  shallowDeepMerge,
  writeConfigLoadFailureAlertSync,
} from '../src/spine-boot.mjs';

describe('spine boot helpers', () => {
  it('one-level merges local config blocks without clobbering sibling keys', () => {
    const merged = shallowDeepMerge({
      theme: 'catppuccin',
      whatsapp: {
        chat_id: 'self',
        auto_e_chats: ['self'],
        client_name: 'wa',
      },
      siblings: {
        don: { cwd: 'C:/old' },
      },
    }, {
      whatsapp: {
        client_name: 'moto',
      },
      siblings: {
        wren: { cwd: 'C:/new' },
      },
    });

    expect(merged).toEqual({
      theme: 'catppuccin',
      whatsapp: {
        chat_id: 'self',
        auto_e_chats: ['self'],
        client_name: 'moto',
      },
      siblings: {
        don: { cwd: 'C:/old' },
        wren: { cwd: 'C:/new' },
      },
    });
  });

  it('applies a local JSON overlay and reports corrupt overlays without changing config', () => {
    const base = { theme: 'catppuccin', whatsapp: { chat_id: 'self' } };
    const ok = applyLocalConfigOverlaySync(base, 'config.local.json', {
      readFileSync: () => '{"whatsapp":{"client_name":"wa2"},"show_prompts":true}',
    });

    expect(ok.error).toBeNull();
    expect(ok.config).toEqual({
      theme: 'catppuccin',
      show_prompts: true,
      whatsapp: { chat_id: 'self', client_name: 'wa2' },
    });

    const corrupt = applyLocalConfigOverlaySync(base, 'config.local.json', {
      readFileSync: () => '{bad json',
    });
    expect(corrupt.config).toBe(base);
    expect(corrupt.error).toBeInstanceOf(SyntaxError);

    const missing = applyLocalConfigOverlaySync(base, 'config.local.json', {
      readFileSync: () => {
        const e = new Error('missing');
        e.code = 'ENOENT';
        throw e;
      },
    });
    expect(missing).toEqual({ config: base, error: null });
  });

  it('names exactly which required WhatsApp boot keys are absent', () => {
    expect(missingWhatsappConfigKeys({})).toEqual(['whatsapp (whole section)']);
    expect(missingWhatsappConfigKeys({ whatsapp: null })).toEqual(['whatsapp (whole section)']);
    expect(missingWhatsappConfigKeys({ whatsapp: { chat_id: 'self' } })).toEqual([
      'whatsapp.allowed_users',
      'whatsapp.auto_e_chats',
    ]);
    expect(missingWhatsappConfigKeys({
      whatsapp: { chat_id: 'self', allowed_users: [], auto_e_chats: [] },
    })).toEqual([]);
  });

  it('builds the operator-facing config-load failure messages', () => {
    const error = new Error('yaml parser exploded');
    expect(configLoadFailureConsoleMessage(error)).toContain('readConfigSync FAILED');
    expect(configLoadFailureConsoleMessage(error)).toContain('observe-only-SKIP');

    const body = configLoadFailureAlertBody(error);
    expect(body).toContain('config load FAILED');
    expect(body).toContain('yaml parser exploded');
    expect(body).toContain('Restart after fixing');
  });

  it('writes a deterministic boot-failure outbox event', () => {
    const writes = [];
    const { id, event } = writeConfigLoadFailureAlertSync({
      egptHome: 'C:/Users/an/.egpt',
      jid: 'self@lid',
      now: () => 12345,
      error: new Error('broken config'),
      write: (path, body) => writes.push({ path, body }),
    });

    expect(id).toBe('12345-bootfail');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(join('C:/Users/an/.egpt', 'outbox', '12345-bootfail.json'));
    expect(JSON.parse(writes[0].body)).toEqual(event);
    expect(event).toMatchObject({
      type: 'wa-send',
      from: 'system',
      ts: 12345,
      jid: 'self@lid',
    });
    expect(event.body).toContain('broken config');
  });
});
