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
import { spliceYamlScalar, spliceYamlKey, spliceYamlRemoveKey, spliceYamlInsertKey, spliceYamlSeqAppend, YamlSpliceRefusal } from '../src/tools/config-io.mjs';

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

  // `comment`: a value that NAMES something is documented by its own trailing comment, so a
  // repoint that leaves the comment naming the old thing ships a comment that lies (migrations/
  // 0012). Still ONE line: the gap before the `#` is kept, and no other comment moves.
  it('rewrites the trailing comment on the SAME line, keeping the whitespace before the `#`', () => {
    const out = spliceYamlScalar(FIXTURE, ['transcription_service', 'enabled'], { expect: false, to: true, comment: 'on again 2026-09-17' });
    expect(diffLines(FIXTURE, out)).toEqual([
      [3, '  enabled: false   # off on kg by operator decision 2026-09-13 — NOT part of the shape',
        '  enabled: true   # on again 2026-09-17'],
    ]);
    expect(YAML.parse(out).transcription_service.enabled).toBe(true);
  });

  it('rewrites the comment alone when the value is already what it should be', () => {
    const out = spliceYamlScalar(FIXTURE, ['transcription_service', 'enabled'], { expect: false, to: false, comment: 'still off' });
    expect(diffLines(FIXTURE, out)).toEqual([
      [3, '  enabled: false   # off on kg by operator decision 2026-09-13 — NOT part of the shape',
        '  enabled: false   # still off'],
    ]);
  });

  it('refuses to INVENT a comment on a line that carries none, and refuses one that is not one line', () => {
    expect(() => spliceYamlScalar(FIXTURE, ['transcription_service', 'use_config'], { expect: 'reve', to: 'kg', comment: 'now kg' }))
      .toThrow(/use_config: its line carries no trailing comment to rewrite/);
    expect(() => spliceYamlScalar(FIXTURE, ['transcription_service', 'enabled'], { expect: false, to: true, comment: 'two\nlines' }))
      .toThrow(/enabled: a trailing comment is one line of text/);
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

// spliceYamlRemoveKey — the entry as it READS in the file goes: the comment lines directly above
// the key at its own column (what describes it), its line, every line of its value, and comment
// lines indented inside the block after its last value. The next key, ITS comment, blank lines and
// every other byte stay.
describe('spliceYamlRemoveKey', () => {
  const AGENTS = [
    'agents:',
    '  ken:',
    '    configuration: opus-xhigh # shared',
    '    conversation_defaults:',
    '      verbose_thinking: true # rescued from ken.yaml',
    '  # GAUSS - what it was for,',
    '  # in two lines',
    '  gauss:',
    '    configuration: opus-xhigh # SHARED with ken',
    '    handles: [ gauss ] # NOT primo',
    '    name: "Gauss"',
    '    conversation_defaults:',
    '      access_level: sandbox',
    '  codex:',
    '    configuration: codex',
    '',
  ].join('\n');
  const WITHOUT = [
    'agents:',
    '  ken:',
    '    configuration: opus-xhigh # shared',
    '    conversation_defaults:',
    '      verbose_thinking: true # rescued from ken.yaml',
    '  codex:',
    '    configuration: codex',
    '',
  ].join('\n');

  it('removes the key, its whole block and the comment above it; every other byte is kept', () => {
    const out = spliceYamlRemoveKey(AGENTS, ['agents'], { key: 'gauss' });
    expect(out).toBe(WITHOUT);
    expect(Object.keys(YAML.parse(out).agents)).toEqual(['ken', 'codex']);
  });

  it('keeps CRLF line endings', () => {
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    expect(spliceYamlRemoveKey(crlf(AGENTS), ['agents'], { key: 'gauss' })).toBe(crlf(WITHOUT));
  });

  it('TRAILING COMMENTS: an end-of-line comment on the last line and comment lines indented inside the block go; the next key\'s own comment stays', () => {
    const src = AGENTS.replace(
      '      access_level: sandbox\n  codex:',
      '      access_level: sandbox # the last line\n      # inside conversation_defaults\n    # inside gauss\n  # CODEX - describes codex\n  codex:',
    );
    expect(spliceYamlRemoveKey(src, ['agents'], { key: 'gauss' }))
      .toBe(WITHOUT.replace('  codex:', '  # CODEX - describes codex\n  codex:'));
  });

  it('the LAST key of the document: a trailing column-0 comment and a missing final newline are handled', () => {
    const src = '# head\na: 1\nb:\n  c: 2 # end of b\n# tail comment';
    expect(spliceYamlRemoveKey(src, [], { key: 'b' })).toBe('# head\na: 1\n# tail comment');
    expect(spliceYamlRemoveKey('a: 1\nb:\n  c: 2', [], { key: 'b' })).toBe('a: 1\n');
  });

  it('a blank line after the block, and a comment separated from the key by a blank line, are kept', () => {
    const src = 'a:\n  # about the section, not about x\n\n  x: 1\n\n  y: 2\n';
    expect(spliceYamlRemoveKey(src, ['a'], { key: 'x' })).toBe('a:\n  # about the section, not about x\n\n\n  y: 2\n');
  });

  it('a block scalar and a multi-line flow list inside the block are removed whole', () => {
    const src = 'a:\n  x:\n    note: |\n      one\n      two\n    list: [\n      p,\n      q ]\n  y: 2\n';
    expect(spliceYamlRemoveKey(src, ['a'], { key: 'x' })).toBe('a:\n  y: 2\n');
  });

  it('refuses by name when the key is absent, the path is not a mapping, or the map is a flow map', () => {
    expect(() => spliceYamlRemoveKey(AGENTS, ['agents'], { key: 'gaus' })).toThrow(/agents\.gaus: agents has no key "gaus"/);
    expect(() => spliceYamlRemoveKey(AGENTS, ['agents', 'gauss', 'handles'], { key: 'gauss' })).toThrow(/agents\.gauss\.handles is not a mapping/);
    expect(() => spliceYamlRemoveKey('a: { x: 1, y: 2 }\n', ['a'], { key: 'x' })).toThrow(/a is a flow mapping/);
  });

  it('refuses rather than leave a result that re-parses to anything but the document without that key', () => {
    // The only key: removing it leaves `agents:` - null, not an empty map.
    let err;
    try { spliceYamlRemoveKey('agents:\n  gauss:\n    name: Gauss\n', ['agents'], { key: 'gauss' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(YamlSpliceRefusal);
    expect(err.message).toMatch(/agents\.gauss: the edited text does not re-parse to the intended change alone/);
  });

  it('refuses YAML that does not parse', () => {
    expect(() => spliceYamlRemoveKey('a: [1, 2\n', [], { key: 'a' })).toThrow(/does not parse/);
  });
});

// spliceYamlInsertKey — the one splice that ADDS. The caller hands it the block's own TEXT, already
// indented for the map; this asserts the file comes back byte-identical except exactly those lines,
// in exactly the place asked for, and that a block that does not belong is refused rather than
// fixed up.
describe('spliceYamlInsertKey', () => {
  // kg's real `agents:` shape: the persona's block ends with a trailing end-of-line comment AND a
  // continuation comment line indented inside it, then a BLANK line, then the comment block that
  // describes the NEXT being. A new sibling goes after the continuation comment, before the blank.
  const KG = [
    '# config.yaml - kg (fixture)',
    'agents:',
    '  egpt:',
    '    configuration: sonnet-default # config/agents/sonnet-default.yaml',
    '    handles: [ e, egpt, ekg ]',
    '    default: true',
    '    conversation_defaults:',
    '      access_level: sandbox',
    '      verbose_thinking: true # this tier outranks the brain def,',
    '      # and stays on for every conversation on this node',
    '',
    '  # KING KEN - the operator\'s second being',
    '  ken:',
    '    configuration: opus-xhigh',
    '    handles: [ ken ]',
    '',
  ].join('\n');
  const BLOCK = [
    '  # E+ - E\'s own voice on a bigger model',
    '  eplus:',
    '    configuration: opus-high # config/agents/opus-high.yaml',
    '    handles: [ "+", "e+" ] # quoted: bare + and e+ are not plain YAML scalars',
    '    conversation_defaults:',
    '      allowed_users: [ "1234" ]',
  ].join('\n');

  it('inserts after a NAMED sibling: every other byte is identical, and the block lands after that sibling\'s trailing comment line, before the blank line and the next being\'s comment', () => {
    const out = spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: BLOCK, after: 'egpt' });
    expect(out).toBe(KG.replace('\n\n  # KING KEN', `\n${BLOCK}\n\n  # KING KEN`));
    expect(Object.keys(YAML.parse(out).agents)).toEqual(['egpt', 'eplus', 'ken']);
    expect(YAML.parse(out).agents.eplus.handles).toEqual(['+', 'e+']);
    expect(commentsOf(out)).toEqual([...commentsOf(KG).slice(0, 4), ...commentsOf(BLOCK), ...commentsOf(KG).slice(4)]);
  });

  it('`after` omitted means LAST', () => {
    const out = spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: BLOCK });
    expect(out).toBe(`${KG.replace(/\n$/, '')}\n${BLOCK}\n`);
    expect(Object.keys(YAML.parse(out).agents)).toEqual(['egpt', 'ken', 'eplus']);
  });

  it('LAST, when the map\'s last entry ends in a trailing comment: the end-of-line comment and the comment lines indented inside the block stay with it', () => {
    const src = `${KG.replace(/\n$/, '')}\n    mode: mention # never unaddressed\n    # …not even when the operator is talking to someone else\n`;
    expect(spliceYamlInsertKey(src, ['agents'], { key: 'eplus', text: BLOCK })).toBe(`${src}${BLOCK}\n`);
  });

  it('keeps CRLF line endings - the live kg config is CRLF - whatever the caller\'s text uses', () => {
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    const expected = crlf(KG.replace('\n\n  # KING KEN', `\n${BLOCK}\n\n  # KING KEN`));
    expect(spliceYamlInsertKey(crlf(KG), ['agents'], { key: 'eplus', text: BLOCK, after: 'egpt' })).toBe(expected);
    expect(spliceYamlInsertKey(crlf(KG), ['agents'], { key: 'eplus', text: crlf(BLOCK), after: 'egpt' })).toBe(expected);
  });

  it('inserts at the document ROOT, and after a last entry with no trailing newline', () => {
    expect(spliceYamlInsertKey('a: 1 # one\nb: 2\n', [], { key: 'c', text: 'c: 3 # three', after: 'a' }))
      .toBe('a: 1 # one\nc: 3 # three\nb: 2\n');
    expect(spliceYamlInsertKey('a: 1\nb:\n  c: 2', [], { key: 'd', text: 'd: 4' })).toBe('a: 1\nb:\n  c: 2\nd: 4\n');
  });

  it('REFUSES by name when the key is already there - never two blocks of one name', () => {
    let err;
    try { spliceYamlInsertKey(KG, ['agents'], { key: 'ken', text: '  ken:\n    configuration: opus-high' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(YamlSpliceRefusal);
    expect(err.message).toMatch(/agents\.ken: agents already has a key "ken"/);
  });

  it('refuses when the map is missing, is not a mapping, or is a flow mapping', () => {
    expect(() => spliceYamlInsertKey(KG, ['siblings'], { key: 'eplus', text: '  eplus: 1' }))
      .toThrow(/siblings\.eplus: siblings is not a mapping/);
    expect(() => spliceYamlInsertKey(KG, ['agents', 'ken', 'handles'], { key: 'eplus', text: '  eplus: 1' }))
      .toThrow(/handles is not a mapping/);
    expect(() => spliceYamlInsertKey('a: { x: 1 }\n', ['a'], { key: 'y', text: 'y: 2' }))
      .toThrow(/a\.y: a is a flow mapping/);
  });

  it('refuses when the sibling to insert after does not exist', () => {
    expect(() => spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: BLOCK, after: 'gauss' }))
      .toThrow(/agents\.eplus: agents has no key "gauss" to insert after/);
  });

  it('refuses text that is not exactly the one key: two keys, a different key, or unparseable', () => {
    expect(() => spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: '  eplus: 1\n  eminus: 2' }))
      .toThrow(/agents\.eplus: the text must be exactly the one key "eplus"/);
    expect(() => spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: '  eminus: 2' }))
      .toThrow(/the text must be exactly the one key "eplus"/);
    expect(() => spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: '  eplus: [ 1, 2' }))
      .toThrow(/agents\.eplus: the text does not parse/);
  });

  it('refuses text indented for a DIFFERENT map - the way an insertion nests a being inside its neighbour', () => {
    expect(() => spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: 'eplus:\n  configuration: opus-high' }))
      .toThrow(/agents\.eplus: the text must be indented 2 spaces for agents, not 0/);
    expect(() => spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: '    eplus:\n      configuration: opus-high' }))
      .toThrow(/the text must be indented 2 spaces for agents, not 4/);
    // The key is at the right column but a COMMENT line above it is not.
    expect(() => spliceYamlInsertKey(KG, ['agents'], { key: 'eplus', text: '# E+\n  eplus: 1' }))
      .toThrow(/the text must be indented 2 spaces for agents/);
  });

  it('refuses rather than write a result that re-parses to anything but the document plus that key', () => {
    // A duplicate key ONE LEVEL DOWN: the text is one key, indented right, and still lands a
    // document the caller did not ask for.
    expect(() => spliceYamlInsertKey('a:\n  x: 1\n', ['a'], { key: 'y', text: '  y:\n    q: 1\n    q: 2' }))
      .toThrow(YamlSpliceRefusal);
  });

  it('refuses YAML that does not parse', () => {
    expect(() => spliceYamlInsertKey('a: [1, 2\n', [], { key: 'b', text: 'b: 1' })).toThrow(/does not parse/);
  });
});

describe('spliceYamlSeqAppend', () => {
  // do's persona, the shape 0020 appends to: an inline list with a trailing comment on its line.
  const HANDLES = 'agents:\n  egpt:\n    handles: [ d, don ]   # the worker answers to both\n    default: true\n';

  it('adds one item to an inline flow list: a ONE-LINE diff, brackets, spacing and trailing comment kept', () => {
    const out = spliceYamlSeqAppend(HANDLES, ['agents', 'egpt', 'handles'], { expect: ['d', 'don'], add: 'rodz' });
    expect(diffLines(HANDLES, out)).toEqual([
      [3, '    handles: [ d, don ]   # the worker answers to both',
        '    handles: [ d, don, rodz ]   # the worker answers to both'],
    ]);
    expect(YAML.parse(out).agents.egpt.handles).toEqual(['d', 'don', 'rodz']);
  });

  it('keeps CRLF line endings - the live kg config is CRLF', () => {
    const crlf = HANDLES.replace(/\n/g, '\r\n');
    const out = spliceYamlSeqAppend(crlf, ['agents', 'egpt', 'handles'], { expect: ['d', 'don'], add: 'rodz' });
    expect(out).toBe(crlf.replace('[ d, don ]', '[ d, don, rodz ]'));
  });

  it('renders the new item in the style of the item before it', () => {
    const quoted = 'handles: [ "d", "don" ]\n';
    expect(spliceYamlSeqAppend(quoted, ['handles'], { expect: ['d', 'don'], add: 'rodz' })).toBe('handles: [ "d", "don", "rodz" ]\n');
    const one = 'handles: [ don ]\n';
    expect(spliceYamlSeqAppend(one, ['handles'], { expect: ['don'], add: 'rodz' })).toBe('handles: [ don, rodz ]\n');
  });

  it('a list spread over more than one line grows at its last item, not at its bracket', () => {
    const wrapped = 'handles: [ alpha,\n  bravo ]\n';
    expect(spliceYamlSeqAppend(wrapped, ['handles'], { expect: ['alpha', 'bravo'], add: 'rodz' })).toBe('handles: [ alpha,\n  bravo, rodz ]\n');
  });

  it('REFUSES by name when the list is not what the caller expects - never appended to twice', () => {
    expect(() => spliceYamlSeqAppend(HANDLES, ['agents', 'egpt', 'handles'], { expect: ['d'], add: 'rodz' }))
      .toThrow(/refusing to edit agents\.egpt\.handles: expected \["d"\], found \["d","don"\]/);
    const already = HANDLES.replace('[ d, don ]', '[ d, don, rodz ]');
    expect(() => spliceYamlSeqAppend(already, ['agents', 'egpt', 'handles'], { expect: ['d', 'don'], add: 'rodz' }))
      .toThrow(YamlSpliceRefusal);
  });

  it('refuses a BLOCK list, an absent path, and a path that is not a sequence', () => {
    const block = 'handles:\n  - d\n  - don\n';
    expect(() => spliceYamlSeqAppend(block, ['handles'], { expect: ['d', 'don'], add: 'rodz' }))
      .toThrow(/it is a block list; only an inline flow list is appended to/);
    expect(() => spliceYamlSeqAppend(HANDLES, ['agents', 'ken', 'handles'], { expect: [], add: 'x' }))
      .toThrow(/refusing to edit agents\.ken\.handles: there is no such node/);
    expect(() => spliceYamlSeqAppend(HANDLES, ['agents', 'egpt'], { expect: {}, add: 'x' }))
      .toThrow(/refusing to edit agents\.egpt: it is a YAMLMap, not a sequence/);
  });

  it('refuses an empty list and a list whose last item is not a scalar', () => {
    expect(() => spliceYamlSeqAppend('handles: []\n', ['handles'], { expect: [], add: 'rodz' }))
      .toThrow(/it is empty, so there is no item to append after/);
    expect(() => spliceYamlSeqAppend('handles: [ { a: 1 } ]\n', ['handles'], { expect: [{ a: 1 }], add: 'rodz' }))
      .toThrow(/its last item is a YAMLMap, not a scalar/);
  });

  it('refuses a plain item that would re-parse as something else, rather than silently quoting it', () => {
    expect(() => spliceYamlSeqAppend('handles: [ d, don ]\n', ['handles'], { expect: ['d', 'don'], add: 'a, b' }))
      .toThrow(/does not re-parse to the intended change alone/);
  });

  it('refuses YAML that does not parse', () => {
    expect(() => spliceYamlSeqAppend('a: [1, 2\n', ['a'], { expect: [1, 2], add: 3 })).toThrow(/does not parse/);
  });
});
