# IdleBiz

Electron game where AI employees — real `claude` / `codex` CLI sessions — operate a
business. Main app: `apps/desktop` (electron-vite + React + Phaser, strict TS — no
`any`, no `!`, no `as`). Full map and workflow in `AGENTS.md`.

- Game state on disk at `~/.idlebiz/<company-slug>/` — agentcompanies/v1 markdown
  packages (COMPANY.md, agents/<slug>/AGENTS.md doubles as the live agent
  instructions, tasks/<slug>/TASK.md, routines/, workspace/, activity.jsonl).
- Employee character sheets are bundled at `apps/desktop/resources/employee-sheets`
  as curated runtime assets. Source workspace lives outside the repo at
  `/Users/kyh/Desktop/vg/office`.
- Verify changes live: `pnpm dev:desktop` exposes CDP on :9222 (use agent-browser).
  Under headless automation the Phaser boot stalls (document.hidden) — force
  `window.__game.scene.start("office")` and step `game.loop.step(t)` to render.

## Two traps that fail silently

- **The px-kit beats Tailwind.** The `.px-*` classes in `renderer/styles.css` live outside
  `@layer`; Tailwind's utilities are layered, and unlayered CSS wins regardless of
  specificity. So a utility on the same element that sets a property its kit class also
  sets does _nothing_ — `text-[12px]` on a `.px-btn` never applied (23 such declarations
  had accumulated). Classes that set font-size/color: `.px-btn` `.px-opt` `.px-field`
  `.px-chip` `.px-cmd` `.px-badge`. Size and colour belong in styles.css as a kit class,
  never per-component. Icons are font glyphs, so "icon size" is font-size: use `.px-icon`.
- **The office's art and its collision don't know about each other.** `buildRoom` reads
  `objects`, `officeSolidAt` reads `collision` — two independent sections of
  office-design.json, nothing reconciles them. The body probe is 16x12 but the sprite is
  32x64, so art overhangs the body by ~8px and any disagreement renders the character
  against the void. Run `pnpm --filter @repo/desktop check:office` after editing a layout;
  it fails on any reachable spot where the player's art hangs over nothing.

## Agent-driven development

`AGENTS.md` is the full workflow — read it before driving this repo. The essentials:

- **Verify**: `pnpm verify` (typecheck · lint · format · check:office · build). There is no
  GitHub Actions; Vercel's build of `apps/web` is the only remote gate and `verify` runs it.
- **Hard prerequisite**: a signed-in `claude` or `codex` CLI on PATH, or the app can't
  onboard, hire or run anything. There is no seeded save.
- **CLI-free surfaces**: `apps/web`, the onboarding modal, and the two hash routes `#/ui`
  (office builder) and `#/office-assets` — all reachable with no company.
- **`pnpm dev:desktop` kills first**: `dev:kill` SIGKILLs this checkout's dev processes _and_
  whatever holds TCP 9222. Check `lsof -ti tcp:9222` before starting.
- **`pnpm dev:desktop` also costs money**: boot calls `scheduler.start()`, which drains the
  task queue immediately against the real `~/.idlebiz` save — real CLI spend, real writes.
  `ls ~/.idlebiz` first; don't boot it on a machine with a live company.

Commands: `pnpm verify` · `pnpm dev:desktop` · `pnpm dev:web` · `pnpm knip`
`pnpm knip` is exploratory, not a gate (it's not in `verify`) and currently exits 1 on
pre-existing unused exports in `apps/desktop` — treat its output as a cleanup backlog,
not as something your change broke.
Office layout: `pnpm --filter @repo/desktop check:office` (add `--layout <path>` for a save)
