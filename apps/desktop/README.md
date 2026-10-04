# @repo/desktop — the game

A Tauri 2 app: a Rust shell over the system's own WebKit (WKWebView on the Mac), which runs
**main**, the node process that owns the save, the keys and the runs, on the node it ships beside
itself (issue #60), and shows the office page main serves. The shell holds no game state; everything here that is not
main is what a page cannot do for itself: a window, a menu-bar icon, message boxes and
notifications, the clipboard, Finder, the login item, the Keychain, and keeping the Mac awake.

```
src-tauri/        the shell, in Rust: the window and its pin, main as its one child, and what
                  main asks of a native app
src/main/         main: the store, the scheduler, the runs, the tools, and the page server the
                  window loads (AGENTS.md has the map)
src/renderer/     the page: React over a Phaser scene, reaching main through `globalThis.appBridge`
src/shared/       what main and the page share: the channels, their schemas, the routes, the domain
src/dev-host/     main as the shell runs it, for a browser: `pnpm dev:browser` and e2e
```

## Main is the shell's child, over its stdio

The shell starts main on node (`src-tauri/src/main_process.rs`) and speaks JSON-RPC 2.0 to it over
its stdio, one message a line, with requests both ways (`src-tauri/src/relay.rs`;
`src/main/relay/` is main's end). Main's stdout carries the protocol alone: anything else main or a
library writes there is moved to stderr, which the shell appends, stamped, to `main.log`.

- The shell says `hello` first, with what only it knows: the resources folder (the skills and the
  employee sheets), the built page, under `tauri dev` the dev server's address, whether the login
  item launched it, and the Keychain's password. Main boots on it; a hello that fails says where
  the log is, in a box, and the app quits.
- The shell asks main for a `handoff` each time it makes the window: a one-time link into main's
  page (below).
- Main asks the shell (`src/main/host.ts`, answered in `src-tauri/src/host.rs`): a message box, the
  clipboard, opening a URL, a file or a folder, the login item; and tells it the menu-bar icon's
  model, a notification, whether to keep the Mac awake, and to relaunch after a reset.
- A quit asks main to stop its runs (`quit`), then closes its stdin, then waits; a main that has
  not exited five seconds later is killed with its process group. Main's stdin is also its
  lifeline: a shell that crashed or was killed ends main too, after its runs. Main leads a process
  group of its own, so a Ctrl-C under `tauri dev` reaches the shell alone, which stops main once.
  There is no restart: main owns the save, and a second one under a first that has not let go
  would race it.

## The window is main's own page

One window, over the page main serves on loopback (`src/main/page-server.ts`), as kyh/inteligir's
window is its server's page. The shell asks main for a handoff and opens the window on it: a
one-time link, spent at its first use and dead unspent after five minutes, whose answer sets the
page's session cookie (HttpOnly, SameSite=Strict, a secret minted per boot) and drops the nonce from
the address (`src/main/page-session.ts`). The page then calls main (`POST /__idlebiz/invoke`) and
hears its events (a server-sent stream, `/__idlebiz/events`) on its own origin
(`src/renderer/install-bridge.ts`), and reaches no Tauri command: no capability grants it one, and
`removeUnusedCommands` leaves none in the binary.

The founder's approve button is on that port, so:

- the seal closes it to every employee run, beside the debug ports (`src/main/agents/seal.ts`);
- main answers only a request naming 127.0.0.1 or localhost at its own port: any other name is a
  page that rebound its own onto loopback;
- main's calls and events need the session and the page's own origin (`Sec-Fetch-Site`, else
  `Origin`): another loopback port is the same site, and carries the cookie;
- the page's content security policy is main's (`src/shared/page-policy.ts`), on the document.

The window is pinned to main's origin, compared by its parts: a link to any other web page opens
in the browser, `window.open` makes no second window, and every device permission is refused
(`src-tauri/src/window.rs`). Closing it hides it and the dock icon: the office keeps working in the
menu bar, and Open brings the same page back, or makes it on a fresh handoff when a launch at login
never did. Each boot binds a port of its own, so nothing of the page is kept between boots
(`no-store`), and the page keeps nothing in the browser's storage.

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
pnpm dev:browser   # the same page and main in a browser, at http://localhost:31100/
```

Both need main built, which the dev server does before it serves the page and again on each change
(`vite.config.ts`). `tauri dev` relaunches the shell when main changes (its watcher skips what
`.gitignore` names, so `.taurignore` brings `.output/main` back); `dev:browser` restarts main
itself. Either way the page stays main's: main hands it Vite's files, so it hot-reloads on main's
origin, and its hot-reload socket dials Vite directly. `/` on the dev server is `dev:browser`'s way
in: each visit asks the main running then for a handoff, so the one address outlives a restart of
main, whose page moves to a new port. The browser is the surface automation drives: WKWebView takes
no WebDriver on the Mac. The seal closes the dev server's port to every employee run as well: Vite
reads any file of the checkout to whoever asks (`/@fs`), and under `dev:browser` signs a browser
in.

The shell compiles on the toolchain `rust-toolchain.toml` pins: `pnpm typecheck` runs clippy
(pedantic, `-D warnings`), `pnpm test` runs `cargo test` after vitest, `pnpm format` runs
`cargo fmt --check`. On Linux the shell needs WebKitGTK (`libwebkit2gtk-4.1-dev`) and the
appindicator for its menu-bar icon (`libayatana-appindicator3-dev`).

## Packaging

`pnpm -F @repo/desktop package`, on a Mac (`scripts/package.ts`):

1. fetches the node the app runs main on, pinned by sha-256 (`scripts/fetch-node.ts`), into
   `src-tauri/binaries/` (`bundle.externalBin`, beside the shell in `Contents/MacOS`) with its
   licence for `Contents/Resources/notices/node`;
2. builds the page and main, and stages main with its production dependencies (the ACP adapters,
   sharp) by `pnpm deploy`, the workspace's patches applied (`scripts/stage-main.ts`), into
   `Contents/Resources/main`, and the page main serves into `Contents/Resources/page`;
3. signs every Mach-O those dependencies carry with the hardened runtime and the app's
   entitlements (`scripts/sign-resources.ts`), since notarization refuses an unsigned one inside;
4. writes the licences of the Rust crates the shell links (`scripts/rust-notices.ts`) to
   `Contents/Resources/notices`;
5. runs `tauri build` with a config of its own (the resources, the sidecar, the signing identity,
   macOS 13.5 as the floor, node 24's), and copies the dmg to `.output/bin`.

It signs with the Developer ID the keychain holds (`APPLE_SIGNING_IDENTITY` names another; with
none it stops, unless `IDLEBIZ_PACK_UNSIGNED=1` asks for an ad-hoc pack, for this Mac alone) and
notarizes with `apps/desktop/.env`'s App Store Connect key, or says it did not when `.env` names
none. `pnpm -F @repo/desktop release:publish` packs as a release (`IDLEBIZ_RELEASE=1`), which
stops unless the pack is both signed and notarized, then publishes the dmg as the release tagged
`v<version>`, where the site's download link finds it.

## What is deliberately not here

- **No updater.** The Electron builds shipped none either; a feed is Tauri's updater plugin and a
  signing key of its own, as kyh/inteligir's.
- **No WebDriver of the window.** The page and main are driven in Chromium (e2e, the dev host);
  the shell is held by `cargo test` and looked at by hand.
- **No restart of main.** A main that dies says so in a box and the app quits: main owns the save.
