#!/usr/bin/env bash
# Publish a signed, notarized macOS build to a SINGLE GitHub release.
#
# electron-builder's GitHub publisher runs once per mac target — we build a dmg
# AND a zip — and each instance independently "creates the release if it's
# missing" on tag v$VERSION. Run bare (`electron-builder --publish always`) they
# race: two release objects land on the same tag, and every later
# `gh release edit` / API PATCH then fails with 422 tag_name already_exists,
# leaving the title bare and the notes empty. Pre-creating the release here means
# both publishers find it and only upload — one release, with editable notes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." # -> apps/desktop

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

# The release tag points at HEAD, so HEAD must already be on the remote — both
# for `gh release create --target` and so the published build matches origin.
if ! git merge-base --is-ancestor HEAD '@{upstream}' 2>/dev/null; then
  echo "HEAD isn't pushed to its upstream. Bump the version, commit, and push first." >&2
  exit 1
fi

# renderer / main / preload bundles (fast; no signing)
pnpm with-env electron-vite build

# Pre-create the release so the dmg+zip publishers find it instead of racing to
# create it. Created here => exactly one release object on the tag.
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

# Package -> sign -> notarize -> dmg+zip -> upload into the release created above.
GH_TOKEN="$(gh auth token)" pnpm with-env electron-builder --mac --publish always
published=1
echo "published ${TAG}: $(gh release view "$TAG" --json url -q .url)"
