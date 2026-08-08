// tests/config-command.test.mjs — /config [<key>[=<value>]] (src/spine/commands.mjs
// configCmd), the `=` grammar (operator ruling 2026-07-28) that replaced the one-day-old
// `set`/`get` sub-verbs: bare = the redacted dump, `<key>` = GET, `<key>=<value>` = SET.
// Every test injects its OWN temp configPath — never the real ~/.egpt/config/config.yaml.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';

async function tmpConfigPath(initial = null) {
  const dir = await mkdtemp(join(tmpdir(), 'egpt-config-cmd-'));
  const fp = join(dir, 'config.yaml');
  if (initial != null) await writeFile(fp, initial, 'utf8');
  return fp;
}

function harness({ config = {}, configPath }) {
  const sent = [];
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    exit: () => {},
    configPath,
  });
  return { cmds, sent };
}

describe('/config <key>=<value> — bare leaf + dotted path resolution, write, redaction', () => {
  it("REPRODUCE-FIRST: /config=kg default_node=do resolves the bare leaf to dispatch.default_node, writes it, and confirms the resolved path", async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, configPath });
    await cmds.run({ body: '/config=kg default_node=do', chatId: '!self', authorized: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    // Names the COMMAND, not just "restart": the operator relaunched the editor and wondered
    // why nothing changed — the spine is a separate, long-running process.
    expect(sent[0].text).toMatch(/\/restart/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/dispatch:\s*\n\s*default_node: do/);
  });

  it('dotted path form (dispatch.default_node) behaves identically to the bare-leaf form', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config dispatch.default_node=do', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/dispatch:\s*\n\s*default_node: do/);
  });

  it('value parsing mirrors the extension prototype: JSON.parse, falling back to the raw string', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config dispatch.auto_paused=true', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/set dispatch\.auto_paused = true/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/auto_paused: true/);   // real boolean, not the string "true"
  });

  it('a value containing its own "=" (a URL query string) survives whole — only the FIRST "=" is the boundary', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config transcription.server.endpoint=https://example.com/hook?a=b&c=d', chatId: '!self', authorized: true });
    expect(sent[0].text).toContain('https://example.com/hook?a=b&c=d');
    const written = await readFile(configPath, 'utf8');
    expect(written).toContain('https://example.com/hook?a=b&c=d');
  });

  it('"<key>=" with an empty value sets an empty string — the natural way to clear default_node', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'do', dispatch: { default_node: 'do' } }, configPath });
    await cmds.run({ body: '/config default_node=', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/dispatch\.default_node = ""/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/default_node: ''|default_node: ""/);
  });

  it('comment-preservation: a config.yaml with comments keeps every comment after a /config <key>=<value> write', async () => {
    const initial = `# operator notes: do not remove this block\nnode_name: kg   # inline note on node_name\n`;
    const configPath = await tmpConfigPath(initial);
    const { cmds } = harness({ config: { node_name: 'kg' }, configPath });
    await cmds.run({ body: '/config default_node=do', chatId: '!self', authorized: true });
    const after = await readFile(configPath, 'utf8');
    // eslint-disable-next-line no-console
    console.log('--- comment-preservation BEFORE ---\n' + initial + '--- AFTER ---\n' + after);
    expect(after).toContain('# operator notes: do not remove this block');
    expect(after).toContain('# inline note on node_name');
    expect(after).toContain('default_node: do');
  });

  it('the write is ONE line — full file text, not a parse', async () => {
    const initial = `node_name: kg\n`;
    const configPath = await tmpConfigPath(initial);
    const { cmds } = harness({ config: { node_name: 'kg' }, configPath });
    await cmds.run({ body: '/config default_node=do', chatId: '!self', authorized: true });
    const after = await readFile(configPath, 'utf8');
    expect(after).toBe('node_name: kg\ndispatch:\n  default_node: do\n');
  });

  it('token redaction: bare /config dump never leaks a token/secret/key/password-ish value', async () => {
    const configPath = await tmpConfigPath();
    const config = {
      beeper: { use: 'main', main: { account: 'me@example', token: 'SUPER-SECRET-TOKEN-VALUE' } },
      bus_key: 'ANOTHER-SECRET-VALUE',
      node_name: 'kg',
    };
    const { cmds, sent } = harness({ config, configPath });
    await cmds.run({ body: '/config', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPER-SECRET-TOKEN-VALUE');
    expect(sent[0].text).not.toContain('ANOTHER-SECRET-VALUE');
    expect(sent[0].text).toContain('<redacted>');
    expect(sent[0].text).toContain('node_name');   // an ordinary key is untouched
  });

  it('token redaction: radio_service.<name>.relay_password never leaks in a bare /config dump', async () => {
    const configPath = await tmpConfigPath();
    const config = {
      node_name: 'kg',
      radio_service: { wildnloyal: { enabled: false, endpoint: 'https://radio.wildnloyal.org', relay_user: 'egpt', relay_password: 'SUPER-SECRET-RELAY-PASSWORD' } },
    };
    const { cmds, sent } = harness({ config, configPath });
    await cmds.run({ body: '/config', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPER-SECRET-RELAY-PASSWORD');
    expect(sent[0].text).toContain('<redacted>');
    expect(sent[0].text).toContain('relay_user');   // an ordinary sibling key is untouched
  });

  it('unregistered key refused — the config file is not created', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config totallyMadeUpKey=banana', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/not a registered config key/);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });

  it('ambiguous bare leaf refused with candidates listed — "enabled" is a KEYS: leaf under 4 top-level blocks', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config enabled=true', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/matches more than one/);
    expect(sent[0].text).toMatch(/local_llm\.enabled/);
    expect(sent[0].text).toMatch(/transcription\.enabled/);
    expect(sent[0].text).toMatch(/transcription_service\.enabled/);
    expect(sent[0].text).toMatch(/transcriptor\.enabled/);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });

  it('spaces around "=" are rejected with an explicit usage message — the strict, unambiguous form', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config default_node = do', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/usage: \/config/);
    expect(sent[0].text).toMatch(/no spaces around/);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });
});

describe('/config <key> — bare-key GET, mirrors the write path\'s resolution + redaction', () => {
  it('REPRODUCE-FIRST: /config default_node resolves the bare leaf and names dispatch.default_node = "do"', async () => {
    // node_name matches default_node so the NODE GATE (run() line ~583) resolves this LOCALLY —
    // an isolated cmds.run() has no mesh to forward through, so a default_node naming ANOTHER
    // node would silently drop the command here (that forwarding path is covered separately in
    // tests/remote-command.test.mjs, which runs the full spine+mesh stack).
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'do', dispatch: { default_node: 'do' } }, configPath });
    await cmds.run({ body: '/config default_node', chatId: '!self', authorized: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    expect(sent[0].text).toMatch(/do/);
  });

  it('dotted path form (dispatch.default_node) behaves identically to the bare-leaf form', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'do', dispatch: { default_node: 'do' } }, configPath });
    await cmds.run({ body: '/config dispatch.default_node', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/dispatch\.default_node = "do"/);
  });

  it('a registered key with no value set replies "is unset", distinct from an unregistered refusal', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config default_node', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/dispatch\.default_node is unset/);
  });

  it('token redaction: a GET of a token-ish key never leaks the real value', async () => {
    const configPath = await tmpConfigPath();
    const config = {
      beeper: { use: 'main', main: { account: 'me@example', token: 'SUPER-SECRET-TOKEN-VALUE' } },
    };
    const { cmds, sent } = harness({ config, configPath });
    await cmds.run({ body: '/config beeper.main.token', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPER-SECRET-TOKEN-VALUE');
    expect(sent[0].text).toContain('<redacted>');
  });

  it('token redaction: a GET of radio_service.<name>.relay_password never leaks the real value', async () => {
    const configPath = await tmpConfigPath();
    const config = {
      radio_service: { wildnloyal: { relay_password: 'SUPER-SECRET-RELAY-PASSWORD' } },
    };
    const { cmds, sent } = harness({ config, configPath });
    await cmds.run({ body: '/config radio_service.wildnloyal.relay_password', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPER-SECRET-RELAY-PASSWORD');
    expect(sent[0].text).toContain('<redacted>');
  });

  it('unregistered key refused with the same message the write path uses', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config totallyMadeUpKey', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/not a registered config key/);
  });

  it('ambiguous bare leaf refused with candidates listed, same as the write path', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config enabled', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/matches more than one/);
    expect(sent[0].text).toMatch(/local_llm\.enabled/);
  });
});

describe('/config participates in node addressing (NODE_ADDRESSABLE gate)', () => {
  it('/config=do default_node=do applies LOCALLY on the node named "do", replying with the resolved path', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'do', account_peers: ['kg', 'do'] }, configPath });
    await cmds.run({ body: '/config=do default_node=do', chatId: '!fam', surface: 'whatsapp', authorized: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/default_node: do/);
  });

  it('/config=do default_node=do stays SILENT on a co-account peer node that is NOT named (kg)', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'kg', account_peers: ['kg', 'do'] }, configPath });
    await cmds.run({ body: '/config=do default_node=do', chatId: '!fam', surface: 'whatsapp', authorized: true });
    expect(sent).toHaveLength(0);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();   // never touched
  });
});

describe('LOCK: lifecycle + STOP still not node-addressable after /config joined NODE_ADDRESSABLE', () => {
  it('/restart do, /upgrade do, /rewind do, and the STOP safe word never resolve to a remote node — even with default_node set', async () => {
    const configPath = await tmpConfigPath();
    const { cmds } = harness({ config: { node_name: 'kg', account_peers: ['kg', 'do'], dispatch: { default_node: 'do' } }, configPath });
    for (const body of ['/restart do', '/upgrade do', '/rewind do', 'stop']) {
      expect(cmds.remoteNode({ body, surface: 'shell', chatId: 'main' })).toBe(null);
    }
  });
});
