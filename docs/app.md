# The app

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

## The page, the shell and main

The page reaches main over its contract and the runs reach it over the control plane: two doors,
never one. The page's carries the founder's session cookie and answers on the page's own port,
which the seal closes to every run; the control plane's is a unix socket main opens for each run,
which only that run's seal reaches, and what it does is the run's.

- **The page's API.** `packages/contract` declares every procedure the page calls of main (oRPC, one
  file per domain, `<domain>-contract.ts`, whose zod schemas are the inputs' types), and
  `server/page-router.ts` implements it, so a procedure missing or mistyped fails to compile. The
  page calls `api.<domain>.<procedure>()` (`renderer/api.ts`, one client for the page) on its own
  origin: under `/rpc`, behind the session cookie and same-origin guards ("The window", below). One
  middleware words every answer that does not return (`server/lib/answers.ts`): a `RefusalError` is
  the store's bare sentence, which the page shows; text over a field's limit says the limit;
  anything else is a fault, answered with its message and reported to main's log.
- **Main's events** are the contract's `events` stream, each a `PageEvent` whose zod schema
  `@repo/contract/events` declares: `server/lib/broadcast.ts` parses each as it publishes it, and
  logs and drops one that fails, which would otherwise end every page's stream at the contract's
  own check. The page hears them through `listen()` (`renderer/page-events.ts`), which reopens a
  stream that drops a second later, and asks main for everything again as each one opens, since
  what main sent meanwhile is lost.
- **The window** is main's own page, served on loopback (`server/page-server.ts`). The shell asks
  main for a `handoff` each time it makes the window, waiting ten seconds, and opens it there: a
  one-time link, spent at its first use and dead unspent after five minutes, whose answer sets the
  page's session cookie (HttpOnly, SameSite=Strict, a secret minted per boot) and drops the nonce
  from the address (`server/page-session.ts`). The founder's approve button is on that port, so the
  seal closes it to every run ([A run's seal](seal.md#a-runs-seal)); main answers only a request
  naming 127.0.0.1 or localhost at its own port, since any other name is a page that rebound its own
  onto loopback; its calls and events need the session and the page's own origin (`Sec-Fetch-Site`,
  else `Origin`), since another loopback port is the same site and carries the cookie; and the
  page's content security policy is main's (`@repo/contract/page-policy`). No capability grants the
  page a command of the shell's, and `removeUnusedCommands` leaves none in the binary. The window is
  pinned to main's origin, compared by its parts: a link to any other page opens in the browser,
  `window.open` makes no second window, and every device permission is refused
  (`src-tauri/src/window.rs`). Closing it hides it and the dock icon: the office keeps working in
  the menu bar, and Open brings the same page back, or makes it on a fresh handoff when a launch at
  login never did. Each boot binds a port of its own, so nothing of the page is kept between boots
  (`no-store`), and the page keeps nothing in the browser's storage.
- **The relay.** The shell starts main on node (`src-tauri/src/main_process.rs`): `node
  <server>/dist/index.js serve`, where `<server>` is `Contents/Resources/server` in the .app and
  `apps/cli` in a checkout (`src-tauri/src/runtime.rs`). It reaches no part of the page's API: it
  talks to main over main's stdio (JSON-RPC 2.0, one message a line, requests both ways:
  `server/relay/rpc.ts`, `src-tauri/src/relay.rs`), and main's stdout carries the protocol alone:
  anything else main or a library writes there is moved to stderr. Main asks the shell for what only
  a native app does (`server/host.ts`): a message box, the clipboard, Finder and the browser, the
  menu-bar icon (main decides it, `server/tray.ts`; the shell draws it, `src-tauri/src/tray.rs`), a
  notification, the login item, the Mac kept awake, a relaunch, and an update checked or installed.
  The shell says hello first, with what only it knows: whether it is the packaged app, the dev
  server's address in dev, whether the login item launched it, the Keychain's sealing key; main
  finds its own files beside itself (the skills in `resources/`, the built page in `dist/page`).
  Each end names every method once (`RELAY_METHODS` and its zod schemas in `server/host.ts`; the
  consts and serde types of `src-tauri/src/protocol.rs`), and both are pinned to one sample a
  method, `src-tauri/tests/fixtures/relay/<method>.json`: `server/host.test.ts` parses each with
  main's schema, `cargo test` reads each into the shell's types and writes it back unchanged, and
  each checks its own methods are the samples'. Both ends refuse a field they do not know. A
  notification the shell cannot read is logged as an error, as every line of the shell's is ("Main's
  log" below), and under `tauri dev` shown in a box too, once a method: main waits on no answer, so
  would never hear of it.
- **Main's lifetime.** Main boots on the hello; one that fails says where the log is, in a box, and
  the app quits, as does one not booted within a minute, killed with its process group first, since
  its quit would wait the stuck boot out. A quit asks main to stop its runs (`quit`) and waits up to
  45 seconds for the answer, then closes main's stdin, its lifeline, so a shell that crashed or was
  killed ends main too, after its runs; a main still there five seconds later is killed with its
  process group. Main leads a group of its own, so a Ctrl-C under `tauri dev` reaches the shell
  alone, which stops main once. There is no restart: main owns the save, and a second main under one
  that has not let go would be refused it (`server/save-claim.ts`).
- **Awake and at login.** The scheduler alone keeps the Mac out of idle sleep, and only while a
  run is in flight (`keepAwake`, `server/keep-awake.ts`: a user-initiated activity the shell
  holds, `src-tauri/src/keep_awake.rs`, never past a closed lid). Settings can open IdleBiz at
  login (`server/login-item.ts`): the macOS login item (`SMAppService`,
  `src-tauri/src/login_item.rs`) is its only record, only a packaged app registers one, and a
  launch at login starts in the menu bar.
- **Updates.** The packaged app updates itself through tauri-plugin-updater
  (`src-tauri/src/updater.rs`) from the feed tauri.conf.json's `plugins.updater` names, the latest
  GitHub release's `latest.json`, whose archive is signed with the key `plugins.updater.pubkey`
  checks; a build packed with no public key takes no updates. Main decides when the founder hears of
  one (`server/updates.ts`): it asks the shell (`host.checkUpdate`) at boot and every six hours,
  notifies once a version each launch, and offers it in Settings and as a menu-bar item, which both
  install through main (the shell tells main `update` on the item's click), so both show one
  status. A check that fails keeps a release already on offer. An install (`host.installUpdate`)
  downloads the release and checks its signature while the office keeps working; then the shell
  stops main as Quit does, installs the release over the app and starts it again. A download that
  fails leaves main running and has it ask the feed again, which may offer a newer release or none;
  an install that fails says so in a box and starts the app again on the version it has.
- **Main's log.** Main's console is its stderr, which the shell appends, stamped, to `main.log`
  (`src-tauri/src/main_log.rs`; `~/Library/Logs/IdleBiz/`; dev: `logs/` in the `IdleBiz (dev)`
  data folder, or in `roots/<id>/` beneath it for an isolated `IDLEBIZ_ROOT_DIR`), never under the
  save root, which a reset deletes; `server/lib/log.ts` sends uncaught errors there too. The
  shell's own lines go there too, since a Finder launch's stderr goes nowhere: through the `log`
  facade Tauri logs with (`src-tauri/src/shell_log.rs`: the shell's own down to info, other
  crates' warnings), and on stderr for a terminal launch. Runs read the file, so a line names a
  page by its origin alone. A catch that carries on past an unexpected error calls `report`
  (`server/lib/report.ts`); a boot that throws says where the log is and exits.

## The renderer's state

Main's answers live in one tanstack-query cache (`renderer/state/queries.ts`, keyed by
`@orpc/tanstack-query`'s `orpc`), where nothing goes stale on its own. The store
(`renderer/state/store.ts`) applies each patch `renderer/state/activity-reducer.ts` makes of an
event as cancelQueries, setQueryData, then invalidateQueries. `useSubmission` is built on React's
`useActionState`: the control is busy while main works and a refusal lands beside it as a
`<Failure>`. The office scene reads the cache through `read` and `watch` in `queries.ts`, and a
founding reads the company, its team and their work again before the scene restarts
(`companyFounded`).

## The budget

The tray and HUD label it `usage` (`usageLabel` in `@repo/domain/format`), never spend; the Budget
panel, the digest, onboarding and the HUD's tooltip say it is at API prices. A turn cut off before
its agent answers (the watchdog, Stop, a quit, a crash) still bills what its usage updates
reported, as uncached input (`usageMeter` in `@repo/agent-driver/acp-usage`).
