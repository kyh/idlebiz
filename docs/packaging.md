# Packaging and release

Paths are short, as in [AGENTS.md](../AGENTS.md), and `CLAUDE.md` holds the decisions.

```sh
pnpm -F @repo/desktop package               # build, sign, notarize → apps/desktop/.output/bin/*.dmg
pnpm -F @repo/desktop release:publish       # the same as a release, then published to GitHub
IDLEBIZ_PACK_UNSIGNED=1 pnpm smoke:desktop  # an ad-hoc pack, booted on a scratch save
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
`~/.appstoreconnect/private_keys/` (`package.ts` reads it there alone), which the seal keeps from
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
`{{current_version}}`, which would send the version, changes the policy in the same commit. The seal
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
scratch (the OS's temporary folder, never where the app is installed), with a key beside
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
may follow it. It refuses where an IdleBiz is running or the Keychain holds IdleBiz's key, which
an ad-hoc pack would wait on a prompt to read, so on a Mac that runs IdleBiz it stops before it
launches anything. A launch where the Keychain holds none makes one, as a first launch does, and
the smoke deletes it as it ends, since kept it would stop the next smoke and prompt the first
IdleBiz installed after. CI's `test-macos` job runs it on an ad-hoc pack.
