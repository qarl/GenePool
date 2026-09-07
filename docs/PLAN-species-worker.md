# PLAN — species clustering on a Web Worker

Status: REVIEWED (1 hardening pass). ⚠ RESHAPED — consider INCREMENTAL clustering before the worker. Author: Jimmy-GenePool, 2026-09-06.

## §0. The review's key finding: membership is fixed at birth → incremental beats the worker

⭐ **Genes are immutable for life** (genotype.js: `Uint8Array(256)`, only written at birth). A creature's junk-gene vector never changes → **its species is fixed when it's born.** So `recompute` reclustering all ~1000 creatures every frame re-derives assignments that CANNOT change — pure waste. The cheap fix:

- **Incremental clustering (recommended):** on BIRTH, assign the newborn to the nearest lineage (`sim > SPECIES_ISO`) or start a new one; maintain per-lineage running centroid + count + the diversity/lifespan EMAs incrementally; on DEATH, `foldDeath` (already per-death). Per-frame cost = O(births) ≈ a handful, not O(pop) → the 8ms ~vanishes, **on the main thread, no worker, no async, no stall.**
- Cost: an algorithm change in `species.mjs` (assign-on-birth instead of global re-cluster) + re-baselined goldens + slight cosmetic DRIFT from the current greedy global recluster (a living bot never migrates lineage even if a centroid drifts past it — arguably *more* correct for "species"; the panel is cosmetic-live so drift is acceptable). Keep a periodic full rebuild only if lineage seeding proves unstable — and if it must run, that's the one case to hand to a worker.
- **This avoids ALL the worker surface below** (B1–B3, M1–M4, epoch races, Electron plumbing, the golden sync-split).

⭐ Two build-time caveats (1-review follow-up) when doing incremental:
- **The saving is the O(N·K·NJ) assignment SCAN only.** "Fixed at birth" means a living creature's lineage never changes — so skip re-deriving it. But the per-lineage centroids/EMAs still DRIFT (the plate is meant to crawl) as members are born/die, and `foldDeath` still needs the tracked EMAs to attribute each death's age — so incremental STILL advances the EMAs + folds deaths every frame; it just stops rescanning every living bot. Keep a periodic full rebuild to stay honest on founder edge cases (a newborn whose nearest rep later dies).
- **Re-baseline includes `test/analysis/species.test.js`, not just the visual goldens.** That test does a byte-exact `deepEqual` on `statsRow` and encodes the EXACT current greedy sequence — it WILL need updating to the new contract. The ≥3-species asserts (`goldens.visual.mjs`, `interaction.visual.mjs`) should survive; the `statsRow` one won't.

**Decision for Karl (worker vs incremental):** incremental is simpler, removes the 8ms on-thread, and needs no async — at the price of a small semantic drift + golden re-baseline. The worker removes the cost *exactly* (bit-identical membership) but carries all the surface below. Lean: **incremental.** Measure it first.

Also do regardless (m6): **cache each bot's gene slices at birth** — removes ~235k `getGeneValue` virtual calls/frame (~1-2ms) and helps whichever path.

---
Status (original draft): pre-review.

## 1. Goal & measured justification

Move the per-frame species clustering off the main thread onto a Web Worker, so the render stays smooth every frame with **no periodic hitch** and species stay fresh.

Measured (real GPU, restored evolved world, pop ~1033, whole-pool): the render frame is 22.7ms, and **8.0ms of it is `speciesModel.recompute()` running EVERY frame** — reclustering all ~1033 creatures 60×/sec. `SPECIES_RECOMPUTE=1`; the comment says "~0.6ms at this pool size" (written at low pop) — it ballooned to 8ms at pop 1000. Throttling (recompute every N frames) is REJECTED by Karl: it clumps the 8ms into every Nth frame → a ~1.4Hz **stall** (yucky). The worker removes the cost from the main thread entirely (onto one of 14 mostly-idle cores) → smooth every frame AND fresh species.

## 2. Current architecture

- `viewer-micrograph-gl.html:1473`: `if (world && frameCount%SPECIES_RECOMPUTE===0){ speciesModel.recompute(world._swimbots.values()); updateSpeciesUI(); }` — synchronous, in the render path, every frame.
- `engine/analysis/species.mjs`: `createSpeciesAnalyzer()` → `.recompute(swimbots)`. Reads per-swimbot `getGenotype().getGeneValue(USED+k)` (junk genes, `junkOf` → Float64Array[NJ]), `getAlive()`, `getAge()`, `_phenotype`. Holds STATEFUL `tracked` Map (lineage EMAs: centroid `ema`, `divEMA`, `sig`(PCA plate), `count`, `misses`, `idset`, `rep`, `lifeEMA`). Returns the species list; `rep` is a live **Swimbot object** (used to render the mini-tiles).
- Shared with the headless run generator (so a generated run's stats reproduce the panel) — so `species.mjs` must keep working synchronously in Node too.

## 3. Proposed architecture

- **New worker** (`desktop/`-served module worker, or a browser worker) that imports `species.mjs`, holds the analyzer instance, and on each message runs `recompute` on the posted gene data.
- **Main → worker (per recompute):** pack the live creatures into a transferable: an id array (Int32) + a flat `Float32Array` of `[NJ]` junk genes per creature (+ age if needed). `junkOf` currently returns Float64; Float32 is fine for the clustering metric (verify) — ~NJ×pop ≈ 144×1033 ≈ 150k floats ≈ 600KB, transferred (zero-copy) via an ArrayBuffer. Pack cost ~1ms on main.
- **Worker → main:** the species list as plain data: `{stableId, count, sig(plate), divEMA, lifeEMA, repId, idset?}`. NO swimbot objects.
- **Main:** map `repId → world._swimbots.get(repId)` for the tiles; feed the list to `updateSpeciesUI`. The tiles already tolerate a missing/638 rep (drive off `tracked`, miss≠extinction).
- **Coalesce:** only one recompute in flight; if a result hasn't returned, skip posting (or post the latest on return). Species drift slowly → a recompute every ~1-2 frames is plenty.

## 4. Risks / traps (for the reviewer)

1. **Golden/headless determinism (the main one).** `window.__golden` (deterministic, synchronous) and the headless run generator both use `species.mjs` synchronously. The worker makes the LIVE app async. → Keep a **synchronous `recompute` path** for `__golden` + the generator (the worker wraps the SAME `species.mjs`, so behavior is identical); the async worker is a live-desktop-only optimization. The `speciated` golden asserts ≥3 species → it must run the sync path. Confirm `__golden`/tests never depend on the worker.
2. **`rep` is a render object** → worker returns `repId`; main re-maps. Handle a rep that died between recompute and use (already tolerated).
3. **Analyzer state lives in the worker** — the `tracked` lineage EMAs must persist in the worker across messages (one analyzer instance). The main thread no longer holds it (except the sync fallback path keeps its own for goldens — two analyzer instances, live-worker vs sync-golden; fine, they're separate contexts).
4. **Serialization fidelity** — Float32 vs the current Float64 `junkOf`: the clustering metric is `sim = 1 - mean|Δ|/256` on 0-255 gene values; Float32 holds those exactly. Verify the species RESULT (membership) is identical to the sync version (it should be).
5. **Post cadence / back-pressure** — don't queue posts faster than the worker drains (coalesce to latest). At pop 1000, recompute ~8ms < frame budget on an idle core, so it keeps up ~every frame.
6. **Electron plumbing** — module worker (`new Worker(url, {type:'module'})`) served via the app's loopback static server; verify it loads `species.mjs` + its deps in the worker context (no DOM). In the plain browser viewer, species runs sync (no worker) OR the same worker — decide (browser viewer isn't the perf-critical desktop path).
7. **`updateSpeciesUI` touches the DOM** — stays on main (only `recompute` moves to the worker). The worker returns data; main does the DOM.
8. **Staleness at extinction/speciation events** — a new species appears ~1-2 frames late in the panel. Imperceptible.

## 5. Build order
1. Extract the pure `recompute(genes,ids,ages)` core so it runs identically on main (sync) and in the worker. Keep the existing sync entry for `__golden`/generator.
2. Add the worker + the pack/post/receive wiring in the live desktop render path; coalesce.
3. Verify: goldens 6/6 (sync path unchanged); measure the render drop (~8ms off main); species panel updates smoothly with no stall; no renderer errors.

## 6. Success criteria
- Real-GPU render at pop ~1000 whole-pool drops ~8ms (→ smooth ~90fps+ with the alloc fix), no periodic stall.
- Species panel visibly identical (≤1-2 frame lag); goldens byte-identical (sync path); headless generator unchanged.

## 7. Process
Per Karl (2026-09-06): contained subsystem → **plan + 1 hardening review** (not the full 5-panel) → build.

## 8. Worker build-checklist (1-review findings — IF we pick the worker over incremental)
- **B1:** payload needs BOTH gene regions (junk `[112,256)` for clustering + coding `[0,83)` for the PCA plate/diversity/popSig). Simplest: transfer the full 256-byte genome; worker slices.
- **B2:** `foldDeath` mutates worker-resident lineage EMAs (lifespan) → add a death-event channel (post `{genomeBytes, age}` per death, before the recompute post to keep advanceFrame ordering); worker returns per-lineage + pop lifeEMA.
- **B3:** the panel reads `speciesModel.tracked` (with up-to-4-miss hysteresis), NOT `speciesList` → worker must return a full tracked-shaped snapshot `{id,count,sig,divEMA,lifeEMA,repId,misses}`; main mirrors it as a `tracked` Map + a `speciesById` Map for tiles.
- **M1:** epoch race — `build()`/reset/`resetOverlays` recreate the analyzer (and `__golden` calls `build()`); stamp posts with an epoch, drop stale results, reset the worker analyzer on reset.
- **M2:** the main facade is NOT thin — it must cover 8 members (recompute, foldDeath, tracked, speciesById, speciesList, popSig, popDivEMA, popLifeEMA) and switch sync-real (`__golden`/tests) vs worker-mirror (live) via a mode flag.
- **M3:** eligibility gate reads `_phenotype.numParts>1` (can't cross) → apply the exact filter on main during packing.
- **M4:** sticky-rep uses object identity + `getAlive` → reconstruct id-based (idset of ids, rep=id, "alive" = repId ∈ posted living set; requires packing only living bots).
- **m1:** transfer raw `Uint8Array(256)` genome bytes (~264KB, exact integers → membership bit-identical, kills the Float32 risk; ping-pong two buffers since transfer detaches).
- **m4 (correction):** the headless generator does NOT use species.mjs; the sync consumers are `__golden` + the visual/interaction/analysis tests. `__golden` is synchronous → goldens MUST stay on the sync path (the hard constraint).
- **m5:** module worker served over the loopback (`.mjs` = text/javascript already); build the URL from `location.origin` (inline script → no `import.meta.url`); **fall back to sync if `new Worker()` throws.**
