#!/usr/bin/env bash
# Publish the built webui dist to the 'dist' branch (single-commit,
# force-pushed) and optionally as a GitHub Release zip.
#
# Why a separate branch: dist/ is gitignored on the source branch (build
# artifacts must not pollute the upstream PR or bloat history), but other
# machines want `git clone -b dist --depth 1` to get a ready-to-serve tree.
#
# Usage:
#   ./scripts/publish-dist.sh            # build + push dist branch
#   ./scripts/publish-dist.sh --release  # also upload dist.zip to a Release
#   SKIP_BUILD=1 ./scripts/publish-dist.sh   # reuse existing build/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH=dist
REMOTE=fork
TMP="$(mktemp -d /tmp/aw-webui-dist.XXXXXX)"
cleanup() { git worktree remove --force "$TMP" 2>/dev/null || rm -rf "$TMP"; }
trap cleanup EXIT

cd "$ROOT"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> npm run build"
  npm run build
fi

echo "==> preparing $BRANCH branch worktree"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add --detach "$TMP" "$BRANCH"
else
  git worktree add --detach "$TMP"
  (
    cd "$TMP"
    git checkout --orphan "$BRANCH"
    git rm -rf --quiet . 2>/dev/null || true
  )
fi

echo "==> syncing build output"
rsync -a --delete --exclude '.git' "$ROOT/dist/" "$TMP/"

echo "==> committing (single commit, force-pushed)"
(
  cd "$TMP"
  git add -A
  git commit --quiet -m "dist build $(date '+%Y-%m-%d %H:%M') — $(git -C "$ROOT" rev-parse --short HEAD)" || {
    echo "no changes since last publish"
    exit 0
  }
  git push "$REMOTE" "$BRANCH" --force
  echo "==> pushed $BRANCH -> $REMOTE"
)

if [[ "${1:-}" == "--release" ]]; then
  ZIP=/tmp/aw-webui-dist.zip
  (
    cd "$ROOT/dist"
    zip -qr "$ZIP" .
  )
  echo "==> uploading release"
  if ! gh release upload dist "$ZIP" --clobber -R "$(git remote get-url $REMOTE | sed -E 's#.*github.com[:/]##; s#\.git$##')" 2>/dev/null; then
    gh release create dist "$ZIP" -R "$(git remote get-url $REMOTE | sed -E 's#.*github.com[:/]##; s#\.git$##')" \
      --title "Patched webui dist" --notes "Latest build of feat/visualization-refresh. Serve with aw-server --webpath."
  fi
  echo "==> release updated: dist.zip"
fi

echo "done."
