#!/bin/bash
# Build the standalone GenePool.app.
#
# The desktop app serves its viewer/engine/fonts/tools from the REPO ROOT (main.mjs: ROOT = resolve(HERE,'..')),
# so a working bundle must include those — not just desktop/. We stage the needed files with desktop/ as a subdir
# (so ROOT resolves the same in the bundle as in dev), then run @electron/packager with asar OFF (the generator
# runs as a utilityProcess forking a real file on disk). Output: desktop/dist/GenePool-darwin-<arch>/GenePool.app
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"        # desktop/
ROOT="$(cd "$HERE/.." && pwd)"               # repo root
STAGE="$HERE/.stage"; OUT="$HERE/dist"
EV="$(node -p "require('$HERE/node_modules/electron/package.json').version")"
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && EARCH=arm64 || EARCH=x64

echo "staging (electron $EV, $EARCH)…"
rm -rf "$STAGE"; mkdir -p "$STAGE/desktop"
cp -R "$ROOT/engine" "$ROOT/tools" "$ROOT/fonts" "$STAGE/"
cp "$ROOT/viewer-micrograph-gl.html" "$ROOT/viewer-micrograph-params.json" "$STAGE/"
cp "$HERE/main.mjs" "$HERE/generator.mjs" "$HERE/preload.cjs" "$STAGE/desktop/"
cp -R "$HERE/build" "$STAGE/desktop/"
cat > "$STAGE/package.json" <<JSON
{
  "name": "genepool",
  "productName": "GenePool",
  "version": "1.0.0",
  "type": "module",
  "main": "desktop/main.mjs",
  "author": "Karl Stiefvater (a fork of GenePool by JJ Ventrella)",
  "devDependencies": { "electron": "^${EV}" }
}
JSON

echo "packaging…"
rm -rf "$OUT"
"$HERE/node_modules/.bin/electron-packager" "$STAGE" GenePool \
  --platform=darwin --arch="$EARCH" --electron-version="$EV" \
  --icon="$HERE/build/icon.icns" --out="$OUT" --overwrite --asar=false \
  --app-bundle-id=com.ventrella.genepool.fork --app-version=1.0.0
rm -rf "$STAGE"
echo "done -> $OUT/GenePool-darwin-$EARCH/GenePool.app"
