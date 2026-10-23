# EDW step 0 — Linux inventory of eGPT (read-only)

Repo `C:\Users\an\src\egpt` @ `472eadf`, 2026-10-23. Static reading only: nothing was run on Linux, nothing in the repo or `~/.egpt` was touched.
Legend: **works** = the POSIX branch exists and looks correct · **degrades** = runs with less information or function · **refuses** = throws or declines loudly · **breaks** = wrong path or ENOENT · *unverified* = my inference, not measured.

Already in the repo: `tests/integrity.test.mjs:181-196` scans `src/**` (except `src/tools/**`) for Windows literals. Its `KNOWN_PLATFORM_DEBT` list (`:231-250`) is the place where known debt is recorded.

---

## 1. `src/`: platform branches and Windows-only calls

### 1a. The 18 files named in the brief (all confirmed) + others found

| file:line | Windows does | Off Windows today | Linux needs |
|---|---|---|---|
| `sandbox-cli-session.mjs:259-262` | allows the boxed session | **refuses**: "OS-level sandboxing is Windows-only" | the Linux box behind the same guard |
| `sandbox-cli-session.mjs:431-440` (`sandboxSpawn`) | `_spawn('powershell.exe', launcherArgv(...))` | not reached (guard above) | THE spawn seam (see §3) |
| `sandbox-cli-session.mjs:471-484` (`launcherArgv`) | builds the PS argv (JSON-array params) | n/a | the Linux launcher's argv contract |
| `sandbox-cli-session.mjs:542-543` (`spawnBoxedCommand`) | heartbeat command in the box via PS | **refuses** | same seam as above, for beats |
| `sandbox-cli-session.mjs:171-178,185-194` | `CLAUDE_CODE_GIT_BASH_PATH`, `MSYS2_PATH_TYPE`, msys64/Git-bash candidates | n/a | not emitted on Linux (`/bin/bash` is native) |
| `sandbox-cli-session.mjs:92-108` | thread store `~/.egpt-jsonl/<thread>` (`homedir()`) | works | `$HOME` must be on the volume, or the store is lost when the container is recreated (*unverified* for the plan's layout) |
| `sandbox-cli-session.mjs:200-212` | remedy text says `powershell … upgrade.ps1` | cosmetic | text only |
| `spine/brainpool.mjs:658-662` (`resolveSandboxedRung`) | rung 4 default `platform==='win32'` → boxed | rung 4 → **false** (unboxed, CLI-confined) | true once the Linux box exists |
| `spine/brainpool.mjs:858` | default `access_level` = `'sandbox'` → rung 1 forces the box | **every being without an explicit level is refused** at session creation (via the guard above) | until step 4: `access_level: regular` (or `all`) on each Linux being — matches plan step 3 |
| `spine/brainpool.mjs:494-514` (`globalReadPathsOf`) | accepts `C:/…` or `/c/…` | **breaks**: `:509` requires a drive letter, so every POSIX path is skipped with a log line | accept absolute POSIX paths (step 4) |
| `spine/brainpool.mjs:55-59`, `warm-cli-session.mjs:99-103`, `codex-cli-session.mjs:11-15` (`normalizeCwd`) | `/c/x` → `C:/x` | applied on every OS: a POSIX path with a one-letter top-level dir (`/d/data`) is rewritten to `D:/data` | gate it on win32, or never mount at a one-letter top-level path |
| `spine/heartbeat-loader.mjs:682-686,1072` | command beats run under msys bash, cmd fallback | **works**: `shell: true` = `/bin/sh` | nothing |
| `spine/lag-probe.mjs:54-58` | `typeperf` | works: `ps -Ao pcpu=,comm=` | `procps` in the image |
| `spine/lag-probe.mjs:61-62` (`sleptBetween`) | `wevtutil` standby check | returns false | nothing |
| `spine/commands.mjs:85-96` (`defaultRssOf`) | `tasklist` | works: `ps -o rss=` | `procps` |
| `spine/commands.mjs:569` (`inSession0`) | supervised and not S1 → "nobody logged in" | in a container: `EGPT_SUPERVISED=1` and no `EGPT_SESSION1` → true | set `EGPT_SESSION1=1` (see daemon-runtime) |
| `spine/commands.mjs:1151,1176` | no chrome-host → no browser | same | chrome-host must exist (below) |
| `daemon-runtime.mjs:63,151` | chrome-host is loaded **only** when `EGPT_SESSION1=1` | without that env: **no browser at all** | the entrypoint sets `EGPT_SESSION1=1` (env only) |
| `daemon-runtime.mjs:67,152` | cli-host in every session | works | nothing |
| `daemon-runtime.mjs:82-97` | lowercases profile keys | case kept | nothing |
| `daemon-runtime.mjs:932` | no SIGHUP | adds SIGHUP | nothing |
| `daemon-runtime.mjs:439,447,488,754` | `git pull --ff-only`, `npm install` (shell), `spawn('node')` | works if git, npm and node are on PATH | git remote credentials in the container for `/upgrade` |
| `daemon-runtime.mjs:700` | log hint says `taskkill /PID …` | cosmetic | text only |
| `daemon-singleton.mjs:24-46` | `UV_FS_O_EXLOCK` share-none open = a real lock (`runner.lock`, `s1.claim`) | **degrades**: no EXLOCK, so `openExclusive` never returns null and `heldExclusive` is always false. Cross-daemon locks are **no-ops**; only the `spine.pid` + `alive.txt` check remains | acceptable while one container = one daemon; a real POSIX lock (flock-equivalent) otherwise |
| `daemon-singleton.mjs:78-89` | `tasklist` fallback for cross-session ESRCH | `process.kill(pid,0)` only | nothing |
| `tools/reap-port.mjs:22,41-58` | `netstat -ano` | works: `lsof -nP -iTCP:<p> -sTCP:LISTEN -t` | `lsof` in the image (absent → empty list, "could not name") |
| `tools/reap-port.mjs:65-75,82-92` | `tasklist` / PS CIM | works: `ps -p … -o comm=/args=` | `procps` |
| `tools/reap-port.mjs:208-210` (`processService`) | asks which Windows service owns a pid | returns null | nothing |
| `tools/reap-port.mjs:225-227` (`killPid`) | `taskkill /F /T` (tree) | `kill -9 <pid>` (**that pid only, not its tree**) | an init (tini) to reap orphans |
| `tools/whisper-server.mjs:63` (`whisperServiceFor`) | registry scan for an nssm whisper service | null | nothing |
| `tools/whisper-server.mjs:31-33` (`isStrayWhisperServer`) | kills a stray only when `service===false` | service is always null → a stray is **never** killed (it is adopted if it answers) | nothing (*unverified* edge: a wedged stray holding the port blocks the spawn) |
| `tools/chrome-launcher.mjs:11-33` | `Program Files` chrome.exe | **works**: scans `/usr/bin/google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser`, `/snap/bin/chromium`; config `chrome.bin` overrides (`commands.mjs:127`) | Chrome at one of those paths |
| `tools/chrome-launcher.mjs:220-229` (`profileHolder`) | opens `lockfile` | works: `SingletonLock` → pid | nothing |
| `tools/chrome-launcher.mjs:231-239` (`chromeProcesses`) | PS CIM | works: `ps -eo pid=,args=` | `procps` |
| `tools/chrome-launcher.mjs:241-243` (`killProcessTree`) | `taskkill /T /F` | SIGKILL to one pid | tini; whether Chrome's children survive is *unverified* |
| `tools/chrome-launcher.mjs:141-157` (`chromePipeArgs`) | fixed argv | same | no `DISPLAY` handling anywhere in `src/` (grep: none) — Chrome inherits the daemon's env (`chrome-host.mjs:63`). There is no config hook to add `--no-sandbox` / `--disable-dev-shm-usage`; chrome-host's `refusal()` (`chrome-host.mjs:44-54`) would accept extra args |
| `tools/chrome-creds.mjs:89-95` | DPAPI decrypt of Chrome's key via `powershell.exe` | **breaks**: `/login` saved-password read → ENOENT | Linux Chrome stores passwords via libsecret/kwallet, or "basic" (v10/v11 with a fixed or keyring key) — *unverified* which one under Xvfb |
| `tools/beeper-update.mjs:21-35` | `auto_update.windows.method`, default manual | linux/mac: anything but `none` → forced `none` + one boot note | nothing for step 1 |
| `tools/beeper-update.mjs:72-77,80,105` | `reg query` for the version, `LOCALAPPDATA` pending update, feed `platform: 'win32'` hardcoded | version null, pending null | n/a until updates exist |
| `tools/beeper-update.mjs:177-191,303` | runs `beeper-update.ps1` | `/update beeper` **refuses** ("not implemented on linux yet") | a Linux update path (later) |
| `tools/beeper-whoami.mjs:106-122` (`localOwners`) | PS `Get-NetTCPConnection` → pid/session/image | **degrades**: empty Map; rows show `-` (`:446`) | nothing |
| `spine/synthesizer-worker.mjs:59-72` | `RADIO_PIPER/venv/Scripts/python.exe` | **breaks**: POSIX venv is `venv/bin/python`. Already listed in `KNOWN_PLATFORM_DEBT` (`integrity.test.mjs:233-236`) | per-platform venv layout |
| `warm-cli-session.mjs:257-264` | `~/.local/bin/claude.exe` | **works**: `~/.local/bin/claude`, else PATH; `EGPT_CLAUDE_BIN` / config `bin` override | nothing |
| `codex-cli-session.mjs:18-31` | `%APPDATA%\npm\…\codex.js` | **works**: `~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js`, else PATH `codex` | nothing |
| `pi-cli-session.mjs:85-95` | `%APPDATA%\npm\…` | **works**: `~/.npm-global/…`, else PATH `pi` | nothing |
| `claude-args.mjs` (no platform branch; `:147,:214` comments) | `osConfined` → `--dangerously-skip-permissions` | non-boxed → `--setting-sources ''` + `--permission-mode default` + `--add-dir` confinement | nothing; follows `sandboxed` |
| `spine/being-link.mjs:60-62` (`askSpineClientPath`) | `~\src\egpt\src\tools\ask-spine.mjs` | same: **assumes the checkout is at `$HOME/src/egpt`** (it is also the launcher's `$repoRoot`, `sandbox-logon-launcher.ps1:1617`) | put the checkout at `$HOME/src/egpt` in the image, or the being's `EGPT_ASK_SPINE`/`EGPT_CDP` point at nothing |
| `spine/being-link.mjs:80-84` | case-folded compare; drive-letter path test | works: POSIX `/` test | nothing |
| `tools/ask-spine.mjs:120` | case-folds argv[1] | works | nothing |
| `tools/transcribe.mjs:121-131` | manual CLI with hardcoded `C:\…` ffmpeg/whisper/model | manual CLI only, unusable as-is | not in the runtime path |
| `video-frames.mjs:16-17` | ffprobe from `ffmpeg(.exe)` | works | nothing |
| `process-priority.mjs:15-18` | BELOW_NORMAL on children | works for own-uid children; `setpriority` on **another uid's** process needs CAP_SYS_NICE (*known Linux rule*) → logged EPERM for per-conversation users | nothing (best-effort) |
| `cli-host.mjs:74`, `warm-cli-session.mjs:333` | `windowsHide` | ignored | nothing |
| `conversations-state.mjs:231-235,252` | msys path rendering | identity on POSIX | nothing |
| `egpt-spine.mjs:21` | SIGTERM handler | works (`docker stop`) | nothing |
| `migrations/0001,0002,0004,0005,0039,0043,0048` | scheduled-task/service fixes | `ctx.platform !== 'win32'` → satisfied with a note | nothing |
| `setup/migrate.mjs:125-127` (`isElevated`) | PS admin check | `getuid()===0` | nothing |

### 1b. Spine facts that matter for the container
- Beeper bridge is pure HTTP/WS on `127.0.0.1:23373…23382` (`bridges/beeper.mjs:516-517`, `spine/boot.mjs:1838,1867`). The spine never launches Beeper; that is the setup layer's job.
- Node ≥22 (`package.json` engines); `/login` uses `node:sqlite` (`tools/chrome-creds.mjs:98-103`), and this host runs v24.13.1.
- `node_modules` on reve holds win32 natives (`@esbuild/win32-x64`, `@rolldown/binding-win32-x64-msvc`, `lightningcss-win32-x64-msvc`). The image must run `npm ci` on Linux and never copy `node_modules` from reve.
- Boot is fatal without `agents:` (`boot.mjs:1001`) or `node_name` (`:1033`), or when `node_name` is not in `transcription_service.echo.peer_priority` (`:1043`).

---

## 2. `setup/`

### 2a. Scripts and whether a container node needs a Linux equivalent

| Script(s) | Job | Container needs |
|---|---|---|
| `install-nssm-service.*`, `uninstall-nssm-service.*`, `bin/egpt-service.exe` | Session 0 runner (nssm) | **yes, as the entrypoint**: PID-1 init (tini) → `node egpt-daemon.mjs` with `EGPT_HOME`, `EGPT_SESSION1=1`, `DISPLAY` |
| `register-session1-daemon-task.ps1`, `session1-daemon-launcher.vbs`, `egpt-daemon-task-labels.ps1`, `egpt-runners.ps1`, `register-startup.ps1`, `startup-supervisor.ps1` | S1 logon task / older supervisors | no (the entrypoint replaces them) |
| `install-beeper-s0-service.ps1`, `beeper-s0-naming.ps1`, `rename-beeper-s0-service.ps1`, `beeper-services-run-as-user.*`, `grant-beeper-service-control.*`, `register-s0-identity-task.ps1`, `s0-identity-reconcile.ps1` | Beeper as a Windows service | **yes, one Linux equivalent**: Beeper launcher under Xvfb with `--user-data-dir` on the volume, supervised. ROADMAP:378-382 says ONE supervisor (a `headless-display.mjs` owning Xvfb the way `whisper-server.mjs` owns its server), never a service beside it |
| `share-beeper-primary-profile.*`, `beeper-share-config.mjs`, `beeper-window.*`, `adopt-beeper-profile.ps1` | share/adopt a Beeper profile between the S1 window and the S0 service | no (single account, one install). The adopt idea (copy a verified profile) is a possible alternative to the VNC first sign-in (*unverified* on Linux) |
| `beeper-desktop.ps1` | Beeper helpers (services, ACEs, ports) | no |
| `renew-beeper-token.*` | token renewal through the service | yes, small: use `src/tools/beeper-mint-token.mjs` + `set-beeper-token.mjs` (both cross-platform), approved in the VNC session |
| `upgrade.ps1/.cmd`, `deploy.ps1` | drop `/upgrade` in `state/ingest`, verify the bounce | optional: in-chat `/upgrade` already works (daemon `git pull` + `npm install`, `daemon-runtime.mjs:436-456`); a shell script for the box is a nicety |
| `start-egpt.*`, `stop-egpt.*` | STOP file + runners | optional: STOP file = `touch $EGPT_HOME/STOP`; `docker stop`/`start` |
| `provision-sandbox-account.*`, `sandbox-account.ps1`, `sandbox-logon-launcher.ps1`, `sweep-sandbox-leases.*`, `test-sandbox-logon-launcher.ps1` | Windows OS sandbox | **yes, at step 4**: user creation (image build or entrypoint) + the Linux launcher. A lease sweep is only needed if leasing is kept |
| `provision-service-account.*` | an account a peer node reaches by ssh | no (EDW has no inbound) |
| `egpt-wake-duty.*`, `register-wake-duty-task.ps1` | wake from sleep for a cycle | no |
| `*.Tests.ps1` (14) | Pester tests | n/a |

### 2b. Node `.mjs` setup tools

| Tool | Cross-platform? |
|---|---|
| `set-beeper-token.mjs` | **yes**. Needs `limbs.beeper.<conn>.token` to **already exist** (`:24-25`). The skeleton's connection is `main` (`config/skeletons/config.yaml:62-64`) |
| `verify-install.mjs` | runs. Off win32, `:182` adds a permanent `warn` naming `setup/install-service.sh`, which **does not exist** (also cited in README.md:77) → best possible exit is **2**, never 0. The claude check uses PATH only (`:160-167`), but the runtime also finds `~/.local/bin/claude` |
| `migrate.mjs` | yes (`isElevated` via `getuid`; Windows migrations self-satisfy) |
| `config-drift.mjs` | yes (ssh to a peer; EDW has no inbound) |
| `global-read-paths.mjs` | yes (reads config); its only consumer is a PS provisioner |
| `move-rooms-out-of-conversations.mjs`, `port-explicit-tools.mjs`, `port-stats-location.mjs` | one-shots, not needed on a fresh volume |
| `src/tools/beeper-mint-token.mjs` | yes (local OAuth + PKCE). The approval prompt appears **in the Beeper window**, so on Xvfb it needs the VNC session (the comment `:26-30` measured a hang on a windowless S0) |

---

## 3. The sandbox

### 3a. Windows end to end (today)
1. **Resolution** — `brainpool.mjs:858` level (default `sandbox`) → `resolveSandboxedRung` `:658-662` (level > conversation > agent default > platform). `:1264` `sandboxOauthTokenOf` (`config.yaml sandbox_oauth_token`, `:489-491`); `:1274-1275` `sandboxSharePathsFor` (`allowed_paths` split RW/RO via `allowedPathsFor` `:144`; node-level `allowed_paths` merged `:440-446`, conversation-level `:463-464`); `:1280` `globalReadPathsOf(global_read_paths)`; `:1332-1359` all passed in `baseOpts` with `beingLink.forBeing({…, boxed})`.
2. **Factory** — `boot.mjs:1051` `makeSession`: `sandboxed ? createSandboxCliSession : createBrainSession`. `boot.mjs:2784-2790` `hosted()` wraps ccode with `spawn: cliHost.spawner(key, meta)`, so the boxed child is **spawned by the daemon process** (`cli-host.mjs:74`) and outlives spine restarts.
3. **Session** — `createSandboxCliSession` (`sandbox-cli-session.mjs:229`): engine guard, platform guard (`:259-262`), credential guard (ccode), per-thread `CLAUDE_CONFIG_DIR=~/.egpt-jsonl/<thread>` (`:310-327`), share lists, read mounts, git-bash, being-link mint → `setEnv` (`:424-429`). Then `sandboxSpawn` replaces `powershell.exe -File setup/sandbox-logon-launcher.ps1 …` for the CLI's own spawn (`:431-440`). Codex and pi are wrapped identically (`:442-443`).
4. **Launcher** (`sandbox-logon-launcher.ps1:17-60`): (a) lease one of 16 pool accounts `egpt-sbx-00..15` (`SANDBOX.md:80-85`) through an exclusively-open lock file in `C:\ProgramData\egpt\sandbox-pool-locks` (`sandbox-account.ps1:30`). The lease is sticky by a hash of the folder, so it is **not** one account per conversation. (b) DPAPI password. (c) user SID. (d) Modify ACE on TargetFolder, RW/RO ACEs on share paths, read back, ledger in the lock file. (e) private desktop. (f) scrub the profile and plant junctions `src`→checkout, `egpt`→conversation folder (cwd), `<name>`→each `global_read_paths` entry (`sandbox-account.ps1:1133-1162`). CreateProcessWithLogonW with stdio passed through. (g) revoke ACEs, release the lease.
5. **Standing grants** (provisioner): the pool group gets RX on `~/.local/bin`, the checkout, and the `global_read_paths` targets, plus traverse ACEs on `~` and `~\src` (`SANDBOX.md:474-516`).
6. **Heartbeats** — `boot.mjs:673-686` `createHeartbeatBoxRunner` → `spawnBoxedCommand` (same launcher argv).
7. **Not confined**: network. There is no network mechanism in `SANDBOX.md` or the launcher (grep found none), so a boxed being reaches `127.0.0.1` (Beeper API is token-gated; the spine's `/being` WS is secret-gated).

### 3b. Seams a Linux "one Unix user per conversation + structural wall" plugs into
| Seam | Where | Role |
|---|---|---|
| Platform default | `brainpool.mjs:662` | rung 4 answers true on a Linux node with the box |
| Platform refusals | `sandbox-cli-session.mjs:260`, `:543` | the only two guards that block Linux |
| **The spawn seam** | `sandbox-cli-session.mjs:437` `sandboxSpawn(bin,args,spawnOpts)` → `_spawn(<launcher>, launcherArgv(...), spawnOpts)`; `:559` for beats | swap the launcher binary/argv per platform; inputs already normalized: `targetFolder`, `sharePaths`, `sharePathsReadOnly`, `setEnv` (NAME=VALUE), `readMounts` (name=path), `bin`, `args` |
| Argv contract | `launcherArgv` `:471-484` | one place for both callers |
| Launch log line | `tapLaunchLine` `:588-605` (`sandbox-logon-launcher: launch …`) | a Linux launcher should print the same prefix to keep logging |
| Windows-only env | `:427` git-bash pair; `:402` resolver | drop on Linux |
| Who spawns | `cli-host.mjs:74` (daemon) via `boot.mjs:2789` | the daemon (or a helper it calls) needs the privilege to switch uid; root, setuid helper or sudo rule is an open design choice |
| Read mounts validation | `brainpool.mjs:509` | must accept POSIX absolute paths |
| Being-link env | `being-link.mjs:209-216` → `EGPT_SPINE_PORT`, `EGPT_BEING_TOKEN`, `EGPT_ASK_SPINE`, `EGPT_CDP` | `EGPT_ASK_SPINE` = `$HOME/src/egpt/src/tools/ask-spine.mjs` (`:60-62`); `EGPT_CDP` = file URL of `being-cdp.mjs` beside it (`:152`). Inside the wall these paths must resolve (the mount at the same path, or the client path changed in one place) |
| Boxed CDP filter | `being-link.mjs:111-131` (`boxedCdpRefusal`) | already POSIX-aware; keyed on `boxed` |
| CLI flags | `claude-args.mjs` `osConfined` | unchanged |
| Thread store | `sandbox-cli-session.mjs:92-108` | per-thread dir must be writable by the conversation uid |
| Setup | `provision-sandbox-account.ps1`, `sandbox-account.ps1` (`$SandboxPoolSize=16`, prefix, group) | Linux: create users/group; the conversation↔uid mapping and where it is stored is **not designed yet** |

### 3c. What the being needs inside the wall (from the Windows box's contents)
- `claude` binary (Windows: RX on `~/.local/bin`). On Linux `~/.local/bin/claude` is typically a symlink into `~/.local/share/claude/versions/…` (*unverified* for the current installer), so the symlink target must be inside the wall, along with the libs it links to (*unverified*: dynamic vs static).
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` from `sandbox_oauth_token` (env), `CLAUDE_CONFIG_DIR` = its writable thread dir. The token is visible to the being (plan "Open checks").
- `node` (ask-spine, being scripts — `sandbox-cli-session.mjs:154-160` records "node: command not found" in a box), `git`, `bash` + coreutils (Bash tool), CA certs, DNS (`/etc/resolv.conf`), `/dev/null`, `/dev/urandom`, `/tmp`. Whether claude/node need `/proc` is *unverified*.
- Read-only: the checkout at the `src` mount, with `node_modules/ws` (ask-spine imports `ws`, `ask-spine.mjs:20`), and each `global_read_paths` entry. Read-write: the conversation folder as cwd (`egpt` mount), plus RW/RO `allowed_paths`.
- Network: loopback to `EGPT_SPINE_PORT` (ask-spine dials `ws://127.0.0.1:<port>/being`, `ask-spine.mjs:77-88`) and outbound HTTPS to Anthropic. A separate net namespace would cut the loopback.
- Chrome: never direct. Only through the spine (`EGPT_CDP` shim intercepts `localhost:9221`, `being-cdp.mjs:10-12`). Chrome is a pipe child of the daemon with no port (`chrome-host.mjs:44-54`).
- Spine and being both write the conversation folder (transcripts plus the being's files), so ownership/ACL must let both read and write (*design*).

### 3d. Docker constraints
| Claim | Status |
|---|---|
| Docker's default capability set includes `SYS_CHROOT`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`; not `SYS_ADMIN` | known |
| The default seccomp profile blocks `mount`, `umount2`, `unshare`, `setns`, `pivot_root` and namespace `clone` flags unless `CAP_SYS_ADMIN` is granted → bind mounts / bwrap / unshare walls need `--cap-add SYS_ADMIN` and/or a custom seccomp profile | known |
| AppArmor `docker-default` denies `mount` where AppArmor is active | known; whether it is active under Docker Desktop/WSL2 is unverified |
| chroot alone holds only against a non-root process without `CAP_SYS_CHROOT`; the being must run as a non-root uid with no caps | known |
| Without mount privilege, the wall's contents must be laid out at image build or entrypoint (copies/hard links, or bind mounts done once at start with privilege) | known (consequence) |
| Chrome in Docker: `/dev/shm` defaults to 64 MB (`--shm-size` or `--disable-dev-shm-usage`); Chrome's own sandbox needs userns or a SUID helper, else `--no-sandbox` | known general; unverified on this image |
| Electron/Beeper: `chrome-sandbox` must be root:4755 or use `--no-sandbox`; AppImage needs FUSE (absent by default → extract) | known general; Beeper's Linux package format (AppImage vs deb) unverified |
| No systemd; PID 1 must reap zombies (tini / `--init`), and POSIX kills here are single-pid (`reap-port.mjs:226`, `chrome-launcher.mjs:242`) | known |
| User namespaces under Docker Desktop 29.4's WSL2 kernel on reve | unverified |

---

## 4. External binaries: how each is located

| Binary | Lookup | Linux paths scanned? |
|---|---|---|
| claude | config `bin` → `EGPT_CLAUDE_BIN` → `~/.local/bin/claude` → PATH (`warm-cli-session.mjs:257-264`); `butler.mjs:64` PATH | yes |
| codex | `EGPT_CODEX_BIN` → (win32 APPDATA) → `~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js` → PATH (`codex-cli-session.mjs:18-31`) | yes (`npm -g` to `/usr/local` → PATH) |
| pi | same pattern (`pi-cli-session.mjs:85-95`) | yes |
| whisper-cli | `transcription…cli.command` default `whisper-cli` on PATH; `model_path` **required** (`tools/transcribe.mjs:95-98`) | PATH / config |
| whisper-server | config `command` + `model` (`spine/transcriptor-worker.mjs:128`; pipeline `whisper-server-local`) | config |
| ffmpeg / ffprobe | config `ffmpeg_command` default `ffmpeg` (`transcribe.mjs:95`, `spine/media.mjs:62`, `synthesizer-worker.mjs:35-37`); ffprobe derived (`video-frames.mjs:16-17`) | PATH / config |
| piper | env `RADIO_PIPER` root → `venv/Scripts/python.exe` + `voices/*.onnx` (`synthesizer-worker.mjs:59-72`). TTS engines: only `piper-server-remote` (`synthesis-pipeline.mjs:51`), so local speech = the spine's own synthesizer worker (`boot.mjs:1439`) + a remote entry pointed at it | **breaks** (`Scripts/python.exe`) |
| Chrome | config `chrome.bin` → `CHROME_PATHS.linux` (`chrome-launcher.mjs:20-26,29-33`) | yes |
| Beeper | not located: discovered by port 23373–23382 + token (`boot.mjs:1838-1875`) | n/a (setup's job) |
| git, npm, node | PATH (`daemon-runtime.mjs:439,447,754`) | PATH |
| ps, lsof | PATH (`reap-port.mjs`, `chrome-launcher.mjs`, `commands.mjs`, `lag-probe.mjs`) | need `procps`, `lsof` |
| ssh | PATH (`beeper-whoami.mjs:325`, `config-drift.mjs:42`) | optional |

---

## 5. Beeper on Linux
- Config: `limbs.beeper.<conn>.{account, token}` (skeleton `config.yaml:59-70`, migration 0049). `beeper.auto_update.<windows|linux|mac>.method` = auto/manual/none (schema `config-schema.mjs:768-778`). Linux: any value but `none` → treated as `none`, with one boot note (`beeper-update.mjs:28-35,367`).
- `beeper-update.mjs` off Windows: installed version null (`:72-73`), pending null (no `LOCALAPPDATA`, `:80-81`), feed query hardcodes `platform: 'win32'` (`:105`), `/update beeper` **refuses** (`:303`), and the install tool is `beeper-update.ps1` (`:177-191`).
- `beeper-whoami.mjs` off Windows: `localOwners` empty (`:107`); API/token probing works; remote mode uses ssh + `src/egpt/src/tools/beeper-whoami.mjs` relative to the login home (`:308`).
- Token setup: `node src/tools/beeper-mint-token.mjs [--port N]` (approve inside the Beeper window = via the temporary VNC) → `printf %s "$TOKEN" | node setup/set-beeper-token.mjs <conn>`. The connection key must exist first (`set-beeper-token.mjs:24-25`); the skeleton names it `main`.
- Profile: Windows runs Beeper with `--user-data-dir` (`install-beeper-s0-service.ps1:12,30`; `adopt-beeper-profile.ps1:46`). The same Electron flag should put the profile on the EGPT_HOME volume (*unverified* for Beeper's Linux build).
- Linked-device count (plan "Open checks") is not in the code.

---

## 6. Tests

**Gated, so they skip on Linux:** `beeper-update.test.mjs` (`describe.skipIf` ×2), `daemon-singleton.test.mjs:74` (`runIf win32`, openExclusive/heldExclusive), `setup-principal.test.mjs` (`describe.skipIf`), `migrations-0005…test.mjs` and `migrations-0048…test.mjs` (`it.skipIf`).

**Platform-aware by design (inject `platform` or branch):** `sandbox-cli-session.test.mjs:265-275` (asserts the Windows-only throw off win32), `spine-heartbeat-loader.test.mjs:62` (defaults to linux), `chrome-brain-profile.test.mjs:137-151`, `spine-brainpool.test.mjs:125`, `daemon-runtime.test.mjs:74`, `migrate-runner.test.mjs:52`, `being-browser`, `being-cdp`, `process-priority`, `cli-host`, `lag-probe`, `sandbox-jsonl-store`, `spine-v1-boot:1066`.

**Will fail on Linux (static, high confidence):** `synthesizer-worker.test.mjs:84-85`. It expects `'C:\\radio\\piper\\venv\\Scripts\\python.exe'` from a `path.join`, and POSIX join gives `C:\radio\piper/venv/Scripts/python.exe`.

**Needs tools:** `integrity.test.mjs` runs `git ls-files src` (`:73`), so git and a real checkout are required.

**Read `.ps1` as text only (should pass, unverified):** `sandbox-ace-reclaim`, `sandbox-src-junction`, `stop-file`, `log-timestamp`.

**Windows-only by nature:** all 14 `setup/*.Tests.ps1` (Pester, Windows cmdlets); `tests-manual/*` (manual).

**Unverified risk:** files with many `C:\` literals — `spine-brainpool` (46), `daemon-runtime` (37), `sandbox-cli-session` (22), `migrations-0004` (21), `migrations-0023` (13), `chrome-creds` (12), `verify-install` (10), `pi-cli-session`, `being-cdp`, `being-browser` (9 each). Most inject `win32` or use pure string helpers, but only a Linux `npx vitest run` in the image proves it.

---

## 7. Step 1 (blueprint boots with no accounts) — concrete changes, smallest first

1. **Image contents, no code**: Node ≥22 (24 preferred for `node:sqlite`), `npm ci` on Linux, git, `procps`, `lsof`, ffmpeg, Xvfb, Chrome at a `CHROME_PATHS.linux` path, whisper.cpp `whisper-cli` + large-v3 model, a piper venv + voices, claude at `~/.local/bin/claude`, codex via `npm -g`, tini as PID 1. Put the checkout at `$HOME/src/egpt` (`being-link.mjs:60` expects it there). → verify: `which` each tool; `node -v`.
2. **Entrypoint env, no code** — reconfigure `daemon-runtime.mjs` through its existing env: `EGPT_HOME=<volume>`, `EGPT_SESSION1=1` (loads chrome-host, `:63,151`; clears `inSession0`, `commands.mjs:569`), `DISPLAY=:99` (inherited by `chrome-host.mjs:63`). Start Xvfb before the daemon (by hand for now; ROADMAP:378 puts its lifecycle in one daemon-owned module later). → verify: daemon log has no "no chrome-host" line (`daemon-runtime.mjs:942`).
3. **Profile config, no code**: `config.yaml` from the skeleton, with `node_name: EDW` in `transcription_service.echo.peer_priority` (`boot.mjs:1033,1043`), the `limbs.beeper` connection key present (placeholder token), `transcription.cli.{command, model_path, ffmpeg_command}`, and no beings that would answer (or `access_level: regular`, since `sandbox` is refused on Linux, `brainpool.mjs:858` → `sandbox-cli-session.mjs:260`). → verify: the spine starts and `state/alive.txt` beats.
4. **`spine/synthesizer-worker.mjs:71`** — make the venv layout per-platform (`bin/python` on POSIX); delete its `KNOWN_PLATFORM_DEBT` entry (`integrity.test.mjs:233-236`) and fix `synthesizer-worker.test.mjs:84`. → verify: "piper speaks" through the synthesizer worker plus a `piper-server-remote` entry pointed at `127.0.0.1`.
5. **`setup/verify-install.mjs:182`** — give the non-Windows runner check a real answer (a daemon pid/beat check in the container) instead of a permanent warn naming the missing `setup/install-service.sh`; fix README.md:77 to match. → verify: `node setup/verify-install.mjs` exits 0.
6. **Chrome under Xvfb**: if Chrome will not start in the container (sandbox, `/dev/shm`), the existing `chromePipeArgs` (`chrome-launcher.mjs:141`) is the one place to add flags; runtime `--shm-size` is the no-code alternative. → verify: `/chrome` launches a pipe Chrome and tabs list.
7. **Checks with no code**: `whisper-cli` on an en and an es sample through the existing cli rung; `claude -p` on the subscription (`claude setup-token` / `~/.claude` on the volume). → verify: as in the plan.

Outside step 1 and not needed for it: `daemon-singleton.mjs:28` (no POSIX lock), `chrome-creds.mjs:91` (`/login` saved passwords), `beeper-update` (Linux updates), `globalReadPathsOf:509` and the whole sandbox (step 4), `normalizeCwd` without a platform gate.
