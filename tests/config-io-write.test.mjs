// tests/config-io-write.test.mjs — writeConfigKey (src/tools/config-io.mjs) must edit the
// operator's config.yaml SURGICALLY: the file comes back byte-identical except for the line(s)
// that genuinely had to change. REPRODUCE-FIRST for the live regression (2026-07-28): the old
// parseDocument -> setIn -> toString() round-trip re-serialized the WHOLE file on every write,
// which moved trailing comments off their key line, destroyed column alignment, re-indented a
// multi-line comment block under a key, and line-wrapped long scalars — on a single
// `/config set default_node do` against the operator's real config. Assertions here are on the
// FULL file text, never a re-parse, because a parse-based assertion is exactly what missed the
// original bug (the data round-tripped fine; only the surrounding bytes were destroyed).
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { writeConfigKey } from '../src/tools/config-io.mjs';

// A faithful miniature of the operator's real ~/.egpt/config/config.yaml: an aligned trailing
// comment, a multi-line comment block continuing under a key (indented, no leading key text),
// a nested block, and a long unquoted scalar value.
const FIXTURE = `# config.yaml — kg (fixture)
node_name: kg   # inline note on node_name, name: José 🌉

dispatch:
  auto_default_mode: accum          # wake E: on | auto | mute | mention-direct | mention | accum
                                     # accum = the mention gate, and the turn is prompted with
                                     # what E missed since its own last turn
  send_to_egpt: mode # E runs a turn: mode (only when it'd surface) | always
  default_node: do

warm:
  idle_ttl_ms: 1800000
  max: 10

transcription_service:
  reve:
    remote:
      token: MU-3ymqcZ03PjDhXG7exOPzwHUfHtVocdWDI5yieuvA
`;

async function tmpConfigPath(initial) {
  const dir = await mkdtemp(join(tmpdir(), 'egpt-config-io-'));
  const fp = join(dir, 'config.yaml');
  await writeFile(fp, initial, 'utf8');
  return fp;
}

describe('writeConfigKey — surgical single-key edit, no whole-file reflow', () => {
  it('REPRODUCE-FIRST: setting an EXISTING key changes only that value; every other byte is identical', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'dispatch.default_node', 'newnode');
    const after = await readFile(fp, 'utf8');
    const expected = FIXTURE.replace('default_node: do', 'default_node: newnode');
    expect(after).toBe(expected);
    // The alignment + multi-line comment block on the UNTOUCHED neighbor key must survive
    // exactly, proving the whole block wasn't reflowed to fix up one line.
    expect(after).toContain('  auto_default_mode: accum          # wake E: on | auto | mute | mention-direct | mention | accum\n');
    expect(after).toContain('                                     # accum = the mention gate, and the turn is prompted with\n');
    expect(after).toContain('                                     # what E missed since its own last turn\n');
  });

  it('setting a NESTED existing key (transcription_service.reve.remote.token analog) touches only its own line', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'warm.idle_ttl_ms', 60000);
    const after = await readFile(fp, 'utf8');
    expect(after).toBe(FIXTURE.replace('idle_ttl_ms: 1800000', 'idle_ttl_ms: 60000'));
  });

  it('setting a NEW key adds exactly one line inside the right block, everything else byte-identical', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'dispatch.brand_new_flag', true);
    const after = await readFile(fp, 'utf8');
    const expected = FIXTURE.replace(
      '  default_node: do\n\nwarm:',
      '  default_node: do\n  brand_new_flag: true\n\nwarm:',
    );
    expect(after).toBe(expected);
  });

  it('setting a key whose parent block does not exist at all creates the minimal nested block', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'newblock.newfield', 'val');
    const after = await readFile(fp, 'utf8');
    expect(after).toBe(FIXTURE + 'newblock:\n  newfield: val\n');
  });

  it('round-trip: the written file still parses to the expected object after an existing-key edit and a new-key insert', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'dispatch.default_node', 'do2');
    await writeConfigKey(fp, 'dispatch.brand_new_flag', 42);
    const parsed = YAML.parse(await readFile(fp, 'utf8'));
    expect(parsed.dispatch.default_node).toBe('do2');
    expect(parsed.dispatch.brand_new_flag).toBe(42);
    expect(parsed.dispatch.auto_default_mode).toBe('accum');   // untouched sibling
    expect(parsed.node_name).toBe('kg');                        // untouched top-level key
  });

  it('a value that would be misread as a bool/number/null gets quoted; a plain-safe one does not', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'dispatch.send_to_egpt', 'true');   // the STRING "true", not the boolean
    let after = await readFile(fp, 'utf8');
    expect(after).toMatch(/send_to_egpt: "true"/);
    expect(YAML.parse(after).dispatch.send_to_egpt).toBe('true');   // still a string on re-parse

    await writeConfigKey(fp, 'dispatch.default_node', 'plainword');
    after = await readFile(fp, 'utf8');
    expect(after).toMatch(/default_node: plainword\n/);   // bare, no quotes added
  });

  it('non-ASCII content (accented name, emoji) in untouched lines survives byte-for-byte', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'dispatch.default_node', 'do');
    const after = await readFile(fp, 'utf8');
    expect(after).toContain('José 🌉');
    expect(Buffer.from(after, 'utf8').equals(Buffer.from(FIXTURE.replace('default_node: do', 'default_node: do'), 'utf8'))).toBe(true);
  });

  it('a non-ASCII VALUE being set is itself written byte-for-byte, no mangling', async () => {
    const fp = await tmpConfigPath(FIXTURE);
    await writeConfigKey(fp, 'user_name', 'José 🚀');
    const after = await readFile(fp, 'utf8');
    expect(after).toContain('user_name: José 🚀');
    expect(YAML.parse(after).user_name).toBe('José 🚀');
  });
});
