# IdleBiz

Electron game where AI employees — real `claude` / `codex` CLI sessions — operate a
business. Main app: `apps/desktop` (electron-vite + React + Phaser, strict TS — no
`any`, no `!`, no `as`). Full map and workflow in `AGENTS.md`.

- Game state on disk at `~/.idlebiz/<company-slug>/` — agentcompanies/v1 markdown
  packages (COMPANY.md, agents/<slug>/AGENTS.md — its frontmatter is the employee, its body
  a mirror of the instructions each run is given, rendered live and rewritten at boot, tasks/<slug>/TASK.md for open work, shipped/<slug>/TASK.md once done, answered or dropped,
  products/<slug>/PRODUCT.md for each product (the first's code is workspace/, later ones
  get products/<slug>/workspace/), shared/ for what teammates share across products,
  bets/<slug>/BET.md, retired/<slug>/ for killed products with their code, routines/,
  activity.jsonl).
- COMPANY.md carries `format`. A save stamped higher than this build writes is refused
  (writers rebuild files from what they understand, so opening it would drop what a newer
  build added); one stamped lower is adopted once in `adoptOlderSave`, the only home for
  code that reads an old shape of a save, then stamped. Tolerant field reads in the codecs
  are not migrations. A frontmatter key the app does not know is still dropped on the next
  write of that file.
- One active company per launch: newest `createdAt`, alphabetical slug on ties.
  Only that company's entities load or migrate; older saves remain untouched.
- Employee character sheets are bundled at `apps/desktop/resources/employee-sheets`
  as curated runtime assets. Source workspace lives outside the repo at
  `/Users/kyh/Desktop/vg/office`.
- Verify changes live: `pnpm dev:desktop` exposes CDP on :9222 (use agent-browser).
  Under headless automation the Phaser boot stalls (document.hidden) — force
  `window.__game.scene.start("office")` and step `game.loop.step(t)` to render.

## The company is steered by bets

`shared/bets.ts` is the whole steering loop, pure: a bet is one hypothesis about one real
number (`users` | `revenue`) of one product, with a spend cap and a window. Its target has
a floor, `MIN_BET_TARGET` (10 whole users, $5), which `open_bet`'s body refuses below:
under it the founder's own clicks or one charge would win the bet, and a win steers the
allocator and the replay.

- **The evaluator judges, never the team.** `judge` runs every scheduler tick against the
  live product numbers: won when the number moved by the target, killed when its window
  closes short — on a reading taken after the close (the pulse reads at boot and re-reads
  Stripe past its cache for it), since a cached read can miss the money that decides it.
  A measuring bet's reading stops at its close — visits up to `until`, charges made by it —
  so however late that read comes, nothing after the window counts. Without one, the verdict
  holds for a second window (`windowHours` past the close), then the bet dies on its last
  reading with a reason naming the source that sent nothing — but only once the pulse has
  asked for `KILL_GRACE_MS` without a break (`pulsingSince`), so a window that closed while
  the app was quit or asleep waits on a read, not the wall clock. The founder or the lead can
  still kill a held bet by hand. Only the lead starts a window (`measure_bet`): spending out
  the budget stops the work but not the clock, because the step that moves the number may
  still be waiting on the founder and a window over nothing shipped is a false verdict. Nor
  does it start one over a number no source reads (`measureRefusal`: the company's Stripe
  key, live unless test money counts, and the product's Vercel project). A spent-out bet
  gets the lead a "settle" run: measure or kill. No tool lets an agent declare a win.
- **A bet counts only what carries its mark** (`Bet.claim`). A users bet owns a landing path
  (`/b/<slug>` unless it names one) and reads visitors under it since it opened; a revenue
  bet reads captured live-mode USD charges tagged `metadata[bet]=<slug>`, the tag
  `create_payment_link` sets on every payment of a link made for that bet. So any number of
  bets run on one product and none can claim another's result. A named path over the whole
  site or `/b` is refused (`namedPathRefusal`), and so is one overlapping a path a live bet
  covers or a closed one named (`holdsItsPath`): each counts visitors the bet did not bring.
  The team's own visits never count; the standing instructions say how to check a path
  without recording one. Readings arrive with the metrics pulse and live on the bet
  (`reading`, taken at `readAt`), so `judge` needs only the bet and the pulse's clock.
  Vercel's analytics API wants `since` and `until` together and filters in OData; path
  filters are free, utm ones are a paid add-on — which is why the mark is a path.
  Per-product revenue reads the same charges over the account's whole history, tagged
  `metadata[product]`, while bets read only charges since the oldest live revenue bet
  opened; untagged money counts for the company only. Test-mode money (a test card,
  `stripe trigger`) is money nobody paid, so it counts nowhere unless
  `IDLEBIZ_COUNT_TEST_MONEY=1` (AGENTS.md). Without it a test-mode key gives a bet no
  reading, not a zero, so a bet only it could read closes unmeasured, never as a loss.
- **Idle hands only spend against a fundable bet.** `allocate` decides everything about
  where a run goes, and the scheduler only carries it out: work on the best open bet
  (product yield + exploration bonus − crowding, runs in flight counted against the budget
  at ~$1 each), else the lead settles a spent-out bet, else the lead opens the next one (a
  run of straight losses asks for new ground), else wait. That budget check is `hasRoomFor`,
  and `delegate` asks it too: a bet without room refuses the handoff rather than let its
  work run unfunded. The portfolio's caps (5 live products, 3 live bets a product) are the
  store's: `createProduct` and `openBet` refuse past them, the founder's New product too,
  and a proposal offers new ground as a new product only while `portfolioHasRoom`.
  A bet that leaves open (measured, killed, judged) drops its waiting
  work, and a run still on it that fails, parks or is cut off by a restart is dropped
  instead of queueing again, as is one that asks the founder once the bet has closed;
  measuring keeps what waits on the founder, since that step may be what moves the number. Retiring a product drops its waiting work, and a release drops
  the leaver's unstarted work and any ask no bet funds. `dropped` is history, not a failure:
  the Inbox never offers it back and the lead's brief never lists it, since reviving it would
  only bill what takes no more work; the lead delegates the idea again under a live bet.
  `dead` is only work whose runs failed on their own, and stays revivable. "Waiting on the
  founder" is modelled in `allocate` once: a bet with a blocked task gets no hands — settle
  runs carry their bet, so that covers them — and a lead whose last proposal is blocked is
  not asked again.
  Routines and founder pings are the only unfunded work, and a routine is only work that
  recurs by nature (a playtest, a store audit): reviewing or marketing the business is a
  bet's job.
- **The store holds the one company this launch runs**, so nothing in its API takes a
  company id: `getCompany()` is null before one is founded, and everything else throws "no
  company is loaded" — a caller that can run without one (tray, boot, the pulse) asks first.
  Lookups (`getX`) return null, `requireX` and commands throw, and null otherwise means only
  that a claim or lock race was lost. It refuses with a `RefusalError` (`shared/refusal.ts`)
  worded as the sentence the agent should read; a tool turns that into its answer, IPC into
  the founder's note. Anything else thrown is a fault: answered the same way, but reported to
  main's log. Don't split it by entity or make it async: its synchronous check-and-set is
  what makes the task lock correct.
- **A company tool is described once**, in `shared/tool-specs.ts`: route, body, lead-only
  refusal, doc and example. The agents' instructions are rendered from it, `main/tools.ts`
  binds each implementation to its spec, and `control-plane.ts` is only transport. A change
  everyone should hear about (a bet, a product, autopilot) goes through
  `main/company-actions.ts`, whoever made it: a tool, the scheduler or the founder's IPC.
  Its `postToRoom` is the team room's only writer, and names the speaker (founder, office
  or employee), so the room agents read and the #team feed hold the same lines and no
  office news reads as the founder's word.
- **The policy is data, retuned by replay.** `dream` replays a fixed set of `explore`
  weights against the measured verdicts and swaps only to a strictly better scorer, so the
  incumbent never loses to a tie. A bet killed before any source reported its number
  (`moved === null`) says nothing about its hypothesis, so neither the replay nor `allocate`
  (product yield, the plateau's run of losses) counts it. The replay scores only work picks
  and floors a pick's cost at one run's, so a win nothing paid for cannot price itself at
  zero; the plateau (three straight losses) only shapes a proposal, so it is a constant, not
  policy. It never retunes below eight measured verdicts. Steering changes go in the policy, not into prompts as advice: briefs carry the
  ledger as facts only. The game is single-player: the replay only ever sees this company's
  bets, and no ledger leaves the machine.

## Two boundaries hold a run

An employee run is a real CLI session running as the founder's OS user. Two boundaries hold
it: the Seatbelt seal it starts under, which decides what it reads, writes and reaches on this
machine, and custody, which keeps IdleBiz's keys in main and runs every step that spends them
there, once the founder signs off. The command policy in front of both is a tripwire, not a
third boundary.

- **Every run starts sealed.** `acpAgentFor` starts each ACP session, a task's or the hiring
  one-shot's, under `/usr/bin/sandbox-exec -p` with a profile `main/agents/seal.ts` renders per
  run, every path a `-D` parameter. Each run resolves its own (`machineSeal`), so a path that
  became a symlink since boot is sealed where it leads from the next run on.
  - _Reads_ are open but for the founder's logins (`LOGINS`: ssh, gh, npm, netrc, git
    credentials, cloud and deploy CLIs, browser and chat-app profiles, agent-browser's saved
    logins), `secrets.json` with every name that starts with it, and the other runner's home.
  - _Writes_ are denied by default. A run writes its own folders (`Seal.writable`: its
    workspace, the shared one, its memory, the save's `cache/`), its runner's home (`~/.claude`
    or `~/.codex`), TMPDIR, macOS's per-user temp and cache folders,
    `/private/tmp`, its runner's agent-browser namespace, node CLIs'
    `~/Library/Preferences/*-nodejs` and the `/dev` nodes a toolchain writes. `TOOL_CACHE_ENV`
    (`agent-driver.ts`) moves TMPDIR and every cache a toolchain keeps in HOME into `cache/`,
    and turns CLI updaters off.
  - Seatbelt obeys the last rule a path matches, so inside those folders the profile denies
    again what the founder's own tools load or run later: what the runner's CLI or desktop app
    loads from its home (`RUNNER_HOMES`: settings, instructions, rules, hooks, skills, plugins,
    shell snapshots, daemons…), claude's transcripts and memory of every folder but the run's
    own (`projects/`, which the founder's sessions there resume and load), a folder the founder
    runs programs from inside one of them (on main's PATH, where its links lead, or a terminal's
    shims in TMPDIR: `TERMINAL_SHIMS`, cmux's) with every folder above it there, and, anywhere, what the founder's tools run
    on opening a folder: in `.git/` everything but what git writes as it stages,
    commits, branches, stashes, merges, rebases and gcs (so no config, hooks, `commondir`,
    `worktrees/`, `modules/` or alternates), `.claude/settings*.json`, `.mcp.json`, `.codex/`,
    and the `.git`/`.claude` folders themselves. Seatbelt checks a moved folder where it lands,
    never what it carries, so these hold in TMPDIR and `cache/` too.
  - Nor does a run write claude's account file (`account` in `RUNNER_HOMES`: `~/.claude.json`
    with every name that starts with it, or the one in `CLAUDE_CONFIG_DIR`), its backups or the
    legacy `.config.json` claude reads in its place: the MCP servers named there, user-wide or
    per project, start in the founder's own sessions, unsealed. claude runs without writing it;
    only the sign-in, which records the login there, does.
  - Seatbelt matches the path a symlink leads to, never the link, so each sealed path is named
    where it is and where it resolves. A run's own folders are allowed only where the save
    resolves: a run whose folder, or any folder between it and the save, is a symlink does not
    start (`ownFolders`), and no run removes, moves or replaces one of its own folders. Main
    makes them before the run: a product's workspace as a git repository (`ensureRepository`,
    macOS's git) and claude's `projects/` folder. A run writes no git config, so its commits are
    named by `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
  - _Reach_: a run connects to no unix socket but DNS's, syslog's, its own folders' and its
    runner's agent-browser namespace (`browserNamespace`, keyed by save and runner): no ssh,
    gpg or 1Password agent, container engine, app `SingletonSocket` (which hands the running
    app a URL), claude's or the codex app's sockets, the founder's own agent-browser daemons or
    the other runner's. Those of them in a folder it writes (launchd's, an ssh-agent's, main's
    `SSH_AUTH_SOCK`, `/tmp/cc-socks`, the codex app's) cannot be moved or replaced either.
    Loopback 9222 and 9229 are closed: the dev renderer's debug port holds the founder's
    approve button. LaunchServices opens nothing; the Apple Event CLIs (`osascript`,
    `osacompile`, `automator`, `shortcuts`) and git's Keychain helper do not run; no setuid
    program runs but `/bin/ps`, which fnm needs; a codex run reaches no Keychain (a
    `mach-lookup` deny of securityd, which holds against a copied binary too).
  - _Checked before use._ Boot runs `checkSeal`, no model call: under each runner's profile a
    canary must be unreadable, a file where no rule allows a write must not be made, and the
    runtime must start. Until it holds the scheduler starts nothing and autopilot files nothing; a
    refusal is listed in Settings beside what boot skipped, and a CLI sign-in retry checks
    again. Main starts a runner's CLI itself only sealed as that runner: its version and login
    probes, `codex mcp list`, and the sign-in (`sealedSignIn`, the only one that may open the
    browser or write claude's account file). The installer runs in `/bin/bash -c`, never a login shell. The login-shell PATH
    probe (`adoptShellPath`) runs unsealed: no run writes the founder's shell startup files.
    `atomicWrite` makes each `.tmp` anew (`wx`), so nothing main writes lands through a planted
    link. Never set `AGENT_BROWSER_PROFILE` for runs: one fixed profile locks every session
    but the first out.
- **Keys stay in main; what spends them runs there.** The keys IdleBiz holds live in
  `secrets.json`, which the seal keeps from every run, each value also sealed with the macOS
  Keychain (`safeStorage`), which a claude run can still reach; dev seals with the mock
  keychain, and nothing on the real save, so it strands none. Main reads each where it uses
  it. A run starts from the founder's env less every credential-shaped name and every URL with
  a login in it, but its runner's own login (`runEnv` in `main/agents/run-env.ts`). An outward
  step that needs a key is a signed tool main runs: `deploy` uploads the product's folder
  through Vercel's API with the founder's token, and Vercel builds it on its own machines
  (`main/deploy.ts`); `create_payment_link` prices in USD and makes a Stripe payment link with
  the founder's own key (`main/payment-links.ts`; a Connect grant is read-only), tagging each
  payment for its product and a named open revenue bet on it. Each runs once the founder signs
  off on the action it names, which is the approval's key (`requireSignOff` in
  `main/tools.ts`): `deploy <product> to production on Vercel project <name>` (or `on a new
Vercel project named <product>` for a product bound to none), and `payment link "<name>" at
$<amount> on <product> for bet <slug>`. A sign-off belongs to the continuation task, is spent
  once and goes with the task.
  - A sign-off pins an action, not the tree a deploy ships, and runs on one product share its
    workspace, so a run carrying one has that workspace to itself: the scheduler's `tick`
    starts it only once no other run is live there, and starts nobody new there while it waits
    or runs. The agents are told the folder is shared.
  - The deploy never runs the Vercel CLI, which runs code a folder holds (`vercel.ts`, a
    `vercel` npx finds first, what a repo's config tells git to run) with the token in its env.
    Main only reads the files, a symlink as the path it holds (as the CLI uploads it), never
    what it names. Main names the project too: the bound one, or for an unbound product a new
    one named after it, bound as soon as Vercel makes it; a name another project holds asks the
    founder to bind instead. So no file in the folder (`.vercel/project.json`, a `name` in
    vercel.json) picks which of the founder's projects is overwritten.
  - Nothing pushes code. The founder pushes by hand from a fresh clone (`git clone --no-local
<workspace>`), never with git inside the workspace: the seal keeps a run from git's config
    and hooks there, but git still obeys what a run leaves in the folder (a rebase's todo list,
    a `.gitattributes`), unsealed, as the founder. A clone runs only upload-pack there, which
    runs nothing its config names since git stopped lazy-fetching a partial clone's missing
    objects (2.45.1; 2.39.4 and the other backports). The prompts and the questions IdleBiz asks
    the founder say so.
- **A run loads the founder's CLI setup, less their MCP.** A claude session loads the
  founder's user, project and local settings (CLAUDE.md, skills, plugins, hooks), under the
  flag tier its session options set (`packages/agent-driver/src/registry.ts`), which outranks
  them: claude's own sandbox off, ask rules for shell and edits that beat any allow rule, no
  bypass mode, and none of their MCP servers or claude.ai connectors (`strictMcpConfig`,
  `disableClaudeAiConnectors`, a deny of `mcp__*`), which act signed in as the founder; the
  company is reached with curl. A codex session loads the founder's codex config with every
  MCP server turned off by the name `codex mcp list` gives it, apps and plugins whole
  (`codexMcpOff` in `main/agents/agent-driver.ts`). A codex whose login lives in the Keychain
  (`cli_auth_credentials_store`, or the profile its config selects) is refused: onboarding says
  so, and every codex run is refused with the same sentence before it starts
  (`main/agents/codex-keychain.ts`).
- **The command policy is a tripwire.** Every permission ask a runner raises meets one
  judgement, `holdFor` in `shared/command-policy.ts`; every turn sets the runner's asking mode
  first (claude `default`, codex `external-sandbox`), since a session starts in a default that
  may not ask. A shell command matching a rule (deploy, publish, git push, GitHub writes,
  payments, sends, remote copies, pipe-to-shell, credential reads, writes and deletes outside
  the workspace) is signed for once, exactly, with the same grant a signed tool takes. It is
  not a boundary: what a script runs goes unseen (`npm run deploy`, a file on disk), and codex
  still honours `allow` decisions in the founder's `~/.codex/rules`, which run a command
  unasked (inside the seal).
  - An `agent-browser` verb is read where agent-browser reads it, the first word its global
    options leave, and any verb but a listed page read is held unless the session's live page,
    read from the browser before the command runs (a click can land anywhere), is loopback with
    every frame found in it of the top page's own origin (or about:). A frame from any other
    origin, another localhost port included, makes the page nobody's: a ref, a `frame` switch or
    `webmcp --frame` acts inside a frame while the URL stays the top page's. Frames are found
    through `window.frames`, open shadow roots and resource timing, so one in a closed shadow
    root is known only by the URL it first asked for, once loaded. A remote site, once signed
    for, is leased for the rest of the run. An act chained
    after a step that may move the page, or inside one no read can see (`batch`, `chat`, an
    init script, an extension, an empty `--session`, a word the shell fills in), is signed for
    once, exactly. An act on a `file:` page is held, and so is a command naming a `file:` URL
    outside the run's own dirs, judged where its symlinks lead (`Confinement.real`). Only the
    command line's own options count: an `AGENT_BROWSER_*` variable or an `agent-browser.json`
    goes unread.
  - An edit by claude's Write/Edit outside a run's own dirs is held, under `save-edit` when it
    lands in the save, where the seal refuses it even once signed for. codex asks before every
    patch, naming each file it writes and where a move lands, so a patch is judged like an
    edit; one naming no file is held. codex asking to widen its own sandbox is held every time,
    never leased: once widened, nothing else in the run asks. An MCP server that asks anyway is
    leased for the run; one nothing can name never is. A web read by the agent's own tool runs,
    as a bare `curl` does; an ask IdleBiz cannot recognise is held once, exactly. A signature
    only ever picks the runner's one-time option. Both runners' wire formats end in
    `packages/agent-driver/src/tool-ask.ts`; the policy only ever sees a `ToolAsk`.
- **What stays open**, on purpose or for want of a rule:
  - the network: a run can send what it reads anywhere;
  - reads across HOME outside the login stores (another project's `.env`, transcripts);
  - to claude runs, which share the founder's login, the Keychain: claude reads its login
    there, so a token the founder's `gh` or git keeps there is guarded only by the tripwire's
    `read-credentials` and `git-push` holds;
  - the rest of each runner's state: claude's prompt history and session registry, codex's
    session logs (which its own memory pass reads), thread and queue databases;
  - the runners' shared ground: every run writes `cache/` and a product's workspace, so code a
    codex run leaves there (a package script, a `node_modules/.bin` shim) runs in the next
    claude run, with the Keychain and claude's login;
  - a program a run builds can still send Apple Events (macOS asks the founder first: refuse
    it), and a debugger listening on a port other than 9222 or 9229 takes its orders;
  - the founder's git run inside a workspace (push from a fresh clone);
  - of the folders the founder's terminal runs programs from in TMPDIR or `/private/tmp`, only
    those on main's PATH and the known terminal shims are sealed: any other (another terminal's
    or version manager's shims, a folder added to their PATH after IdleBiz started) is writable
    by runs.

## Two traps that fail silently

- **sandbox-exec cannot nest.** Once a profile denies anything, applying another inside it
  fails (`sandbox_apply: Operation not permitted`), so any sandbox a runner or its tools start
  inside the seal makes every command fail. claude's own is forced off in its flag-tier
  settings (`packages/agent-driver/src/registry.ts`), whatever the founder's say. codex runs in
  `external-sandbox`, a mode the app's patch of codex-acp adds (`patches/`): no sandbox of
  codex's own and approval `untrusted`, so codex asks before every command and patch it does
  not know is safe, and its patch ask names where a move lands. codex-acp's own modes either
  sandbox or never ask, so an upgrade must carry the patch. Chrome's sandbox is off in runs
  (`AGENT_BROWSER_ARGS=--no-sandbox`). The boot check runs plain node, so it cannot see a
  runner's own sandbox; the gate tests can. `main/agents/claude-gate.test.ts` and
  `codex-gate.test.ts` drive the real CLI through the app's adapter, sealed, against a
  stand-in model on loopback (nothing billed, a scratch config), and fail once a command nests
  or runs unasked (a push must reach `holdFor`), a founder's MCP server starts, a command
  escapes the seal, or a run rewrites the founder's config; claude's runs under founder
  settings that turn its sandbox on, codex's checks that a patch names where a move lands.
  They run in `pnpm --filter @repo/desktop test` on a Mac with that CLI installed and skip
  elsewhere, CI included.
- **The px-kit beats Tailwind.** The `.px-*` classes in `packages/px-kit/px-kit.css` (one
  stylesheet, imported by both apps) live outside `@layer`; Tailwind's utilities are
  layered, and unlayered CSS wins regardless of specificity. So a utility on the same
  element that sets a property its kit class also sets does _nothing_ — `text-[12px]` on a
  `.px-btn` never applied (23 such declarations had accumulated). Before putting a utility on
  an element with a `.px-*` class, check px-kit.css for the same property: many set
  font-size, colour, background or padding (`.px-btn`, `.px-opt`, `.px-hint`, `.px-inset`…).
  A variant is a kit modifier (`.px-hint-danger`, `.px-inset-hover`), never a utility. Size
  and colour belong in the kit as a class, never per-component. Cursors are the opposite:
  no kit class sets one, each app does by element. Icons are font glyphs, so "icon size" is
  font-size: use `.px-icon`.
- **The office's art and its collision don't know about each other.** `buildRoom` reads
  `objects`, the walk grid reads `collision` — two independent sections of
  office-design.json, and nothing keeps them in step. The builder's Block footprint closes
  the cells under a selection once, when asked. Those cells stay closed when the piece
  later moves, flips or is deleted. The body probe is 16x12 but the sprite is 32x64, so
  art overhangs the body by ~8px and any disagreement renders the character
  against the void. Run `pnpm --filter @repo/desktop check:office` after editing a layout;
  it fails on any seat, point of interest or door unreachable from spawn, any open floor
  cell no body can ever stand on, any reachable spot where the player's art, facing right,
  hangs over nothing, any reachable spot where something drawn above the player covers
  their face, and any placed object naming art this build lacks. The schema
  (`shared/office-layout-schema.ts`, v2: `seats` with roles, `pois`, `door`), the walk
  grid (`shared/office-grid.ts`), the art lookup (`shared/office-object-sprite.ts`) and
  the sight judgement (`shared/office-sight.ts`) are shared by the scene, the save
  handler and that script — a layout main refuses to save is exactly one the check would
  fail. Main parses the saved file (`main/office-design.ts`): one it can't read opens as
  the bundled office and the builder says Save will replace it; one stamped with a newer
  `version` is never replaced.
- **A sprite is its resolved path, never its id.** `objectSpritePath` picks the PNG; the
  scene keys its texture by that path, and the builder sizes, hits and anchors the object
  by that path's entry in `sprite-bounds.generated.ts`, one scan of the shipped art. That
  scan is also the office kit's catalog: kit PNG NNN is `office-object-NNN`. Run
  `pnpm --filter @repo/desktop generate:sprite-bounds` after adding or changing a PNG
  (`import:office-objects` runs it after copying in the kit):
  the scene throws on an id with no sprite and the builder on a sprite never measured, so
  main opens a saved office naming either (`unresolvedArt`) as the bundled office and
  refuses to save one, and `check:office` fails on both and on a sprite measured from
  other pixels.
- **The walker has two rules the authored collision does not.** A seat's cell is solid
  (sitters are placed on the chair; walkers never stand in it) and open floor no body can
  probe is sealed — both in `walkGridOf`, so the scene, the gate and the builder's
  Seal pockets agree. At boot the scene additionally closes every reachable node
  where the founder's face would be painted over, judged from the real textures, so a
  saved layout the gate never saw still cannot hide them. Main judges the same pose from
  the PNGs, a bundled employee standing in for the founder, and refuses a save only when
  closing them would cut a seat, POI or door off or close in the spawn, where the founder
  is placed exactly and could not take a step (`sightIssues`). On a source sheet that
  pose is not the top-left frame but `SOURCE_STANDING_FRAME`.

## UI conventions

- **The renderer mirrors main's state by asking again.** An activity event says which slice
  moved; `renderer/state/activity-reducer.ts` (pure, exhaustive over the event kinds — a new
  kind is a compile error, not a silent default) turns it into a patch and the slices to
  refetch. Answers can land out of order, so every fetch takes a ticket and a slice keeps
  only an answer at least as new as its last (`ordering.ts`). A patch outranks every answer
  still in flight, so a slice an event patches is also one it refetches, or what the refused
  answer carried (a hire) is lost. Don't put entities in events.
- **Every mutation goes through `useSubmission`** (`renderer/hooks/use-submission.ts`, on
  React's `useActionState`): the control is busy while main works and a refusal lands beside
  it as a `<Failure>`. No `void action()` in a handler, no hand-rolled `mounted` refs — a
  throw inside an action goes to the error boundary, so the hook returns failure as state.
  A read goes through `useAsync` (`renderer/hooks/use-async.ts`) the same way: its failure
  is state, and an answer that lands after its deps changed is dropped.
- **React and the office scene talk through `renderer/game/office-port.ts`**, a typed
  vocabulary over Phaser's emitter. The scene still fetches its own roster when it boots: it
  restarts the moment a company is founded, before the store has refreshed.

- **Headless interactions come from Base UI** (`@base-ui/react`, per-part imports like
  `@base-ui/react/dialog`), skinned with px-kit classes. Dialogs, choice windows (Toolbar),
  toggles and the like are never hand-rolled: `renderer/ui/modal.tsx` and
  `renderer/ui/choice-menu.tsx` are the patterns. Base UI composites learn their items a
  render after mount, so focus them from a deferred effect and mark the default tab stop
  with `data-composite-item-active`, not `autoFocus`.
- The game reads as a handheld RPG but never names one: no "Pokémon"/"poke" in code,
  comments, copy or docs.

## Agent-driven development

`AGENTS.md` is the full workflow — read it before driving this repo. The essentials:

- **Verify**: `pnpm verify` (typecheck · lint · format · check:office · test · build). CI
  (`.github/workflows/ci.yml`) runs the same six steps on every push to main and every PR;
  keep the two lists in step.
- **`pnpm lint` is a clean gate.** `oxlint.config.ts` extends the ultracite presets (core, react, anti-slop; next for `apps/web`), type-aware through `oxlint-tsgolint` so the promise, exhaustiveness and `no-unsafe-*` rules see types; every rule is an error. Fix the code, don't add config overrides (the few there are listed in `AGENTS.md` with their reasons); a `// oxlint-disable-next-line rule -- why` needs a stated reason.
- **Hard prerequisite**: a signed-in `claude` or `codex` CLI on PATH, or the app can't
  onboard, hire or run anything. There is no seeded save.
- **CLI-free surfaces**: `apps/web`, the onboarding modal, and the two hash routes `#/ui`
  (office builder) and `#/office-assets` — all reachable with no company.
- **`pnpm dev:desktop` stops this checkout's desktop dev session first**; `dev:web`,
  `verify` and unrelated processes on TCP 9222 survive, and startup fails while that port is
  occupied. It runs Turbo in loose env mode, so shell env reaches Electron.
- **Desktop boot drains queued work immediately**. Use a fresh `IDLEBIZ_ROOT_DIR` to protect
  the real save; see the fixture recipe in `AGENTS.md`. Employee runs still cost money.

Commands: `pnpm verify` · `pnpm dev:desktop` · `pnpm dev:web` · `pnpm knip` · `pnpm e2e`
`pnpm knip` checks unused files, exports and dependencies; it is not part of `verify`.
`pnpm e2e` builds the desktop app and drives it with Playwright: macOS only, every test that
founds a company (office, #team, key entry, sealing) skips without a signed-in CLI, never
spends, not part of `verify` or CI (see `AGENTS.md`).
Office layout: `pnpm --filter @repo/desktop check:office` (add `--layout <path>` for a save)
Tests: `pnpm --filter @repo/desktop test` (geometry, schemas, command policy, temporary saves,
real loopback requests and, on macOS, the seal and any installed CLI's gate; no Electron or
Phaser)
