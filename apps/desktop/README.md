# @repo/desktop — the game

A Tauri 2 app: a Rust shell over the system's own WebKit (WKWebView on the Mac), which runs
**main** — `idlebiz serve`, the server `apps/cli` builds, the node process that owns the save, the
keys and the runs — on the node it ships beside itself (issue #60), and shows the office page main
serves. The shell holds no game state; everything here that is not the page is what a page cannot
do for itself: a window, a menu-bar icon, message boxes and notifications, the clipboard, Finder,
the login item, the Keychain, and keeping the Mac awake. The two programs are laid out as
kyh/inteligir's are: this one is the app, `apps/cli` the server and the binary.

```
src-tauri/        the shell, in Rust: the window and its pin, main as its one child, and what
                  main asks of a native app
src/renderer/     the page: React over a Phaser scene, calling main through `api`, the client
                  of the oRPC contract in packages/contract (`api.ts`, `page-events.ts`)
scripts/          the pack: node, the server staged, signing, notices, the dmg, the release
```

Main itself — the store, the scheduler, the runs, the tools and the page server the window loads
— is `apps/cli/src/server` (AGENTS.md has the map), and `apps/cli/src/dev-host` runs it as the
shell does, for a browser: `pnpm dev:browser` and e2e.

## Main is the shell's child, over its stdio

The shell starts main on node (`src-tauri/src/main_process.rs`): `node <server>/dist/index.js
serve`, where `<server>` is `Contents/Resources/server` in the .app and `apps/cli` in a checkout
(`src-tauri/src/runtime.rs`). It speaks JSON-RPC 2.0 to main over its stdio, one message a line,
with requests both ways (`src-tauri/src/relay.rs`; `apps/cli/src/server/relay/` is main's end). Main's stdout carries the protocol alone: anything else main or a
library writes there is moved to stderr, which the shell appends, stamped, to `main.log`.

- The shell says `hello` first, with what only it knows: whether it is the packaged app, under
  `tauri dev` the dev server's address, whether the login item launched it, and the Keychain's
  sealing key. Main finds its own files beside itself (the skills and the employee sheets in
  `resources/`, the built page in `dist/page`). Main boots on the hello; one that fails says where
  the log is, in a box, and the app quits. So does one that has not booted within a minute,
  killed with its process group first: its quit would wait the stuck boot out.
- The shell asks main for a `handoff` each time it makes the window, and waits ten seconds for
  it: a one-time link into main's page (below).
- Main asks the shell (`apps/cli/src/server/host.ts`, answered in `src-tauri/src/host.rs`): a message box, the
  clipboard, opening a URL, a file or a folder, the login item; and tells it the menu-bar icon's
  model, a notification, whether to keep the Mac awake, and to relaunch after a reset.
- Every method either way and its shape is named once on each end, `RELAY_METHODS` and its zod
  schemas in `host.ts`, the consts and serde types in `src-tauri/src/protocol.rs`, and both are
  pinned to one sample a method in `src-tauri/tests/fixtures/relay/`: main's tests parse each, and
  `cargo test` reads each into the shell's types and back. Both ends refuse a field they do not
  know. A notification the shell cannot read goes to its stderr, and under `tauri dev` to a box
  too, once a method: main waits on no answer, so would never hear of it.
- A quit asks main to stop its runs (`quit`) and waits up to 45 seconds for the answer, then
  closes its stdin, then waits; a main that has not exited five seconds later is killed with its
  process group. Main's stdin is also its lifeline: a shell that crashed or was killed ends main
  too, after its runs. Main leads a process group of its own, so a Ctrl-C under `tauri dev`
  reaches the shell alone, which stops main once.
  There is no restart: main owns the save, and a second one under a first that has not let go
  would be refused it (`apps/cli/src/server/save-claim.ts`).

## The window is main's own page

One window, over the page main serves on loopback (`apps/cli/src/server/page-server.ts`), as kyh/inteligir's
window is its server's page. The shell asks main for a handoff and opens the window on it: a
one-time link, spent at its first use and dead unspent after five minutes, whose answer sets the
page's session cookie (HttpOnly, SameSite=Strict, a secret minted per boot) and drops the nonce from
the address (`apps/cli/src/server/page-session.ts`). The page then calls main over its oRPC
contract (under `/rpc`), its event stream among them, on its own origin (`src/renderer/api.ts`,
`src/renderer/page-events.ts`), and reaches no Tauri command: no capability grants it one, and
`removeUnusedCommands` leaves none in the binary.

The founder's approve button is on that port, so:

- the seal closes it to every employee run, beside the debug ports
  (`apps/cli/src/server/agents/seal.ts`), whose own way in is the control plane, as
  `idlebiz <tool>`;
- main answers only a request naming 127.0.0.1 or localhost at its own port: any other name is a
  page that rebound its own onto loopback;
- main's calls and events need the session and the page's own origin (`Sec-Fetch-Site`, else
  `Origin`): another loopback port is the same site, and carries the cookie;
- the page's content security policy is main's (`packages/contract/src/page-policy.ts`), on the
  document.

The window is pinned to main's origin, compared by its parts: a link to any other web page opens
in the browser, `window.open` makes no second window, and every device permission is refused
(`src-tauri/src/window.rs`). Closing it hides it and the dock icon: the office keeps working in the
menu bar, and Open brings the same page back, or makes it on a fresh handoff when a launch at login
never did. Each boot binds a port of its own, so nothing of the page is kept between boots
(`no-store`), and the page keeps nothing in the browser's storage.

## The Keychain

`secrets.json`'s values are sealed with a key the Keychain keeps for IdleBiz: 32 random bytes,
base64, under service "IdleBiz" and account "sealing-key", made on the first launch that finds
none (`src-tauri/src/keychain.rs`). The shell reads it with no prompt, being the signed app that
made it, and hands it to main at hello; main seals each value with AES-256-GCM, bound to the key's
name (`apps/cli/src/server/secrets.ts`). Main never reaches the Keychain. A development shell hands
no key and never touches the Keychain: main seals a dev save with a fixed key of its own.

## Running it

```sh
pnpm dev:desktop   # tauri dev: the window, the page hot-reloaded, main rebuilt and restarted
pnpm dev:browser   # the same page and main in a browser, at http://localhost:31100/
```

Both need main built, which the dev server does before it serves the page and again on each change
(`vite.config.ts` watch-builds `apps/cli`). `tauri dev` relaunches the shell when main's bundle
changes (`--additional-watch-folders ../cli/dist`; its watcher skips what `.gitignore` names, so
`apps/cli/.taurignore` brings `dist/` back); `dev:browser` restarts main itself. Either way the page stays main's: main hands it Vite's files, so it hot-reloads on main's
origin, and its hot-reload socket dials Vite directly. `/` on the dev server is `dev:browser`'s way
in: each visit asks the main running then for a handoff, so the one address outlives a restart of
main, whose page moves to a new port. The browser is the surface automation drives: WKWebView takes
no WebDriver on the Mac. The seal closes the dev server's port to every employee run as well: Vite
reads any file of the checkout to whoever asks (`/@fs`), and under `dev:browser` signs a browser
in.

The shell compiles on the toolchain `rust-toolchain.toml` pins: `pnpm typecheck` runs clippy
(pedantic, `-D warnings`), `pnpm test:rust` runs `cargo test` (`pnpm test` is vitest; the root's
runs both), `pnpm format` runs `cargo fmt --check`. On Linux the shell needs WebKitGTK (`libwebkit2gtk-4.1-dev`) and the
appindicator for its menu-bar icon (`libayatana-appindicator3-dev`).

## Packaging

`pnpm -F @repo/desktop package`, on a Mac (`scripts/package.ts`):

1. fetches the node the app runs main on, pinned by sha-256 (`scripts/fetch-node.ts`), into
   `src-tauri/binaries/` (`bundle.externalBin`, beside the shell in `Contents/MacOS`) with its
   licence for `Contents/Resources/notices/node`;
2. builds the page and the server, and stages the `idlebiz` package — its bundle with the page
   inside it, its `resources/` and its production dependencies (the ACP adapters, sharp) — by
   `pnpm deploy`, the workspace's patches applied (`scripts/stage-server.ts`), into
   `Contents/Resources/server`;
3. signs every Mach-O those dependencies carry with the hardened runtime and the app's
   entitlements (`scripts/sign-resources.ts`), since notarization refuses an unsigned one inside;
4. writes the licences of the Rust crates the shell links (`scripts/rust-notices.ts`) to
   `Contents/Resources/notices`;
5. runs `tauri build` with a config of its own (the resources, the sidecar, the signing identity,
   macOS 13.5 as the floor, node 24's), and copies the dmg to `.output/bin`.

It signs with the Developer ID the keychain holds (`APPLE_SIGNING_IDENTITY` names another; with
none it stops, unless `IDLEBIZ_PACK_UNSIGNED=1` asks for an ad-hoc pack, for this Mac alone) and
notarizes with the App Store Connect key `apps/desktop/.env` names by id and issuer, its `.p8` in
`~/.appstoreconnect/private_keys/` where the seal keeps it from every run, or says it did not
when `.env` names none. `pnpm -F @repo/desktop release:publish` packs as a release
(`IDLEBIZ_RELEASE=1`), which stops unless the pack is both signed and notarized, then publishes
the dmg as the release tagged `v<version>`, where the site's download link finds it.

`pnpm smoke:desktop` packs, then boots the .app (`scripts/smoke-packaged.ts`; `pnpm -F
@repo/desktop smoke <path/to/IdleBiz.app>` boots another, a release's from its dmg). It checks that
the pack carries every file the server ships under `resources/` (the skills and the employee
sheets, which main reads only once a company hires and runs) and the licences, then launches it on
a scratch `IDLEBIZ_ROOT_DIR`: hello boots main on the pack's node, the window loads main's page
(the shell prints `[shell] window loaded`), main answers that page on loopback signed out to
anything without a handoff, a second launch hands over to the first, and a SIGTERM quits as Quit
does, leaving nothing main started running. It refuses where an IdleBiz is running, or where the
Keychain holds IdleBiz's key, which an ad-hoc pack is not the app to read without a prompt; a
launch where it holds none makes one, as a first launch does. CI's `test-macos` job runs it on an
ad-hoc pack (`IDLEBIZ_PACK_UNSIGNED=1`).

## What is deliberately not here

- **No updater.** The Electron builds shipped none either; a feed is Tauri's updater plugin and a
  signing key of its own, as kyh/inteligir's.
- **No WebDriver of the window.** The page and main are driven in Chromium (`tools/e2e`, the dev host);
  the shell is held by `cargo test`, booted packaged by `pnpm smoke:desktop`, and looked at by hand.
- **No restart of main.** A main that dies says so in a box and the app quits: main owns the save.
