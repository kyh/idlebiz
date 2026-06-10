# IdleBiz

A Pokémon-style idle business sim where your employees are real AI agents. They
write real code and docs in a real folder on your machine, coordinate with each
other, ship products, ask you for permission before doing anything public — and
the dashboard can read your actual Stripe revenue and analytics.

## Layout

- `apps/desktop` — the Electron game (electron-vite + React + Phaser + pi agents).
  Character sprites generate from the premade sheets bundled at
  `apps/desktop/resources/premades` (derived from the paid Limezu pack — keep
  this repo private).

## Develop

```sh
pnpm install
pnpm dev:desktop
```

Game state lives at `~/.idlebiz/<company-slug>/` as human-readable
agentcompanies/v1 packages (COMPANY.md, agents/, tasks/, workspace/).
