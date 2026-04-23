#!/usr/bin/env bash
# Install canvas-level-editor into a target project.
# Usage: ./install.sh /path/to/Project [subdir]
# Default subdir: tools/canvas-level-editor
set -e

TARGET="${1:-}"
SUBDIR="${2:-tools/canvas-level-editor}"
[ -z "$TARGET" ] && { echo "Usage: ./install.sh /path/to/project [subdir]"; exit 1; }
[ ! -d "$TARGET" ] && { echo "Target dir not found: $TARGET"; exit 1; }

PKG_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$TARGET/$SUBDIR"
mkdir -p "$DEST"

cp "$PKG_ROOT/editor-core.js" "$DEST/"
cp "$PKG_ROOT/editor-core.css" "$DEST/"

echo "Installed canvas-level-editor at: $DEST"
echo ""
echo "Usage in your game (HTML):"
echo '  <link rel="stylesheet" href="'"$SUBDIR"'/editor-core.css">'
echo '  <script src="'"$SUBDIR"'/editor-core.js"></script>'
echo '  <script>window.CanvasLevelEditor.create({ schema, courses, ... });</script>'
