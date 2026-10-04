# @repo/desktop — the game

A Tauri 2 app: a Rust shell over the system's own WebKit (WKWebView on the Mac), which shows the
office page and runs **main**, the node process that owns the save, the keys and the runs, on the
node it ships beside itself (issue #60). The shell holds no game state; everything here that is not
main is what a page cannot do for itself: a window, a menu-bar icon, message boxes and
notifications, the clipboard, Finder, the login item, the Keychain, and keeping the Mac awake.

```
src-tauri/        the shell, in Rust: the window and its pin, main as its one child, and what
                  main asks of a native app
src/main/         main: the store, the scheduler, the runs, the tools (AGENTS.md has the map)
src/renderer/     the page: React over a Phaser scene, reaching main through `globalThis.appBridge`
src/shared/       what main and the page share: the channels, their schemas, the domain
src/dev-host/     main behind a token bridge for a browser: `pnpm dev:browser` and e2e
```

## Main is the shell's child, and its stdio is the one channel

The shell starts main on node (`src-tauri/src/main_process.rs`) and speaks JSON-RPC 2.0 to it over
its stdio, one message a line, with requests both ways (`src-tauri/src/relay.rs`;
`src/main/relay/` is main's end). Main's stdout carries the protocol alone: anything else main or a
library writes there is moved to stderr, which the shell appends, stamped, to `main.log`.

- The shell says `hello` first, with what only it knows: the resources folder (the skills and the
  employee sheets), whether the login item launched it, and the Keychain's password. Main boots on
  it; a hello that fails says where the log is, in a box, and the app quits.
- The window's calls reach main as `invoke {method, payload}` through the page's one command,
  `main_invoke` (`src-tauri/src/commands.rs`), which relays them unread: main parses every payload
  (`src/main/lib/ipc-handler.ts`). Main's events come back as Tauri events under each channel's own
  name.
- Main asks the shell (`src/main/host.ts`, answered in `src-tauri/src/host.rs`): a message box, the
  clipboard, opening a URL, a file or a folder, the login item; and tells it the menu-bar icon's
  model, a notification, whether to keep the Mac awake, and to relaunch after a reset.
- A quit asks main to stop its runs (`quit`), then closes its stdin, then waits; a main that has
  not exited five seconds later is killed with its process group. Main's stdin is also its
  lifeline: a shell that crashed or was killed ends main too, after its runs. Main leads a process
  group of its own, so a Ctrl-C under `tauri dev` reaches the shell alone, which stops main once.
  There is no restart: main owns the save, and a second one under a first that has not let go
  would race it.

## The window

One window over the bundle's own page (the dev server's under `tauri dev`), pinned to that origin:
a link to any other web page opens in the browser, `window.open` makes no second window, and every
device permission is refused (`src-tauri/src/window.rs`). Closing it hides it and the dock icon:
the office keeps working in the menu bar, and Open brings the same page back. A launch at login
starts there, with no window until the founder opens one. The page's content security policy is
`app.security.csp` in `src-tauri/tauri.conf.json`; the dev server writes the same one into the page
it serves (`src/dev-host/policy.ts`).

`capabilities/main.json` grants the window `main_invoke` and the event listener, nothing else; the
app manifest in `build.rs` names the one command, so `removeUnusedCommands` drops every other.

## The Keychain, sealed as Electron sealed it

`secrets.json`'s values are sealed as Electron's `safeStorage` sealed them on the Mac, Chromium's
OSCrypt v10, so a save an Electron build sealed opens as it was. The shell reads the password from
the Keychain item Electron made ("IdleBiz Safe Storage", `src-tauri/src/keychain.rs`), being the
same signed app, and hands it to main at hello; main derives the key and seals
(`src/main/lib/os-crypt.ts`). Main never reaches the Keychain. A development shell hands the mock
keychain's password Chromium's dev builds sealed with.

## Running it

```sh
pnpm dev:desktop   # tauri dev: the window, the page hot-reloaded, main rebuilt and restarted
pnpm dev:browser   # the same page and main in a browser, at the URL it prints
```

Both need main built, which the dev server does before it serves the page and again on each change
(`vite.config.ts`). `tauri dev` relaunches the shell when main changes (its watcher skips what
`.gitignore` names, so `.taurignore` brings `.output/main` back); `dev:browser` restarts main
itself. The browser is the surface automation drives: WKWebView takes no WebDriver on the Mac. The
dev host's bridge sits on the dev server's own origin (`/__idlebiz/*`), behind a token in the page's
URL fragment, and the seal closes that port to every employee run.

The shell compiles on the toolchain `rust-toolchain.toml` pins: `pnpm typecheck` runs clippy
(pedantic, `-D warnings`), `pnpm test` runs `cargo test` after vitest, `pnpm format` runs
`cargo fmt --check`. On Linux the shell needs WebKitGTK (`libwebkit2gtk-4.1-dev`) and the
appindicator for its menu-bar icon (`libayatana-appindicator3-dev`).

## Packaging

`pnpm -F @repo/desktop package`, on a Mac (`scripts/package.ts`):

1. fetches the node the app runs main on, pinned by sha-256 (`scripts/fetch-node.ts`), into
   `src-tauri/binaries/` (`bundle.externalBin`, beside the shell in `Contents/MacOS`) with its
   licence for `Contents/Resources/node`;
2. builds the page and main, and stages main with its production dependencies (the ACP adapters,
   sharp) by `pnpm deploy`, the workspace's patches applied (`scripts/stage-main.ts`), into
   `Contents/Resources/main`;
3. signs every Mach-O those dependencies carry with the hardened runtime and the app's
   entitlements (`scripts/sign-resources.ts`), since notarization refuses an unsigned one inside;
4. writes the licences of the Rust crates the shell links (`scripts/rust-notices.ts`) to
   `Contents/Resources/notices`;
5. runs `tauri build` with a config of its own (the resources, the sidecar, the signing identity,
   macOS 13.5 as the floor, node 24's), and copies the dmg to `.output/bin`.

It signs with the Developer ID the keychain holds (`APPLE_SIGNING_IDENTITY` names another;
`IDLEBIZ_PACK_UNSIGNED=1` packs ad-hoc, for this Mac alone) and notarizes with
`apps/desktop/.env`'s App Store Connect key. `pnpm -F @repo/desktop release:publish` packs, then
publishes the dmg as the release tagged `v<version>`, where the site's download link finds it.

## What is deliberately not here

- **No updater.** The Electron builds shipped none either; a feed is Tauri's updater plugin and a
  signing key of its own, as kyh/inteligir's.
- **No WebDriver of the window.** The page and main are driven in Chromium (e2e, the dev host);
  the shell is held by `cargo test` and looked at by hand.
- **No restart of main.** A main that dies says so in a box and the app quits: main owns the save.
