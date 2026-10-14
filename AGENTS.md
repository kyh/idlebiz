# AGENTS.md

**IdleBiz** is a retro RPG-style idle business sim where the employees are the player's own
coding CLIs. The app is two programs: `apps/desktop`, a Tauri shell around the office page, and
`apps/cli`, the `idlebiz` binary, whose `idlebiz serve` is main, the node process that spawns real
`claude` / `codex` sessions and saves the whole company as human-readable markdown under
`~/.idlebiz/`. Every other verb of `idlebiz` is a company tool the employees call. A small Next.js
landing page (`apps/web`) ships the download; the app sends it nothing.

This is the tool-agnostic guide for coding agents, meant to be run, not just read: the workflow
(run, verify and ship a change) and the map (where each thing lives and how each mechanic works),
each mechanic described once. The premises and decisions behind them, each with its reason, are
`CLAUDE.md`'s: read it first. Claude reads both.

Paths below are short: `server/…` and `commands/…` are under `apps/cli/src/`, `renderer/…` under
`apps/desktop/src/`, `src-tauri/…` under `apps/desktop/`, and `@repo/<package>/<module>` is
`packages/<package>/src/<module>.ts`.

> Naming: this file is repo documentation. The `AGENTS.md` files under
> `~/.idlebiz/company/agents/<slug>/` are game data — the in-game employee's own
> instructions (`server/paths.ts`) — and a product's workspace `AGENTS.md` is its team's notes
> ("A run's env, login and notes"). Unrelated.

## Quickstart

```sh
pnpm install
pnpm verify        # static gate: typecheck · lint · knip · format · test · build
pnpm dev:web       # landing page → http://localhost:3000
pnpm dev:browser   # the office in a browser → http://localhost:31100/ (signs the browser in to main)
pnpm dev:desktop   # the app's own window (tauri dev)
pnpm e2e           # builds the page and main, then drives them in Chromium (local only)
```

No database, no Docker, no server to provision: past `pnpm install`, the one thing to install is
Rust through rustup, since `pnpm verify` runs clippy and `cargo test` over the shell and
`pnpm dev:desktop` builds it (`apps/desktop/rust-toolchain.toml` pins the toolchain, and the first
`cargo` call installs it; on Linux, Tauri's prerequisites too: `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `libssl-dev`, `build-essential`).
There is no bootstrap script and nothing to seed.

**`pnpm dev:desktop` and `pnpm dev:browser` are not plain dev servers.** Each runs `pnpm dev:kill`
first (`apps/desktop/scripts/devkill.sh`), which terminates this checkout's desktop session —
`tauri dev`, its shell and the dev server, each with main under it — then kills any that remain
after ten seconds. Main stops its runs first on the TERM. `pnpm dev:web`, `pnpm verify`, tests
and a running `pnpm e2e` survive it. It leaves an unrelated process on TCP **31100**, the dev
server's port, alone, and startup fails while that port is occupied.

Both build main (`apps/cli`'s bundle, `apps/cli/dist`) before the page is served and again on each
change: `tauri dev` restarts the shell when main's bundle changes
(`--additional-watch-folders ../cli/dist`), and `dev:browser` restarts main itself. A change to the
page is hot-reloaded; a change to the shell's Rust rebuilds and relaunches it.

## The one hard prerequisite

The app is inert without a **signed-in `claude` or `codex` CLI on PATH**: it can't onboard, hire
or run anything. `packages/agent-driver/src/detect.ts` probes `claude auth status` /
`codex login status`; `agents.hasAuth` (`server/page-router.ts`) gates the UI behind
`renderer/ui/auth-gate.tsx`. IdleBiz stores no model-provider credentials of its own — every
run bills against the player's existing CLI login.

Preflight — run these three before deciding what you can verify:

```sh
claude --version          # or: codex --version — at least one must resolve
codex --version
agent-browser --version   # missing ⇒ npm i -g agent-browser && agent-browser install
```

A sandbox without those CLIs can still do the full static gate and can still drive the
CLI-free surfaces below; it cannot reach a populated office.

## Verify a change end-to-end

Static gate:

```sh
pnpm verify
```

`.github/workflows/ci.yml`'s `ci` job runs the same six steps on Linux on every push to main and
every PR, as named steps: keep the two lists in step. Its actions are pinned by commit SHA, which
dependabot moves (`.github/dependabot.yml`); a new step pins its action the same way. Vercel's
build of `apps/web` is a second remote check. `pnpm knip` checks unused files, exports and
dependencies.

Its `test-macos` job runs what only a Mac can: clippy over the shell's macOS code, `pnpm test`
with the seal and every gate suite (it installs `claude`, `codex` and `agent-browser` at versions
pinned there, signed in to nothing, and fails before the tests if one does not answer
`--version`, since a gate skips on a CLI it cannot run), and `pnpm smoke:desktop` on an ad-hoc
pack ("Packaging and release").

**The compiler's strictness is `tsconfig.base.json`** (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitReturns`, `noImplicitOverride`, unused locals and
parameters). Every workspace's tsconfig extends it but `apps/web`'s, which Next writes, and adds
only what is its own (`lib`, `types`, `include`, `paths`, the renderer's `jsx`). The code the page
runs (the renderer, `@repo/domain`, `@repo/contract`) extends `tsconfig.page.json`, the ES2023
ceiling of the window's WebKit; the renderer adds the DOM in `renderer/env.d.ts`.

**Lint is a clean gate.** `oxlint.config.ts` extends the ultracite presets (`ultracite/oxlint/core`, `react`, `anti-slop`; `next` scoped to `apps/web`); every rule is an error and `lint` fails on the first one. It is type-aware (`options.typeAware`, run by the `oxlint-tsgolint` devDependency): without it the presets' `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `no-deprecated` and `no-unsafe-*` are skipped without a word. Fix the code, don't add overrides; the deliberate ones, each with its reason beside it in the config:

- `no-await-in-loop` off: sequential awaits are intentional (ordered agent turns, paced writes).
- `switch-exhaustiveness-check` takes a `default` as exhaustive: it is how a consumer says every other kind means nothing to it. A switch that must name every kind has none; the activity reducer's table of slices is typed over every kind instead (`satisfies Record<ActivityKind, …>`).
- `no-confusing-void-expression` off: `() => set(x)` is the house style.
- `strict-boolean-expressions` off: truthiness checks on optionals are idiomatic here.
- `promise-function-async` and `strict-void-return` off: taste; a dropped or misplaced promise is still `no-floating-promises`' and `no-misused-promises`' to catch.
- `consistent-return` off: a bare `return` in a `T | undefined` helper is deliberate.
- `consistent-type-assertions` takes `assertionStyle: "never"`: no `as` and no `<T>x`, only `as const`; parse at the boundary or narrow with a guard. anti-slop's `require-safety-comment-for-type-assertion` is off with it, since a `// SAFETY:` comment no longer admits one.

Prefer fixing code over `oxlint-disable` comments; when a rule is genuinely wrong for a line, disable that line with a stated reason (`// oxlint-disable-next-line rule -- why`).

End-to-end suite — `pnpm e2e` builds the page and main, then drives them with Playwright in
Chromium (`tools/e2e/`): each launch starts the built main through the dev host
(`apps/cli/src/dev-host/host.ts`), which answers main's asks of a native app as the shell would,
and opens the built page main serves on the handoff link main hands it, as the shell's window
opens. `pnpm -F @repo/e2e e2e` reruns it on the last build. The shell itself (the window, the
menu-bar icon, the Keychain, the login item) is Rust's, held by `cargo test`, booted packaged by
`pnpm smoke:desktop` and driven by hand.
The suite covers the title screen, a founded company's
office (HUD, #team, one NPC per hire), Vercel and Stripe key entry (a key taken is sealed,
shown as set and, for Stripe, replaceable and removable; a key refused is never saved), Printful token entry
(a token Printful takes is sealed, shown with its store, replaceable and removable), a key pasted into
secrets.json being sealed, a held command denied from #team, an action card answered, keys
held into a window let go of when it closes, #team kept on its newest line and shown again when
its window reopens, a long ask kept on screen, a typed answer kept while the dialogue's menu is
hovered, the dialogue's cursor kept on Talk… as rows come ahead of it, Start refused while out of
budget, retiring the selected product, a file
boot skipped named in full, and a save a newer build wrote asking for an update. It is local only, not part
of `pnpm verify` or CI:

- It needs Playwright's Chromium (`pnpm -F @repo/e2e exec playwright install chromium`, once).
- Every test that founds a company (the office, the #team approval, the panels, Vercel,
  Stripe and Printful key entry, sealing) needs a signed-in `claude` or `codex` CLI under the
  macOS seal and skips without one, so off a Mac only the title screen and the newer save run.
- It needs no network and no real account. Every launch starts main with
  `tools/e2e/src/stub-services.ts` preloaded, which answers Stripe, Vercel and Printful from
  canned JSON: an account that takes any key, or, under `launch({ keys: "refused" })`, a Stripe
  and Vercel that answer every key with a 401. No test sends a key to a vendor: what each
  really answers a key it refuses is the unit fetch fakes' to hold (`stripe-key.test.ts`,
  `vercel.test.ts`, `vercel-connect.test.ts`, `printful-token.test.ts`).
- It runs beside `pnpm dev:desktop` and `pnpm dev:browser`: each launch serves its page on a port
  of its own, and opens an isolated root.
- It never spends. Each test gets a fresh `IDLEBIZ_ROOT_DIR` and founds through the page's API,
  called from the test with the page's cookie and origin (`apiOf`), with a hand-written team (no
  casting run), a $0 cap and autopilot off; the scheduler checks the budget before it spawns
  anything, so no run can start. It directs nobody, and every test ends by asserting its save
  logged no `run.start`.

Runtime, web — headless with [agent-browser](https://github.com/vercel-labs/agent-browser):

```sh
pnpm dev:web &
agent-browser open http://localhost:3000
agent-browser snapshot          # accessibility tree with @eN refs
agent-browser screenshot /tmp/web.png
```

Runtime, desktop — drive the office in a browser. `pnpm dev:browser` runs main as the shell does,
and main serves the page, its files from the dev server, as it serves the window. Open
`http://localhost:31100/`: each visit asks the main running then for a one-time handoff and lands
the browser on main's page, signed in, so after an edit to main restarts it, the same address
lands on the new one. The app's window is WKWebView, which no automation attaches to on the Mac,
so the browser is the one the agents drive; `pnpm dev:desktop` is for looking at the real window.

> **Use an empty temporary save root for desktop verification.** Boot starts the scheduler,
> which immediately drains queued work, even with autopilot off. Existing companies can
> launch paid CLI sessions. `IDLEBIZ_ROOT_DIR` overrides the default `~/.idlebiz` root.
> Isolation protects the real save, but onboarding and employee runs still bill the signed-in
> CLI. A dev launch on `~/.idlebiz` while the installed IdleBiz has it open refuses to boot
> ("The save").

```sh
IDLEBIZ_ROOT_DIR="$(mktemp -d)" pnpm dev:browser   # serves http://localhost:31100/
agent-browser open http://localhost:31100/
agent-browser snapshot
```

**The office scene** — only with a finished onboarding, i.e. a signed-in CLI. Under headless
automation Phaser's boot can stall (`document.hidden` never flips), so the canvas stays blank
until you step it:

```sh
agent-browser eval 'window.__game.scene.start("office")'
agent-browser eval 'window.__game.loop.step(performance.now())'
agent-browser screenshot /tmp/office.png
```

Don't stop at `pnpm verify` — for anything the player can see, drive it and look.

## What is verifiable without a signed-in CLI

| Surface                                | How to reach it                       | CLI needed? |
| -------------------------------------- | ------------------------------------- | ----------- |
| `apps/web` landing                     | `pnpm dev:web`                        | no          |
| Onboarding modal (first screen)        | boot with an empty `IDLEBIZ_ROOT_DIR` | no          |
| Office, HUD, dialogue, teams, products | finish onboarding                     | **yes**     |

The last row is a hard gate, not a convenience: `renderer/ui/onboarding.tsx` calls
`onboarding.hires`, which dispatches a real agent run (`server/agents/onboarding.ts`), and
`finalize()` bails when no hires come back. Use `IDLEBIZ_ROOT_DIR` for fixtures; there is no
bundled seeded save. Employee runs still use the signed-in CLI.

## Platform matrix

| Platform            | Dev command        | Agent-verifiable at runtime?                      |
| ------------------- | ------------------ | ------------------------------------------------- |
| Desktop, in browser | `pnpm dev:browser` | **Yes** — agent-browser at http://localhost:31100 |
| Desktop, its window | `pnpm dev:desktop` | By eye: WKWebView takes no automation on the Mac  |
| Web (Next.js)       | `pnpm dev:web`     | **Yes** — headless via agent-browser              |

The browser and the window run the same page, which main serves, over the same main: only the host
that runs main differs (the dev host, or the shell).

## Tests

No test needs a window or Phaser.

- `pnpm --filter idlebiz test` covers main: schemas, codecs, the command policy, store and
  integration behaviour under temporary save roots, real loopback and socket requests, the page's
  router and the `idlebiz` verbs against a live control plane. A test file opens its save with
  `tempSave` or `freshSave` and founds Kai's Acme with `foundAcme` (`server/test-support/save.ts`):
  `server/paths.ts` reads the root when a path is asked for and refuses one before any save is
  open, so a test that opens none fails rather than writing the founder's. Command policy rules
  each need a matching example; everyday commands must remain allowed.
- On macOS main's suite also runs the seal on canary files under a stand-in home (`seal.test.ts`)
  and main's login-shell probe on a stand-in home's startup files (`shell-path.test.ts`). Where a
  `claude` or `codex` CLI is installed, the gate suites (`server/agents/claude-gate.test.ts`,
  `codex-gate.test.ts`) drive the real CLI through the app's ACP adapter, sealed, against a
  stand-in model on loopback, billing nothing, on a scratch config that never touches its login.
  They fail once a command nests a sandbox or runs unasked (a push must reach `holdFor`), a
  founder's MCP server starts, a command escapes the seal, or a run rewrites the founder's config;
  claude's runs under founder settings that turn its sandbox on, and codex's checks that the seal
  refuses a patch moving a file into the save. Where `agent-browser` is installed, the real
  agent-browser runs under a run's seal (`browser-gate.test.ts`). All skip elsewhere; CI's
  `test-macos` job runs every one, on the CLI versions its workflow pins, which move by hand.
- `pnpm --filter @repo/agent-driver test` covers an ACP turn against stand-in agents
  (permissions, resume, teardown, how a turn ends, usage) and the failure classes.
- `pnpm --filter @repo/desktop test` covers the page's geometry and state, and its `test:rust`
  runs `cargo test` over the shell (the relay's framing and its samples, main's supervision against
  a stand-in main on node, the navigation pin, the runtime's paths, main's log).
- The root `pnpm test` runs every suite and `test:rust` through turbo, `TEST_CONCURRENCY` at a
  time (4 unless set), and replays any suite but main's whose inputs have not changed: main's gates
  run or skip on the CLIs this machine has. turbo hands every other suite only the env its config
  names, and main's the shell's whole env, as `pnpm --filter idlebiz test` does, so `CLAUDE_BIN`,
  `CODEX_BIN`, TMPDIR and `SSH_AUTH_SOCK` reach its gate and seal suites (`apps/cli/turbo.json`).

Drive anything requiring a window live instead, or cover it in the e2e suite.

## Configuration

Nothing is required to run. Every key is optional and its absence disables one feature
rather than crashing boot.

- IdleBiz's keys live in `~/.idlebiz/secrets.json`, not a `.env`, and are entered in the app
  ("Keys and what spends them").
- The shell's env reaches main, but for every `NODE_*` variable, which the shell and the dev host
  both drop (`scrubbed_env`, `mainEnv`): none loads code into main, and no `NODE_ENV` of a
  terminal's or vitest's reaches the runs, which inherit main's env less its credential-shaped
  names, as in a terminal launch ("A run's env, login and notes").
- `CLAUDE_BIN` / `CODEX_BIN` override the CLI paths, for main and the gate suites alike
  (`packages/agent-driver/src/detect.ts`).
- `IDLEBIZ_COUNT_TEST_MONEY=1` counts test-mode Stripe charges toward revenue and bets, for
  an end-to-end run of a revenue bet on a test key. Without it only live-mode money counts:
  a test-mode key reads as "Stripe is in test mode — no charge counts" in the brief and
  `measure_bet` refuses a revenue bet on it (`server/metrics.ts`).
- `IDLEBIZ_ROOT_DIR` overrides the save and secrets directory for isolated runs
  (`server/paths.ts`). Defaults to `~/.idlebiz`; use a fresh temporary directory for desktop
  verification.
- `apps/desktop/.env` (see `.env.example`) is release-only ("Packaging and release").

## Packaging and release

`pnpm -F @repo/desktop package` packs the app on a Mac (`apps/desktop/scripts/package.ts`),
signed with the keychain's Developer ID (none stops it, unless `IDLEBIZ_PACK_UNSIGNED=1` asks for
an ad-hoc pack) and notarized when `apps/desktop/.env` names the notary key: the id and issuer of
the App Store Connect key. Its `.p8` sits in `~/.appstoreconnect/private_keys/` (`package.ts`
reads it there alone), which the seal keeps from every run; never keep it in the checkout, which
runs can read. `release:publish` refuses a pack that is not both signed and notarized.

The pack stages the `idlebiz` package with `pnpm deploy` (`apps/desktop/scripts/stage-server.ts`)
into `Contents/Resources/server`: its bundle (the page staged inside it), its `resources/`, and the
dependencies it does not bundle — the ACP adapters main spawns (they bring their own zod and ACP
sdk). So `apps/cli` `dependencies` is exactly what the server ships: everything Vite bundles —
zod, oRPC, citty, the ACP sdk, `@repo/*` — goes in `devDependencies`, or the app ships it for
nothing, and `apps/desktop` has no `dependencies` at all, since the page is bundled whole.
`pnpm add` defaults to `dependencies`.

`pnpm smoke:desktop` packs and boots the .app on a scratch save
(`apps/desktop/scripts/smoke-packaged.ts`): every resource the server ships is in it, hello boots
main on the pack's node, the window loads main's page, a second launch hands over, and a quit
leaves nothing main started running. It refuses where an IdleBiz is running or the Keychain holds
IdleBiz's key, which an ad-hoc pack would wait on a prompt to read, so on a Mac that runs IdleBiz
it stops before it launches anything; the key its own launch makes it deletes as it ends, so a Mac
is left as it found it. CI's `test-macos` job runs it on an ad-hoc pack.

## Map

Turborepo + pnpm.

```
apps/
  desktop/       @repo/desktop — the app the founder installs: a Tauri 2 shell over the system
                 WebKit (src-tauri/, Rust), the office page (src/renderer/, React + Phaser) and
                 the pack and its smoke (scripts/).
  cli/           idlebiz — the server and the binary. `idlebiz serve` is main (src/server/); every
                 other verb is a company tool (src/commands/tools.ts); src/dev-host/ runs main as
                 the shell would; resources/ holds what main reads. The build is dist/index.js
                 with its chunks flat beside it, and the page staged as dist/page.
  web/           @repo/web — the landing page (Next.js on Vercel): the download and the trust
                 pages.
packages/
  domain/        @repo/domain — the vocabulary both sides share, pure.
  contract/      @repo/contract — the page's API, contract-first.
  agent-driver/  @repo/agent-driver — the ACP runtime, over domain.
  px-kit/        @repo/px-kit — the pixel UI kit both apps draw with.
tools/
  e2e/           @repo/e2e — Playwright over the built page and main, through the dev host.
```

- `apps/desktop/src-tauri` — the shell, Rust: the window over main's page, opened on the handoff
  main hands it, and its navigation pin (`window.rs`, `navigation.rs`), main as its one child
  (`main_process.rs` over the relay's framing in `relay.rs` and its messages in `protocol.rs`,
  `runtime.rs` for where node and the server are), what main asks of a native app (`host.rs`:
  message boxes, the clipboard, Finder, opening a path or a URL, notifications; `tray.rs`,
  `login_item.rs`, `keep_awake.rs`, `keychain.rs`), and main's log (`main_log.rs`). No capability
  grants the page a command.
- `apps/desktop/src/renderer` — the office page: a React overlay (`ui/`) over a Phaser 4 scene
  (`game/`, with the office's geometry: `office-depth.ts` the draw bands,
  `office-layout-schema.ts` the shape of office-design.json, `office-grid.ts` walking as pure
  math), main's answers in one tanstack-query cache (`state/queries.ts`), the window's own state
  and main's events applied to that cache in `state/store.ts`, and main reached through `api.ts`,
  its events through `page-events.ts`.
- `apps/desktop/scripts` — the pack: node fetched (`fetch-node.ts`), the server staged
  (`stage-server.ts`, as Resources/server), everything signed (`sign-resources.ts`), the crates'
  notices (`rust-notices.ts`), the bundle and notarization (`package.ts`), the release
  (`publish-release.sh`), the smoke (`smoke-packaged.ts`), and `devkill.sh`.
- `apps/cli/src` — the `idlebiz` binary: `index.ts` and `program.ts` (citty; help, version and
  every failure on stderr), `commands/serve.ts` (loads main), `commands/tools.ts` (one verb per
  company tool, a client of the control plane), `paths.ts` (the package's own files), and
  `dev-host/host.ts` (main as the shell runs it, for `pnpm dev:browser` and the e2e suite, which
  ask it for the handoff the shell's window opens on).
- `apps/cli/src/server` — main. `serve.ts` (boot on the shell's hello, the relay, quit),
  `save-claim.ts` (boot's claim on the save), `host.ts` (what main asks of the app that runs it,
  and every message of the relay's), `relay/` (its end of the stdio channel),
  `page-server.ts` (the window's page on loopback: the handoff and the guards;
  `page-session.ts` the sign-in), `page-router.ts` (the page's contract implemented, its event
  stream fed by `lib/broadcast.ts`; `lib/answers.ts` words what does not return),
  `store/store.ts` (the one company in memory, every command on it, and its writes),
  `store/*-codec.ts` (one strict zod schema per package kind, which its encoder is typed against
  and its decoder parses; `company-codec.ts` owns the save format stamp),
  `paths.ts` (the on-disk save format, documented at the top), `scheduler.ts` (the idle loop,
  which alone keeps the Mac awake, through `keep-awake.ts`), `founder-actions.ts` (what the
  founder hands the team, filed and queued through the scheduler), `company-actions.ts` (a change
  everyone hears about), `agents/` (runs: `runner-pool.ts` the runners, their rests and each
  task's turn, `session.ts` an ACP session under its seal and every permission ask it raises,
  `run-workspace.ts` the folders and env main readies a run, `ask-box.ts` its one ask of the
  founder), `control-plane.ts` (HTTP on a unix socket per run, which the agents' `idlebiz`
  command calls back into; `agent-launcher.ts` writes that command at boot),
  `tool-specs.ts` (every company tool, described once) and `tools/` (each bound to its
  implementation: `define.ts` the binding, the asks and the holds, then the team's, portfolio,
  Vercel, money and print tools), `policy/` (the command policy: `reading.ts` the words
  `shell-lexer.ts` reads from a line as bash would, read loosely as well where another shell may
  split it apart, `shell-rules.ts` the rules over them, `browser.ts` the agent-browser gate and
  the live page it reads, `index.ts` `holdFor`), `refusal.ts`,
  `agents/seal.ts` (the Seatbelt profile each run starts under, and its boot check),
  `agents/bundled-skills.ts` (where IdleBiz's skills ship), `agents/claude-user-settings.ts`
  (what of the founder's claude settings a run still carries: its sign-in and model),
  `activity.ts` (the one publisher), `prompts/` (what employees are told), `lib/fs.ts`
  (every write, atomic and behind the reset gate), `lib/vendor-call.ts` (how a Stripe or
  Printful call failed, sorted once), `vercel-connect.ts` (the Vercel token the
  founder pastes and each product's project binding), `vercel-api.ts` (what every Vercel call
  shares), `stripe-api.ts` (what every Stripe call shares), `stripe-key.ts` (the Stripe key the
  founder enters, which charges and reads revenue),
  `deploy.ts` (the Vercel API calls the `deploy` tool makes),
  `vercel-env.ts` (the Vercel call `set_env` makes, and the values a deploy may not ship),
  `env-name.ts` (what set_env may name),
  `stripe-links.ts` (the Stripe calls `create_payment_link` and `sell_print` make, and the
  switch-off of a retired product's links), `link-record.ts` (a payment link as the save keeps
  it: a `create_payment_link` link on its own, a listing's inside the listing),
  `printful.ts` (Printful's API: its catalog, and pricing a print),
  `printful-orders.ts` (Printful's order calls), `stripe-checkouts.ts` (the read of Stripe's
  checkout sessions and a payment's charges), `order-pump.ts` (each paid print order to Printful,
  each link sale's delivery, and the founder's order cards),
  `printful-token.ts` (the Printful token the founder enters and the one store it sells
  through, kept as one credential), `print-listing.ts` (what `sell_print` checks before it
  lists), `secrets.ts`, `metrics.ts`, `tray.ts`, `login-item.ts` (open at login).
- `apps/cli/resources` — what main reads beside its bundle: IdleBiz's skills (`skills/`).
- `apps/web` — the landing page, its trust pages and their Markdown for agents; it holds no
  secret and the app calls none of it.
- `packages/domain` — zod only, importing no other package of the repo's: `domain.ts` (the
  company, its people, products and tasks), `runners.ts` (the runners' ids and the names the
  founder knows them by), `bets.ts` (the bets, their judge and the allocator),
  `activity.ts` (the event grammar), `digest.ts`, `hire.ts`, `integrations.ts`, `hold-rules.ts`
  (every rule that holds a call, what its card says and whether signing leases it; data only,
  for the page), `format.ts` (money's formatting), `errors.ts`, `json.ts`, `character-frame.ts`
  (a sheet's frames: the box, the walk and sit strips, the origin and soles) and
  `character-seed.ts` (which sheet a sprite seed wears, which the save keeps, and the founder's
  looks).
- `packages/contract` — the page's API: the oRPC contract (`contract.ts`, one folder per domain),
  its routes (`routes.ts`), the page's content security policy (`page-policy.ts`), which main
  stamps on the page and the dev server writes into it, and the schemas of its event stream
  (`events.ts`).
- `packages/agent-driver` — spawns the `claude` / `codex` ACP adapters (a turn over
  claude-agent-acp or codex-acp, the runners' registry), normalizes events and tool asks, prices
  usage, and classes failures (auth, access denied, usage limit, overload, context, other) with
  when a usage limit said it lifts; what each costs the runner (a sign-out, a rest) is the
  server's `heed`. Over domain, never imported by the page. Source-only, no build step.
- `packages/px-kit` — the pixel-UI design system as one stylesheet (palette, `@theme` tokens,
  VG5000, every `.px-*` class), imported by both apps after Tailwind.
- `tools/e2e` — the Playwright suite over the built page and main (`src/harness.ts` launches them
  through the dev host; `src/stub-services.ts` answers every launch's Stripe, Vercel and
  Printful calls from canned JSON).

## How it works

Each mechanic below is described here and nowhere else; `CLAUDE.md` holds the decision behind it.

### The save

Game state lives on disk at `~/.idlebiz/company/`, beside `cache/` (the runs' tool caches) and
`bin/` (the `idlebiz` command main writes the runs at boot), as agentcompanies/v1 markdown
packages:

- `COMPANY.md`, and beside it what the founder configured (`approvals.json`); company-level
  running state goes in `state/` (path helpers in `server/paths.ts`).
- `agents/<slug>/AGENTS.md`: its frontmatter is the employee, its body a mirror of the
  instructions each run is given, rendered live and rewritten at boot.
- `tasks/<slug>/TASK.md` for open work, `shipped/<slug>/TASK.md` once done, answered, settled or
  dropped.
- `products/<slug>/PRODUCT.md` for each product, the first included, with its code in
  `products/<slug>/workspace/` (placed by the slug alone, so retiring it moves one folder), whose
  root `AGENTS.md` is the team's notes on it.
- `listings/<id>.json` for each print a product sells through Printful, `links/<id>.json` for
  each `create_payment_link` link (by Stripe's id), and `orders/<id>.json` for each paid checkout
  on one of the company's links, a listing's or `create_payment_link`'s. They sit outside the
  product's package, so all outlive its retirement: its links are switched off from them, and
  each order still ships or is still owed. Runs read them, never write them.
- `shared/` for what teammates share across products, `bets/<slug>/BET.md`, `retired/<slug>/`
  for killed products with their code, `routines/`, `activity.jsonl`.

A root holds one save or none: `company/`, a fixed folder founding publishes with one rename and
boot reads alone (`server/paths.ts`), so no record carries a company id and no path names one.
Its paths are read when asked for, never at import, and refused until a save is open: serve opens
its launch's (`IDLEBIZ_ROOT_DIR`, or `~/.idlebiz`) first, a test its own. Founding refuses while
it exists, and one boot cannot read (its COMPANY.md missing or refused) blocks the office like a
save of another format. So does a COMPANY.md stamped below this build's format, or not at all,
in another folder of the root: a save from before `company/`, which would otherwise be founded
beside. A reset deletes the whole root, `secrets.json` included; to start over otherwise, move
`company/` out.

COMPANY.md carries `format` (`SAVE_FORMAT`, `store/company-codec.ts`), and a save stamped at any
other blocks loading and founding (`SaveFormatError`). Each codec reads its kind through one
strict zod schema, the one its encoder writes to: a package it refuses (a hand edit, a field
missing) is skipped and named in the load report, never read with a default. A frontmatter key
the app does not know is still dropped on the next write of that file. Boot alone repairs what a
hand edit or a release with no lead leaves (`initStore`): a run that names no lock is queued
again, and queued or running work nobody holds is to do. No repair stands in for a package it
skipped: a lead whose AGENTS.md did not read stays lead, and a teammate's open work stays theirs.

Only closed work is history. `done` tasks move to `shipped/` and load on demand; so does an ask
the founder answered, `superseded` by its continuation, an order card the founder `settled`, and
work the steering loop `dropped` (its bet stopped taking work, its product was retired, its
assignee released), none ever a ship. `dead` tasks — runs that failed on their own — stay in the
active queue until their bet stops or their product retires, because the Inbox can retry them and
employees use them to identify unresolved problems. `listOpenTasks` answers open work only; the
one reader of history is `shippingLog`, which sends each ship as a line without its brief.

One main holds a save at a time. Boot claims it before it reads it (`server/save-claim.ts`: a
socket main listens on in `<save>/.main/` while it runs, which a second main on that save finds
answering), so a main on a save another holds (`pnpm dev:desktop` while the installed app has
`~/.idlebiz` open) refuses to boot and says so, rather than run each task twice; one a crash left
holds nothing. Each main's socket has a name of its own that appears only once it answers, so a
file there that answers nothing never will and any main clears it, and mains claiming at once
each step back a random while and try again, so one holds and never two. A
second launch of the packaged app hands over to the first, which shows its window
(`tauri-plugin-single-instance`, `src-tauri/src/lib.rs`); a development shell skips it, since it
keys on the bundle id machine-wide and would hand over to an installed IdleBiz.

### Activity and running state

`publishActivity` (`server/activity.ts`) stamps, persists and fans out one `ActivityEvent`
(`@repo/domain/activity`, a discriminated union on `kind` with typed payloads). Consumers switch
on `kind`; nobody re-parses a payload.

State that outlives a run is written where it is known: the founder's digest folds into
`state/since-last-look.json` as each event publishes (`store.logActivity`,
`server/store/digest.ts`), and what a run leaves for the next — the session to resume and a
digest of the instructions it holds, where the real numbers stood, what they last shipped — sits
in `agents/<slug>/run-state.json`, so AGENTS.md changes only when the instructions do. A resumed
session is sent them again only when that digest no longer matches. The brief's "recently
shipped" lines come from `state/recent-ships.json`, written with the ship. Nothing reads
`activity.jsonl` back: main appends to it and pushes each event to the renderer, whose activity
ring starts empty every launch; #team reads the room back from main's copy of `chat.jsonl`
instead.

### The store and the company's tools

The store (`store/store.ts`) holds the one company this launch runs, so nothing in its API takes
a company id: `getCompany()` is null before one is founded, and everything else throws "no
company is loaded" — a caller that can run without one (tray, boot, the pulse) asks first.
Lookups (`getX`) return null, `requireX` and commands throw, and null otherwise means only that a
claim or lock race was lost. It refuses with a `RefusalError` (`server/refusal.ts`) worded as the
sentence the agent should read; a tool turns that into its answer, refused, the page's API into
the founder's note. Anything else thrown is a fault: answered the same way, as a fault, but
reported to main's log.

A company tool is described once, in `server/tool-specs.ts`: body, lead-only refusal, doc and
example. The agents' instructions are rendered from it, `server/tools/` binds each implementation
to its spec (`define`), `idlebiz <tool>` is the client a run types it with (`commands/tools.ts`),
and `control-plane.ts` is only transport, which serves each tool at its name alone (`toolPath`:
posted to `/v1/<tool_name>` on the run's socket), so `callTool` takes a `ToolName` and what it
answers is shaped once (`ToolAnswerSchema`) for both ends.

- Main writes a launcher at each boot (`server/agent-launcher.ts`, `~/.idlebiz/bin/idlebiz`),
  which runs the CLI on main's own node and goes first on each run's PATH. The verb sends its
  request to the control plane its run was handed (`IDLEBIZ_API_SOCKET`, `IDLEBIZ_RUN_TOKEN`), over
  that run's own unix socket only ("A run's seal" says why the socket names the caller). `-` reads
  the request from stdin, and `idlebiz <tool> --help` prints the tool's doc. It sends the request
  as its shortest JSON (`encodeRequest`), however the agent spaced or escaped it: that is what the
  control plane's 64 KiB limit weighs and set_env's 60 KiB value limit counts, so a value set_env
  takes fits in a call.
- Every call ends in one of `TOOL_OUTCOMES`, the verb's exit code, which the instructions render:
  done (0) is what the implementation returns, refused (1) a `RefusalError` or the lead-only
  refusal, a fault (2) anything else thrown, reported to main's log, and held (4) a call waiting
  on the founder (a sign-off, an integration: `holdFor` in `server/tools/define.ts`). An ask that
  did not reach the founder is refused; `ask_boss` and `request_integration`, whose call is the
  ask, are done once it does. The verb prints the answer on stdout whichever it is, so
  `idlebiz deploy && …` stops at a deploy awaiting sign-off. A call that never reached main, or
  that main could not take (a body that does not parse), exits 1 with why on stderr.
- A change everyone should hear about (a bet, a product, autopilot) goes through
  `server/company-actions.ts`, whoever made it: a tool, the scheduler or the founder's page. Its
  `postToRoom` is the team room's only writer, and names the speaker (founder, office or
  employee).
- What the founder hands the team (a room message, a direct request, an answer, a sign-off, an
  assignment, a connection resuming the asks it answers) is `server/founder-actions.ts`, which
  files and queues through the scheduler's `file` and `enqueue`. The scheduler keeps the tick,
  admission, autopilot and the runs, and is handed at boot the integrations a run's tools call out
  with (`Integrations` in `server/tools/define.ts`), so tests fake them.

### Bets steer the company

`@repo/domain/bets` is the whole steering loop, pure: a bet is one hypothesis about one real
number (`users` | `revenue`) of one product, with a spend cap and a window. Its target has a
floor, `MIN_BET_TARGET` (10 whole users, $5), which `open_bet`'s body refuses below.

- **The verdict.** `judge` runs every scheduler tick against the live product numbers: won when
  the number moved by the target, killed when its window closes short — on a reading taken after
  the close (the pulse reads at boot and re-reads Stripe past its cache for it), since a cached
  read can miss the money that decides it. A measuring bet's reading stops at its close — visits
  up to `until`, charges made by it — so however late that read comes, nothing after the window
  counts. Without one, the verdict holds for a second window (`windowHours` past the close), then
  the bet dies on its last reading with a reason naming the source that sent nothing — but only
  once the pulse has asked for `KILL_GRACE_MS` without a break (`pulsingSince`), so a window that
  closed while the app was quit or asleep waits on a read, not the wall clock. The founder or the
  lead can still kill a held bet by hand.
- **The window.** Only the lead starts one (`measure_bet`): spending out the budget stops the
  work but not the clock, because the step that moves the number may still be waiting on the
  founder and a window over nothing shipped is a false verdict. Nor does it start one over a
  number no source reads (`measureRefusal`: the company's Stripe key, live unless test money
  counts, and the product's Vercel project). A spent-out bet gets the lead a "settle" run:
  measure or kill. One that ends done with neither closes the bet unmeasured
  (`closeUnsettledBet`): no window ran, and briefing the lead again would bill the bet a run
  every tick.
- **The mark** (`Bet.claim`). A users bet owns a landing path (`/b/<slug>` unless it names one)
  and reads visitors under it since it opened; a revenue bet reads captured live-mode USD charges
  tagged `metadata[bet]=<slug>`, the tag `create_payment_link` and `sell_print` set on every
  payment of a link made for that bet. A named path over the whole site or `/b` is refused
  (`namedPathRefusal`), and so is one overlapping a path a live bet covers or a closed one named
  (`holdsItsPath`): each counts visitors the bet did not bring. The team's own visits never count;
  the standing instructions say how to check a path without recording one. Readings arrive with
  the metrics pulse and live on the bet (`reading`, taken at `readAt`), so `judge` needs only the
  bet and the pulse's clock. Vercel's analytics API wants `since` and `until` together and filters
  in OData; path filters are free, utm ones are a paid add-on — which is why the mark is a path.
- **Revenue.** Per-product revenue reads the same charges over the account's whole history,
  tagged `metadata[product]`, while bets read only charges since the oldest live revenue bet
  opened; untagged money counts for the company only. Test-mode money counts nowhere unless
  `IDLEBIZ_COUNT_TEST_MONEY=1` ("Configuration"); without it a test-mode key gives a bet no
  reading, not a zero, so a bet only it could read closes unmeasured, never as a loss.
- **Where a run goes.** `allocate` decides everything about it, and the scheduler only carries
  it out: work on the best open bet (product yield + exploration bonus − crowding, runs in flight
  counted against the budget at ~$1 each), else the lead settles a spent-out bet, else the lead
  opens the next one (a run of straight losses asks for new ground), else wait. That budget check
  is `hasRoomFor`, and `delegate` asks it too: a bet without room refuses the handoff rather than
  let its work run unfunded. The portfolio's caps (5 live products, 3 live bets a product) are the
  store's: `createProduct` and `openBet` refuse past them, the founder's New product too, and a
  proposal offers new ground as a new product only while `portfolioHasRoom`.
- **Waiting on the founder** is modelled in `allocate` once: a bet with a blocked task gets no
  hands — settle runs carry their bet, so that covers them — and a lead whose last proposal is
  blocked is not asked again. Nor is one whose last proposal ended done with no news on the
  ledger since it was briefed (`proposalIdle`: no bet opened or closed, no product started), the
  same brief getting the same answer, until it is `PROPOSAL_RETRY_MS` (15 minutes) old, since the
  room or a connection may have moved meanwhile. A proposal that ends done is noted in
  `state/last-proposal.json` (`store.lastProposalDone`), so allocating reads no history.
- **Work a bet no longer funds.** A bet that leaves open (measured, killed, judged) drops its
  waiting work, and a run still on it that fails, parks or is cut off by a restart is dropped
  instead of queueing again, as is one that asks the founder once the bet has closed; measuring
  keeps what waits on the founder and the continuation carrying their answer, whose run is dropped
  only when it fails, since that step may be what moves the number. A continuation names the ask
  it answers (`answers` in its TASK.md, set only by `resolveBlockedWithAnswer`), so measuring,
  parking, a restart and a release read it there and never load `shipped/`. Retiring a product
  drops its waiting work and switches off its payment links, and the retiring run's own task, on
  no bet, is dropped the same way when it fails, parks, asks or is cut off, since a retry would
  run in the company's folder. A release drops the leaver's unstarted work and any ask no bet
  funds; a funded ask, and the continuation carrying the founder's answer to one, go to the lead.
- **`dropped` is history, not a failure**: the Inbox never offers it back and the lead's brief
  never lists it, since reviving it would only bill what takes no more work; the lead delegates
  the idea again under a live bet. `dead` is only work whose runs failed on their own, and stays
  revivable while its bet is open and its product live: a bet that leaves open or a product that
  retires drops its dead work too, since `claimTask` refuses anything else a run would bill.
- **The replay.** `dream` replays a fixed set of `explore` weights against the measured verdicts
  and swaps only to a strictly better scorer, so the incumbent never loses to a tie. A bet closed
  unmeasured (`moved === null`: killed before any source reported its number, or left unsettled)
  says nothing about its hypothesis, so neither the replay nor `allocate` (product yield, the
  plateau's run of losses) counts it. The replay scores only work picks and floors a pick's cost
  at one run's, so a win nothing paid for cannot price itself at zero; the plateau (three straight
  losses) only shapes a proposal, so it is a constant, not policy. It never retunes below eight
  measured verdicts.

### How a product earns

`BUSINESS_MODELS` in `server/prompts/instructions.ts` tells each run how its type makes money with
the tools there are: software sells once through `create_payment_link`, a game studio a web
game's paid unlock, ecommerce prints through `sell_print` to US buyers or sells digital goods
through a link, custom whichever fits, and VC sells information only (deal memos, teardowns, a
paid newsletter). `instructions.ts` teaches the tools as one flow: an `ask_boss` action card for
any step only a human can take, `set_env` for a key the founder hands back, `sell_print` and
`read_orders` for prints, and a link's `delivery` for what the founder sends each buyer, never an
`ask_boss` card, which would block its bet. No prompt tells a run to push: the founder pushes by
hand (`instructions.test.ts` checks both).

**Checking who paid.** A product tells who paid on its own server (no tool makes a webhook): a
link's `afterPaymentUrl` sends each buyer back to a route of the product's with `session_id`, and
the route reads that checkout session with a restricted key of the product's own (Checkout
Sessions: Read, which the founder makes on an `ask_boss` action and the team keeps with
`set_env`), unlocking only a session `paid` on its link. It asks Stripe once per purchase, since
reads count against the founder's whole account, then trusts a cookie it signs with a secret of
its own; a session still `unpaid` (a bank debit clearing) is kept to check again, and a 429 or
5xx is never "not paid". A paid session id unlocks for whoever holds it, which the instructions
say, with how to tie a purchase to one buyer where the product has sign-in or a database. The
instructions teach it under "Checking who paid", with a Next.js route. What only the founder can
hand over, a link's `delivery` says, and the order pump cards the founder for each paid checkout
on it.

**Action cards.** `ask_boss` takes a question or an action (`{action, instructions, draft?}`): a
step no tool takes, such as posting from the founder's accounts, signing up, buying a domain or
verifying an email. The founder answers Done, with an optional note that reaches the run as
written (a product's own key included, by the founder's choice), or Can't, with why
(`resolveAction`). That note lands in the continuation's TASK.md, which every run can read, and
the card says so: sealing it elsewhere would narrow nothing while the runner's own transcript
holds the prompt. Only a run's first ask reaches the founder; every tool that asks says so when
its ask was dropped. The task blocks like a question's, so its bet gets no hands meanwhile.
TASK.md keeps an action behind `[action] ` as JSON, and escapes any question starting with `[` behind `[ask] `,
so no agent's text reads back as an action, an approval or a connect ask.

### Skills

IdleBiz's skills live at `apps/cli/resources/skills/.agents/skills/<name>/SKILL.md` (Agent Skills format: frontmatter
`name` and `description`, then the body), shipped in the .app with the server
(`apps/desktop/scripts/stage-server.ts` stages the `idlebiz` package, `resources/` and all) and
found by `bundledSkillsDir` (`server/agents/bundled-skills.ts`) beside the server that runs. The
hidden `.agents` is forced: codex-acp takes skills only from `<folder>/.agents/skills` of a folder
a session is handed, and `.agents` is also the claude plugin `idlebiz`
(`.agents/.claude-plugin/plugin.json`), whose skills folder is the same one; claude names each
`idlebiz:<name>`. Adding one is adding its folder there; the gate tests prove both runners are
offered each one shipped. No `allowed-tools` and no `!` shell lines in a SKILL.md
(`bundled-skills.test.ts` holds each to that, and to a `name` matching its folder). The first,
`digital-product`, is the playbook for selling a guide, template or unlock direct, through the
product's own page and create_payment_link, so a bet counts each sale.

### A run's seal

Every run starts sealed. `acpAgentFor` starts each ACP session, a task's or the hiring
one-shot's, under `/usr/bin/sandbox-exec -p` with a profile `server/agents/seal.ts` renders per
run, every path a `-D` parameter. Each run resolves its own (`machineSeal`), so a path that became
a symlink since boot is sealed where it leads from the next run on.

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

### A run's env, login and notes

- **Env.** A run starts from the founder's (main's) env less every credential-shaped name —
  `TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `APIKEY`, `PAT`, `DSN`, `WEBHOOK`, `CREDENTIALS`, `AUTH` as
  whole `_` segments, so `SSH_AUTH_SOCK` too — and every URL with a login in it but a `*_PROXY`,
  except its runner's own login (`providerEnv` in `packages/agent-driver/src/registry.ts`;
  `runEnv` in `server/agents/run-env.ts`). AWS access keys sign for the whole account, so neither
  runner keeps them, and the seal hides `~/.aws` (`LOGINS` in `seal.ts`), so no AWS profile loads
  either: a founder on Bedrock signs in with `AWS_BEARER_TOKEN_BEDROCK` only. On Vertex,
  `GOOGLE_APPLICATION_CREDENTIALS` must name a key file outside the sealed logins: gcloud's
  default credentials under `~/.config/gcloud` are hidden too.
- **A claude session** loads no setting source (`settingSources: []`,
  `packages/agent-driver/src/registry.ts`): not the founder's user settings (their CLAUDE.md and
  rules, skills, plugins, hooks, permissions), nor a project's or a local one, which a run could
  otherwise write for the next to load. What remains is managed policy and the flag tier its
  session options set: claude's own sandbox off, ask rules for shell and edits, no bypass mode, no
  plan mode (its exit asks to approve a plan, which would block the task on a founder card that
  changes nothing), no skills of claude's own (`disableBundledSkills`), IdleBiz's as a plugin, and
  none of their MCP servers or claude.ai connectors (`strictMcpConfig`,
  `disableClaudeAiConnectors`, a deny of `mcp__*`), which act signed in as the founder; the company
  is reached with the `idlebiz` command ("The store and the company's tools"). A sign-in kept in
  their settings rather than their shell still reaches the run (`claudeUserSettings` in
  `server/agents/claude-user-settings.ts`): their settings' `env` (a Bedrock or Vertex switch, a
  gateway's URL and token), through `runEnv` as the shell's env goes, filtered alike, and the
  helpers claude runs for a key or a cloud login (`apiKeyHelper`, `awsAuthRefresh`,
  `awsCredentialExport`, `gcpAuthRefresh`), which run sealed, so one that reads `~/.aws` or
  gcloud's login fails as it did. So does the model they picked, with its effort (`model`,
  `effortLevel`, `modelSettings`, `alwaysThinkingEnabled`, `modelOverrides`), in the flag tier:
  claude would otherwise run its default, and claude-agent-acp, which reads their user settings,
  sets a model only when it thinks claude picked another. A deny rule in managed settings outranks the flag tier's ask rules and would
  refuse a company tool's `idlebiz` command before IdleBiz is asked, the turn still ending as
  done, so a claude run under one does not start, and says which rule (`refuseDeniedTools` in
  `server/agents/claude-denies.ts`).
- **A codex session** loads the founder's codex config with every MCP server turned off by the
  name `codex mcp list` gives it, and apps, plugins and memories whole (`codexSessionEnv` in
  `server/agents/session.ts`): turning plugins off is also what keeps their plugins' skills out.
  One it cannot list refuses the run with codex's reason. No codex setting leaves all the
  founder's own skills out, nor their instructions or rules, so the seal keeps a codex run from
  reading them (their memories too), and IdleBiz's folder is handed to the session to read
  (`readDirs`). The codex gate test plants each of these and checks none reaches the model, and
  that a push their rules allow still asks.
- **Team notes.** A product's notes for teammates are `AGENTS.md` at its workspace's root, for
  both runners: codex reads it itself, and a claude session, which loads no project's CLAUDE.md,
  is handed it beside its system prompt (`systemPrompt.append` in its session `_meta`), read by
  main as the run starts (`readTeamNotes` in `server/agents/team-notes.ts`), framed as the team's
  notes, never the founder's word (`server/prompts/team-notes.ts`), and cut at 32 KiB, before a
  character the cut would split. Main picks it as codex does, `AGENTS.override.md` in its place
  when there is one, and codex's session config pins what their config could change
  (`project_doc_fallback_filenames` empty, `project_doc_max_bytes` at the same 32 KiB), so both
  runners read the same notes. Main reads it unsealed, so only a file of the workspace's own root:
  through a link only to a file beside it (the common `AGENTS.md` -> `CLAUDE.md`), never one
  leading further, where a folder on the way could turn into a link between resolving and opening,
  and never a hard link. The standing instructions say it is the team's word, not the founder's,
  and have every teammate keep it as a plain file, fold an override into it and leave a CLAUDE.md
  as `@AGENTS.md`, which the founder's own claude follows.
- **Signed in.** A runner is signed in only if its login probe, run sealed as its runs are, says
  so: a codex login kept in the Keychain reads as none (a codex run reaches no Keychain), and
  onboarding's sign-in says to keep it in a file. The work of a runner not signed in waits on the
  queue, spending no attempt (`signedIn` in `server/agents/runner-pool.ts`), until a sign-in finds
  it again. A turn whose login the provider refused (a revoked token, `claude auth logout`
  mid-session) reads the runner as signed out the same way (`heed`) until the founder signs it in
  again, however often its probe, which reads only the login stored, says signed in: the sign-in
  runs its login for it anyway. With no CLI left the gate asks for that sign-in; with another
  still signed in the HUD names each signed-out runner someone works on and who waits on it, the
  lead's steering included, beside a Sign in button.
- **Failures and rests.** A failed turn is classed by what its adapter says before its prose
  (`packages/agent-driver/src/rate-limit.ts`: claude's `errorKind`, codex's typed failure's
  category and actions; claude's kinds mirror claude-agent-acp's `providerFailureCategory`). The
  package reports only the class and, for a usage limit, when the provider said it lifts; what
  each costs the runner is decided in one place, `heed` in `server/agents/runner-pool.ts`:
  - `auth` signs the runner out as above.
  - `usage-limit` (a rate limit, billing, an account on hold) rests it until the reset the
    provider reported (claude's `_claude/rateLimit` on usage updates, in epoch seconds; codex-acp
    keeps its rate limits to itself, so its text) or else the time its text names, never past 12h.
    claude-agent-acp forwards that rate limit only once the turn has had a model response, so a
    turn refused on its first request, as a retried task's usually is, names a reset only in its
    text; one naming none rests the runner 30m, since a retry refused again costs one spawn and no
    tokens.
  - `overloaded` rests it 1m, doubling with each one in a row up to 15m (`backoffMs`) and starting
    over once a turn ends any other way, since a busy provider clears in minutes.
  - `access-denied` (an organization yet to verify, a Bedrock/Vertex/Foundry credential claude
    could not load) neither signs it out nor spends the session, since signing in again cannot
    repair it, but rests it on the same backoff, so a credential blip clears and a standing
    refusal is not hammered, and #team tells the founder what the provider said.
  - `context` spends the session.

  A rest never shortens one holding, and is kept in `state/runner-rest.json`, so a restart does
  not spawn each parked task once to be refused; it is not critical: lost, that is all it costs.

### Keys and what spends them

**Keys.** The keys IdleBiz holds live in `~/.idlebiz/secrets.json`, which the seal keeps from
every run. They are IdleBiz's own: main reads each where it uses it (`getSecret` in
`server/secrets.ts`) and exports none into any env, so no employee holds `STRIPE_SECRET_KEY` or
`VERCEL_TOKEN`. A key is named only by its constant there, or by a set_env value's `ENV/` name,
so a misspelt name fails typecheck rather than reading as no key.

- Each value is also sealed with a key the macOS Keychain keeps for IdleBiz (service "IdleBiz",
  account "sealing-key": 32 random bytes, which the shell reads and hands main at hello as
  `sealingKey`), since a claude run can still reach the Keychain: AES-256-GCM with a random nonce
  and the key's name as associated data, as `sealed:v2:<base64 of nonce, ciphertext and tag>`
  (`sealerFor` in `server/secrets.ts`, `setSealer` at boot).
- Keys are entered in the app: `VERCEL_TOKEN` through a product's Vercel button (under users),
  Stripe and Printful in the Budget panel (under revenue). A key pasted into the file as plain
  text is sealed the next time main reads it. One main can't open (another build or another
  scheme sealed it, a byte of it changed, it was moved under another name, or access was denied)
  reads as absent, is named in Settings and stays as it is: enter it again. A `secrets.json` that
  fails to parse is listed in Settings and never rewritten (`readJsonFileForUpdate` in
  `server/lib/fs.ts`).
- Dev (any unpackaged launch, e2e too) seals with a fixed key, `DEV_SECRETS_KEY`: a development
  shell is ad-hoc signed, so the real Keychain would ask again after every rebuild and stall
  automation. It never touches the Keychain: a key dev sealed is no secret and only dev opens it.
  On the real save (no `IDLEBIZ_ROOT_DIR`) dev seals nothing, so it strands none: the packaged
  app's keys read as absent there and one entered there is written plain for the app to seal. Use
  `IDLEBIZ_ROOT_DIR`.
- Those keys never reach a run by the founder's hand either: an action's reply, a question's
  answer, a room message and an order card's note holding one are refused (`refuseHeldKey` in
  `server/company-actions.ts`; an order card's also refuses anything shaped like a Stripe key),
  and so is `set_env` given one. Both also refuse any Stripe secret key (`sk_`,
  `holdsStripeSecretKey`), IdleBiz's or not: it charges, refunds and pays out on the whole account
  with no sign-off, so a Stripe key the team asks for is a restricted one. What a restricted key
  was granted no API reads, so an `rk_` passes on the founder's word.

**Signed tools.** An outward step that needs a key is a signed tool main runs: `deploy`,
`create_payment_link` and `sell_print`. Each runs once the founder signs off on the action it
names, which is the approval's key (`requireSignOff` in `server/tools/define.ts`); a sign-off
belongs to the continuation task, is spent once and goes with the task. A sign-off pins an action,
not the tree a deploy ships, and runs on one product share its workspace, so a run carrying one
has that workspace to itself: the scheduler's `tick` starts it only once no other run is live
there, and starts nobody new there while it waits or runs. The agents are told the folder is
shared. No tool sets a project's domains or sells a subscription: those stay the founder's.

**Vercel and `deploy`.** `deploy` uploads the product's folder through Vercel's API with the
founder's `VERCEL_TOKEN` (`server/deploy.ts`), and Vercel builds it on its own machines. The
action signed is `deploy <product> to production on Vercel project <name>` (or
`on a new Vercel project named <product>` for a product bound to none).

- Before the sign-off is asked, and before `set_env` sets anything, Vercel is asked whether it
  still takes the token (`validateToken`): one it turns away (expired, revoked) leaves the founder
  a Vercel card rather than spend the sign-off on a call that would fail.
- The deploy never runs the Vercel CLI, which runs code a folder holds (`vercel.ts`, a `vercel`
  npx finds first, what a repo's config tells git to run) with the token in its env. Main only
  reads the files, a symlink as the path it holds (as the CLI uploads it), never what it names.
  Main names the project too: the bound one, or for an unbound product a new one named after it,
  bound as soon as Vercel makes it; a name another project holds asks the founder to bind instead.
  So no file in the folder (`.vercel/project.json`, a `name` in vercel.json) picks which of the
  founder's projects is overwritten.
- One `VERCEL_TOKEN` serves every product: binding another reuses it unless the founder pastes a
  new one. Each product binds a project of its own (a project another product holds is refused).
  The first token saved, through any product, resumes every Vercel ask, since it is what each
  product's deploy lacked; after that a binding resumes only the Vercel asks about that product or
  about none: an ask names the product it is about (`productId`, saved as the task's
  `askProduct`), which a run may name other than its own, and its Inbox card opens that product's
  binding. A refused token shows on each bound product as "vercel refused".

**`set_env` and the deploy's key scan.** `set_env` sets a variable on the product's bound project,
sensitive, for production and preview (`server/vercel-env.ts`), unsigned, since a key the founder
handed back for that product has reached runs anyway: their reply sits in the task.

- It only creates a name set_env never set there, and replaces only one it did: the founder may
  bind a live project whose variables are theirs, and a sensitive one cannot be read back. Nothing
  is retried as a readable type.
- Main keeps each value Vercel took in `secrets.json` (`ENV/<product>/<project>/<NAME>`, per
  project, so a product rebound to a project of the founder's replaces none of theirs; main's own
  copy never in the save, which runs read).
- A deploy refuses a folder any of whose uploaded files holds one, from any product, or any key
  IdleBiz itself holds (`heldKeys` in `server/secrets.ts`), naming the file and the variable or
  key, never the value: a key in source ships publicly. It reads the folder for that before it
  asks for the sign-off, and again over what it uploads. Only values of 8 characters or more are
  scanned. It is a tripwire, not a boundary: an encoded or split key passes, and nothing scans
  what the founder pushes by hand.
- Vercel's own names are refused as a name (`server/env-name.ts`). A name with a prefix a
  framework builds into the page (`NEXT_PUBLIC_`, `VITE_`…) is set, so a publishable key (`pk_`)
  stays out of the source, but never over a value shaped like a secret (`publicValueRefusal`:
  Stripe's `sk_`/`rk_`/`whsec_`, a private key block, GitHub, OpenAI, Anthropic, AWS, Resend and
  Slack keys), nor over one set_env keeps under a server-only name, or one holding or held in it
  (`serverOnlyValueIn`): the build inlines a public value where the file scan never looks. The
  deploy guard skips a public name's value (`unshippableEnvValues`), which the build ships anyway;
  that trusts the name, not the framework, so a prefix the product's framework does not read
  (`VITE_` in a Next.js app) leaves a value server-only and unguarded.
- A set_env call's title, its command line, is logged as `set_env` alone, judged on the whole
  title before the log cuts any title to one short line (`loggedToolName`, `scheduler.ts`): a
  command may put the value before the verb.

**Stripe and `create_payment_link`.** `create_payment_link` prices in USD and makes a Stripe
payment link with the founder's own key (`server/stripe-links.ts`), tagging each payment for its
product and a named revenue bet on it, open or measuring, and the link alone with the `delivery`
its buyers are owed, which Stripe copies onto each checkout. It keeps each link it makes under
`links/`. The action signed is `payment link "<name>" at $<amount> on <product> for bet <slug>
delivering "<delivery>" then send buyers to <url>`: the delivery is what the founder owes each
buyer and the URL is where paying buyers land, so a changed one is signed anew.

- Each POST goes under an idempotency key of its fields, like `sell_print`'s, so a retry after a
  timeout gets back the link Stripe made rather than a second one nothing saved knows; Stripe
  replays a failure (a 500 too) for a day, so a key it answered with one moves on to the next
  (`idempotentPost`), as does a replayed link Stripe now lists as switched off (a reset, a
  retirement or the founder switched it off since). A replayed link Stripe won't look up counts
  as on and is read like any create's answer, since Stripe made it either way: recorded, or named
  to the agent as one that may stand, never as no link made.
- Before the sign-off it asks Stripe whether the key still reads payment links
  (`stripeLinkAccess`), so a key rolled, revoked or expired since it was saved leaves a Stripe
  card instead of spending a sign-off on a call that would fail; one Stripe turns away while making
  the link or a listing's (401/403) leaves the same card. A link with a `delivery` is refused
  before the sign-off while the key cannot read checkout sessions (`stripeCheckoutAccess`), since
  that read is how each buyer reaches the founder.
- Its optional `afterPaymentUrl`, where each buyer lands once they have paid, must be https with
  no login or port on one of the product's verified production domains (`productionHosts` in
  `server/vercel.ts`, as `sell_print`'s files), and main adds
  `session_id={CHECKOUT_SESSION_ID}`, which Stripe fills (`after_completion[type]=redirect`).
- With no key it leaves the founder a Stripe card that opens the Budget panel, whose charging-key
  row saves a key only once Stripe has taken it (`server/stripe-key.ts`) and resumes the work that
  waited on it: every Stripe card is one `stripe` ask, a key to charge with or to count revenue
  with alike, and none resumes on a test-mode key, which counts no money unless
  `IDLEBIZ_COUNT_TEST_MONEY=1`. A new key is pasted over the saved one, never after removing it: a
  pulse between the two finds no key and hands each retiring link to the founder to switch off by
  hand.
- A restricted key needs Write on Payment Links, Prices and Products to charge, Read on Charges
  for the revenue read and for each paid print, whose payment the order pump reads before Printful
  is paid, Read on Checkout Sessions for the order pump and a link's `delivery`, and Write on
  Shipping Rates to sell a print, which `sell_print` checks with a read of all three
  (`stripeListingAccess`) before it asks for the sign-off.
- Metrics reads revenue with the same key (`stripeCredential` in `server/metrics.ts`), since every
  payment link and so every tagged charge is on its account; with no key saved nothing reads
  revenue. A key Stripe turns away on that read stays saved and shows in the Budget panel as
  refused (`noteStripeRead` and `stripeKeyStatus` in `server/stripe-key.ts`, asked again on each
  pulse) until a read Stripe takes, or a key pasted over it. That may be the same key: a
  restricted key's grants are edited in place, so saving one drops the read kept of it
  (`forgetStripeRead`) and the pulse it starts asks Stripe again.
- Stripe's and Printful's calls run through `answering` (`server/lib/vendor-call.ts`), all but the
  revenue read (`metrics.ts`, which settles each read apart) and the Printful token's check: it
  sorts how a call failed and reports an answer its schema refuses once, under the call's name,
  and each caller folds that into its own result.

**Printful and `sell_print`.** `sell_print` lists a Printful print-on-demand item
(`server/print-listing.ts`). Agents find variant ids, placements and techniques with
`printful_catalog` (`printfulCatalog` in `server/printful.ts`), which main reads with the token
(v2 serves the catalog only to a signed-in caller). The action signed is `sell "<name>" (variants
<ids>) printing <placement> (<technique>) <file URL> sha256:<digest> at $<price> via Printful on
<product> for bet <slug>`, the file's whole digest, so a design deployed over the URL is signed
for anew.

- Its print files must be images the product's own verified production domains serve now, each
  read whole and hashed (`readPrintFile`). Printful's estimate prices each variant with them at
  the listing's price (California taxes that, not Printful's own) to Los Angeles, Seattle, Denver
  (Colorado adds a retail delivery fee), Alaska and Hawaii (`server/printful.ts`, polled every 3s
  and backing off on a 429), and a price below the floor is refused before the founder is asked
  (`priceFloorCents`: the dearest estimate plus Stripe's 4.4% + 30¢ at its dearest, less the
  shipping the buyer pays), as is a Stripe key that cannot read shipping rates, checkout sessions
  or charges.
- Signed, it makes a Stripe price, a fixed shipping rate at Printful's dearest shipping and a
  card-only payment link collecting US addresses only, a dropdown for the variant when there are
  several, tagged like `create_payment_link`'s and with `metadata[listing]`, each POST under an
  idempotency key of its fields (`stripeShippedLink` in `server/stripe-links.ts`), and saves the
  listing under `listings/` with each file's sha256 and whether its link is live.
- The Printful token and its one store are the founder's, pasted in the Budget panel and kept only
  once Printful shows it can place orders in exactly one store (`server/printful-token.ts`). The
  store is no secret, so it sits in `printful-store.json` beside `secrets.json`, written before
  the token and put back as it was if the token can't be kept: neither is kept without the other.
  With no token, or one Printful refuses, the tool leaves a Printful card that opens that panel,
  where a new token is pasted over the saved one.

**The order pump** (`server/order-pump.ts`) runs on the metrics pulse and sends each paid order to
Printful unsigned, since the founder signed the listing and its price floor. Its tests fake
Stripe, the product's site and Printful at `fetch` (`server/order-pump.test.ts`).

- While a Stripe key is saved, every 30 minutes it makes one account-wide read of Stripe's
  checkout sessions (`server/stripe-checkouts.ts`, line items expanded; a list per link, or a
  faster beat, would spend the reads Stripe allows, which metrics already mostly spends on a quiet
  store) from a `created[gt]` cursor in `state/orders-cursor.json`, one per key that has read
  (named by its mode and a digest, never the key), since a key of another mode or account lists
  none of this one's sessions: a key new to a mode already read starts from the oldest of that
  mode's cursors, one of a mode never read from the founding. Each is held behind any checkout
  that may still be paid and re-reads the last 10 minutes. A read that cannot reach the cursor
  (Stripe lists newest first) moves it up to what it read and cards the founder.
- A session on a listing's link with `payment_status` `paid` (complete alone is not paid) is kept
  as an order under `orders/`, on disk before Printful hears of it; its Printful `external_id` is
  the session id's hash, looked up (`/v2/orders/@<id>`) before a draft is made
  (`server/printful-orders.ts`), so a restart never makes one twice. The design is read again and
  must hash as signed.
- A draft charges nothing; it is polled every pulse until priced (a bounded number of reads) and
  confirmed only on a read that shows it still a draft costing no more than Stripe collected less
  its dearest fee on a card (`netOfStripeCents`), with the payment's charges read just before,
  neither refunded nor disputed and paid by card (`readPaymentStanding`, Read on Charges, whose
  refusal cards the founder at once; a listing's link takes only cards, but one made before it did
  may have taken Klarna or Affirm, whose fee is dearer), so no restart confirms twice or past that
  guard. A send whose last try failed asks Printful once more for a draft it may have made before
  the founder is told to place it by hand. Waiting orders are sent and sent ones' Printful status
  read every 10 minutes.
- A test-mode sale is priced, then its draft deleted (one Printful never prices is deleted too),
  and anything that stops it goes to the room, never a card: nobody paid.
- A paid session on a `create_payment_link` link (its `product` tag names a product of the
  company, live or retired, and it has no `metadata[listing]`) is kept as a `link` order and
  posted to the room, and a live one whose link names a `delivery` is carded to the founder with
  the buyer's email and that text: nothing else reaches a buyer. One tagged with a listing this
  save no longer holds is kept as an unreadable order and carded. A card is raised before its
  order is kept, since cards dedupe by subject and the kept order is what stops the next read
  retrying.
- What the pump cannot settle (a draft dearer than the payment less the fee, a refunded or
  disputed payment, a changed design, a refusal, a status of failed, canceled or onhold the first
  time any call reads it, a refused key once anything is sold) is an order card in the Inbox: a
  blocked task of origin `order` naming its subject (`OrderCardSubject` in `@repo/domain/domain`:
  an order and its trouble, a link left on, or what stops the pump), which dedupes it and settles
  it, its title only copy rendered from it; no assignee, no product, so no bet stalls, no
  retirement drops it and no teammate can claim it. The founder's Done or Can't closes it with no
  run, as `settled` history (`settleOrderCard` in `server/company-actions.ts`), and goes to the
  room, where support reads it. Refunds are the founder's, in Stripe, and each card says so. A
  menu-bar-only launch counts what waits on the founder in the tray and notifies each new order
  card.
- Agents read orders, buyers' emails and addresses included, with the unsigned `read_orders`.

**Retiring a product** switches off, in main with the founder's key, every payment link it sells
through, a listing's and each `create_payment_link` link, whose record main keeps under `links/`
(`switchOffRetiredLinks` in `server/company-actions.ts`, run by the retirement and every pulse,
which sends `POST /v1/payment_links/<id>` with `active=false`; `server/retired-links.test.ts`), so
it takes no new money; checkouts already paid still count and still ship, and one opened before
the switch and paid after is kept like any other.

- Only a product whose package is under `retired/` and not `products/` counts as retired
  (`isRetiredProduct`), so one boot could not read keeps its links, and its paid checkouts are
  still kept as orders (`madeProduct`).
- The retirement is on disk before Stripe is asked and never depends on its answer; each link
  then records `switched-off`, `retrying` while Stripe is busy (429), failing (5xx) or out of
  reach, or `left-on` with why, raised first as one card per link naming it to switch off by hand
  in Stripe's dashboard (no key, a refusal, ten sweeps unanswered; a test-mode link tells the room
  instead), whose Done records it switched off by the founder. A key saved but not openable this
  launch leaves the links waiting for it.
- Every pulse sweeps again, one sweep at a time and one link at a time, so a quit before Stripe
  answered is finished at the next launch; switching off a link already off answers the same. A
  link Stripe makes while its product retires is still kept, and switched off at once.
  `read_orders` and `kill_product` say where each of a retired product's links stands.

**A reset** waits for each signed link Stripe is still making to be recorded and refuses a new one
(`makingPaymentLink`), then switches off every live link not yet off before it deletes the save
(`switchOffBeforeReset`), since nothing is left after to ship its prints or record a buyer. Its
warning names each link Stripe left on, each paid print Printful never confirmed (but a held one
whose card the founder settled), and each paid order whose card still waits on the founder (a
delivery, one IdleBiz cannot send).

**Nothing pushes code.** The founder pushes by hand from a fresh clone
(`git clone --no-local <workspace>`), never with git inside the workspace: the seal keeps a run
from git's config and hooks there, but git still obeys what a run leaves in the folder (a rebase's
todo list, a `.gitattributes`), unsealed, as the founder. A clone runs only upload-pack there,
which runs nothing its config names since git stopped lazy-fetching a partial clone's missing
objects (2.45.1; 2.39.4 and the other backports). The prompts and the questions IdleBiz asks the
founder say so. A shell `git push` is still held under `git-push`, and signed it runs as any
command does: on a claude run git reaches a credential helper that reads the Keychain (gh's), so
it can push over https as the founder. Refuse it.

### The command policy

Every permission ask a runner raises meets one judgement, `holdFor` in `server/policy/index.ts`;
every turn sets the runner's asking mode first (claude `default`, codex `external-sandbox`), since
a session starts in a default that may not ask. A shell command matching a rule (deploy, publish,
git push, GitHub writes, payments, sends, remote copies, pipe-to-shell, credential reads) is
signed for once, exactly as sent, newlines and all (the card marks each with `⏎`), with the same
grant a signed tool takes. It is a tripwire: what a script runs goes unseen (`npm run deploy`, a
file on disk). codex would run a command the founder's `~/.codex/rules` allow without asking, so
its runs find no rules there ("A run's seal").

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

### What stays open

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

### Traps that fail silently

- **sandbox-exec cannot nest.** Once a profile denies anything, applying another inside it fails
  (`sandbox_apply: Operation not permitted`), so any sandbox a runner or its tools start inside
  the seal makes every command fail. claude's own is forced off in its flag-tier settings
  (`packages/agent-driver/src/registry.ts`), whatever the founder's say. Runs start Chrome without
  its own (`AGENT_BROWSER_ARGS=--no-sandbox`). codex runs in `external-sandbox`, a mode
  `patches/@agentclientprotocol__codex-acp@1.12.0.patch` adds: no sandbox of codex's own and
  approval `untrusted`, so codex asks before every command and patch it does not know is safe.
  codex-acp's own modes either sandbox or never ask, so an upgrade must carry the patch, keyed by
  the exact version the catalog pins. Both adapters and the ACP sdk are pinned exactly in the
  `pnpm-workspace.yaml` catalog: a bump moves the patch's key, may change the wire `acp-session.ts`
  speaks, and must pass `claude-gate.test.ts` and `codex-gate.test.ts` on a Mac with both CLIs,
  which CI's `test-macos` job runs. The boot check runs plain node, so it cannot see a runner's
  own sandbox; the gate tests can ("Tests").
- **The px-kit beats Tailwind.** The `.px-*` classes in `packages/px-kit/px-kit.css` live outside
  `@layer`; Tailwind's utilities are layered, and unlayered CSS wins regardless of specificity. So
  a utility on the same element that sets a property its kit class also sets does _nothing_:
  `text-[12px]` on a `.px-btn` never applies. Before putting a utility on an element with a
  `.px-*` class, check px-kit.css for the same property: many set font-size, colour, background or
  padding (`.px-btn`, `.px-opt`, `.px-hint`, `.px-inset`…). `renderer/px-kit-overrides.test.ts`
  fails on one in any class string of the desktop renderer that names a kit class; a class built
  at runtime goes unread. A variant is a kit modifier (`.px-hint-danger`, `.px-inset-hover`),
  never a utility. Cursors are the opposite: no kit class sets one, each app does by element.
  Icons are font glyphs, so "icon size" is font-size: use `.px-icon`.
- **The office's art and its collision don't know about each other.**
  `renderer/game/office-design.json` is the one office: placed sprites, each naming its PNG under
  `public/`, over a 16px collision grid, with the seats, points of interest, door and spawn.
  `office-layout.test.ts` checks only what would break the app: the schema (the renderer parses it
  before React mounts, so a bad edit blanks it), art that exists, and every seat, point of
  interest and door reachable from spawn. `buildRoom` draws `objects`; the walk grid reads
  `collision`; nothing keeps the two in step. The body probe is 16x12 but the sprite is 32x64, so
  art overhangs the body by ~8px, and a hand edit to either section can render a character against
  the void or paint furniture over their face. The walker adds two rules the collision does not
  state, both in `walkGridOf` (`renderer/game/office-grid.ts`): a seat's cell is solid (sitters
  are placed on the chair; walkers never stand in it) and open floor no body can probe is sealed.

### The page, the shell and main

The page reaches main over its contract and the runs reach it over the control plane: two doors,
never one. The page's carries the founder's session cookie and answers on the page's own port,
which the seal closes to every run; the control plane's is a unix socket main opens for each run,
which only that run's seal reaches, and what it does is the run's.

- **The page's API.** `packages/contract` declares every procedure the page calls of main (oRPC,
  one folder per domain, `<domain>-contract.ts` beside `<domain>-schema.ts`, whose zod schemas
  are the inputs' types), and `server/page-router.ts` implements it, so a procedure missing or
  mistyped fails to compile. Main serves the window its page on loopback, signed in by a one-time
  handoff (`server/page-server.ts`, `server/page-session.ts`). The page calls
  `api.<domain>.<procedure>()` (`renderer/api.ts`, one client for the page) on its own origin:
  under `/rpc`, behind the session cookie and same-origin guards. One middleware words every
  answer that does not return (`server/lib/answers.ts`): a `RefusalError` is the store's bare
  sentence, which the page shows; text over a field's limit says the limit; anything else is a
  fault, answered with its message and reported to main's log.
- **Main's events** are the contract's `events` stream, each a `PageEvent` whose zod schema
  `@repo/contract/events` declares: `server/lib/broadcast.ts` parses each as it publishes it, and
  logs and drops one that fails, which would otherwise end every page's stream at the contract's
  own check. The page hears them through `listen()` (`renderer/page-events.ts`), which reopens a
  stream that drops a second later, and asks main for everything again as each one opens, since
  what main sent meanwhile is lost.
- **The relay.** The shell reaches no part of the page's API: it talks to main over main's stdio
  (JSON-RPC 2.0, one message a line: `server/relay/rpc.ts`, `src-tauri/src/relay.rs`), and the
  page reaches no command of the shell's. Main asks the shell for what only a native app does
  (`server/host.ts`): a message box, the clipboard, Finder and the browser, the menu-bar icon (main
  decides it, `server/tray.ts`; the shell draws it, `src-tauri/src/tray.rs`), a notification, the
  login item, the Mac kept awake, a relaunch. The shell says hello first, with what only it knows:
  whether it is the packaged app, the dev server's address in dev, whether the login item launched
  it, the Keychain's sealing key. Each end names every method once (`RELAY_METHODS` and its zod
  schemas in `server/host.ts`; the consts and serde types of `src-tauri/src/protocol.rs`), and
  both are pinned to one sample a method, `src-tauri/tests/fixtures/relay/<method>.json`:
  `server/host.test.ts` parses each with main's schema, `cargo test` reads each into the shell's
  types and writes it back unchanged, and each checks its own methods are the samples'. Both ends
  refuse a field they do not know, and a development shell shows a box for a notification it
  cannot read. Main's stdin is its lifeline: the shell closes it only after main answers `quit`,
  so a shell that crashed or was killed ends main too, after its runs.
- **Awake and at login.** The scheduler alone keeps the Mac out of idle sleep, and only while a
  run is in flight (`keepAwake`, `server/keep-awake.ts`: a user-initiated activity the shell
  holds, `src-tauri/src/keep_awake.rs`, never past a closed lid). Settings can open IdleBiz at
  login (`server/login-item.ts`): the macOS login item (`SMAppService`,
  `src-tauri/src/login_item.rs`) is its only record, only a packaged app registers one, and a
  launch at login starts in the menu bar.
- **Main's log.** Main's console is its stderr, which the shell appends, stamped, to `main.log`
  (`src-tauri/src/main_log.rs`; `~/Library/Logs/IdleBiz/`; dev: `logs/` in the `IdleBiz (dev)`
  data folder, or in `roots/<id>/` beneath it for an isolated `IDLEBIZ_ROOT_DIR`), never under the
  save root, which a reset deletes; `server/lib/log.ts` sends uncaught errors there too. A catch
  that carries on past an unexpected error calls `report` (`server/lib/report.ts`); a boot that
  throws says where the log is and exits.

### The renderer's state

Main's answers live in one tanstack-query cache (`renderer/state/queries.ts`, keyed by
`@orpc/tanstack-query`'s `orpc`), where nothing goes stale on its own. The store
(`renderer/state/store.ts`) applies each patch `renderer/state/activity-reducer.ts` makes of an
event as cancelQueries, setQueryData, then invalidateQueries. `useSubmission` is built on React's
`useActionState`: the control is busy while main works and a refusal lands beside it as a
`<Failure>`. The office scene reads the cache through `read` and `watch` in `queries.ts`, and a
founding reads the company, its team and their work again before the scene restarts
(`companyFounded`).

### The budget

The tray and HUD label it `usage` (`usageLabel` in `@repo/domain/format`), never spend; the Budget
panel, the digest, onboarding and the HUD's tooltip say it is at API prices. A turn cut off before
its agent answers (the watchdog, Stop, a quit, a crash) still bills what its usage updates
reported, as uncached input (`runAcpTurn`).
