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
  it("REPRODUCE-FIRST: /config default_node=do resolves the bare leaf to dispatch.default_node, writes it, and confirms the resolved path", async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: { node_name: 'kg' }, configPath });
    await cmds.run({ body: '/config default_node=do', chatId: '!self', authorized: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    // A hot key (step B): the spine swaps the re-read file in on its next tick.
    expect(sent[0].text).toMatch(/next tick, no restart/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/dispatch:\s*\n\s*default_node: do/);
  });

  it('a restart-only key (config-swap.mjs RESTART_KEYS) says so and names the COMMAND', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: {}, configPath });
    await cmds.run({ body: '/config shell.port=23999', chatId: '!self', authorized: true });
    // Names the COMMAND, not just "restart": the operator relaunched the editor and wondered
    // why nothing changed — the spine is a separate, long-running process.
    expect(sent[0].text).toMatch(/restart-only key.*\/restart/);
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
      radio_service: { examplefm: { enabled: false, endpoint: 'https://radio.examplefm.example', relay_user: 'egpt', relay_password: 'SUPER-SECRET-RELAY-PASSWORD' } },
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
    expect(sent[0].text).toMatch(/usage: \/<handle> config/);
    expect(sent[0].text).toMatch(/no spaces around/);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();
  });
});

describe('/config <key> — bare-key GET, mirrors the write path\'s resolution + redaction', () => {
  it('REPRODUCE-FIRST: /config default_node resolves the bare leaf and names dispatch.default_node = "do"', async () => {
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
      radio_service: { examplefm: { relay_password: 'SUPER-SECRET-RELAY-PASSWORD' } },
    };
    const { cmds, sent } = harness({ config, configPath });
    await cmds.run({ body: '/config radio_service.examplefm.relay_password', chatId: '!self', authorized: true });
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

// A command names its being (2026-10-19): the being's node runs it, the other node does not.
// `typed` is the spine's own reading (classify): commandOf, then isCommand, then run.
const KG = { node_name: 'kg', peer_nodes: ['kg', 'do'], agents: { egpt: { handles: ['e', 'egpt'], default: true } } };
const DO = { node_name: 'do', peer_nodes: ['kg', 'do'], agents: { egpt: { handles: ['d', 'don'], default: true } } };
async function typed(cmds, ev) {
  const c = cmds.commandOf(ev);
  if (!c || c.commandElsewhere || !(await cmds.isCommand(c))) return c;
  await cmds.run(c);
  return c;
}

describe('/config runs on the node of the being it is typed to', () => {
  it('/d config default_node=do applies on do (D\'s node), replying with the resolved path', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: DO, configPath });
    await typed(cmds, { body: '/d config default_node=do', chatId: '!fam', surface: 'whatsapp', authorized: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/dispatch\.default_node/);
    const written = await readFile(configPath, 'utf8');
    expect(written).toMatch(/default_node: do/);
  });

  it('/d config default_node=do is not a command on kg: nothing said, nothing written', async () => {
    const configPath = await tmpConfigPath();
    const { cmds, sent } = harness({ config: KG, configPath });
    const c = await typed(cmds, { body: '/d config default_node=do', chatId: '!fam', surface: 'whatsapp', authorized: true });
    expect(c.commandElsewhere).toBe('d');
    expect(sent).toHaveLength(0);
    await expect(readFile(configPath, 'utf8')).rejects.toThrow();   // never touched
  });
});

describe('LOCK: lifecycle typed to another node\'s being never runs here; STOP is no command', () => {
  it('/d restart, /d upgrade, /d rewind x on kg are not commands there; "stop" is no command at all', async () => {
    const configPath = await tmpConfigPath();
    const exits = [];
    const cmds = createCommands({ getConfig: () => KG, send: async () => {}, exit: (code) => exits.push(code), configPath });
    for (const body of ['/d restart', '/d upgrade', '/d rewind abc123']) {
      const c = await typed(cmds, { body, surface: 'whatsapp', chatId: '!self', authorized: true });
      expect(c?.commandElsewhere, body).toBe('d');
    }
    expect(cmds.commandOf({ body: 'stop', surface: 'whatsapp', chatId: '!self', authorized: true })).toBe(null);
    expect(exits).toEqual([]);
  });
});

// ── sandbox_oauth_token (operator 2026-09-05). The key was NAMED so the EXISTING
//    CONFIG_REDACT_RE (/token|key|secret|password|^account$|allowed_users/i) catches it with no
//    change to the redactor — these two tests are what makes that a verified claim rather than
//    an assumption about a regex. ──
describe('/config — sandbox_oauth_token is redacted by the EXISTING key-name rule', () => {
  it('a bare /config dump never leaks the sandbox OAuth token', async () => {
    const configPath = await tmpConfigPath();
    const config = { node_name: 'kg', sandbox_oauth_token: 'SUPER-SECRET-OAUTH-TOKEN-VALUE' };
    const { cmds, sent } = harness({ config, configPath });
    await cmds.run({ body: '/config', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPER-SECRET-OAUTH-TOKEN-VALUE');
    expect(sent[0].text).toContain('sandbox_oauth_token');   // the KEY is still visible...
    expect(sent[0].text).toContain('<redacted>');            // ...only the value is gone
  });

  it('a GET of sandbox_oauth_token never leaks the real value either', async () => {
    const configPath = await tmpConfigPath();
    const config = { sandbox_oauth_token: 'SUPER-SECRET-OAUTH-TOKEN-VALUE' };
    const { cmds, sent } = harness({ config, configPath });
    await cmds.run({ body: '/config sandbox_oauth_token', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPER-SECRET-OAUTH-TOKEN-VALUE');
    expect(sent[0].text).toContain('<redacted>');
  });
});

// ── book.ics_url (2026-10-15): the calendar's secret iCal address is a credential, so the
//    redactor names it — /config never shows it, dumped or read. ──
describe('/config — book.ics_url is redacted', () => {
  const URL_ = 'https://calendar.google.com/calendar/ical/x/private-SUPERSECRETICS/basic.ics';
  it('a bare /config dump never leaks the secret iCal address', async () => {
    const { cmds, sent } = harness({ config: { node_name: 'kg', book: { ics_url: URL_, calendar_email: 'demos@x' } }, configPath: await tmpConfigPath() });
    await cmds.run({ body: '/config', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPERSECRETICS');
    expect(sent[0].text).toContain('demos@x');
  });

  it('/config book.ics_url (GET) shows <redacted>', async () => {
    const { cmds, sent } = harness({ config: { book: { ics_url: URL_ } }, configPath: await tmpConfigPath() });
    await cmds.run({ body: '/config book.ics_url', chatId: '!self', authorized: true });
    expect(sent[0].text).not.toContain('SUPERSECRETICS');
    expect(sent[0].text).toContain('<redacted>');
  });
});
