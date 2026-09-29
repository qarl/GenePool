# PLAN — body-based species plate ("license plate" v2)

Status: v3 — incorporates review #1 and the 5-lens review (§7). Engineering fixes folded in; PRODUCT questions for Karl in §8. Owner: Jimmy-GenePool. Requested by Karl 2026-09-29.

## 1. Goal (Karl's words → requirements)

- **R1 "visually similar organisms should have similar plates."** Today they don't: the plate is a PCA projection of raw
  gene values, and gene space is near-isotropic (top-5 gene PCs ≈ 20% of variance; the Pool Atlas found gene distance
  separates nothing, while body features separate well — 2 body axes ≈ 50%).
- **R2 "all plates should always be the same"** — one fixed plate function, never dependent on a run's options. The same
  genome gets the same plate in every pool, run, machine, app build.
- **R3 "let's assume the category-3 option is always enabled"** — the plate grows the body with
  `fixBranchCategoryGene: true` regardless of the run's config. This makes R1 and R2 compatible: plate = pure function of
  the genome, AND it measures the body you actually see (all our pools run with the fix on).
- **R4 "I don't want it too obvious — five PCA axes"** — characters are PCA coordinates of body space (blends), not one
  readable trait per character.
- Plate stays **5 characters of [0-9A-Z]** and keeps its role: universal species ID shown in the app's species list,
  main-view population plate, atlas.

Non-goals: changing species *membership* (still the junk-DNA reproductive gate, SPECIES_ISO 0.9); changing anything in
the engine trajectory (plates are observer-only; bit-identical sim is untouched).

## 2. Current system (facts, verified)

- `engine/analysis/species.mjs`: `signatureOf(vec)` projects a mean **expressed-gene** vector `[0,EXPRESSED=83)` onto 5
  frozen PCA components (`PCA_MEAN/COMPONENTS/SCALES`, trained by `tools/pca/` on 100 seeds, **before** the
  category-3 fix and **before** the pmath epoch), squashes with `normCDF`, ×`SIG_AMP=2`, clamps, rounds to −17..+17,
  maps with **wrap-around** (`0`=mean, positive `1..H`, negative wraps from `Z` down).
- The analyzer keeps per-lineage running sums over EXPRESSED genes (`sumUsed`, `sumSqUsed`); `emaUsed` (EMA of the
  lineage mean, SIG_EMA 0.08) → `t.sig`; population `popUsedEMA` → `popSig`; diversity = mean per-gene std over EXPRESSED.
- **Stale:** with `fixBranchCategoryGene` (on in POOL_SETTINGS) category 3 = **genes 83–109 are expressed**: 23% of
  evolved creatures have category-3 parts (12% of all parts, 60/226 pools). The plate + diversity ignore them. Genes
  110–111 (food type) are live only with numFoodTypes = 2.
- Consumers: viewer (`plateHTML(sig)` colour barcode; `labMain` pop plate; species list rows; `__golden` meta),
  atlas (`r.t.sig`), `test/analysis/species.test.js` (asserts `signatureOf(PCA_MEAN) === '00000'` + format).
  **Timelines do NOT store plates** (run-gen statsRow = `{div, life}` only) → no stored-data migration.
  Visual goldens don't compare plates (DOM, not canvas). `test/oracles/e1-corpus.js` `signatureOf` is an unrelated
  body-decode oracle (name clash only).
- Embryology (`Embryology.generatePhenotypeFromGenotype(genotype, config)`) reads only `config.numFoodTypes` and
  `config.fixBranchCategoryGene`. Cost measured: **~6 µs/creature** (2000 creatures ≈ 12 ms).
- Renderer uses `part.endCapSpline` (terminal dome bulge) → visual; `part.splined` is NOT used by the renderer → not visual.

## 3. Design

### 3.1 Body features (pure function of the genome)
For each creature: `ph = EMB.generatePhenotypeFromGenotype(genotype, PLATE_DECODE)` with a module-level
`EMB = new Embryology()` in the new shared `engine/analysis/body-features.mjs` (never `world._embryology`; decode is
synchronous and resets its state per call) and the frozen `PLATE_DECODE = { numFoodTypes: 1, fixBranchCategoryGene: true }`
(R2/R3 — never the run's config; the decode reads only these two fields and uses only + − × ÷ floor round).
**Part 0 is the empty root (width = length = 0) and is skipped everywhere.** Features use only **genetic part
parameters** (pose-independent). Groups get equal total weight (§3.3) so correlated size features can't dominate PCA.

| group | feature | definition | transform |
|---|---|---|---|
| size | reach | longest root→tip path: Σ length along the deepest parent chain (as the viewer's chain logic, viewer:1310) | sqrt |
| size | segs | numParts − 1 | sqrt |
| shape | width | area-weighted mean part.width | sqrt |
| shape | taper | last/first width along the **trunk chain** (parts with chain[p] === chain[1]) | sqrt |
| shape | cap | area-weighted mean endCapSpline (rounded vs blunt tips; renderer viewer:1089) | — |
| structure | branches | # parts with branch && parent > 0 | sqrt |
| structure | depth | max branch nesting depth | — |
| structure | splay | mean |part.angle| over branch-base parts | — |
| structure | symmetry | fraction of branch bases whose reflect produced a mirrored partner (branchNumber > 1) | — |
| colour | green, blue | area-weighted mean colour (red is NOT colour here — see hair) | — |
| colour | contrast | area-weighted mean |rgb(part) − rgb(parent)| (how the renderer blends parent→child, viewer:1223) | — |
| texture | hair | Σ length·width·red / Σ length·width (renderer grows cilia only where red > 0.01, length ∝ width·red, viewer:1245) | — |
| motion | freq | phenotype.frequency | — |
| motion | amp | mean |part.amp| | — |
| motion | turn | mean |part.turnAmp| | — |

Dropped vs v1: `aspect` (≈ f(length, width)), Σlength (overstates bushy bodies; replaced by reach), raw `red`
(it is primarily a hair/texture control in the renderer). Transforms use **sqrt only**: IEEE-754 requires correctly
rounded sqrt, every engine implements it so, and the engine already relies on it (pmath.js, topology.js); `Math.log`,
`exp`, `pow`, `hypot` are banned in the plate path (not guaranteed identical across engines).

**Fixed-point storage (review B2):** each feature is stored as an integer `Math.round(f × 2^16)` at computation time.
Running sums of integers stay far below 2^53, so memberAdd/memberRemove cancel **exactly** (same guarantee the gene sums
rely on, species.mjs:92) → a fresh analyzer (scrub/restore/resume) and a long-running one hold identical sums.

### 3.2 Species feature mean + crawl
`assigned` changes from `sb → tid` to `sb → { tid, feat }` (feat = the creature's fixed-point feature vector, computed once
at assignment; membership is fixed at birth). Per lineage keep integer `sumFeat` (add at assignment, subtract the cached
vector at removal). `emaFeat` = EMA(SIG_EMA) of the lineage mean → `t.sig = plateOf(emaFeat)`. Population: pooled sums →
`popFeatEMA` → `popSig`. Projection is linear after the per-creature transform, so a species plate is the centre of its
members' plates. `plateOf(vec)` is the pure function (R2); the displayed lineage plate additionally gets **letter
hysteresis** (§3.4) — it is inherently history-dependent anyway (EMA crawl), exactly as today.

### 3.3 Frozen basis (trained once, then constants)
New `tools/plate/train-basis.mjs`: for every champion pool (226 today; current engine + settings), run the analyzer, take
each species (≥5 members) **mean feature vector** (what a plate encodes). Then: `FEAT_MEAN`, `FEAT_SD` (z-score) →
**group weights** `w_g = 1/√n_g` per feature so each visual group (size, shape, structure, colour, texture, motion) carries
equal total variance → PCA (power iteration + deflation, dependency-free) → top-5 `PLATE_COMPONENTS` (sign: largest-|element|
positive) → project the training set → per-component **empirical quantile thresholds** (35 per component, the k/36
quantiles of the training projections; review: counts/depth are skewed, so PC scores aren't normal). Emits a literal
constants block spliced into body-features/species (like emit-const). Reports variance explained by PC1..5 (the old
"2 body axes ≈ 50%" came from a different feature set on main-species individuals — not evidence; measure fresh).

### 3.4 Encoding (fixes the wrap-around problem)
coordinate `z_c = featW · comp_c` → symbol index = number of that component's **literal-constant** thresholds below
`z_c` → 0..35, **monotonic** (low→`0`, high→`Z`, training median ≈ `H`/`I`), flat histogram over the training species by
construction, **comparisons only** (no erf/exp/log; the thresholds are emitted as numbers, never computed at load time).
Neighbouring values → neighbouring letters. `SIG_AMP`, `erf`, `normCDF` and the old PCA constants are deleted.
**Hysteresis** for the crawling lineage/population plates: keep the last index per position; move to a new index only when
`z_c` clears the bin boundary by ε = 0.25 × that bin's width (bins near the centre are narrow, so EMA crawl would otherwise
flicker centre letters). `plateOf()` (pure, no hysteresis) is what the atlas and tests use.

### 3.5 Barcode colours (viewer) — ONE shared helper
Both plate painters must change together: `plateHTML` (viewer:1564, DOM barcode) **and** `drawInfoOverlay`
(viewer:1968, the plate burned into recorded video), which duplicates the old signed/wrap decode. Replace both with one
`plateHue(ch)` = linear ramp over index 0..35 (red 29 → green → blue 264, no wrap, no magenta). Similar plates → similar
barcodes; extremes don't collide.

### 3.6 Diversity + gene range
R2 spirit: fixed definition. Diversity stays **genetic** (it's a genetic-diversity gauge) but over the coding genes that can build or run a body under R3,
`[0, 110)` (was [0,83)); genes 110–111 (food type) are inert with one food type and would drift like junk and inflate it. The `EXPRESSED` export is removed; the atlas "typical body" pick switches to the
body-feature mean (consistent with the plate). Numbers shift once; nothing stored depends on them except `div` in future
timelines' stats rows.

### 3.7 Performance
Features: 1 embryology + O(parts) per new creature (~6–10 µs). Restore/scrub of a 2000-pop world: ~15 ms once. Birth
rate is tiny. Optional optimisation (only if measured necessary): reuse `sb._phenotype` when the run's config already
has `fixBranchCategoryGene === true` (identical decode). Default: always decode with PLATE_DECODE (one code path;
the atlas stand-ins have no phenotype anyway).


## 3.8 v3 engineering amendments (5-lens review — supersede earlier sections where they conflict)
**Determinism**
- Every mean over a possibly-empty set (splay, symmetry, amp, turn, …) is defined as 0 when empty; the root part 1 is NOT
  a branch base. `Number.isInteger` asserted on every fixed-point value before memberAdd (a NaN would poison sumFeat
  forever). Feature vectors stored as `Float64Array` of integers (×2^16 can exceed int32).
- **R2 applies to `plateOf(featureVector)` only** (pure, identical everywhere; golden-tested in Node + a JSC/SpiderMonkey CI
  job alongside the pmath matrix, pinning both the integer feature vectors and the plates). Displayed lineage plates are
  history-dependent, as today: lineage partition depends on assignment order/SPECIES_K, so a scrub-restored analyzer can
  group differently from live play. §4.4 narrowed accordingly (same member set → same plate).
- **Drop the EMA for plates.** The viewer recomputes per FRAME, so an EMA crawl rate depends on vsync/speed. Plates show
  `plateOf(exact integer mean)` with hysteresis only (stateless across frame rates). Body means move slowly, so no crawl
  is needed for smoothness. (Diversity/lifespan EMAs unchanged.)
- Thresholds: `idx = count(th < z)` (strict); duplicate thresholds nudged to distinct midpoints; hysteresis ε for the two
  half-infinite end bins = the neighbour bin's width. Hysteresis state lives on the lineage object (dies with it), resets
  on analyzer creation, never stored.
- Emit constants with shortest round-trip `String(x)`; fold mean/SD/weights/components into ONE coefficient matrix + offset
  with a fixed summation order; compute the training quantiles by calling the runtime `coordsOf()` on the emitted literals.
- Initial plate is `null` (not `'00000'`, which now means "minimum everywhere"); `plateHTML`/`drawInfoOverlay` render null
  as blank cells.

**Visual efficacy**
- Same-pool species are near-duplicates (median z-distance 0.51 vs 4.57 across pools) → the ~1235 species ≈ 215
  independent points. **Weight each pool equally** (1/n_species) in mean/SD/PCA/quantiles; **train on 70% of pools, validate
  on held-out pools + new hunt pools**; every nearest-neighbour check excludes same-pool pairs.
- **Training set includes early-run snapshots** (founder-era and ~0.05-day populations from a set of seeds), so founders,
  young runs and the main-view plate at t≈0 don't saturate to `0`/`Z`.
- Features added: width spread (sqrt max/min width), limb fraction (branch-chain length / total length), curl (mean
  |angle| between consecutive parts). branches/depth/segs replaced or length-weighted (a tiny twig ≠ a big limb). hair =
  hairy perimeter × red (cilia sit on edges/caps). Colour group weight reduced (the shader lightens/desaturates hue) —
  final group weights tuned on the triplet test, then frozen.
- Report eigenvalue gaps and bootstrap stability over pools (|cos| of components) before freezing; if PC4/PC5 aren't
  stable (> 0.8), say so (5 positions may exceed what the data supports).
- **Validation replaced (§4.1):** render each validation species at a FIXED zoom (keeps size), 8 phase frames + rest pose;
  pose-invariant descriptors (frame-averaged mask radial histogram, area, perimeter²/area, pixel colour) + a motion
  descriptor (mean silhouette IoU change between frames). Spearman ρ ≥ 0.4 (plate vs descriptor distance, cross-pool pairs
  only), new vs old. **Human triplet test** on held-out pools ("which of B or C looks more like A?"): plate agrees with
  Karl ≥ 70%, old plate ≈ 50%.

**Performance** (measured): decode ≈ 3.2 µs + ~14 KB garbage per creature; today's post-restore full assignment already
17–24 ms at pop 2000. → **Reuse `sb._phenotype` whenever `config.fixBranchCategoryGene === true`** (safe: nothing writes
genetic part fields after decode; only that flag changes the body) — fresh decode only for fix-off runs and atlas
stand-ins; a test asserts reused == fresh features. Feature code uses module-level scratch buffers (allocate only the
final vector). Per-frame recompute cost ≈ unchanged (±0.1 ms). run-gen listed as a consumer; generator throughput
measured in step 7 (must not regress — flat-out rule).

**Integration**
- `assigned` → `{tid, feat}` touches `speciesIdOf` (species.mjs:169 — viewer compares with `===` at 1639/2026/2147/2198 +
  selection.visual.mjs), `foldDeath` (:155) and the removal loop (:117): all use `.tid`.
- Atlas `build-page` reads `face.body.parts` + z-scores `A.features` → keep a raw `parts` field on faces / update page.
- `popUsedEMA` getter removed/renamed; stale "PCA signature" comment (viewer:1383); header comments (species.mjs:18–30,
  analyze-pools:3–6); docs/pca-plate-basis.md replaced; historical plans left with a note.
- **Diversity range change DESCOPED** from this plan (it would make `div` jump mid-timeline in resumed runs and needs
  DIV_MAX recalibration). Diversity stays as-is; revisit separately if wanted.

## 4. Validation (must pass before shipping)
The plate is a projection of the body features, so "plate distance vs feature distance" is circular (review B5) and is
NOT used as evidence. R1 is judged on measures **independent of the features**:
1. **Pixel-derived shape descriptors** from the rendered atlas faces (tools/atlas/render-specimens.mjs output): rotation-
   invariant silhouette measures computed from the images (area, perimeter²/area, radial-extent histogram, Hu moments of
   the mask, mean body colour from pixels). Spearman ρ between plate distance and image-descriptor distance, **new plate
   vs old plate** on the same species. Target: new ρ clearly above old.
2. **Nearest-plate contact sheet** (the real test): ~12 random species, each beside its 3 nearest-plate species (faces +
   plates) → I inspect, then Karl eyeballs. Also the reverse: 3 random far-plate pairs to show they look different.
3. **Uniformity**: per-position symbol histogram over all species ≈ flat (true by construction on training data; check on
   species from pools not used for training, e.g. new hunt pools).
4. **Determinism**: two analyzers agree; frozen golden plates for a few E1-corpus genomes; neutral (median) features →
   `H`/`I` in every position; raising one PC coordinate never lowers its letter; a scrub-restored analyzer gives the same
   `plateOf` values as a long-running one (fixed-point sums).
5. **Sim untouched**: full core suite + visual goldens pass unchanged (plates are observer-only).

## 5. Steps
1. `tools/plate/train-basis.mjs` + feature extraction module `engine/analysis/body-features.mjs` (shared by analyzer,
   trainer, atlas). Train; inspect variance explained.
2. species.mjs: features-at-assignment, `sumFeat`/`emaFeat`, `plateOf`, quantile encoding, diversity over [0,112),
   remove old PCA constants/EXPRESSED/SIG_AMP/erf.
3. viewer: shared `plateHue` used by `plateHTML` AND `drawInfoOverlay`; check `__golden` meta.
4. atlas: `analyze-pools` switches to the SHARED `body-features.mjs` (its private `bodyFeatures` has the part-0/taper
   bug and would make map + families disagree with plates); face pick = member closest to the species feature mean; refresh atlas.
5. Tests: update species.test (neutral genome → middle symbols; format), add plate golden strings + monotonicity test.
6. Validation §4; docs: replace docs/pca-plate-basis.md with docs/body-plate-basis.md; retire tools/pca (keep in git history).
7. Rebuild the desktop app (standing rule): `desktop/dist/...` holds a stale copy of species.mjs until rebuilt.

## 6. Risks / open questions
- **Fix-off runs exist:** the browser viewer and visual goldens call makeStandardWorld with no settings, and run-gen sets
  the fix only with `--fix` (review). In those runs the plate describes category-3 limbs that are not grown/rendered.
  Accepted under R3. **Open question for Karl:** should category 3 simply be ON everywhere (browser viewer, goldens,
  CLI default), so "always enabled" is literally true? (Changes those runs' trajectories + goldens — separate change.)
- **Basis trained on our 226 pools only** (current settings). A coordinate system — fine — but body plans far outside the
  training cloud saturate to `0`/`Z`. Retrain = new plate epoch.
- **Every plate changes** once (accepted: no backward compatibility). Timelines store no plates → nothing to migrate.
- **Optimisation (only if measured necessary):** reuse `sb._phenotype` when the run's config has the fix on — genetic part
  fields appear immutable after create() (swimbot.js:188-237) but growth must be confirmed not to rewrite length/width.
  Default: always decode (one code path; ~130 allocations/decode, ~6 µs).

## 7. Review log
- **Review #1 (1 agent):** B1 part-0/taper undefined → skip root, trunk-chain taper. B2 float sums don't cancel →
  fixed-point integer features, `assigned` caches `{tid, feat}`. B3 thresholds must be literal constants; drop erf/exp.
  B4 missed consumer `drawInfoOverlay` → shared `plateHue`. B5 circular R1 metric → pixel-derived descriptors + contact
  sheet. Significant: added splay/symmetry/hair/parent-child contrast/reach, dropped aspect/Σlength/raw red; group
  weights; empirical quantiles; hysteresis; diversity [0,110); fix-off runs stated; atlas uses shared module.
- **5-lens review:** determinism (NaN on empty means; R2 scoped to plateOf; per-frame EMA → dropped; strict/deduped
  thresholds; round-trip constants), visual efficacy (pool-level dependence → pool weighting + held-out validation; early-
  run training data; width spread/limb fraction/curl; colour down-weight; fixed-zoom multi-frame + triplet validation;
  eigen-stability), integration (`.tid` at 3 more sites; atlas `parts`; null default plate; diversity descoped),
  performance (no blockers; reuse `_phenotype` when fix on; scratch buffers), product (questions → §8).

## 8. Product questions for Karl (must answer before build)
1. Sister species (fresh junk-DNA splits) start with the same body → may share a plate. OK ("same body, same plate")?
2. Monotonic axes are learnable (PC1 ≈ size → "first cell blue = big"). Apply a fixed random rotation of the 5-D subspace
   so no single cell maps to one trait (distances unchanged)?
3. Letters: equal-quantile per position (flat, best as an ID) vs one shared scale (weak axes use middle letters; letter
   differences track similarity better). Recommend: shared scale.
4. Plates will be steady (barely move within a run). OK, or should they visibly crawl as a species evolves?
5. Main-view population plate = average of all bodies (a creature that doesn't exist). Show the dominant species' plate
   instead?
6. Make category 3 ON everywhere (browser viewer, goldens, CLI default), so "always enabled" is literally true?
