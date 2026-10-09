// tests/chrome-creds.test.mjs — the PARSING + BRANCHING of readChromeCredential, with the three
// live-only seams (Local State read, PowerShell DPAPI-unprotect, node:sqlite logins read) MOCKED.
// The real DPAPI/SQLite path is Windows + live-only and already validated by the operator's probe,
// so it is NOT exercised here. What IS exercised for real is the AES-256-GCM split + decrypt: the
// fakes hand it genuine v10 blobs built with node:crypto and a known key, so the nonce/ct/tag split
// and the registrable-domain match are proven without a live profile.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { readChromeCredential } from '../src/tools/chrome-creds.mjs';

const AES_KEY = crypto.randomBytes(32);

// A real Chrome-style v10 password blob: 'v10' + 12-byte nonce + ciphertext + 16-byte GCM tag.
function v10blob(plaintext, key = AES_KEY) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ct, c.getAuthTag()]);
}

// Build the three seams. The Local State carries base64( "DPAPI" + <opaque protected bytes> ) just
// like Chrome's; the fake PowerShell ignores that blob and returns the KNOWN key (real DPAPI is
// live-only), while `onPsScript` lets a test inspect exactly what was embedded in the PS command.
function makeSeams({ key = AES_KEY, dpapiPrefix = true, rows = [], onPsScript = () => {} } = {}) {
  const protectedKey = Buffer.concat([
    dpapiPrefix ? Buffer.from('DPAPI', 'latin1') : Buffer.alloc(0),
    Buffer.from('opaque-protected-key-bytes'),
  ]);
  const localState = JSON.stringify({ os_crypt: { encrypted_key: protectedKey.toString('base64') } });
  return {
    readFile: (p) => {
      if (String(p).endsWith('Local State')) return localState;
      throw new Error(`unexpected readFile ${p}`);
    },
    runPowerShell: (script) => { onPsScript(script); return Buffer.from(key).toString('base64'); },
    readLogins: async () => rows,
  };
}

const classdojoRows = [{ origin_url: 'https://www.classdojo.com/', username_value: 'parent@example.com', password_value: v10blob('clsdjo-pass!') }];

describe('readChromeCredential — the happy path + v10 split', () => {
  it('decrypts the matching row and returns { username, password }', async () => {
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, makeSeams({ rows: classdojoRows }));
    expect(got).toEqual({ username: 'parent@example.com', password: 'clsdjo-pass!' });
  });

  it('handles node:sqlite BLOBs returned as Uint8Array (not Buffer)', async () => {
    const rows = [{ origin_url: 'https://www.classdojo.com/', username_value: 'p@x.com', password_value: new Uint8Array(v10blob('u8-pass')) }];
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, makeSeams({ rows }));
    expect(got).toEqual({ username: 'p@x.com', password: 'u8-pass' });
  });
});

describe('readChromeCredential — registrable-domain match', () => {
  it('matches across subdomains on the PAGE side (home.classdojo.com ↔ saved www.classdojo.com)', async () => {
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'home.classdojo.com' }, makeSeams({ rows: classdojoRows }));
    expect(got?.password).toBe('clsdjo-pass!');
  });

  it('matches across subdomains on the SAVED side (saved accounts.google.com ↔ mail.google.com)', async () => {
    const rows = [{ origin_url: 'https://accounts.google.com/signin', username_value: 'me@gmail.com', password_value: v10blob('g-pass') }];
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'mail.google.com' }, makeSeams({ rows }));
    expect(got).toEqual({ username: 'me@gmail.com', password: 'g-pass' });
  });

  it('a different registrable domain does not match → null', async () => {
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'example.org' }, makeSeams({ rows: classdojoRows }));
    expect(got).toBeNull();
  });
});

describe('readChromeCredential — the null branches', () => {
  it('no saved rows → null', async () => {
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, makeSeams({ rows: [] }));
    expect(got).toBeNull();
  });

  it('a matching row whose password is NOT a v10/v11 blob → skipped → null', async () => {
    const rows = [{ origin_url: 'https://www.classdojo.com/', username_value: 'x', password_value: Buffer.concat([Buffer.from('v99', 'latin1'), crypto.randomBytes(30)]) }];
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, makeSeams({ rows }));
    expect(got).toBeNull();
  });

  it('a master key that is not 32 bytes → null', async () => {
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, makeSeams({ rows: classdojoRows, key: crypto.randomBytes(16) }));
    expect(got).toBeNull();
  });

  it('missing profilePath or domain → null', async () => {
    expect(await readChromeCredential({ domain: 'classdojo.com' }, makeSeams({ rows: classdojoRows }))).toBeNull();
    expect(await readChromeCredential({ profilePath: 'C:/fake/brain' }, makeSeams({ rows: classdojoRows }))).toBeNull();
  });

  it('a throwing seam collapses to null (never throws out)', async () => {
    const seams = makeSeams({ rows: classdojoRows });
    seams.runPowerShell = () => { throw new Error('powershell blew up'); };
    await expect(readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, seams)).resolves.toBeNull();
  });
});

describe('readChromeCredential — the DPAPI prefix strip', () => {
  it('strips the ascii "DPAPI" prefix before handing the blob to PowerShell', async () => {
    let embedded = null;
    const onPsScript = (script) => {
      const m = script.match(/FromBase64String\('([^']+)'\)/);
      embedded = m ? Buffer.from(m[1], 'base64') : null;
    };
    await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, makeSeams({ rows: classdojoRows, onPsScript }));
    expect(embedded).not.toBeNull();
    expect(embedded.subarray(0, 5).toString('latin1')).not.toBe('DPAPI');       // prefix gone
    expect(embedded.toString('latin1')).toBe('opaque-protected-key-bytes');     // exactly the blob after the prefix
  });

  it('a key blob WITHOUT a DPAPI prefix is passed through unchanged', async () => {
    let embedded = null;
    const onPsScript = (script) => { const m = script.match(/FromBase64String\('([^']+)'\)/); embedded = m ? Buffer.from(m[1], 'base64') : null; };
    const got = await readChromeCredential({ profilePath: 'C:/fake/brain', domain: 'classdojo.com' }, makeSeams({ rows: classdojoRows, dpapiPrefix: false, onPsScript }));
    expect(got?.password).toBe('clsdjo-pass!');
    expect(embedded.toString('latin1')).toBe('opaque-protected-key-bytes');
  });
});
