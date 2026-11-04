// tests/chrome-group-identity.test.mjs — each group's Chrome is named and colored after its group
// (operator 2026-10-17): --window-name in the argv, and the profile's name + theme color written into
// its Local State / Default/Preferences before its Chrome starts. Temp profile dirs with fake JSON
// (key names as Chrome 155 writes them); no real Chrome.
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { groupColor, stampGroupProfile, GROUP_PALETTE } from '../src/tools/chrome-launcher.mjs';
import { readBrowserColors, readBrowserGroups } from '../src/rooms-file.mjs';
import { createPipeChannel } from '../src/tools/cdp.mjs';
import { createCommands } from '../src/spine/commands.mjs';

const LOCAL_STATE = '{"browser":{"enabled_labs_experiments":[]},"profile":{"info_cache":{"Default":{"active_time":1792243422.086623,"avatar_icon":"chrome://theme/IDR_PROFILE_AVATAR_26","is_using_default_name":true,"name":"Your Chrome","profile_highlight_color":-14737376}},"profiles_order":["Default"]},"zoom":{"level":1.0}}';
const PREFERENCES = '{"browser":{"window_placement":{"bottom":1050,"left":10}},"note":"a<b","partition":{"per_host_zoom_levels":{"x":{"a.com":{"zoom_level":0.0}}}},"profile":{"avatar_index":26,"exit_type":"Crashed","name":"Your Chrome"},"syncing_theme_prefs_migrated_to_non_syncing":true}';
const argbOf = (hex) => (0xff000000 | parseInt(hex.slice(1), 16)) | 0;

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function profile({ localState = LOCAL_STATE, preferences = PREFERENCES } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'egpt-identity-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'Default'));
  if (localState != null) writeFileSync(join(dir, 'Local State'), localState);
  if (preferences != null) writeFileSync(join(dir, 'Default', 'Preferences'), preferences);
  return dir;
}
const read = (dir) => ({
  ls: JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')),
  prefs: JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8')),
  lsText: readFileSync(join(dir, 'Local State'), 'utf8'),
  prefsText: readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'),
});

describe('groupColor — a fixed palette pick by name, overridable per group', () => {
  it('is deterministic and always from the palette', () => {
    for (const g of ['brain', 'contoso-si', 'shared', 'perrito', 'with space']) {
      expect(GROUP_PALETTE).toContain(groupColor(g));
      expect(groupColor(g)).toBe(groupColor(g));
    }
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((g) => groupColor(g))).size).toBeGreaterThan(1);
  });
  it('browsers.yaml colors.<group> wins when it is #RRGGBB; anything else falls back to the palette', () => {
    expect(groupColor('brain', { brain: '#00AA11' })).toBe('#00aa11');
    expect(groupColor('brain', { other: '#00aa11' })).toBe(groupColor('brain'));
    for (const bad of ['red', '#abc', 0x00aa11, { x: 1 }, null]) expect(groupColor('brain', { brain: bad })).toBe(groupColor('brain'));
  });
});

describe('stampGroupProfile — name and color into the profile, nothing else touched', () => {
  it('sets the Local State and Preferences keys Chrome 155 reads', () => {
    const dir = profile();
    const logs = [];
    stampGroupProfile({ userDataDir: dir, group: 'contoso-si', colors: { 'contoso-si': '#188038' }, log: (m) => logs.push(m) });
    const { ls, prefs } = read(dir);
    expect(ls.profile.info_cache.Default).toMatchObject({ name: 'contoso-si', is_using_default_name: false });
    expect(prefs.profile).toMatchObject({ name: 'contoso-si', using_default_name: false });
    expect(prefs.extensions.theme.id).toBe('user_color_theme_id');
    expect(prefs.browser.theme.user_color2).toBe(argbOf('#188038'));
    expect(prefs.browser.theme.user_color2).toBeLessThan(0);                 // signed SkColor, as Chrome stores it
    expect(logs).toEqual([`stamped "contoso-si" profile ${dir}: name "contoso-si", color #188038`]);
  });

  it('keeps everything else, numbers byte-for-byte (a double written as 1.0 stays 1.0)', () => {
    const dir = profile();
    stampGroupProfile({ userDataDir: dir, group: 'brain' });
    const { ls, prefs, lsText, prefsText } = read(dir);
    expect(lsText).toContain('"level":1.0');
    expect(lsText).toContain('"active_time":1792243422.086623');
    expect(prefsText).toContain('"zoom_level":0.0');
    const before = { ls: JSON.parse(LOCAL_STATE), prefs: JSON.parse(PREFERENCES) };
    Object.assign(before.ls.profile.info_cache.Default, { name: 'brain', is_using_default_name: false });
    Object.assign(before.prefs.profile, { name: 'brain', using_default_name: false });
    before.prefs.extensions = { theme: { id: 'user_color_theme_id' } };
    before.prefs.browser.theme = { user_color2: argbOf(groupColor('brain')) };
    expect(ls).toEqual(before.ls);
    expect(prefs).toEqual(before.prefs);
  });

  it('a profile already stamped is not rewritten, and no tmp file is left behind', () => {
    const dir = profile();
    stampGroupProfile({ userDataDir: dir, group: 'brain' });
    const first = read(dir);
    const logs = [];
    stampGroupProfile({ userDataDir: dir, group: 'brain', log: (m) => logs.push(m) });
    expect(read(dir).lsText).toBe(first.lsText);
    expect(read(dir).prefsText).toBe(first.prefsText);
    expect(logs).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.includes('egpt-tmp'))).toEqual([]);
    expect(readdirSync(join(dir, 'Default')).filter((f) => f.includes('egpt-tmp'))).toEqual([]);
  });

  it('a color change restamps only the color', () => {
    const dir = profile();
    stampGroupProfile({ userDataDir: dir, group: 'brain', colors: { brain: '#000001' } });
    stampGroupProfile({ userDataDir: dir, group: 'brain', colors: { brain: '#000002' } });
    expect(read(dir).prefs.browser.theme.user_color2).toBe(argbOf('#000002'));
  });

  it('a new profile (no files yet) is skipped and logged, nothing created, never throws', () => {
    const dir = join(tmpdir(), `egpt-identity-none-${process.pid}`);
    const logs = [];
    expect(() => stampGroupProfile({ userDataDir: dir, group: 'shared', log: (m) => logs.push(m) })).not.toThrow();
    expect(existsSync(dir)).toBe(false);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => /profile stamp skipped .*not there yet/.test(l))).toBe(true);
  });

  it('an unparsable file is skipped and left as is; the other one is still stamped', () => {
    const dir = profile({ localState: '{"profile": nope' });
    const logs = [];
    stampGroupProfile({ userDataDir: dir, group: 'shared', log: (m) => logs.push(m) });
    expect(readFileSync(join(dir, 'Local State'), 'utf8')).toBe('{"profile": nope');
    expect(JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8')).profile.name).toBe('shared');
    expect(logs.filter((l) => /profile stamp skipped .*Local State/.test(l))).toHaveLength(1);
  });

  it('a Local State with no Default profile entry is not invented', () => {
    const dir = profile({ localState: '{"profile":{"info_cache":{}}}' });
    const logs = [];
    stampGroupProfile({ userDataDir: dir, group: 'shared', log: (m) => logs.push(m) });
    expect(readFileSync(join(dir, 'Local State'), 'utf8')).toBe('{"profile":{"info_cache":{}}}');
    expect(logs.some((l) => /no profile\.info_cache\.Default/.test(l))).toBe(true);
  });

  it('a bad colors entry is named in the log and the palette color is used', () => {
    const dir = profile();
    const logs = [];
    stampGroupProfile({ userDataDir: dir, group: 'brain', colors: { brain: 'green' }, log: (m) => logs.push(m) });
    expect(logs[0]).toBe(`browsers.yaml colors.brain "green" is not "#RRGGBB"; using ${groupColor('brain')}`);
    expect(read(dir).prefs.browser.theme.user_color2).toBe(argbOf(groupColor('brain')));
  });
});

describe('readBrowserColors — browsers.yaml colors:, beside groups:', () => {
  it('reads the map; {} without one, and never mistakes groups: for colors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egpt-colors-'));
    dirs.push(dir);
    const path = join(dir, 'browsers.yaml');
    writeFileSync(path, 'groups:\n  brain: [ "eGPT Admin" ]\ncolors:\n  brain: "#1a73e8"\n');
    expect(await readBrowserColors({ path })).toEqual({ brain: '#1a73e8' });
    expect(await readBrowserGroups({ path })).toEqual({ brain: ['eGPT Admin'] });
    writeFileSync(path, 'groups:\n  brain: [ "eGPT Admin" ]\n');
    expect(await readBrowserColors({ path })).toEqual({});
    expect(await readBrowserColors({ path: join(dir, 'missing.yaml') })).toEqual({});
  });
});

describe('the launch path stamps the profile before the daemon starts its Chrome', () => {
  function build({ profileDir, holder = null, colors = {} }) {
    const launches = [];
    const logs = [];
    const chromeHost = {
      launch: async (o) => {
        launches.push({ ...o, nameAtLaunch: JSON.parse(readFileSync(join(o.profileDir, 'Local State'), 'utf8')).profile.info_cache.Default.name });
        return { pid: 42, channel: createPipeChannel({ writable: new PassThrough(), readable: new PassThrough() }) };
      },
      kill: () => {}, list: async () => [], onExit: () => {},
    };
    const cmds = createCommands({
      getConfig: () => ({ chrome: { profile_dir: profileDir } }),
      chromeHost, profileHolder: () => holder, browserColors: async () => colors,
      freeMem: () => Infinity, rssOf: () => null, onChromeLog: (m) => logs.push(m),
      send: async () => {}, sleep: async () => {}, brains: { resolve: (name) => ({ name, type: 'ccode' }) },
    });
    return { cmds, launches, logs };
  }

  it('name + browsers.yaml color are on disk when launch is sent, and the argv carries --window-name', async () => {
    const dir = profile();
    const { cmds, launches } = build({ profileDir: dir, colors: { brain: '#e52592' } });
    expect(await cmds.startBrowser()).toMatchObject({ ok: true, launched: true });
    expect(launches).toHaveLength(1);
    expect(launches[0].nameAtLaunch).toBe('brain');
    expect(launches[0].argv).toContain('--window-name=brain');
    expect(read(dir).prefs.browser.theme.user_color2).toBe(argbOf('#e52592'));
  });

  it('a profile another Chrome holds is neither stamped nor launched', async () => {
    const dir = profile();
    const { cmds, launches } = build({ profileDir: dir, holder: 'EBUSY' });
    expect((await cmds.startBrowser()).ok).toBe(false);
    expect(launches).toHaveLength(0);
    expect(read(dir).lsText).toBe(LOCAL_STATE);
    expect(read(dir).prefsText).toBe(PREFERENCES);
  });
});
