import { describe, expect, it } from 'vitest';
import {
  COMPOSE_SCOPE,
  READONLY_SCOPE,
  buildAuthUrl,
  makePkce,
  mergeGmailConfig,
  parseArgs,
} from '../setup/gmail-oauth.mjs';

describe('gmail oauth setup helper', () => {
  it('parses bool negation and valued flags', () => {
    expect(parseArgs([
      '--client-id', 'abc',
      '--client-secret=def',
      '--no-compose',
      '--notify-all',
    ])).toEqual({
      'client-id': 'abc',
      'client-secret': 'def',
      compose: false,
      'notify-all': true,
    });
  });

  it('builds an installed-app consent URL that requests offline access', () => {
    const url = new URL(buildAuthUrl({
      clientId: 'client.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:43111/oauth2/callback',
      scopes: [READONLY_SCOPE, COMPOSE_SCOPE],
      state: 'state123',
      codeChallenge: 'challenge123',
      loginHint: 'me@example.com',
    }));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43111/oauth2/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('login_hint')).toBe('me@example.com');
    expect(url.searchParams.get('scope')).toContain(READONLY_SCOPE);
    expect(url.searchParams.get('scope')).toContain(COMPOSE_SCOPE);
  });

  it('creates PKCE material in base64url form', () => {
    const { verifier, challenge } = makePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('merges gmail settings without clobbering unrelated config', () => {
    const merged = mergeGmailConfig({
      theme: 'catppuccin',
      gmail: {
        important_from: ['boss@example.com'],
        create_drafts: false,
      },
    }, {
      enabled: true,
      client_id: 'id',
      refresh_token: 'rt',
    });

    expect(merged).toEqual({
      theme: 'catppuccin',
      gmail: {
        important_from: ['boss@example.com'],
        create_drafts: false,
        enabled: true,
        client_id: 'id',
        refresh_token: 'rt',
      },
    });
  });
});
