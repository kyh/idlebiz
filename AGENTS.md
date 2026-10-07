# AGENTS.md

**IdleBiz** is a retro RPG-style idle business sim where the employees are the player's own
coding CLIs. The app is two programs, laid out as kyh/inteligir's are: `apps/desktop`, a Tauri
shell around the office page, and `apps/cli`, the `idlebiz` binary, whose `idlebiz serve` is
main, the node process that spawns real `claude` / `codex` sessions and saves the whole company
as human-readable markdown under `~/.idlebiz/`. Every other verb of `idlebiz` is a company tool
the employees call. A small Next.js landing page (`apps/web`) ships the download and the Stripe
Connect OAuth hop. This is the tool-agnostic guide for coding agents — meant to be run, not just
read. Claude also reads `CLAUDE.md`; both point back here.

Paths below are short, as in CLAUDE.md: `server/…` and `commands/…` are under `apps/cli/src/`,
`renderer/…` under `apps/desktop/src/`, `src-tauri/…` under `apps/desktop/`, and
`@repo/<package>/<module>` is `packages/<package>/src/<module>.ts`.

> Naming: this file is repo documentation. The `AGENTS.md` files under
> `~/.idlebiz/<company>/agents/<slug>/` are game data — the in-game employee's own
> instructions (`server/paths.ts`). Unrelated.

## Quickstart

```sh
pnpm install
pnpm verify        # static gate: typecheck · lint · format · test · build
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
after three seconds. Main stops its runs first on the TERM. `pnpm dev:web`, `pnpm verify`, tests
and a running `pnpm e2e` survive it. It leaves an unrelated process on TCP **31100**, the dev
server's port, alone, and startup fails while that port is occupied.

Both build main (`apps/cli`'s bundle, `apps/cli/dist`) before the page is served and again on each
change: `tauri dev` restarts the shell when main's bundle changes
(`--additional-watch-folders ../cli/dist`), and `dev:browser` restarts main itself. A change to the page is hot-reloaded; a change to the shell's Rust rebuilds and relaunches
it.

## The one hard prerequisite

The app is inert without a **signed-in `claude` or `codex` CLI on PATH**.
`packages/agent-driver/src/detect.ts` probes `claude auth status` / `codex login status`;
`agents.hasAuth` (`server/page-router.ts`) gates the UI behind
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

Static gate (`.github/workflows/ci.yml` runs the same steps on every push to main and every
PR, as named steps; Vercel's build of `apps/web` is a second remote check):

```sh
pnpm verify
```

**Lint is a clean gate.** `oxlint.config.ts` extends the ultracite presets (`ultracite/oxlint/core`, `react`, `anti-slop`; `next` scoped to `apps/web`); every rule is an error and `lint` fails on the first one. It is type-aware (`options.typeAware`, run by the `oxlint-tsgolint` devDependency): without it the presets' `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `no-deprecated` and `no-unsafe-*` are skipped without a word. The deliberate overrides, each with its reason beside it in the config:

- `no-await-in-loop` off: sequential awaits are intentional (ordered agent turns, paced writes).
- `switch-exhaustiveness-check` takes a `default` as exhaustive: it is how a consumer says every other kind means nothing to it. A switch that must name every kind has none; the activity reducer's table of slices is typed over every kind instead (`satisfies Record<ActivityKind, …>`).
- `no-confusing-void-expression` off: `() => set(x)` is the house style.
- `strict-boolean-expressions` off: truthiness checks on optionals are idiomatic here.
- `promise-function-async` and `strict-void-return` off: taste; a dropped or misplaced promise is still `no-floating-promises`' and `no-misused-promises`' to catch.
- `consistent-return` off: a bare `return` in a `T | undefined` helper is deliberate.

Prefer fixing code over `oxlint-disable` comments; when a rule is genuinely wrong for a line, disable that line with a `-- reason`.

End-to-end suite — `pnpm e2e` builds the page and main, then drives them with Playwright in
Chromium (`tools/e2e/`): each launch starts the built main through the dev host
(`apps/cli/src/dev-host/host.ts`), which answers main's asks of a native app as the shell would,
and opens the built page main serves on the handoff link main hands it, as the shell's window
opens. `pnpm -F @repo/e2e e2e` reruns it on the last build. The shell itself (the window, the
menu-bar icon, the Keychain, the login item) is Rust's, held by `cargo test` and driven by hand.
The suite covers the title screen, a founded company's
office (HUD, #team, one NPC per hire), Vercel and Stripe key entry (a key taken is sealed,
shown as set and, for Stripe, replaceable and removable; a key refused is never saved), Printful token entry
(a token Printful takes is sealed, shown with its store, replaceable and removable), a key pasted into
secrets.json being sealed, a held command denied from #team, an action card answered, keys
held into a window let go of when it closes, #team kept on its newest line and shown again when
its window reopens, a long ask kept on screen, a typed answer kept while the dialogue's menu is
hovered, the dialogue's cursor kept on Talk… as rows come ahead of it, Start refused while out of
budget, a Stripe sign-in left in the browser started over, retiring the selected product, a file
boot skipped named in full, and a save a newer build wrote asking for an update. It is local only, not part
of `pnpm verify` or CI:

- It needs Playwright's Chromium (`pnpm -F @repo/e2e exec playwright install chromium`, once).
- Every test that founds a company (the office, the #team approval, the panels, Vercel,
  Stripe and Printful key entry, sealing) needs a signed-in `claude` or `codex` CLI under the
  macOS seal and skips without one, so off a Mac only the title screen and the newer save run.
  The refusal tests send made-up keys to the real Vercel and Stripe APIs, so they need the
  network; where a key is taken, main is started with `tools/e2e/src/stub-services.ts` preloaded, which
  answers those APIs and Printful's from canned JSON (`launch({ stubServices: true })`), so no
  real account or key is needed.
- It runs beside `pnpm dev:desktop` and `pnpm dev:browser`: each launch serves its page on a port
  of its own, and opens an isolated root.
- It never spends. Each test gets a fresh `IDLEBIZ_ROOT_DIR` and founds through the page's API
  with a hand-written team (no casting run), a $0 cap and autopilot off; the
  scheduler checks the budget before it spawns anything, so no run can start. It directs
  nobody, and every test ends by asserting its save logged no `run.start`.

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
> launch paid CLI sessions. `IDLEBIZ_ROOT_DIR` overrides the default `~/.idlebiz` root
> (`server/paths.ts`). The whole shell env reaches main, and the employees' CLIs less its
> credential-shaped names, as in a terminal launch. Isolation protects the real save, but
> onboarding and employee runs still bill the signed-in CLI.

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
| `apps/web` landing + `/api/stripe/*`   | `pnpm dev:web`                        | no          |
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

## Configuration

Nothing is required to run. Every key is optional and its absence disables one feature
rather than crashing boot.

- `apps/web` — `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY` (see `.env.example`, read through
  `src/lib/env.ts`). Missing ⇒ `/api/stripe/*` refuses the flow with a clear message.
- Desktop runtime secrets live in `~/.idlebiz/secrets.json`, not a `.env`. They are
  IdleBiz's own: main reads each where it uses it (`getSecret` in `server/secrets.ts`) and
  exports none into any env, so no employee holds `STRIPE_SECRET_KEY` or `VERCEL_TOKEN`.
  Employees run as the founder's OS user: every run's seal (below) keeps it from the file,
  and each value is also sealed with the macOS Keychain as Electron's `safeStorage` sealed it
  (Chromium's OSCrypt over the "IdleBiz Safe Storage" item, which the shell reads and hands
  main at hello; `server/lib/os-crypt.ts`, `setSealer` at boot) as `sealed:v1:<base64>`, since a
  claude run can still reach the Keychain. Enter
  keys in the app: `VERCEL_TOKEN` through a product's Vercel button (under users), Stripe in
  the Budget panel (under revenue). A key pasted into the file as plain text is sealed the
  next time main reads it. One the Keychain can't open (another build sealed it, or access
  was denied) reads as absent, is named in Settings and stays as it is: enter it again.
  Dev (any unpackaged launch, e2e too) seals with Chromium's mock keychain's password: a
  development shell is ad-hoc signed, so the real Keychain would ask again after every rebuild
  and stall automation. It never touches the Keychain, and it seals with a fixed key: a key dev
  sealed is no secret and only dev opens it. On the
  real save (no `IDLEBIZ_ROOT_DIR`) dev seals nothing, so the packaged app's keys read as
  absent there and one entered there is written plain for the app to seal. Use
  `IDLEBIZ_ROOT_DIR`.
  Employees charge through the `create_payment_link` tool, which makes the link with
  `STRIPE_SECRET_KEY` in main (`server/payment-links.ts`) once the founder signs off; with no
  key it leaves the founder a Stripe card that opens the Budget panel, whose charging-key row
  saves a key only once Stripe has taken it (`server/stripe-key.ts`) and resumes the work that
  waited on it. A new key is pasted over the saved one, never after removing it: a pulse
  between the two finds no key and hands each retiring link to the founder to switch off by hand. A restricted key needs Write on Payment Links, Prices and Products to charge,
  and Read on Charges for the revenue read below (without Connect) and for each paid print,
  whose payment the order pump reads before Printful is paid (with Connect too), Read on
  Checkout Sessions for the order pump, and Write on Shipping Rates to sell a print, which
  `sell_print` checks with a read of all three (`stripeListingAccess`) before it asks for the
  sign-off. A link's optional
  `delivery` (what the founder hands each buyer) rides on the link's metadata alone, is part of
  the action the founder signs, and needs Read on Checkout Sessions, which
  `create_payment_link` checks first (`stripeCheckoutAccess`). Every `create_payment_link` also
  asks Stripe whether the key still reads payment links (`stripeLinkAccess`) before the sign-off,
  so a key rolled, revoked or expired since it was saved leaves a Stripe card instead; one Stripe
  turns away while making the link or a listing's (401/403) leaves the same card. Its optional `afterPaymentUrl`
  sends each buyer back to the product, on one of its verified production domains
  (`productionHosts`), with `session_id={CHECKOUT_SESSION_ID}` added
  (`after_completion[type]=redirect`), and is signed too (`then send buyers to <url>`): the
  product's own server reads that session with a Checkout Sessions: Read key the founder makes
  for it (`set_env` refuses any `sk_` key), which is how a paid unlock checks who paid. Employees read Printful's catalog with `printful_catalog` (`printfulCatalog` in
  `server/printful.ts`) and list a print with `sell_print` (`server/print-listing.ts`): main checks
  the print files against the product's verified production domains (`productionHosts` in
  `server/vercel.ts`) and hashes each (`readPrintFile`), prices it with Printful's estimates
  (`server/printful.ts`, polled every 3s and backing off on a 429), refuses a price under the
  floor, and once signed off makes the shipped payment link (`stripeShippedLink` in
  `server/payment-links.ts`, each POST with an idempotency key) and saves the listing under
  `listings/`. Paid orders reach Printful through the order pump (`server/order-pump.ts`),
  which the metrics pulse runs: while a Stripe key is saved it reads Stripe's checkouts
  (`server/stripe-checkouts.ts`) every 30 minutes, keeps each paid one on the company's links
  under `orders/` (a retired product's too) from a cursor kept per key,
  and drafts, prices and confirms a print on Printful (`server/printful-orders.ts`) once its cost
  fits in what Stripe's fee on a card leaves and its payment is by card, neither refunded nor disputed; a `create_payment_link` sale is a
  `link` order, carded to the founder when its link names a `delivery`. Anything it cannot
  settle is an order card in the Inbox, and `read_orders` lists orders for support. Its tests fake Stripe, the product's site and Printful
  at `fetch` (`server/order-pump.test.ts`). `create_payment_link` keeps each link it makes under
  `links/`; retiring a product switches off its links, a listing's too, with the key
  (`switchOffRetiredLinks` in `server/company-actions.ts`, run by the retirement and every pulse;
  `server/retired-links.test.ts`), asking again each pulse while Stripe does not answer, and a
  live link Stripe refuses or never answers for, or one with no key saved, is a card naming it
  (a test-mode one, a line in the room). A reset waits for each signed link Stripe is
  still making and refuses a new one (`makingPaymentLink`), then switches off every live link
  (`switchOffBeforeReset`) and warns of what it could not, with each paid print Printful never
  confirmed (but a held one whose card the founder settled) and each paid order whose card still waits on the founder. The Printful token is pasted in the Budget panel, kept only once Printful shows it can
  place orders in exactly one store (`server/printful-token.ts`); with none, or one Printful
  refuses, the tool leaves a Printful card that opens that panel, where a new token replaces the
  saved one. Metrics reads revenue with the Stripe key
  whenever one is saved, since every payment link and so every tagged charge is on its
  account; only with no key does the company whose `metrics.json` holds the connected
  account read through `STRIPE_CONNECT_TOKEN` (`stripeCredential` in `server/metrics.ts`), so
  a grant on another account, or one revoked, never stands between a bet and its money. The
  Connect token is read-only. A key Stripe
  refuses shows in the Budget panel — a Connect token as revoked, with Disconnect beside Reconnect
  while main still holds its grant, the own key as the charging key — until a pulse finds Stripe taking a key again, or no key left (`noteStripeRead` in
  `server/stripe-connect.ts`). One `VERCEL_TOKEN` serves every product:
  binding another reuses it unless the founder pastes a new one. Each product binds a project
  of its own (a project another product holds is refused). The first token saved, through
  any product, resumes every Vercel ask, since it is what each product's deploy lacked; after
  that a binding resumes only the Vercel asks about that product or about none: an ask names the product it is about
  (`productId`, saved as the task's `askProduct`), which a run may name other than its own,
  and its Inbox card opens that product's binding. A refused token shows on
  each bound product as "vercel refused". One that fails to parse is listed in Settings and never rewritten
  (`readJsonFileForUpdate` in `server/lib/fs.ts`; `metrics.json` too). Employees deploy
  through the `deploy` tool, which uploads the product's folder through Vercel's API with
  `VERCEL_TOKEN` in main (`server/deploy.ts`) once the founder signs off. Before the sign-off is
  asked, and before `set_env` sets anything, Vercel is asked whether it still takes the token
  (`validateToken`): one it turns away (expired, revoked) leaves the founder a Vercel card rather
  than spend the sign-off on a deploy that would fail. No tool pushes
  code: the founder pushes by hand from a fresh `git clone --no-local` of the workspace, never
  with git inside it, which obeys what the team left there, as the founder (CLAUDE.md). A run
  cannot use their ssh keys or agents; what it can still reach, the Keychain on a claude run
  included, is CLAUDE.md's "What stays open". A product's own keys go on its bound project
  through `set_env`, unsigned: main sets the variable with `VERCEL_TOKEN`, sensitive for
  production and preview (`server/vercel-env.ts`), replacing only a name set_env set, and keeps
  each value Vercel took in `secrets.json` under `ENV/<company>/<product>/<project>/<NAME>` (never the
  save, which runs read) so `deploy` refuses a folder whose files hold any of them, before the
  sign-off is asked, naming the file and the variable, never the value. A public name
  (`NEXT_PUBLIC_`, `VITE_`…, `server/env-name.ts`) is the exception: its value is built into the
  page, so a deploy ships it, and set_env refuses one shaped like a secret, or one it keeps under
  a server-only name, under it. No tool sets a project's domains or sells a subscription: those
  stay the founder's.
- A run's env is the founder's (main's) less every credential-shaped name — `TOKEN`,
  `SECRET`, `PASSWORD`, `KEY`, `APIKEY`, `PAT`, `DSN`, `WEBHOOK`, `CREDENTIALS`, `AUTH` as
  whole `_` segments, so `SSH_AUTH_SOCK` too — and every URL with a login in it but a
  `*_PROXY`, except its runner's own login (`providerEnv` in
  `packages/agent-driver/src/registry.ts`; `runEnv` in `server/agents/run-env.ts`). AWS access
  keys sign for the whole account, so neither runner keeps them, and the seal hides `~/.aws`
  (`LOGINS` in `seal.ts`), so no AWS profile loads either: a founder on Bedrock signs in with
  `AWS_BEARER_TOKEN_BEDROCK` only. On Vertex, `GOOGLE_APPLICATION_CREDENTIALS` must name a key
  file outside the sealed logins: gcloud's default credentials under `~/.config/gcloud` are
  hidden too. A claude session loads none of the founder's settings, so the `env` of their
  claude user settings reaches the run the same way, filtered alike, beside the sign-in helpers
  and the model and effort named there (`claudeUserSettings` in
  `server/agents/claude-user-settings.ts`).
- Every employee run starts sealed, under the Seatbelt profile `server/agents/seal.ts` renders
  and hands `sandbox-exec -p`; CLAUDE.md ("Two boundaries hold a run") has the whole model and
  what it leaves open. Reads are open but for the founder's logins (`LOGINS`), `secrets.json`,
  the other runner's home and, for codex, the founder's skills, instructions and memories, and
  their rules, which read as missing (codex refuses to start on an unreadable one), since an
  `allow` there runs a command without asking IdleBiz. Writes are denied but for the run's own folders (workspace,
  shared, memory, the save's `cache/`), its runner's state (`state` in `RUNNER_HOMES`, a list
  of names in the home: a CLI upgrade that writes a new one fails with `EPERM` there until it is
  added), temp and per-user cache folders and its agent-browser namespace. So in the runner's
  home it writes nothing that CLI loads or runs (claude's `~/.claude.json` included) and no
  other folder's claude `projects/`; nowhere does a run write git's config or hooks, `.claude/settings*.json`,
  `.mcp.json` or `.codex/`, nor `.agents` in its own folders, where codex finds skills.
  It connects to no unix socket but its own folders', its namespace's and its own line to the
  company (`IDLEBIZ_API_SOCKET`, a socket main opens per run: another run could read its token
  from its env, never reach its socket), to no loopback
  debug port (9222, 9229), the dev server's (31100) or the one main serves the window's page on, and a codex run reaches no Keychain: a codex whose login is there
  reads as signed out, so its employees' work waits on the queue. Main makes a product's workspace a repository
  and claude's `projects/` before a run and sets the run's git identity by env;
  `TOOL_CACHE_ENV` in `server/agents/agent-driver.ts` moves TMPDIR and toolchain caches into
  `cache/`, so a tool that writes elsewhere in HOME fails with `EPERM` until its cache is
  moved there too. A git dependency fails as well: npm and pnpm clone it into a `.git` no run
  may make, and so do `git clone` and `git init`; the standing instructions say so and point
  runs at a repository's tarball instead. Boot checks
  the seal without a model call (a read and a write canary per runner); until it holds, no run
  starts, and a refusal is listed in Settings. sandbox-exec cannot nest, so claude's own
  sandbox is forced off, runs start Chrome without its own (`AGENT_BROWSER_ARGS=--no-sandbox`),
  and codex runs in `external-sandbox`, a mode
  `patches/@agentclientprotocol__codex-acp@1.12.0.patch` adds: no sandbox of codex's own, and
  it asks before every command and patch. A codex-acp upgrade must carry that patch.
- `IDLEBIZ_WEB_URL` points the Stripe Connect hop at a local `apps/web`
  (`server/stripe-connect.ts`); `CLAUDE_BIN` / `CODEX_BIN` override the CLI paths
  (`packages/agent-driver/src/detect.ts`).
- `IDLEBIZ_COUNT_TEST_MONEY=1` counts test-mode Stripe charges toward revenue and bets, for
  an end-to-end run of a revenue bet on a test key. Without it only live-mode money counts:
  a test-mode key reads as "Stripe is in test mode — no charge counts" in the brief and
  `measure_bet` refuses a revenue bet on it (`server/metrics.ts`), even beside a live Connect
  grant, since the key IdleBiz charges with makes every link.
- `IDLEBIZ_ROOT_DIR` overrides the save and secrets directory for isolated runs. Defaults
  to `~/.idlebiz`; use a fresh temporary directory for desktop verification.
- `apps/desktop/.env` (see `.env.example`) is release-only: Apple notarization keys for
  `pnpm --filter @repo/desktop package`.

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
  unlayered, so they win over any Tailwind utility that sets the same property
  (`renderer/px-kit-overrides.test.ts` fails on one in the desktop renderer). Size and
  colour belong in the kit as a class, never per-component. Full explanation in `CLAUDE.md`.
- **Some icons deliberately use OS fonts.** VG5000 lacks recognizable equivalents for
  ⚙ settings, 💼 company, and ☕ idle; ❗ attention and ⚠ warnings retain their color cues.
  These fallback glyphs are exceptions. Keep the vendored font unchanged.
- **Only closed work is history.** `done` tasks move to `shipped/` and load on demand;
  so does an ask the founder answered, `superseded` by its continuation, and work the
  steering loop `dropped` (its bet stopped taking work, its product was retired, its
  assignee released), neither ever a ship. `dead` tasks — runs that failed on their own —
  stay in the active queue until their bet stops or their product retires, because the Inbox
  can retry them and employees use them to
  identify unresolved problems. `listTasks` answers open work only; the one
  reader of history is `shippingLog`, which sends each ship as a line without its brief.
- **The office is frozen data.** `renderer/game/office-design.json` is the one office:
  placed sprites, each naming its PNG under `public/`, over a 16px collision grid, with the
  seats, points of interest, door and spawn. No tool authors it; `office-layout.test.ts`
  checks its schema, its art paths and that spawn reaches every seat, POI and door. Its art and its
  collision are independent sections, and the 32x64 sprite overhangs the 16x12 body probe,
  so a hand edit to either can stand a character over the void or behind furniture. The
  walker makes each seat's cell solid and seals open floor no body can reach
  (`walkGridOf` in `renderer/game/office-grid.ts`).
- **Tests need no window or Phaser.** `pnpm --filter idlebiz test` covers main: schemas, codecs,
  store/integration behavior under temporary save roots, real loopback and socket requests, the page's
  router and the `idlebiz` verbs against a live control plane. `pnpm --filter @repo/desktop test`
  covers the page's geometry and state, then `cargo test` the shell (the relay's framing, main's
  supervision against a stand-in main on node, the navigation pin, the runtime's paths, main's
  log). On macOS main's suite also runs the seal on canary files under a stand-in home
  (`seal.test.ts`) and main's login-shell probe on a stand-in home's startup files
  (`shell-path.test.ts`), and, where a `claude` or `codex` CLI is installed, the real CLI through the
  app's ACP adapter against a stand-in model on loopback, billing nothing and never touching
  its login (`claude-gate.test.ts`, `codex-gate.test.ts`), and, where `agent-browser` is
  installed, the real agent-browser under a run's seal (`browser-gate.test.ts`); all skip
  elsewhere. Command policy
  rules each need a matching example; everyday commands must remain allowed. Drive anything
  requiring a window live instead, or cover it in the e2e suite.
- **The page's API is a contract.** `packages/contract` declares every procedure the page
  calls of main (oRPC, one folder per domain, `<domain>-contract.ts` beside `<domain>-schema.ts`,
  whose zod schemas ARE the inputs' types — declare the schema, never a parallel type), and
  `server/page-router.ts` implements it, so a procedure missing or mistyped fails to compile.
  The page calls `api().<domain>.<procedure>()` (`renderer/api.ts`, installed once by
  `renderer/install-api.ts`) on its own origin, since main serves it (`server/page-server.ts`):
  under `/rpc`, behind the session cookie and same-origin guards, with main's events on one
  server-sent stream, `/events`, named by `@repo/contract/events` (`listen()`). One middleware
  words every answer that does not return (`server/lib/answers.ts`): a `RefusalError`
  (`server/refusal.ts`) is the store's bare sentence, which the page shows; text over a field's
  limit says the limit; anything else is a fault, answered with its message and reported to
  main's log. The shell reaches no part of it: it talks to main over main's stdio (JSON-RPC 2.0,
  one message a line: `server/relay/rpc.ts`, `src-tauri/src/relay.rs`), and the page reaches no
  command of the shell's.
- **A run reaches main as `idlebiz <tool>`, never through the page.** Each company tool is a
  verb of the `idlebiz` binary (`commands/tools.ts`), generated from its spec in
  `server/tool-specs.ts` (route, body, lead-only refusal, doc, example), so the instructions,
  the verb and the server cannot disagree. Main writes a launcher at each boot
  (`server/agent-launcher.ts`, `~/.idlebiz/bin/idlebiz`), which runs the CLI on main's own node
  and goes first on each run's PATH. The verb sends its request to the control plane its run was
  handed (`IDLEBIZ_API_URL`, `IDLEBIZ_RUN_TOKEN`; `server/control-plane.ts`), on loopback only,
  prints the answer, and exits 1 with why when a call is refused; `-` reads the request from
  stdin. `idlebiz <tool> --help` prints the tool's doc.
- **Main asks the shell for what only a native app does** (`server/host.ts`): a message box, the
  clipboard, Finder and the browser, the menu-bar icon (main decides it, `server/tray.ts`; the
  shell draws it, `src-tauri/src/tray.rs`), a notification, the login item (`SMAppService`), the
  Mac kept awake while a run is in flight, a relaunch. The shell says hello first, with what only
  it knows: whether it is the packaged app, the dev server's address in dev, whether the login
  item launched it, the Keychain's password.
  Main's stdin is its lifeline: the shell closes it only after main answers `quit`, so a shell
  that crashed or was killed ends main too, after its runs.
- **Main keeps a log file.** Main's console is its stderr, which the shell appends, stamped, to
  `main.log` (`src-tauri/src/main_log.rs`; `~/Library/Logs/IdleBiz/`; dev: `logs/` in the
  `IdleBiz (dev)` data folder, or in `roots/<id>/` beneath it for an isolated
  `IDLEBIZ_ROOT_DIR`), never under the save root, which a reset deletes; `server/lib/log.ts` sends
  uncaught errors there too. A catch that carries on past an unexpected error calls
  `report` (`server/lib/report.ts`); a boot that throws says where the log is and exits.
- **Everything main says happened goes through `server/activity.ts`.** `publishActivity`
  stamps, persists and fans out one `ActivityEvent` (`@repo/domain/activity`, a discriminated
  union on `kind` with typed payloads). Consumers switch on `kind`; nobody re-parses a
  payload, and a second emit path would be a listener somebody forgot.
- **The activity log is an audit trail, not a query store.** State that outlives a run is
  written where it is known: the founder's digest folds into `state/since-last-look.json` as
  each event publishes (`store.logActivity`, `server/store/digest.ts`), and what a run leaves
  for the next — the session to resume and a digest of the instructions it holds, where the
  real numbers stood, what they last shipped — sits in `agents/<slug>/run-state.json`, so
  AGENTS.md changes only when the instructions do. A resumed session is sent them again only
  when that digest no longer matches.
  The brief's "recently shipped" lines come from `state/recent-ships.json`, written with the
  ship. Nothing reads `activity.jsonl` back: main appends to it and pushes each event to
  the renderer, whose activity ring starts empty every launch; #team reads the room back from
  main's copy of `chat.jsonl` instead. Company-level running state goes in
  `<company>/state/` (path helpers in `server/paths.ts`); what the founder configured
  (`metrics.json`, `approvals.json`) stays beside COMPANY.md.
- **Vocabularies are `as const` tuples** (`TASK_STATUSES`, `INTEGRATION_KINDS`,
  `BUSINESS_TYPE_IDS`, `RUNNER_IDS`): the type and the zod enum both derive from the tuple,
  so there is nothing to keep in sync.
- **A product's notes for teammates are `AGENTS.md` at its workspace's root**, for both
  runners: codex reads it itself; a claude run, which loads no CLAUDE.md, is handed it beside
  its system prompt (`readTeamNotes` in `server/agents/team-notes.ts`), as the team's notes, never
  the founder's word, picked and cut as codex's session config has codex pick and cut them. Not to be confused with an employee's own `agents/<slug>/AGENTS.md`.
- **Prose an employee reads lives in `server/prompts/`.** The store persists it and the
  scheduler gathers what it is grounded in; neither authors text. `instructions.ts` says how
  each business type earns (`BUSINESS_MODELS`; VC sells information, never investment) and
  teaches the tools as one flow: an `ask_boss` action card for any step only a human can take,
  `set_env` for a key the founder hands back, `sell_print` and `read_orders` for prints, and a
  link's `delivery` for what the founder sends each buyer, never an `ask_boss` card, and
  "Checking who paid" for an unlock the product's server checks with Stripe. No prompt
  tells a run to push: the founder pushes by hand (`instructions.test.ts` checks both).
- **The budget is usage at API prices**: what the runs would cost billed per token, not what
  the founder's plan bills. The tray and HUD label it `usage` (`usageLabel` in
  `@repo/domain/format`); the Budget panel, the digest, onboarding and the HUD's tooltip say it
  is at API prices. A turn cut off before its agent answers (the watchdog, Stop, a quit, a
  crash) still bills what its usage updates reported, as uncached input (`runAcpTurn`).
- **`apps/cli` `dependencies` is exactly what the server ships.** The pack stages the `idlebiz`
  package with `pnpm deploy` (`apps/desktop/scripts/stage-server.ts`) into
  `Contents/Resources/server`: its bundle (the page staged inside it), its `resources/`, and the
  dependencies it does not bundle — the ACP adapters main spawns (they bring their own zod and
  ACP sdk) and sharp (native, kept out of the bundle in `apps/cli/vite.config.ts`). Everything
  Vite bundles — zod, oRPC, citty, the ACP sdk, `@repo/*` — goes in `devDependencies`, or the
  app ships it for nothing; `apps/desktop` has no `dependencies` at all, since the page is
  bundled whole. `pnpm add` defaults to `dependencies`.

## Map

- `apps/desktop/src-tauri` — the shell, Rust: the window over main's page, opened on the handoff
  main hands it, and its navigation pin (`window.rs`, `navigation.rs`), main as its one child
  (`main_process.rs` over the relay's framing in `relay.rs`, `runtime.rs` for where node and the
  server are), what main asks of a native app (`host.rs`: message boxes, the clipboard, Finder,
  notifications; `tray.rs`, `login_item.rs`, `keep_awake.rs`, `keychain.rs`), and main's log
  (`main_log.rs`). No capability grants the page a command.
- `apps/desktop/src/renderer` — the office page: a React overlay (`ui/`) over a Phaser 4 scene
  (`game/`, with the office's geometry: `office-depth.ts` the draw bands,
  `office-layout-schema.ts` the shape of office-design.json, `office-grid.ts` walking as pure
  math), a hand-rolled external store in `state/store.ts`, and main reached through `api.ts`
  (installed by `install-api.ts`).
- `apps/desktop/scripts` — the pack: node fetched (`fetch-node.ts`), the server staged
  (`stage-server.ts`), everything signed (`sign-resources.ts`), the crates' notices
  (`rust-notices.ts`), the bundle and notarization (`package.ts`), the release
  (`publish-release.sh`), and `devkill.sh`.
- `apps/cli/src` — the `idlebiz` binary: `index.ts` and `program.ts` (citty; help, version and
  every failure on stderr), `commands/serve.ts` (loads main), `commands/tools.ts` (one verb per
  company tool, a client of the control plane), `paths.ts` (the package's own files), and
  `dev-host/host.ts` (main as the shell runs it, for `pnpm dev:browser` and the e2e suite, which
  ask it for the handoff the shell's window opens on).
- `apps/cli/src/server` — main. `serve.ts` (boot on the shell's hello, the relay, quit),
  `host.ts` (what main asks of the app that runs it), `relay/` (its end of the stdio channel),
  `page-server.ts` (the window's page on loopback: the handoff, the guards, the event stream;
  `page-session.ts` the sign-in, `page-policy.ts` the page's CSP), `page-router.ts` (the page's
  contract implemented; `lib/answers.ts` words what does not return), `store/store.ts` (the one
  company in memory, every command on it, and its writes), `store/*-codec.ts` (one pure markdown
  package ⇄ domain object mapping per kind; `company-codec.ts` owns the save format stamp),
  `paths.ts` (the on-disk save format, documented at the top), `scheduler.ts` (the idle loop; it
  alone holds the Mac out of idle sleep, through `keep-awake.ts`, while a run is in flight —
  never past a closed lid), `agents/` (runs), `control-plane.ts` (HTTP on a unix socket per run, which only
  that run's seal reaches, that the agents' `idlebiz` command calls back into; `agent-launcher.ts` writes that command at boot),
  `tool-specs.ts` (every company tool, described once) and `tools.ts` (each bound to its
  implementation), `command-policy.ts` (rules over the words `shell-lexer.ts` reads from a line
  as bash would, read loosely as well where another shell may split it apart), `refusal.ts`,
  `agents/seal.ts` (the Seatbelt profile each run starts under, and its boot check),
  `agents/bundled-skills.ts` (where IdleBiz's skills ship, `apps/cli/resources/skills`),
  `agents/claude-user-settings.ts` (what of the founder's claude settings a run still carries:
  its sign-in and model),
  `activity.ts` (the one publisher), `prompts/` (what employees are told), `lib/fs.ts`
  (every write, atomic and behind the reset gate), `stripe-connect.ts` / `vercel-connect.ts`
  (the two OAuth connections, same shape), `stripe-api.ts` (what every Stripe call shares),
  `stripe-key.ts` (the charging key the founder enters),
  `deploy.ts` (the Vercel API calls the `deploy` tool makes),
  `vercel-env.ts` (the Vercel call `set_env` makes, and the values a deploy may not ship),
  `env-name.ts` (what set_env may name),
  `payment-links.ts` (the Stripe calls `create_payment_link` and `sell_print` make, and the
  switch-off of a retired product's links),
  `printful.ts` (Printful's API: the saved token, its catalog, and pricing a print),
  `printful-orders.ts` (Printful's order calls), `stripe-checkouts.ts` (the read of Stripe's
  checkout sessions and a payment's charges), `order-pump.ts` (each paid print order to Printful, each link sale's
  delivery, and the founder's order cards),
  `printful-token.ts` (the Printful token the founder enters), `print-listing.ts` (what
  `sell_print` checks before it lists), `secrets.ts`,
  `metrics.ts`, `tray.ts`, `login-item.ts` (open at login: the macOS login item is its only
  record, only a packaged app registers one, and a launch at login starts in the menu bar).
- `apps/cli/resources` — what main reads beside its bundle: IdleBiz's skills (`skills/`) and the
  employee sheets (`employee-sheets/`).
- `apps/web` — landing page plus the three Stripe Connect route handlers.
- `packages/domain` — the vocabulary both sides share, pure: `domain.ts` (the company, its
  people, products and tasks), `bets.ts` (the bets, their judge and the allocator),
  `activity.ts` (the event grammar), `digest.ts`, `hire.ts`, `integrations.ts`, `hold-rules.ts`
  (what an approval card says each rule holds; data only, for the page), `format.ts`,
  `errors.ts`, `json.ts`, and `character-frame.ts` (the sprite box every process slices by).
- `packages/contract` — the page's API: the oRPC contract (`contract.ts`, one folder per domain),
  its routes (`routes.ts`) and the event stream's names (`events.ts`).
- `packages/agent-driver` — spawns the `claude` / `codex` ACP adapters, normalizes events,
  prices usage, and classes failures (auth, usage limit, overload, context, other). Source-only, no build step.
- `packages/stripe-connect-protocol` — the handshake between the desktop's loopback server
  and the web's Stripe routes: paths, the state codec, the callback outcome. Both ends import it.
- `packages/px-kit` — the pixel-UI design system as one stylesheet (palette, `@theme` tokens,
  VG5000, every `.px-*` class), imported by both apps after Tailwind.
- `tools/e2e` — the Playwright suite over the built page and main (`src/harness.ts` launches them
  through the dev host; `src/stub-services.ts` answers Stripe, Vercel and Printful from canned
  JSON).
