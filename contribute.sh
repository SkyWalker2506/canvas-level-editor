#!/usr/bin/env bash
# Promote engine-generic fixes from a project back to the package repo.
# Only copies engine files (editor-core.js, editor-core.css) — not game config.
# Usage: ./contribute.sh /path/to/Project [subdir]
set -e

TARGET="${1:-}"
SUBDIR="${2:-tools/canvas-level-editor}"
[ -z "$TARGET" ] && { echo "Usage: ./contribute.sh /path/to/project [subdir]"; exit 1; }

PKG_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$TARGET/$SUBDIR"
[ ! -d "$SRC" ] && { echo "Not installed at: $SRC"; exit 1; }

CHANGED=0
for f in editor-core.js editor-core.css; do
  if ! diff -q "$SRC/$f" "$PKG_ROOT/$f" >/dev/null 2>&1; then
    echo "[DIFF] $f"
    diff "$PKG_ROOT/$f" "$SRC/$f" | head -30
    echo ""
    cp "$SRC/$f" "$PKG_ROOT/$f"
    CHANGED=1
  fi
done

if [ $CHANGED -eq 0 ]; then
  echo "No engine differences — nothing to contribute."
  exit 0
fi

echo "Copied to package. Review and push:"
echo "  cd $PKG_ROOT"
echo "  git diff && git add -A && git commit -m 'fix: ...' && git push"
