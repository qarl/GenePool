# Species plate = PCA basis (how it was built, and how to rebuild it)

The 5-symbol species "license plate" in `viewer-micrograph-gl.html` is the genome **projected onto the 5 principal
components of evolved expressed-gene space**. Each digit is the coefficient along one orthogonal axis of real variation —
not an arbitrary raw gene. The axes are **fixed baked constants**, so the same genome yields the same plate in any pool:
a *universal* species ID. (Earlier plates were arbitrary raw-gene samples, or would have been run-dependent — rejected
because a species must keep its identity when pools are mixed.)

## What genes it spans — and the dead-gene caveat
The basis is computed over the **EXPRESSED** genes `[0, EXPRESSED)` = **[0, 83)** only, NOT the full coding region
`[0,112)`. Genes `[83,112)` are decoded but never expressed, so they drift like junk and carry no structure:
- **83–109** = body-part **category 3**, never selected (JJ's off-by-one: `branchCategory = floor(3·gene/256)` tops out
  at 2; he bumped `NUM_CATEGORIES` 3→4 but the `/256`-vs-`/255` bug leaves the 4th category unreachable). See
  `engine/embryology.js:100–139`.
- **110–111** = food-type preferences, only read when `numFoodTypes === 2`; the viewer hardcodes **one** food type.

⚠️ **If those genes are ever turned back on** (category-3 bug fixed, or two food types), the expressed region changes and
**this basis is INVALID** — it must be regenerated (see below), and `EXPRESSED` raised in the viewer.

## How the basis was built
1. **Dataset** — 100 seeds (**1…100**), each the viewer's *exact* world (pool 3000², 220 junk-zeroed founders, 700 food,
   `reproductiveIsolation 0.9`, one food type), run **200k ticks** (fully speciated; ~5 stable species by 30k). From each
   run, take the **most-representative individual** (member closest to its expressed-gene centroid) of **every species
   with ≥5 members**. → **1,561 genomes** across the 100 lineages.
2. **PCA** — over the expressed genes `[0,83)`: subtract the mean, form the covariance, take the top-5 eigenvectors by
   power-iteration + deflation. Sign convention: each vector's largest-|element| is positive (reproducible).
3. **Bake** — mean + 5 component vectors + per-component projection std, emitted as JS constants into `signatureOf`.

## The result (why 5 digits, and their limit)
The evolved-genome space is **near-isotropic** — variance is spread ~evenly across the ~83 genes, no dominant axes:

| top-N components | variance captured |
|---|---|
| 5  | **19.6%** |
| 10 | 35% |
| 17 | 50% |
| 20 | 55% |

So five digits are an **intentional lossy fingerprint** — but they are the *best possible* 5 (a ~3× improvement over 5
arbitrary genes), and the projection onto max-variance axes is also the optimal 5-dim *discriminator*. Karl's call: keep
5, and the best 5 are the best.

## Encoding (in the viewer)
`sigCoord(vec,i)`: `coeff = (vec − PCA_MEAN) · PC_i`, standardise, take the **signed percentile** `p = 2(Φ(coeff/scale) −
0.5) ∈ [-1,1]`, **amplify** `× SIG_AMP` (=1.5) and **CLAMP** to `[-1,1]` — a linear, non-wrapping coordinate (0 = mean).
`signatureOf` maps it to base36 steps `[-17,17]`: **mean → "00000"**, above-average climbs `1,2,3…H`, below descends
`Z,Y,X…J` (clamped — NOT a ring; the antipode gap `I` is never produced, and extremes pile at `H`/`J` rather than
wrapping). Amplification (Karl: "make them stronger") clamps ~⅓ of digits at the extremes — intentional.

**Colour = a LINEAR ramp, not the hue wheel** (the wheel is a ring: red would wrap back through magenta). Each cell's hue
sweeps monotonically **red (29°, −1) → green (146°, 0/mean) → blue (264°, +1)** in OKLCh at fixed L/C and stops — the
magenta arc (~330°) is dropped. So colour reads directly as below/at/above average. `hue = 29 + (v+1)·117.5`.

Two requirements that seem to conflict but don't in practice: "mean = 00000" and "no species near 0" — the percentile +
amplification push every real species far from the origin; only a genome *exactly* at the mean on all 5 axes reads 00000,
which no real species is. Mean → 00000; on the 1561-genome set, 0 plates near-0, ~98% distinct.

## Regenerating the basis (`tools/pca/`)
```
DIR=/tmp/pca-data
node tools/pca/run-batch.mjs 100 200000 $DIR 10     # 100 seeds x 200k ticks, 10-wide (~25 min on 10 perf cores)
node tools/pca/pca.mjs $DIR 5                        # PCA -> $DIR/basis.json + variance report
cp $DIR/basis.json tools/pca/basis.json             # keep the provenance artifact
node tools/pca/emit-const.mjs tools/pca/basis.json /tmp/pca-const.js   # emit the JS const block
# then paste PCA_MEAN / PCA_COMPONENTS / PCA_SCALES from pca-const.js into viewer-micrograph-gl.html's signatureOf block
```
If `EXPRESSED` changed, update it in both `tools/pca/extract-seed.mjs` and the viewer first. `tools/pca/basis.json` is the
committed provenance of the current baked constants.
