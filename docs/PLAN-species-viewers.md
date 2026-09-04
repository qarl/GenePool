# PLAN — species viewers (top-3 species side panels)

Study pools by seeing the **three largest species** live, side by side. On `viewer-micrograph-gl.html`.
Status: **BUILT (core feature complete), 2026-09-03.** Steps 1–7 done except rank/floor hysteresis (deferred, needs
live tuning). Gated throughout by the visual-golden harness (`docs/PLAN-visual-goldens.md`). Commits:
2a `ba634f6` (render→renderView split, byte-identical) · 2b `2879d72` (1024×768, per-view FBO sets, region composite) ·
3 `bb77128` (three tiles, top-3 by head-count, engine-native clustering, reproductiveIsolation ON) ·
5 `0c1ec59` (count labels, HTML overlay) · 7 `2f51be1` (5px gutters + matching rounded corners) ·
4+6 `9a8c5df` (stable species identity + rep-death re-pick). REMAINING: rank/floor hysteresis (tiles can still swap
slots when head-counts cross — needs Karl watching live to tune the margin); optional vignette; fit-zoom calibration
(TILE_ZOOM=14 is a fixed guess). `empty` golden scene deferred (needs a skip-founders hook arg).

## Confirmed decisions (Karl)
- Layout **1024×768 (4:3)**: main **768×768**, three **256×256** smalls stacked in the right column (256×3=768).
- Small viewers show the top-3 species (by living head-count), **fixed shared zoom**, auto-centered on a
  representative, rounded corners + vignette, NO pan/zoom.
- **Scope = visuals + COUNTS (counts first)**: each small tile shows its species' **living head-count + rank**.
  (Dominance header + speciation timeline = possible later, not this pass. Karl: "counts first.")
- Karl hates menus — ask in prose, never AskUserQuestion.

## Species definition (engine-native — verified exact)
Cluster on **junk genes 112..255** (144 of them). Metric = `1 − mean|Δg|/256` (**/256 = BYTE_SIZE**, not 255).
Same-species iff `similarity > reproductiveIsolation` — **STRICT `>`** (world.js:499 rejects on `<=`). Read the
threshold via the schedule (`scheduleValue(world._config.reproductiveIsolation, clock)`, defaults 0.9). These are
an APPROXIMATION of a non-transitive relation (counts approximate). Also: the junk gate is necessary-not-
sufficient for real interbreeding — phenotype mate-attraction can subdivide a junk-cluster; declare that out of scope.

## Step 1 — species monitor (DONE, headless-verified)
Representative clustering: each living bot → its MOST-SIMILAR rep (not first-match); rep = member closest to the
species' mean junk genome (O(k); no pairwise medoid — k² blows up at ~1800). Speciation emerges ~40k ticks (one
dominant ~90% + small satellites). Prototype: scratchpad/species.mjs. Port with the fixes below.

## Rendering architecture (reviewed)
- `render()` → **`renderView(cam, vw, vh, fbos)`**, PURE-RENDER (all per-frame mutation hoisted out — see below).
- **FBO sizing decoupled from canvas.** Canvas = 1024×768; offscreen sets: **main 768×768** + **one 256×256 set**.
  `makeTex`/`makeAccum` take a size param; every `uniform2f(...Res,…)` uses the VIEW size.
- **Four distinct RESULT textures** (main + 3 smalls) that persist to compositing — share only the heavy
  intermediates (slab/accum/scene/bloom) across the 3 smalls. (OR composite each small immediately after its
  renderView before the next clobbers the shared set.) NOT one shared result texture (→ 3 identical tiles).
- **Composite pass** assembles the result textures onto the 1024×768 canvas via `gl.viewport` per region; sample
  with **normalized UVs or region-origin-subtracted texelFetch — NEVER window-absolute `gl_FragCoord`** (edge smear).
  Clear the canvas first. Main copy must be **1:1 NEAREST, Y-orientation pinned** (shaders bake the `1−y` flip) so
  it's lossless (that exactness is what makes the byte-identical gate meaningful). Smalls add rounded-rect SDF
  alpha + vignette (FINAL already darkens radially — tune together, don't double).
- **Per-view (not global):** parameterize **`fitZoom(curW,curH)`** (the real W/H→world-scale carrier) and let
  `sc()`/`toScreen`/cull-margins consume it. **`SC_REF` stays a SINGLE global** (main-calibrated); renderView READS
  it, never re-derives (per-view recompute mis-calibrates the rim between views). Wall = per-view cam, drawn into
  the view texture (or skipped for smalls; its wallDark quads would blacken a zoomed-in tile). **Bloom `uDir`
  (±12px absolute) must scale by view size** (`round(3·vw/768)`) or the 256 tiles wash out.
- **Hoist ONCE-PER-FRAME state OUT of renderView** (else it advances 4×): detritus drift `j.x+=j.vx`,
  death-fade bookkeeping — **`known`, `deathTick`, AND `fades`** (renderView only READS fades after the pre-pass).
- Watch: `captureCreatureGeom` (dead Copy-Swimmer path) reads global `sc()/toScreen` → delete it or set main view first.
- Cost ≈ 1.3× fill (768² + 3×256²), but budget the 4-view frame against the recompute (below), not fill-only.

## Species clustering — STABILITY (mandatory, not deferrable)
- Assign each living bot to its **most-similar** rep. **Hard rep cap K=16–32 enforced DURING assignment** (only
  top-3 shown; a bot matching no capped rep → nearest existing rep / "other" bucket; never create beyond K). This
  is a REQUIRED perf bound (uncapped → N·R·144 ≈ 5.8e8 ops, ~½s hitch).
- **Stable species IDs via last-frame rep seeding + GREEDY ONE-TO-ONE match in descending current-cluster size**
  (largest fragment inherits the prior ID; unmatched current → fresh ID; unmatched prior → retire). Nearest-rep
  alone breaks on split (both fragments claim one ID). Seed IDs for MORE than top-3 (all above floor / top-N+buffer)
  so a species dipping to #4 keeps its identity (the #3/#4 boundary is the worst strobe).
- **Rank hysteresis** (#2/#3 AND #3/#4): don't swap unless the size gap exceeds a margin for K recomputes.
  (Land the margin with a conservative default; don't over-tune before observing an actual flicker.)
- **Min-size floor WITH hysteresis** (two-sided band: appear above floor+margin, persist until below floor−margin)
  so a species hovering at the floor doesn't blink tiles present↔absent.
- Recompute cadence ~30 frames; **amortize** it (spread across the interval, or a Worker) so it doesn't land in one
  frame alongside the 4-view render.

## Candidate/tile lifecycle
- **Re-pick on death is PER-FRAME** (rep still in `world._swimbots`?), separate from the 30-frame recompute. Re-pick
  pool = last snapshot filtered to living; keep members sorted by centrality so re-pick is O(1).
- **Rep-death hysteresis + cross-fade**: hold the rep through its death-fade, then cross-fade to the successor (or
  bias re-pick to the previous rep's nearest living neighbour) — auto-center means a naive re-pick snaps the camera.
  Decide + state whether a dead/extinct tile holds-through-fade or snaps (main view fades; be consistent or deliberate).
- **Representative for APPEARANCE**: junk-centrality is decorrelated from body plan (used genes) AND from age. Pick
  the visual rep by **used-gene centrality / median body length, biased to grown members (growthScale≈1)** — else you
  show an arbitrary or newborn-speck specimen. (Or caveat the tile as a compatibility-centroid, not an appearance summary.)
- **Fixed zoom**: 432 is chain ARC length, not screen extent (branch spread + cap hairs + 1.2× death-swell exceed it).
  Calibrate to a bounding radius with margin (or observed p95 size + a scale bar) so real size differences fill the frame.
- `<3` species (fresh pool = 1) → **blank/labeled empty tile** (not ambiguous with a bug). Ties → break by stable id.

## Build order (reworked — stability + counts BEFORE cosmetics)
1. **Species monitor** — DONE. Port with /256 + strict `>` + schedulable threshold + the K-cap + most-similar assign.
2a. **Pure `render()`→`renderView` refactor + hoists + FBO-size param, AT THE CURRENT 900×760.** Gate **byte-
    identical via `gl.readPixels` diff** vs a pre-refactor capture (only size where byte-identity is achievable).
2b. **Resize to the 1024×768 layout** (main 768×768) as an explicit visible change; re-baseline (drop "unchanged").
3. **256² small FBO set + three small viewports** — render top-3 reps (plain, fixed zoom, 4 distinct result textures).
4. **Clustering stability** (ID continuity/seeding, one-to-one match, hysteresis, floor) — do NOT defer; panels strobe.
5. **Counts display** — per-tile living head-count + rank (Step-1 substrate already has it). [Karl: counts first.]
6. **Tracking + lifecycle** — auto-center, per-frame re-pick + rep-death cross-fade, blank tiles, fit-zoom calibration.
7. **Cosmetics** — rounded corners + vignette (demoted last; FINAL already darkens, marginal gain).

## Deferred / out of scope (revisit)
- Dominance header (species total, top-3 fraction) + **speciation/extinction timeline** — cheap byproduct of the
  stable-ID work (a ring buffer of {tick, per-id count}); product-value lens argued for it. Karl chose counts-first;
  timeline is the natural next tool.
- Morphotype clustering on USED genes (a second "what do they look like" lens). Faster speciation (mutation/isolation
  tuning) only if Karl wants quicker demos (faithful default: ~40k ticks to first split).
