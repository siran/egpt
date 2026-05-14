// slash/theme.mjs — switch terminal color theme.

import { listThemes } from '../tools/theme.mjs';

export const meta = [
  {
    cmd: '/theme',
    section: 'ROOM',
    surface: 'shell',
    usage: '/theme <name|next|prev>',
    desc: 'switch terminal theme',
  },
  {
    cmd: '/themes',
    section: 'ROOM',
    surface: 'shell',
    usage: '/themes',
    desc: 'list available themes',
  },
];

export async function run({ cmd, arg, ctx }) {
  // ctx keys consumed:
  //   sysOut(text)
  //   getTheme()        — current theme name (let binding in egpt.mjs)
  //   setTheme(name)    — apply by name; handles the Object.assign(T, ...)
  //                       + _currentTheme reassignment + setThemeRev bump
  const { sysOut, getTheme, setTheme } = ctx;

  if (cmd === '/themes') {
    const names = await listThemes();
    const cur = getTheme();
    const lines = names.map(n => n === cur ? `/theme ${n} ← active` : `/theme ${n}`);
    sysOut(`themes:\n${lines.join('\n')}`);
    return true;
  }

  if (cmd === '/theme') {
    const name = arg.trim();
    if (!name) {
      sysOut(`active theme: ${getTheme()}  (use /themes to list, next/prev to rotate)`);
      return true;
    }
    const names = await listThemes();
    let target = name;
    if (name === 'next' || name === 'prev') {
      const idx = names.indexOf(getTheme());
      target = name === 'next'
        ? names[(idx + 1) % names.length]
        : names[(idx - 1 + names.length) % names.length];
    }
    setTheme(target);
    sysOut(`theme: ${target}`);
    return true;
  }

  return false;
}
