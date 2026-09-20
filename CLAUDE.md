# IdleBiz

Electron game where AI employees — real `claude` / `codex` CLI sessions — operate a
business. Main app: `apps/desktop` (electron-vite + React + Phaser, strict TS — no
`any`, no `!`, no `as`). Full map and workflow in `AGENTS.md`.

- Game state on disk at `~/.idlebiz/<company-slug>/` — agentcompanies/v1 markdown
  packages (COMPANY.md, agents/<slug>/AGENTS.md — its frontmatter is the employee, its body
  a mirror of the instructions each run is given, rendered live and rewritten at boot, tasks/<slug>/TASK.md for open work, shipped/<slug>/TASK.md once done,
  products/<slug>/PRODUCT.md for each product (the first shares workspace/, later ones
  get products/<slug>/workspace/), bets/<slug>/BET.md, retired/<slug>/ for killed
  products, routines/, activity.jsonl).
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
number (`users` | `revenue`) of one product, with a spend cap and a window.

- **The evaluator judges, never the team.** `judge` runs every scheduler tick against the
  live product numbers: won when the number moved by the target, killed when its window
  closes short. Only the lead starts a window (`measure_bet`): spending out the budget stops
  the work but not the clock, because the step that moves the number may still be waiting
  on the founder and a window over nothing shipped is a false verdict. A spent-out bet gets
  the lead a "settle" run: measure or kill. No tool
  lets an agent declare a win.
- **A bet counts only what carries its mark** (`Bet.claim`). A users bet owns a landing path
  (`/b/<slug>` unless it names one) and reads visitors under it since it opened; a revenue
  bet reads Stripe money tagged `metadata[bet]=<slug>`. So any number of bets run on one
  product and none can claim another's result; `claimsCollide` refuses only a path another
  live bet already covers. Readings arrive with the metrics pulse and live on the bet
  (`reading`), so `judge` needs nothing but the bet. Vercel's analytics API wants `since`
  and `until` together and filters in OData; path filters are free, utm ones are a paid
  add-on — which is why the mark is a path. Per-product revenue is the same read, tagged
  `metadata[product]`; untagged money counts for the company only.
- **Idle hands only spend against a fundable bet.** `allocate` decides everything about
  where a run goes, and the scheduler only carries it out: work on the best open bet
  (product yield + exploration bonus − crowding, runs in flight counted against the budget
  at ~$1 each), else the lead settles a spent-out bet, else the lead opens the next one (a
  run of straight losses asks for new ground), else wait. "Waiting on the founder" is
  modelled there once: a bet with a blocked task gets no hands — settle runs carry their
  bet, so that covers them — and a lead whose last proposal is blocked is not asked again.
  Routines and founder pings are the only unfunded work, and a routine is only work that
  recurs by nature (a playtest, a store audit): reviewing or marketing the business is a
  bet's job.
- **The store holds the one company this launch runs**, so nothing in its API takes a
  company id: `getCompany()` is null before one is founded, and everything else throws "no
  company is loaded" — a caller that can run without one (tray, boot, the pulse) asks first.
  Lookups (`getX`) return null, `requireX` and commands throw, and null otherwise means only
  that a claim or lock race was lost. It refuses with the sentence the agent should read; a
  tool turns that into its answer, IPC into the founder's note. Don't split it by entity or
  make it async: its synchronous check-and-set is what makes the task lock correct.
- **A company tool is described once**, in `shared/tool-specs.ts`: route, body, lead-only
  refusal, doc and example. The agents' instructions are rendered from it, `main/tools.ts`
  binds each implementation to its spec, and `control-plane.ts` is only transport. A change
  everyone should hear about (a bet, a product, autopilot) goes through
  `main/company-actions.ts`, whoever made it: a tool, the scheduler or the founder's IPC.
- **The policy is data, retuned by replay.** `dream` replays a fixed grid of `PolicyParams`
  against the closed bets and swaps only to a strictly better scorer, so the incumbent never
  loses to a tie. It stays on the defaults below eight closed bets. Steering changes go in
  the policy, not into prompts as advice: briefs carry the ledger as facts only. The game is
  single-player: the replay only ever sees this company's bets, and no ledger leaves the machine.
- **Outward-facing stays founder-gated**, through one judgement: `holdFor` in
  `shared/command-policy.ts`. A shell command matching a rule is signed for once, exactly. A
  page-changing `agent-browser` verb is held unless the session's live URL (read from the
  browser, since a click can land anywhere) is loopback. Employee sessions also load the
  founder's own CLI settings, so their MCP servers, signed in as the founder, are held too.
  A site or a server is leased for the rest of the run; a server nothing can name never is.
  Both runners' wire formats end in `packages/agent-driver/src/tool-ask.ts`; the policy only
  ever sees a `ToolAsk`.

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
  office-design.json, nothing reconciles them. The body probe is 16x12 but the sprite is
  32x64, so art overhangs the body by ~8px and any disagreement renders the character
  against the void. Run `pnpm --filter @repo/desktop check:office` after editing a layout;
  it fails on any seat, point of interest or door unreachable from spawn, any open floor
  cell no body can ever stand on, any reachable spot where the player's art hangs over
  nothing, and any reachable spot where something drawn above the player covers their
  face. The schema (`shared/office-layout-schema.ts`, v2: `seats` with roles, `pois`,
  `door`), the walk grid (`shared/office-grid.ts`) and the sight judgement
  (`shared/office-sight.ts`) are shared by the scene, the save handler and that script —
  a layout main refuses to save is exactly one the check would fail.
- **The walker has two rules the authored collision does not.** A seat's cell is solid
  (sitters are placed on the chair; walkers never stand in it) and open floor no body can
  probe is sealed — both in `walkGridOf`, so the scene, the gate and the builder's
  Rebuild collision agree. At boot the scene additionally closes every reachable node
  where the founder's face would be painted over, judged from the real textures, so a
  saved layout the gate never saw still cannot hide them.

## UI conventions

- **The renderer mirrors main's state by asking again.** An activity event says which slice
  moved; `renderer/state/activity-reducer.ts` (pure, exhaustive over the event kinds — a new
  kind is a compile error, not a silent default) turns it into a patch and the slices to
  refetch. Answers can land out of order, so every fetch takes a ticket and a slice keeps
  only an answer at least as new as its last (`ordering.ts`). Don't put entities in events.
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

- **Verify**: `pnpm verify` (typecheck · lint · format · check:office · test · build). There is no
  GitHub Actions; Vercel's build of `apps/web` is the only remote gate and `verify` runs it.
- **`pnpm lint` is a clean gate.** `oxlint.config.ts` extends the ultracite presets (core, react, anti-slop; next for `apps/web`); every rule is an error. Fix the code, don't add config overrides; a `// oxlint-disable-next-line rule -- why` needs a stated reason.
- **Hard prerequisite**: a signed-in `claude` or `codex` CLI on PATH, or the app can't
  onboard, hire or run anything. There is no seeded save.
- **CLI-free surfaces**: `apps/web`, the onboarding modal, and the two hash routes `#/ui`
  (office builder) and `#/office-assets` — all reachable with no company.
- **`pnpm dev:desktop` stops this checkout's dev processes first**. Unrelated processes on
  TCP 9222 survive; startup fails while that port is occupied.
- **Desktop boot drains queued work immediately**. Use a fresh `IDLEBIZ_ROOT_DIR` to protect
  the real save; see the fixture recipe in `AGENTS.md`. Employee runs still cost money.

Commands: `pnpm verify` · `pnpm dev:desktop` · `pnpm dev:web` · `pnpm knip`
`pnpm knip` checks unused files, exports and dependencies; it is not part of `verify`.
Office layout: `pnpm --filter @repo/desktop check:office` (add `--layout <path>` for a save)
Tests: `pnpm --filter @repo/desktop test` (geometry, schemas, command policy, temporary saves,
and real loopback requests; no Electron or Phaser)
