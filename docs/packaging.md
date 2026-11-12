# Packaging and release

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

```sh
pnpm -F @repo/desktop package               # build, sign, notarize → apps/desktop/.output/bin/*.dmg
pnpm -F @repo/desktop release:publish       # the same as a release, then published to GitHub
IDLEBIZ_PACK_UNSIGNED=1 pnpm smoke:desktop  # an ad-hoc pack, booted on a scratch save
IDLEBIZ_PACK_UNSIGNED=1 pnpm smoke:update   # two test packs, the installed one updating itself
```

`package` packs the app on a Mac with Xcode's command line tools and the Rust toolchain
(`apps/desktop/scripts/package.ts`):

1. it fetches the node the app runs main on, pinned by sha-256 (`scripts/fetch-node.ts`), into
   `src-tauri/binaries/` (`bundle.externalBin`, beside the shell in `Contents/MacOS`), with its
   licence for `Contents/Resources/notices/node`;
2. builds the page and the server, and stages the `idlebiz` package with `pnpm deploy`, the
   workspace's patches applied (`scripts/stage-server.ts`), into `Contents/Resources/server`: its
   bundle (the page staged inside it), its `resources/`, and the dependencies it does not bundle,
   the ACP adapters main spawns (they bring their own zod and ACP sdk);
3. signs every Mach-O those dependencies carry with the hardened runtime and the app's
   entitlements (`scripts/sign-resources.ts`), since notarization refuses an unsigned one inside;
4. writes the licences of the Rust crates the shell links (`scripts/rust-notices.ts`) to
   `Contents/Resources/notices`;
5. runs `tauri build` with a config of its own (the resources, the sidecar, the signing identity,
   macOS 13.5 as the floor, node 24's, which the page's build targets as Safari 16.6) and copies
   the dmg to `.output/bin`.

So `apps/cli` `dependencies` is exactly what the server ships: everything Vite bundles — zod,
oRPC, citty, the ACP sdk, `@repo/*` — goes in `devDependencies`, or the app ships it for nothing,
and `apps/desktop` has no `dependencies` at all, since the page is bundled whole. `pnpm add`
defaults to `dependencies`.

It signs with the keychain's Developer ID (`APPLE_SIGNING_IDENTITY` names another; with none it
stops, unless `IDLEBIZ_PACK_UNSIGNED=1` asks for an ad-hoc pack, for this Mac alone) and notarizes
when `apps/desktop/.env` names the notary key by the id and issuer of its App Store Connect key
(see `.env.example`), saying it did not when `.env` names none. The key's `.p8` sits in
`~/.appstoreconnect/private_keys/` (`package.ts` reads it there alone), which the sandbox keeps from
every run; never keep it in the checkout, which runs can read. `release:publish` packs as a
release (`IDLEBIZ_RELEASE=1`), which stops unless the pack is both signed and notarized, then
publishes the dmg as the release tagged `v<version>`, where the site's download link finds it, so
bump `version` in `apps/desktop/package.json` and `apps/cli/package.json` together first.

A release is also one the installed app can update from ("Updates" in
[The page, the shell and main](app.md#the-page-the-shell-and-main)). It signs the updater's archive
(`IdleBiz-<version>-arm64.app.tar.gz`) with `~/.tauri/idlebiz.key`, made once with
`pnpm -F @repo/desktop tauri signer generate -w ~/.tauri/idlebiz.key`, whose password is `.env`'s
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=` line, empty for a key made without one, and whose public half
is tauri.conf.json's `plugins.updater.pubkey`: a release stops while that public half is empty, the
key is missing or `.env` lacks the line, and no other pack signs with that key (a test pack that is
the update signs with a throwaway key of its own, below). That public half is also
what turns the checks on, since a build packed without it asks GitHub for nothing, and the privacy
policy (`apps/web/src/lib/agent/site-content.ts`) tells the founder what each check shows GitHub:
that text is live on the site before the first release that sets the key, and an endpoint naming
`{{current_version}}`, which would send the version, changes the policy in the same commit. The sandbox
keeps `~/.tauri` from every run, as it keeps the notary key: whoever holds the key ships code to
every install. Keep an offline copy of the key and its password: lose either and no installed app
takes another update, since a new key reaches an install only by the founder downloading the app
again. The pack writes `latest.json`, the feed, naming the archive's URL in the release and its
signature (`scripts/release-feed.ts`, held by its test to the endpoint and to what publishing
uploads), and the release publishes the dmg, the archive and the feed, becoming the latest only once
all three are up.

A test pack (`IDLEBIZ_PACK_UPDATE_TEST=<spec.json>`, `scripts/update-test-pack.ts`) is one an update
is tested on: its spec names a version, a feed at `http://127.0.0.1:<port>/latest.json` and the
`pubkey` its updates are checked against, the public half of a throwaway key made in scratch, which
`package.ts` writes into that pack's config alone. When the pack is the update (`archive`), the spec
also names that throwaway `key`, which signs its archive at pack time and goes in no config. It
builds from `.output/update-test` into `src-tauri/target/update-test`, apart from every other pack,
and leaves its .app, and with `archive` its signed archive and feed, in the spec's `outDir`. It is
refused as a release, as a signed pack, on a feed off loopback, with a key or folder outside
scratch (the system's temporary folder, from `getconf`, since TMPDIR is what `launchctl setenv`
could point anywhere), with its folder in `/Applications` or `~/Applications` whatever scratch is,
with a key beside
`~/.tauri/idlebiz.key` or in the checkout, with tauri.conf.json's public key however it is encoded,
or with `.output/bin` as its folder, and an archive whose signature carries the release key's ID is
removed and stops the pack, however that key was reached: its feed is plain http and its key has no
password, so either in a release would let whoever answers that port or holds that key ship code to
every install. The feed and key go in at pack time and never at runtime, since a switch the
installed app read could be set by `launchctl setenv` and re-point the founder's updates. While the
variable is set, `pnpm -F @repo/desktop smoke` boots only a .app it is named, since a test pack
leaves `src-tauri/target/release`'s as it was.

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
handoff, a second launch hands over to the first, and a SIGTERM quits as Quit does, leaving
nothing main started running, and nothing the poisoned env named was run or made. That env names
a decoy save, another TMPDIR, a `ZDOTDIR`, a runner's home and model address, a CA, test money
counted and an `OPENSSL_CONF`, and a shell, a CLI and a PATH whose programs leave a mark when run,
as the `ZDOTDIR`'s startup file does; it leaves HOME alone, since the shell's own Keychain read
may follow it. It refuses where an IdleBiz is running or the Keychain holds any of IdleBiz's keys,
which an ad-hoc pack would wait on a prompt to read, so on a Mac that runs IdleBiz it stops before
it launches anything. The shell must say it read the empty vault at hello, and a key a launch wrote
is deleted as the smoke ends and fails it, since kept it would stop the next smoke and prompt the
first IdleBiz installed after. CI's `test-macos` job runs it on an ad-hoc pack.

`pnpm smoke:update` holds an update end to end, on an Apple-silicon Mac whose terminal may drive
System Events (`apps/desktop/scripts/smoke-update.ts`), in these steps:

1. it serves a feed on loopback for the whole run and makes throwaway keys in scratch with
   `tauri signer generate`: the packs' key, when it packs afresh, and an untrusted one every run.
   Scratch is the system's temporary folder (`getconf`), which `package.ts` holds a test pack to;
2. it packs N, the version in package.json, and then N+1 as test packs, both asking that feed and
   trusting the packs' key; `--packs=<dir>` packs into `<dir>` once and reuses what it holds after;
3. it installs N with `ditto` into a scratch `Applications`, which the account writes, so the swap
   asks for no admin password, and seeds its save: Acme founded through the store with a $0 cap and
   autopilot off (`server/test-support/seed-save.seed.ts`, run under
   `apps/cli/vitest.seed.config.ts` alone, which `pnpm test` never runs);
4. it launches N with `--root=` and the system PATH, so the shell's `touch` guard holds, and begins
   the update the founder's way, from the menu-bar item (`scripts/tray-ax.ts`), since the page's
   session is the shell's alone and the app takes no switch that installs: a click posted at the
   item opens its menu (tray-icon gives the item its menu only while it handles a real
   mouse-down), and System Events reads the menu and clicks its update item;
5. it offers a release signed by the untrusted key first, which is refused in a box that says it
   could not be downloaded (UserNotificationCenter draws the shell's boxes, which have no parent
   window, so the smoke reads that process's windows too), with main and the installed version as
   they were, then the release as packed, which stops main cleanly, swaps the app and restarts it
   on the same `--root=`;
6. it checks N+1: the update's Info.plist, shell bytes, server version and signature
   (`codesign --verify --deep --strict`), one new main on the same save, a check that finds itself
   current, Open Acme in its menu, the shell's word that it read the vault's one key, and the save as N left
   it, but for `.main/`, `company/state/` and what was appended to each `*.jsonl`, which main moves
   itself;
7. it quits it, leaving nothing running and no `tauri_*_app` swap folder behind, puts the Keychain's
   search list back, and leaves every request the feed answered in `.output/smoke-update/feed.log`.

An ad-hoc pack's code identity is its cdhash, which the update changes, so a keychain of the
smoke's own in scratch, first on the search list while it runs, holds one team value as a vault
item with a partition list naming both packs' cdhashes (`scripts/update-keychain.ts`), as one
Developer ID's would, and a Keychain prompt fails the run at once. It refuses where an IdleBiz is
running or the Keychain holds any of IdleBiz's keys, both as it starts and again once it has
packed, so a key it finds in the user's keychains as it ends is one a launch wrote, which it
deletes, never a founder's; and it
refuses a search list a run killed outright left its keychain on. It puts the list back on a throw
or a signal alike. CI's `update-macos` job runs it, and uploads the feed's log and `main.log` when
it fails.
