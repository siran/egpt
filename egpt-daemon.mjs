#!/usr/bin/env node
// egpt-daemon.mjs - keeps `node egpt-spine.mjs` running.
//
// The supervisor implementation lives in src/daemon-runtime.mjs so tests can
// run it with fake spawn/fs/timers instead of launching the real product.

import { createDaemonRuntime } from './src/daemon-runtime.mjs';

createDaemonRuntime().start();
