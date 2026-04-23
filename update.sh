#!/usr/bin/env bash
# Pull latest canvas-level-editor code into a project. Preserves game-specific config.
# Usage: ./update.sh /path/to/Project [subdir]
set -e

TARGET="${1:-}"
SUBDIR="${2:-tools/canvas-level-editor}"
[ -z "$TARGET" ] && { echo "Usage: ./update.sh /path/to/project [subdir]"; exit 1; }

PKG_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$TARGET/$SUBDIR"
[ ! -d "$DEST" ] && { echo "Not installed at: $DEST"; exit 1; }

(cd "$PKG_ROOT" && git pull --quiet) || true

cp "$PKG_ROOT/editor-core.js" "$DEST/"
cp "$PKG_ROOT/editor-core.css" "$DEST/"

echo "Updated canvas-level-editor at: $DEST"
