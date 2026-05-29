// slash/attach.mjs — attach a brain session in many shapes.
//
// Smart pre-flight: when /attach is invoked without prerequisites in
// place, set them up rather than bouncing the operator through 4-5
// commands. Lobby → auto-create+join a room named after the session
// arg; Chrome unreachable → auto-spawn; no matching tab → auto-open one.
//
// Five forms:
//   /attach                          rescan Chrome, attach any new matching tabs
//   /attach <url|uuid|tabId>         attach THAT tab — brain inferred from URL,
//                                    session auto-named (operator 2026-05-29:
//                                    'the tab already defines brain type, url')
//   /attach <profile>                start a YAML brain profile
//   /attach <brain>                  attach all CDP tabs or create a local session
//   /attach <brain> <name> [tabSpec] explicit attach to one specific tab

import * as cdp from '../src/tools/cdp.mjs';

export const meta = {
  cmd: '/attach',
  section: 'SESSIONS',
  surface: 'both',
  usage: '/attach [brain|profile] [name] [tab]',
  desc: 'attach CDP tab, brain profile, or rescan',
};

export async function run({ arg, ctx }) {
  // ctx keys consumed:
  //   sysOut
  //   sessions / setSessions                — shadowed below for lobby auto-room
  //   roomSessionsMap / setRoomSessionsMap
  //   getCurrentRoom / setCurrentRoom
  //   setActiveSessions
  //   canonicalBrainName / brainForName / brainForUrl
  //   brainNamesForHelp / profileDirsText
  //   isInternalUrl
  //   nextName / nextEmoji
  //   loadBrainProfile / attachProfile
  //   resolveTabId
  //   spawnChromeWithExtension
  const { sysOut,
          sessions: roomSessions, setSessions: setRoomSessions,
          roomSessionsMap, setRoomSessionsMap,
          getCurrentRoom, setCurrentRoom, setActiveSessions,
          canonicalBrainName, brainForName, brainForUrl,
          brainNamesForHelp, profileDirsText, isInternalUrl,
          nextName, nextEmoji,
          loadBrainProfile, attachProfile,
          resolveTabId, spawnChromeWithExtension } = ctx;

  let targetRoom = getCurrentRoom();
  if (targetRoom === 'default') {
    const lobbyParts = arg.split(/\s+/).filter(Boolean);
    const lobbyBrain = canonicalBrainName(lobbyParts[0]);
    const lobbySessName = lobbyParts[1] && brainForName(lobbyBrain) ? lobbyParts[1] : null;
    const autoRoomName = lobbySessName || lobbyBrain || 'work';
    const otherRooms = Object.keys(roomSessionsMap).filter(r => r !== 'default' && r !== autoRoomName);
    if (otherRooms.length) {
      const list = otherRooms.map(r => {
        const sess = roomSessionsMap[r] ?? {};
        const members = Object.entries(sess).map(([n, s]) => `${s.emoji ?? ''}${n}/${s.brain}`).join(', ') || '(empty)';
        return `  · ${r}  (${members})`;
      }).join('\n');
      sysOut(`other rooms available — /attach <brain> auto-creates a room, or use the legacy /save-room/<load> flow to resume one with its sessions:\n${list}`);
    }
    if (!roomSessionsMap[autoRoomName]) {
      setRoomSessionsMap(rs => ({ ...rs, [autoRoomName]: {} }));
      sysOut(`auto-created room "${autoRoomName}"`);
    }
    setCurrentRoom(autoRoomName);
    setActiveSessions([]);
    sysOut(`joined room "${autoRoomName}" — continuing /attach`);
    targetRoom = autoRoomName;
  }

  // Shadow sessions/setSessions to write into targetRoom — setCurrentRoom
  // above takes effect next render, but the rest of /attach runs RIGHT NOW.
  // Without the shadow, attach writes still go to the lobby.
  const sessions = roomSessionsMap[targetRoom] ?? {};
  const setSessions = (updater) => {
    setRoomSessionsMap(rs => {
      const cur = rs[targetRoom] ?? {};
      const next = typeof updater === 'function' ? updater(cur) : updater;
      return { ...rs, [targetRoom]: next };
    });
  };

  // Auto-spawn Chrome when the targeted brain needs CDP and Chrome
  // isn't reachable. Heavy but unavoidable forward path.
  const wantsCdp = brainForName(canonicalBrainName(arg.split(/\s+/)[0]))?.urlMatch != null;
  if (wantsCdp && !(await cdp.isRunning())) {
    sysOut('chrome not reachable — starting it with the extension…');
    try { await spawnChromeWithExtension(); }
    catch (e) { sysOut(`!! chrome start failed: ${e.message}`); return true; }
  }

  const parts = arg.split(/\s+/).filter(Boolean);

  // Form 1: no args — rescan, attach all unattached matching tabs.
  if (parts.length === 0) {
    try {
      const tabs = await cdp.listTabs();
      let working = { ...sessions };
      const additions = {};
      for (const tab of tabs) {
        if (isInternalUrl(tab.url)) continue;
        const brainName = brainForUrl(tab.url);
        if (!brainName) continue;
        if (Object.values(working).some(s => s.options?.targetId === tab.id)) continue;
        const name = nextName(brainName, working);
        const emoji = nextEmoji(working);
        additions[name] = { brain: brainName, options: { targetId: tab.id }, emoji };
        working[name] = additions[name];
      }
      if (Object.keys(additions).length === 0) {
        sysOut('no new tabs to attach (everything matching is already a session)');
      } else {
        setSessions(s => ({ ...s, ...additions }));
        sysOut(`attached: ${Object.entries(additions).map(([n, s]) => `${s.emoji} ${n} (${s.brain})`).join(', ')}`);
      }
    } catch (e) { sysOut(`!! ${e.message}`); }
    return true;
  }

  // Profile form: /attach <profile> [session-name-override].
  const profileCandidate = parts[0];
  const profileNameOverride = parts.length === 2 && !brainForName(canonicalBrainName(parts[0])) ? parts[1] : null;
  if (parts.length <= 2) {
    try {
      const profile = await loadBrainProfile(profileCandidate);
      if (profile) {
        await attachProfile(profile, profileNameOverride || undefined);
        return true;
      }
    } catch (e) {
      sysOut(`!! profile "${profileCandidate}": ${e.message}`);
      return true;
    }
  }

  // Brain forms.
  const brainName = canonicalBrainName(parts[0]);
  const brain = brainForName(brainName);
  if (!brain) {
    // Form 2 (URL/uuid/tabId): the operator passed a tab spec directly. The
    // tab itself already defines its URL and (via brainForUrl) its brain, so
    // brain + name are inferred — no need to type them. Operator 2026-05-29:
    // "[tabspec] after defining brain... makes no sense, since the tab
    // already defines brain type, url, etc."
    if (parts.length === 1 && parts[0].length >= 6) {
      try {
        const tid = await resolveTabId(parts[0]);
        if (tid) {
          const tabs = await cdp.listTabs();
          const tab = tabs.find(t => t.id === tid);
          if (tab) {
            const inferredBrain = brainForUrl(tab.url);
            if (!inferredBrain) {
              sysOut(`!! tab matched but no brain recognizes its URL: ${tab.url}`);
              return true;
            }
            const existing = Object.entries(sessions).find(([_, s]) => s.options?.targetId === tid);
            if (existing) {
              sysOut(`tab already attached as ${existing[1].emoji ?? ''}${existing[0]} (${existing[1].brain})`);
              return true;
            }
            const name = nextName(inferredBrain, sessions);
            const emoji = nextEmoji(sessions);
            setSessions(s => ({ ...s, [name]: { brain: inferredBrain, options: { targetId: tid }, emoji } }));
            sysOut(`session "${name}" -> ${emoji} ${inferredBrain} (tab ${tid.slice(0, 8)}…, ${tab.title || tab.url.slice(0, 60)})\n  address it as @${name} for a single-recipient turn`);
            return true;
          }
        }
      } catch (e) { /* fall through to usage */ }
    }
    sysOut(
      'usage: /attach                          rescan and attach new tabs\n' +
      '       /attach <url|uuid|tabId>         attach THAT tab; brain + name inferred\n' +
      '       /attach <profile>                start a YAML brain profile\n' +
      '       /attach <brain>                  attach CDP tabs or create a local session\n' +
      '       /attach <brain> <name> [tabSpec] explicit attach\n' +
      'brains: ' + brainNamesForHelp().join(', ') +
      '\nprofile dirs:\n' + profileDirsText()
    );
    return true;
  }
  const sessionName = parts[1];
  const tabSpec = parts.slice(2).join(' ').trim();

  // Form 3: brain only. CDP brains attach all unattached tabs;
  // local brains create one auto-named session in the current cwd.
  if (!sessionName) {
    if (!brain.urlMatch) {
      const name = nextName(brainName, sessions);
      const emoji = nextEmoji(sessions);
      const options = { cwd: process.cwd() };
      setSessions(s => ({ ...s, [name]: { brain: brainName, options, emoji } }));
      sysOut(`session "${name}" -> ${emoji} ${brainName}` +
        `\n  cwd: ${options.cwd}` +
        `\n  address it as @${name} for a single-recipient turn`);
      return true;
    }
    try {
      const matching = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
      let working = { ...sessions };
      const additions = {};
      for (const tab of matching) {
        if (Object.values(working).some(s => s.options?.targetId === tab.id)) continue;
        const name = nextName(brainName, working);
        const emoji = nextEmoji(working);
        additions[name] = { brain: brainName, options: { targetId: tab.id }, emoji };
        working[name] = additions[name];
      }
      if (Object.keys(additions).length === 0) {
        sysOut(`no new ${brainName} tabs to attach`);
      } else {
        setSessions(s => ({ ...s, ...additions }));
        sysOut(`attached: ${Object.keys(additions).join(', ')}`);
      }
    } catch (e) { sysOut(`!! ${e.message}`); }
    return true;
  }

  // Form 2: explicit.
  if (sessions[sessionName]) { sysOut(`session "${sessionName}" already exists`); return true; }
  const options = {};
  if (brain.urlMatch) {
    try {
      if (tabSpec) {
        const tid = await resolveTabId(tabSpec, brain);
        if (!tid) { sysOut(`could not resolve "${tabSpec}" to a tab. /tabs to see open tabs.`); return true; }
        options.targetId = tid;
      } else {
        let tabs = (await cdp.listTabs()).filter(t => brain.urlMatch.test(t.url));
        if (tabs.length === 0 && brain.homeUrl) {
          // Auto-open: cheap, expected next step. Without this the
          // operator gets bounced to /open then back to /attach.
          sysOut(`no ${brainName} tab open — opening ${brain.homeUrl}…`);
          try {
            const tid = await cdp.openTab(brain.homeUrl);
            options.targetId = tid;
          } catch (e) { sysOut(`!! could not open ${brainName} tab: ${e.message}`); return true; }
          tabs = [];
        }
        if (tabs.length === 0 && !options.targetId) {
          sysOut(`no open ${brainName} tabs to attach. try /open ${brainName} to open one.`);
          return true;
        }
        if (tabs.length > 1) {
          const lst = tabs.map(t => `  "${t.title}" — ${t.url}`).join('\n');
          sysOut(`multiple ${brainName} tabs open. specify which:\n${lst}\nuse: /attach ${brainName} ${sessionName} <urlOrUuidOrId>`);
          return true;
        }
        if (tabs.length === 1) options.targetId = tabs[0].id;
      }
    } catch (e) { sysOut(`!! ${e.message}`); return true; }
  }

  const emoji = nextEmoji(sessions);
  setSessions(s => ({ ...s, [sessionName]: { brain: brainName, options, emoji } }));
  sysOut(`session "${sessionName}" -> ${emoji} ${brainName}` +
    (options.targetId ? ` (tab ${options.targetId.slice(0, 8)}...)` : '') +
    `\n  address it as @${sessionName} for a single-recipient turn`);
  return true;
}
