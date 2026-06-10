# IdleBiz

Electron game where AI employees (pi agents) really operate a business. One app:
`apps/desktop` (electron-vite + React + Phaser, strict TS — no `any`, no `!`, no `as`).

- Game state on disk at `~/.idlebiz/<company-slug>/` — agentcompanies/v1 markdown
  packages (COMPANY.md, agents/<slug>/AGENTS.md doubles as the live pi agent
  instructions, tasks/<slug>/TASK.md, routines/, workspace/, activity.jsonl).
- `reference/` (gitignored) holds the paid Limezu asset packs the character
  compositor reads at runtime, plus paperclip-master as architecture reference.
  Override location with IDLEBIZ_REFERENCE_DIR.
- Verify changes live: `pnpm dev:desktop` exposes CDP on :9222 (use agent-browser).
  Under headless automation the Phaser boot stalls (document.hidden) — force
  `window.__game.scene.start("office")` and step `game.loop.step(t)` to render.

Commands: `pnpm typecheck` · `pnpm lint` · `pnpm format` · `pnpm dev:desktop`
