#!/usr/bin/env bash
# Pre-create one release so the dmg and zip publishers cannot race to create it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." # -> apps/desktop

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

# The published build and release tag must match pushed HEAD.
if ! git merge-base --is-ancestor HEAD '@{upstream}' 2>/dev/null; then
  echo "HEAD isn't pushed to its upstream. Bump the version, commit, and push first." >&2
  exit 1
fi

pnpm with-env electron-vite build

created_here=""
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release ${TAG} already exists — electron-builder will upload into it"
else
  gh release create "$TAG" \
    --target "$(git rev-parse HEAD)" \
    --title "IdleBiz ${TAG}" \
    --generate-notes
  created_here=1
fi

# A failed package/notarize/upload shouldn't strand an empty release + tag.
published=""
cleanup() {
  if [ -n "$created_here" ] && [ -z "$published" ]; then
    echo "publish failed — removing the empty ${TAG} release and its tag" >&2
    gh release delete "$TAG" --yes --cleanup-tag >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

GH_TOKEN="$(gh auth token)" pnpm with-env electron-builder --mac --publish always
published=1
echo "published ${TAG}: $(gh release view "$TAG" --json url -q .url)"
