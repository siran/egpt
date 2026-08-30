// Per-chat auto-mode semantics: standalone @e detection (no email false
// positives) and the reply gate for each mode.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AUTO_MODES, mentionHits, mentionHitsAnywhere, mentionStatus, replyAllowed, receives, isAutoMode, DEFAULT_AUTO_MODE, mayEmit, mayEmitChat, isSilenceReply, fanOutDecision } from '../src/auto-mode.mjs';

describe('mentionStatus', () => {
  it('detects @e as a standalone token, anywhere and at start', () => {
    expect(mentionStatus('@e hello')).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('To @e my assistant')).toEqual({ atEAnywhere: true, atEStart: false });
    expect(mentionStatus('@egpt do this')).toEqual({ atEAnywhere: true, atEStart: true });
  });
  it('does NOT match @e glued inside a word/email', () => {
    expect(mentionStatus('me@e.com')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('write to me@e.com please')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('hey@egpt')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('email')).toEqual({ atEAnywhere: false, atEStart: false });
  });
  it('handles leading whitespace for atEStart', () => {
    expect(mentionStatus('   @e hi').atEStart).toBe(true);
  });

  // WAKE-WORD SET honors configured handles (operator 2026-07-07, DOLLY sleep-test bug):
  // the gate was hardcoded to e/egpt, so a node configured with handles [ed, egptd] never
  // woke on @ed. mentionStatus now takes the wake set the bridge derives from the config.
  it('honors a configured wake-word set (@ed) while keeping the network-wide @e', () => {
    const wake = ['e', 'egpt', 'ed', 'egptd'];   // DOLLY-shaped: network defaults + persona handles
    // BEFORE (default set) the DOLLY handle failed the gate — this is the reproduce:
    expect(mentionStatus('@ed estás?')).toEqual({ atEAnywhere: false, atEStart: false });
    // AFTER (honoring the set) @ed wakes the node, at start and anywhere…
    expect(mentionStatus('@ed estás?', wake)).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('oye @egptd ayuda', wake)).toEqual({ atEAnywhere: true, atEStart: false });
    // …and the network-wide @e / @egpt still wake it (regression).
    expect(mentionStatus('@e estás?', wake).atEStart).toBe(true);
    expect(mentionStatus('@egpt hola', wake).atEAnywhere).toBe(true);
    // @egpt must match 'egpt', not the shorter 'e' then stop (no false glue).
    expect(mentionStatus('hey@ed', wake)).toEqual({ atEAnywhere: false, atEStart: false });
  });
  it('an empty/absent wake set falls back to the network default e/egpt', () => {
    expect(mentionStatus('@e hi', [])).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('@ed hi', [])).toEqual({ atEAnywhere: false, atEStart: false });   // no handles → @ed does not wake
  });

  // ONE MATCHER (operator 2026-07-25): mentionStatus and the AGENT matcher (spine/router.mjs
  // `addressed`) are now the same scan (mentionHits) over different token sets, so the boundary
  // rule is one rule. A HYPHEN is part of a token, never a break: `@egpt-bot` is its own unknown
  // token, not @egpt — which is what the router's `@([a-z0-9_-]+)` capture always meant (it
  // resolved `don-local` whole) and what tests/room.test.mjs already locks for the room router.
  // Agent names carry hyphens (`don-local`), so a plain \b here would let `@don-x` wake `don`.
  it('a hyphen does not break a token: @egpt-bot / @e-bot are their OWN tokens, not the persona', () => {
    expect(mentionStatus('@egpt-bot hi')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('@e-bot hi')).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('@e-bot and @e hi')).toEqual({ atEAnywhere: true, atEStart: false });   // the real @e still wakes
  });

  it('a DOT is still a boundary: the qualified @e.kg form wakes the persona', () => {
    expect(mentionStatus('@e.kg hola')).toEqual({ atEAnywhere: true, atEStart: true });
  });

  // Real bug (operator 2026-07-24): /status emits a fenced ```yaml block whose
  // version line is a git commit SUBJECT — "refactor(bridge): @e voice-note
  // transcript reuses transcript.md" — a changelog line, not an address. The raw
  // matchers saw that fenced @e and woke E on its own /status output.
  describe('code-fence / inline-code stripping (operator 2026-07-24: /status false-wake)', () => {
    it('an @e inside a fenced code block does not wake', () => {
      const text = [
        'status:',
        '```yaml',
        'version: refactor(bridge): @e voice-note transcript reuses transcript.md',
        '```',
      ].join('\n');
      expect(mentionStatus(text)).toEqual({ atEAnywhere: false, atEStart: false });
    });
    it('an @e inside inline code does not wake', () => {
      expect(mentionStatus('use `@e` to mention')).toEqual({ atEAnywhere: false, atEStart: false });
    });
    it('an UNCLOSED fenced block strips to end-of-text — an @e after it is not detected', () => {
      const text = 'before the fence\n```\nsome code @e trailing, never closed';
      expect(mentionStatus(text)).toEqual({ atEAnywhere: false, atEStart: false });
    });
    // Regression: a genuine @e OUTSIDE any code region still wakes normally.
    it('a real @e outside code regions still wakes (regression)', () => {
      expect(mentionStatus('@e hello')).toEqual({ atEAnywhere: true, atEStart: true });
      expect(mentionStatus('please @e look')).toEqual({ atEAnywhere: true, atEStart: false });
      expect(mentionStatus('@egpt hi')).toEqual({ atEAnywhere: true, atEStart: true });
      expect(mentionStatus('me@e.com')).toEqual({ atEAnywhere: false, atEStart: false });
      expect(mentionStatus('hey@egpt')).toEqual({ atEAnywhere: false, atEStart: false });
    });
    it('custom wakeWords: a fenced @ed does not wake, but a live @ed does', () => {
      const wake = ['ed', 'egptd'];
      expect(mentionStatus('@ed estás?', wake)).toEqual({ atEAnywhere: true, atEStart: true });
      expect(mentionStatus('```\n@ed estás?\n```', wake)).toEqual({ atEAnywhere: false, atEStart: false });
    });
    // Live bug (operator 2026-08-30, WhatsApp): an ad-hoc DOUBLE-backtick fence (not the
    // usual triple) was used to quote an illustrative example addressed to a DIFFERENT
    // being. The old stripCode only recognized runs of exactly 1 or 3 backticks, so a
    // run of 2 was not code at all to it — the fenced @e survived stripping and woke E on
    // someone else's example. CommonMark's real rule (run of N backticks, closed by the
    // NEXT run of the same N) covers any run length, not just 1 and 3.
    it('an @e inside a DOUBLE-backtick fence does not wake (any backtick run length is code)', () => {
      const text = [
        'w te explico:',
        '',
        '``',
        'an: @e estás',
        '``',
        '',
        'agarra el spine de kg que reconoce a e',
      ].join('\n');
      expect(mentionStatus(text)).toEqual({ atEAnywhere: false, atEStart: false });
    });
  });
});

// A BARE HANDLE OPENING A MESSAGE IS A MENTION (operator 2026-07-27: "the '@' is not
// necessary at the beginning … 'e ', 'd ', 'egpt ', 'don ', they are all handles, and it's
// easy to write" … "d, must triger, but 'donde' must not" … "note: it work like mention
// direct -- the message has to start with keyword").
//
// It is the SAME matcher, not a second one: the bare scan reuses mentionHits' existing
// _NOT_GLUED boundary, which is exactly the operator's rule — `d,` hits because a comma is
// not a letter; `donde` does not because `o` is. START ONLY: a bare handle mid-sentence
// is not a mention at all (otherwise every `e` in Spanish prose would fire), so there is no
// "anywhere" variant of the bare form to build. The `@` form keeps its own anywhere
// behaviour untouched.
//
// THE ACCEPTED COLLISION (operator, knowingly): `don` is a Spanish honorific, so
// `don Pedro me dijo…` WILL wake `don`. "it's fine if it triggers … the agent will reply
// accordingly, and the real don Pedro will see both, perhaps smile." No heuristic, no word
// list, no confidence check guards this — do not add one.
describe('a BARE handle at the START addresses, exactly like @handle', () => {
  const DOLLY = ['d', 'don'];        // the live DOLLY persona handle set
  const KG    = ['e', 'egpt'];       // the live kg persona handle set

  it('REPRODUCE-FIRST: `d hola` wakes d — at start AND anywhere, same as @d hola', () => {
    expect(mentionStatus('d hola', DOLLY)).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('d hola', DOLLY)).toEqual(mentionStatus('@d hola', DOLLY));
  });
  it('REPRODUCE-FIRST: punctuation is a boundary — `d, ya vi` wakes d', () => {
    expect(mentionStatus('d, ya vi', DOLLY)).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionHits('d, ya vi', DOLLY)).toEqual([{ token: 'd', atStart: true }]);
  });
  it('REPRODUCE-FIRST: `donde está el archivo` does NOT wake — the handle is glued to a word char', () => {
    expect(mentionStatus('donde está el archivo', DOLLY)).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionHits('donde está el archivo', DOLLY)).toEqual([]);
  });
  it('REPRODUCE-FIRST: START ONLY — a bare handle mid-sentence is ordinary text', () => {
    expect(mentionStatus('vamos d luego', DOLLY)).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionStatus('esto y e aquello', KG)).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionHits('vamos d luego', DOLLY)).toEqual([]);
  });
  it('REPRODUCE-FIRST: the @ form is untouched — `@d hola` still wakes exactly as before', () => {
    expect(mentionStatus('@d hola', DOLLY)).toEqual({ atEAnywhere: true, atEStart: true });
    expect(mentionStatus('oye @d mirá', DOLLY)).toEqual({ atEAnywhere: true, atEStart: false });
    expect(mentionHits('@d hola', DOLLY)).toEqual([{ token: 'd', atStart: true }]);
  });

  it('longest-token-first: `don qué opinás` matches don, not d', () => {
    expect(mentionHits('don qué opinás', DOLLY)).toEqual([{ token: 'don', atStart: true }]);
  });
  it('the accepted collision ships unguarded: `don Pedro me dijo…` DOES wake don', () => {
    expect(mentionHits('don Pedro me dijo que sí', DOLLY)).toEqual([{ token: 'don', atStart: true }]);
  });
  it("REPRODUCE-FIRST: an apostrophe suffix is NOT a boundary — `don't`/`don's` do not wake don", () => {
    expect(mentionHits("don't do that", DOLLY)).toEqual([]);
    expect(mentionHits("don's afternoon plans", DOLLY)).toEqual([]);
    expect(mentionStatus("don't do that", DOLLY)).toEqual({ atEAnywhere: false, atEStart: false });
    // a real boundary right after the apostrophe still wakes — `d' hola` is glued only THROUGH
    // a following letter, not by the apostrophe itself.
    expect(mentionHits("d' hola", DOLLY)).toEqual([{ token: 'd', atStart: true }]);
  });
  it('kg`s own set: `egpt mirá esto` and `e importante` wake; `email` and `egpts` do not', () => {
    expect(mentionHits('egpt mirá esto', KG)).toEqual([{ token: 'egpt', atStart: true }]);
    expect(mentionHits('e importante', KG)).toEqual([{ token: 'e', atStart: true }]);
    expect(mentionHits('email', KG)).toEqual([]);
    expect(mentionHits('egpts hola', KG)).toEqual([]);
  });
  it('a HYPHEN is not a boundary here either — `d-bot hola` is its own token', () => {
    expect(mentionHits('d-bot hola', DOLLY)).toEqual([]);
  });

  // THE BOUNDARY IS UNICODE-AWARE (operator 2026-07-27, ruling on the STOP this chunk raised).
  // It was `(?![\w-])`, and JS `\w` is ASCII — so an accented letter counted as a BOUNDARY:
  // `donde` was silent as ruled, but `dónde` (the CORRECT spelling of the interrogative) woke
  // `d`, along with `día`, `dólar`, `dígame`, `déjalo`. "An ASCII-only boundary in a
  // Spanish-language deployment does not implement the rule he gave; it implements it for
  // unaccented text only." `\p{L}\p{N}` + the `u` flag is the SAME rule over the real alphabet.
  describe('unicode boundary — an accented letter is a LETTER, not a break', () => {
    it('accented Spanish words are SILENT (the ruling`s own counter-example, spelled correctly)', () => {
      for (const w of ['dónde está el archivo', 'día lindo', 'dólar', 'dígame', 'déjalo', 'dámelo', 'dúo'])
        expect([w, mentionHits(w, DOLLY)]).toEqual([w, []]);
      expect(mentionHits('donde está el archivo', DOLLY)).toEqual([]);   // unaccented, unchanged
    });
    it('NON-LATIN letters and non-ASCII DIGITS are letters/digits too — silent', () => {
      for (const w of ['dя hola', 'd文 hola', 'dδ hola', 'd٣ hola', 'd1 hola', 'd_x hola'])
        expect([w, mentionHits(w, DOLLY)]).toEqual([w, []]);
    });
    it('the `@` form moves in the SAME direction — `@dónde hola` no longer hits d', () => {
      expect(mentionHits('@dónde hola', DOLLY)).toEqual([]);
      expect(mentionHits('@día hola', DOLLY)).toEqual([]);
      expect(mentionHits('@d hola', DOLLY)).toEqual([{ token: 'd', atStart: true }]);   // the real @d, unchanged
    });
    it('PUNCTUATION still fires — `d,` `d.` `d:` `d?` `d!` `d;` and plain `d `', () => {
      for (const w of ['d, ya vi', 'd. ya vi', 'd: ya vi', 'd? ya vi', 'd! ya vi', 'd; ya vi', 'd ya vi'])
        expect([w, mentionHits(w, DOLLY)]).toEqual([w, [{ token: 'd', atStart: true }]]);
    });
    // DELIBERATE, and the operator has seen it: an emoji and an em-dash are neither \p{L} nor
    // \p{N}, so they remain boundaries and these FIRE. A trailing emoji is a plausible way to
    // address an agent, so this is wanted rather than merely tolerated.
    it('an EMOJI or a DASH after the handle still fires (stated, not hidden)', () => {
      for (const w of ['d🙂 hola', 'd— hola', 'd… hola', 'd👍'])
        expect([w, mentionHits(w, DOLLY)]).toEqual([w, [{ token: 'd', atStart: true }]]);
    });
    it('the ASCII glue locks are untouched by the widening', () => {
      expect(mentionHits('email', ['e', 'egpt'])).toEqual([]);
      expect(mentionHits('caramelo rico', ['cara', 'carol'])).toEqual([]);
      expect(mentionHits('carolina llegó', ['cara', 'carol'])).toEqual([]);
      expect(mentionHits('d-bot hola', DOLLY)).toEqual([]);
      expect(mentionHits('@egpt-bot hi', ['e', 'egpt'])).toEqual([]);
      expect(mentionHits('me@e.com', ['e', 'egpt'])).toEqual([]);
    });
    // A THROWN regex here would break every mention on the node, so the class shape is locked:
    // `-` MUST stay last (under `u`, a `-` between two class escapes is a syntax error), and
    // _escapeWake only ever emits SyntaxCharacter escapes, which `u` still permits.
    it('never THROWS on real or hostile handles under the `u` flag', () => {
      for (const h of ['e', 'egpt', 'carol', 'wren', 'cara', 'don', 'd', 'don-local', 'don.do',
                       'e.kg', 'x_y', 'café', '日本', 'a-b-c', '.*+?^${}()|[]\\', '🙂', '\uD800'])
        expect(() => mentionHits('probe text', [h])).not.toThrow();
    });
  });
  it('leading whitespace is tolerated (mirrors the @ form)', () => {
    expect(mentionStatus('   d hola', DOLLY)).toEqual({ atEAnywhere: true, atEStart: true });
  });
  it('a handle ALONE is a mention, same as a lone @d', () => {
    expect(mentionHits('d', DOLLY)).toEqual([{ token: 'd', atStart: true }]);
    expect(mentionHits('d', DOLLY)).toEqual(mentionHits('@d', DOLLY));
  });
  it('code stripping still applies — a fenced/inline bare handle never wakes', () => {
    expect(mentionHits('```\nd hola\n```', DOLLY)).toEqual([]);
    expect(mentionHits('`d` hola', DOLLY)).toEqual([]);
  });
  it('the bare hit rides in TEXT ORDER beside @ hits', () => {
    expect(mentionHits('d and @don here', DOLLY))
      .toEqual([{ token: 'd', atStart: true }, { token: 'don', atStart: false }]);
  });
  it('a command wins: a line opening with a slash is not a bare handle', () => {
    expect(mentionHits('/status', DOLLY)).toEqual([]);
    expect(mentionHits('/dolly restart', DOLLY)).toEqual([]);
  });

  // THE GATING CONTRACT (operator 2026-07-27: "it work like mention direct -- the message
  // has to start with keyword"). The bare form must be INDISTINGUISHABLE from the @ form at
  // the gate — if the two diverge in any mode, the bare form is not really a mention.
  it('gates IDENTICALLY to @d in EVERY mode', () => {
    const bare = { ...mentionStatus('d hola', DOLLY), replyToBot: false };
    const at   = { ...mentionStatus('@d hola', DOLLY), replyToBot: false };
    const gate = (st) => ({ atEStart: st.atEStart, atEAnywhere: st.atEAnywhere, replyToBot: st.replyToBot });
    for (const mode of AUTO_MODES) {
      expect([mode, replyAllowed(mode, gate(bare))]).toEqual([mode, replyAllowed(mode, gate(at))]);
    }
    // …and it is a DIRECT mention: mention-direct wakes on it.
    expect(replyAllowed('mention-direct', gate(bare))).toBe(true);
    expect(replyAllowed('mention', gate(bare))).toBe(true);
    expect(replyAllowed('mute', gate(bare))).toBe(false);
    expect(replyAllowed('off', gate(bare))).toBe(false);
    expect(replyAllowed('on', gate(bare))).toBe(true);
  });
});

// ── THE SWITCH (operator 2026-07-27: "this addressing without the '@' must be an option, easy
//    to turn on/off globally"). ONE node-wide boolean, `dispatch.address_without_at`, DEFAULT
//    TRUE — the live behaviour he likes stays on for every node that says nothing.
//
//    It is an ARGUMENT, never a config read: mentionHits is a PURE function and stays one (the
//    import-free lock below). The flag arrives from the CALLERS — the bridges hand it to
//    mentionStatus beside the wakeWords boot already gives them, the router hands it to
//    `addressed` beside the agents registry boot already gives it. Same route as the wake list,
//    on both sides.
//
//    OFF must be a RETURN to the pre-39d70a3 matcher, not a third behaviour: only '@' hits, and
//    the '@' scan byte-for-byte identical in both states — SAME unicode boundary (39d70a3's
//    other half, which is NOT switchable), same anywhere behaviour, same code stripping. ──
describe('address_without_at: the bare form is a node-wide SWITCH, default ON', () => {
  const DOLLY = ['d', 'don'];
  const OFF = { addressWithoutAt: false };
  const ON  = { addressWithoutAt: true };

  it('REPRODUCE-FIRST: OFF — `d hola` does NOT address, and the text is untouched', () => {
    expect(mentionHits('d hola', DOLLY, OFF)).toEqual([]);
    expect(mentionStatus('d hola', DOLLY, OFF)).toEqual({ atEAnywhere: false, atEStart: false });
    expect(mentionHits('d, ya vi', DOLLY, OFF)).toEqual([]);
    expect(mentionHits('don qué opinás', DOLLY, OFF)).toEqual([]);
  });
  it('REPRODUCE-FIRST: OFF — `@d hola` still addresses, exactly as it does with the flag on', () => {
    expect(mentionHits('@d hola', DOLLY, OFF)).toEqual([{ token: 'd', atStart: true }]);
    expect(mentionStatus('@d hola', DOLLY, OFF)).toEqual({ atEAnywhere: true, atEStart: true });
  });
  it('REPRODUCE-FIRST: ON is the DEFAULT — no option at all behaves like `d hola` does live', () => {
    expect(mentionHits('d hola', DOLLY)).toEqual([{ token: 'd', atStart: true }]);
    expect(mentionHits('d hola', DOLLY, ON)).toEqual(mentionHits('d hola', DOLLY));
    expect(mentionHits('d hola', DOLLY, {})).toEqual(mentionHits('d hola', DOLLY));
    expect(mentionStatus('d hola', DOLLY, ON)).toEqual(mentionStatus('d hola', DOLLY));
  });

  // The '@' path may not so much as flinch when the switch moves — including 39d70a3's OTHER
  // half, the unicode boundary, which is not switchable and stays in force in both states.
  it('the `@` path is IDENTICAL in both states — anywhere, boundary, fences, longest-first', () => {
    for (const t of ['@d hola', 'oye @d mirá', '@don.do do X', '@dónde hola', '@día hola',
                     '@d-bot hola', 'me@d.com', 'hey@don', '```\n@d hola\n```', '`@d` hola',
                     '@DON and @d', '@d', 'nada de nada'])
      expect([t, mentionHits(t, DOLLY, OFF)]).toEqual([t, mentionHits(t, DOLLY, ON)]);
  });
  it('OFF drops ONLY the bare hit from a mixed line — the @ hits stay, in text order', () => {
    expect(mentionHits('d and @don here', DOLLY, ON))
      .toEqual([{ token: 'd', atStart: true }, { token: 'don', atStart: false }]);
    expect(mentionHits('d and @don here', DOLLY, OFF)).toEqual([{ token: 'don', atStart: false }]);
  });
  it('OFF gates like an UNMENTIONED message in every mode; ON gates like @d in every mode', () => {
    const gate = (st) => ({ ...st, replyToBot: false });
    for (const mode of AUTO_MODES) {
      expect([mode, replyAllowed(mode, gate(mentionStatus('d hola', DOLLY, OFF)))])
        .toEqual([mode, replyAllowed(mode, gate(mentionStatus('no me menciona', DOLLY, OFF)))]);
      expect([mode, replyAllowed(mode, gate(mentionStatus('d hola', DOLLY, ON)))])
        .toEqual([mode, replyAllowed(mode, gate(mentionStatus('@d hola', DOLLY, ON)))]);
    }
  });

  // PURITY LOCK. The flag must never become a config read INSIDE the matcher: auto-mode.mjs is
  // the one module the bridges, the router, the gate and the room all share, and it has zero
  // imports by design. If this goes red, someone reached for the config from inside a pure
  // function — hand the value in from the caller instead.
  it('mentionHits stays PURE — auto-mode.mjs imports nothing and reads no config/env', () => {
    const src = readFileSync(new URL('../src/auto-mode.mjs', import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/require\(|process\.env|readConfig|getConfig|EGPT_CONFIG/);
  });
});

// mentionHitsAnywhere — the SPOKEN (voice_handles) counterpart to the bare/@-forms above: a
// bare-token scan with NO `^` anchor and NO '@' required, reusing the SAME _NOT_GLUED boundary
// on both sides (operator 2026-08-09, wake-on-spoken-alias). This does not touch the EXISTING
// bare-form rule (START ONLY, tested above) — it is a separate, opt-in mode for a separate list.
describe('mentionHitsAnywhere — the spoken (voice_handles) anywhere-match mode', () => {
  it('matches a bare token ANYWHERE in the string, no @ required', () => {
    expect(mentionHitsAnywhere('oye perrito estás ahí', ['perrito'])).toEqual([{ token: 'perrito' }]);
    expect(mentionHitsAnywhere('estás ahí perrito', ['perrito'])).toEqual([{ token: 'perrito' }]);
  });
  it('a token GLUED inside a longer word does NOT match (both sides of the boundary)', () => {
    expect(mentionHitsAnywhere('el carperrito pasó', ['perrito'])).toEqual([]);   // glued on the left
    expect(mentionHitsAnywhere('el perritolindo pasó', ['perrito'])).toEqual([]); // glued on the right
  });
  it('punctuation/whitespace boundaries still fire, mid-string', () => {
    expect(mentionHitsAnywhere('hola, perrito, vení', ['perrito'])).toEqual([{ token: 'perrito' }]);
  });
  it('no match, no tokens, no text → empty, never throws', () => {
    expect(mentionHitsAnywhere('nada de nada', ['perrito'])).toEqual([]);
    expect(mentionHitsAnywhere('perrito', [])).toEqual([]);
    expect(mentionHitsAnywhere('', ['perrito'])).toEqual([]);
    expect(mentionHitsAnywhere(null, ['perrito'])).toEqual([]);
  });
  it('longest-token-first, case-insensitive, multiple hits in text order', () => {
    expect(mentionHitsAnywhere('Perrito y luego perro', ['perro', 'perrito']))
      .toEqual([{ token: 'perrito' }, { token: 'perro' }]);
  });
  it("REPRODUCE-FIRST: an apostrophe suffix is NOT a boundary — a whisper transcript of `I don't know` does not wake don", () => {
    expect(mentionHitsAnywhere("I don't know", ['don'])).toEqual([]);
    expect(mentionHitsAnywhere("that's don's dog", ['don'])).toEqual([]);
  });
});

// mentionStatus' opt-in `alsoAnywhere` — additive merge of the voice-alias anywhere-match into
// atEAnywhere ONLY (never atEStart, which has no meaning for an anywhere hit). Every EXISTING
// caller (no alsoAnywhere) is untouched — locked by the huge test surface above this block,
// none of which was edited to add this option.
describe('mentionStatus({ alsoAnywhere }) — voice_handles merges additively into atEAnywhere', () => {
  it('a voice alias mid-transcript sets atEAnywhere true, atEStart stays false', () => {
    const st = mentionStatus('(voice transcription, 8s) oye perrito estás ahí', [], { alsoAnywhere: ['perrito'] });
    expect(st).toEqual({ atEAnywhere: true, atEStart: false });
  });
  it('no alsoAnywhere list (undefined/empty) behaves exactly like plain mentionStatus', () => {
    expect(mentionStatus('hola perrito', [])).toEqual(mentionStatus('hola perrito', [], { alsoAnywhere: [] }));
    expect(mentionStatus('hola perrito', [])).toEqual(mentionStatus('hola perrito', [], { alsoAnywhere: undefined }));
  });
  it('the text @handle path and the voice alsoAnywhere path OR together', () => {
    const st = mentionStatus('@e y también perrito', ['e', 'egpt'], { alsoAnywhere: ['perrito'] });
    expect(st).toEqual({ atEAnywhere: true, atEStart: true });   // @e still sets atEStart
  });
  it('addressWithoutAt keeps riding alongside alsoAnywhere without interference', () => {
    const st = mentionStatus('e hola perrito', ['e'], { addressWithoutAt: false, alsoAnywhere: ['perrito'] });
    // bare 'e' at start does NOT address (addressWithoutAt:false) but the voice alias still does
    expect(st).toEqual({ atEAnywhere: true, atEStart: false });
  });
});

describe('replyAllowed', () => {
  const M = (o) => ({ atEStart: false, atEAnywhere: false, replyToBot: false, ...o });
  it('on always allows (personality decides downstream)', () => {
    expect(replyAllowed('on', M())).toBe(true);
  });
  it('auto gates like on — always allows, mention-independent', () => {
    expect(replyAllowed('auto', M())).toBe(true);
    expect(replyAllowed('auto', M({ atEAnywhere: true }))).toBe(true);
  });
  it('accum gates EXACTLY like mention — the mode changes the PROMPT, never the gate', () => {
    // BY DESIGN (operator 2026-07-26), not by degradation: 'accum' is a known mode whose
    // reply gate IS mention's. What it adds happens in the prompt (spine/spine.mjs
    // runReplyTurn + transcript-log.contextSinceLastTurn), never here.
    expect(replyAllowed('accum', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('accum', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('accum', M())).toBe(false);
    expect(replyAllowed('accum', M({ atEStart: true }))).toBe(false);   // atEStart alone is not a mention hit
    // identical to 'mention' in EVERY mention state — see tests/accum-mode.test.mjs for
    // the exhaustive form.
    expect(replyAllowed('accum', M({ atEAnywhere: true }))).toBe(replyAllowed('mention', M({ atEAnywhere: true })));
    expect(replyAllowed('accum', M())).toBe(replyAllowed('mention', M()));
  });
  it('mute / off never allow', () => {
    expect(replyAllowed('mute', M({ atEStart: true, atEAnywhere: true, replyToBot: true }))).toBe(false);
    expect(replyAllowed('off', M({ atEAnywhere: true }))).toBe(false);
  });
  it('mention-direct: only @e-at-start or reply-to-bot', () => {
    expect(replyAllowed('mention-direct', M({ atEStart: true }))).toBe(true);
    expect(replyAllowed('mention-direct', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('mention-direct', M({ atEAnywhere: true }))).toBe(false);   // mid-message ≠ start
    expect(replyAllowed('mention-direct', M())).toBe(false);
  });
  it('mention: @e anywhere or reply-to-bot', () => {
    expect(replyAllowed('mention', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('mention', M({ replyToBot: true }))).toBe(true);
    expect(replyAllowed('mention', M())).toBe(false);
  });
  it('unknown mode falls back to mention semantics', () => {
    expect(replyAllowed('bogus', M({ atEAnywhere: true }))).toBe(true);
    expect(replyAllowed('bogus', M())).toBe(false);
  });
});

describe('receives / isAutoMode', () => {
  it('receives is true for everything except off', () => {
    for (const m of ['on', 'auto', 'mute', 'mention-direct', 'mention', 'accum']) expect(receives(m)).toBe(true);
    expect(receives('off')).toBe(false);
  });
  it('isAutoMode + default; auto and accum are both known modes', () => {
    expect(isAutoMode('mention')).toBe(true);
    expect(isAutoMode('auto')).toBe(true);     // new mode (operator 2026-07-04)
    expect(isAutoMode('nope')).toBe(false);
    expect(isAutoMode('accum')).toBe(true);    // a MODE again (operator 2026-07-26) — gates like mention, prompts with the gap
    expect(DEFAULT_AUTO_MODE).toBe('mention'); // auto/accum are opt-in only, never the default
  });
});

// Regression: the WA bridge rewrites a mid-body "@e" to a LEADING "@e " prefix
// (at_e_anywhere, default on) purely so start-anchored parseInput ROUTES the
// message to @e. The per-chat reply gate must NOT be computed on that rewritten
// body — doing so promotes a mid-message @e to atEStart and silently collapses
// 'mention-direct' into 'mention'. The gate must read the user's ORIGINAL body.
// (Mirrors src/bridges/whatsapp.mjs: `_gateMs = mentionStatus(processed)` is
// taken BEFORE the `processed = '@e ' + processed` routing rewrite.)
describe('mention-direct gate is immune to the @e-routing rewrite', () => {
  // Minimal model of the bridge's at_e_anywhere expansion.
  const routeRewrite = (body) =>
    (!/^@\S/.test(body) && mentionStatus(body).atEAnywhere) ? `@e ${body}` : body;

  it('mid-body @e routes to @e but does NOT open mention-direct', () => {
    const original = 'hello @e are you up?';
    const routed = routeRewrite(original);
    expect(routed).toBe('@e hello @e are you up?');     // routing prepends for parseInput

    // WRONG (the bug): gate computed on the rewritten body → false-positive start.
    expect(mentionStatus(routed).atEStart).toBe(true);

    // RIGHT: gate computed on the original body → mention-direct stays closed,
    // mention still fires (the @e is genuinely present, just not at the start).
    const gate = mentionStatus(original);
    expect(gate).toEqual({ atEAnywhere: true, atEStart: false });
    expect(replyAllowed('mention-direct', gate)).toBe(false);
    expect(replyAllowed('mention', gate)).toBe(true);
  });

  it('genuine @e-at-start opens both mention and mention-direct', () => {
    const gate = mentionStatus('@e ping');
    expect(replyAllowed('mention-direct', gate)).toBe(true);
    expect(replyAllowed('mention', gate)).toBe(true);
  });
});

describe('fanOutDecision — single record-always / gate-on-mode chokepoint', () => {
  // The operator's rule (2026-06-02): gating is mode + per-turn replyAllowed
  // (from the INCOMING message), NEVER E's reply body — except the 'on'-mode
  // silence cosmetic. Nothing is dropped; non-sent replies are annotated.
  it('mute: NEVER fans out, whatever E said — recorded + annotated', () => {
    expect(fanOutDecision('mute', { replyAllowed: true, reply: 'a long real answer' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mute)' });
    expect(fanOutDecision('mute', { reply: '…' }).sent).toBe(false);
  });
  it('mention: fan-out follows replyAllowed, the reply BODY is irrelevant', () => {
    // replyAllowed true → sent, even if the reply is just "…"
    expect(fanOutDecision('mention', { replyAllowed: true, reply: '…' }))
      .toEqual({ sent: true, annotation: null });
    // replyAllowed false → NOT sent, even a long reply → recorded + annotated
    expect(fanOutDecision('mention', { replyAllowed: false, reply: 'a whole paragraph' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mention)' });
  });
  it('mention-direct: same — body never decides', () => {
    expect(fanOutDecision('mention-direct', { replyAllowed: true, reply: 'hi' }).sent).toBe(true);
    expect(fanOutDecision('mention-direct', { replyAllowed: false, reply: 'long reflection' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mention-direct)' });
  });
  it('fails CLOSED for mention modes when replyAllowed is absent (forgotten flag → recorded, not leaked)', () => {
    expect(fanOutDecision('mention', { reply: 'leak attempt' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: mention)' });
    expect(fanOutDecision('mention-direct', { reply: 'leak attempt' }).sent).toBe(false);
  });
  it('on: fans out real replies; a pure-silence reply is the ONLY body-aware case (recorded, not pushed)', () => {
    expect(fanOutDecision('on', { reply: 'hello there' })).toEqual({ sent: true, annotation: null });
    expect(fanOutDecision('on', { reply: '…' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: on)' });
    expect(fanOutDecision('on', { reply: '...' }).sent).toBe(false);
  });
  it('auto: same as on — real replies fan out, a pure-silence reply is recorded not pushed', () => {
    expect(fanOutDecision('auto', { reply: 'on it' })).toEqual({ sent: true, annotation: null });
    expect(fanOutDecision('auto', { reply: '…' }))
      .toEqual({ sent: false, annotation: '(not sent to group. auto: auto)' });
  });
  it('isSilenceReply only matches pure ellipsis/empty', () => {
    expect(isSilenceReply('…')).toBe(true);
    expect(isSilenceReply('...')).toBe(true);
    expect(isSilenceReply('   ')).toBe(true);
    expect(isSilenceReply('… and then')).toBe(false);   // the leak shape: NOT silence
    expect(isSilenceReply('ok')).toBe(false);
  });
});

describe('mayEmit — outbound backstop', () => {
  it('HARD-blocks mute/off even when replyAllowed is (wrongly) true', () => {
    expect(mayEmit('mute', { replyAllowed: true })).toBe(false);
    expect(mayEmit('off',  { replyAllowed: true })).toBe(false);
  });
  it('allows on unconditionally', () => {
    expect(mayEmit('on', {})).toBe(true);
    expect(mayEmit('on', { replyAllowed: false })).toBe(true);
  });
  it('allows auto unconditionally (gates like on)', () => {
    expect(mayEmit('auto', {})).toBe(true);
    expect(mayEmit('auto', { replyAllowed: false })).toBe(true);
  });
  it('mention modes defer to the per-turn replyAllowed flag', () => {
    expect(mayEmit('mention', { replyAllowed: true })).toBe(true);
    expect(mayEmit('mention', { replyAllowed: false })).toBe(false);
    expect(mayEmit('mention-direct', { replyAllowed: true })).toBe(true);
    expect(mayEmit('accum', { replyAllowed: true })).toBe(true);   // accum defers to the flag exactly like mention
  });
  it('fails CLOSED for mention modes when the flag is absent', () => {
    expect(mayEmit('mention', {})).toBe(false);
    expect(mayEmit('mention-direct', {})).toBe(false);
  });
  // I5 REVISED (operator 2026-06-16, Phase 2): a reaction now follows the SAME
  // mode gate as any message — no longer hard-blocked, because it arrives as an
  // intelligible stage-direction. 'on' → E may answer; 'mention(-direct)' → only if
  // @-mentioned (a reaction can't, so replyAllowed stays false → silent);
  // 'mute'/'off' → never. (Was: a reaction NEVER emitted in any mode.)
  it('a reaction follows the normal mode gate (I5 revised) — no longer hard-blocked', () => {
    expect(mayEmit('on',      { isReaction: true })).toBe(true);                       // 'on' → may answer
    expect(mayEmit('on',      { replyAllowed: true, isReaction: true })).toBe(true);
    expect(mayEmit('mention', { isReaction: true })).toBe(false);                     // not mentioned → silent
    expect(mayEmit('mention', { replyAllowed: true, isReaction: true })).toBe(true);  // mentioned → may answer
    expect(mayEmit('mute',    { replyAllowed: true, isReaction: true })).toBe(false); // mute always silent
    expect(mayEmit('off',     { replyAllowed: true, isReaction: true })).toBe(false);
  });
});

// CONTRACT: whatsapp.auto_e_paused = absolute @e-emit kill. This is the one gate
// rule that lives in egpt.mjs `_eMayReplyToChat` (above the mode layer); locking
// it here guards against its silent removal. The wrapper delegates to this fn,
// so this IS the real gate, pause included — not a parallel copy.
describe('mayEmitChat — global pause kill over the mode gate', () => {
  it('paused BLOCKS every mode — even on, even with replyAllowed', () => {
    expect(mayEmitChat({ paused: true, mode: 'on' })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'on', replyAllowed: true })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'mention', replyAllowed: true })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'mention-direct', replyAllowed: true })).toBe(false);
    // A REACTION must not bypass any gate (operator 2026-06-16 nota bene): paused
    // kills a reaction-triggered emit too, even in 'on'.
    expect(mayEmitChat({ paused: true, mode: 'on', isReaction: true })).toBe(false);
    expect(mayEmitChat({ paused: true, mode: 'on', replyAllowed: true, isReaction: true })).toBe(false);
  });
  it('not paused → identical to the per-chat mode gate (mayEmit)', () => {
    for (const mode of ['on', 'mute', 'off', 'mention', 'mention-direct', 'accum']) {
      for (const replyAllowed of [true, false, undefined]) {
        expect(mayEmitChat({ paused: false, mode, replyAllowed }))
          .toBe(mayEmit(mode, { replyAllowed }));
      }
    }
  });
  it('defaults are fail-safe (no args → no emit)', () => {
    expect(mayEmitChat()).toBe(false);                       // no mode, not paused → mayEmit(undefined) → false
    expect(mayEmitChat({ mode: 'mention' })).toBe(false);    // mention w/o replyAllowed → fails closed
  });
});
