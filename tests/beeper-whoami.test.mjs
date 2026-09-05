// beeper-whoami — WHICH Desktop is on which port, and whose account it is (operator 2026-09-03).
// No Beeper and no network: probe and the Windows socket-owner lookup are both injected.
//
// What is locked here is the reasoning the tool exists for. A 401 is a RESULT, not a failure:
// a token belongs to an INSTALL, so it is the 401 from the OTHER connection that proves two
// separate Desktops are answering rather than one. And a connection with no base_url must be
// reported as riding the bridge DEFAULT (23373) rather than as unset, because that default is
// exactly what the spine would ride.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectionsOf, report, topology, renderTable, renderSummary, summarize, localAddresses, shellPortOf, nodesOf } from '../src/tools/beeper-whoami.mjs';

const cfg = {
  node_name: 'kg',
  beeper: {
    use: 'main',
    main: { account: 'an@example.com', base_url: 'http://127.0.0.1:23373', token: 'tok-s0' },
    s1: { account: 'an@example.com', base_url: 'http://127.0.0.1:23374', token: 'tok-s1' },
  },
};

// Two installs, one account: each token answers exactly one port.
const fakeProbe = async (baseUrl, token) => {
  const port = Number(new URL(baseUrl).port);
  const owner = { 23373: 'tok-s0', 23374: 'tok-s1' }[port];
  if (!owner) return { ok: false, status: 0, error: 'ECONNREFUSED' };
  if (token !== owner) return { ok: false, status: 401 };
  return { ok: true, status: 200, loginID: '@an:beeper.com', email: 'an@example.com', networks: ['Beeper', 'WhatsApp'] };
};

const fakeOwners = async () => new Map([
  [23373, { pid: 100, session: 0, image: 'Beeper.exe' }],
  [23374, { pid: 200, session: 1, image: 'Beeper.exe' }],
]);

describe('beeper-whoami', () => {
  it('lists the connections in config, excluding `use` (a pointer, not a connection)', () => {
    const conns = connectionsOf(cfg);
    expect(conns.map((c) => c.name)).toEqual(['main', 's1']);
    expect(conns.find((c) => c.name === 'main').isUse).toBe(true);
  });

  // A CONNECTION WITH CANDIDATE ENDPOINTS carries a token PER ENDPOINT, and the tool must try
  // every one. Reading only the top-level `token` loses them all and then reports an install this
  // node can talk to as `up, no token of ours works` — measured live on 2026-09-04, right after
  // the operator's own `main` moved its token into `endpoints:`. The two states are opposite ("it
  // refused us" vs "we never asked"), so losing a token is not a missing row, it is a WRONG one.
  it('flattens `endpoints:` candidates so EVERY token this node holds is tried', () => {
    const conns = connectionsOf({
      beeper: {
        use: 'primary',
        primary: {
          account: 'operator@example.com',
          endpoints: [
            { base_url: 'http://127.0.0.1:23373', token: 'tok-a' },
            { base_url: 'http://127.0.0.1:23374', token: 'tok-b' },
          ],
        },
      },
    });
    expect(conns.map((c) => c.token)).toEqual(['tok-a', 'tok-b']);
    // Labelled by PORT: two candidates of one connection would otherwise both print `primary`
    // and read as a duplicated row rather than two installs.
    expect(conns.map((c) => c.name)).toEqual(['primary:23373', 'primary:23374']);
    // The connection owns account/owner_node/use; a candidate owns only its address and token.
    expect(conns.every((c) => c.account === 'operator@example.com' && c.isUse === true)).toBe(true);
  });

  it('the plain token-only shape is untouched by that flattening', () => {
    const [c] = connectionsOf({ beeper: { use: 'main', main: { account: 'a@b', token: 't' } } });
    expect({ name: c.name, token: c.token, baseUrl: c.baseUrl }).toEqual({
      name: 'main', token: 't', baseUrl: 'http://127.0.0.1:23373',
    });
  });

  it('reports a connection with no base_url as riding the bridge DEFAULT, not as unset', () => {
    const [c] = connectionsOf({ beeper: { use: 'main', main: { token: 't' } } });
    expect(c.baseUrl).toBe('http://127.0.0.1:23373');
  });

  it('names the session that owns each port, and whose account answers there', async () => {
    const out = await report({ cfg, deps: { probe: fakeProbe, localOwners: fakeOwners } });
    expect(out).toMatch(/:23373\s+pid 100, SESSION 0/);
    expect(out).toMatch(/:23374\s+pid 200, SESSION 1/);
    expect(out).toMatch(/main \(use\): 200\s+@an:beeper\.com/);
    expect(out).toMatch(/config beeper\.main → http:\/\/127\.0\.0\.1:23373.*→ SESSION 0/);
    expect(out).toMatch(/config beeper\.s1 → http:\/\/127\.0\.0\.1:23374.*→ SESSION 1/);
  });

  // THE TEST NAME USED TO SAY "PROOF", and that was the overclaim itself, written into a lock.
  // A token belongs to one install, so a different install is the LIKELY reading of a 401 — but a
  // revoked or expired token on the SAME install answers identically. The detail view now offers
  // the reading instead of asserting it, and this asserts that it never states it as fact.
  it('offers a 401 as the likely different-install reading, without asserting it', async () => {
    const out = await report({ cfg, deps: { probe: fakeProbe, localOwners: fakeOwners } });
    expect(out).toMatch(/s1: 401\s+refused/);
    expect(out).toMatch(/main \(use\): 401\s+refused/);
    // it must still SAY which reading is likely — honesty is not the same as saying nothing
    expect(out).toMatch(/likely a different install/);
    // ...and must not present it as established
    expect(out).not.toMatch(/a different install answers here/);
  });

  it('says so plainly when a connection carries no token', async () => {
    const noTok = { ...cfg, beeper: { ...cfg.beeper, s1: { ...cfg.beeper.s1, token: '' } } };
    const out = await report({ cfg: noTok, deps: { probe: fakeProbe, localOwners: fakeOwners } });
    expect(out).toMatch(/s1: no token in config — cannot ask/);
  });

  it('survives a node where nothing is listening at all', async () => {
    const out = await report({ cfg, deps: { probe: async () => ({ ok: false, status: 0, error: 'ECONNREFUSED' }), localOwners: async () => new Map() } });
    expect(out).toMatch(/nothing listening/);
    expect(out).toMatch(/→ nobody listening/);
  });
});

// ---------------------------------------------------------------------------------------------
// THE TOPOLOGY TABLE (operator 2026-09-04: "better a table ... i think this is an important
// configuration helper script"). One command, one map, because the live question is not "what
// does the token matrix say" but "which port do I type".
//
// Everything is injected: no network, no ssh, no real ports, no Windows. What is locked here is
// the SHAPE of the answer and, more importantly, the four states that are easy to conflate:
//   logged in                   a token of ours got 200 there
//   up, no token of ours works  it answers, and 401s every token we hold — and that is ALL it
//                               says: a signed-out install and one signed in as an account whose
//                               token we do not hold both 401, so login state is unknowable here
//   no token in config          we never asked — an unauthenticated 401 looks identical, means the opposite
//   not listening               nothing answered at all
// The vocabulary is deliberately role-shaped (primary / secondary): eGPT is a public tool and no
// person, machine or account name belongs in it. What the table PRINTS is discovered data.
const table = {
  node_name: 'kg',
  shell: { port: 23375 },
  beeper: {
    use: 'primary',
    primary: { account: 'operator@example.com', base_url: 'http://127.0.0.1:23373', token: 'tok-primary' },
    secondary: { account: 'agents@example.com', base_url: 'http://127.0.0.1:23374', token: 'tok-secondary' },
  },
};

// 23373/23374 are two installs of one product, each answering only its OWN token. 23376 is a
// third install that is UP and answers nobody we know — the "no approved connection" case.
const tableProbe = async (baseUrl, token) => {
  const port = Number(new URL(baseUrl).port);
  if (port === 23376) return { ok: false, status: 401 };
  const owner = { 23373: 'tok-primary', 23374: 'tok-secondary' }[port];
  if (!owner) return { ok: false, status: 0, error: 'ECONNREFUSED' };
  if (token !== owner) return { ok: false, status: 401 };
  return port === 23373
    ? { ok: true, status: 200, loginID: '@primary:beeper.com', email: 'operator@example.com', networks: ['Beeper'] }
    : { ok: true, status: 200, loginID: '@secondary:beeper.com', email: 'agents@example.com', networks: ['Beeper'] };
};

const tableOwners = async () => new Map([
  [23373, { pid: 100, session: 0, image: 'Beeper.exe' }],
  [23374, { pid: 200, session: 1, image: 'Beeper.exe' }],
  [23375, { pid: 300, session: 1, image: 'node.exe' }],
  [23376, { pid: 400, session: 0, image: 'Beeper.exe' }],
  [9222, { pid: 100, session: 0, image: 'Beeper.exe' }],
  [9223, { pid: 500, session: 1, image: 'chrome.exe' }],
]);

const tableDeps = (over = {}) => ({
  probe: tableProbe,
  localOwners: tableOwners,
  tcpListening: async (port) => port === 23375,
  cdpProbe: async (port) => (port === 9222 ? { ok: true, label: 'Beeper' }
    : port === 9223 ? { ok: true, label: 'Chrome' }
    : { ok: false }),
  localAddresses: () => ['10.0.0.4'],
  hostname: () => 'node-one',
  remoteProbe: async () => ({ ok: false, error: 'not asked' }),
  ...over,
});

describe('beeper-whoami — the topology table', () => {
  it('prints host | ip | node | port | S0/S1 | account | state, one line per port', async () => {
    const remoteProbe = async (host) => (host === 'peer-two'
      ? {
        ok: true,
        ip: '203.0.113.7',
        rows: [
          { host: 'ignored', ip: '?', node: 'do', port: 23373, role: 'api', session: 'S0', account: '@remote:beeper.com', state: 'logged in' },
          { host: 'ignored', ip: '?', node: 'do', port: 23375, role: 'console', session: 'S0', account: '-', state: 'listening' },
        ],
      }
      : { ok: false, ip: '198.51.100.9', error: 'ssh: connect to host peer-three port 22: Connection timed out' });

    const { rows, notes } = await topology({ cfg: table, hosts: ['peer-two', 'peer-three'], deps: tableDeps({ remoteProbe }) });
    expect(renderTable(rows, notes)).toBe([
      'host        ip            node  port           S0/S1  account                state',
      '----------  ------------  ----  -------------  -----  ---------------------  --------------------------',
      // ORDER: node, then S0/S1, then api/cdp/console, then port. The local node is first and its
      // S0 rows come before its S1 rows; inside a session the api row (which names the account)
      // sits above the cdp row (which is the number a driver is typed at).
      'node-one    10.0.0.4      kg    23373 api      S0     @primary:beeper.com    logged in',
      'node-one    10.0.0.4      kg    23376 api      S0     -                      up, no token of ours works',
      // 9222 is pid 100 — the SAME process as the 23373 api row, so it inherits that account.
      'node-one    10.0.0.4      kg     9222 cdp      S0     @primary:beeper.com    listening (Beeper)',
      'node-one    10.0.0.4      kg    23374 api      S1     @secondary:beeper.com  logged in',
      // 9223 is Chrome's own pid, which no api row is, so it stays `-`.
      'node-one    10.0.0.4      kg     9223 cdp      S1     -                      listening (Chrome)',
      'node-one    10.0.0.4      kg    23375 console  S1     -                      listening',
      'peer-two    203.0.113.7   do    23373 api      S0     @remote:beeper.com     logged in',
      'peer-two    203.0.113.7   do    23375 console  S0     -                      listening',
      'peer-three  198.51.100.9  ?     -              -      -                      unreachable',
      '',
      'peer-three: unreachable - ssh: connect to host peer-three port 22: Connection timed out',
    ].join('\n'));
  });

  it('reads an install that answers and 401s every token we hold as up, no token of ours works', async () => {
    const { rows } = await topology({ cfg: table, deps: tableDeps() });
    const up = rows.find((r) => r.port === 23376);
    expect(up.state).toBe('up, no token of ours works');
    expect(up.account, 'there is no account to name when nothing authenticated').toBe('-');
  });

  it('never reads "we never asked" as "it refused us" — no token is its own state', async () => {
    // An UNAUTHENTICATED request comes back 401 exactly like a foreign install's token does, and
    // the two mean opposite things. Reading the second as the first is a confident wrong answer.
    const noTok = { ...table, beeper: { use: 'primary', primary: { base_url: 'http://127.0.0.1:23376' } } };
    const { rows } = await topology({ cfg: noTok, deps: tableDeps() });
    const row = rows.find((r) => r.port === 23376);
    expect(row.state).toBe('no token in config');
    expect(rows.some((r) => r.state === 'up, no token of ours works')).toBe(false);
  });

  it('keeps a CONFIGURED port that answers nothing, and drops an empty scan port', async () => {
    const moved = { ...table, beeper: { ...table.beeper, secondary: { ...table.beeper.secondary, base_url: 'http://127.0.0.1:23380' } } };
    const { rows } = await topology({ cfg: moved, deps: tableDeps() });
    expect(rows.find((r) => r.port === 23380).state, 'the port you configured is dead is the answer we came for').toBe('not listening');
    expect(rows.some((r) => r.port === 23381), 'an empty scan port is noise, not an answer').toBe(false);
  });

  it('a remote host that does not answer costs one row and never takes the local ones with it', async () => {
    const remoteProbe = async () => ({ ok: false, ip: null, error: 'ssh: Could not resolve hostname' });
    const { rows, notes } = await topology({ cfg: table, hosts: ['far-node'], deps: tableDeps({ remoteProbe }) });
    const row = rows.find((r) => r.host === 'far-node');
    // `unreachable` and nothing more: slow is not dead, and a closed lid is not "off the network".
    expect(row).toMatchObject({ node: '?', port: '-', session: '-', account: '-', state: 'unreachable', ip: '?' });
    expect(rows.filter((r) => r.host === 'node-one').length).toBeGreaterThan(0);
    expect(notes.some((n) => n.startsWith('far-node: unreachable -'))).toBe(true);
  });

  it('skips remote silently when there is no ssh client at all', async () => {
    const { rows } = await topology({ cfg: table, hosts: ['far-node'], deps: tableDeps({ remoteProbe: async () => ({ ok: false, noSsh: true }) }) });
    expect(rows.some((r) => r.host === 'far-node')).toBe(false);
  });

  it('reads S0/S1 as - wherever the OS cannot say — there is no POSIX equivalent to invent', async () => {
    // localOwners already returns an empty Map off win32; the table must degrade, not guess.
    const { rows } = await topology({ cfg: table, deps: tableDeps({ localOwners: async () => new Map() }) });
    expect([...new Set(rows.map((r) => r.session))]).toEqual(['-']);
    expect(rows.find((r) => r.port === 23373).state, 'the API answer does not depend on the OS half').toBe('logged in');
  });

  it('shows ? rather than crowning one address when the host has several', async () => {
    const { rows, notes } = await topology({ cfg: table, deps: tableDeps({ localAddresses: () => ['192.0.2.5', '100.64.0.2'] }) });
    expect(rows[0].ip).toBe('?');
    expect(notes.some((n) => n.includes('192.0.2.5, 100.64.0.2'))).toBe(true);
  });

  it('reports the console port once, as the console — not also as a nonsense API row', async () => {
    const { rows } = await topology({ cfg: table, deps: tableDeps() });
    const at = rows.filter((r) => r.port === 23375 && r.host === 'node-one');
    expect(at.map((r) => r.role)).toEqual(['console']);
    expect(shellPortOf({}), 'a node that configures nothing keeps the old default').toBe(23375);
    expect(shellPortOf({ shell: { port: 23385 } })).toBe(23385);
  });

  // -------------------------------------------------------------------------------------------
  // WHICH INSTALL IS THIS CDP PORT — the question the number itself cannot answer, and the one
  // the operator got wrong three times running (2026-09-04: tunnelling to a CDP port and finding
  // a different account than the one he was aiming at). Two Beeper CDP rows print identically, so
  // the number typed into a driver used to say nothing about whose account was behind it.
  //
  // A Beeper install serves its HTTP API and its debugger from ONE process, so the pid the OS
  // reports for the CDP socket is the pid of an api row above — and that row has already been
  // told, by a 200, whose account it is. No second probe, no new scan: the same data read the
  // other way round. Four cases in one fixture, because it is the DIFFERENCE between them the
  // operator needs and all four used to print `-`:
  //   9222  Beeper, pid 100 — the process behind the 23373 api row  -> inherits @primary
  //   9223  Chrome, pid 500 — no api row is that process            -> stays `-`
  //   9224  Beeper, pid 400 — the process behind 23376, which 401s  -> `-`, and SAYS why
  //   9225  Beeper, pid 600 — no api row shares that pid at all     -> stays `-`, nothing guessed
  const joinOwners = async () => new Map([
    ...(await tableOwners()),
    [9224, { pid: 400, session: 0, image: 'Beeper.exe' }],
    [9225, { pid: 600, session: 1, image: 'Beeper.exe' }],
  ]);
  const joinDeps = (over = {}) => tableDeps({
    localOwners: joinOwners,
    cdpProbe: async (port) => (port === 9223 ? { ok: true, label: 'Chrome' }
      : [9222, 9224, 9225].includes(port) ? { ok: true, label: 'Beeper' }
      : { ok: false }),
    ...over,
  });

  it('gives a Beeper CDP port the account of the api port its own PROCESS serves', async () => {
    const { rows } = await topology({ cfg: table, deps: joinDeps() });
    expect(renderTable(rows)).toBe([
      'host      ip        node  port           S0/S1  account                state',
      '--------  --------  ----  -------------  -----  ---------------------  ----------------------------------------------',
      'node-one  10.0.0.4  kg    23373 api      S0     @primary:beeper.com    logged in',
      'node-one  10.0.0.4  kg    23376 api      S0     -                      up, no token of ours works',
      'node-one  10.0.0.4  kg     9222 cdp      S0     @primary:beeper.com    listening (Beeper)',
      'node-one  10.0.0.4  kg     9224 cdp      S0     -                      listening (Beeper, up, no token of ours works)',
      'node-one  10.0.0.4  kg    23374 api      S1     @secondary:beeper.com  logged in',
      'node-one  10.0.0.4  kg     9223 cdp      S1     -                      listening (Chrome)',
      'node-one  10.0.0.4  kg     9225 cdp      S1     -                      listening (Beeper)',
      'node-one  10.0.0.4  kg    23375 console  S1     -                      listening',
    ].join('\n'));
  });

  it('never guesses: Chrome, and a Beeper pid no api row shares, both stay -', async () => {
    const { rows } = await topology({ cfg: table, deps: joinDeps() });
    const at = (port) => rows.find((r) => r.port === port);
    expect(at(9223), 'no api row is Chrome — a browser the operator drives by hand has no account here')
      .toMatchObject({ account: '-', state: 'listening (Chrome)' });
    // Chrome stays `-` because of the PID, not because of its name: the join is evidence, and a
    // real install whose /json/version omits the word "beeper" (it labels itself Electron) is
    // still that pid's process, so it must still be named.
    const electron = await topology({ cfg: table, deps: joinDeps({ cdpProbe: async (port) => (port === 9222 ? { ok: true, label: 'Electron' } : { ok: false }) }) });
    expect(electron.rows.find((r) => r.port === 9222))
      .toMatchObject({ account: '@primary:beeper.com', state: 'listening (Electron)' });
    expect(at(9225), 'pid 600 serves its API outside the scan, or serves none — either way we do not know')
      .toMatchObject({ account: '-', state: 'listening (Beeper)' });
    // And where the OS names no owner at all (off win32) there is no pid to join on, so the join
    // adds nothing rather than inventing something: every CDP row is exactly as it was before.
    const off = await topology({ cfg: table, deps: joinDeps({ localOwners: async () => new Map() }) });
    expect(off.rows.filter((r) => r.role === 'cdp').map((r) => [r.account, r.state])).toEqual([
      ['-', 'listening (Beeper)'], ['-', 'listening (Chrome)'], ['-', 'listening (Beeper)'], ['-', 'listening (Beeper)'],
    ]);
  });

  it('carries the api row\'s own state onto a CDP row whose api row answers but takes no token of ours', async () => {
    // A driver aimed here would be driving an install this node cannot name. That is precisely
    // what has to be known BEFORE the number is typed, and it is DERIVED from the joined api row's
    // own state — never assumed from the absence of an account.
    const { rows } = await topology({ cfg: table, deps: joinDeps() });
    expect(rows.find((r) => r.port === 9224)).toMatchObject({ account: '-', state: 'listening (Beeper, up, no token of ours works)' });

    // …and it really is that api row talking: hand 23376 a token it answers, and the CDP row on
    // the same pid becomes that account, with the plain state back.
    const { rows: authed } = await topology({
      cfg: { ...table, beeper: { ...table.beeper, third: { base_url: 'http://127.0.0.1:23376', token: 'tok-third' } } },
      deps: joinDeps({
        probe: async (baseUrl, token) => (Number(new URL(baseUrl).port) === 23376
          ? (token === 'tok-third' ? { ok: true, status: 200, loginID: '@third:beeper.com', networks: ['Beeper'] } : { ok: false, status: 401 })
          : tableProbe(baseUrl, token)),
      }),
    });
    expect(authed.find((r) => r.port === 9224)).toMatchObject({ account: '@third:beeper.com', state: 'listening (Beeper)' });
  });

  // THE RULE THE WORDING EXISTS FOR, locked so it cannot be "improved" back into a claim.
  // A 401 from Beeper's local API is evidence about OUR TOKEN and about nothing else. An install
  // with no approved connection and an install fully signed in as an account whose token this node
  // does not hold answer with the SAME 401 — indistinguishable from outside. The tool once called
  // that `NOT LOGGED IN` and it misled: the operator read it off an install he had just used,
  // signed in as himself (2026-09-04). The cell may say what answered and what was refused; it may
  // not say who is signed in there.
  it('an install answering 401 to every token must NOT be described in terms of login state', async () => {
    const { rows } = await topology({ cfg: table, deps: joinDeps() });
    const rendered = renderTable(rows).split('\n');
    //   23376 api  the install itself     9224 cdp  its debugger, joined by pid and carrying its state
    const cellOf = (port, role) => rendered.find((l) => l.includes(`${port} ${role} `));

    for (const [port, role] of [[23376, 'api'], [9224, 'cdp']]) {
      const cell = cellOf(port, role);
      expect(cell, `the ${port} ${role} row must be in the table for this to lock anything`).toBeTruthy();
      // The literal the tool used to print. Case-insensitive too, so a lowercase rewording of the
      // same claim fails just as loudly — the objection is the CLAIM, not its capitalisation.
      expect(cell, 'a 401 says our token was refused; it says nothing about who is logged in').not.toContain('LOGGED IN');
      expect(cell).not.toMatch(/logged in/i);
      // …and it is not gutted into silence either: what IS known still has to be printed, or the
      // row stops answering "is anything up on this port at all".
      expect(cell, 'the install answered — that is real information').toContain('up');
      expect(cell, 'and no token this node holds was accepted').toContain('no token of ours works');
    }
  });

  it('carries the same CDP labelling for a remote node — it runs THIS tool, so it comes back joined', async () => {
    // The remote did the join over ITS OWN pids and returned finished rows; the parent relabels
    // host/ip and nothing else. A CDP account must therefore survive the trip untouched.
    const remoteProbe = async () => ({
      ok: true,
      ip: '203.0.113.7',
      rows: [
        { host: 'ignored', ip: '?', node: 'do', port: 23373, role: 'api', session: 'S0', account: '@remote:beeper.com', state: 'logged in' },
        { host: 'ignored', ip: '?', node: 'do', port: 9222, role: 'cdp', session: 'S0', account: '@remote:beeper.com', state: 'listening (Beeper)' },
        { host: 'ignored', ip: '?', node: 'do', port: 9223, role: 'cdp', session: 'S0', account: '-', state: 'listening (Beeper, up, no token of ours works)' },
      ],
    });
    const { rows } = await topology({ cfg: table, hosts: ['peer-two'], deps: joinDeps({ remoteProbe }) });
    const remote = rows.filter((r) => r.host === 'peer-two');
    expect(remote.map((r) => [r.port, r.account, r.state])).toEqual([
      [23373, '@remote:beeper.com', 'logged in'],
      [9222, '@remote:beeper.com', 'listening (Beeper)'],
      [9223, '-', 'listening (Beeper, up, no token of ours works)'],
    ]);
    expect(remote.every((r) => r.ip === '203.0.113.7' && r.host === 'peer-two')).toBe(true);
  });

  // ORDER: node, then S0/S1, then api/cdp/console, then port (operator 2026-09-04). The rows of
  // ONE install have to sit together, and the api row that NAMES the account has to come before
  // the cdp row that gets typed into a driver. Port order alone scatters them — 9xxx and 233xx
  // land at opposite ends of the table.
  it('orders by node, then session, then api/cdp/console, then port', async () => {
    // The remote answers with its rows DELIBERATELY out of order: one node's rows are one node's
    // block and the same rule applies inside it, whatever the far end sent.
    const remoteProbe = async () => ({
      ok: true,
      ip: '203.0.113.7',
      rows: [
        { host: 'ignored', ip: '?', node: 'do', port: 23375, role: 'console', session: 'S1', account: '-', state: 'listening' },
        { host: 'ignored', ip: '?', node: 'do', port: 9222, role: 'cdp', session: 'S0', account: '@remote:beeper.com', state: 'listening (Beeper)' },
        { host: 'ignored', ip: '?', node: 'do', port: 23373, role: 'api', session: 'S0', account: '@remote:beeper.com', state: 'logged in' },
      ],
    });
    const { rows } = await topology({ cfg: table, hosts: ['peer-two'], deps: joinDeps({ remoteProbe }) });
    expect(rows.map((r) => `${r.host} ${r.session} ${r.role} ${r.port}`)).toEqual([
      // The local node first, then the peers in the order the operator listed them: that is HIS
      // order, and it is positional — the `node` column is self-reported and says ? for a node
      // that never answered, so it could not carry the grouping anyway.
      'node-one S0 api 23373',      // port breaks the tie between two S0 api rows…
      'node-one S0 api 23376',
      'node-one S0 cdp 9222',       // …but role outranks it: a 9xxx cdp still follows a 233xx api
      'node-one S0 cdp 9224',
      'node-one S1 api 23374',      // and session outranks role: S1's api follows S0's cdp
      'node-one S1 cdp 9223',
      'node-one S1 cdp 9225',
      'node-one S1 console 23375',  // console last of the three roles, not alphabetically third
      'peer-two S0 api 23373',
      'peer-two S0 cdp 9222',
      'peer-two S1 console 23375',
    ]);
  });

  it('sorts a row the OS names no session for LAST within its node, not first', async () => {
    // `-` is the least informative row there is; leading with it would push the answer down.
    const { rows } = await topology({
      cfg: table,
      deps: joinDeps({ localOwners: async () => new Map([[23373, { pid: 100, session: 0, image: 'Beeper.exe' }]]) }),
    });
    expect(rows[0]).toMatchObject({ port: 23373, session: 'S0' });
    expect(rows.slice(1).every((r) => r.session === '-'), 'everything the OS did not name follows it').toBe(true);
  });

  it('keeps an overlay/VPN address but drops host-only virtual switches and link-local', () => {
    // A node can be OFF-LAN: the overlay address may be the only way in, so it must survive.
    expect(localAddresses({
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
      'Wi-Fi': [{ family: 'IPv4', address: '169.254.7.7', internal: false }],
      overlay0: [{ family: 'IPv4', address: '100.64.0.2', internal: false }],
    })).toEqual(['100.64.0.2']);
  });
});

// ---------------------------------------------------------------------------------------------
// THE NODES NAMED IN CONFIG — `egpt_nodes` (operator 2026-09-04: "the table needs to be outputted
// by a tool, not only here"). The topology had been living in chat and being retyped as --host
// flags on every run; the block moves it into config.yaml, where the tool can read it.
//
// What is locked here, in order of how expensive each would be to get wrong:
//   · NO BLOCK = NO CHANGE. The first thing to hold, because every single-node install is that
//     case and none of them asked for any of this.
//   · A PEER IS ONLY EVER SOMETHING THE OPERATOR NAMED. No scan, no ARP, no broadcast, no
//     192.168.* assumption — so `host` (defaulting to the map key) is the way in, and an entry
//     with no `ip` at all is still probed. An eGPT node can be off-LAN.
//   · TWO `self` ENTRIES ARE REPORTED, not resolved by picking one. A wrong pick prints a
//     confidently wrong local row, which is the failure this whole tool exists to avoid.
// The vocabulary stays role-shaped (node-one / peer-two): eGPT is a public tool and no machine,
// person or account name belongs in it. What the table PRINTS is discovered data.
const NODES = {
  'node-one': { type: 'self', name: 'NODE-ONE', ip: '192.0.2.11', ip_type: 'reserved' },
  'peer-two': { type: 'peer', name: 'PEER-TWO', ip: '192.0.2.12', ip_type: 'reserved' },
};

// Records every ssh target asked for, so "which peers were probed" is an assertion and not an
// inference from the rendered rows. Answers as a peer that is up but reports no ssh address.
function spyRemote(answer = async () => ({ ok: false, error: 'not asked' })) {
  const asked = [];
  return { asked, remoteProbe: async (host, opts) => { asked.push(host); return answer(host, opts); } };
}

const remoteRows = (node = 'do') => [
  { host: 'ignored', ip: '?', node, port: 23373, role: 'api', session: 'S0', account: '@remote:beeper.com', state: 'logged in' },
  { host: 'ignored', ip: '?', node, port: 23375, role: 'console', session: 'S0', account: '-', state: 'listening' },
];

describe('beeper-whoami — the nodes named in config (egpt_nodes)', () => {
  it('reads nothing at all from a config that declares no egpt_nodes', () => {
    expect(nodesOf({})).toEqual({ self: null, peers: [], notes: [] });
    expect(nodesOf({ egpt_nodes: null })).toEqual({ self: null, peers: [], notes: [] });
  });

  // THE BASELINE. A node with no egpt_nodes must behave byte-identically: the local row is still
  // hostname() + os.networkInterfaces(), and NOTHING is probed — no ssh, no discovery, nothing.
  it('with NO egpt_nodes: the local row stays auto-detected and no peer is probed', async () => {
    const { asked, remoteProbe } = spyRemote();
    const { rows, notes } = await topology({ cfg: table, deps: tableDeps({ remoteProbe }) });
    expect(asked, 'a config that names no peers must cost no ssh at all').toEqual([]);
    expect([...new Set(rows.map((r) => r.host))]).toEqual(['node-one']);   // the injected hostname()
    expect([...new Set(rows.map((r) => r.ip))]).toEqual(['10.0.0.4']);     // the injected interface
    expect(notes.some((n) => n.startsWith('remote nodes:')), 'it still says how to name one').toBe(true);
  });

  // THE POINT OF THE BLOCK: a bare run, no flags, lists every peer.
  it('probes every peer in config with NO flags, and reaches it by the map key when host: is absent', async () => {
    const { asked, remoteProbe } = spyRemote(async () => ({ ok: true, ip: null, rows: remoteRows() }));
    const { rows, notes } = await topology({ cfg: { ...table, egpt_nodes: NODES }, deps: tableDeps({ remoteProbe }) });

    // `peer-two` carries no host:, so the MAP KEY is the ssh target. `node-one` is self and is
    // never probed — a node does not ssh to itself.
    expect(asked).toEqual(['peer-two']);
    expect(renderTable(rows, notes)).toBe([
      'host      ip          node  port           S0/S1  account                state',
      '--------  ----------  ----  -------------  -----  ---------------------  --------------------------',
      'NODE-ONE  192.0.2.11  kg    23373 api      S0     @primary:beeper.com    logged in',
      'NODE-ONE  192.0.2.11  kg    23376 api      S0     -                      up, no token of ours works',
      'NODE-ONE  192.0.2.11  kg     9222 cdp      S0     @primary:beeper.com    listening (Beeper)',
      'NODE-ONE  192.0.2.11  kg    23374 api      S1     @secondary:beeper.com  logged in',
      'NODE-ONE  192.0.2.11  kg     9223 cdp      S1     -                      listening (Chrome)',
      'NODE-ONE  192.0.2.11  kg    23375 console  S1     -                      listening',
      'PEER-TWO  192.0.2.12  do    23373 api      S0     @remote:beeper.com     logged in',
      'PEER-TWO  192.0.2.12  do    23375 console  S0     -                      listening',
    ].join('\n'));
    // …and with the peers named, the "name them with --host" note has nothing left to ask for.
    expect(notes).toEqual([]);
  });

  it('unions --host with the config peers and deduplicates by SSH TARGET', async () => {
    const { asked, remoteProbe } = spyRemote(async () => ({ ok: false, error: 'down' }));
    await topology({
      cfg: { ...table, egpt_nodes: NODES },
      // peer-two is already in config (same target, one probe); peer-three is not (still works).
      hosts: ['peer-two', 'peer-three'],
      deps: tableDeps({ remoteProbe }),
    });
    expect(asked, 'config first, then the flags config does not already name').toEqual(['peer-two', 'peer-three']);
  });

  it('keeps --host working for a node config does not name at all', async () => {
    const { asked, remoteProbe } = spyRemote(async () => ({ ok: false, error: 'down' }));
    await topology({ cfg: table, hosts: ['peer-three'], deps: tableDeps({ remoteProbe }) });
    expect(asked).toEqual(['peer-three']);
  });

  // The operator knows his own topology better than os.networkInterfaces() does: it can enumerate
  // a machine's addresses but cannot say which one peers use.
  it('lets the self entry name the local row, overriding the auto-detected address', async () => {
    const cfg = { ...table, egpt_nodes: NODES };
    const { rows, notes } = await topology({ cfg, deps: tableDeps({ localAddresses: () => ['10.0.0.4', '100.64.0.2'] }) });
    expect(rows[0].host).toBe('NODE-ONE');
    expect(rows[0].ip).toBe('192.0.2.11');
    // …and the "several addresses, so ip reads ?" note is gone with it: the question it explains
    // has been answered, and repeating it over a declared address would just read as a warning.
    expect(notes.some((n) => n.includes('several addresses'))).toBe(false);
  });

  it('falls back to auto-detection for anything the self entry leaves out', async () => {
    const cfg = { ...table, egpt_nodes: { 'node-one': { type: 'self', name: 'NODE-ONE' } } };
    const { rows } = await topology({ cfg, deps: tableDeps() });
    expect(rows[0].host).toBe('NODE-ONE');
    expect(rows[0].ip, 'no ip declared, so the measured one still stands').toBe('10.0.0.4');
  });

  // OFF-LAN IS A FIRST-CLASS CASE, not a degraded one: a node reachable only by a tailscale/DNS
  // name has no meaningful ip, and `ip` is never how a node is reached anyway.
  it('probes a peer that has host: and no ip at all', async () => {
    const { asked, remoteProbe } = spyRemote(async () => ({ ok: true, ip: null, rows: remoteRows('far') }));
    const cfg = { ...table, egpt_nodes: { 'peer-two': { type: 'peer', host: 'peer-two.tailnet.example' } } };
    const { rows } = await topology({ cfg, deps: tableDeps({ remoteProbe }) });

    expect(asked).toEqual(['peer-two.tailnet.example']);
    const remote = rows.filter((r) => r.node === 'far');
    expect(remote).toHaveLength(2);
    // No name: ⇒ the ssh target labels the row. No ip anywhere ⇒ ? , never a guess.
    expect(remote[0].host).toBe('peer-two.tailnet.example');
    expect(remote[0].ip).toBe('?');
  });

  it('prefers the address ssh actually connected to over the one config declares', async () => {
    const { remoteProbe } = spyRemote(async () => ({ ok: true, ip: '203.0.113.7', rows: remoteRows() }));
    const { rows } = await topology({ cfg: { ...table, egpt_nodes: NODES }, deps: tableDeps({ remoteProbe }) });
    expect(rows.find((r) => r.host === 'PEER-TWO').ip, 'measured beats declared').toBe('203.0.113.7');
  });

  it('shows a configured peer that does not answer as unreachable, keeping its declared address', async () => {
    const { remoteProbe } = spyRemote(async () => ({ ok: false, ip: null, error: 'ssh: connect to host peer-two port 22: Connection timed out' }));
    const { rows, notes } = await topology({ cfg: { ...table, egpt_nodes: NODES }, deps: tableDeps({ remoteProbe }) });
    expect(rows.find((r) => r.host === 'PEER-TWO')).toMatchObject({ node: '?', port: '-', state: 'unreachable', ip: '192.0.2.12' });
    // The note names the SSH TARGET, not the label: that is the string the operator would retype.
    expect(notes.some((n) => n.startsWith('peer-two: unreachable -'))).toBe(true);
  });

  // A wrong pick prints a confidently wrong local row, and the operator would have no way to see
  // that the tool chose. So it says so and measures instead.
  it('REPORTS two self entries rather than resolving them by picking one', async () => {
    const { asked, remoteProbe } = spyRemote();
    const cfg = {
      ...table,
      egpt_nodes: {
        'node-one': { type: 'self', name: 'NODE-ONE', ip: '192.0.2.11' },
        'node-two': { type: 'self', name: 'NODE-TWO', ip: '192.0.2.13' },
      },
    };
    const { self, notes } = nodesOf(cfg);
    expect(self, 'neither one is chosen').toBe(null);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('node-one, node-two');
    expect(notes[0]).toContain('type: self');

    const t = await topology({ cfg, deps: tableDeps({ remoteProbe }) });
    expect(t.notes[0], 'the report reaches the operator, at the top of the table').toBe(notes[0]);
    expect(t.rows[0].host, 'and the local row falls back to what it can measure').toBe('node-one');
    expect(t.rows[0].ip).toBe('10.0.0.4');
    expect(asked, 'a self entry is never a peer, however many of them there are').toEqual([]);
  });

  // --json is what a REMOTE node returns to whoever asked. If it fanned out to its own config
  // peers, two nodes listing each other would ssh back and forth and never come back.
  it('fans out to NOTHING with configPeers: false — the shape --json runs', async () => {
    const { asked, remoteProbe } = spyRemote();
    await topology({ cfg: { ...table, egpt_nodes: NODES }, configPeers: false, deps: tableDeps({ remoteProbe }) });
    expect(asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// THE SESSION SUMMARY — the DEFAULT view (operator 2026-09-05: "i only want to see s0 in kg/dolly
// beeper ports. it has to say logged in s0 with <account>, logged in s1 with <account>"). He does
// not care which port a Beeper install happened to take; he cares WHICH ACCOUNT IS LOGGED IN, IN
// WHICH SESSION, ON WHICH NODE. So the default is keyed by node x session and the port numbers
// drop out — except the install's own cdp port, which is the number he types into a driver.
//
// It is a PROJECTION over the same topology() rows the port map renders, so both are locked here
// off ONE fixture: same probes, same owners, same remote, two renderings. What that fixture
// carries, and why each piece is in it:
//   kg S0  the primary install, and its debugger on the SAME pid  -> account + cdp 9222
//   kg S1  the secondary install, no debugger of its own          -> account + cdp -
//   kg S2  the spine console and somebody's Chrome, NO Beeper     -> NO ROW AT ALL
//   do S0  a peer, logged in, joined to its own debugger remotely -> account + cdp 9222
//   do S1  an install that answers and 401s every token we hold   -> `-` and the verbatim state
//   peer-three  a node that never answered                        -> one `unreachable` row
const summaryProbe = async (baseUrl, token) => {
  const port = Number(new URL(baseUrl).port);
  const owner = { 23373: 'tok-primary', 23374: 'tok-secondary' }[port];
  if (!owner) return { ok: false, status: 0, error: 'ECONNREFUSED' };
  if (token !== owner) return { ok: false, status: 401 };
  return port === 23373
    ? { ok: true, status: 200, loginID: '@primary:beeper.com', email: 'operator@example.com', networks: ['Beeper'] }
    : { ok: true, status: 200, loginID: '@secondary:beeper.com', email: 'agents@example.com', networks: ['Beeper'] };
};

// SESSION 2 HOLDS THE CONSOLE AND A CHROME AND NOTHING ELSE — a real shape (a second interactive
// login), and the one that proves the summary reports the sessions it FOUND A BEEPER IN rather
// than every session the OS happens to have.
const summaryOwners = async () => new Map([
  [23373, { pid: 100, session: 0, image: 'Beeper.exe' }],
  [23374, { pid: 200, session: 1, image: 'Beeper.exe' }],
  [23375, { pid: 300, session: 2, image: 'node.exe' }],
  [9222, { pid: 100, session: 0, image: 'Beeper.exe' }],   // the SAME process as 23373
  [9223, { pid: 500, session: 2, image: 'chrome.exe' }],   // nobody's install
]);

// The peer runs THIS tool and answers --json, so its api rows arrive already joined over ITS OWN
// pids — `cdp` included. A pid means nothing across a network and is never joined across nodes.
const summaryRemoteRows = [
  { host: 'ignored', ip: '?', node: 'do', port: 23373, role: 'api', session: 'S0', account: '@remote:beeper.com', state: 'logged in', cdp: 9222 },
  { host: 'ignored', ip: '?', node: 'do', port: 9222, role: 'cdp', session: 'S0', account: '@remote:beeper.com', state: 'listening (Beeper)' },
  { host: 'ignored', ip: '?', node: 'do', port: 23374, role: 'api', session: 'S1', account: '-', state: 'up, no token of ours works', cdp: null },
  { host: 'ignored', ip: '?', node: 'do', port: 23375, role: 'console', session: 'S1', account: '-', state: 'listening' },
];

const summaryDeps = (over = {}) => ({
  probe: summaryProbe,
  localOwners: summaryOwners,
  tcpListening: async (port) => port === 23375,
  cdpProbe: async (port) => (port === 9222 ? { ok: true, label: 'Beeper' }
    : port === 9223 ? { ok: true, label: 'Chrome' }
    : { ok: false }),
  localAddresses: () => ['10.0.0.4'],
  hostname: () => 'node-one',
  remoteProbe: async (host) => (host === 'peer-two'
    ? { ok: true, ip: '203.0.113.7', rows: summaryRemoteRows }
    : { ok: false, ip: '198.51.100.9', error: 'ssh: connect to host peer-three port 22: Connection timed out' }),
  ...over,
});

const summaryTopology = (over = {}, hosts = ['peer-two', 'peer-three']) =>
  topology({ cfg: table, hosts, deps: summaryDeps(over) });

describe('beeper-whoami — the session summary (the default view)', () => {
  it('prints node | session | account | state | cdp, one line per Beeper install', async () => {
    const { rows, notes } = await summaryTopology();
    expect(renderSummary(summarize(rows), notes)).toBe([
      'node        session  account                state                       cdp',
      '----------  -------  ---------------------  --------------------------  ----',
      // The account and the session are the answer; 9222 is the one port that survives, because
      // it is the number typed into a driver and the account alone cannot tell you it.
      'kg          S0       @primary:beeper.com    logged in                   9222',
      'kg          S1       @secondary:beeper.com  logged in                   -',
      // kg S2 has the console and a Chrome and no Beeper, so it is ABSENT — not an empty row.
      'do          S0       @remote:beeper.com     logged in                   9222',
      // Verbatim, and it stays a statement about our token: see the login-state lock below.
      'do          S1       -                      up, no token of ours works  -',
      // A node that never answered has no session to report and must still be SEEN. It reports no
      // node name either, so the ssh target labels it — that is the string you would retype.
      'peer-three  -        -                      unreachable                 -',
      '',
      'peer-three: unreachable - ssh: connect to host peer-three port 22: Connection timed out',
    ].join('\n'));
  });

  // THE PORT MAP IS NOT DELETED, IT IS DEMOTED. "What is listening and why" is still a real
  // question, so --ports renders exactly the table that used to be the default, byte for byte,
  // off these same rows.
  it('--ports still renders the full port map, unchanged', async () => {
    const { rows, notes } = await summaryTopology();
    expect(renderTable(rows, notes)).toBe([
      'host        ip            node  port           S0/S1  account                state',
      '----------  ------------  ----  -------------  -----  ---------------------  --------------------------',
      'node-one    10.0.0.4      kg    23373 api      S0     @primary:beeper.com    logged in',
      'node-one    10.0.0.4      kg     9222 cdp      S0     @primary:beeper.com    listening (Beeper)',
      'node-one    10.0.0.4      kg    23374 api      S1     @secondary:beeper.com  logged in',
      'node-one    10.0.0.4      kg     9223 cdp      S2     -                      listening (Chrome)',
      'node-one    10.0.0.4      kg    23375 console  S2     -                      listening',
      'peer-two    203.0.113.7   do    23373 api      S0     @remote:beeper.com     logged in',
      'peer-two    203.0.113.7   do     9222 cdp      S0     @remote:beeper.com     listening (Beeper)',
      'peer-two    203.0.113.7   do    23374 api      S1     -                      up, no token of ours works',
      'peer-two    203.0.113.7   do    23375 console  S1     -                      listening',
      'peer-three  198.51.100.9  ?     -              -      -                      unreachable',
      '',
      'peer-three: unreachable - ssh: connect to host peer-three port 22: Connection timed out',
    ].join('\n'));
  });

  // A session the OS reports but no Beeper lives in is not a Beeper session. Printing an empty row
  // for it would read as "the install is missing" rather than "there was never one here".
  it('never invents a session row: a session with no Beeper is absent, not blank', async () => {
    const { rows } = await summaryTopology();
    const sum = summarize(rows);
    expect(rows.some((r) => r.session === 'S2'), 'the fixture must really have an S2 for this to lock anything').toBe(true);
    expect(sum.some((r) => r.session === 'S2')).toBe(false);
    expect(sum.map((r) => `${r.node} ${r.session}`)).toEqual(['kg S0', 'kg S1', 'do S0', 'do S1', 'peer-three -']);
  });

  it('drops the console and the cdp rows — a debugger is the same install counted twice', async () => {
    const { rows } = await summaryTopology();
    expect(rows.some((r) => r.role === 'console') && rows.some((r) => r.role === 'cdp'), 'both are in the port map').toBe(true);
    expect(summarize(rows), 'four installs and one unreachable node').toHaveLength(5);
  });

  // The cdp cell is the PID JOIN, not a port that happens to be up. 9223 is listening and is
  // nobody's install, so it never reaches a row; 23374's process runs no debugger, so it reads `-`.
  it('takes the cdp port from the install own process, never from a port merely being up', async () => {
    const { rows } = await summaryTopology();
    const at = (node, session) => summarize(rows).find((r) => r.node === node && r.session === session);
    expect(at('kg', 'S0').cdp, 'pid 100 serves 23373 and 9222 — one process, one install').toBe('9222');
    expect(at('kg', 'S1').cdp, 'pid 200 runs no debugger; 9223 is Chrome and belongs to nobody here').toBe('-');
    expect(summarize(rows).some((r) => r.cdp === '9223')).toBe(false);
  });

  // THE SAME RULE AS THE PORT MAP'S STATE CELL, in the view the operator actually reads. A 401 is
  // evidence about OUR TOKEN and nothing else: a signed-out install and one signed in as an account
  // whose token this node does not hold answer identically. The tool once called that `NOT LOGGED
  // IN` and the operator read it off an install he had just used, signed in as himself (2026-09-04).
  it('never describes an install that only 401d us in terms of login state', async () => {
    const { rows, notes } = await summaryTopology();
    const line = renderSummary(summarize(rows), notes).split('\n').find((l) => l.startsWith('do          S1'));
    expect(line, 'the row must be in the summary for this to lock anything').toBeTruthy();
    expect(line).not.toMatch(/logged in/i);
    expect(line, 'the install answered — that is real information').toContain('up');
    expect(line, 'and no token this node holds was accepted').toContain('no token of ours works');
  });

  // OFF WINDOWS THE SUMMARY STILL ANSWERS, it just answers less: localOwners returns nothing, so
  // there is no session and no pid. The accounts and states are measured over plain HTTP and are
  // unaffected, so the rows STAY and a note says why the column is empty. Collapsing to nothing
  // would throw away the part that still works; guessing a session from a port number would be a lie.
  it('keeps every row where the OS names no session, and says why the column is -', async () => {
    const { rows, notes } = await summaryTopology({ localOwners: async () => new Map(), remoteProbe: async () => ({ ok: false, noSsh: true }) }, []);
    expect(summarize(rows).map((r) => [r.session, r.account, r.state, r.cdp])).toEqual([
      // No pid either, so no join: `-` rather than 9222 guessed off a port that is merely up.
      ['-', '@primary:beeper.com', 'logged in', '-'],
      ['-', '@secondary:beeper.com', 'logged in', '-'],
    ]);
    expect(renderSummary(summarize(rows), notes)).toContain('session: the OS named none of these');
  });

  it('does not blame the OS when it named the sessions it could', async () => {
    // The local half is sessionless here but the peer answered with S0/S1 of its own, so the note
    // would be false — the column is populated, just not everywhere.
    const { rows, notes } = await summaryTopology({ localOwners: async () => new Map() }, ['peer-two']);
    expect(renderSummary(summarize(rows), notes)).not.toContain('session: the OS named none of these');
  });

  // THE DEFAULT IS THE DELIVERABLE. --json stays the full row list because that is the leaf shape a
  // peer answers with — a remote that returned the summary would strip the port map off every peer.
  it('wires the CLI: summary by default, --ports for the map, --json still the rows', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/tools/beeper-whoami.mjs', import.meta.url)), 'utf8');
    const cli = src.slice(src.indexOf('if (isMain)'));
    expect(cli).toContain("a === '--ports'");
    expect(cli).toMatch(/ports \? renderTable\(rows, notes\) : renderSummary\(summarize\(rows\), notes\)/);
    expect(cli).toContain('JSON.stringify(rows)');
  });
});
