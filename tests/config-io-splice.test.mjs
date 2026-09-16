// tests/config-io-splice.test.mjs — spliceYamlScalar / spliceYamlKey (src/tools/config-io.mjs),
// the ONE primitive every config migration edits through.
//
// The hazard, measured 2026-09-16 on the live kg config with yaml 2.9.0: even a NO-OP
// parseDocument(src).toString() rewrites the file, moving end-of-line comments onto their own
// line and exploding long flow lists. The fixture below carries exactly those shapes, and the
// first test proves toString() still damages it - otherwise the rest would prove nothing.
// Every assertion is on the FULL text, never a re-parse: the data surviving is not the point,
// the bytes are.
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import { spliceYamlScalar, spliceYamlKey, YamlSpliceRefusal } from '../src/tools/config-io.mjs';

const FIXTURE = `# config.yaml — kg (fixture), the operator's rulings live in comments like these
transcription_service:
  enabled: false   # off on kg by operator decision 2026-09-13 — NOT part of the shape
  use_config: reve
  echo:
    peer_priority: [ do, kg ]
    handles: [ alpha-one, bravo-two, charlie-three, delta-four, echo-five, foxtrot-six, golf-seven, hotel-eight ]
  reve:
    fallback_order: [ remote, cli ] # dolly's worker first, local whisper-cli second
    remote:
      type: whisper-server-remote   # the pipeline dispatches on type, not on the key
      endpoint: http://192.168.1.102:23390
    cli:
      type: whisper-cli
      command: C:\\Users\\an\\bin\\whisper.cpp\\Release\\whisper-cli.exe
      language: auto # NOT absent: whisper.cpp defaults to 'en', and a pinned language mis-hears the other one fluently
      quoted: "a quoted value"   # stays quoted
`;

const PROFILE = ['transcription_service', 'reve'];

// Every line that differs, as [lineNo, before, after]. A splice never changes the line count.
function diffLines(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  expect(lb.length).toBe(la.length);
  return la.flatMap((l, i) => (l === lb[i] ? [] : [[i + 1, l, lb[i]]]));
}
const commentsOf = (src) => src.split('\n').map((l) => (l.includes('#') ? l.slice(l.indexOf('#')) : null)).filter(Boolean);

describe('the fixture actually exercises what toString() destroys', () => {
  it('a no-op parseDocument().toString() does NOT round-trip it (else these tests prove nothing)', () => {
    expect(YAML.parseDocument(FIXTURE).toString()).not.toBe(FIXTURE);
  });
});

describe('spliceYamlScalar', () => {
  it('a no-op (expect === to) returns the text byte-identical', () => {
    const out = spliceYamlScalar(FIXTURE, [...PROFILE, 'cli', 'language'], { expect: 'auto', to: 'auto' });
    expect(out).toBe(FIXTURE);
  });

  it('a scalar edit is a ONE-LINE diff and every comment survives verbatim', () => {
    const from = 'C:\\Users\\an\\bin\\whisper.cpp\\Release\\whisper-cli.exe';
    const to = 'D:\\tools\\whisper.cpp\\whisper-cli.exe';
    const out = spliceYamlScalar(FIXTURE, [...PROFILE, 'cli', 'command'], { expect: from, to });
    expect(diffLines(FIXTURE, out)).toEqual([
      [15, `      command: ${from}`, `      command: ${to}`],
    ]);
    expect(commentsOf(out)).toEqual(commentsOf(FIXTURE));
    expect(YAML.parse(out).transcription_service.reve.cli.command).toBe(to);
  });

  it('edits one element of a FLOW list in place, keeping the list and its trailing comment on one line', () => {
    const out = spliceYamlScalar(FIXTURE, [...PROFILE, 'fallback_order', 0], { expect: 'remote', to: 'worker' });
    expect(diffLines(FIXTURE, out)).toEqual([
      [9, "    fallback_order: [ remote, cli ] # dolly's worker first, local whisper-cli second",
        "    fallback_order: [ worker, cli ] # dolly's worker first, local whisper-cli second"],
    ]);
  });

  it('edits one element of a BLOCK list (the shape do carries) in place', () => {
    const block = 'profile:\n  fallback_order:\n    - remote   # first\n    - cli\n';
    const out = spliceYamlScalar(block, ['profile', 'fallback_order', 0], { expect: 'remote', to: 'worker' });
    expect(out).toBe('profile:\n  fallback_order:\n    - worker   # first\n    - cli\n');
  });

  it('keeps CRLF line endings - the live kg config is CRLF', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const out = spliceYamlScalar(crlf, [...PROFILE, 'fallback_order', 0], { expect: 'remote', to: 'worker' });
    expect(out).toBe(crlf.replace('[ remote, cli ]', '[ worker, cli ]'));
  });

  it('keeps a quoted scalar quoted', () => {
    const out = spliceYamlScalar(FIXTURE, [...PROFILE, 'cli', 'quoted'], { expect: 'a quoted value', to: 'it\'s "new"' });
    expect(diffLines(FIXTURE, out)).toEqual([
      [17, '      quoted: "a quoted value"   # stays quoted', '      quoted: "it\'s \\"new\\""   # stays quoted'],
    ]);
  });

  it('REFUSES by name when the current value is not what the caller expects, and returns nothing', () => {
    let err;
    try { spliceYamlScalar(FIXTURE, [...PROFILE, 'remote', 'endpoint'], { expect: 'http://127.0.0.1:23390', to: 'http://10.0.0.1:23390' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(YamlSpliceRefusal);
    expect(err.message).toContain('transcription_service.reve.remote.endpoint');
    expect(err.message).toContain('expected "http://127.0.0.1:23390"');
    expect(err.message).toContain('found "http://192.168.1.102:23390"');
  });

  it('refuses a path that does not exist, and a path that is not a scalar', () => {
    expect(() => spliceYamlScalar(FIXTURE, [...PROFILE, 'nope'], { expect: 'x', to: 'y' }))
      .toThrow(/transcription_service\.reve\.nope: there is no such node/);
    expect(() => spliceYamlScalar(FIXTURE, [...PROFILE, 'cli'], { expect: 'x', to: 'y' }))
      .toThrow(/transcription_service\.reve\.cli: it is a YAMLMap, not a scalar/);
  });

  it('refuses a plain value that would re-parse as something else, rather than silently quoting it', () => {
    expect(() => spliceYamlScalar(FIXTURE, ['transcription_service', 'use_config'], { expect: 'reve', to: 'true' }))
      .toThrow(/use_config: the edited text does not re-parse to the intended change alone/);
    expect(() => spliceYamlScalar(FIXTURE, ['transcription_service', 'use_config'], { expect: 'reve', to: 'a # b' }))
      .toThrow(YamlSpliceRefusal);
  });

  it('refuses YAML that does not parse', () => {
    expect(() => spliceYamlScalar('a: [1, 2\n', ['a', 0], { expect: 1, to: 3 })).toThrow(/does not parse/);
  });
});

describe('spliceYamlKey', () => {
  it('renames a mapping KEY as a one-line diff; the block under it and every comment are untouched', () => {
    const out = spliceYamlKey(FIXTURE, PROFILE, { from: 'remote', to: 'worker' });
    expect(diffLines(FIXTURE, out)).toEqual([[10, '    remote:', '    worker:']]);
    expect(commentsOf(out)).toEqual(commentsOf(FIXTURE));
    const data = YAML.parse(out).transcription_service.reve;
    expect(Object.keys(data)).toEqual(['fallback_order', 'worker', 'cli']);
    expect(data.worker.type).toBe('whisper-server-remote');
  });

  it('renames a key at the document root', () => {
    const out = spliceYamlKey('a: 1 # one\nb: 2\n', [], { from: 'a', to: 'z' });
    expect(out).toBe('z: 1 # one\nb: 2\n');
  });

  it('refuses by name when the key is absent', () => {
    expect(() => spliceYamlKey(FIXTURE, PROFILE, { from: 'gpu', to: 'worker' }))
      .toThrow(/transcription_service\.reve has no key "gpu"/);
  });

  it('refuses by name when the new key already exists - never two blocks of one name', () => {
    expect(() => spliceYamlKey(FIXTURE, PROFILE, { from: 'remote', to: 'cli' }))
      .toThrow(/transcription_service\.reve already has a key "cli"/);
  });

  it('refuses when the path is not a mapping', () => {
    expect(() => spliceYamlKey(FIXTURE, [...PROFILE, 'fallback_order'], { from: 'remote', to: 'worker' }))
      .toThrow(/fallback_order is not a mapping/);
  });
});
