#!/bin/bash
# Refresh the Pool Atlas end to end: re-analyse every champion pool, render any NEW species stills + swimming loops
# (existing ones are kept -- faces are deterministic per pool), rebuild the page. Pass --open to show it in Safari.
set -euo pipefail
cd "$(dirname "$0")/../.."
node tools/atlas/analyze-pools.mjs
node tools/atlas/render-specimens.mjs
node tools/atlas/render-anims.mjs
node tools/atlas/build-page.mjs
if [ "${1:-}" = "--open" ]; then open "$HOME/Library/Application Support/GenePool/atlas/index.html"; fi
