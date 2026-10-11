# IdleBiz

Tauri game where AI employees — real `claude` / `codex` CLI sessions — operate a business. This
file holds the premises and the decisions, each in a line or two with its reason. The workflow,
the map and how each mechanic works are `AGENTS.md`'s, imported at the end, each described there
once: change a mechanic there, and a decision here.

## Premises

- **Two programs.** `apps/desktop` is the app the founder installs: a Rust shell (`src-tauri`)
  around the office page (Vite + React + Phaser). `apps/cli` is the `idlebiz` binary:
  `idlebiz serve` is main, the node process that owns the save, the keys and the runs, the shell's
  one child, reached over its stdio. Every other verb is a company tool an employee types in its
  shell (`idlebiz message-team '{"text":"…"}'`).
- **The save is human-readable markdown**: agentcompanies/v1 packages under `~/.idlebiz/company/`.
  A root holds one save or none, so no record carries a company id.
- **No users yet, so no adoption code.** A save stamped at any format but this build's is refused:
  a newer one because writers rebuild files from what they understand, so opening it would drop
  what that build added; an older one because a pre-release build made it. A format bump resets
  every save, and the first migration is written once a bump would strand someone's.
- **A session is check in, sign off, leave.** Autopilot is on from founding, and the Mac is kept
  out of idle sleep only while a run is in flight, never past a closed lid.
- **The budget is usage at API prices**: what the runs would cost billed per token, not what the
  founder's plan bills, so nothing calls it spend.
- **Single-player.** The replay only ever sees this company's bets, and no ledger leaves the
  machine.
- **Employee runs load IdleBiz's own skills and none of the founder's.** A skill is prose no test
  renders from `server/tool-specs.ts`, so a change to a tool or rule one cites (a bet's floor, the
  unlock's key) changes that skill in the same commit.
- **Employee character sheets** and their busts are the page's own files, curated and served as
  they are, at `apps/desktop/public/characters`: the office cuts its anims from each sheet by
  `@repo/domain/character-frame`, and `@repo/domain/character-seed` maps a saved sprite seed to
  its sheet, so changing either changes every saved face. Their source workspace lives outside the
  repo at `/Users/kyh/Desktop/vg/office`.
- **The game reads as a handheld RPG but never names one**: no "Pokémon"/"poke" in code,
  comments, copy or docs.

## Steering

- **Bets steer the company**, each one hypothesis about one real number of one product, with a
  spend cap and a window.
- **The evaluator judges, never the team**: no tool lets an agent declare a win. A target has a
  floor, since under it the founder's own clicks or one charge would win the bet, and a win steers
  the allocator and the replay.
- **A bet counts only what carries its mark**, a landing path or a payment's tag, so any number of
  bets run on one product and none can claim another's result.
- **Only money somebody paid counts**: test-mode money (a test card, `stripe trigger`) counts
  nowhere unless a developer opts in for an end-to-end run.
- **Idle hands only spend against a fundable bet.** `allocate` decides where every run goes and
  the scheduler only carries it out. Routines and founder pings are the only unfunded work, and a
  routine is only work that recurs by nature: reviewing or marketing the business is a bet's job.
- **The policy is data, retuned by replay.** Steering changes go in the policy, not into prompts
  as advice: briefs carry the ledger as facts only.
- **Prose an employee reads lives in `server/prompts/`.** The store persists it and the scheduler
  gathers what it is grounded in; neither authors text.
- **What only a human can do is an action card**: the agents propose the step rather than stall,
  and keep questions rare.
- **VC sells information, never investment**: taking money as an investment or selling a security
  is regulated, and Stripe forbids it.

## Security

- **Two boundaries hold a run**, since a run is a real CLI session running as the founder's OS
  user: the Seatbelt seal decides what it reads, writes and reaches on this machine, and custody
  keeps IdleBiz's keys in main and runs every step that spends them there, once the founder signs
  off.
- **The command policy is a tripwire, not a third boundary**: what a script runs goes unseen.
- **No run starts unsealed**: the seal is one boundary, and also what makes a run's socket its own.
- **Who calls the company is the socket, not a secret**: any run can read a teammate's env, token
  included, but never reach its socket, so no teammate calls lead-only tools as the lead.
- **Keys stay in main; what spends them runs there.** No key reaches a run's env; a step that needs
  one is a tool main runs once the founder signs off on the action it names.
- **A run signs in as the founder's CLI, on the model they picked, and loads nothing else of
  theirs**: their MCP servers and connectors act signed in as the founder, and a project's settings
  are what a run could write for the next to load.
- **Nothing pushes code.** The founder pushes by hand from a fresh clone: git inside a workspace
  obeys what a run left there, unsealed, as the founder.
- **What the boundaries leave open is listed**, on purpose or for want of a rule, in AGENTS.md's
  "What stays open".

## Code

- **Strict TS everywhere** — no `any`, no non-null `!`, no `as` but `as const` (parse at the
  boundary or narrow with a guard) — and clippy pedantic in Rust. Kebab-case filenames. Make
  illegal states unrepresentable.
- **Lint and the compiler are clean gates**: fix the code, don't add config overrides; a disable
  comment states why.
- **The store is one synchronous object.** Don't split it by entity or make it async: its
  synchronous check-and-set is what makes the task lock correct.
- **A refusal is a sentence.** The store refuses with a `RefusalError` worded as what the agent
  should read; anything else thrown is a fault, reported to main's log.
- **A codec skips, never defaults.** A package its strict schema refuses is named in the load
  report, never read with a default.
- **A company tool is described once**, in `server/tool-specs.ts`, so the instructions, the verb
  and the server cannot disagree.
- **A change everyone should hear about goes through `server/company-actions.ts`**, whoever made
  it, and its `postToRoom` is the room's only writer, so the room agents read and #team hold the
  same lines and no office news reads as the founder's word.
- **Two doors, never one.** The page reaches main over its contract and the runs over the control
  plane: the page's door carries the founder's session cookie on a port the seal closes to every
  run.
- **The page's API is a contract** (`packages/contract`): declare the zod schema, never a parallel
  type. The page and main ship in one app, so it may break freely.
- **The shell and main pin each relay method to one sample**, since neither compiles against the
  other: a method added, renamed or reshaped changes its sample and both ends in one commit.
- **Everything main says happened goes through `server/activity.ts`**: a second emit path would
  be a listener somebody forgot.
- **The activity log is an audit trail, not a query store**: state that outlives a run is written
  where it is known.
- **Vocabularies are `as const` tuples** (`TASK_STATUSES`, `INTEGRATION_KINDS`,
  `BUSINESS_TYPE_IDS`, `RUNNER_IDS`): the type and the zod enum both derive from the tuple, so there
  is nothing to keep in sync.
- **`apps/cli` `dependencies` is exactly what the server ships**: what Vite bundles goes in
  `devDependencies`, or the app ships it for nothing.

## UI

- **The renderer mirrors main's state by asking again.** An activity event says what moved, never
  the entities: `renderer/state/activity-reducer.ts` (pure, exhaustive over the event kinds, so a
  new kind is a compile error, not a silent default) turns it into a patch and the query keys to
  refetch. A patch outranks every read in flight, which is cancelled rather than let land over it,
  so a key an event patches is also one it refetches, or what the cancelled read carried (a hire)
  is lost.
- **Every mutation goes through `useSubmission`** (`renderer/hooks/use-submission.ts`): a throw
  inside an action goes to the error boundary, so the hook returns failure as state. No
  `void action()` in a handler, no hand-rolled `mounted` refs. A read is a `useQuery` (or one of
  the hooks over one in `queries.ts`), its failure state too, and main's answer to a change is held
  with `setAnswer`, which outranks reads in flight as a patch does.
- **React and the office scene talk through `renderer/game/office-port.ts`**, a typed vocabulary
  over Phaser's emitter. The scene reads main's state from the window's cache, so a boot asks main
  once for each answer.
- **Headless interactions come from Base UI** (`@base-ui/react/<part>`), skinned with px-kit:
  dialogs, choice windows and toggles are never hand-rolled (`renderer/ui/modal.tsx` and
  `renderer/ui/choice-menu.tsx` are the patterns). Its composites learn their items a render after
  mount, so focus them from a deferred effect and mark the default tab stop with
  `data-composite-item-active`, not `autoFocus`.
- **Size and colour belong in px-kit as a class, never per-component**: the kit is unlayered, so it
  beats any Tailwind utility on the same element.
- **Some icons deliberately use OS fonts.** VG5000 lacks recognizable equivalents for ⚙ settings,
  💼 company and ☕ idle; ❗ attention and ⚠ warnings keep their colour cues. Keep the vendored font
  unchanged.
- **The office is frozen data no tool authors**, and its art and collision are independent, so a
  hand edit to either can stand a character over the void or behind furniture.

## The repo

- **No sandbox runs inside the seal**: sandbox-exec cannot nest, so claude's, codex's and Chrome's
  own are off, and a codex-acp upgrade must carry the app's patch.
- **One main per save**: boot claims the save before it reads it, so a second main refuses rather
  than run each task twice.
- **The shell is copied between sibling repos, never shared.** Its log, origin-pin and runtime
  modules (`main_log.rs`, `navigation.rs`, `window.rs`, `runtime.rs` in `src-tauri/src/`) and the
  pack's scripts (`apps/desktop/scripts`) are copied between kyh/init, this repo and
  kyh/inteligir, and the two-program layout and main's page server and its sign-in
  (`server/page-server.ts`, `server/page-session.ts`) between this repo and kyh/inteligir. They
  diverge on purpose. No package holds them: each shell supervises its own server and each server
  drives its own ACP runtime, and two public repos would need a third to publish one from. A fix
  in one is ported to the others by hand. The node pin (`VERSION` and its sha-256 in
  `apps/desktop/scripts/fetch-node.ts`) and `apps/desktop/rust-toolchain.toml` move together
  across all three. inteligir's pin allows `about:srcdoc` and this one refuses it, on purpose: the
  office draws no frame.

@AGENTS.md
