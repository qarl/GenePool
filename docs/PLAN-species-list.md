# PLAN — species list (browsable, click-to-expand)

Replace the fixed 3-tile right column with a **scrollable list of ALL species**, each drawn as its collapsed
license-plate, sorted by population (largest first). **Click a plate to expand it into a full live mini-viewer**
(the 256² micrograph of that species' representative). Multiple can be open at once.

_Reviewed by 1 + 5 subagents (2026-09-04). Unanimous verdict: **core approach sound** — the scratch-corner blit
ordering, the y-flip math, byte-identical main view, and dynamic-golden-dims were all independently VERIFIED against the
code. Findings below are folded in and tagged by lens (`GL/DOM/DATA/PERF/TEST §N`). Two earlier "accepted fixes" were
themselves wrong and are corrected here (labMain anchor; extinction predicate; readPixels-as-default)._

## Decisions
- **Multi-expand:** several viewers open at once. List scrolls.
- **Ordering: wobbly first.** Strict live re-sort by count — Karl wants to see the jump before we calm it. (Hysteresis
  and a secondary id tie-break `DATA §N6` are the known follow-ups.)
- **Collapsed row = plate only.** Expanded viewer = full label (plate + count + diversity) — Karl: "show all info."
- **⚠ OPEN — `SPECIES_K` (needs Karl).** As coded the list can **never exceed 24 species**: `SPECIES_K=24` caps the
  clusters `computeSpecies` tracks (line 878/922), and bots that would form a 25th cluster are **force-merged into the
  nearest one — so tail counts are wrong, not just hidden** (`PERF §S2`, `DATA §S3`, `GL/DOM/TEST` all flag it). "A list
  that can be quite large" therefore requires **raising `SPECIES_K`**, whose real cost is the every-frame clustering
  `O(bots × K × NJ)` (up to ~2000 bots), NOT the DOM. Recommendation: raise to ~64–128 and measure clustering ms; decide
  the ceiling with Karl before Phase 1.

## Current architecture (what we're changing)
- One `#cv` WebGL canvas, 1024×768. `render()` composites the main view (768², left) + 3 tiles (256², right column)
  into fixed canvas **regions** via `renderView(cam,vw,vh,set,regionX,regionY,drawWall,roundPx,onlyBot)` → POST_FS with
  `uOrigin`. Between-view gutters drawn as black boxes (1293-1308). HTML `.tileLabel`s overlay the regions.
- `computeSpecies()` (every frame) → `speciesList` (count desc, ≤`SPECIES_K`), `speciesById`, `tracked` (persistent
  lineages: `.sig`,`.rep`,`.emaUsed`,`.divEMA`,`.count`; survive **up to 4 missed reclusters** before `tracked.delete`
  at `misses>4`, line 974), and `slotIds` (the 3 sticky tile slots — **removed**; used only at 554/883/977-983/1041/1282,
  all inside replaced code — `DATA §N8` confirms no hidden coupling; `__golden`/`__bench` read `speciesList`, survive).

## Target architecture
- **Left:** `#cv` → **768×768**, main micrograph only (keep its rounded corner). Main render is **byte-identical** to
  today's left-768 (SC_REF is VIEW_MAIN-based, FBOs are `makeFBOSet(768)`, `uRes` is region-local — `GL`+`TEST` verified)
  → the new golden should equal the left-768 crop of the current one (a Phase-0 sanity gate).
- **`#labMain`** (whole-pop plate/count/diversity) must stay top-right **of the canvas**. ⚠ `right:12px` is WRONG once
  `#stage` is a flex row (canvas 768 + gap + panel 256 ≈ 1029px → 12px anchors to the *panel's* edge) (`DOM §S2`,`GL §2`).
  **Fix: wrap the canvas in its own `position:relative` box and anchor `#labMain` to that** (a `<canvas>` can't hold
  children). (Fallback: `right: calc(256px + 5px + 12px)`.)
- **Right:** a scrollable DOM panel `#species` (256 wide, canvas height, `overflow-y:auto`) beside the canvas in a flex
  `#stage` (the old 5px main|column gutter becomes the flex gap). HTML, not WebGL.
  - Reset `line-height` on `#species` — `#stage` sets `line-height:0` (line 23), which would collapse any flowed text
    (`DOM §S6`). Add `scrollbar-gutter: stable` so a vertical scrollbar doesn't shrink a 256 mini into an x-scroll
    (`DOM §S7`).
- **Collapsed row:** `<div class="srow" data-id=ID>` holding `plateHTML(sig)`; `cursor:pointer`; explicit height/padding
  (plate is ~20px — a thin target) and a row gap (`DOM §S5`).
- **Expanded row:** taller, adds a `<canvas class="mini" 256²>` + a `.tileLabel`-style overlay label (the expanded label
  MAY reuse `.tileLabel` — absolute, pointer-events:none, pinned over the mini if `.srow` is `position:relative` —
  `DOM §NK5`). Mini's rounded corner = CSS `border-radius` (clips at composite even for `putImageData`; don't `ctx.clip`
  — `DOM §NK3`).
- **⚠ De-scope the plate CSS (BLOCKING, `DOM §B1`).** `.tileLabel .plate/.cell/.g` and the emitted glyph bitmaps
  `.tileLabel .cell .g[data-c="X"]{…}` (line 1016) are all scoped under `.tileLabel`. A bare `.srow` won't match → cells
  get no size, `.g` gets no bitmap → **collapsed rows render blank**. And you can't add `.tileLabel` to a row (it's
  `position:absolute; pointer-events:none`). **Re-root those rules (and the generated string) on `.plate`/`.cell`/`.g`**
  so they apply in both the absolute labels and the flowed rows.
- **Scope the global `canvas {}` rule.** Line 24 puts `border-radius/box-shadow/cursor:grab` on ALL canvases; minis would
  inherit the shadow + grab cursor. Scope shadow/cursor to `#cv` (keep border-radius or set it per `.mini`) (`GL §3`).

## Feeding a mini canvas (the one real technical question — VERIFIED correct)
Each frame, for each expanded species, `renderView(rep@TILE_ZOOM, 256,256, smallSet, 0,0, drawWall=false, roundPx=0,
rep)` into the **scratch corner** of `#cv` (GL viewport `(0,0,256,256)` = displayed bottom-left = canvas-2D `y=512`).
Blit that into the row's 2D canvas, **individually, before the next mini reuses the corner** (batching would leave every
row showing the last species — `GL §9`). After ALL expanded views, render main **unconditionally** over the full 768²
(covers the scratch; POST_FS writes every fragment incl. rounded corners, so no mini pixels leak — `GL` verified).
- **Live default = `drawImage(cv, 0, 512, 256,256, 0,0,256,256)`** (GPU-side, no readback, upright, no flip). Works
  mid-`render()` without `preserveDrawingBuffer`. `readPixels` is a **synchronous GPU→CPU stall** — fine once per offline
  `__golden`, but N stalls per 60Hz frame serializes CPU/GPU (`PERF §B1`, `GL §1`; corrects earlier "same sync cost").
- **Deterministic/headless + golden capture = `readPixels`(0,0,256,256) → row-flip → `putImageData`** (the path
  `__golden` proves, line 1372). Keep this for the mini-golden (`TEST §B1`) and as the fallback.
- **`roundPx=0`** — CSS rounds the mini; a GL round would double-fringe (`§5`, both new reviewers confirm).
- **Reuse buffers:** one module-scope scratch `Uint8Array(256²*4)` + one `ImageData` per size, written in place — the
  live loop must not allocate 256KB×N per frame (`PERF §S1`, `GL §8`). Cache each mini's 2D context once (`DOM §NK6`).
- **Purity:** resolve the rep WITHOUT writing to `tracked` (no `r.t.rep = …` in the shared path) or the main golden
  loses byte-purity (`GL` caveat).

## Perf mitigations — IN SCOPE, not deferred (`PERF §B1`)
The wall is per-mini readback/render, not the DOM. Bring in now (all cheap):
- **Round-robin** live minis: refresh 1–2 per frame (a thumbnail at 60/N fps is imperceptible) → ≤1–2 stalls/frame.
- **Gate offscreen minis** with an `IntersectionObserver` on each `.mini` in `#species` — a scrolled-out mini must not
  render+blit for pixels nobody sees.
- Optional **soft cap** on simultaneous live minis.
- The DOM list is genuinely cheap (≤24 rows today; plates are baked-bitmap spans, re-decode-free) (`PERF §S2/N2`,
  `DOM §NK1`) — but still do a **minimal-move reconcile** (`insertBefore` only when a row isn't already the right
  sibling), not blind `appendChild`-every-row-every-frame (`DOM §S4`).

## Build order

### Phase 0 — layout scaffold (main-only canvas + empty right panel)
- `#cv` → 768×768; `render()` drops the tile loop (1281-1291) **and** the gutter block (1293-1308). Keep main + corner.
- De-scope the plate CSS (`DOM §B1`); scope the global `canvas{}` rule (`GL §3`); wrap the canvas in a
  `position:relative` box and re-anchor `#labMain` to it (`DOM §S2`).
- Add `#species` (flex, gap 5px, dark bg, `line-height:normal`, `scrollbar-gutter:stable`). Retire `#lab0..2` + all
  `slotIds` logic.
- **`build()` MUST reset new state (BLOCKING):** `build()` resets `nextSpeciesId=1` (line 554) → ids reused every
  Reset/seed/`__golden`. Clear `rowMap` + `expanded` **and `#species.replaceChildren()`** there (clearing the maps
  alone leaves orphan rows/canvases accumulating — `DATA §B2`, `GL §4`).
- **Goldens:** only the 5 PNGs re-record (harness reads dims from `__golden` — `capture.mjs:27` — `TEST` verified);
  re-record on arm64 (`record.mjs` refuses off-arch); code + goldens in ONE commit (`TEST §N4`). Sanity: new 768² golden
  == left-768 crop of the old (`TEST` main-byte-identical, verified). Re-baseline perf (`node perf.mjs --update`) — the
  drop is tile removal, not a speedup (`PERF §B2`, `TEST §S1`, `GL §7`). Update stale metadata: `scenes.mjs:3`
  `CANVAS→{768,768}`, and the `speciated` "3 tiles" comment/message (`TEST §S2/S3`).

### Phase 1 — collapsed list (wobbly)
- Rename `updateTileLabels` → `updateSpeciesUI`. Iterate the **union of `tracked` (persistent) and `speciesList`** — NOT
  `speciesList` alone — keyed by id in `rowMap`. Create rows for new ids; **drop a row only when its id leaves
  `tracked`** (retired at `misses>4`), never on a 1-frame `speciesById` absence (a miss ≠ extinction — `DATA §B1`).
  During a miss: keep the row, read the label from `tracked.get(id)` (`t.sig`/`t.count`/`t.divEMA`), skip the blit.
- Sort present species by count; reorder rows to match via minimal-move reconcile. Plate only; update a row's plate only
  when its `sig` changed. Label data lives on the lineage (`r.t.sig`, not `r.sig` — `DATA §N8`).
- One **delegated** listener on `#species` (rows churn every frame — `DOM §S3`). Toggle on `closest('.plate')` so
  clicking an expanded mini doesn't collapse it (`DOM §S5`). **Capture the id on `pointerdown`** (a row can move between
  press and release under the wobble → click resolves to the wrong/none species; `DOM §S3`). Keeps the wobble Karl wants.
- This is the first thing to eyeball: how bad is the reorder jump?

### Phase 2 — click to expand (multi, live)
- `expanded = Set<id>()`. Toggle → add/remove the row's `.mini` + full label.
- In `render()`, before the main render, loop expanded ids; **don't mutate `expanded` mid-loop** — collect changes,
  apply after (`DATA §N7`, `DOM`). For each: if `speciesById.get(id)` is present → render its mini from the **continuous
  `r.t.rep`** (alive + in `idset`, re-established this frame → a STABLE specimen; `members.find(alive)` returns a
  frame-jittering member — `DATA §S5`); if the id is in a **miss** (absent from `speciesById` but still in `tracked`) →
  freeze (skip blit); if it left `tracked` → auto-collapse + drop the row.
- Reconcile row counts vs `#labMain`: rows count grown bots only (`ph.numParts>1`), `#labMain` counts all living →
  they won't sum. Annotate or reconcile (`DATA §S4`).

### Phase 3 — polish
- Scroll feel, expanded-label styling, spacing/gutters, round-robin/offscreen tuning.
- `drawImage`-vs-`readPixels` A/B **on real hardware** (SwiftShader has no GPU bus so the perf bench can't see the
  stall — `PERF §B2`).

## Testing
- **Re-record + pass the 5 visual goldens** (now 768² main). `gate-a`/`founders/adults/branchy/dying` are main-view,
  unaffected (`TEST §N3`).
- **Restore small-view coverage (BLOCKING, `TEST §B1`):** removing tiles deletes the only golden of the 256² path — the
  path Phase 2 rewrites. Extend `__golden` to expand one species (on `speciated`, ≥3 species), render its mini into the
  readable corner, return the 256² bytes as a second golden. Byte-exact coverage for a few lines.
- **Interaction harness (BLOCKING, `TEST §B2`):** add `interaction.visual.mjs` — `__golden(seed,ticks)` to populate a
  deterministic `#species`, then query rows / click / **manually tick+render** (note: `__golden` sets
  `loopStopped=true`, so the rAF loop is dead after capture — the driver must re-arm or call `render()` itself; and
  extinction-collapse needs the sim advanced). Wire into `npm --prefix test/visual test`.
- `perf.mjs` still runs (main view); add a variant that force-expands K minis to measure the real cost driver.

## Open questions / decisions
- **`SPECIES_K` ceiling** (the one for Karl — see Decisions). Everything else is folded in above.
- Count reconciliation policy (`DATA §S4`): annotate the embryonic gap, or count all living per species?
