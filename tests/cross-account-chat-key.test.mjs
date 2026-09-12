// cross-account-chat-key — ONE real chat, TWO Beeper accounts, ONE key (operator 2026-09-05).
//
// THE PROBLEM IT EXISTS FOR. The node's second account gets its own profile directory, hence its
// own EGPT_HOME, hence its own spine process: two spines, one Beeper connection each. When one of
// them is the MOUTH for the other, spine A hands spine B a chat and B must find ITS OWN chatId for
// that same underlying chat. Nothing in the payload can do that. Measured live, the same machine,
// the same WhatsApp group:
//
//   primary   sees  !6ljZJkx0OaY9ZVhEzFgi:beeper.local   localChatID 211
//   secondary sees  !HuXFQeZSY1X4khNDWTzz:beeper.local   localChatID 3
//
// Beeper is Matrix: each account gets its own room, so the room id, the local id and every other
// handle are per-account. The PEOPLE are not — which is the whole idea, and what this file locks.
//
// PURE UNIT TESTS, deliberately: crossAccountChatKey takes a chat payload and returns a string.
// No bridge, no server, no profile. (The roster reader it calls, participantKeys, is exercised
// against the live-shaped fake in tests/beeper-bridge.test.mjs — "chat membership".)
import { describe, it, expect } from 'vitest';
import { crossAccountChatKey } from '../src/bridges/beeper.mjs';

// ── THE FIXTURE, in the MEASURED shape ──────────────────────────────────────────────────────
// Roles only, never people. Every ordinary member carries a phoneNumber; the VIEWING account
// carries none at all — it appears as its matrix id with isSelf true, which is the live shape and
// the reason "phone numbers only" already means "everyone but me".
const PRIMARY_NUM = '+15550000001';
const SECONDARY_NUM = '+15550000002';
const M1 = '+1 (555) 111-0001';   // punctuation on purpose: a live roster is not normalised
const M2 = '+15551110002';
const M3 = '+15551110003';

const member = (id, phoneNumber) => ({ id, phoneNumber, fullName: id });
const self = (id) => ({ id, isSelf: true });   // NO phoneNumber — measured live

// Each account also sees the OTHER participants through ITS OWN id namespace (p-… vs s-…), so
// these fixtures differ in every single id. If a participant id ever leaked into the key, the two
// views below could not possibly compare equal.
const AS_PRIMARY = {
  id: '!6ljZJkx0OaY9ZVhEzFgi:beeper.local', title: 'Group', type: 'group',
  participants: { items: [
    self('@primary:beeper.com'),
    member('p-secondary@beeper.local', SECONDARY_NUM),
    member('p-m1@beeper.local', M1),
    member('p-m2@beeper.local', M2),
  ] },
};
const AS_SECONDARY = {
  id: '!HuXFQeZSY1X4khNDWTzz:beeper.local', title: 'Group', type: 'group',
  participants: { items: [
    member('s-m2@beeper.local', M2),                 // …and in a different ORDER, too
    self('@secondary:beeper.com'),
    member('s-primary@beeper.local', PRIMARY_NUM),
    member('s-m1@beeper.local', M1),
  ] },
};

// The identities the NODE holds — what a caller pairing the two accounts passes as `exclude`.
const OWN_ACCOUNTS = [PRIMARY_NUM, SECONDARY_NUM];

describe('crossAccountChatKey — two accounts, one underlying chat', () => {
  // THE LOCK. Different room ids, different local ids, different participant ids, different roster
  // order — one key.
  it('both accounts derive the SAME key for the same real group', () => {
    const a = crossAccountChatKey(AS_PRIMARY, OWN_ACCOUNTS);
    const b = crossAccountChatKey(AS_SECONDARY, OWN_ACCOUNTS);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    // …and it is exactly the chat TYPE and then the member phone set, digits-normalised and
    // ordered — not an opaque hash, so a failure here says WHICH identity moved.
    expect(a).toBe('group,#15551110001,#15551110002');
    // nothing account-shaped survived: no room id, no local id, no participant id
    expect(a).not.toMatch(/beeper|!|@|p-|s-/);
  });

  // WHY `exclude` IS NOT OPTIONAL FOR AN EXACT MATCH. Self drops out for free (it has no
  // phoneNumber), but each account sees the OTHER as an ordinary member WITH one — which is
  // precisely the pair of entries the live diff of the two rosters turned up.
  it('with NO exclusions the two views differ by exactly the two account numbers', () => {
    const a = crossAccountChatKey(AS_PRIMARY);
    const b = crossAccountChatKey(AS_SECONDARY);
    expect(a).not.toBe(b);
    expect(a).toBe('group,#15550000002,#15551110001,#15551110002');   // primary sees the SECONDARY's number
    expect(b).toBe('group,#15550000001,#15551110001,#15551110002');   // secondary sees the PRIMARY's number
    // the VIEWING account's own number is absent from its OWN key either way — the self entry
    // carries no phoneNumber, so no self-detection was needed to drop it
    expect(a).not.toContain('15550000001');
    expect(b).not.toContain('15550000002');
  });

  it('an exclusion is normalised like the roster is — any phone form works', () => {
    const want = crossAccountChatKey(AS_PRIMARY, OWN_ACCOUNTS);
    for (const form of ['+15550000002', '15550000002', '+1 (555) 000-0002', '+1 555-000-0002']) {
      expect(crossAccountChatKey(AS_PRIMARY, form), form).toBe(want);
    }
    // a bare national form is a DIFFERENT digit string and excludes nothing — the country code is
    // never guessed (same rule idKey states for membership)
    expect(crossAccountChatKey(AS_PRIMARY, '5550000002')).toContain('15550000002');
  });

  it('a single identity may be passed instead of a list', () => {
    expect(crossAccountChatKey(AS_PRIMARY, SECONDARY_NUM)).toBe('group,#15551110001,#15551110002');
  });

  it('the key is a SET: roster order and phone punctuation cannot change it', () => {
    const shuffled = { participants: { items: [
      member('x2', M2), member('x1', '+1 555 111 0001'), self('@primary:beeper.com'),
    ] } };
    const plain = { participants: { items: [
      member('y1', '15551110001'), member('y2', '+1 (555) 111-0002'),
    ] } };
    expect(crossAccountChatKey(shuffled)).toBe(crossAccountChatKey(plain));
  });

  it('reads the bare-array roster shape too (the other shape participantKeys accepts)', () => {
    const asArray = { type: 'single', participants: [member('a', M1), member('b', M2)] };
    expect(crossAccountChatKey(asArray)).toBe('single,#15551110001,#15551110002');
  });
});

// ── COLLISION: the whole point of a key is that DIFFERENT chats get DIFFERENT ones ──────────
describe('crossAccountChatKey — different chats must not collide', () => {
  it('two genuinely different groups key differently', () => {
    const groupA = { participants: { items: [self('@primary:beeper.com'), member('a1', M1), member('a2', M2)] } };
    const groupB = { participants: { items: [self('@primary:beeper.com'), member('b1', M1), member('b2', M3)] } };
    expect(crossAccountChatKey(groupA)).toBeTruthy();
    expect(crossAccountChatKey(groupB)).toBeTruthy();
    expect(crossAccountChatKey(groupA)).not.toBe(crossAccountChatKey(groupB));
  });

  it('a member joining changes the key — a superset is not the same chat', () => {
    const before = { participants: { items: [member('a1', M1), member('a2', M2)] } };
    const after = { participants: { items: [member('a1', M1), member('a2', M2), member('a3', M3)] } };
    expect(crossAccountChatKey(after)).not.toBe(crossAccountChatKey(before));
  });

  // HONEST LIMIT, stated as a test rather than left to be discovered: a participant SET cannot
  // tell two groups with the SAME membership apart. No threshold fixes that; a caller needing
  // certainty must confirm some other way.
  it('two DIFFERENT groups with IDENTICAL membership key the same — the documented limit', () => {
    const one = { id: '!aaa:beeper.local', title: 'Trip', participants: { items: [member('a', M1), member('b', M2)] } };
    const two = { id: '!bbb:beeper.local', title: 'Trip planning', participants: { items: [member('c', M1), member('d', M2)] } };
    expect(crossAccountChatKey(one)).toBe(crossAccountChatKey(two));
  });
});

// ── THE LIVE TOPOLOGY THAT BROKE IT (operator 2026-09-06, "An y Dando") ─────────────────────
// Measured on BOTH Beeper endpoints the same day — the smallest real group there is: the two
// accounts the node holds plus ONE other person. Roles, not people, but the SHAPE is verbatim:
//
//   primary's view of the group    type=group   [ self(no phone), OTHER, SECONDARY ]
//   secondary's view of the SAME   type=group   [ self(no phone), PRIMARY, OTHER   ]
//   primary's 1:1 with OTHER       type=single  [ self(no phone), OTHER            ]
//
// Both accounts are excluded, so every one of the three reduces to {OTHER} — one identity. That
// is why membership ALONE cannot key this: the group and the 1:1 are the same set. `type` is the
// axis that separates them, and it is a property of the REAL chat, not of a view (both endpoints
// independently report `group` for the same room), so folding it in costs the cross-account
// equality nothing. Only once they cannot collide is a one-identity key safe FOR A GROUP.
const OTHER = M1;
const LIVE_GROUP_AS_PRIMARY = {
  id: '!primaryroom:beeper.local', title: 'Trio', type: 'group',
  participants: { items: [
    member('p-other@beeper.local', OTHER),
    member('p-secondary@beeper.local', SECONDARY_NUM),
    self('@primary:beeper.com'),
  ] },
};
const LIVE_GROUP_AS_SECONDARY = {
  id: '!secondaryroom:beeper.local', title: 'Trio', type: 'group',
  participants: { items: [
    member('s-primary@beeper.local', PRIMARY_NUM),
    member('s-other@beeper.local', OTHER),
    self('@secondary:beeper.com'),
  ] },
};
const LIVE_DM_AS_PRIMARY = {
  id: '!primarydm:beeper.local', title: 'Other', type: 'single',
  participants: { items: [member('p-other@beeper.local', OTHER), self('@primary:beeper.com')] },
};

describe('crossAccountChatKey — the smallest real group: two accounts and one other person', () => {
  // THE OPERATOR'S SYMPTOM, as an assertion. Without a key the mouth link refuses ('no-key') and
  // the reply falls back onto the node's OWN account — the operator talking to himself, which is
  // the one thing the second account exists to prevent. This is the property that fixes it.
  it('BOTH accounts derive the SAME key for the three-person group', () => {
    const a = crossAccountChatKey(LIVE_GROUP_AS_PRIMARY, OWN_ACCOUNTS);
    const b = crossAccountChatKey(LIVE_GROUP_AS_SECONDARY, OWN_ACCOUNTS);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(a).toBe('group,#15551110001');
  });

  // …AND the collision that made the one-identity floor necessary is gone, which is what earns
  // the relaxation. Same surviving member, same account, different chat, different key.
  it('the group and the 1:1 with the SAME person key DIFFERENTLY', () => {
    const g = crossAccountChatKey(LIVE_GROUP_AS_PRIMARY, OWN_ACCOUNTS);
    const dm = crossAccountChatKey(LIVE_DM_AS_PRIMARY, OWN_ACCOUNTS);
    expect(g).toBeTruthy();
    expect(g).not.toBe(dm);
    // the 1:1 is still refused outright: nothing distinguishes a 1:1 from itself, so the floor of
    // two stands for `single` and only `single`.
    expect(dm).toBeNull();
  });

  // The type axis is not decoration: it is IN the key, and a chat that changed type would not
  // key as the same chat.
  it('type leads the key, ahead of the member set', () => {
    expect(crossAccountChatKey({ ...LIVE_GROUP_AS_PRIMARY, type: 'single' }, OWN_ACCOUNTS)).toBeNull();
    expect(crossAccountChatKey(LIVE_GROUP_AS_PRIMARY, OWN_ACCOUNTS)).toBe('group,#15551110001');
  });
});

// ── THE CHAT THAT IS ONLY US (operator 2026-09-12, live: "eGPT Admin") ──────────────────────
// The operator made a WhatsApp group whose ONLY members are the two accounts this node holds —
// nobody else at all. Measured the same day with read-only GETs against BOTH installs; roles
// substituted for people as everywhere else in this file, but the TYPES, the TITLES and the
// isSelf/phone shape are verbatim:
//
//   primary   !trYqoMoH7jETBozvcOQh   type group   title "eGPT Admin"   [ SECONDARY, self(no phone) ]
//   secondary !nG3zZhXhJ0mZfmCu6s2f   type group   title "eGPT Admin"   [ PRIMARY,   self(no phone) ]
//
// Each account sees the OTHER as the only phone-carrying member and ITSELF as the phone-less self
// entry, so once BOTH held identities are excluded the surviving phone set is EMPTY on BOTH sides.
// The membership key refused four times live ("this chat cannot be keyed across accounts") and
// every reply went out on the EAR's account — the operator answering himself, the one thing the
// second account exists to prevent.
//
// THE TITLE is what the two views provably agree on here, and only because the group is NAMED: an
// explicitly-named group's name is Matrix room state, so it is a property of the REAL chat rather
// than of a view — the same standing `type` has, and the same reason it can be keyed on.
const ADMIN_AS_PRIMARY = {
  id: '!trYqoMoH7jETBozvcOQh:beeper.local', title: 'eGPT Admin', type: 'group',
  participants: { items: [
    member('p-secondary@beeper.local', SECONDARY_NUM),
    self('@primary:beeper.com'),
  ] },
};
const ADMIN_AS_SECONDARY = {
  id: '!nG3zZhXhJ0mZfmCu6s2f:beeper.local', title: 'eGPT Admin', type: 'group',
  participants: { items: [
    member('s-primary@beeper.local', PRIMARY_NUM),
    self('@secondary:beeper.com'),
  ] },
};

describe('crossAccountChatKey — the group whose ONLY members are the two accounts', () => {
  // THE OPERATOR'S SYMPTOM, as an assertion: on HEAD both of these are null and the mouth refuses.
  it('BOTH accounts derive the SAME key for the two-account group', () => {
    const a = crossAccountChatKey(ADMIN_AS_PRIMARY, OWN_ACCOUNTS);
    const b = crossAccountChatKey(ADMIN_AS_SECONDARY, OWN_ACCOUNTS);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    // Readable, like the member key — a failure says WHICH field moved, not that a hash changed.
    expect(a).toBe('group,title:egpt-admin');
  });

  // NAMESPACED, so the two kinds of key live in disjoint spaces. idKey stamps every phone identity
  // with a leading '#', so a title segment can never be read as a member and no title-keyed chat
  // can ever answer to a membership key.
  it('a title key can never collide with a member key', () => {
    const title = crossAccountChatKey(ADMIN_AS_PRIMARY, OWN_ACCOUNTS);
    expect(title).not.toMatch(/#/);
    for (const members of [AS_PRIMARY, AS_SECONDARY, LIVE_GROUP_AS_PRIMARY, LIVE_GROUP_AS_SECONDARY]) {
      expect(crossAccountChatKey(members, OWN_ACCOUNTS)).not.toBe(title);
    }
  });

  // …and the title is doing real work: TWO groups of exactly the two accounts are told apart by it.
  it('two DIFFERENT two-account groups key differently', () => {
    const other = { ...ADMIN_AS_PRIMARY, id: '!other:beeper.local', title: 'eGPT Lab' };
    expect(crossAccountChatKey(other, OWN_ACCOUNTS)).toBe('group,title:egpt-lab');
    expect(crossAccountChatKey(other, OWN_ACCOUNTS)).not.toBe(crossAccountChatKey(ADMIN_AS_PRIMARY, OWN_ACCOUNTS));
  });

  // The title is normalised the way every other title in this bridge is (chatSlug), so casing and
  // punctuation cannot split one chat into two keys.
  it('the title is slug-normalised, so case and spacing cannot break the match', () => {
    const loud = { ...ADMIN_AS_SECONDARY, title: '  EGPT   admin  ' };
    expect(crossAccountChatKey(loud, OWN_ACCOUNTS)).toBe(crossAccountChatKey(ADMIN_AS_PRIMARY, OWN_ACCOUNTS));
  });

  // AN UNNAMED two-account group. Beeper SYNTHESISES a title out of the members, so each account
  // names the room after the OTHER one and the two titles differ. There is nothing here both sides
  // agree on, so there must be NO match — and a no-match falls the reply cleanly back to the ear,
  // which is correct. What must never happen is a WRONG match.
  it('an UNNAMED two-account group does not key alike — no match, and no wrong match', () => {
    const unnamedPrimary = { ...ADMIN_AS_PRIMARY, title: 'The Secondary' };    // primary names it after the secondary
    const unnamedSecondary = { ...ADMIN_AS_SECONDARY, title: 'The Primary' };  // …and vice versa
    const a = crossAccountChatKey(unnamedPrimary, OWN_ACCOUNTS);
    const b = crossAccountChatKey(unnamedSecondary, OWN_ACCOUNTS);
    expect(a).not.toBe(b);
    // …and neither of them accidentally answers to the NAMED group's key either
    const named = crossAccountChatKey(ADMIN_AS_PRIMARY, OWN_ACCOUNTS);
    expect(a).not.toBe(named);
    expect(b).not.toBe(named);
  });

  // THE DISTINCTION THAT MAKES THIS SAFE. The new case is "emptied BY the exclusions", i.e. every
  // phone-carrying member is an account we hold. It is NOT "empty to begin with", which stays the
  // non-evidence it always was.
  it('a group with NO phone-carrying member at all is still refused, titled or not', () => {
    const matrixOnly = {
      id: '!m:beeper.local', title: 'eGPT Admin', type: 'group',
      participants: { items: [self('@primary:beeper.com'), { id: '@matrix-only:beeper.com' }] },
    };
    expect(crossAccountChatKey(matrixOnly, OWN_ACCOUNTS)).toBeNull();
    expect(crossAccountChatKey({ ...ADMIN_AS_PRIMARY, participants: { items: [] } }, OWN_ACCOUNTS)).toBeNull();
    expect(crossAccountChatKey({ ...ADMIN_AS_PRIMARY, participants: undefined }, OWN_ACCOUNTS)).toBeNull();
  });

  it('a BLANK title is not evidence either — an emptied group with no name is still refused', () => {
    expect(crossAccountChatKey({ ...ADMIN_AS_PRIMARY, title: '   ' }, OWN_ACCOUNTS)).toBeNull();
    expect(crossAccountChatKey({ ...ADMIN_AS_PRIMARY, title: undefined }, OWN_ACCOUNTS)).toBeNull();
    // a title of pure punctuation slugs to nothing, which is the same non-evidence
    expect(crossAccountChatKey({ ...ADMIN_AS_PRIMARY, title: '!!!' }, OWN_ACCOUNTS)).toBeNull();
  });

  it('with NO exclusions the member key still wins — the title case cannot be reached', () => {
    expect(crossAccountChatKey(ADMIN_AS_PRIMARY)).toBe('group,#15550000002');
    expect(crossAccountChatKey(ADMIN_AS_SECONDARY)).toBe('group,#15550000001');
  });

  // ── THE EXCLUSIONS ARE NO LONGER PHONE-ONLY (operator 2026-09-12) ───────────────────────────
  // selfIdentities() now reports every identifier an install answers to — its phone, its Beeper
  // user id, its email — so `exclude` arrives carrying entries that are not phone-shaped. The
  // title branch's trigger is `allPhones.length && !phones.length` over PHONE keys only, and a
  // non-phone skip entry (idKey leaves it without the leading '#') cannot match one. Reasoning
  // said that made it unaffected; this asserts it.
  it('a non-phone exclusion (Beeper id, email) changes nothing — the title branch still fires', () => {
    const wide = [...OWN_ACCOUNTS, '@primary:beeper.com', '@secondary:beeper.com', 'anrodz42@example.com', 'dolly.egpt@example.com'];
    expect(crossAccountChatKey(ADMIN_AS_PRIMARY, wide)).toBe('group,title:egpt-admin');
    expect(crossAccountChatKey(ADMIN_AS_SECONDARY, wide)).toBe('group,title:egpt-admin');
  });

  // …and the ordinary member key is equally untouched: a Beeper id in `exclude` can only ever
  // skip a Beeper id in the roster, which PHONE_KEY_RE never let into the key in the first place.
  it('a non-phone exclusion cannot remove a member from an ordinary member key', () => {
    const wide = [...OWN_ACCOUNTS, '@primary:beeper.com', 'dolly.egpt@example.com'];
    for (const chat of [AS_PRIMARY, AS_SECONDARY, LIVE_GROUP_AS_PRIMARY, LIVE_GROUP_AS_SECONDARY]) {
      expect(crossAccountChatKey(chat, wide)).toBe(crossAccountChatKey(chat, OWN_ACCOUNTS));
    }
  });

  // The self entry in a roster IS the account's Beeper id (measured live: '@dolly-egpt:beeper.com'
  // with no phoneNumber at all), so a wide exclusion set now really does skip it. It carried no
  // phone, so nothing it could have contributed was ever in the key — the two views still agree.
  it('excluding the viewing account by its own Beeper id leaves both views keying alike', () => {
    const wide = [...OWN_ACCOUNTS, '@primary:beeper.com', '@secondary:beeper.com'];
    expect(crossAccountChatKey(AS_PRIMARY, wide)).toBe(crossAccountChatKey(AS_SECONDARY, wide));
  });

  // `single` IS DELIBERATELY LEFT OUT. The 1:1 between the two held accounts is the same degenerate
  // shape, but its title is the OTHER party's display name and therefore DIFFERS per account, so a
  // title key cannot work there — and a CONSTANT key ("the 1:1 between us") would be derived from
  // nothing about the chat at all, which is exactly the non-evidence the refusals above exist to
  // reject: Beeper is multi-network, so a WhatsApp 1:1 and a Signal 1:1 with the same co-account
  // number would both answer to it. It stays refused, and the ear speaks.
  it('the 1:1 BETWEEN the two accounts stays refused — a title cannot cross it', () => {
    const dmAsPrimary = {
      id: '!dm-p:beeper.local', title: 'The Secondary', type: 'single',
      participants: { items: [member('p-secondary@beeper.local', SECONDARY_NUM), self('@primary:beeper.com')] },
    };
    const dmAsSecondary = {
      id: '!dm-s:beeper.local', title: 'The Primary', type: 'single',
      participants: { items: [member('s-primary@beeper.local', PRIMARY_NUM), self('@secondary:beeper.com')] },
    };
    expect(crossAccountChatKey(dmAsPrimary, OWN_ACCOUNTS)).toBeNull();
    expect(crossAccountChatKey(dmAsSecondary, OWN_ACCOUNTS)).toBeNull();
  });
});

// ── REFUSALS: a key that is not EVIDENCE must not be a key at all ───────────────────────────
// Returning something for these would make every chat that produces the same non-evidence
// "match" every other one — the opposite of identifying a chat.
describe('crossAccountChatKey — refuses rather than matching everything to everything', () => {
  it('NO roster in the payload is UNKNOWN, never "nobody": null', () => {
    expect(crossAccountChatKey({ id: '!x:beeper.local', title: 'Bare', type: 'group' })).toBeNull();
    expect(crossAccountChatKey(null)).toBeNull();
    expect(crossAccountChatKey(undefined)).toBeNull();
  });

  it('an EMPTY roster is null', () => {
    expect(crossAccountChatKey({ participants: { items: [] } })).toBeNull();
  });

  // MATRIX-ONLY MEMBERS. A participant id is namespaced per account, so it can never compare equal
  // across two of them — it contributes nothing to the key by construction. A chat whose members
  // are ALL matrix-only therefore yields nothing at all, and two such chats must NOT be declared
  // the same chat on the strength of both yielding nothing.
  it('a chat of matrix-only participants keys as null — and two of them still do not match', () => {
    const one = { participants: { items: [self('@primary:beeper.com'), { id: '@x:beeper.com' }, { id: '@y:beeper.com' }] } };
    const two = { participants: { items: [self('@primary:beeper.com'), { id: '@p:beeper.com' }, { id: '@q:beeper.com' }] } };
    expect(crossAccountChatKey(one)).toBeNull();
    expect(crossAccountChatKey(two)).toBeNull();
    // the trap this closes: null == null. A caller must never read two refusals as a match, so
    // there is no key here to be compared in the first place.
    expect(crossAccountChatKey(one)).toBeNull();
  });

  // THE THRESHOLD, and the collision that used to set it for everyone. A 1:1 with X yields {X};
  // so does the group [self, X, co-account] once the co-account is excluded — which is why a bare
  // size-1 key could put a reply meant for the GROUP into a PRIVATE chat. Now `type` leads the key
  // and they cannot collide, so the floor is one FOR A GROUP and stays two for a `single`: nothing
  // distinguishes a 1:1 from itself.
  it('ONE surviving identity keys a GROUP and is still refused for a 1:1', () => {
    const oneToOne = { type: 'single', participants: { items: [self('@primary:beeper.com'), member('x', M1)] } };
    const smallGroup = { type: 'group', participants: { items: [
      self('@primary:beeper.com'), member('x', M1), member('co', SECONDARY_NUM),
    ] } };
    expect(crossAccountChatKey(oneToOne, OWN_ACCOUNTS)).toBeNull();
    expect(crossAccountChatKey(smallGroup, OWN_ACCOUNTS)).toBe('group,#15551110001');
    // the collision that made the old floor necessary, checked directly: same surviving member,
    // and the two keys are still not each other.
    expect(crossAccountChatKey(smallGroup, OWN_ACCOUNTS)).not.toBe(crossAccountChatKey(oneToOne, OWN_ACCOUNTS));
  });

  it('a group whose only phone-bearing members are excluded is refused, not keyed empty', () => {
    const chat = { type: 'group', participants: { items: [
      self('@primary:beeper.com'), member('co', SECONDARY_NUM), { id: '@matrix-only:beeper.com' },
    ] } };
    expect(crossAccountChatKey(chat, OWN_ACCOUNTS)).toBeNull();
  });

  it('TWO surviving identities is the smallest key a NON-group will produce', () => {
    const chat = { type: 'single', participants: { items: [self('@primary:beeper.com'), member('x', M1), member('y', M2)] } };
    expect(crossAccountChatKey(chat, OWN_ACCOUNTS)).toBe('single,#15551110001,#15551110002');
    // a payload with no `type` at all keeps the same floor — it is not a group, so it is not
    // trusted with one identity
    const untyped = { participants: { items: [self('@primary:beeper.com'), member('x', M1)] } };
    expect(crossAccountChatKey(untyped, OWN_ACCOUNTS)).toBeNull();
  });
});
