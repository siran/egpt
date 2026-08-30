// node-signature.test.mjs — THE STRUCTURAL, INVISIBLE, MANDATORY node id (operator 2026-07-26:
// "invisible characters are the way to go … there's a structural invisible and a visible pre and
// post signature. spine doesn't boot without the invisible ones. the visible one are prescindable
// … oh, yes, the transcript must decode the signature into a <node>").
//
// THREE layers on every frame a spine commits to a surface:
//   1. structural, invisible, MANDATORY — the Unicode TAG encoding of node_name (this file)
//   2. visible bridge_signature_open/close — OPTIONAL, humans only (signature-layers.test.mjs)
//   3. the persona stamp — unchanged (persona-wrap.test.mjs)
import { describe, it, expect } from 'vitest';
import {
  encodeNodeSignature, decodeNodeSignature, stripNodeSignature, renderNodeSignature,
} from '../src/node-signature.mjs';
import { makeWrapPersona } from '../src/bridges/persona-wrap.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { isLiveStreamFrame, LIVE_FRAME_MARK } from '../src/dispatch-line.mjs';
import { transcriptAppend } from '../src/transcript-log.mjs';
import { htmlToMarkdown } from '../src/html-to-markdown.mjs';
import { normEchoText } from '../src/bridges/beeper.mjs';
import { stripFrontMatter } from '../src/transcript-meta.mjs';
import { mentionHits } from '../src/auto-mode.mjs';

// The literal frame for node "kg": TAG LANGUAGE, tag-encoded 'k','g', CANCEL TAG.
const KG = '\u{E0001}\u{E006B}\u{E0067}\u{E007F}';
// Any tag-block codepoint at all — the assertion "no raw invisible bytes reached here".
const RAW_TAG = /[\u{E0000}-\u{E007F}]/u;

describe('node-signature — the encoding', () => {
  it('encodes a node name as U+E0001 + tag-encoded ASCII + U+E007F CANCEL TAG', () => {
    expect(encodeNodeSignature('kg')).toBe(KG);
    expect(encodeNodeSignature('do')).toBe('\u{E0001}\u{E0064}\u{E006F}\u{E007F}');
  });

  it('decodes back to the node name — the transcript can name the node (operator 2026-07-26)', () => {
    expect(decodeNodeSignature(encodeNodeSignature('kg'))).toBe('kg');
    expect(decodeNodeSignature(`hola ${encodeNodeSignature('reve-2')}`)).toBe('reve-2');
  });

  it('is invisible: the frame contributes no visible characters', () => {
    expect(`a${KG}b`.replace(/[\u{E0000}-\u{E007F}]/gu, '')).toBe('ab');
  });

  it('absence is ORDINARY, never an error — every message in the wild has no marker', () => {
    expect(decodeNodeSignature('plain text')).toBe(null);
    expect(decodeNodeSignature('')).toBe(null);
    expect(decodeNodeSignature(null)).toBe(null);
    expect(stripNodeSignature('plain text')).toBe('plain text');
    expect(renderNodeSignature('plain text')).toBe('plain text');
  });

  it('strips TOTALLY — a regex over the whole frame, nothing left behind', () => {
    expect(stripNodeSignature(`hola${KG}`)).toBe('hola');
    expect(stripNodeSignature(`${KG}a${KG}b${KG}`)).toBe('ab');
    expect(RAW_TAG.test(stripNodeSignature(`hola${KG}`))).toBe(false);
  });

  it('renders the frame as <node> — legible, not raw bytes', () => {
    expect(renderNodeSignature(`hola${KG}`)).toBe('hola<kg>');
  });

  it('no node name → no signature (the codec is tolerant; BOOT is the enforcer)', () => {
    expect(encodeNodeSignature('')).toBe('');
    expect(encodeNodeSignature(null)).toBe('');
  });
});

describe('makeWrapPersona — the structural layer rides EVERY frame', () => {
  const wrapKg = (cfg = {}) => makeWrapPersona({ nodeName: 'kg', ...cfg });

  it('a frame carries a DECODABLE invisible node id', () => {
    const out = wrapKg()({ bodyEmoji: '🐶', label: 'egpt' }, 'Hola');
    expect(decodeNodeSignature(out)).toBe('kg');
    expect(stripNodeSignature(out)).toBe('🐶 egpt: Hola');   // visible bytes unchanged
  });

  it('the VISIBLE layers stay optional — empty open/close still signs structurally', () => {
    const bare = wrapKg()({}, 'Hey');
    expect(decodeNodeSignature(bare)).toBe('kg');
    expect(stripNodeSignature(bare)).toBe('Hey');
    const dressed = wrapKg({ bridgeSignatureOpen: '🌉kg', bridgeSignatureClose: '💸' })({ bodyEmoji: '🐶', label: 'egpt' }, 'Hola');
    expect(decodeNodeSignature(dressed)).toBe('kg');
    expect(stripNodeSignature(dressed)).toBe('🌉kg 🐶 egpt: Hola 💸');
  });

  it('EMPTY BODY returns untouched — never a bare signature (cd96edc)', () => {
    expect(wrapKg()({ bodyEmoji: '🐶', label: 'egpt' }, '')).toBe('');
    expect(wrapKg()({}, '   ')).toBe('   ');
  });

  it('a mesh ENVELOPE is never signed — parseMesh must still read it', () => {
    const env = encodeMesh({ by: 'don.do', body: '🤝 la respuesta', re: 'HFM.kg', post_id: 'p1', done: true });
    const out = wrapKg({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' })({}, env);
    expect(out).toBe(env);
    expect(RAW_TAG.test(out)).toBe(false);
    expect(parseMesh(out)).not.toBe(null);
  });

  it('NO ACCUMULATION: placeholder → N updates → finish yields exactly ONE marker at every step', () => {
    const wrap = wrapKg({ bridgeSignatureOpen: '🌉', bridgeSignatureClose: '💸' });
    const tag = { bodyEmoji: '🐶', label: 'egpt' };
    const frames = [
      wrap(tag, '⏳ Thinking…'),
      wrap(tag, 'Ho ⏳'), wrap(tag, 'Hola m ⏳'), wrap(tag, 'Hola mundo ⏳'),
      wrap(tag, 'Hola mundo'),
    ];
    for (const f of frames) expect(f.match(/\u{E0001}/gu)?.length).toBe(1);
  });

  it('re-wrapping an ALREADY-signed body still yields exactly one marker (a relayed nugget)', () => {
    const wrap = wrapKg();
    const once = wrap({}, 'la respuesta');
    const twice = wrap({}, once);
    expect(twice.match(/\u{E0001}/gu)?.length).toBe(1);
    expect(decodeNodeSignature(twice)).toBe('kg');
  });

  it('no node name configured → byte-identical to today (the port default is tolerant)', () => {
    expect(makeWrapPersona({})({ bodyEmoji: '🐶', label: 'egpt' }, 'Hola')).toBe('🐶 egpt: Hola');
  });

  it('the LIVE-FRAME guard still fires on a frame carrying BOTH the marker and ⏳', () => {
    const frame = wrapKg({ bridgeSignatureClose: '💸' })({ bodyEmoji: '🐶', label: 'egpt' }, `Hola mundo ${LIVE_FRAME_MARK}`);
    const editBody = `edited #42\n    - old\n    + ${frame.replace(/\n/g, ' ')}`;
    expect(isLiveStreamFrame(editBody)).toBe(true);
  });
});

// Beeper preserved all 19 candidates byte-for-byte on the wire (operator probe, 2026-07-26).
// THIS locks the other half: our OWN inbound pipeline.
describe('the marker survives OUR OWN inbound pipeline', () => {
  it('htmlToMarkdown keeps it (Beeper delivers HTML; .trim() does not eat a TAG char)', () => {
    expect(htmlToMarkdown(`<p>hola${KG}</p>`)).toBe(`hola${KG}`);
    expect(decodeNodeSignature(htmlToMarkdown(`<p>🐶 egpt<br>Hola mundo${KG}</p>`))).toBe('kg');
  });

  it('stripFrontMatter keeps it', () => {
    expect(stripFrontMatter(`---\nname: fam\n---\n\nhola${KG}`)).toBe(`hola${KG}`);
  });

  it('mentionHits is unaffected — a marker is not a word char, so @e still hits', () => {
    expect(mentionHits(`@e hola${KG}`, ['e'])).toEqual([{ token: 'e', atStart: true }]);
    expect(mentionHits(`hola @e${KG}`, ['e'])).toEqual([{ token: 'e', atStart: false }]);
  });

  it('normEchoText DROPS it — the sent form and the stored form must compare equal', () => {
    expect(normEchoText(`hola${KG}`)).toBe('hola');
    expect(normEchoText(`hola${KG}`)).toBe(normEchoText('hola'));
  });
});

describe('the transcript decodes the signature into a <node>', () => {
  const FROM = {
    chatId: '!room:beeper.com', chatName: 'fam', network: 'whatsapp',
    userId: 'u-1', senderName: 'An', msgKey: 'm7',
  };
  const identity = createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5) });

  it('renders <node>, never raw invisible bytes, on the line AND on the body', () => {
    const ev = identity.build({ body: `Hola mundo${KG}`, from: FROM });
    expect(ev.line).toBe('An@[fam].wa (14:05) #m7: Hola mundo<kg>');
    expect(ev.body).toBe('Hola mundo<kg>');
    expect(RAW_TAG.test(ev.line)).toBe(false);
    expect(RAW_TAG.test(ev.body)).toBe(false);
  });

  it('an unsigned message is untouched (inbound tolerance)', () => {
    expect(identity.build({ body: 'Hola mundo', from: FROM }).line)
      .toBe('An@[fam].wa (14:05) #m7: Hola mundo');
  });

  it('the bytes appended to transcript.md carry <node>, not the marker', () => {
    const ev = identity.build({ body: `Hola mundo${KG}`, from: FROM });
    const bytes = transcriptAppend({ existing: true, body: ev.line });
    expect(bytes).toContain('<kg>');
    expect(RAW_TAG.test(bytes)).toBe(false);
  });
});

// A prompt is not a place for invisible characters: we must not smuggle to ourselves.
describe('the marker never reaches the brain', () => {
  const FROM = { chatId: '!r:beeper.com', chatName: 'fam', network: 'whatsapp', userId: 'u', senderName: 'An' };
  const identity = createIdentity({ now: () => Date.UTC(2026, 5, 29, 14, 5) });

  it('brainpool prompts with `ev.line ?? ev.body` — BOTH are clean', () => {
    const ev = identity.build({ body: `dime algo${KG}`, from: FROM });
    expect(RAW_TAG.test(ev.line ?? ev.body)).toBe(false);
    expect(RAW_TAG.test(ev.body)).toBe(false);
  });

  it('a burst/cycle prompt (joined ev.lines) is clean', () => {
    const a = identity.build({ body: `uno${KG}`, from: FROM });
    const b = identity.build({ body: `dos${KG}`, from: FROM });
    expect(RAW_TAG.test([a.line, b.line].join('\n\n'))).toBe(false);
  });

  it('the transcript TAIL a command feeds back is clean, because the file itself is', () => {
    const ev = identity.build({ body: `tres${KG}`, from: FROM });
    const file = transcriptAppend({ existing: false, body: ev.line, name: 'fam', surface: 'whatsapp', slug: 'fam' });
    expect(RAW_TAG.test(stripFrontMatter(file))).toBe(false);
  });
});
