// tests/browser-tools.test.mjs — click and type like a person: real Input events, over a faked port transport.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as browser from '../src/tools/browser-tools.mjs';

const TAB = { id: 'T1', type: 'page', url: 'https://example.com/form', title: 'Form', webSocketDebuggerUrl: 'ws://fake/page/T1' };
const CENTER = { x: 110, y: 220 };

// A Chrome behind /json + one WebSocket per session; `evaluate(expression)` answers Runtime.evaluate.
function fakeChrome(evaluate = (e) => (e.includes('scrollIntoView') ? CENTER : undefined)) {
  const sent = [];
  class WS extends EventTarget {
    constructor(url) { super(); this.url = url; setTimeout(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const { id, method, params } = JSON.parse(text);
      sent.push({ url: this.url, method, params });
      const result = method === 'Runtime.evaluate' ? { result: { value: evaluate(params.expression) } } : {};
      setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) })));
    }
    close() {}
  }
  vi.stubGlobal('fetch', async (url) => new Response(JSON.stringify(String(url).endsWith('/json/version') ? { webSocketDebuggerUrl: 'ws://fake/browser' } : [TAB])));
  vi.stubGlobal('WebSocket', WS);
  return { sent, of: (m) => sent.filter((s) => s.method === m) };
}

// Deterministic stand-in for Math.random.
const seeded = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const mouse = (c) => c.of('Input.dispatchMouseEvent').map(({ params: p }) => [p.type, p.x, p.y, p.button]);
const CLICK_AT_CENTER = ['mouseMoved', 'mousePressed', 'mouseReleased'].map((t) => [t, CENTER.x, CENTER.y, 'left']);

describe('browser-tools — click and type like a person', () => {
  let savedCdp;
  beforeEach(() => { savedCdp = process.env.EGPT_CDP; delete process.env.EGPT_CDP; });
  afterEach(() => { vi.unstubAllGlobals(); if (savedCdp !== undefined) process.env.EGPT_CDP = savedCdp; });

  it('click: scrolls the element into view and sends a real mouse moved → pressed → released at its center', async () => {
    const c = fakeChrome();
    await browser.click('T1', '#go');
    expect(c.of('Runtime.evaluate')[0].params.expression).toContain('document.querySelector("#go")');
    expect(c.of('Runtime.evaluate')[0].params.expression).toContain('scrollIntoView');
    expect(mouse(c)).toEqual(CLICK_AT_CENTER);
  });

  it('click / type / clickText still throw when nothing matches, and send no input', async () => {
    const c = fakeChrome(() => null);
    await expect(browser.click('T1', '#nope')).rejects.toThrow('click: no element matches "#nope"');
    await expect(browser.type('T1', '#nope', 'x', { sleep: async () => {} })).rejects.toThrow('type: no element matches "#nope"');
    await expect(browser.clickText('T1', 'Send')).rejects.toThrow('clickText: nothing visible matches "Send"');
    expect(c.sent.filter((s) => s.method.startsWith('Input.'))).toEqual([]);
  });

  it('clickText: the last visible match by default, the first with { first: true }; a RegExp works too', async () => {
    const c = fakeChrome();
    await browser.clickText('T1', 'Sen.');
    await browser.clickText('T1', /Next/, { first: true });
    const [last, first] = c.of('Runtime.evaluate').map((s) => s.params.expression);
    expect(last).toContain('new RegExp("Sen.", \'i\')');
    expect(last).toContain('.pop()');
    expect(first).toContain('new RegExp("Next", \'i\')');
    expect(first).toContain('[0]');
    expect(mouse(c)).toEqual([...CLICK_AT_CENTER, ...CLICK_AT_CENTER]);
  });

  it('type: clicks the field, selects its content, then one Input.insertText per code point, each followed by its jittered pause', async () => {
    const c = fakeChrome();
    const pauses = [];
    await browser.type('T1', '#q', 'hi 👋!', { rand: seeded(7), sleep: async (ms) => { pauses.push(ms); } });
    expect(c.sent.map((s) => s.method)).toEqual([
      'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
      'Runtime.evaluate', 'Input.insertText', 'Input.insertText', 'Input.insertText', 'Input.insertText', 'Input.insertText',
    ]);
    expect(mouse(c)).toEqual(CLICK_AT_CENTER);
    expect(c.of('Runtime.evaluate')[1].params.expression).toContain('select()');
    expect(c.of('Input.insertText').map((s) => s.params.text)).toEqual(['h', 'i', ' ', '👋', '!']);
    const rand = seeded(7);
    expect(pauses).toEqual(['h', 'i', ' ', '👋', '!'].map((ch) => browser.keyDelay(ch, rand)));
  });

  it('keyDelay: 25–110 ms a key, longer after a space or punctuation, now and then a think', () => {
    const at = (...v) => { let i = 0; return () => v[i++ % v.length]; };
    expect(browser.keyDelay('a', at(0.5))).toBe(46);                 // 25 + 85·0.5²
    expect(browser.keyDelay('a', at(0))).toBe(225);                  // 25, and rand 0 < 1/25: +200
    expect(browser.keyDelay('a', at(0.9999))).toBe(110);
    expect(browser.keyDelay(' ', at(0.5))).toBe(151);                // +60 + 90·0.5
    expect(browser.keyDelay(',', at(0.5))).toBe(151);
    expect(browser.keyDelay('a', at(0.5, 0.01, 0.5))).toBe(396);     // +200 + 300·0.5

    const rand = seeded(42);
    const letters = Array.from({ length: 2000 }, () => browser.keyDelay('e', rand));
    const spaces = Array.from({ length: 2000 }, () => browser.keyDelay(' ', rand));
    for (const ms of letters) expect((ms >= 25 && ms <= 110) || (ms >= 225 && ms <= 610)).toBe(true);
    for (const ms of spaces) expect((ms >= 85 && ms <= 260) || (ms >= 285 && ms <= 760)).toBe(true);
    const plain = letters.filter((ms) => ms <= 110);
    expect(plain.reduce((a, b) => a + b, 0) / plain.length).toBeGreaterThan(45);
    expect(plain.reduce((a, b) => a + b, 0) / plain.length).toBeLessThan(62);
    expect(new Set(letters).size).toBeGreaterThan(50);
    expect(letters.length - plain.length).toBeGreaterThan(30);       // ~1 in 25 thinks
    expect(letters.length - plain.length).toBeLessThan(130);
    const run = (seed) => { const r = seeded(seed); return Array.from({ length: 20 }, () => browser.keyDelay('e', r)); };
    expect(run(1)).not.toEqual(run(2));
  });

  it('cli: finds the tab by url part, brings it to the front, and maps each command', async () => {
    const c = fakeChrome((e) => {
      if (e.includes('scrollIntoView')) return CENTER;
      if (e === 'location.href') return TAB.url;
      if (e === 'document.title') return TAB.title;
      if (e.includes('innerText ??')) return 'Hello\n\n  world, and more';
      if (e.includes('el.value ?? el.innerText')) return 'ok';
      if (e.includes('tagName')) return 'BUTTON:Send | A:Home';
      return undefined;
    });
    expect(await browser.cli(['example.com', 'list'])).toBe('BUTTON:Send | A:Home');
    expect(c.of('Target.activateTarget')[0]).toMatchObject({ url: 'ws://fake/browser', params: { targetId: 'T1' } });
    expect(c.of('Page.bringToFront')[0].url).toBe(TAB.webSocketDebuggerUrl);
    expect(await browser.cli(['example.com', 'text', '11'])).toBe('https://example.com/form || Form || Hello world');
    expect(await browser.cli(['/form', 'click', 'Send'])).toBe('clicked Send');
    expect(await browser.cli(['/form', 'clickFirst', 'Send'])).toBe('clicked Send');
    expect(await browser.cli(['/form', 'clickSel', '#go'])).toBe('clicked #go');
    expect(await browser.cli(['/form', 'type', '#q', 'ok'])).toBe('typed; value=ok');
    const evals = c.of('Runtime.evaluate').map((s) => s.params.expression);
    expect(evals.filter((e) => e.includes('.pop()'))).toHaveLength(1);
    expect(evals.filter((e) => e.includes('.filter(e => new RegExp("Send", \'i\')') && e.includes('[0]'))).toHaveLength(1);
    expect(c.of('Input.insertText').map((s) => s.params.text)).toEqual(['o', 'k']);
    expect(mouse(c)).toHaveLength(12);
  });

  it('cli: a bad command line is the usage, and asks Chrome nothing; an unknown tab says so', async () => {
    const c = fakeChrome();
    for (const argv of [[], ['example.com'], ['example.com', 'bogus'], ['example.com', 'click'], ['example.com', 'type', '#q'], ['example.com', 'toString']]) {
      await expect(browser.cli(argv)).rejects.toThrow(/^usage: node browser-tools\.mjs <tabUrlPart> list/);
    }
    expect(c.sent).toEqual([]);
    await expect(browser.cli(['nowhere.test', 'list'])).rejects.toThrow('no tab whose url contains "nowhere.test"');
  });
});
