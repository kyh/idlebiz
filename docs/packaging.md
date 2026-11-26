# Packaging and release

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

```sh
pnpm -F @repo/desktop package               # build, sign, notarize → apps/desktop/.output/bin/*.dmg
pnpm -F @repo/desktop release:publish       # the same as a release, then published to GitHub
IDLEBIZ_PACK_UNSIGNED=1 pnpm smoke:desktop  # an ad-hoc pack, booted on a scratch save
pnpm smoke:update                           # two test packs, the installed one updating itself
```

`package` packs the app on a Mac with Xcode's command line tools
(`apps/desktop/scripts/package.ts`), through electron-builder's API:

1. it fetches the node the app runs main on, pinned by sha-256 (`scripts/fetch-node.ts`), into
   `.cache/bundled-node/node`, which goes beside the shell in `Contents/MacOS` (`extraFiles`), with
   its licence for `Contents/Resources/notices/node`;
2. builds the page, the shell (electron-vite, into `.output/app`, which goes in `app.asar`) and the
   server, and stages the `idlebiz` package with `pnpm deploy`, the workspace's patches applied
   (`scripts/stage-server.ts`), into `Contents/Resources/server`: its bundle (the page staged inside
   it), its `resources/`, and the dependencies it does not bundle, the ACP adapters main spawns
   (they bring their own zod and ACP sdk);
3. signs every Mach-O those dependencies carry with the hardened runtime and the app's
   entitlements (`scripts/sign-resources.ts`), since notarization refuses an unsigned one inside;
4. writes the licences of the npm packages the shell bundles (vite's `build.license`) to
   `Contents/Resources/notices/shell-packages.md`, beside Electron's and Chromium's own, which
   electron-builder puts in the bundle;
5. runs electron-builder (the resources, node, the signing identity, the fuses, macOS 13.5 as the
   floor, node 24's, which the page's build targets as Safari 16.6) and copies the .app and the dmg
   to `.output/bin`.

The fuses turn off what would let a launch run other code as the app: `ELECTRON_RUN_AS_NODE`,
`NODE_OPTIONS`, `--inspect`, and any app code but the `app.asar` whose integrity the bundle
records; and since no page loads from `file://`, none gets its old extra privileges. Cookie encryption stays off: Chromium would keep its key in the login keychain, readable
with no prompt only by the build that wrote it, so each pack a smoke makes would leave one behind
for the next build to prompt over, and the window's one cookie is the session main mints each boot.

So `apps/cli` `dependencies` is exactly what the server ships: everything Vite bundles — zod,
oRPC, citty, the ACP sdk, `@repo/*` — goes in `devDependencies`, or the app ships it for nothing.
`apps/desktop`'s one dependency is `@napi-rs/keyring`, the native module the shell reads the
Keychain with, which electron-builder ships in the bundle; the page and the rest of the shell are
bundled whole. `pnpm add` defaults to `dependencies`.

It signs with the keychain's Developer ID (`APPLE_SIGNING_IDENTITY` names another; with none it
stops, unless `IDLEBIZ_PACK_UNSIGNED=1` asks for an ad-hoc pack, for this Mac alone) and notarizes
the app and the dmg when the root `.env` names the notary key by the id and issuer of its App
Store Connect key (see `.env.example`), saying it did not when `.env` names none. The key's `.p8`
sits in `~/.appstoreconnect/private_keys/` (`package.ts` reads it there alone), which the sandbox
keeps from every run; never keep it in the checkout, which runs can read. `package.ts` drops every
signing and notary variable electron-builder would read from its own env (`CSC_*`, `APPLE_*`) and
sets only what it decided. `release:publish` packs as a release (`IDLEBIZ_RELEASE=1`), which stops
unless the pack is both signed and notarized, then publishes the dmg as the release tagged
`v<version>`, where the site's download link finds it, so bump `version` in
`apps/desktop/package.json` and `apps/cli/package.json` together first.

A release is also one the installed app can update from ("Updates" in
[The page, the shell and main](app.md#the-page-the-shell-and-main)). Only a release names the feed:
electron-builder writes `Contents/Resources/app-update.yml` (GitHub, `kyh/idlebiz`) into it, and
beside it the zip electron-updater installs (`IdleBiz-<version>-arm64-mac.zip`), its blockmap and
`latest-mac.yml`, which names the zip with its SHA-512. Squirrel.Mac installs an update only when it
is signed by the identity the installed app is, so the Developer ID is the update key: whoever holds
it ships code to every install, and losing it strands every install on its version until the founder
downloads the app again. The release publishes the dmg, the zip, its blockmap and the feed as a
draft, and makes it public and latest only once all four are up (`scripts/publish-release.sh`). The
privacy policy (`apps/web/src/lib/agent/site-content.ts`) tells the founder what each check shows
GitHub, so a check that sends more changes the policy in the same commit.

A test pack (`IDLEBIZ_PACK_UPDATE_TEST=<spec.json>`, `scripts/update-test-pack.ts`) is one an update
is tested on: its spec names a version, a feed at `http://127.0.0.1:<port>/latest-mac.yml`, a
throwaway signing identity (its SHA-1) and the scratch keychain that holds it, and the save it opens.
`package.ts` packs it unsigned into `.output/update-test`, apart from every other pack, writes its
`app-update.yml` naming the loopback feed, signs it whole as the throwaway identity, and leaves the
.app, and with `archive` its zip and feed, in the spec's `outDir`. The save is baked into its shell
(`IDLEBIZ_TEST_PACK_ROOT`, read by `electron.vite.config.ts` at build time and by no build but a test
pack's), since ShipIt relaunches an update with no arguments and so drops `--root=`. It is refused as
a release, with an identity macOS trusts to sign code (one `security find-identity -v` lists, as a
Developer ID is), on a feed off loopback, with a keychain, save or folder outside scratch (the
system's temporary folder, from `getconf`, since TMPDIR is what `launchctl setenv` could point
anywhere) or in the checkout, with its folder in `/Applications` or `~/Applications` whatever
scratch is, or with `.output/bin` as its folder: its feed is plain http and its identity's key has
no password, so either in a release would let whoever answers that port or holds that key ship code
to every install. The feed and save go in at pack time and never at runtime, since a switch the
installed app read could be set by `launchctl setenv` and re-point the founder's updates or save.
While the variable is set, `pnpm -F @repo/desktop smoke` boots only a .app it is named, since a
test pack leaves `.output/bin`'s as it was.

`pnpm smoke:desktop` packs, then boots the .app on a scratch save it names with `--root=` (the
packaged app takes no `IDLEBIZ_ROOT_DIR`), under an env poisoned as `launchctl setenv` could
poison launchd's (`apps/desktop/scripts/smoke-packaged.ts`;
`pnpm -F @repo/desktop smoke <path/to/IdleBiz.app>` boots another, a release's from its dmg): the
pack carries every file the server ships under `resources/` (the skills, which main reads only
once a company hires and runs) and the licences, hello boots main on the pack's node, main starts
on the account's HOME, SHELL, USER, LOGNAME and TMPDIR, the system PATH and the save `--root=`
names, with none of what the shell drops (its starting env, read with `ps -E`), the shell writes
the account's `main.log`, the window loads main's page (the shell prints
`[shell] window loaded`), main answers that page on loopback signed out to anything without a
handoff, a second launch hands over to the first (Electron's single-instance socket, in the app's
`~/Library/Application Support/IdleBiz`), and a SIGTERM quits as Quit does, leaving nothing main
started running, and nothing the poisoned env named was run or made. That env names a decoy save,
another TMPDIR, a `ZDOTDIR`, a runner's home and model address, a CA, test money counted and an
`OPENSSL_CONF`, and a shell, a CLI and a PATH whose programs leave a mark when run, as the
`ZDOTDIR`'s startup file does; it leaves HOME alone, since the shell's own Keychain read may follow
it. It refuses where an IdleBiz is running or the Keychain holds any of IdleBiz's keys, which an
ad-hoc pack would wait on a prompt to read, so on a Mac that runs IdleBiz it stops before it
launches anything. The shell must say it read the empty vault at hello, and a key a launch wrote is
deleted as the smoke ends and fails it, since kept it would stop the next smoke and prompt the first
IdleBiz installed after. CI's `test-macos` job runs it on an ad-hoc pack.

`pnpm smoke:update` holds an update end to end, on an Apple-silicon Mac whose terminal may drive
System Events (`apps/desktop/scripts/smoke-update.ts`), in these steps:

1. it serves a feed on loopback for the whole run and makes throwaway code-signing identities, a
   self-signed certificate each, in a keychain of its own in scratch (`scripts/test-identity.ts`),
   on the search list only while it signs: the packs' identity, when it packs afresh, and another
   neither pack is, every run. Scratch is the system's temporary folder (`getconf`), which
   `package.ts` holds a test pack to;
2. it packs N, the version in package.json, and then N+1 as test packs, both asking that feed,
   signed as the packs' identity and carrying the save beside them; `--packs=<dir>` packs into
   `<dir>` once and reuses what it holds after;
3. it installs N with `ditto` into a scratch `Applications`, which the account writes, so ShipIt
   asks for no admin password, and seeds its save: Acme founded through the store with a $0 cap and
   autopilot off (`server/test-support/seed-save.seed.ts`, run under
   `apps/cli/vitest.seed.config.ts` alone, which `pnpm test` never runs);
4. it launches N with `--root=` and the system PATH, so the shell's `touch` guard holds, and begins
   the update the founder's way, from the menu-bar item (`scripts/tray-ax.ts`), since the page's
   session is the shell's alone and the app takes no switch that installs: a click posted at the
   item opens its menu, and System Events reads the menu and clicks its update item;
5. it offers a copy of N+1 re-signed as the other identity first, which Squirrel.Mac refuses, in a
   box that says it could not be downloaded (UserNotificationCenter draws the shell's boxes, which
   have no parent window, so the smoke reads that process's windows too), with main and the
   installed version as they were, then the release as packed, which stops main cleanly and which
   ShipIt swaps in and relaunches with no arguments, on the save the pack carries;
6. it checks N+1, reading the relaunched shell's lines from `main.log`, since ShipIt starts it
   apart from the smoke: the update's Info.plist, shell bytes, server version and signature
   (`codesign --verify --deep --strict`), one new main on the same save, a check that finds itself
   current, Open Acme in its menu, the shell's word that it read the vault's one key, and the save
   as N left it, but for `.main/`, `company/state/` and what was appended to each `*.jsonl`, which
   main moves itself;
7. it quits it, leaving nothing running, deletes both keychains and puts the search list back, and
   leaves every request the feed answered in `.output/smoke-update/feed.log`.

The packs' code identity is their certificate, but the vault's item reads by cdhash, which the
update changes, so a keychain of the smoke's own in scratch, first on the search list while it
runs, holds one team value as a vault item with a partition list naming both packs' cdhashes
(`scripts/update-keychain.ts`), and a Keychain prompt fails the run at once. It refuses where an
IdleBiz is running or the Keychain holds any of IdleBiz's keys, both as it starts and again once it
has packed, so a key it finds in the user's keychains as it ends is one a launch wrote, which it
deletes, never a founder's; and it refuses a search list a run killed outright left either keychain
on. It puts the list back on a throw or a signal alike. CI's `update-macos` job runs it, and uploads
the feed's log, ShipIt's and `main.log` when it fails.
