#!/usr/bin/env node
// setup/global-read-paths.mjs — this node's config.yaml `global_read_paths`, as JSON, for
// provision-sandbox-account.ps1 (through Get-SandboxGlobalReadPaths in sandbox-account.ps1).
//
// PowerShell cannot parse YAML, and a second reading of the key there would be a second thing to
// keep in agreement with the spine's. So the provisioner asks node, and node answers with the ONE
// reading: config-io's readConfigSync (EGPT_HOME, default ~/.egpt) and brainpool.mjs's
// globalReadPathsOf - the same function that builds every sandboxed turn's -ReadMounts, so the
// folder the provisioner grants is the folder the launcher mounts.
//
// Prints ONE line of JSON on stdout and nothing else:
//   { "mounts": [ { "name": "repos", "path": "C:/Users/an/src/siran" } ], "skipped": [ "<why>" ] }
// ONLY this key. config.yaml holds credentials (sandbox_oauth_token, beeper_token); nothing else
// in it is read out here. `skipped` names each invalid entry, for the provisioner to print.
import { readConfigSync } from '../src/tools/config-io.mjs';
import { globalReadPathsOf } from '../src/spine/brainpool.mjs';

const skipped = [];
const mounts = globalReadPathsOf(readConfigSync().global_read_paths, (line) => skipped.push(line));
process.stdout.write(`${JSON.stringify({ mounts, skipped })}\n`);
