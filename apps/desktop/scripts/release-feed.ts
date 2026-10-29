// What the installed app updates from, beside the dmg in each release: the archive it installs, and
// the feed (src-tauri/tauri.conf.json's plugins.updater) naming it and its signature, the static
// JSON tauri-plugin-updater reads. Pure, so a test holds its shape without a release.

/** The archive the installed app installs, as each release names it. */
export const archiveName = (version: string): string => `IdleBiz-${version}-arm64.app.tar.gz`;

export const FEED_NAME = "latest.json";

/** Where `version`'s assets download from, given the feed: the latest release's `latest.json`. */
export const releaseAssets = (feed: string, version: string): string => {
  const assets = feed.replace(
    /\/releases\/latest\/download\/latest\.json$/u,
    `/releases/download/v${version}`,
  );
  if (assets === feed) {
    throw new Error(`the updater's feed, ${feed}, is no GitHub release's latest.json`);
  }
  return assets;
};

interface Release {
  /** tauri.conf.json's one `plugins.updater` endpoint. */
  feed: string;
  version: string;
  /** The archive's `.sig`, as `tauri build` writes it. */
  signature: string;
  publishedAt: Date;
}

/** The feed for one release: its Apple-silicon archive's URL in the release, and its signature. */
export const releaseFeed = ({ feed, version, signature, publishedAt }: Release) => ({
  platforms: {
    "darwin-aarch64": {
      signature: signature.trim(),
      url: `${releaseAssets(feed, version)}/${archiveName(version)}`,
    },
  },
  pub_date: publishedAt.toISOString(),
  version,
});
