# Body plate basis (species "license plate", v2 — 2026-09-29)

The 5-symbol plate describes a species' average **body**, not its genes (full design + review log: `docs/PLAN-body-plate.md`).

- **Features** (`engine/analysis/body-features.mjs`): 18 numbers read from each creature's decoded body — always decoded
  with category 3 on (`PLATE_DECODE`), genetic part parameters only (never pose) → a pure function of the genome.
  Groups: size (reach, segs), shape (width, widthSpread, taper, cap), structure (limbFrac, branches, depth, splay,
  symmetry), colour (green, blue, contrast), texture (hair = red-driven cilia), motion (freq, amp, turn). Stored as
  fixed-point integers (×2^16) so the analyzer's running sums add/remove exactly.
- **Basis** (`engine/analysis/plate-basis.mjs`, generated): weighted PCA over species mean features from every champion
  pool (each pool weighted equally; 30% of pools held out) + early-run snapshots; top 5 axes (≈67% of body variance)
  → a fixed random ROTATION (no single cell readable) → one shared set of 35 letter thresholds (monotonic 0…Z).
- **Encoding**: `coords = W·meanFeat + B`; letter = number of thresholds below each coord. Only + − × ÷ √ round and
  comparisons → identical on every machine. Displayed plates add letter hysteresis (no flicker); `plateOf()` is pure.
- **Validation** (`tools/plate/validate.mjs`, held-out pools, picture-derived descriptors independent of the features):
  Spearman ρ(plate distance, picture distance) NEW 0.28 vs OLD gene plate 0.006; contact sheets + a triplet page.
- **Retrain** = a new plate epoch (all plates change): `node tools/plate/train-basis.mjs`, then update the golden plates
  in `test/analysis/plate.test.js`.
