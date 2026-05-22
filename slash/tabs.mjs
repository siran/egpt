// slash/tabs.mjs — list pages in the brain Chrome.

import * as cdp from '../src/tools/cdp.mjs';

export const meta = {
  cmd: '/tabs',
  section: 'BRAINS',
  surface: 'both',
  usage: '/tabs [all]',
  desc: 'list Chrome pages (chrome:// internals hidden by default)',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   BRAINS              — brain registry; we walk urlMatch to label tabs
  const { sysOut, BRAINS } = ctx;

  try {
    const all = await cdp.listTabs();
    const showAll = arg === 'all';
    const isInternal = (u) =>
      u.startsWith('chrome://') || u.startsWith('chrome-extension://') ||
      u.startsWith('devtools://') || u.startsWith('about:');
    const tabs = showAll ? all : all.filter(t => !isInternal(t.url));
    if (!tabs.length) {
      sysOut(showAll
        ? 'no pages found in brain Chrome'
        : 'no real pages (try /tabs all to see chrome:// internals)');
      return true;
    }
    const matchBrain = (url) => {
      for (const b of Object.values(BRAINS)) {
        if (b.urlMatch && b.urlMatch.test(url)) return b.name;
      }
      return '(unmapped)';
    };
    const hidden = all.length - tabs.length;
    const header = hidden
      ? `(${hidden} chrome:// page${hidden > 1 ? 's' : ''} hidden — /tabs all to see)\n`
      : '';
    sysOut(header + tabs.map(t =>
      `"${t.title || '(untitled)'}"   ·   ${matchBrain(t.url)}\n` +
      `   ${t.url}\n` +
      `   id: ${t.id.slice(0, 8)}`,
    ).join('\n\n'));
  } catch (e) {
    sysOut(`!! ${e.message}`);
  }
  return true;
}
