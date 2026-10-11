# IdleBiz

**[idlebiz.com](https://idlebiz.com)**

A retro RPG-style idle business sim where your employees are real AI agents. They
write real code and docs in a real folder on your machine, coordinate with each
other, ship products, ask you for permission before doing anything public — and
the dashboard can read your actual Stripe revenue and analytics.

## Layout

- `apps/desktop` — the game: a Tauri app, a Rust shell around a React + Phaser page.
- `apps/cli` — the `idlebiz` binary: `idlebiz serve` is main, the node process that runs the
  company, which the app runs as its child and which serves the page; every other verb is a
  company tool the employees call.
- `apps/web` — the landing page (Next.js), styled with the game's pixel-UI kit.
  Download button resolves the latest `.dmg` from GitHub releases.
- `packages/domain`, `packages/contract` — the vocabulary both sides share, and the page's
  API, an oRPC contract the server implements.
- `packages/agent-driver` — spawns the player's `claude` / `codex` CLIs and
  normalizes their event streams.
- `tools/e2e` — the Playwright suite over the built page and server.

Source asset workspace lives outside the repo at `/Users/kyh/Desktop/vg/office`.

## Develop

```sh
pnpm install
pnpm dev:desktop   # the app's window (needs the Rust toolchain; Linux also WebKitGTK)
pnpm dev:browser   # the same office in a browser, at the URL it prints
pnpm dev:web
pnpm verify        # typecheck · lint · knip · format · test · build
```

Employees run on your own signed-in `claude` or `codex` CLI — the app needs one on
PATH. `AGENTS.md` is the guide for coding agents working on this repo.

## Release (desktop)

```sh
pnpm -F @repo/desktop package          # build + sign + notarize locally → .output/bin/*.dmg
pnpm -F @repo/desktop release:publish  # same, then publish to GitHub releases
IDLEBIZ_PACK_UNSIGNED=1 pnpm smoke:desktop  # an ad-hoc pack, booted on a scratch save
```

On a Mac with Xcode's command line tools and the Rust toolchain
(`apps/desktop/rust-toolchain.toml`). Signs with the Developer ID in the keychain (none stops
it, unless `IDLEBIZ_PACK_UNSIGNED=1` asks for an ad-hoc pack); notarizes with the App Store
Connect key `apps/desktop/.env` names (its id and issuer, gitignored; see `.env.example`), whose
`AuthKey_<id>.p8` sits in `~/.appstoreconnect/private_keys/`, never in the checkout: employee
runs read the rest of HOME, but not there. Bump `version` in `apps/desktop/package.json` and
`apps/cli/package.json` together before publishing; the release is tagged `v<version>`.

Game state lives at `~/.idlebiz/company/` as human-readable
agentcompanies/v1 packages (COMPANY.md, agents/, tasks/, shipped/, products/, shared/).
