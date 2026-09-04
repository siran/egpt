// beeper-whoami — WHICH Desktop is on which port, and whose account it is (operator 2026-09-03).
// No Beeper and no network: probe and the Windows socket-owner lookup are both injected.
//
// What is locked here is the reasoning the tool exists for. A 401 is a RESULT, not a failure:
// a token belongs to an INSTALL, so it is the 401 from the OTHER connection that proves two
// separate Desktops are answering rather than one. And a connection with no base_url must be
// reported as riding the bridge DEFAULT (23373) rather than as unset, because that default is
// exactly what the spine would ride.
import { describe, it, expect } from 'vitest';
import { connectionsOf, report, topology, renderTable, localAddresses, shellPortOf, nodesOf } from '../src/tools/beeper-whoami.mjs';

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
  // every one. Reading only the top-level `token` loses them all and then reports a perfectly
  // healthy install as NOT LOGGED IN — measured live on 2026-09-04, right after the operator's
  // own `main` moved its token into `endpoints:`. The two states are opposite ("it refused us"
  // vs "we never asked"), so losing a token is not a missing row, it is a WRONG one.
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

  it('reads a 401 as PROOF of a different install, never as a broken token', async () => {
    const out = await report({ cfg, deps: { probe: fakeProbe, localOwners: fakeOwners } });
    expect(out).toMatch(/s1: 401\s+a different install answers here/);
    expect(out).toMatch(/main \(use\): 401\s+a different install answers here/);
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
//   logged in            a token of ours got 200 there
//   NOT LOGGED IN        it answers, and 401s every token we hold
//   no token in config   we never asked — an unauthenticated 401 looks identical, means the opposite
//   not listening        nothing answered at all
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
      '----------  ------------  ----  -------------  -----  ---------------------  ------------------',
      'node-one    10.0.0.4      kg    23373 api      S0     @primary:beeper.com    logged in',
      'node-one    10.0.0.4      kg    23374 api      S1     @secondary:beeper.com  logged in',
      'node-one    10.0.0.4      kg    23375 console  S1     -                      listening',
      'node-one    10.0.0.4      kg    23376 api      S0     -                      NOT LOGGED IN',
      'node-one    10.0.0.4      kg     9222 cdp      S0     -                      listening (Beeper)',
      'node-one    10.0.0.4      kg     9223 cdp      S1     -                      listening (Chrome)',
      'peer-two    203.0.113.7   do    23373 api      S0     @remote:beeper.com     logged in',
      'peer-two    203.0.113.7   do    23375 console  S0     -                      listening',
      'peer-three  198.51.100.9  ?     -              -      -                      unreachable',
      '',
      'peer-three: unreachable - ssh: connect to host peer-three port 22: Connection timed out',
    ].join('\n'));
  });

  it('reads an install that answers and 401s every token we hold as NOT LOGGED IN', async () => {
    const { rows } = await topology({ cfg: table, deps: tableDeps() });
    const up = rows.find((r) => r.port === 23376);
    expect(up.state).toBe('NOT LOGGED IN');
    expect(up.account, 'there is no account to name when nothing authenticated').toBe('-');
  });

  it('never reads "we never asked" as "it refused us" — no token is its own state', async () => {
    // An UNAUTHENTICATED request comes back 401 exactly like a foreign install's token does, and
    // the two mean opposite things. Reading the second as the first is a confident wrong answer.
    const noTok = { ...table, beeper: { use: 'primary', primary: { base_url: 'http://127.0.0.1:23376' } } };
    const { rows } = await topology({ cfg: noTok, deps: tableDeps() });
    const row = rows.find((r) => r.port === 23376);
    expect(row.state).toBe('no token in config');
    expect(rows.some((r) => r.state === 'NOT LOGGED IN')).toBe(false);
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
      '--------  ----------  ----  -------------  -----  ---------------------  ------------------',
      'NODE-ONE  192.0.2.11  kg    23373 api      S0     @primary:beeper.com    logged in',
      'NODE-ONE  192.0.2.11  kg    23374 api      S1     @secondary:beeper.com  logged in',
      'NODE-ONE  192.0.2.11  kg    23375 console  S1     -                      listening',
      'NODE-ONE  192.0.2.11  kg    23376 api      S0     -                      NOT LOGGED IN',
      'NODE-ONE  192.0.2.11  kg     9222 cdp      S0     -                      listening (Beeper)',
      'NODE-ONE  192.0.2.11  kg     9223 cdp      S1     -                      listening (Chrome)',
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
