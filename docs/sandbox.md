# The sandbox and what judges a run

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

## A run's sandbox

Every run starts sandboxed. `acpAgentFor` starts each ACP session, a task's or the hiring
one-shot's, under `/usr/bin/sandbox-exec -p` with a profile `@repo/sandbox/profile` renders per
run, every path a `-D` parameter. Each run resolves its own (`machineSandbox` in
`@repo/sandbox/machine`, which main's `sandboxOf` in `server/agents/sandbox.ts` hands the save, its
keys' file and its own ports), so a path that became a symlink since boot is sandboxed where it
leads from the next run on. The package knows nothing of main: a folder it cannot hand a run comes
back as a `FolderRefusedError`, which main words for the founder.

- _Reads_ are open but for the founder's logins (`LOGINS`: ssh, gh, npm, netrc, git credentials,
  cloud, infrastructure and deploy CLIs, database clients' saved passwords, package registries'
  and model hubs' publish logins, App Store Connect's notary keys, the updater's signing key,
  browser and chat-app profiles, agent-browser's saved logins; a file that holds one is sandboxed
  whole, even where a toolchain reads it on every build, and the caches and plugins beside it
  stay readable), `secrets.json` with every name that starts with it, the other runner's home
  (and, where `CLAUDE_CONFIG_DIR` or `CODEX_HOME` moved it, as the e2e suite's stand-ins do, the
  one in HOME with claude's account file beside it, which the founder's own CLI still keeps),
  and, for a codex run, what of the founder's own it would load
  (`personal` in `RUNNER_HOMES`): their skills (`$CODEX_HOME/skills`, codex's own `.system` ones in
  it, and `~/.agents/skills`), since codex loads every skill it can read and no setting leaves them
  all out; their instructions (`AGENTS.md` and `AGENTS.override.md` in its home), which it loads
  whatever its config says; and their `memories/`. A plugin's skills (in `plugins/cache`) stay
  readable: the session config turning plugins off keeps them out. Their rules
  (`$CODEX_HOME/rules`), whose `allow` decisions run a command without asking, and which no setting
  of the app server's leaves out, a codex run finds missing (`absent` in `RUNNER_HOMES`, denied
  `with errno ENOENT`) rather than refused: codex refuses to start a session on a rules folder it
  cannot read. The admin's `/etc/codex/rules` still loads, and so would a trusted project's
  `.codex/rules`, but no run makes a `.codex` folder.
- _Writes_ are denied by default. A run writes its own folders (`Sandbox.writable`: its workspace,
  the shared one, its memory, the save's `cache/`), its runner's state in its home (`state` in
  `RUNNER_HOMES`, a list of names: sessions, logs, caches, databases, codex's refreshed login;
  claude's transcripts and memory of the run's own folder only; a CLI upgrade that writes a new
  one fails with `EPERM` there until it is added), TMPDIR, macOS's per-user temp and cache
  folders, `/private/tmp`, the agent-browser namespace of its runner and folders, node CLIs'
  `~/Library/Preferences/*-nodejs` and the `/dev` nodes a toolchain writes. `toolCacheEnv`
  (`agents/run-workspace.ts`) moves TMPDIR and every cache a toolchain keeps in HOME into
  `cache/`, and turns CLI updaters off, so a tool that writes elsewhere in HOME fails with `EPERM`
  until its cache is moved there too. A git dependency fails as well: npm and pnpm clone it into a
  `.git` no run may make, and so do `git clone` and `git init`; the standing instructions say so
  and point runs at a repository's tarball instead.
- The rest of the runner's home is what the founder's own CLI and desktop app load and run:
  settings, instructions, hooks, skills, plugins, and any script a setting names there (a status
  line, a hook's, codex's `notify`); every other folder's claude transcripts and memory, which the
  founder's sessions there resume and load. None of it is written.
- Seatbelt obeys the last rule a path matches, so inside those folders the profile denies again
  what the founder's own tools load or run later: a folder the founder runs programs from inside
  one of them (on main's PATH, where its links lead, or a terminal's shims in TMPDIR:
  `TERMINAL_SHIMS`, cmux's) or a link in the runner's home leads (a dotfile manager's) with every
  folder above it there, and, anywhere, what the founder's tools run on opening a folder: in
  `.git/` everything but what git writes as it stages, commits, branches, stashes, merges, rebases
  and gcs (so no config, hooks, `commondir`, `worktrees/`, `modules/` or alternates),
  `.claude/settings*.json`, `.mcp.json`, `.codex/`, an editor's `.vscode/{tasks,launch,settings}.json`
  and `.idea/`, direnv's `.envrc`, and the `.git`, `.claude`, `.vscode` and `.idea` folders
  themselves. Each name matches in any case, as the disk does (`.GIT/config` is `.git/config`).
  Seatbelt checks a moved folder where it lands, never what it carries, so these hold in TMPDIR and
  `cache/` too. Nor is `.agents` written in any of the run's own folders (`Sandbox.skillFolders`),
  where codex finds skills in its working directory and in each folder it is handed, so no run
  leaves one for the next.
- Nor does a run write claude's account file (`account` in `RUNNER_HOMES`: `~/.claude.json` with
  every name that starts with it, or the one in `CLAUDE_CONFIG_DIR`), its backups or the legacy
  `.config.json` claude reads in its place: the MCP servers named there, user-wide or per project,
  start in the founder's own sessions, unsandboxed. claude runs without writing it; only the sign-in,
  which records the login there, does.
- Seatbelt matches the path a symlink leads to, never the link, so each sandboxed path is named
  where it is and where it resolves. A run's own folders are allowed only where the save
  resolves: a run whose folder, or any folder between it and the save, is a symlink does not start
  (`ownFolders`), and no run removes, moves or replaces one of its own folders. Main makes them
  before the run: a product's workspace as a git repository (`ensureRepository`, macOS's git;
  without Apple's command line tools the run goes on in a plain folder) and claude's `projects/`
  folder. A run writes no git config, so its commits are named by
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
- _Reach_: a run connects to no unix socket but DNS's, syslog's, its own folders', its line to the
  company (`apiSocket`, below) and its agent-browser namespace (`browserNamespace`, keyed by save,
  runner and the run's own folders, since a daemon keeps the sandbox and working directory of the run
  that started it and idles past it): no ssh, gpg or 1Password agent, container engine, app
  `SingletonSocket` (which hands the running app a URL), claude's or the codex app's sockets, the
  founder's own agent-browser daemons or those of the other runner or of runs with other folders.
  Those of them in a folder it writes (launchd's, an ssh-agent's, main's `SSH_AUTH_SOCK`,
  `/tmp/cc-socks`, the codex app's) cannot be moved or replaced either. Loopback 9222, 9229 and
  31100 are closed, and so is the port main serves the window's page on (`pagePorts`), which holds
  the founder's approve button: Chrome's DevTools port, node's inspector, and the dev server, which
  reads any file of the checkout to whoever asks and under `pnpm dev:browser` signs a browser in to
  main's page. LaunchServices opens nothing, launchd starts no job (`job-creation`, which launchd
  checks of its caller, though it already refuses any sandboxed caller's, a sign-in's too), and
  cfprefsd writes no preference (`user-preference-write`: it writes for a caller allowed that or
  the plist's own write). No run mounts or unmounts a filesystem itself
  (`file-mount`, `file-unmount`, which the kernel checks; a remount, `file-mount-update`, is not
  denied, since no list before macOS 15 names it and the profile must compile on the floor),
  nor has diskarbitrationd mount one over a folder the run names, the one mount it checks against
  its caller's sandbox (`file-mount`): no `hdiutil attach -mountpoint`, so no `.dmg` a run would pack
  through a mount at a folder of its own either. Each would run or land outside the sandbox, as the
  founder. The Apple Event CLIs (`osascript`, `osacompile`, `automator`, `shortcuts`) and
  git's Keychain helper do not run; no setuid program runs but `/bin/ps`, which fnm needs; no run
  reaches the pasteboard, where a key the founder pastes sits, and a codex run no Keychain (each a
  `mach-lookup` deny of its service, which holds against a copied binary too).
- _Who calls the company is the socket, not a secret._ Each run reaches its tools over its own
  unix socket, an HTTP server main opens for that run alone (`controlPlane.registerRun`) at
  `<save>/.run/<id>`, mode 0600 in a 0700 folder (`~/.idlebiz-run/<save digest>/` when that path
  passes the 103 bytes macOS allows a socket; past both the run does not start, `runSocketPath`).
  Runs are processes of the founder's own user, so any run can read another's env (`ps -E`, or the
  `KERN_PROCARGS2` sysctl, which needs no setuid program, so keeping `/bin/ps` would not close it),
  its bearer token included, and a token alone would let a teammate call lead-only tools as the
  lead. So a run's sandbox lets it connect to its own socket (`Sandbox.apiSocket`) and names no other
  run's, in folders no run writes (the save, HOME), and each socket's server binds the run it was
  made for: a token presented on another run's socket is refused. The bearer stays as a second
  check. Without the sandbox neither isolates a run: a socket's mode admits every process of the
  founder's user, which every run is. The `idlebiz` command a run types reads
  `IDLEBIZ_API_SOCKET` and `IDLEBIZ_RUN_TOKEN` (`commands/tools.ts`) and calls on that socket
  alone, never on a relative path, which would reach whatever listens in the run's own folders; no
  loopback port answers for the company. A socket closes as its run settles, so a call from a
  process the run left behind finds nothing; boot sweeps what a crash left.
- _Reported._ Every deny of a task's run carries its label (`Sandbox.label`, `<employee>/<task>`,
  as a `(with message …)` the kernel logs beside the deny), and main reads them back from the
  system log while it runs (`watchDenials` in `@repo/sandbox/denials`, `log stream`, which needs no
  privilege for the user's own processes) into its log as
  `[sandbox] run <label>: <process> denied <operation> <path>`. A probe's and a sign-in's go
  unlabelled.
- _Checked before use._ Boot runs `checkSandbox`, no model call: under each runner's profile a canary
  must be unreadable, a file where no rule allows a write must not be made, and the runtime must
  start. Until it holds the scheduler starts nothing and autopilot files nothing; a refusal is
  listed in Settings beside what boot skipped, and a CLI sign-in retry checks again. Main starts a
  runner's CLI itself only sandboxed as that runner: its version and login probes, `codex mcp list`,
  and the sign-in (`sandboxedSignIn`, the only one that may open the browser or write claude's
  account file). Of what main starts outside a sandbox, three programs would run what their env
  names, so each starts on an env of its own, never main's whole (`unsandboxedEnv`,
  `server/lib/founder-env.ts`): the account's HOME, USER, LOGNAME, SHELL and TMPDIR, the locale,
  and a PATH it is given. They are the login-shell PATH probe (`adoptShellPath`, the packaged
  app's alone: a dev launch keeps its terminal's PATH), which starts the account's shell on the
  fallback PATH with launchd's own ssh agent, as a terminal's shell starts (`SSH_AUTH_SOCK` only
  where launchd puts it, a folder no run makes or writes: an rc file that starts an agent when it
  finds none would leave one running after every probe, and its `ssh-add` would hand keys to any
  other); the installer, `/usr/bin/curl -q … | /bin/bash` on the system PATH and never a login
  shell, with the founder's proxies but no CA and no `.curlrc`, failing with its download
  (`pipefail`); and a workspace's `git init`, on the system PATH. The sign-in, whose profile lets
  it open the browser, starts from the same names with main's PATH, the proxies and its runner's
  provider settings (`signInEnv`). So no `ZDOTDIR`, `BASH_ENV`, exported function,
  `GIT_TEMPLATE_DIR` or `DEVELOPER_DIR` steers them, and no run writes the startup files or git
  config under the account's home that they still read. The sandbox's check waits on the probe,
  never boot, so no run starts on a PATH short of the shell's.
- Main's own writes: `atomicWrite` makes each `.tmp` anew (`wx`), so nothing main writes lands
  through a planted link. Never set `AGENT_BROWSER_PROFILE` for runs: one fixed profile locks
  every session but the first out.

## What judges a run

Every turn sets the runner's mode first (`sessionMode` in `packages/agent-driver/src/registry.ts`),
since a session starts in a default the founder's settings may pick. The runner's own judge decides
what it can; IdleBiz writes no rules of its own over commands:

- claude runs in auto mode: its classifier, on Anthropic's servers, reads each action before it
  runs and refuses what it takes for harm. Behind a gateway at `ANTHROPIC_BASE_URL`, which may not
  pass that check through, every checked action would be refused, so there it runs in Manual and
  asks. The session sets no ask rule, since one forces a prompt even in auto mode.
- codex runs in `agent-full-access`: no sandbox of its own can start inside ours, and its auto
  review judges only what that sandbox would stop, so it asks nothing. Its runs find none of the
  founder's `~/.codex/rules` ([A run's sandbox](#a-runs-sandbox)).
- Whatever ask reaches IdleBiz is allowed (`permissionGate` in `server/agents/session.ts`): the
  sandbox and custody are what hold a run, and a step that spends IdleBiz's keys is a signed tool,
  signed for once by the founder ([Keys and what spends them](keys.md)). The one refusal is codex
  asking to widen its own sandbox: once widened, nothing in the run would ask again. A deny rule of
  the session's own (`mcp__*`, plan mode) refuses before anything asks. Both runners' wire formats
  end in `packages/agent-driver/src/tool-ask.ts`.
- A saved ask names a signed tool's hold rule (`@repo/domain/hold-rules`), so retiring one is a
  breaking store change (bump `SAVE_FORMAT`): a TASK.md still asking under it is refused.

## What stays open

On purpose or for want of a rule:

- the network: a run can send what it reads anywhere;
- every other service a run reaches over mach: the profile allows what it does not deny by name,
  so a service that acts for its caller without checking the caller's sandbox acts for a run as the
  founder, until it is found and denied as the Keychain's and the pasteboard's are;
- what diskarbitrationd does for a run but mount over a folder the run names: it checks the
  caller's sandbox only there, and who owns the disk otherwise, so an image a run attaches mounts
  under `/Volumes`, and a run can unmount or eject the founder's own volumes (`diskutil unmount`
  or `eject`, `hdiutil detach`);
- a remount of a filesystem the founder's user mounted (`mount -u`, `file-mount-update`): no
  operation list before macOS 15 names it, and a name the floor's sandbox does not know fails the
  whole profile, so it waits on the floor;
- the environment launchd hands the apps the founder opens later (`launchctl setenv`, which no
  rule of the sandbox's names): a `NODE_OPTIONS` there loads a file into their node, a `ZDOTDIR` runs
  one in their next terminal's shell, and a `CODEX_HOME` points their own codex at another home.
  A canary holds that launchd takes no setenv from a run (`@repo/sandbox`'s `machine.mac.test.ts`), so it is code a run
  leaves for the founder to run, a workspace's script, that could set one. IdleBiz's packaged app
  takes from it neither who the founder is nor its save, its runners' CLIs, homes or model
  addresses ([Main's env](app.md#the-page-the-shell-and-main)), and none of the programs it starts
  outside a sandbox that would run what an env names takes it ([A run's sandbox](#a-runs-sandbox)). It
  still takes the rest, and its runs with it: proxies, which alone see hostnames and can withhold
  traffic but cannot read TLS; what a run's own tools read to pick a registry or whom to trust
  (`npm_config_registry`, `npm_config_strict_ssl`, `npm_config_cafile`, `GIT_SSL_NO_VERIFY`,
  `GIT_SSL_CAINFO`, `PIP_CERT`, `CARGO_HTTP_CAINFO`, `CURL_HOME`…), with which a proxy or
  registry set there reads and rewrites a run's package and git traffic, and so what a product
  ships; a runner's other settings (`ANTHROPIC_API_KEY`, a Bedrock switch: another account
  billed, inside the sandbox); and `SSH_AUTH_SOCK`, whose path no run may then write (one in a
  workspace denies its team writes there). A development launch takes its terminal's whole,
  which is launchd's when the terminal app started after the setenv;
- the shell's own env, which is launchd's: the updater runs `touch` on launchd's PATH (an update
  is refused while that finds any but `/usr/bin/touch`), stages in launchd's TMPDIR and may keep
  a failed install's backup under launchd's HOME, and whether a `CFFIXED_USER_HOME` there moves
  where the Keychain looks, and with it the sealing key, is unverified;
- an update while it is staged: the updater unpacks the new app into a folder under the shell's
  TMPDIR, the per-user temp folder every run writes, before it moves it over the installed app,
  so a process a run left behind could alter it in between (whether macOS's checks of a
  notarized bundle catch that is unverified), until the updater stages it in a folder of its own;
- the single-instance socket, `/tmp/com_idlebiz_desktop_si.sock`, in a folder every run writes: a
  process a run left behind that listens there first makes the next launch hand over to it and
  quit;
- a login store a variable moves (`GH_CONFIG_DIR`, `AWS_SHARED_CREDENTIALS_FILE`, `GNUPGHOME`,
  `DOCKER_CONFIG`, `KUBECONFIG`, `XDG_CONFIG_HOME`…): `LOGINS` sandboxes each where it is by default,
  so one the founder, or launchd's env, moved is read where it went;
- reads across HOME outside the login stores (another project's `.env`, transcripts, a clipboard
  manager's history, `~/.yarnrc.yml`, yarn's settings, where `yarn npm login` adds a token), this
  checkout's `apps/desktop/.env` included: it names the notary key by id and issuer, which sign
  nothing without the `.p8` the sandbox keeps in `~/.appstoreconnect/private_keys`, and holds the
  updater key's password, which signs nothing without `~/.tauri/idlebiz.key`, sandboxed as well;
- to claude runs, which share the founder's login, the Keychain: claude reads its login there, so
  a token the founder's `gh` or git keeps there, and what a run does with it (a push over https),
  is guarded only by auto mode's classifier, and behind a gateway by nothing;
- to claude runs, a deny rule of managed policy outside the managed settings files: main reads
  none in the MDM profile, in server-managed settings (claude.ai's or a gateway's, which claude
  caches) or in a `policyHelper`'s output, so a run under one starts, and each company tool's
  `idlebiz` command is refused before IdleBiz is asked, the turn ending as done
  ([A run's env, login and notes](runs.md#a-runs-env-login-and-notes));
- each runner's state, which the founder's own sessions read as data: claude's prompt history,
  session registry, todos and file backups (which a rewind restores), codex's session logs and
  databases (its memory pass reads them into what later sessions load);
- the runners' shared ground: every run writes `cache/` and a product's workspace, so code a codex
  run leaves there (a package script, a `node_modules/.bin` shim) runs in the next claude run,
  with the Keychain and claude's login;
- the team's notes: any run writes a product's `AGENTS.md`, and every later run on it reads it, a
  claude run's in its system prompt, so one run's words steer the next; framing them as
  teammates' (which they can close themselves) is all that stands against that;
- a program a run builds can still send Apple Events (macOS asks the founder first: refuse it),
  and a debugger listening on a port other than 9222 or 9229 takes its orders;
- the founder's git run inside a workspace (push from a fresh clone);
- of the folders the founder's terminal runs programs from in TMPDIR or `/private/tmp`, only
  those on main's PATH and the known terminal shims are sandboxed: any other (another terminal's or
  version manager's shims, a folder added to their PATH after IdleBiz started) is writable by
  runs.
