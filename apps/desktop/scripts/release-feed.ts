/** The archive the installed app installs, as each release names it. */
export const archiveName = (version: string) => `IdleBiz-${version}-arm64.app.tar.gz`;

export const FEED_NAME = "latest.json";

/** Where `version`'s assets download from, given the feed: the latest release's `latest.json`. */
export const releaseAssets = (feed: string, version: string) => {
  const assets = feed.replace(
    /\/releases\/latest\/download\/latest\.json$/u,
    `/releases/download/v${version}`,
  );

  if (assets === feed) {
    throw new Error(`the updater's feed, ${feed}, is no GitHub release's latest.json`);
  }

  return assets;
};

interface Signed {
  version: string;
  /** The archive's `.sig`, as `tauri build` writes it. */
  signature: string;
  publishedAt: Date;
}

export interface Release extends Signed {
  /** The feed's own URL: a release's is tauri.conf.json's one `plugins.updater` endpoint. */
  feed: string;
}

/** A feed naming one Apple-silicon archive: where it downloads from, and its signature. */
export const feedFor = ({
  archiveUrl,
  version,
  signature,
  publishedAt,
}: Signed & { archiveUrl: string }) => ({
  platforms: {
    "darwin-aarch64": {
      signature: signature.trim(),
      url: archiveUrl,
    },
  },
  pub_date: publishedAt.toISOString(),
  version,
});

/** The feed for one release: its Apple-silicon archive's URL in the release, and its signature. */
export const releaseFeed = ({ feed, version, signature, publishedAt }: Release) =>
  feedFor({
    archiveUrl: `${releaseAssets(feed, version)}/${archiveName(version)}`,
    publishedAt,
    signature,
    version,
  });
