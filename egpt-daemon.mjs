#!/usr/bin/env node
// egpt-daemon.mjs - keeps `node egpt-spine.mjs` running, for every profile this
// SESSION supervises.
//
// The supervisor implementation lives in src/daemon-runtime.mjs so tests can
// run it with fake spawn/fs/timers instead of launching the real product.
//
// ONE PROFILE by default (EGPT_HOME), which is exactly what it always did. Set
// EGPT_HOMES to a ';'-separated list and this one process supervises all of them
// - the supervision axis is the SESSION, not the account (operator 2026-09-11),
// so the session 0 service carries every session 0 profile instead of there
// being one service per account:
//
//   EGPT_HOMES=C:\Users\an\.egpt;C:\Users\an\.egpt-secondary
//
// EGPT_SESSION1=1 marks this daemon (and the spines it spawns) as the SESSION 1
// one, which is what keeps its singleton apart from the service's.

import { startProfileDaemons } from './src/daemon-runtime.mjs';

startProfileDaemons();
