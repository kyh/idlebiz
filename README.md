# IdleBiz

**[idlebiz.com](https://idlebiz.com)**

A retro RPG-style idle business sim where your employees are real AI agents. They
write real code and docs in a real folder on your machine, coordinate with each
other, ship products, ask you for permission before doing anything public — and
the dashboard can read your actual Stripe revenue and analytics.

## Layout

- `apps/desktop` — the game: a Tauri app (a Rust shell around a React + Phaser page, and
  main, the node process that runs the company).
  Character sprites generate from bundled employee sheets at
  `apps/desktop/resources/employee-sheets`.
- `apps/web` — the landing page (Next.js), styled with the game's pixel-UI kit.
  Download button resolves the latest `.dmg` from GitHub releases.
- `packages/agent-driver` — spawns the player's `claude` / `codex` CLIs and
  normalizes their event streams.

Source asset workspace lives outside the repo at `/Users/kyh/Desktop/vg/office`.

## Develop

```sh
pnpm install
pnpm dev:desktop   # the app's window (needs the Rust toolchain; Linux also WebKitGTK)
pnpm dev:browser   # the same office in a browser, at the URL it prints
pnpm dev:web
pnpm verify        # typecheck · lint · format · test · build
```

Employees run on your own signed-in `claude` or `codex` CLI — the app needs one on
PATH. `AGENTS.md` is the guide for coding agents working on this repo.

## Release (desktop)

```sh
pnpm -F @repo/desktop package          # build + sign + notarize locally → .output/bin/*.dmg
pnpm -F @repo/desktop release:publish  # same, then publish to GitHub releases
```

On a Mac with Xcode's command line tools and the Rust toolchain
(`apps/desktop/rust-toolchain.toml`). Signs with the Developer ID in the keychain (ad-hoc
without one); notarizes with `apps/desktop/.env` (Apple notarization creds) and the
`AuthKey_*.p8` at the repo root — both gitignored. Bump `version` in
`apps/desktop/package.json` before publishing; the release is tagged `v<version>`.

Game state lives at `~/.idlebiz/<company-slug>/` as human-readable
agentcompanies/v1 packages (COMPANY.md, agents/, tasks/, shipped/, products/, workspace/).
