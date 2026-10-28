# The seal and the command policy

Paths are short, as in [AGENTS.md](../AGENTS.md); the decisions behind it are `CLAUDE.md`'s.

## A run's seal

Every run starts sealed. `acpAgentFor` starts each ACP session, a task's or the hiring
one-shot's, under `/usr/bin/sandbox-exec -p` with a profile `server/agents/seal.ts` renders per
run, every path a `-D` parameter. Each run resolves its own (`machineSeal`,
`server/agents/machine-seal.ts`), so a path that became a symlink since boot is sealed where it
leads from the next run on.

- _Reads_ are open but for the founder's logins (`LOGINS`: ssh, gh, npm, netrc, git
  credentials, cloud and deploy CLIs, App Store Connect's notary keys, browser and chat-app
  profiles, agent-browser's saved logins), `secrets.json` with every name that starts with it,
  the other runner's home, and, for a codex run, what of the founder's own it would load
  (`personal` in `RUNNER_HOMES`): their skills (`$CODEX_HOME/skills`, codex's own `.system` ones
  in it, and `~/.agents/skills`), since codex loads every skill it can read and no setting leaves
  them all out; their instructions (`AGENTS.md` and `AGENTS.override.md` in its home), which it
  loads whatever its config says; and their `memories/`. A plugin's skills (in `plugins/cache`)
  stay readable: the session config turning plugins off keeps them out. Their rules
  (`$CODEX_HOME/rules`), whose `allow` decisions run a command without asking, and which no
  setting of the app server's leaves out, a codex run finds missing (`absent` in `RUNNER_HOMES`,
  denied `with errno ENOENT`) rather than refused: codex refuses to start a session on a rules
  folder it cannot read. The admin's `/etc/codex/rules` still loads, and so would a trusted
  project's `.codex/rules`, but no run makes a `.codex` folder.
- _Writes_ are denied by default. A run writes its own folders (`Seal.writable`: its workspace,
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
  `.claude/settings*.json`, `.mcp.json`, `.codex/`, and the `.git`/`.claude` folders themselves.
  Seatbelt checks a moved folder where it lands, never what it carries, so these hold in TMPDIR and
  `cache/` too. Nor is `.agents` written in any of the run's own folders (`Seal.skillFolders`),
  where codex finds skills in its working directory and in each folder it is handed, so no run
  leaves one for the next.
- Nor does a run write claude's account file (`account` in `RUNNER_HOMES`: `~/.claude.json` with
  every name that starts with it, or the one in `CLAUDE_CONFIG_DIR`), its backups or the legacy
  `.config.json` claude reads in its place: the MCP servers named there, user-wide or per project,
  start in the founder's own sessions, unsealed. claude runs without writing it; only the sign-in,
  which records the login there, does.
- Seatbelt matches the path a symlink leads to, never the link, so each sealed path is named
  where it is and where it resolves. A run's own folders are allowed only where the save
  resolves: a run whose folder, or any folder between it and the save, is a symlink does not start
  (`ownFolders`), and no run removes, moves or replaces one of its own folders. Main makes them
  before the run: a product's workspace as a git repository (`ensureRepository`, macOS's git;
  without Apple's command line tools the run goes on in a plain folder) and claude's `projects/`
  folder. A run writes no git config, so its commits are named by
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
- _Reach_: a run connects to no unix socket but DNS's, syslog's, its own folders', its line to the
  company (`apiSocket`, below) and its agent-browser namespace (`browserNamespace`, keyed by save,
  runner and the run's own folders, since a daemon keeps the seal and working directory of the run
  that started it and idles past it): no ssh, gpg or 1Password agent, container engine, app
  `SingletonSocket` (which hands the running app a URL), claude's or the codex app's sockets, the
  founder's own agent-browser daemons or those of the other runner or of runs with other folders.
  Those of them in a folder it writes (launchd's, an ssh-agent's, main's `SSH_AUTH_SOCK`,
  `/tmp/cc-socks`, the codex app's) cannot be moved or replaced either. Loopback 9222, 9229 and
  31100 are closed, and so is the port main serves the window's page on (`pagePorts`), which holds
  the founder's approve button: Chrome's DevTools port, node's inspector, and the dev server, which
  reads any file of the checkout to whoever asks and under `pnpm dev:browser` signs a browser in to
  main's page. LaunchServices opens nothing; the Apple Event CLIs (`osascript`, `osacompile`,
  `automator`, `shortcuts`) and git's Keychain helper do not run; no setuid program runs but
  `/bin/ps`, which fnm needs; a codex run reaches no Keychain (a `mach-lookup` deny of securityd,
  which holds against a copied binary too).
- _Who calls the company is the socket, not a secret._ Each run reaches its tools over its own
  unix socket, an HTTP server main opens for that run alone (`controlPlane.registerRun`) at
  `<save>/.run/<id>`, mode 0600 in a 0700 folder (`~/.idlebiz-run/<save digest>/` when that path
  passes the 103 bytes macOS allows a socket; past both the run does not start, `runSocketPath`).
  Runs are processes of the founder's own user, so any run can read another's env (`ps -E`, or the
  `KERN_PROCARGS2` sysctl, which needs no setuid program, so keeping `/bin/ps` would not close it),
  its bearer token included, and a token alone would let a teammate call lead-only tools as the
  lead. So a run's seal lets it connect to its own socket (`Seal.apiSocket`) and names no other
  run's, in folders no run writes (the save, HOME), and each socket's server binds the run it was
  made for: a token presented on another run's socket is refused. The bearer stays as a second
  check. Without the seal neither isolates a run: a socket's mode admits every process of the
  founder's user, which every run is. The `idlebiz` command a run types reads
  `IDLEBIZ_API_SOCKET` and `IDLEBIZ_RUN_TOKEN` (`commands/tools.ts`) and calls on that socket
  alone, never on a relative path, which would reach whatever listens in the run's own folders; no
  loopback port answers for the company. A socket closes as its run settles, so a call from a
  process the run left behind finds nothing; boot sweeps what a crash left.
- _Checked before use._ Boot runs `checkSeal`, no model call: under each runner's profile a canary
  must be unreadable, a file where no rule allows a write must not be made, and the runtime must
  start. Until it holds the scheduler starts nothing and autopilot files nothing; a refusal is
  listed in Settings beside what boot skipped, and a CLI sign-in retry checks again. Main starts a
  runner's CLI itself only sealed as that runner: its version and login probes, `codex mcp list`,
  and the sign-in (`sealedSignIn`, the only one that may open the browser or write claude's
  account file). The installer runs in `/bin/bash -c`, never a login shell. The login-shell PATH
  probe (`adoptShellPath`, the packaged app's alone: a dev launch keeps its terminal's PATH) runs
  unsealed: no run writes the founder's shell startup files. The seal's check waits on it, never
  boot, so no run starts on a PATH short of the shell's.
- Main's own writes: `atomicWrite` makes each `.tmp` anew (`wx`), so nothing main writes lands
  through a planted link. Never set `AGENT_BROWSER_PROFILE` for runs: one fixed profile locks
  every session but the first out.

## The command policy

Every permission ask a runner raises meets one judgement, `holdFor` in `server/policy/index.ts`;
every turn sets the runner's asking mode first (claude `default`, codex `external-sandbox`), since
a session starts in a default that may not ask. A shell command matching a rule (deploy, publish,
git push, GitHub writes, payments, sends, remote copies, pipe-to-shell, credential reads) is
signed for once, exactly as sent, newlines and all (the card marks each with `⏎`), with the same
grant a signed tool takes. It is a tripwire: what a script runs goes unseen (`npm run deploy`, a
file on disk). codex would run a command the founder's `~/.codex/rules` allow without asking, so
its runs find no rules there ([A run's seal](#a-runs-seal)).

- An `idlebiz <tool>` line runs unasked: its request is data the game reads, and the tool itself
  holds what needs the founder. No fetch is the company's, so a `curl` or `wget` that sends a body
  asks wherever it goes, a loopback port (a product's dev server) or a socket included, since what
  listens there may be anyone's.
- An `agent-browser` verb is read where agent-browser reads it, the first word its global options
  leave, and any verb but a listed page read is held unless the session's live page, read from the
  browser before the command runs (a click can land anywhere), is loopback with every frame found
  in it of the top page's own origin (or about:). A frame from any other origin, another localhost
  port included, makes the page nobody's: a ref, a `frame` switch or `webmcp --frame` acts inside a
  frame while the URL stays the top page's. Frames are found through `window.frames`, open shadow
  roots and resource timing, so one in a closed shadow root is known only by the URL it first asked
  for, once loaded. A remote site, once signed for, is leased for the rest of the run. An act
  chained after a step that may move the page, or inside one no read can see (`batch`, `chat`, an
  init script, an extension, an empty `--session`, a word the shell fills in), is signed for once,
  exactly. An act on a `file:` page is held, and so is a command naming a `file:` URL outside the
  run's own dirs, judged where its symlinks lead (`Confinement.real`). Only the command line's own
  options count: an `AGENT_BROWSER_*` variable or an `agent-browser.json` goes unread.
- No rule judges where a run writes: an edit by claude's Write/Edit, a codex patch and a shell
  `rm` or `mv` all run unheld, and the seal refuses whatever lands outside the run's own folders.
  codex asking to widen its own sandbox is refused with no card: once widened, nothing else in the
  run would ask. An MCP server that asks anyway is leased for the run; one nothing can name never
  is. A web read by the agent's own tool runs, as a bare `curl` does, and so does a file read by
  claude's Read, Grep or Glob, as a bare `cat` does; an ask IdleBiz cannot recognise is held once,
  exactly. A signature only ever picks the runner's one-time option. Both runners' wire formats
  end in `packages/agent-driver/src/tool-ask.ts`; the policy only ever sees a `ToolAsk`.
- Whether a sign-off leases is its rule's alone (`LEASED` in `@repo/domain/hold-rules`, which
  every rule must fill), never the hold's. A saved ask names its rule, so retiring a hold rule is
  a breaking store change (bump `SAVE_FORMAT`): a TASK.md still asking under it is refused.

## What stays open

On purpose or for want of a rule:

- the network: a run can send what it reads anywhere;
- reads across HOME outside the login stores (another project's `.env`, transcripts), this
  checkout's `apps/desktop/.env` included: it names the notary key by id and issuer, which sign
  nothing without the `.p8` the seal keeps in `~/.appstoreconnect/private_keys`;
- to claude runs, which share the founder's login, the Keychain: claude reads its login there, so
  a token the founder's `gh` or git keeps there is guarded only by the tripwire's
  `read-credentials` and `git-push` holds;
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
  those on main's PATH and the known terminal shims are sealed: any other (another terminal's or
  version manager's shims, a folder added to their PATH after IdleBiz started) is writable by
  runs.
