# OFFICE

A Pokémon-style startup simulator where your employees are **real AI agents that actually do work**.

Found a company, hire AI employees, walk up to them in a top-down pixel office, and tell them what to build in plain language. Under the hood each employee is a [pi](https://github.com/badlogic/pi-mono) coding agent (OpenAI `gpt-5.x`) running in the Electron main process — it writes real files, runs real commands, and produces real artifacts in a per-company workspace on disk. Watch them work live, see the cost tick up, and assign more.

> Stardew Valley meets a control plane for autonomous agents.

## Run it

```bash
npm install
# if Electron's binary didn't download during install:
node node_modules/electron/install.js
npm run dev                 # launches the Electron app (CDP debug on :9222)
```

Auth is **reused from `~/.inteligir/auth.json`** (the existing pi/inteligir OpenAI login) — no fresh OAuth needed. Game data lives under `~/.office/` (SQLite db + per-company workspaces + per-employee agent sessions).

## How it plays

1. **Onboard** — name your company, describe what you're building, pick a type (software / knowledge).
2. **Hire** — browse procedurally-generated candidates (each a unique composited sprite + portrait + persona) and hire who you want. They appear at a desk.
3. **Walk up** (WASD / arrows) and press **E** to open a dialogue.
4. **Assign** — type an instruction or tap a quick action. The employee goes "working", a real pi run executes, and its tool calls / messages / cost stream into the dialogue feed.
5. **Done** — files land in the company workspace; the task summary shows what they did. Employees keep their pi session, so they remember prior work.

## Architecture

One Electron app, three layers:

- **Renderer** (`src/renderer/`) — React 19 overlay + a Phaser 4 game.
  - `game/` — `OfficeScene` (tilemap office, player movement + AABB collision, camera), `npcs.ts` (employee NPCs + state), `characters.ts` (loads composited sprites), `PhaserGame.tsx`.
  - `ui/` — `Onboarding`, `Hiring`, `Dialogue`, `Hud`.
  - `state/store.ts` — tiny external store; subscribes to `onActivity`, drives HUD/dialogue.
- **Main** (`src/main/`) — the control plane (paperclip-patterned, slim).
  - `store/store.ts` — `node:sqlite` schema + repo with the atomic single-assignee checkout / run-lock.
  - `agents/pi-driver.ts` — one in-process `PiAgent` per employee (shared `AuthStorage`/`ModelRegistry`/`Model`, per-employee cwd/agentDir/session), plus an `ask_boss` tool.
  - `agents/event-parser.ts` — flattens pi events (reads `stopReason`/`errorMessage`/`usage` off `message`).
  - `scheduler.ts` — async run loop: concurrency cap 3 + per-employee single-active, streams events to `activity_log` + renderer.
  - `character/compositor.ts` — builds employee walk spritesheets + portraits (sharp), returned as base64.
- **IPC** (`src/shared/`) — `ipc-channels.ts` (plain, zod-free, safe for the sandboxed preload) + `ipc-registry.ts` (zod schemas + typed `Contract`/`AppBridge`).

## Data model (SQLite, `~/.office/office.db`)

`company` · `employee` (= agent) · `task` (= issue, with a `run_id` execution lock) · `run` (token usage + cost) · `activity_log` (event-sourced feed). Cost is whatever pi reports per run, summed onto `company.spent_cents` for the meter.

## Assets

Runtime assets are curated PNGs in `public/workspace-kit/` and
`resources/employee-sheets/`. Source asset workspace lives outside the repo at
`/Users/kyh/Desktop/vg/office`.

## Notes / next steps

- `ask_boss` marks a task `blocked` with a question — the "they need you" mechanic is wired but the UI for answering a blocked question is minimal.
- Packaging (`electron-builder`) needs `sharp` in `asarUnpack` (already configured); not yet built/notarized.
- Cost is per-pi-report; subscription auth may report `$0` (meter then shows tokens).
- Stretch: free-form streaming chat (vs. task-assignment), model-tier-as-salary, multi-room office, a real "blocked question" reply flow.
