# PLAN — engine-independent, architecture-independent determinism

> **STATUS: BUILT & GREEN (2026-09-24, epoch `pmath-1`).** 9 sites swapped to `engine/pmath.js` (frozen 1024-LUT
> `psin`/`pcos`, exact-integer `ppow2`, `phypot`). Proven: neutrality (passthrough == pre-swap baseline
> bit-for-bit) and cross-engine identity (system node V8 14.1 == app Electron V8 15.2, vector
> `a663a0fe 4d0842ea 39536da7`). JJ fidelity preserved via a per-test-process `Math` shadow (JJ source
> untouched). Full suite 383 pass / 0 fail. Cross-engine golden + CI matrix (Node 22/24/latest + macOS arm64 +
> required Electron job) added. Engine hot-swapped into `~/Desktop/GenePool.app`. Uncommitted pending Karl's ok.
> Deferred (clean-slate, no gate needed): wiring `ENGINE_EPOCH` stamping into run-gen/generator — a future-epoch
> nicety, not needed now.


## Goal (Karl)

> "i want this to be engine independent. architecture independent."
> "let's go with the fastest implementation, we don't actually need the accuracy. we just need identical
> behavior run to run."

Make the sim produce **byte-identical** keyframes on any JS engine (any V8 version, any other engine) and any
CPU architecture. The ONLY invariant is reproducibility (run-to-run and machine-to-machine). **Numerical
accuracy vs real `sin` is explicitly a non-goal** — a crude-but-frozen approximation is correct as long as it
is identical everywhere and looks acceptable.

## Root cause (measured)

IEEE-754 pins `+ − × ÷` and `sqrt` to the last bit on every engine/CPU; it does NOT pin the transcendentals.
Confirmed empirically 2026-09-24: seed 7 × 4000 ticks → snapshot-hash `c398c3af…` under system node
(V8 14.1.146.11) vs `979a1ec6…` under the app's Electron (V8 15.2.124.19); each engine reproduces *itself*
bit-for-bit (control passed). The entire engine is already portable EXCEPT **9 call sites**:

- `engine/swimbot.js:308,309,338,350,351` — 3× `sin`, 2× `cos` (heading + body-part bending, per tick).
- `engine/pool-seed.mjs:17` — `sin`,`cos` in `diskPoint` (founder placement).
- `engine/world.js:533` — `pow(2, x)` in the evolvable-mutation-rate path.
- `engine/obstacle-field.js:130` — `hypot` in a grid-ring bound.
- (`engine/analysis/species.mjs:53` — `exp`; ANALYSIS/stats only, not the trajectory. Fix for tidiness, low
  priority; it does not affect run bytes.)

Call rate (seed 7): ~4,073 `sin` + ~2,268 `cos` per tick = transcendentals are **~22% of tick time**; `pow`
~0.02/tick, `hypot` ~0/tick (implementation irrelevant for those two).

## Design

### New module `engine/pmath.js` — frozen, portable, runtime uses ONLY correctly-rounded ops

- **`psin(x)` / `pcos(x)` = frozen LUT + linear interpolation.** Table of N = 2^k entries over [0, 2π).
  - Runtime: `t = x * (N/2π); i = floor(t); f = t - i; idx = i & (N-1); return T[idx] + (T[idx+1]-T[idx])*f;`
    Only `* + - floor &` — all portable. `pcos(x) = psin(x + π/2)` with a table of size N+1 (guard entry).
  - **Fastest table size chosen by bench** (accuracy is a non-goal): bench showed N=4096 (4.77 ns) beat native
    (6.68) and beat larger tables (cache). Re-bench 256/1024/4096 and pick the fastest; linear interp stays
    because it was already faster than native (no reason to drop to nearest-neighbour). Target: ≤ native
    ns/call and ~0% tick-time delta (measured −0.4% at N=65536; expect ≤0 at N=4096).
- **`ppow2(x)` = 2^x**, portable. `x` here is a small real. Simple: `2^i` exact via repeated mult / `x*LN2`
  path is banned (needs exp). Use `2^i` (i=floor(x), exact by multiplying/dividing 2s or a tiny power table)
  × `2^f` (f∈[0,1), a short frozen poly or a tiny LUT). Rare call → correctness-simple over fast.
- **`phypot(a,b)` = `sqrt(a*a+b*b)`** — `sqrt` is correctly-rounded/portable; inputs bounded (≤~216) so no
  overflow. It's inside `ceil()+1`, so the integer result almost certainly doesn't even move.

### The frozen table must reconstitute bit-identically everywhere (KEY SUBTLETY — for review)

If the table is computed at load via `Math.sin`, we're right back to engine-dependence. It must be **frozen
data**. Two ways, panel to pick:
1. **Store raw IEEE bits** (a `Uint8Array`/hex/base64 buffer decoded via `DataView.getFloat64`) — guarantees
   exact reconstruction, zero reliance on decimal parsing.
2. **Store decimal literals** and rely on spec-mandated correctly-rounded decimal→double parsing (all engines
   comply) — simpler, but (1) is the belt-and-suspenders choice. Recommend (1).
   The table is generated ONCE by a committed build script (`tools/pmath/gen-table.mjs`) and checked in; the
   generator's own math never runs at engine runtime.

### Range reduction (for review)

`x` can be large and negative: `bendRadian = timer*freq + phase` grows with `timer`; `angle*π/180` for
arbitrary `angle`. `i = floor(t); idx = i & (N-1)` handles wraparound and negatives IF done on a value coerced
to a 32-bit int correctly (`& (N-1)` forces int32; negative `i & mask` yields the correct non-negative index
in two's-complement for power-of-2 mask — verify). Precision of `x*(N/2π)` degrades for very large `x`; bound
`timer` growth or pre-reduce `x` mod 2π with a portable step. Panel: confirm the largest real `x` seen and
whether int32 masking is safe for it.

### Swap the 9 sites

Import `{ psin, pcos, ppow2, phypot }` and replace the calls. Keep `PI_OVER_180` etc. (literal constants,
exact). No other logic changes.

## The meta-fix — a cross-engine determinism test (the gap that let this through)

Our determinism tests run on ONE engine, so they only ever proved *intra-engine* reproducibility. Add:
- A **committed golden hash** of a canonical run (seed 7, fixed ticks, snapshot-byte sha256) produced by the
  portable code. `test/engine/portable-determinism.test.js` recomputes it and asserts equality — so ANY engine
  the test runs on must match the frozen hash. This makes engine/arch-independence a *tested invariant*.
- A CI matrix across ≥2 Node majors (and ideally the app's Electron) running that test, so a divergence fails
  the build. Document that the visual/render goldens are a separate axis (renderer already integer-hash noise).

## Consequences (state plainly)

1. **One-time epoch shift.** `psin ≠ Math.sin`, so every number shifts. This splits into two DIFFERENT things
   that must NOT be conflated (per the product panel):
   - **Our test goldens** (engine + visual fixtures) — *our* artifacts. Regenerate freely in the epoch commit;
     no consent needed. (Genome-decode + genetics oracles `e1`/`e2` are trig/pow-free and DON'T move.)
   - **Karl's evolved runs** (the 50 seeds; the named timelines fans/gliders/kelp/mosquitos/pills/arena) —
     *his* data, evolved over hours. **NON-DESTRUCTIVE BY DEFAULT.** New-epoch runs get the epoch stamped so
     they land BESIDE the old ones; old runs stay on disk and stay playable under the old engine. Nothing of
     his is overwritten or swept. Karl decides, per run, which to re-grow vs. keep as legacy (see Q2). This is
     the moment to finally do content-addressed run storage so a config/epoch change never nukes his runs.
2. **Performance: ~0** (measured −0.4%; a small LUT is ≈ native). Re-confirm after wiring with the perf bench.
3. **Supersedes the CLI's engine-pin.** `PLAN-generator-cli.md` V1 required spawning the app's exact Electron
   to stay deterministic. Once the engine is portable that pin is UNNECESSARY — any node produces identical
   runs. Keep `engineVersion` stamping but its value becomes the *pmath epoch* ("pmath-1"), not the V8 version;
   resume across epochs (native→pmath) refuses/`--force`. Update the CLI plan after this lands.

## CLEAN-SLATE decision (Karl, 2026-09-24) — SUPERSEDES all migration machinery below

Karl: *"delete all the old seed files… nevermind about worrying about mixing engines. remove all the
timelines — i hate backward compatibility when it's not needed."* DONE — all 50 seed dbs + 6 custom timelines
deleted (~34 GB). Consequence: **there is no old data to protect, so the entire epoch-gate / migration layer
is DROPPED:**
- ❌ per-operation cross-epoch gate table (drag/play/resume/edit) — not needed.
- ❌ `commitParamEdit`/`commitImport` cross-epoch refuse/re-stamp (EB2) — no pre-epoch dbs exist.
- ❌ `startRun` cross-epoch flag / banner / snap-only playback — nothing old to play.
- ❌ non-destructive filename stamping / "beside the old ones" coexistence — nothing to coexist with.
- ❌ resume-refusal gate in `openRunWriter` — no mixed dbs possible.
- ✅ KEEP a lightweight `ENGINE_EPOCH='pmath-1'` stamp on new runs (near-free, future-proofs the NEXT epoch and
  ties to the table hash) — but with NO enforcement gate.
- ✅ KEEP everything about the actual portability fix + its proof: pmath module, 9-site swap, the cross-engine
  golden + CI matrix (incl. Electron + W=1/W≥2), the load-sim Math-shadow, PMATH_PASSTHROUGH neutrality proof,
  regenerating OUR test goldens.

So the build shrinks to: **pmath module + swap 9 sites + fidelity Math-shadow + cross-engine golden/CI +
regenerate our goldens.** No app-side gate, no migration. Rollout below is simplified accordingly.

## Panel synthesis (5 lenses) — FINAL spec (supersedes conflicts above)

**Verdict across the panel: the approach is sound and the numeric core is airtight by ECMAScript mandate**
(FMA/x87, signed-zero, subnormals, `toString`/parse round-trip, ToInt32 masking, mulberry32 all verified
portable *by spec*). The 9-site inventory is independently confirmed complete; no hidden trig; heading
non-unit-length is inert; no assert is trig-coupled; parallel inherits the swap for free. Blockers are all in
the *scaffolding* (tests, epoch gate, CI), not the math. Folded decisions:

### Must-haves folded in
- **PB1 (numeric):** the cross-engine golden must ALSO pin the **parallel worker count** (assert same hash at
  W=1 and W≥2) — core-count is the real "different CPU" axis (FP `+` non-associative). Reductions stay
  fixed-index-order.
- **FB1 (tests/CI):** CI must run a **genuinely different V8 as a REQUIRED job** — an
  `ELECTRON_RUN_AS_NODE=1 electron canonical-run.mjs` step (the exact V8 line that diverged), plus a Node
  matrix (22/24/latest) and a macOS/arm64 arch axis. A committed hash under one engine only re-proves
  intra-engine reproducibility — the *matrix* is what closes the gap.
- **FB/S: keep `jj-macro-seed42.json` NATIVE and protect its input half.** It's DUAL-PURPOSE: its
  `init/config` is a trig-free founder corpus read by 6 consumers *and the parallel engine's GENES source* —
  do NOT regenerate that. Only `world-macro-fidelity.test.js` reads its aggregate golden, and that's a
  TOLERANCE test (bands 10–40%, self-documented "not bit-exact") → it survives; if a band trips, refresh ONLY
  the `points`/`avgPop`/`avgFood` aggregates. Keeping it native makes it the cross-basis anchor proving the
  portable engine still tracks *native-JJ's* real ecosystem within tolerance. (Corrects R1-N8: only
  `swimbot-fidelity` + `swimbot-mating` genuinely break.)
- **EB1 (rollout):** the **epoch stamp + version gate ships in the SAME release as the swap** — NOT a
  follow-up. Otherwise the app resumes/plays existing native dbs under pmath and silently mixes epochs.
- **EB2 (rollout):** `commitParamEdit`/`commitImport` must **refuse or re-stamp** on a cross-epoch db (they
  keep old keyframes + re-sim forward → mixed file).
- **B2 (hashing):** golden = `sha256` over a **field-walk of `world.serialize()`** (clock, nextIds,
  foodRegen, ghosts — everything), NOT gzip (zlib not portable) and NOT bare `JSON.stringify` (maps
  NaN/Inf→null, colliding broken states); assert every serialized double is finite. Hash a **checkpoint
  vector** (ticks 100/1000/4000) to localize first divergence.
- **B1 (faithfulness — KARL):** resolve by **shadowing `Math` in the `load-sim.js` vm sandbox**
  (`Math.sin/cos/pow = psin/pcos/ppow2`) — vendored `simulation/` is confirmed oracle-only, so JJ's files stay
  byte-identical and nothing leaks to the shared global. Keeps the A/B green, now certifying algorithmic
  faithfulness under shared trig. **Needs Karl's yes (Q1).**

### Design refinements folded in
- `export const ENGINE_EPOCH = 'pmath-1'` lives in `engine/pmath.js` (table + epoch label together).
- **Decimal-literal table** (dodges endianness); generator emits shortest-round-trip literals only, with a
  per-entry `Number(literal)===original` check + a committed `sha256(table)` assertion tied to the epoch.
- **`ppow2` must be EXACT at integer exponents** (`2^i` by halving/doubling) so the mutation contract
  (1@0, 2@+64, 0.5@−64) and the `>1→clamp` boundary are unchanged; unit-test asserts exactness.
- `phypot = sqrt(a*a+b*b)`; add a one-line **grid-superset assertion** (candidates ⊇ brute-force hits over the
  obstacle suite) since `phypot ≤ hypot` could shave a ring at an exact boundary.
- **PMATH_PASSTHROUGH** neutrality switch (routes psin→Math.sin, etc.): with it on, the swapped engine must
  reproduce the archived **pre-epoch** golden bit-for-bit → proves the swap changed ONLY trig values, no logic.
  Keep it env-gated as a permanent regression guard.
- Whitelist the portable `Math.*` already in the trajectory (`round/trunc/abs/min/max/PI/sqrt`) as known-safe
  so no one mistakes `Math.round` in the torus path for a 10th site. Verify the render `Float32Array` SoA is
  write-only (no `fround` read-back into state). The parallel SAB is endianness-exempt (transient in-memory;
  only serialize() JSON is hashed). No `-0` table entries.
- Orphan fixture `test/fixtures/golden/seed42-t2000.json` has no consumer — delete or ignore.

### Per-operation epoch gate (cross-epoch = stored `engineVersion` ≠ `ENGINE_EPOCH`; null ⇒ "pre-epoch")
| Operation | Same epoch | Cross-epoch (incl. pre-epoch) |
|---|---|---|
| Play — drag/snap (deserialize keyframe) | allow | **ALLOW** (pure stored bytes, epoch-independent) |
| Play — playing (re-sim between keyframes) | allow | **REFUSE forward re-sim** → snap-only + one-time banner |
| Scrub (slider) | allow | snap = allow; motion follows the play rule |
| Resume (write new keyframes) | allow | **REFUSE by default**; explicit `--force` re-stamps + accepts the seam (loud) |
| Branch-edit (commitParamEdit/Import) | allow + stamp | **REFUSE by default**; force → re-stamp + warn surviving keyframes predate the engine |

Old (null-epoch) dbs: treated read-only by default. **No directory sweep, no auto-rewrite** — nothing is
written to an old db unless Karl explicitly resumes/edits/regenerates it. This is what makes the rollout
**reversible** (revert engine + gate = plain code revert; every native db still valid).

## Rollout / commits (final sequence — clean-slate)

1. **`engine/pmath.js` + `tools/pmath/gen-table.mjs` + unit tests, UNWIRED.** psin/pcos/ppow2/phypot,
   `ENGINE_EPOCH`, table-reconstruction + `sha256(table)` + ppow2-exactness + range-reduction tests, ns/call
   perf assertion (pick fastest table size), PMATH_PASSTHROUGH. Nothing imports it yet → zero behavior change.
2. **load-sim.js Math-shadow** oracle patch (Q1) so `swimbot-fidelity`/`swimbot-mating` stay green, now
   certifying algorithmic faithfulness under shared trig. (Q1 framing confirmed by Karl's clean-slate stance;
   confirm once.)
3. **The swap commit (atomic):** swap the 9 sites + apply the oracle Math-shadow + regenerate our regenerable
   test goldens (protect `jj-macro-seed42.json`'s input half; keep it native; only refresh aggregates if a band
   trips) + add the cross-engine golden test (serialize field-walk, checkpoint vector 100/1000/4000, W=1/W≥2)
   + the grid-superset assertion. Verify with PMATH_PASSTHROUGH == old baseline (neutrality) BEFORE regenerating
   goldens. Emit `ENGINE_EPOCH` on fresh runs (no gate). Full repackage + relaunch; bump appVersion.
4. **Regenerate seeds fresh** under the portable engine on the empty `timelines/` dir (Karl will say how many /
   which — clean slate, so just generate).
5. **Update `PLAN-generator-cli.md`:** strike V1's Electron-pin / V8-version gate (obsolete once portable);
   `engineVersion` becomes the `pmath-1` epoch tag. CI matrix design carries over.

## CI (final)
Matrix: Node 22 / 24 / latest on ubuntu + a macOS/arm64 job (arch axis) + a **REQUIRED** Electron job
(`ELECTRON_RUN_AS_NODE=1 electron test/engine/canonical-run.mjs`, the V8 that diverged). Each recomputes the
committed golden vector and the table hash. Golden filename carries the epoch (`portable-determinism.pmath-1`).

## Review 1 — folded findings (SUPERSEDES above where noted)

**Verdict from R1:** math design is correct and the range-reduction crux is SAFE; two blockers the draft
missed (a faithfulness-contract decision, and a gzip-hashing trap).

- **R1-B1 (BLOCKER, needs KARL) — the JJ fidelity tests are LIVE differentials, not regenerable goldens.**
  `test/engine/swimbot-fidelity.test.js` runs JJ's original `simulation/` swimbot (native `Math.sin/cos`)
  side-by-side with `engine/` and asserts bit-equality every tick; `swimbot-mating.test.js` and the
  `jj-macro-seed42.json` trajectory consumer are the same class. `psin ≠ Math.sin` → they fail on tick 1, and
  there's no fixture to "regenerate." This is a **faithfulness demotion**: from "bit-exact to JJ *including*
  native libm" to "bit-exact to JJ's *algorithm*, using our portable trig." Since native libm was never
  portable, this is arguably more honest — and Karl already said "we don't need the accuracy." Two resolutions:
  - **(preferred) patch the JJ ORACLE path to call pmath too** (the vendored `simulation/` copy is oracle-only
    — CONFIRM it's not used in production). Then the A/B stays bit-exact and green, now certifying algorithmic
    faithfulness under shared portable trig.
  - (fallback) retire/re-scope those trajectory differentials to a tolerance check.
  **Frozen science oracles `e1-decode.json` (genome→params) + `e2-genetics.json` (crossover+mutation) are
  trig/pow-free → they SURVIVE untouched.** Bring the (preferred) resolution to Karl for a yes.
- **R1-B2 (BLOCKER) — hash `world.serialize()` PRE-gzip, never `.db` bytes.** `run-db.mjs:35` gzips keyframes;
  zlib output varies by version/build → non-portable. The committed golden + any machine-to-machine check must
  be `sha256(JSON.stringify(world.serialize()))` computed before `encode`. `JSON.stringify` of doubles is
  spec-portable; gzip is not. Document that `.db` files are NOT cross-machine byte-comparable — only decoded
  keyframes are.
- **R1-S1 — range reduction is UNCONDITIONALLY portable; DROP the hedge.** `*`,`floor`,`-`,`&(ToInt32)` are all
  fully specified/bit-identical for ANY `x` (any magnitude, even >2^53/Inf — same "wrong" bucket everywhere,
  and accuracy is a non-goal). Delete "bound timer growth / pre-reduce x mod 2π" — it's needless churn. Negative
  `i & (N-1)` is correct two's-complement modulo (verified `-3 & 4095 = 4093`); keep unmasked `i` for `f=t-i`.
  Reachable ranges are tiny anyway (`|bendRadian|≲8000` default).
- **R1-S2 — FLIP to decimal-literal table (not raw bits); dodge endianness.** Raw `Float64Array(buffer)` is
  host-endian → would differ on big-endian. Decimal→double parsing is correctly-rounded by the SAME guarantee
  we trust for the golden hash, so it's as safe and simpler. If ever using raw bits, `DataView.getFloat64(o,
  /*LE=*/true)` explicitly. Derive `N/2π`, `π/2`, `PI_OVER_180` from `Math.PI` once (portable), don't hand-type.
- **R1-S3 — guard silent table regen = silent epoch fork.** Commit a `sha256(table)` assertion tied to
  `engineVersion="pmath-1"`; comment that regenerating `tools/pmath/gen-table.mjs` output is a deliberate epoch
  bump (mirror `gen-e1-oracle.js` discipline).
- **R1-S4 — `pcos(x)=psin(x+π/2)` is determinism-safe; heading is no longer unit-length** (`sin²+cos²≠1`).
  R1 checked swimbot asserts — none require unit-length/≤1 on a heading-derived value → SAFE. Document it so a
  panelist doesn't panic when positions shift.
- **R1-S5 — `ppow2` realistic exponent is `[-2, 2]`** (scale=64, int8 avg). `2^i` exact via halving/doubling,
  `2^f` a 3-4 term poly or 16-entry LUT; overflow→Inf→clamp≤1, underflow→0 both deterministic. Any frozen
  approx fine.
- **R1-N8 — golden blast radius (concrete).** *Regenerable in the epoch commit:* `test/fixtures/golden/
  p1a-tick-baseline-*.json`, `test/sim/golden.test.js`, `test/sim/p1a-golden.test.js`,
  `swimbot-motion-golden.test.js`, `world-snapshot-gates.test.js`, `commit-param-edit.test.js`, snapshot-
  asserting `test/io/run-*.test.js`, `test/visual/goldens/*.png` + `METADATA.json` (6 hashes). *Breaks, needs
  B1 first:* `swimbot-fidelity.test.js`, `swimbot-mating.test.js`, `jj-macro-seed42.json`. *Survives:*
  `e1-decode.json`, `e2-genetics.json`, science half of `science-fidelity.test.js`. *Timing only:*
  `test/visual/perf/baseline.json`.
- Confirmed no OTHER non-portable source: no `**`, `Math.random` not in trajectory (`mulberry32` integer-only),
  all `.sort()` total-order, Map/Set iteration deterministic or off the persisted path, `performance.now` gated.

## Open questions for the panel

- Table storage (raw-bits vs decimal) + range-reduction safety for the largest real `x`.
- Fastest table size given accuracy is a non-goal (bench 256/1024/4096; is nearest-neighbour ever worth it, or
  does interp stay free?).
- `ppow2` shape (exact-enough + simple) — does the mutation-rate path need any particular precision, or is any
  frozen approximation fine (it feeds a probability clamped to ≤1)?
- Does the visual-golden harness need regenerating too (sim positions move → yes), and what's the full golden
  inventory that must move in the epoch commit?
- Epoch/versioning: how to mark old (native-math) dbs so playback/resume doesn't silently mix epochs.
