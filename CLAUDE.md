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
  bet reads captured live-mode USD charges tagged `metadata[bet]=<slug>`. So any number of
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
  instead of queueing again; measuring keeps what waits on the founder, since that step may
  be what moves the number. Retiring a product drops its waiting work, and a release drops
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
  (product yield, the plateau's run of losses) counts it. The replay scores only work picks,
  so it never touches `plateau`, and it floors a pick's cost at one run's so a win nothing
  paid for cannot price itself at zero. It stays on the defaults below eight measured
  verdicts. Steering changes go in the policy, not into prompts as advice: briefs carry the
  ledger as facts only. The game is single-player: the replay only ever sees this company's
  bets, and no ledger leaves the machine.
- **Outward-facing stays founder-gated**, through one judgement: `holdFor` in
  `shared/command-policy.ts`. A shell command matching a rule is signed for once, exactly.
  A signature pins a command, not the tree it ships, and runs on one product share its
  workspace, so a run carrying one has that workspace to itself: the scheduler's `tick` starts
  it only once no other run is live there, and starts nobody new there while it waits on
  them or runs. The agents are told the folder is shared. An
  `agent-browser` verb is read where agent-browser reads it, the first word its global options
  leave, and any verb but a listed page read is held unless the session's live page (read from
  the browser, since a click can land anywhere) is loopback, every frame found in it of the top
  page's own origin (or about:) — a frame from any other origin, another localhost port
  included, reads as nobody's: a ref from `snapshot`, a `frame` switch or `webmcp --frame` acts
  inside a frame while the URL stays the top page's, so a localhost build framing Stripe (its
  buy button and pricing table sit in shadow roots) is a page nobody can read. Frames are found
  through `window.frames`, every readable document's open shadow roots and its resource timing;
  one in a closed shadow root is known only by the URL it first asked for, and only once it has
  finished loading: not while it loads, not where a redirect or later navigation took it, not
  any frame inside it, and not at all once the page has filled or cleared its resource-timing
  buffer. That page is read before the command runs,
  so an act chained after a step that may move the page (opening a loopback page, whose frames
  are unread until it loads; pointing the session at another browser or namespace, or moving
  it under its other name: "default" is the unnamed session unless `AGENT_BROWSER_SESSION`
  says otherwise), or inside one whose page or steps no read can see (`batch`, `chat`, an init
  script, an extension, an empty `--session`, a word the shell fills in), is signed for once,
  exactly, like a shell rule. Only the command line's own options count: an `AGENT_BROWSER_*`
  variable or an `agent-browser.json` goes unread, so either can still reroute or script a
  session unseen.
  Employee sessions also load the founder's own CLI settings, so their MCP servers, signed in
  as the founder, are held too. Every turn sets the runner's asking mode, and claude's
  session carries flag-tier ask rules (shell, edits, MCP) that outrank any allow rule in the
  founder's claude settings; codex still honours `allow` decisions in the founder's
  ~/.codex/rules, which run a command outside the sandbox unasked. A site or a server is
  leased for the rest of the run; a page or a server nothing can name never is. codex asking
  to widen its own sandbox is held every time, never leased: once widened, nothing else in
  the run asks. A signature only ever picks the runner's one-time option, never an "always"
  one. An edit by claude's Write/Edit outside a run's own dirs (its working directory, memory
  folder, the shared workspace, the tool cache) is held, under `save-edit` when it lands in
  the save. codex's patch is held every time it asks: codex asks only past its own roots, and
  its ask names each file the patch changes but never where a move takes one, so a patch
  naming only the workspace can still write the save. A shell write is not judged by path, so
  `cp x ../approvals.json` still runs. A web read by the agent's own tool runs, as a bare
  `curl` does; an ask IdleBiz cannot recognise is held once, exactly, and so is a codex
  `execute` approval that names no command. Both runners' wire formats end in
  `packages/agent-driver/src/tool-ask.ts`; the policy only ever sees a `ToolAsk`.

## Two traps that fail silently

- **The px-kit beats Tailwind.** The `.px-*` classes in `packages/px-kit/px-kit.css` (one
  stylesheet, imported by both apps) live outside `@layer`; Tailwind's utilities are
  layered, and unlayered CSS wins regardless of specificity. So a utility on the same
  element that sets a property its kit class also sets does _nothing_ — `text-[12px]` on a
  `.px-btn` never applied (23 such declarations had accumulated). Classes that set
  font-size/color: `.px-btn` `.px-opt` `.px-field` `.px-chip` `.px-cmd` `.px-badge`. Size
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
  by that path's entry in `sprite-bounds.generated.ts`, one scan of the shipped art. Run
  `pnpm --filter @repo/desktop generate:sprite-bounds` after adding or changing a PNG:
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
- **`pnpm lint` is a clean gate.** `oxlint.config.ts` extends the ultracite presets (core, react, anti-slop; next for `apps/web`); every rule is an error. Fix the code, don't add config overrides; a `// oxlint-disable-next-line rule -- why` needs a stated reason.
- **Hard prerequisite**: a signed-in `claude` or `codex` CLI on PATH, or the app can't
  onboard, hire or run anything. There is no seeded save.
- **CLI-free surfaces**: `apps/web`, the onboarding modal, and the two hash routes `#/ui`
  (office builder) and `#/office-assets` — all reachable with no company.
- **`pnpm dev:desktop` stops this checkout's desktop dev session first**; `dev:web`,
  `verify` and unrelated processes on TCP 9222 survive, and startup fails while that port is
  occupied. It runs Turbo in loose env mode, so shell env reaches Electron.
- **Desktop boot drains queued work immediately**. Use a fresh `IDLEBIZ_ROOT_DIR` to protect
  the real save; see the fixture recipe in `AGENTS.md`. Employee runs still cost money.

Commands: `pnpm verify` · `pnpm dev:desktop` · `pnpm dev:web` · `pnpm knip`
`pnpm knip` checks unused files, exports and dependencies; it is not part of `verify`.
Office layout: `pnpm --filter @repo/desktop check:office` (add `--layout <path>` for a save)
Tests: `pnpm --filter @repo/desktop test` (geometry, schemas, command policy, temporary saves,
and real loopback requests; no Electron or Phaser)
