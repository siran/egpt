import { describe, it, expect } from 'vitest';
import { canonicalUserId, deviceId, isAuthorizedUser, sameUser } from '../src/identity.mjs';

describe('canonicalUserId — stable across group, 1:1, and device (proven from operator data)', () => {
  it('strips @server, :deviceId, and the group _N suffix', () => {
    expect(canonicalUserId('34836563681438@lid')).toBe('34836563681438');
    expect(canonicalUserId('34836563681438:45@lid')).toBe('34836563681438');     // Beeper/web device
    expect(canonicalUserId('34836563681438_1')).toBe('34836563681438');          // group sender-key form
    expect(canonicalUserId('34836563681438_1--0')).toBe('34836563681438');       // defensive
    expect(canonicalUserId('16468217865@s.whatsapp.net')).toBe('16468217865');
    expect(canonicalUserId('16468217865:42@s.whatsapp.net')).toBe('16468217865');
    expect(canonicalUserId('wa:16468217865@s.whatsapp.net')).toBe('16468217865');
  });
  it('the operator is ONE canonical id regardless of which group/device it came from', () => {
    const fromGroupA = canonicalUserId('34836563681438:0@lid');
    const fromGroupB = canonicalUserId('34836563681438:45@lid');   // a different device, another group
    const fromSenderKey = canonicalUserId('34836563681438_1');
    expect(fromGroupA).toBe(fromGroupB);
    expect(fromGroupA).toBe(fromSenderKey);
  });
  it('returns null for junk', () => {
    expect(canonicalUserId('')).toBeNull();
    expect(canonicalUserId(null)).toBeNull();
    expect(canonicalUserId('@lid')).toBeNull();
    expect(canonicalUserId('status@broadcast')).toBeNull();   // no digits in user part
  });
});

describe('deviceId — informational source tag, never a permission input', () => {
  it('extracts the device segment, primary = 0', () => {
    expect(deviceId('34836563681438@lid')).toBe('0');
    expect(deviceId('34836563681438:45@lid')).toBe('45');
    expect(deviceId('16468217865:42@s.whatsapp.net')).toBe('42');
    expect(deviceId(null)).toBe('0');
  });
});

describe('isAuthorizedUser — Layer B command gate', () => {
  // The operator's config carries BOTH forms; either matches.
  const allowed = ['16468217865', '34836563681438'];   // phone + lid

  it('authorizes the operator from a group (lid form), any device', () => {
    expect(isAuthorizedUser('34836563681438@lid', allowed)).toBe(true);
    expect(isAuthorizedUser('34836563681438:45@lid', allowed)).toBe(true);   // from Beeper
    expect(isAuthorizedUser('34836563681438_1', allowed)).toBe(true);        // group sender-key form
  });
  it('authorizes the operator from a 1:1 / phone form', () => {
    expect(isAuthorizedUser('16468217865@s.whatsapp.net', allowed)).toBe(true);
    expect(isAuthorizedUser('16468217865:42@s.whatsapp.net', allowed)).toBe(true);
  });
  it('allowlist entries may themselves carry device/suffix decoration', () => {
    expect(isAuthorizedUser('34836563681438@lid', ['34836563681438:9@lid'])).toBe(true);
  });
  it('denies a non-listed user (e.g. a random group member)', () => {
    expect(isAuthorizedUser('4290722676802@lid', allowed)).toBe(false);
    expect(isAuthorizedUser('170205426794544:3@lid', allowed)).toBe(false);
  });
  it('denies junk / empty allowlist', () => {
    expect(isAuthorizedUser('34836563681438@lid', [])).toBe(false);
    expect(isAuthorizedUser(null, allowed)).toBe(false);
    expect(isAuthorizedUser('status@broadcast', allowed)).toBe(false);
  });
});

describe('sameUser — same human across group/device, by form', () => {
  it('true across device + group + suffix decoration of one number', () => {
    expect(sameUser('34836563681438:0@lid', '34836563681438:45@lid')).toBe(true);
    expect(sameUser('34836563681438_1', '34836563681438@lid')).toBe(true);
  });
  it('false for different numbers (does NOT infer lid↔phone equivalence)', () => {
    expect(sameUser('34836563681438@lid', '16468217865@s.whatsapp.net')).toBe(false);
    expect(sameUser('34836563681438@lid', '4290722676802@lid')).toBe(false);
  });
});
