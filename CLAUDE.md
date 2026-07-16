# IdleBiz

Electron game where AI employees (pi agents) really operate a business. One app:
`apps/desktop` (electron-vite + React + Phaser, strict TS — no `any`, no `!`, no `as`).

- Game state on disk at `~/.idlebiz/<company-slug>/` — agentcompanies/v1 markdown
  packages (COMPANY.md, agents/<slug>/AGENTS.md doubles as the live pi agent
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

Commands: `pnpm typecheck` · `pnpm lint` · `pnpm format` · `pnpm dev:desktop`
Office layout: `pnpm --filter @repo/desktop check:office` (add `--layout <path>` for a save)
