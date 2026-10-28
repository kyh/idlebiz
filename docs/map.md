# Map

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions. The tree
is AGENTS.md's [Map](../AGENTS.md#map); this is where each thing lives in it.

- `apps/desktop/src-tauri` — the shell, Rust: the window over main's page, opened on the handoff
  main hands it, and its navigation pin (`window.rs`, `navigation.rs`), main as its one child
  (`main_process.rs` over the relay's framing in `relay.rs` and its messages in `protocol.rs`,
  `runtime.rs` for where node and the server are), what main asks of a native app (`host.rs`:
  message boxes, the clipboard, Finder, opening a path or a URL, notifications; `tray.rs`,
  `login_item.rs`, `keep_awake.rs`, `keychain.rs`), its own updates (`updater.rs`), and main's log
  (`main_log.rs`, which the shell's own lines reach through `shell_log.rs`). No capability grants
  the page a command.
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
- `apps/cli/src` — the `idlebiz` binary: `index.ts` and `program.ts` (citty; help and version on
  stdout, every failure on stderr), `commands/serve.ts` (loads main), `commands/tools.ts` (one
  verb per company tool, a client of the control plane), `paths.ts` (the package's own files), and
  `dev-host/host.ts` (main as the shell runs it, for `pnpm dev:browser` and the e2e suite, which
  ask it for the handoff the shell's window opens on, held to the shell's deadlines on main).
- `apps/cli/src/server` — main. `serve.ts` (boot on the shell's hello, the relay, quit),
  `save-claim.ts` (boot's claim on the save), `host.ts` (what main asks of the app that runs it,
  and every message of the relay's), `relay/` (its end of the stdio channel),
  `page-server.ts` (the window's page on loopback: the handoff and the guards;
  `page-session.ts` the sign-in), `page-router.ts` (the page's contract implemented, its event
  stream fed by `lib/broadcast.ts`; `lib/answers.ts` words what does not return),
  `store/store.ts` (the one company in memory, every command on it, and its writes),
  `store/load.ts` (reading packages and records off disk, and the load report naming each one
  skipped), `store/slugs.ts` (the free id a new package takes),
  `store/*-codec.ts` (one strict zod schema per package kind, which its encoder is typed against
  and its decoder parses; `company-codec.ts` owns the save format stamp),
  `paths.ts` (the on-disk save format, documented at the top), `scheduler.ts` (the idle loop,
  which alone keeps the Mac awake, through `keep-awake.ts`), `founder-actions.ts` (what the
  founder hands the team, filed and queued through the scheduler), `company-actions.ts` (a change
  everyone hears about), `agents/` (runs: `runner-pool.ts` the `RunnerPool`, its runners, their
  rests and each task's turn, `session.ts` an ACP session under its seal and every permission ask
  it raises, `run-workspace.ts` the folders and env main readies a run, `ask-box.ts` its one ask
  of the founder), `control-plane.ts` (HTTP on a unix socket per run, which the agents' `idlebiz`
  command calls back into; `agent-launcher.ts` writes that command at boot),
  `tool-specs.ts` (every company tool, described once) and `tools/` (each bound to its
  implementation: `define.ts` the binding, the asks and the holds, then the team's, portfolio,
  Vercel, money and print tools), `policy/` (the command policy: `reading.ts` the words
  `shell-lexer.ts` reads from a line as bash would, read loosely as well where another shell may
  split it apart, `shell-rules.ts` the rules over them, `browser.ts` the agent-browser gate and
  the live page it reads, `index.ts` `holdFor`), `refusal.ts`,
  `agents/seal.ts` (the Seatbelt profile each run starts under), `agents/machine-seal.ts` (what
  it seals on this machine), `agents/seal-check.ts` (its boot check),
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
  switch-off of a retired product's links), `reset-links.ts` (every live link switched off before
  a reset deletes the save), `link-record.ts` (a payment link as the save keeps
  it: a `create_payment_link` link on its own, a listing's inside the listing),
  `printful.ts` (Printful's API: its catalog, and pricing a print),
  `printful-orders.ts` (Printful's order calls), `stripe-checkouts.ts` (the read of Stripe's
  checkout sessions and a payment's charges), `order-intake.ts` (each paid checkout on the
  company's links kept as an order, and each link sale's delivery carded), `order-pump.ts` (each
  kept print order to Printful), `order-card.ts` (how the founder's order cards name an order),
  `printful-token.ts` (the Printful token the founder enters and the one store it sells
  through, kept as one credential), `print-listing.ts` (what `sell_print` checks before it
  lists), `secrets.ts`, `metrics.ts`, `tray.ts`, `login-item.ts` (open at login), `updates.ts`
  (when the founder hears of an update, and its install asked of the shell).
- `apps/cli/resources` — what main reads beside its bundle: IdleBiz's skills (`skills/`).
- `apps/web` — the landing page, its trust pages and their Markdown for agents; it holds no
  secret and the app calls none of it. `next.config.ts` turns on `cacheComponents` and
  `partialPrefetching`: every page prerenders static, so a link prefetches its whole shell.
  Its og:video (`public/og/og.mp4` and its poster) is recorded by `pnpm -F @repo/web og:video`
  (`scripts/og-video.ts`), never by a build: a canvas scene of the office from the desktop app's
  own files (office-design.json, the employee sheets, px-kit, the wordmark), filling the frame
  under a slow camera drift, with the HUD's revenue plate counting up in the top left and the
  logo and its line in the bottom right, stepped on a fixed clock, screenshotted in Playwright's
  Chromium and encoded by ffmpeg.
- `packages/domain` — zod only, importing no other package of the repo's: `domain.ts` (the
  company, its people, products and tasks), `runners.ts` (the runners' ids and the names the
  founder knows them by), `bets.ts` (the bets, their judge and the allocator),
  `activity.ts` (the event grammar), `digest.ts`, `hire.ts`, `integrations.ts`, `hold-rules.ts`
  (every rule that holds a call, what its card says and whether signing leases it; data only,
  for the page), `format.ts` (money's formatting), `errors.ts`, `json.ts`, `character-frame.ts`
  (a sheet's frames: the box, the walk and sit strips, the origin and soles) and
  `character-seed.ts` (which sheet a sprite seed wears, which the save keeps, and the founder's
  looks).
- `packages/contract` — the page's API: the oRPC contract (`contract.ts`, one file per domain),
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
