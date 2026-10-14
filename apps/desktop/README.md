# @repo/desktop — the game

A Tauri 2 app: a Rust shell over the system's own WebKit (WKWebView on the Mac), which runs
**main** — `idlebiz serve`, the server `apps/cli` builds, the node process that owns the save, the
keys and the runs — on the node it ships beside itself, and shows the office page main serves. The
shell holds no game state; everything here that is not the page is what a page cannot do for
itself: a window, a menu-bar icon, message boxes and notifications, the clipboard, Finder, the login
item, the Keychain, and keeping the Mac awake. Of the two programs, this one is the app, `apps/cli`
the server and the binary.

```
src-tauri/        the shell, in Rust: the window and its pin, main as its one child, and what
                  main asks of a native app
src/renderer/     the page: React over a Phaser scene, calling main through `api`, the client
                  of the oRPC contract in packages/contract (`api.ts`, `page-events.ts`)
scripts/          the pack: node, the server staged, signing, notices, the dmg, the release
```

Main itself — the store, the scheduler, the runs, the tools and the page server the window loads
— is `apps/cli/src/server`, and `apps/cli/src/dev-host` runs it as the shell does, for a browser:
`pnpm dev:browser` and e2e.

```sh
pnpm dev:desktop   # tauri dev: the window, the page hot-reloaded, main rebuilt and restarted
pnpm dev:browser   # the same page and main in a browser, at http://localhost:31100/
```

How each part works is told once, in the repo's [AGENTS.md](../../AGENTS.md):

- main as the shell's child over its stdio, the window as main's own page, the menu bar and the
  login item: [The page, the shell and main](../../AGENTS.md#the-page-the-shell-and-main);
- the Keychain's sealing key:
  [Keys and what spends them](../../AGENTS.md#keys-and-what-spends-them);
- the dev loop, the toolchain and what Linux needs besides:
  [Quickstart](../../AGENTS.md#quickstart);
- the pack, the release and the smoke:
  [Packaging and release](../../AGENTS.md#packaging-and-release).

## What is deliberately not here

- **No updater.** A feed is Tauri's updater plugin and a signing key of its own.
- **No WebDriver of the window.** The page and main are driven in Chromium (`tools/e2e`, the dev
  host); the shell is held by `cargo test`, booted packaged by `pnpm smoke:desktop`, and looked at
  by hand.
- **No restart of main.** A main that dies says so in a box and the app quits: main owns the save.
