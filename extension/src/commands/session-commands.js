// extension/src/commands/session-commands.js — pure command handlers
// for the session-management slash commands. Same DI pattern as
// wa-commands.js: each handler takes (rest, ctx); the React layer in
// App.jsx wires ctx to the live refs/storage/chrome APIs.
//
// Commands: /use, /sessions, /detach, /tabs, /open, /attach.
//
// ctx contract (per command, only the relevant fields matter):
//   log(text), error(text)        user-visible egpt messages
//   getSessions()                 → Map of attached sessions (name → {brain, targetId})
//   setSession(name, value)       set a session entry (or delete when value=null)
//   syncSessionsList()            notify React state of the change
//   getActiveSessions()           → array of currently /use'd session names
//   setActiveSessions(arr)        replace the active session list
//   getPeerNodes()                → Map of peer nodes (for /sessions cross-node listing)
//   listTabs()                    → CDP tab list (mock-friendly)
//   createTab({url, active})      → chrome.tabs.create wrapper
//   waitForTabLoad(id)            → resolves when tab is loaded
//   nextSessionName(brainType)    → unique session name picker
//   canonicalBrain(rawType)       → BRAINS-canonicalized type
//   brains                        → BRAINS map (type → {name, urlMatch, homeUrl})
//   resolveTabSpec(spec, brain)   → CDP id (for /attach <type> <name> <spec>)
//   sleep(ms)                     → mock-friendly setTimeout wrapper

export async function use(rest, ctx) {
  const { getActiveSessions, setActiveSessions, getSessions, log, error } = ctx;
  const target = (rest ?? '').trim();
  if (!target) {
    const active = getActiveSessions();
    log(active.length
      ? `active sessions: ${active.join(', ')}`
      : 'no active sessions — /use <name> or /use a,b,c for multi-AI broadcast');
    return;
  }
  if (target === 'clear' || target === 'none') {
    setActiveSessions([]);
    log('active sessions cleared');
    return;
  }
  const names = target.split(',').map(s => s.trim()).filter(Boolean);
  const sessions = getSessions();
  const unknown = names.filter(n => !sessions.has(n));
  if (unknown.length) {
    error(`unknown session(s): ${unknown.join(', ')}`);
    return;
  }
  setActiveSessions(names);
  log(names.length === 1
    ? `Active session → ${names[0]}`
    : `Active sessions → ${names.join(', ')} (multi-AI broadcast)`);
}

export async function sessions(_rest, ctx) {
  const { getSessions, getPeerNodes, log } = ctx;
  const list = [...getSessions().entries()];
  const localBlock = list.length === 0
    ? '(no local sessions)'
    : list.map(([n, s]) => `  ${n}  ${s.brain.name}  tab:${s.targetId}`).join('\n');
  const peerLines = [];
  for (const [nodeId, peer] of getPeerNodes()) {
    const head = `~ ${nodeId}  (${peer.role ?? 'node'})${peer.polling ? '  [polling]' : ''}`;
    peerLines.push(head);
    for (const sess of peer.sessions ?? []) {
      peerLines.push(`    ${(sess.name ?? '?').padEnd(14)}${sess.brain ?? '?'}`);
    }
  }
  const peerBlock = peerLines.length
    ? `\n\n── peers (zombie sessions) ───────────────────\n${peerLines.join('\n')}`
    : '';
  log(localBlock + peerBlock);
}

export async function detach(rest, ctx) {
  const { setSession, syncSessionsList, getActiveSessions, setActiveSessions, log } = ctx;
  const name = (rest ?? '').trim().split(/\s+/)[0];
  if (!name) { log('Usage: /detach <name>'); return; }
  setSession(name, null);
  syncSessionsList();
  const active = getActiveSessions();
  if (active.includes(name)) setActiveSessions(active.filter(x => x !== name));
  log(`Detached ${name}`);
}

export async function tabs(_rest, ctx) {
  const { listTabs, log } = ctx;
  const all = await listTabs();
  if (all.length === 0) { log('No open tabs found.'); return; }
  log(all.map(t => `  ${t.id}  ${(t.url ?? '').slice(0, 70)}`).join('\n'));
}

export async function open(rest, ctx) {
  const {
    log, error, brains, canonicalBrain, nextSessionName,
    getSessions, setSession, syncSessionsList,
    listTabs, createTab, waitForTabLoad, sleep,
  } = ctx;
  const parts = (rest ?? '').trim().split(/\s+/).filter(Boolean);
  const [rawType, customName] = parts;
  if (!rawType) {
    log(`Usage: /open <brain> [name]\nBrains: ${Object.keys(brains).join('  ')}`);
    return;
  }
  const brainType = canonicalBrain(rawType);
  const brain = brains[brainType];
  if (!brain || !brain.homeUrl) {
    log(`Unknown brain type "${rawType}". Available: ${Object.keys(brains).join('  ')}`);
    return;
  }
  const name = customName || nextSessionName(brainType);
  if (getSessions().has(name)) {
    log(`Session "${name}" already exists.`);
    return;
  }
  log(`Opening ${brain.homeUrl}…`);
  try {
    // CDP target ids and chrome.tabs ids don't intersect — snapshot
    // CDP targets matching this brain before/after the open and pick
    // the new one. Poll up to ~2s for CDP to register the new target.
    const beforeIds = new Set((await listTabs(brain.urlMatch)).map(t => t.id));
    const tab = await createTab({ url: brain.homeUrl, active: false });
    log('Waiting for tab to load…');
    await waitForTabLoad(tab.id);
    let cdpId = null;
    for (let i = 0; i < 10; i++) {
      const after = await listTabs(brain.urlMatch);
      const newOne = after.find(t => !beforeIds.has(t.id));
      if (newOne) { cdpId = newOne.id; break; }
      await sleep(200);
    }
    if (!cdpId) {
      log('/open: opened the tab, but couldn\'t locate its CDP target — try /attach');
      return;
    }
    setSession(name, { brain, targetId: cdpId });
    syncSessionsList();
    log(`Ready: ${name} → ${brainType} (target ${String(cdpId).slice(0, 8)}…). /use ${name} to make it the default for plain text.`);
  } catch (e) {
    log(`/open failed: ${e?.message ?? e}`);
  }
}

export async function attach(rest, ctx) {
  const {
    log, brains, canonicalBrain, nextSessionName,
    getSessions, setSession, syncSessionsList,
    listTabs, resolveTabSpec,
  } = ctx;
  const args = (rest ?? '').trim().split(/\s+/).filter(Boolean);

  // Zero-arg: rescan all tabs, attach any matching that isn't already a session
  if (args.length === 0) {
    const all = await listTabs();
    const additions = [];
    for (const tab of all) {
      const matchedType = Object.keys(brains).find(k => brains[k].urlMatch?.test(tab.url));
      if (!matchedType) continue;
      const sessions = getSessions();
      const taken = [...sessions.values()].some(s => s.targetId === tab.id);
      if (taken) continue;
      const name = nextSessionName(matchedType);
      setSession(name, { brain: brains[matchedType], targetId: tab.id });
      additions.push(`${name} (${matchedType})`);
    }
    if (!additions.length) log('No new tabs to attach.');
    else {
      syncSessionsList();
      log(`Attached: ${additions.join(', ')}. /use <name> to route plain text to one.`);
    }
    return;
  }

  const [rawType, customName, ...tabSpecParts] = args;
  const brainType = canonicalBrain(rawType);
  const brain = brains[brainType];
  if (!brain) {
    log(`Unknown brain type "${rawType}". Available: ${Object.keys(brains).join('  ')}`);
    return;
  }
  const tabSpec = tabSpecParts.join(' ').trim();
  let targetId = null;
  if (tabSpec) {
    targetId = await resolveTabSpec(tabSpec, brain);
    if (!targetId) {
      log(`Could not resolve "${tabSpec}" to a tab. /tabs to list.`);
      return;
    }
  } else {
    const matchTabs = (await listTabs()).filter(t => brain.urlMatch?.test(t.url));
    if (matchTabs.length === 0) {
      log(`No open ${brainType} tabs. /open ${brainType} to create one.`);
      return;
    }
    if (matchTabs.length > 1) {
      const lst = matchTabs.map(t => `  ${t.id}  ${(t.title ?? '').slice(0, 50)}`).join('\n');
      log(`Multiple ${brainType} tabs open. Specify tab ID:\n${lst}`);
      return;
    }
    targetId = matchTabs[0].id;
  }
  const name = customName || nextSessionName(brainType);
  if (getSessions().has(name)) {
    log(`Session "${name}" already exists.`);
    return;
  }
  setSession(name, { brain, targetId });
  syncSessionsList();
  log(`Attached ${name} → ${brainType} (tab ${targetId}). /use ${name} to make it the default for plain text.`);
}
