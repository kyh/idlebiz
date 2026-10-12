# @repo/desktop — the game

The app the founder installs: a Tauri 2 shell over the system's own WebKit, which runs main
(`idlebiz serve`, which `apps/cli` builds) as its one child and shows the office page main serves.
How the shell, main and the page fit together and how the app is packed are AGENTS.md's ("The
page, the shell and main", "Packaging and release"), and its Map says where each part lives.

## Running it

```sh
pnpm dev:desktop   # tauri dev: the window, the page hot-reloaded, main rebuilt and restarted
pnpm dev:browser   # the same page and main in a browser, at http://localhost:31100/
```

## What is deliberately not here

- **No updater.** A feed is Tauri's updater plugin and a signing key of its own.
- **No WebDriver of the window.** The page and main are driven in Chromium (`tools/e2e`, the dev
  host); the shell is held by `cargo test`, booted packaged by `pnpm smoke:desktop`, and looked at
  by hand.
- **No restart of main.** A main that dies says so in a box and the app quits: main owns the save.
