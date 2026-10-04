#!/usr/bin/env bash
# Pack the signed, notarized app (`pnpm package`), then publish its dmg as the release tagged
# v<version>: a draft first, made public only once the dmg is up, so the site's download link
# never resolves a release with nothing to download.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." # -> apps/desktop

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

# The published build and release tag must match pushed HEAD.
if ! git merge-base --is-ancestor HEAD '@{upstream}' 2>/dev/null; then
  echo "HEAD isn't pushed to its upstream. Bump the version, commit, and push first." >&2
  exit 1
fi

# Porcelain lists untracked files too, and the build bundles those as well.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty; the build would not match ${TAG}. Commit or stash first." >&2
  exit 1
fi

# A reused version would ship another commit under a tag that already names one.
if gh release view "$TAG" >/dev/null 2>&1 ||
  git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "${TAG} already exists. Bump apps/desktop/package.json version, commit, push." >&2
  exit 1
fi

pnpm run package

gh release create "$TAG" \
  --draft \
  --target "$(git rev-parse HEAD)" \
  --title "IdleBiz ${TAG}" \
  --generate-notes

# A draft has no tag yet, so deleting it leaves nothing behind. Once the upload
# succeeds the draft is kept, so a failed un-draft can be finished by hand.
uploaded=""
cleanup() {
  if [ -z "$uploaded" ]; then
    echo "publish failed, removing the ${TAG} draft" >&2
    gh release delete "$TAG" --yes >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

gh release upload "$TAG" ".output/bin/IdleBiz-${VERSION}-arm64.dmg"
uploaded=1
gh release edit "$TAG" --draft=false --latest
echo "published ${TAG}: $(gh release view "$TAG" --json url -q .url)"
