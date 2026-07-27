// tests/config-command.test.mjs — /config [set <key> <value>] (src/spine/commands.mjs
// configCmd), replacing the unrecognized-command catch-all fallthrough for the operator's
// live line `/config set default_node do`. Every test injects its OWN temp configPath — never
// the real ~/.egpt/config/config.yaml.
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

describe('/config set — bare leaf + dotted path resolution, write, redaction', () => {
  it('REPRODUCE-FIRST: /config set default_node do resolves the bare leaf to dispatch.default_node, writes it, and confirms the resolved path', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, configPath });
    await cmds.run({ body: '/config set default_node do', chatId: '!self', authorized: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    expect(sent[0].text).toMatch(/next restart/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/dispatch:\s*\n\s*default_node: do/);
  });

  it('dotted path form (dispatch.default_node) behaves identically to the bare-leaf form', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config set dispatch.default_node do', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/dispatch:\s*\n\s*default_node: do/);
  });

  it('value parsing mirrors the extension prototype: JSON.parse, falling back to the raw string', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config set dispatch.auto_paused true', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/set dispatch\.auto_paused = true/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/auto_paused: true/);   // real boolean, not the string "true"
  });

  it('comment-preservation: a config.yaml with comments keeps every comment after a /config set write', async () => {
    const initial = `# operator notes: do not remove this block\nnode_name: kg   # inline note on node_name\n`;
    const configPath = await tmpConfigPath(initial);
    const { cmds } = harness({ config: { node_name: 'kg' }, configPath });
    await cmds.run({ body: '/config set default_node do', chatId: '!self', authorized: true });
    const after = await readFile(configPath, 'utf8');
    // eslint-disable-next-line no-console
    console.log('--- comment-preservation BEFORE ---\n' + initial + '--- AFTER ---\n' + after);
    expect(after).toContain('# operator notes: do not remove this block');
    expect(after).toContain('# inline note on node_name');
    expect(after).toContain('default_node: do');
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

  it('unregistered key refused — the config file is not created', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config set totallyMadeUpKey banana', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/not a registered config key/);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });

  it('ambiguous bare leaf refused with candidates listed — "enabled" is a KEYS: leaf under 4 top-level blocks', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config set enabled true', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/matches more than one/);
    expect(sent[0].text).toMatch(/local_llm\.enabled/);
    expect(sent[0].text).toMatch(/transcription\.enabled/);
    expect(sent[0].text).toMatch(/transcription_service\.enabled/);
    expect(sent[0].text).toMatch(/transcriptor\.enabled/);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });

  it('usage reply for a bare "set" with missing args — no write', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config set', chatId: '!self', authorized: true });
    expect(sent[0].text).toMatch(/usage: \/config/);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });
});

describe('/config participates in node addressing (NODE_ADDRESSABLE gate)', () => {
  it('/config=do set default_node do applies LOCALLY on the node named "do", replying with the resolved path', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'do', account_peers: ['kg', 'do'] }, configPath });
    await cmds.run({ body: '/config=do set default_node do', chatId: '!fam', surface: 'whatsapp', authorized: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/default_node: do/);
  });

  it('/config=do set default_node do stays SILENT on a co-account peer node that is NOT named (kg)', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'kg', account_peers: ['kg', 'do'] }, configPath });
    await cmds.run({ body: '/config=do set default_node do', chatId: '!fam', surface: 'whatsapp', authorized: true });
    expect(sent).toHaveLength(0);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();   // never touched
  });
});

describe('LOCK: lifecycle + STOP still not node-addressable after /config joined NODE_ADDRESSABLE', () => {
  it('/restart do, /upgrade do, /rewind do, and the STOP safe word never resolve to a remote node', async () => {
    const configPath = await tmpConfigPath();
    const { cmds } = harness({ config: { node_name: 'kg', account_peers: ['kg', 'do'] }, configPath });
    for (const body of ['/restart do', '/upgrade do', '/rewind do', 'stop']) {
      expect(cmds.remoteNode({ body, surface: 'shell', chatId: 'main' })).toBe(null);
    }
  });
});
