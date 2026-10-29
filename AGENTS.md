# AGENTS.md

**IdleBiz** is a retro RPG-style idle business sim where the employees are the player's own
coding CLIs. The app is two programs: `apps/desktop`, a Tauri shell around the office page, and
`apps/cli`, the `idlebiz` binary, whose `idlebiz serve` is main, the node process that spawns real
`claude` / `codex` sessions and saves the whole company as human-readable markdown under
`~/.idlebiz/`. Every other verb of `idlebiz` is a company tool the employees call. A small Next.js
landing page (`apps/web`) ships the download; the app sends it nothing.

This is the tool-agnostic guide for coding agents, meant to be run, not just read: the workflow
(run, verify and ship a change), the map and the traps, kept short enough for every agent to load
whole. How each mechanic works is told once, in its own file under `docs/`
([How it works](#how-it-works) lists them). The premises and decisions behind them, each with its
reason, are `CLAUDE.md`'s: read it first. Claude reads both.

Paths below are short: `server/…` and `commands/…` are under `apps/cli/src/`, `renderer/…` under
`apps/desktop/src/`, `src-tauri/…` under `apps/desktop/`, and `@repo/<package>/<module>` is
`packages/<package>/src/<module>.ts`.

> Naming: this file is repo documentation. The `AGENTS.md` files under
> `~/.idlebiz/company/agents/<slug>/` are game data — the in-game employee's own
> instructions (`server/paths.ts`) — and a product's workspace `AGENTS.md` is its team's notes
> ([A run's env, login and notes](docs/runs.md#a-runs-env-login-and-notes)). Unrelated.

## Quickstart

```sh
pnpm install
pnpm verify        # static gate: typecheck · lint · knip · format · test · build
pnpm dev:web       # landing page → http://localhost:3000
pnpm dev:browser   # the office in a browser → http://localhost:31100/ (signs the browser in to main)
pnpm dev:desktop   # the app's own window (tauri dev)
pnpm e2e           # builds the page and main, then drives them in Chromium (local only)
```

No database and no server to provision: past `pnpm install`, the one thing to install is
Rust through rustup, since `pnpm verify` runs clippy (pedantic, `-D warnings`), `cargo test` and
`cargo fmt --check` over the shell and `pnpm dev:desktop` builds it
(`apps/desktop/rust-toolchain.toml` pins the toolchain, and the first `cargo` call installs it). On
Linux the shell also links WebKitGTK, the appindicator its menu-bar icon loads and librsvg, and
needs a C toolchain: `build-essential`, `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev` (CI's `ci` job installs the three libraries; its runner ships the toolchain). There
is no bootstrap script and nothing to seed.

**`pnpm dev:desktop` and `pnpm dev:browser` are not plain dev servers.** Each runs `pnpm dev:kill`
first (`apps/desktop/scripts/devkill.sh`), which terminates this checkout's desktop session —
`tauri dev`, its shell and the dev server, each with main under it — then kills any that remain
after ten seconds. Main stops its runs first on the TERM. `pnpm dev:web`, `pnpm verify`, tests
and a running `pnpm e2e` survive it. It leaves an unrelated process on TCP **31100**, the dev
server's port, alone, and startup fails while that port is occupied.

Both build main (`apps/cli`'s bundle, `apps/cli/dist`) before the page is served and again on each
change (`apps/desktop/vite.config.ts` watch-builds it): `tauri dev` restarts the shell when main's
bundle changes (`--additional-watch-folders ../cli/dist`; its watcher skips what `.gitignore`
names, so `apps/cli/.taurignore` brings `dist/` back), and `dev:browser` restarts main itself.
Either way the page stays main's: main hands it Vite's files, so a change to the page hot-reloads
on main's origin, and its hot-reload socket dials Vite directly. A change to the shell's Rust
rebuilds and relaunches it.

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
pack ([Packaging and release](docs/packaging.md)).

**The compiler's strictness is `tsconfig.base.json`** (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitReturns`, `noImplicitOverride`, `erasableSyntaxOnly`,
unused locals and parameters). Every workspace's tsconfig extends it and adds only what is its own
(`lib`, `types`, `include`, `paths`, `jsx`, and `apps/web`'s Next plugin). The code the page
runs (the renderer, `@repo/domain`, `@repo/contract`) extends `tsconfig.page.json`, the ES2023
ceiling of the window's WebKit; the renderer adds the DOM in `renderer/env.d.ts`.

**Lint is a clean gate.** `oxlint.config.ts` extends the ultracite presets
(`ultracite/oxlint/core`, `react`, `anti-slop`; `next` scoped to `apps/web`); every rule is an
error and `lint` fails on the first one. It is type-aware (`options.typeAware`, run by the
`oxlint-tsgolint` devDependency): without it the presets' `no-floating-promises`,
`no-misused-promises`, `switch-exhaustiveness-check`, `no-deprecated` and `no-unsafe-*` are skipped
without a word. Fix the code, don't add overrides: the deliberate ones are in `oxlint.config.ts`,
each with its reason beside it. `switch-exhaustiveness-check` takes a `default` as exhaustive, so a
switch that must name every kind has none; the activity reducer's table of slices is typed over
every kind instead (`satisfies Record<ActivityKind, …>`).

Prefer fixing code over `oxlint-disable` comments; when a rule is genuinely wrong for a line, disable that line with a stated reason (`// oxlint-disable-next-line rule -- why`).

End-to-end suite — `pnpm e2e` builds the page and main, then drives them with Playwright in
Chromium (`tools/e2e/`): each launch starts the built main through the dev host
(`apps/cli/src/dev-host/host.ts`), which answers main's asks of a native app as the shell would,
and opens the built page main serves on the handoff link main hands it, as the shell's window
opens. `pnpm -F @repo/e2e e2e` reruns it on the last build. The shell itself (the window, the
menu-bar icon, the Keychain, the login item) is Rust's, held by `cargo test`, booted packaged by
`pnpm smoke:desktop` and driven by hand. What the suite covers is its tests, in
`tools/e2e/src/*.spec.ts`. It is local only, not part of `pnpm verify` or CI:

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
> launch paid CLI sessions, so ask before a dev launch on the real `~/.idlebiz`.
> `IDLEBIZ_ROOT_DIR` overrides the default `~/.idlebiz` root.
> Isolation protects the real save, but onboarding and employee runs still bill the signed-in
> CLI. A dev launch on `~/.idlebiz` while the installed IdleBiz has it open refuses to boot
> ([The save](docs/save.md#the-save)).

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
`onboarding.hires`, which dispatches a real agent run (`server/agents/onboarding.ts`), and its
flow (`renderer/ui/onboarding-flow.ts`) founds nothing when no hires come back. Use `IDLEBIZ_ROOT_DIR` for fixtures; there is no
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
- On macOS main's suite also runs the seal on canary files under a stand-in home
  (`seal.mac.test.ts`) and main's login-shell probe on a stand-in home's startup files
  (`shell-path.test.ts`). Where a `claude` or `codex` CLI is installed, the gate suites
  (`server/agents/claude-gate.test.ts`, `codex-gate.test.ts`) drive the real CLI through the app's
  ACP adapter, sealed, against a stand-in model on loopback, billing nothing, on a scratch config
  that never touches its login.
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
  ([Keys and what spends them](docs/keys.md)).
- The shell's env reaches main, but for every `NODE_*` variable, which the shell and the dev host
  both drop (`scrubbed_env`, `mainEnv`): none loads code into main, and no `NODE_ENV` of a
  terminal's or vitest's reaches the runs, which inherit main's env less its credential-shaped
  names, as in a terminal launch
  ([A run's env, login and notes](docs/runs.md#a-runs-env-login-and-notes)).
- `CLAUDE_BIN` / `CODEX_BIN` override the CLI paths, for main and the gate suites alike
  (`packages/agent-driver/src/detect.ts`).
- `IDLEBIZ_COUNT_TEST_MONEY=1` counts test-mode Stripe charges toward revenue and bets, for
  an end-to-end run of a revenue bet on a test key. Without it only live-mode money counts:
  a test-mode key reads as "Stripe is in test mode — no charge counts" in the brief and
  `measure_bet` refuses a revenue bet on it (`server/metrics.ts`).
- `IDLEBIZ_ROOT_DIR` overrides the save and secrets directory for isolated runs
  (`server/paths.ts`). Defaults to `~/.idlebiz`; use a fresh temporary directory for desktop
  verification.
- `apps/desktop/.env` (see `.env.example`) is release-only
  ([Packaging and release](docs/packaging.md)).

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
                 with its chunks flat beside it (src/paths.ts counts on that), and the desktop
                 page's build staged as dist/page (scripts/stage-page.ts), which serve hands the
                 window.
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

Where each thing lives in it, file by file, is [docs/map.md](docs/map.md).

## How it works

Each mechanic is described once, in its file under `docs/`, and read before it is changed;
`CLAUDE.md` holds the decision behind it.

- [The save and the store](docs/save.md): the save on disk, activity and running state, the store
  and the company's tools.
- [Bets steer the company](docs/bets.md): the verdict, the window, the mark, revenue, where a run
  goes, the replay.
- [How a product earns](docs/earning.md): the business models, checking who paid, action cards.
- [Runs](docs/runs.md): a run's env, login and team notes, failures and rests, IdleBiz's skills.
- [The seal and the command policy](docs/seal.md): what a run reads, writes and reaches, the
  command policy, what stays open.
- [Keys and what spends them](docs/keys.md): IdleBiz's keys, the signed tools, Vercel, Stripe,
  Printful, the order pump, retiring a product, a reset.
- [The app](docs/app.md): the page, the shell and main, the renderer's state, the budget.
- [Packaging and release](docs/packaging.md): the pack, signing and notarizing, the release, the
  smoke.
- [Map](docs/map.md): what each folder holds, file by file.

## Traps that fail silently

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
  own sandbox; the gate tests can ([Tests](#tests)).
- **A utility beats the px-kit.** The `.px-*` classes in `packages/px-kit/px-kit.css` and each
  app's own classes sit in Tailwind's `components` layer, the apps' element rules in `base`, as
  Tailwind documents, so a utility on the same element wins: `text-[12px]` on a `.px-btn` resizes
  that one button, the per-component size CLAUDE.md rules out. Before putting a utility on an
  element with a `.px-*` class, check px-kit.css for the same property: many set font-size,
  colour, background or padding (`.px-btn`, `.px-opt`, `.px-hint`, `.px-inset`…).
  `renderer/px-kit-overrides.test.ts` fails on one in any class string of the desktop renderer
  that names a kit class; a class built at runtime goes unread, and there the utility wins
  unnoticed. A variant is a kit modifier (`.px-hint-danger`, `.px-inset-hover`), never a utility,
  and a colour is one of the kit's tokens (`text-fg-mid`, `bg-veil/90`), never a hex of a
  component's own, which the same test refuses. Cursors are the apps': no kit class sets one,
  each app does by element. Icons are font glyphs, so "icon size" is font-size: use `.px-icon`.
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
