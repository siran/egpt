export function createTelegramBootScheduler({
  startTgBridge,
  isBridgeRunning = () => false,
  getPeers = () => [],
  getBusTargetId = () => null,
  postEvent = async () => {},
  nodeId = 'node',
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = () => {},
} = {}) {
  if (typeof startTgBridge !== 'function') {
    throw new Error('createTelegramBootScheduler: startTgBridge required');
  }

  let bootAttempted = false;
  let bootTimer = null;

  const cancelBootAttempt = () => {
    if (bootTimer) {
      clearTimeoutFn(bootTimer);
      bootTimer = null;
    }
  };

  const scheduleBootAttempt = () => {
    if (bootAttempted || isBridgeRunning()) return;
    cancelBootAttempt();
    bootTimer = setTimeoutFn(() => {
      bootTimer = null;
      if (bootAttempted || isBridgeRunning()) return;
      bootAttempted = true;
      const peers = [...getPeers()];
      const otherShellPolling = peers.some((p) => p.polling && p.role !== 'chrome');
      if (otherShellPolling) return;
      const chromePolling = peers.some((p) => p.polling && p.role === 'chrome');
      if (chromePolling) {
        const tid = getBusTargetId();
        if (tid) {
          Promise.resolve(postEvent(tid, {
            type: 'telegram-handoff',
            from: nodeId,
            ts: Date.now(),
            to: nodeId,
          })).catch((e) => log(`!! telegram-handoff post failed: ${e?.message ?? e}`));
          setTimeoutFn(() => {
            if (!isBridgeRunning()) startTgBridge();
          }, 1500);
          return;
        }
      }
      startTgBridge();
    }, 2000);
  };

  return {
    cancelBootAttempt,
    scheduleBootAttempt,
    isBootAttempted: () => bootAttempted,
    markBootAttempted: () => { bootAttempted = true; },
    resetBootAttempt: () => { bootAttempted = false; },
  };
}
