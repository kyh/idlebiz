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
   macOS 13.5 as the floor, node 24's) and copies the dmg to `.output/bin`.

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
`pnpm -F @repo/desktop tauri signer generate -w ~/.tauri/idlebiz.key`, whose password, if it has
one, is `.env`'s `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and whose public half is tauri.conf.json's
`plugins.updater.pubkey`: a release stops while that is empty or the key is missing, and no other
pack signs anything. The seal keeps `~/.tauri` from every run, as it keeps the notary key: whoever
holds the key ships code to every install. Keep an offline copy of the key and its password: lose
either and no installed app takes another update, since a new key reaches an install only by the
founder downloading the app again. The pack writes `latest.json`, the feed, naming the
archive's URL in the release and its signature (`scripts/release-feed.ts`, held by its test to the
endpoint and to what publishing uploads), and the release publishes the dmg, the archive and
the feed, becoming the latest only once all three are up.

`pnpm smoke:desktop` packs, then boots the .app on a scratch `IDLEBIZ_ROOT_DIR`
(`apps/desktop/scripts/smoke-packaged.ts`; `pnpm -F @repo/desktop smoke <path/to/IdleBiz.app>`
boots another, a release's from its dmg): the pack carries every file the server ships under
`resources/` (the skills, which main reads only once a company hires and runs) and the licences,
hello boots main on the pack's node, the window loads main's page (the shell prints
`[shell] window loaded`), main answers that page on loopback signed out to anything without a
handoff, a second launch hands over to the first, and a SIGTERM quits as Quit does, leaving
nothing main started running. It refuses where an IdleBiz is running or the Keychain holds
IdleBiz's key, which an ad-hoc pack would wait on a prompt to read, so on a Mac that runs IdleBiz
it stops before it launches anything. A launch where the Keychain holds none makes one, as a first
launch does, and the smoke deletes it as it ends, since kept it would stop the next smoke and
prompt the first IdleBiz installed after. CI's `test-macos` job runs it on an ad-hoc pack.
