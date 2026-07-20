# AGENTS.md

**IdleBiz** is a Pokémon-style idle business sim where the employees are the player's own
coding CLIs. One Electron app (`apps/desktop`) spawns real `claude` / `codex` sessions and
saves the whole company as human-readable markdown under `~/.idlebiz/`; a small Next.js
landing page (`apps/web`) ships the download and the Stripe Connect OAuth hop. This is the
tool-agnostic guide for coding agents — meant to be run, not just read. Claude also reads
`CLAUDE.md`; both point back here.

> Naming: this file is repo documentation. The `AGENTS.md` files under
> `~/.idlebiz/<company>/agents/<slug>/` are game data — the in-game employee's own
> instructions (`apps/desktop/src/main/paths.ts`). Unrelated.

## Quickstart

```sh
pnpm install
pnpm verify        # static gate: typecheck · lint · format · check:office · build
pnpm dev:web       # landing page → http://localhost:3000
pnpm dev:desktop   # Electron window + CDP on :9222
```

No database, no Docker, no server to provision — `pnpm install` really is the whole setup.
There is no bootstrap script and nothing to seed.

**`pnpm dev:desktop` is not a plain dev server.** It runs `pnpm dev:kill` first
(`apps/desktop/scripts/devkill.sh`), which SIGKILLs turbo / electron-vite / Electron /
esbuild processes matched to _this checkout's_ absolute path — and then kills whatever holds
TCP **9222**, no matter who owns it. Check `lsof -ti tcp:9222` before starting: an unrelated
agent-browser session on that port will be killed.

## The one hard prerequisite

The app is inert without a **signed-in `claude` or `codex` CLI on PATH**.
`packages/agent-driver/src/detect.ts` probes `claude auth status` / `codex login status`;
`hasAuth` in `apps/desktop/src/main/index.ts` gates the UI behind
`renderer/ui/auth-gate.tsx`. IdleBiz stores no model-provider credentials of its own — every
run bills against the player's existing CLI login.

Preflight — run these three before deciding what you can verify:

```sh
claude --version          # or: codex --version — at least one must resolve
codex --version
agent-browser --version   # missing ⇒ npm i -g agent-browser && agent-browser install
```

A sandbox without those CLIs can still do the full static gate and can still drive the two
CLI-free surfaces below; it cannot reach a populated office.

## Verify a change end-to-end

Static gate (there is no GitHub Actions here — Vercel's build of `apps/web` on push is the
only remote check, and `pnpm verify` runs the same `next build`):

```sh
pnpm verify
```

Runtime, web — headless with [agent-browser](https://github.com/vercel-labs/agent-browser):

```sh
pnpm dev:web &
agent-browser open http://localhost:3000
agent-browser snapshot          # accessibility tree with @eN refs
agent-browser screenshot /tmp/web.png
```

Runtime, desktop — attach to the Electron renderer over CDP.

> **⚠️ Booting the desktop app spends real money and mutates the founder's save.**
> `main/index.ts` calls `scheduler.start()` unconditionally at boot, and `Scheduler.start()`
> fires `onTick()` _synchronously_ — which drains the queued-task queue (deliberately, "so
> backoff retries resume even with autopilot off") and then self-directs idle employees if
> autopilot is on. Every run it starts is a real `claude` / `codex` session billed to the
> founder's own CLI login, writing markdown into the real save. There is no test root:
> `ROOT_DIR` is hardcoded to `~/.idlebiz` (`main/paths.ts`) and `getDefaultCompany()` returns
> the most recently created company.
>
> **Run `ls ~/.idlebiz` first.** If it lists a company directory, do _not_ run
> `pnpm dev:desktop` — move the directory aside first, or stay on `pnpm dev:web` and the
> static gate. (Making `ROOT_DIR` overridable is the open prerequisite for safe desktop
> fixtures; until then this is a manual check.)

**(a) CLI-free routes** — the office builder and the object catalog render with no company,
so no scheduler work is required to see them. They contain no Phaser; skip the block below.

```sh
ls ~/.idlebiz                   # STOP if a company dir exists (see warning above)
lsof -ti tcp:9222 || true       # must be free, or dev:kill will take it
pnpm dev:desktop &
agent-browser connect 9222
agent-browser eval 'location.hash = "#/ui"'   # or "#/office-assets"
agent-browser screenshot /tmp/builder.png
agent-browser close
pnpm dev:kill                   # tear the session down
```

**(b) The office scene** — only on the default route (`#/`), and only with a finished
onboarding, i.e. a signed-in CLI. Do not navigate away from `#/` first: `#/ui` and
`#/office-assets` unmount `<PhaserGame>`, whose cleanup runs `game.destroy(true)` while
`window.__game` keeps pointing at the destroyed instance — the evals below then throw or
silently no-op. Under headless automation Phaser's boot also stalls (`document.hidden` never
flips), so the canvas stays blank until you step it:

```sh
agent-browser connect 9222
agent-browser eval 'location.hash'                          # expect "" or "#/"
agent-browser eval 'window.__game.scene.start("office")'
agent-browser eval 'window.__game.loop.step(performance.now())'
agent-browser screenshot /tmp/office.png
```

Don't stop at `pnpm verify` — for anything the player can see, drive it and look.

## What is verifiable without a signed-in CLI

| Surface                              | How to reach it                     | CLI needed? |
| ------------------------------------ | ----------------------------------- | ----------- |
| `apps/web` landing + `/api/stripe/*` | `pnpm dev:web`                      | no          |
| Office builder (`#/ui`)              | `location.hash = "#/ui"`            | no          |
| Object catalog (`#/office-assets`)   | `location.hash = "#/office-assets"` | no          |
| Onboarding modal (first screen)      | boot with an empty `~/.idlebiz`     | no          |
| Office, HUD, dialogue, teams, ships  | finish onboarding                   | **yes**     |

The last row is a hard gate, not a convenience: `renderer/ui/poke-onboarding.tsx` calls
`generateHires`, which dispatches a real agent run (`main/agents/onboarding.ts`), and
`finalize()` bails when no hires come back. There is no seeded save — and note the app
writes to the _real_ `~/.idlebiz`, so anything you create there lands in the founder's
actual game, and booting at all starts the scheduler against it (see the warning above).

## Platform matrix

| Platform           | Dev command        | Agent-verifiable at runtime?                       |
| ------------------ | ------------------ | -------------------------------------------------- |
| Desktop (Electron) | `pnpm dev:desktop` | **Yes** — CDP on :9222 via `agent-browser connect` |
| Web (Next.js)      | `pnpm dev:web`     | **Yes** — headless via agent-browser               |

Unusually for this stack, the Electron app is the _more_ driveable surface: electron-vite
already starts it with `--remoteDebuggingPort 9222`.

## Configuration

Nothing is required to run. Every key is optional and its absence disables one feature
rather than crashing boot.

- `apps/web` — `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY` (see `.env.example`, read through
  `src/lib/env.ts`). Missing ⇒ `/api/stripe/*` refuses the flow with a clear message.
- Desktop runtime secrets live in `~/.idlebiz/secrets.json`, not a `.env`.
  `main/secrets.ts` exports them into the process env at boot so both the metrics providers
  and every employee's shell inherit them: `STRIPE_SECRET_KEY` / `STRIPE_CONNECT_TOKEN`,
  `PLAUSIBLE_API_KEY`, `VERCEL_TOKEN`.
- `IDLEBIZ_WEB_URL` points the Stripe Connect hop at a local `apps/web`
  (`main/stripe-connect.ts`); `CLAUDE_BIN` / `CODEX_BIN` override the CLI paths
  (`packages/agent-driver/src/runner.ts`).
- `apps/desktop/.env` (see `.env.example`) is release-only: Apple notarization keys for
  `pnpm --filter @repo/desktop release`.

## Rules that matter

- **No `any`, no non-null `!`, no `as` casts.** Kebab-case filenames. Make illegal states
  unrepresentable.
- **The px-kit beats Tailwind.** `.px-*` classes in `renderer/styles.css` are unlayered, so
  they win over any Tailwind utility that sets the same property. Size and colour belong in
  `styles.css` as a kit class, never per-component. Full explanation in `CLAUDE.md`.
- **Office art and collision are independent sections of `office-design.json`.** After any
  layout edit run `pnpm --filter @repo/desktop check:office` (already part of `pnpm verify`).
- **IPC goes through the registry.** `shared/ipc-channels.ts` is the runtime source of truth
  for channel names and must stay dependency-free (the sandboxed preload imports it);
  zod payload schemas live in `shared/ipc-registry.ts`.

## Map

- `apps/desktop/src/main` — the control plane. `store/store.ts` (markdown packages ⇄ domain
  objects), `paths.ts` (the on-disk save format, documented at the top), `scheduler.ts` (the
  idle loop), `agents/` (runs), `control-plane.ts` (loopback HTTP the agents curl back into),
  `secrets.ts`, `metrics.ts`, `tray.ts`.
- `apps/desktop/src/renderer` — React overlay (`ui/`) over a Phaser 4 scene (`game/`), with a
  hand-rolled external store in `state/store.ts`.
- `apps/desktop/src/shared` — `ipc-channels.ts`, `ipc-registry.ts`, `domain.ts`, `format.ts`.
- `apps/web` — landing page plus the three Stripe Connect route handlers.
- `packages/agent-driver` — spawns `claude` / `codex`, normalizes their NDJSON event streams,
  prices usage, tracks rate limits. Source-only, no build step.
