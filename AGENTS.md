# AGENTS.md

**IdleBiz** is a retro RPG-style idle business sim where the employees are the player's own
coding CLIs. One Electron app (`apps/desktop`) spawns real `claude` / `codex` sessions and
saves the whole company as human-readable markdown under `~/.idlebiz/`; a small Next.js
landing page (`apps/web`) ships the download and the Stripe Connect OAuth hop. This is the
tool-agnostic guide for coding agents — meant to be run, not just read. Claude also reads
`CLAUDE.md`; both point back here.

> Naming: this file is repo documentation. The `AGENTS.md` files under
> `~/.idlebiz/<company>/agents/<slug>/` are game data — the in-game employee's own
> instructions (`apps/desktop/src/main/paths.ts`). Unrelated.

## Quickstart

```sh
pnpm install
pnpm verify        # static gate: typecheck · lint · format · check:office · test · build
pnpm dev:web       # landing page → http://localhost:3000
pnpm dev:desktop   # Electron window + CDP on :9222
pnpm e2e           # builds the desktop app, then drives it (macOS, local only)
```

No database, no Docker, no server to provision — `pnpm install` really is the whole setup.
There is no bootstrap script and nothing to seed.

**`pnpm dev:desktop` is not a plain dev server.** It runs `pnpm dev:kill` first
(`apps/desktop/scripts/devkill.sh`), which terminates this checkout's desktop session — its
turbo watch, electron-vite and Electron — then kills any that remain after three seconds.
`pnpm dev:web`, `pnpm verify` and tests survive it. It leaves unrelated processes on TCP
**9222** alone and refuses to start while that port is occupied.

## The one hard prerequisite

The app is inert without a **signed-in `claude` or `codex` CLI on PATH**.
`packages/agent-driver/src/detect.ts` probes `claude auth status` / `codex login status`;
`hasAuth` in `apps/desktop/src/main/index.ts` gates the UI behind
`renderer/ui/auth-gate.tsx`. IdleBiz stores no model-provider credentials of its own — every
run bills against the player's existing CLI login.

Preflight — run these three before deciding what you can verify:

```sh
claude --version          # or: codex --version — at least one must resolve
codex --version
agent-browser --version   # missing ⇒ npm i -g agent-browser && agent-browser install
```

A sandbox without those CLIs can still do the full static gate and can still drive the two
CLI-free surfaces below; it cannot reach a populated office.

## Verify a change end-to-end

Static gate (`.github/workflows/ci.yml` runs the same steps on every push to main and every
PR, as named steps; Vercel's build of `apps/web` is a second remote check):

```sh
pnpm verify
```

**Lint is a clean gate.** `oxlint.config.ts` extends the ultracite presets (`ultracite/oxlint/core`, `react`, `anti-slop`; `next` scoped to `apps/web`); every rule is an error and `lint` fails on the first one. It is type-aware (`options.typeAware`, run by the `oxlint-tsgolint` devDependency): without it the presets' `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `no-deprecated` and `no-unsafe-*` are skipped without a word. The deliberate overrides, each with its reason beside it in the config:

- `no-await-in-loop` off: sequential awaits are intentional (ordered agent turns, paced writes).
- `switch-exhaustiveness-check` takes a `default` as exhaustive: it is how a consumer says every other kind means nothing to it. A switch that must name every kind (the activity reducer) has none.
- `no-confusing-void-expression` off: `() => set(x)` is the house style.
- `strict-boolean-expressions` off: truthiness checks on optionals are idiomatic here.
- `promise-function-async` and `strict-void-return` off: taste; a dropped or misplaced promise is still `no-floating-promises`' and `no-misused-promises`' to catch.
- `consistent-return` off: a bare `return` in a `T | undefined` helper is deliberate.
- `no-unsafe-*` off under `apps/desktop/scripts/**`: untyped .mjs/.cjs scripts reading JSON and pixel data.

Prefer fixing code over `oxlint-disable` comments; when a rule is genuinely wrong for a line, disable that line with a `-- reason`.

End-to-end suite — `pnpm e2e` builds the desktop app, then drives the build with
Playwright's Electron support (`apps/desktop/e2e/`); `pnpm -F @repo/desktop e2e` reruns it on
the last build. It covers the title screen, the builder and the catalog, a founded company's
office (HUD, #team, one NPC per hire), Vercel and Stripe key entry (a key taken is sealed,
shown as set and, for Stripe, removable; a key refused is never saved), a key pasted into
secrets.json being sealed, and a held command denied from #team. It is local only, not part
of `pnpm verify` or CI:

- It needs a macOS desktop session: each launch shows the window and takes focus.
- Every test that founds a company (the office, the #team approval, Vercel and Stripe key
  entry, sealing) needs a signed-in `claude` or `codex` CLI and skips without one; only the
  title screen and the builder and catalog run without it. The refusal tests send made-up
  keys to the real Vercel and Stripe APIs, so they need the network; where a key is taken,
  main's `fetch` answers both APIs from canned JSON (`stubStripeAndVercel`), so no real
  account or key is needed.
- Quit `pnpm dev:desktop` first: an unpackaged launch shares its userData and so its
  single-instance lock, and the suite refuses to start while that is held.
- It never spends. Each test gets a fresh `IDLEBIZ_ROOT_DIR` and founds over the preload
  bridge with a hand-written team (no casting run), a $0 cap and autopilot off; the
  scheduler checks the budget before it spawns anything, so no run can start. It directs
  nobody, and every test ends by asserting its save logged no `run.start`.

Runtime, web — headless with [agent-browser](https://github.com/vercel-labs/agent-browser):

```sh
pnpm dev:web &
agent-browser open http://localhost:3000
agent-browser snapshot          # accessibility tree with @eN refs
agent-browser screenshot /tmp/web.png
```

Runtime, desktop — attach to the Electron renderer over CDP.

> **Use an empty temporary save root for desktop verification.** Boot starts the scheduler,
> which immediately drains queued work, even with autopilot off. Existing companies can
> launch paid CLI sessions. `IDLEBIZ_ROOT_DIR` overrides the default `~/.idlebiz` root
> (`main/paths.ts`). `dev:desktop` runs Turbo in loose env mode, so the whole shell env
> reaches Electron, and the employees' CLIs less its credential-shaped names, as in a
> terminal launch. Isolation protects the real save, but onboarding and employee runs still
> bill the signed-in CLI.

**(a) CLI-free routes** — the office builder and the object catalog render with no company,
so no scheduler work is required to see them. They contain no Phaser; skip the block below.

```sh
idlebiz_test_root=$(mktemp -d /tmp/idlebiz-ui.XXXXXX)
lsof -ti tcp:9222 || true       # must be free
IDLEBIZ_ROOT_DIR="$idlebiz_test_root" pnpm dev:desktop &
agent-browser connect 9222
agent-browser eval 'location.hash = "#/ui"'   # or "#/office-assets"
agent-browser screenshot /tmp/builder.png
agent-browser close
pnpm dev:kill                   # tear the session down
rm -rf "$idlebiz_test_root"
```

**(b) The office scene** — only on the default route (`#/`), and only with a finished
onboarding, i.e. a signed-in CLI. Do not navigate away from `#/` first: `#/ui` and
`#/office-assets` unmount `<PhaserGame>` and clear its debug handle. Under headless automation
Phaser's boot also stalls (`document.hidden` never
flips), so the canvas stays blank until you step it:

```sh
agent-browser connect 9222
agent-browser eval 'location.hash'                          # expect "" or "#/"
agent-browser eval 'window.__game.scene.start("office")'
agent-browser eval 'window.__game.loop.step(performance.now())'
agent-browser screenshot /tmp/office.png
```

Don't stop at `pnpm verify` — for anything the player can see, drive it and look.

## What is verifiable without a signed-in CLI

| Surface                                | How to reach it                       | CLI needed? |
| -------------------------------------- | ------------------------------------- | ----------- |
| `apps/web` landing + `/api/stripe/*`   | `pnpm dev:web`                        | no          |
| Office builder (`#/ui`)                | `location.hash = "#/ui"`              | no          |
| Object catalog (`#/office-assets`)     | `location.hash = "#/office-assets"`   | no          |
| Onboarding modal (first screen)        | boot with an empty `IDLEBIZ_ROOT_DIR` | no          |
| Office, HUD, dialogue, teams, products | finish onboarding                     | **yes**     |

The last row is a hard gate, not a convenience: `renderer/ui/onboarding.tsx` calls
`generateHires`, which dispatches a real agent run (`main/agents/onboarding.ts`), and
`finalize()` bails when no hires come back. Use `IDLEBIZ_ROOT_DIR` for fixtures; there is no
bundled seeded save. Employee runs still use the signed-in CLI.

## Platform matrix

| Platform           | Dev command        | Agent-verifiable at runtime?                       |
| ------------------ | ------------------ | -------------------------------------------------- |
| Desktop (Electron) | `pnpm dev:desktop` | **Yes** — CDP on :9222 via `agent-browser connect` |
| Web (Next.js)      | `pnpm dev:web`     | **Yes** — headless via agent-browser               |

Unusually for this stack, the Electron app is the _more_ driveable surface: electron-vite
already starts it with `--remoteDebuggingPort 9222`.

## Configuration

Nothing is required to run. Every key is optional and its absence disables one feature
rather than crashing boot.

- `apps/web` — `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY` (see `.env.example`, read through
  `src/lib/env.ts`). Missing ⇒ `/api/stripe/*` refuses the flow with a clear message.
- Desktop runtime secrets live in `~/.idlebiz/secrets.json`, not a `.env`. They are
  IdleBiz's own: main reads each where it uses it (`getSecret` in `main/secrets.ts`) and
  exports none into any env, so no employee holds `STRIPE_SECRET_KEY` or `VERCEL_TOKEN`.
  Employees run as the founder's OS user: every run's seal (below) keeps it from the file,
  and each value is also sealed with Electron's `safeStorage` (the macOS Keychain,
  `setSealer` at boot) as `sealed:v1:<base64>`, since a claude run can still reach the
  Keychain. Enter
  keys in the app: `VERCEL_TOKEN` through a product's Vercel button (under users), Stripe in
  the Budget panel (under revenue). A key pasted into the file as plain text is sealed the
  next time main reads it. One the Keychain can't open (another build sealed it, or access
  was denied) reads as absent, is named in Settings and stays as it is: enter it again.
  Dev (any unpackaged launch, e2e too) runs on Chromium's mock keychain
  (`--use-mock-keychain`): its Electron is ad-hoc signed, so the real Keychain would ask
  again after every Electron change and stall automation. It never touches the Keychain,
  and it seals with a fixed key: a key dev sealed is no secret and only dev opens it. On the
  real save (no `IDLEBIZ_ROOT_DIR`) dev seals nothing, so the packaged app's keys read as
  absent there and one entered there is written plain for the app to seal. Use
  `IDLEBIZ_ROOT_DIR`.
  Employees charge through the `create_payment_link` tool, which makes the link with
  `STRIPE_SECRET_KEY` in main (`main/payment-links.ts`) once the founder signs off; with no
  key it leaves the founder a Stripe card that opens the Budget panel, whose charging-key row
  saves a key only once Stripe has taken it (`main/stripe-key.ts`) and resumes the work that
  waited on it. A restricted key needs Write on Payment Links, Prices and Products to charge,
  and Read on Charges and Customers for the revenue read below. Metrics reads revenue with it
  for every company but
  the one whose `metrics.json` holds the connected account: that one reads through
  `STRIPE_CONNECT_TOKEN` instead, taking the connected account as the one the key charges
  on (`stripeCredential` in `main/metrics.ts`). The Connect token is read-only. A key Stripe
  refuses shows in the HUD — a Connect token as revoked, the own key as the charging key — until a pulse finds Stripe taking a key again, or no key left (`noteStripeRead` in
  `main/stripe-connect.ts`). One `VERCEL_TOKEN` serves every product:
  binding another reuses it unless the founder pastes a new one, and a refused one shows on
  each bound product as "vercel refused". One that fails to parse is listed in Settings and never rewritten
  (`readJsonFileForUpdate` in `main/lib/fs.ts`; `metrics.json` too). Employees deploy
  through the `deploy` tool, which uploads the product's folder through Vercel's API with
  `VERCEL_TOKEN` in main (`main/deploy.ts`) once the founder signs off. They push code
  through the `push` tool, which pushes a committed branch of the product's repository with
  the founder's own git credentials (main's ssh agent, their global and system credential
  helpers) once the founder signs off on that exact commit and URL (`main/git-push.ts`).
  Main runs no git in the workspace's repository, whose config and hooks an employee
  writes: it reads the remote's URL from the file, fetches the branch through upload-pack
  into a repository of its own under the save's `.push/` and pushes from there. It refuses a
  `/usr/bin/git` from before upload-pack stopped lazy-fetching a partial clone's objects
  (2.39.4, 2.45.1), and runs git with PATH cut to `/usr/bin:/bin:/usr/sbin:/sbin`, so a
  founder's credential helper or `core.sshCommand` named without an absolute path is looked
  up only in those. No tool
  sets a project's env vars or domains, or sells a subscription: those stay the founder's.
- A run's env is the founder's (main's) less every credential-shaped name — `TOKEN`,
  `SECRET`, `PASSWORD`, `KEY`, `APIKEY`, `PAT`, `DSN`, `WEBHOOK`, `CREDENTIALS`, `AUTH` as
  whole `_` segments, so `SSH_AUTH_SOCK` too — and every URL with a login in it but a
  `*_PROXY`, except its runner's own login (`providerEnv` in
  `packages/agent-driver/src/registry.ts`; `runEnv` in `main/agents/run-env.ts`). AWS access
  keys sign for the whole account, so neither runner keeps them: a founder on Bedrock signs
  in with an AWS profile or `AWS_BEARER_TOKEN_BEDROCK`.
- Every employee run starts sealed, inside the Seatbelt profile `main/agents/seal.ts` renders
  and hands `sandbox-exec -p`: the
  founder's logins kept under HOME (ssh, `gh`, npm, netrc, git credentials, `~/.aws`, docker,
  gnupg, gcloud, the Stripe, Wrangler, Netlify and Vercel CLIs, Chrome's and Brave's
  profiles), the other runner's login, `secrets.json` and `.push/` (where main stages a push)
  are unreadable and unwritable; shell
  rc files, `~/.gitconfig`, `~/.config` and LaunchAgents are unwritable; git's Keychain
  helper cannot run and no ssh agent answers, so no run can sign a push as the founder. Each
  of those paths is sealed where a symlink leads as well as where it is named, as they stand
  when each run starts, and no folder above one can be renamed or removed. A
  codex run also cannot run `/usr/bin/security`; a claude run can, since claude reads its own
  login with it. Network stays open. Boot checks the seal without a model call; until it
  holds, no run starts and no task spends an attempt, and if it fails, or this Mac has no
  `/usr/bin/sandbox-exec`, Settings lists why beside what boot skipped; a CLI sign-in retry
  checks again. sandbox-exec cannot nest, so claude's own sandbox is forced off and
  codex runs in `external-sandbox`, a mode
  `patches/@agentclientprotocol__codex-acp@1.12.0.patch` adds: no sandbox of codex's own,
  and it asks before every command and patch. A codex-acp upgrade must carry that patch.
  Runs start Chrome for agent-browser without its own sandbox
  (`AGENT_BROWSER_ARGS=--no-sandbox`), in a daemon namespace of the save's own
  (`AGENT_BROWSER_NAMESPACE`) that neither the founder's agent-browser nor main's live-page
  read starts unsealed, and install packages into the save's `cache/` (`TOOL_CACHE_ENV` in
  `main/agents/agent-driver.ts`).
- `IDLEBIZ_WEB_URL` points the Stripe Connect hop at a local `apps/web`
  (`main/stripe-connect.ts`); `CLAUDE_BIN` / `CODEX_BIN` override the CLI paths
  (`packages/agent-driver/src/detect.ts`).
- `IDLEBIZ_COUNT_TEST_MONEY=1` counts test-mode Stripe charges toward revenue and bets, for
  an end-to-end run of a revenue bet on a test key. Without it only live-mode money counts:
  a test-mode key reads as "Stripe is in test mode — no charge counts" in the brief and
  `measure_bet` refuses a revenue bet on it (`main/metrics.ts`).
- `IDLEBIZ_ROOT_DIR` overrides the save and secrets directory for isolated runs. Defaults
  to `~/.idlebiz`; use a fresh temporary directory for desktop verification.
- `apps/desktop/.env` (see `.env.example`) is release-only: Apple notarization keys for
  `pnpm --filter @repo/desktop release`.

## Rules that matter

- **One active company per launch.** Boot selects the newest company by `createdAt`
  (alphabetical slug breaks ties), then loads and migrates only that save. Older saves
  stay untouched. Unreadable company metadata blocks loading and founding; entity IDs
  resolve only within the active company. There is no company switching during a launch.
- **No `any`, no non-null `!`, no `as` casts.** Kebab-case filenames. Make illegal states
  unrepresentable.
- **Headless interactions are Base UI** (`@base-ui/react/<part>`), skinned with px-kit:
  `renderer/ui/modal.tsx` (Dialog) and `renderer/ui/choice-menu.tsx` (Toolbar) are the
  patterns. Don't hand-roll a dialog, menu or toggle.
- **The px-kit beats Tailwind.** `.px-*` classes in `packages/px-kit/px-kit.css` are
  unlayered, so they win over any Tailwind utility that sets the same property. Size and
  colour belong in the kit as a class, never per-component. Full explanation in `CLAUDE.md`.
- **Some icons deliberately use OS fonts.** VG5000 lacks recognizable equivalents for
  ⚙ settings, 💼 company, and ☕ idle; ❗ attention and ⚠ warnings retain their color cues.
  These fallback glyphs are exceptions. Keep the vendored font unchanged.
- **Only closed work is history.** `done` tasks move to `shipped/` and load on demand;
  so does an ask the founder answered, `superseded` by its continuation, and work the
  steering loop `dropped` (its bet stopped taking work, its product was retired, its
  assignee released), neither ever a ship. `dead` tasks — runs that failed on their own —
  stay in the active queue because the Inbox can retry them and employees use them to
  identify unresolved problems. `listTasks` answers open work only; the one
  reader of history is `shippingLog`, which sends each ship as a line without its brief.
- **Office art and collision are independent sections of `office-design.json`.** After any
  layout edit run `pnpm --filter @repo/desktop check:office` (already part of `pnpm verify`).
  Six passes: every seat, point of interest and the door reachable from spawn; no open
  floor cell no body can stand on; no reachable spot with the player's art (facing right)
  over the void; no reachable spot with the player's face painted over; no placed object
  naming art this build lacks; every placed sprite measured from its PNG (run
  `generate:sprite-bounds` after adding art). The walker seals the second and the scene
  seals the fourth at boot (`shared/office-grid.ts`, `shared/office-sight.ts`), so a saved
  layout is safe to walk even when its data would fail the gate; main opens one failing
  the fifth as the bundled office and refuses to save it, and refuses one whose fourth-pass
  spots, once closed, cut a seat, point of interest or the door off, or close in the spawn.
- **Tests need no Electron or Phaser.** `pnpm --filter @repo/desktop test` covers geometry,
  schemas, codecs, store/integration behavior under temporary save roots, and real loopback
  requests and real `/usr/bin/git` pushes to bare repositories on disk. On macOS it also runs the seal on canary files under a stand-in home
  (`seal.test.ts`), and, where a `claude` or `codex` CLI is installed, the real CLI through the
  app's ACP adapter against a stand-in model on loopback, billing nothing and never touching
  its login (`claude-gate.test.ts`, `codex-gate.test.ts`); all skip elsewhere. Command policy
  rules each need a matching example; everyday commands must remain allowed. Drive anything
  requiring a window live instead, or cover it in the e2e suite.
- **IPC goes through the registry.** `shared/ipc-channels.ts` is the runtime source of truth
  for channel names and must stay dependency-free (the sandboxed preload imports it);
  zod payload schemas live in `shared/ipc-registry.ts`, and a method's payload type IS its
  schema's output — declare the schema, never a parallel type. Main registers every handler
  from one `IpcHandlers` map (`main/lib/ipc-handler.ts`), so a channel without one fails to
  compile. A handler's throw crosses as an `IpcReply` refusal (`main/lib/ipc-reply.ts`) the
  preload rethrows bare, so the founder reads the store's sentence, not Electron's wrapper;
  frame and payload checks still throw. A throw that is not a `RefusalError`
  (`shared/refusal.ts`) is a fault and is reported too.
- **Main keeps a log file.** `main/lib/log.ts` sends main's console, uncaught errors and
  crashed renderer or child processes to `main.log` under `app.getPath("logs")`
  (`~/Library/Logs/IdleBiz/`; dev: `logs/` in the `IdleBiz (dev)` userData, or in `roots/<id>/` beneath it for an isolated `IDLEBIZ_ROOT_DIR`), never under the
  save root, which a reset deletes. A catch that carries on past an unexpected error calls
  `report` (`main/lib/report.ts`); a boot that throws says where the log is and exits.
- **Everything main says happened goes through `main/activity.ts`.** `publishActivity`
  stamps, persists and fans out one `ActivityEvent` (`shared/activity.ts`, a discriminated
  union on `kind` with typed payloads). Consumers switch on `kind`; nobody re-parses a
  payload, and a second emit path would be a listener somebody forgot.
- **The activity log is an audit trail, not a query store.** State that outlives a run is
  written where it is known: the founder's digest folds into `state/since-last-look.json` as
  each event publishes (`store.logActivity`, `main/store/digest.ts`), and what a run leaves
  for the next — the session to resume and a digest of the instructions it holds, where the
  real numbers stood, what they last shipped — sits in `agents/<slug>/run-state.json`, so
  AGENTS.md changes only when the instructions do. A resumed session is sent them again only
  when that digest no longer matches.
  The brief's "recently shipped" lines come from `state/recent-ships.json`, written with the
  ship. Nothing reads `activity.jsonl` back: main appends to it and pushes each event to
  the renderer, whose feed starts empty every launch. Company-level running state goes in
  `<company>/state/` (path helpers in `main/paths.ts`); what the founder configured
  (`metrics.json`, `approvals.json`) stays beside COMPANY.md.
- **Vocabularies are `as const` tuples** (`TASK_STATUSES`, `INTEGRATION_KINDS`,
  `BUSINESS_TYPE_IDS`, `RUNNER_IDS`): the type and the zod enum both derive from the tuple,
  so there is nothing to keep in sync.
- **Prose an employee reads lives in `main/prompts/`.** The store persists it and the
  scheduler gathers what it is grounded in; neither authors text.
- **`apps/desktop` `dependencies` is exactly what the app ships.** electron-builder unpacks
  it into node_modules: the ACP adapters main spawns (they bring their own zod and ACP sdk)
  and sharp (native, kept out of the bundle in `electron.vite.config.ts`). Everything Vite
  bundles — zod, the ACP sdk, renderer libs, `@repo/*` — goes in `devDependencies`, or the
  app ships it unpacked for nothing. `pnpm add` defaults to `dependencies`.

## Map

- `apps/desktop/src/main` — the control plane. `store/store.ts` (the one company in memory,
  every command on it, and its writes), `store/*-codec.ts` (one pure markdown package ⇄
  domain object mapping per kind; `company-codec.ts` owns the save format stamp), `paths.ts` (the on-disk save format, documented at the top), `scheduler.ts` (the
  idle loop), `agents/` (runs), `control-plane.ts` (loopback HTTP the agents curl back into),
  `agents/seal.ts` (the Seatbelt profile each run starts under, and its boot check),
  `activity.ts` (the one publisher), `prompts/` (what employees are told), `lib/fs.ts`
  (every write, atomic and behind the reset gate), `stripe-connect.ts` / `vercel-connect.ts`
  (the two integrations, same shape), `stripe-key.ts` (the charging key the founder enters),
  `deploy.ts` (the Vercel API calls the `deploy` tool makes), `git-push.ts` (the git
  calls the `push` tool makes, none inside the workspace's repository),
  `payment-links.ts` (the Stripe calls `create_payment_link` makes), `secrets.ts`,
  `metrics.ts`, `tray.ts`.
- `apps/desktop/src/renderer` — React overlay (`ui/`) over a Phaser 4 scene (`game/`), with a
  hand-rolled external store in `state/store.ts`.
- `apps/desktop/src/shared` — `ipc-channels.ts`, `ipc-registry.ts`, `domain.ts`,
  `activity.ts`, `command-policy.ts` (rules over the words `shell-lexer.ts` reads from a
  line as bash would, read loosely as well where another shell may split it apart),
  `hold-rules.ts` (what an approval card says each rule holds; data only, for the renderer),
  `format.ts`, `errors.ts`, `character-frame.ts` (the
  sprite box every process slices by), `office-depth.ts` (draw bands + paint order),
  `office-layout-schema.ts` (office-design.json, versioned and migrated), `office-grid.ts`
  (walking as pure math), `office-sight.ts` (where the room hides a face) and
  `office-object-sprite.ts` (the PNG each placed object draws); the scene, the save
  handler and `check:office` all use the last four.
- `apps/web` — landing page plus the three Stripe Connect route handlers.
- `packages/agent-driver` — spawns the `claude` / `codex` ACP adapters, normalizes events,
  prices usage, and tracks rate limits. Source-only, no build step.
- `packages/stripe-connect-protocol` — the handshake between the desktop's loopback server
  and the web's Stripe routes: paths, the state codec, the callback outcome. Both ends import it.
- `packages/px-kit` — the pixel-UI design system as one stylesheet (palette, `@theme` tokens,
  VG5000, every `.px-*` class), imported by both apps after Tailwind.
