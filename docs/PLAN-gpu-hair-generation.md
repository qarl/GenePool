# PLAN — GPU hair generation

Status: REVIEWED (1 + 5-panel incorporated). ⚠ RESHAPED — do NOT build option C; measure count-LOD first. Author: Jimmy-GenePool, 2026-09-06.

## §0. MEASUREMENT GATE — run BEFORE building the port (5-panel consensus)

Two reviewers (architecture + perf) independently reached the same conclusion the plan missed: **strand COUNT is world-space** — `n = round(gLen/hairSpace)` (viewer ~977) and cap `K` have **no screen-scale term** — so at whole-pool zoom we generate, upload (~10MB/frame), AND draw all 322k strands *even though each is sub-pixel* (the code's own comment ~934: they "melt into the rim"). `hairLOD` only fades brightness, not count.

So the cheap lever attacks the 322k at its root:

1. **Count-LOD (≈ 1 line):** derive `n`/`K` from `gLen*S` (screen length) or clamp `hairSpace` to a minimum screen-pixel spacing. Cuts strand count several-fold *in exactly the slow band*, reducing CPU generation **and** GPU draw **and** the ~10MB upload — none of which the GPU-gen port touches (it only makes CPU generation cheaper). Reversible, no new shader. **It's a visual/product call for Karl** (fewer sub-pixel hairs — likely indistinguishable, possibly *less* shimmery). **Measure it first: at whole-pool zoom, what fraction of the 322k strands exceed ~1px?** If most are sub-pixel, count-LOD likely captures the bulk of the 19ms and the whole port below is unnecessary.
2. **Pre-port cross-arch baseline (cross-arch reviewer MAJOR1):** capture arm64-vs-x64 at tick 709200 / whole-pool with the CURRENT CPU-gen — the golden `diffFraction` budget (0.05% ≈ 295px) is the likely failure point at hair density, and we have no proof it passes even today. Without this baseline a post-port failure can't be attributed.
3. **Spike the loaded-VS cost (if still pursuing the port):** hack ~20 dummy `texelFetch` + a bezier eval into the existing hair VS over the current buffer, `gl.finish`. Refute threshold: >6ms → the win drops below 2×.

**Decision rule:** if count-LOD (1) captures most of the 19ms, STOP — don't build the port. Only if it's insufficient AND (3) shows the VS stays cheap, build the port — as **option A or D, NOT C** (§below).

## ⚠ Option C is DEAD (shader-correctness reviewer B-1)
Hairs are drawn **per depth slab** (interleaved with the body/resolve sweep so `RESOLVE_FS` depth-attenuates each slab's hair glow — a load-bearing feature). So `gl_InstanceID` resets every slab draw and WebGL2 has no base-instance → C's "one big draw + in-shader `gl_InstanceID→part` search" maps every slab's strands to the first parts. **C does not function with the slab compositing.** If the port is built: **option A** (per-strand index VBO — a per-slab byte-offset drop-in) or **option D** (transform-feedback: generate once/strand into the existing 8-float buffer, leaving the draw path + HAIR_SDF_VS unchanged — the minimal-blast-radius, 4×-less-work path; perf reviewer's pick).

---
Status (original): HARDENED (1-reviewer incorporated; pre 5-panel).

## 1. Goal & measured justification

Move hair *generation* (the per-strand JS loop) from the CPU to the GPU — the last big per-frame CPU cost after the body port.

Measured on the **real GPU**, reproducing Karl's scene (seed 1, tick 709200 = 3:17:00 → pop 570, **322k hairs**, whole-pool zoom):

| frame component | ms | share |
|---|---:|---:|
| full frame | 29.0 (≈ Karl's 35fps) | 100% |
| GPU (`gl.finish`) | **0.0** | ~0% |
| non-hair (body GPU + fixed passes + buildSegs/partPointsGL + junk) | 9.9 | 34% |
| **hair emit (JS per-strand loop)** | **19.1** | **66%** |

Hairs are already GPU-*drawn* (the SDF quad) but CPU-*generated*: for every strand JS computes root (Bézier), bend, length, metachronal beat, drag, jitter → 8 floats. At 322k strands ≈ 19ms. Move to the idle GPU → target render 29ms → ~10ms → **~90fps at pop 600 / 300k hairs** (worst case; zoomed-in already faster via frustum cull).

## 2. Current architecture (what we're replacing)

Per part, in `tessSegment` (~975-1004), gated by `P.hair>0 && red>0.01 && grow>0.001 && hairLOD>0.01`:
- **Side hairs:** `n = round(gLen/hairSpace)` pairs; for `h` in 0..n at `u=(h+0.5)/n`: `L/R = bez(edge,u)` + the `merge` branch **bend**; `lenS = hairLen*(lerp(wStart,wEnd,u)/3)*red*grow*S`; `beat = hairSway*sin(lerp(v0,v1,u)*hairWave − hairTime*hairBeat)`; `hbright = grow*fade*hairLOD`; jitter key `kb = floor(lerp(v0,v1,u)*13)*2` → `hairJit`/`hair01`; `emitHair(root, ±jitteredDir, jitteredLen, widS, ±beat − hairDrag*(v·perp), hbright)`.
- **Cap hairs** (`emitCapHairs` ~910): radial fan of `K = round(halfEllipsePerim/hairSpace)` around the tip cap (`deL/deR/dnx/dny`, bent+ramped) and mouth cap; `phi ∈ [−π/2,π/2]`.
- `emitHair` → 8 floats/strand → `HAIR_SDF_VS` (1 instance→1 quad) → `HAIR_SDF_FS` (smooth SDF, **no floor/fract**). Increments `hairsEmitted` (HUD/__bench metric).
- Globals → uniforms: `hairSpace, hairLen, hairWid, hairSway, hairWave, hairBeat, hairDrag, hairTime(=clock), hairAngJit, hairLenJit`.
- ⚠ **Death swell (M3):** at `fade<0.999`, `tessSegment` mutates `pt.sL..sR` IN PLACE (scale outward by swell) + scales `capLenT/R` BEFORE the hair loop — so the current roots sit on the SWELLED screen-space points.

## 3. Proposed architecture (hardened)

Keep the GPU DRAW (SDF quad, `HAIR_SDF_FS` **unchanged**). Replace the CPU per-strand loop with GPU generation from a **per-part hair record in an RGBA32F texture** (M1: 5700+ parts × ~48 floats won't fit uniform vectors / a UBO — use `texelFetch`, NEAREST, core-WebGL2, cross-arch-exact). A new `HAIR_GEN_VS` reads the record + the strand's (part, localIndex, side) and computes its params, then expands to the quad; pairs with the unchanged `HAIR_SDF_FS`.

### Variable strands-per-part → **option C** (1-review M1); ship via an **A→C ladder**
Instanced draw needs one instance count but `n` varies per part (uncapped, hairy morphology). Both A and C require the per-part record TEXTURE; A additionally keeps a 322k CPU loop (~2-4ms, not the "~1-3ms" I claimed) for no structural saving. So:
- **Step 1 ships A** (CPU loop pushes only a tiny per-strand `(partIndex, localIndex, side)` — no trig/bez/hash — into an index VBO; use an INT attribute or two floats, NOT one packed float32: 24-bit mantissa vs ~5700 parts × thousands of strands) to validate the record-texture + weld + jitter + beat cheaply.
- **Step 2 swaps the mapping to C**: CPU prefix-sums per-part strand counts (O(parts), cheap) into a small texture; draw `total-strands` instances; `HAIR_GEN_VS` integer-binary-searches `gl_InstanceID → part` (~13 `texelFetch` + int compares, cross-arch-exact), then `localIndex = gl_InstanceID − firstStrand[part]`. Delete the CPU loop. **Zero per-strand CPU.**
- **B is DEAD** (MAX_STRANDS clips hairy parts / wastes massively). **D (transform feedback)** = fallback ONLY if M5 shows the VS is hot (it removes the 4×-per-vertex redundant generation).

### The metachronal beat — CPU float64 range-reduction (1-review **B1**, the blocker)
`beat` phase = `lerp(v0,v1,u)*hairWave − hairTime*hairBeat`, and `hairTime=clock` is UNBOUNDED (≈42552 rad at tick 709200). The body poly-sincos ([−π/2,π/2]) can't take it, and reducing 42552 mod 2π in **float32** is catastrophic (per-backend divergence + frame flicker). Fix:
- CPU passes a per-frame uniform **`uBeatPhase = (hairTime*hairBeat) mod 2π`** (float64 reduction).
- VS: `phase = fract((v*hairWave)/(2π))*2π − uBeatPhase`, fold into [−π,π], then a poly-sincos extended to [−π,π]. The `v*hairWave` term is small (≤~72 rad → float32-safe); the `fract` 2π-seam is SAFE because `sin` is continuous across it (a 1-ulp seam flip gives `sin(2π−ε)≈sin(−ε)`).
- The cap beat has no u-span → pass its single reduced phase.

### Per-part hair record — its OWN texture (1-review M2), NOT the strip record
The strip record is a near-superset but MISSING: `vx,vy` (drag velocity), `grow`, `hairLOD`, `n`/`part.length*g`, `nx,ny`, `capLenT`, `capLenR`. Bloating the working strip attribute record (36→~48) wastes ~200KB/frame of strip bandwidth for fields it ignores. Since the record is a TEXTURE anyway, give hairs their own per-part record (superset of what they need, incl. the SWELLED screen-space bézier points per M3, and `rampEnd`-recomputable fields).

### Jitter re-keyed on INTEGERS (1-review M4) — needs Karl's OK
The current key `kb = floor(lerp(v0,v1,u)*13)*2` is a **floor hazard**: a cross-arch/precision flip at an `arc*13` integer boundary re-hashes the strand to a totally DIFFERENT angle/length (discontinuous, golden-buster). Fix: re-key jitter on the integer `(partIndex, localStrandIndex, side)` — exact on every backend, already available in the VS. This CHANGES the jitter pattern (equally organic random) → a one-line **Karl OK**. (Caps already key on integer `i*131`.) Note: `hair01`'s integer hash core is bit-exact in GLSL `uint`, but its final `/4294967296` is float64(JS) vs float32(GLSL) — NOT bit-equal (don't waste effort matching; the residual is sub-pixel + IEEE-deterministic cross-arch).

⭐ **Cross-arch is otherwise LOWER-risk than the body:** `HAIR_SDF_FS` has no `floor`/`fract` of interpolated data, so the cytoplasm cell-flip hazard doesn't apply to the FILL. The remaining cross-arch surfaces are all POSITION: the beat (B1), the bend `sin/cos` (poly), and the jitter key (M4) — all handled above.

## 4. Risks / traps (for the 5-panel)

1. **B1 beat phase (blocker):** unbounded phase → CPU float64 reduction + `uBeatPhase` uniform + extended poly. MUST be verified at a LARGE tick (tick-0 golden won't catch it — M6).
2. **Variable-count mapping (M1):** ship A→C; the record + prefix textures via `texelFetch`; get `gl_InstanceID→(part,localIndex,side)` exact.
3. **Jitter key floor hazard (M4):** re-key on integers (Karl OK).
4. **Death swell (M3):** record MUST carry the swelled screen-space bézier points (regenerating roots from world coords silently drops dead-swimmer dispersal).
5. **VS gets much heavier (M5):** generation runs 4×/strand (per quad vertex) + record texelFetch + C's search (~13 texelFetch/vertex). "GPU idle" was measured with a TRIVIAL VS — **re-measure `gl.finish` after Step 1 and Step 3**; if the VS is hot, escalate to option D (transform feedback: generate once/strand, then vanilla draw).
6. **Weld (M6):** side hairs weld BETTER (both poly now) but roots SHIFT vs current CPU-exact → re-record goldens; cap hairs are poly-vs-CPU-exact-dome-base → sub-pixel seam (accepted class). `rampEnd` recomputable in-shader from `rampRw`,`a1`.
7. **Cap hairs = SECOND generator (m1)**, not a mode flag: own per-cap record (A/B corners, axis, capLen, radWorld, red, grow, fade*hairLOD, reduced beat phase, vx/vy, K) + own mapping. `phi∈[−π/2,π/2]` (fan) needs no reduction (only the beat does).
8. **`hairsEmitted` metric (m2):** recompute = Σ(n*2) + Σ(cap K) so the HUD/__bench isn't zeroed.
9. **Growth gate (m6):** gated-out parts contribute `n=0` to the prefix sum (no in-VS discard).
10. **Per-view ×7 (m4):** records are screen-space → rebuilt+re-uploaded per `renderView` (main + ≤6 minis, `onlyBot`). Budget 7 small texture uploads/frame.
11. **Frustum-cull slack (m5):** GPU `lenS` must match CPU exactly so hairs don't exceed the `+30` cull bound and pop at the screen edge.
12. **Species tiles / onlyBot** path must generate hairs correctly.

## 5. Incremental build order (de-risk)
1. **Side hairs on GPU, option A mapping** (record texture + `HAIR_GEN_VS` + tiny index VBO); caps + everything else stay CPU. A/B flag. Measure CPU drop + **re-measure `gl.finish`** (M5). Verify weld/beat/jitter.
2. **Swap side-hair mapping to C** (prefix-sum texture + VS search); delete the CPU loop. **Cross-arch gate at a LARGE tick** (709200) — the beat reduction (B1) only shows there.
3. **Cap hairs on GPU** (second generator). Measure + `gl.finish` re-check.
4. **Visual + golden checks** (+ re-record); if VS hot at any step, evaluate option D.
5. **Remove the CPU hair path + flag** (no cruft); re-record goldens + baseline; final real-GPU bench at pop ~570/322k (target ~10ms) AND the large-tick cross-arch gate.

## 6. Success criteria
- Real-GPU pop ~570 / 322k / whole-pool: render **29ms → ~10ms** (~90fps); hair-emit CPU → ~0 (or ~2ms for the interim A step).
- **`gl.finish` re-measured** ≈ idle with the heavier VS (not assumed — M5).
- Cross-arch goldens hold at maxΔ≤1 **including a large-tick (709200) render** (B1/M6); visually indistinguishable; suite 6/6; `hairsEmitted` HUD correct; no dual path.

## 7. Open questions for Karl
- **Jitter re-key on integers (M4)** — changes each strand's random angle/length offset to an equally-organic but DIFFERENT pattern. OK? (It's the clean fix for the cross-arch floor hazard.)
- Variable-count: A→C ladder (recommend) — OK to ship the interim A step (with ~2-4ms residual) before swapping to zero-CPU C?
- Incremental (side → cap → remove CPU), each measured?

## 8. Process
Per `big-change-planning-formula`: draft → 1 reviewer (DONE) → 5 distinct-lens reviewers (DONE) → incorporate (DONE, this doc) → **§0 measurement gate (count-LOD first)** → build ONLY if the gate says so, as option A/D.

## 9. 5-panel findings — build-time checklist (IF the port is built after the gate)

**Architecture / whether-to-build:** count-LOD (§0) likely moots the port — hairs are sub-pixel at the slow zoom, count is world-space. Is 35fps-at-whole-pool even a FELT problem (zoomed-in already fast, live vsync-capped ~120)? Don't ship the interim option-A step as a "milestone" (build-to-delete cruft) — spike, then build the endpoint.

**Shader correctness:** ⚠ C is DEAD (per-slab compositing, §0). A = per-slab index-VBO drop-in (`vertexAttribIPointer`). Record texture: wrap into width-W (MAX_TEXTURE_SIZE 2048 floor; address `ivec2(L%W,L/W)`, exact <2^24); prefix-sum values exact <2^24 too; binary-search tie-break = upper_bound−1 (n=0 gated parts make duplicate keys), read ints as `int(x+0.5)`.

**Cross-arch (the sharp axis, but hairs lower-risk than body — SDF FS has no floor/fract):**
- **Beat poly:** do NOT "extend to [−π,π]" — the Taylor-7 body poly returns sin(π)≈−0.075 (wrong AND a 0.15-rad fold-seam discontinuity → shimmer, cross-arch-STABLE so the gate green-lights it). **Quadrant-reduce [−π,π]→[−π/2,π/2] via sin(π−x)** and reuse the proven poly.
- **Beat phase:** unbounded `hairTime*hairBeat` → CPU float64 reduce to `uBeatPhase` (the real failure is TEMPORAL stutter at large tick, not per-backend divergence). Also reduce `v0,v1` per-part `mod(2π/hairWave)` on CPU — real max `v*hairWave` ≈ 96+ rad (vOff∈[0,600)), not the "72" I wrote.
- **New cross-arch surface hairs have that the strip didn't:** per-strand `u=(h+0.5)/n` / `phi=(i+0.5)/K` are GLSL highp division (2.5 ULP, not correctly-rounded) — strip avoided this via its `uU` uniform; hairs can't (n uncapped). Sub-pixel but VERIFY at the gate.
- **Jitter re-key on integers** (side): removes the `floor(arc*13)` flip hazard — a visual pattern change (Karl OK). NOTE option A can PRESERVE the exact current pattern (bake the key into the index VBO); only C/D-in-VS force the re-key.
- **diffFraction budget (0.05%≈295px) is the likely gate-failer at 322k strands**, not maxΔ — each strand adds edge/discard boundary px. Pre-port baseline mandatory (§0.2).
- Rosetta-x64 proxy covers SwiftShader only; the REAL-GPU beat/atan/poly Karl sees is a human check, not gated.

**Visual fidelity:**
- **Cap weld:** BAKE `deL/deR/dnx/dny` + `capLen*rampEnd` into the cap record from the CPU (exact) — do NOT recompute cap bend in-shader, or the fan detaches from the dome (the old "hairs float off the cap" bug).
- **Cap jitter key** is `floor(vArc*13)+i*131` (NOT just `i*131` — I misstated it): same floor hazard → bake `floor(vArc*13)` per-cap on CPU. Cap beat is per-cap-constant → precompute on CPU (exact `Math.sin`, no GPU poly).
- **Side-hair root** must reuse `BODY_INST_VS`'s [−π/2,π/2] `sincos` + `bez2` (NOT the beat's poly) so roots track the body edge; side record needs the un-swelled `merge` pivot (`px,py` from `toScreen(parentPos)`) + `da,rw,a0,a1`.
- **Death swell:** record must carry the SWELLED screen-space bézier points (regenerating from world coords drops dead-swimmer dispersal). Growth-gated parts → n=0 in the prefix (no in-VS discard).
- **Temporal test needed:** the beat is animated; single-frame goldens can't catch seam/stutter. Add a multi-tick continuity probe, and make the large-tick gate golden ZOOMED on a hairy specimen spanning ≥1 wavelength (whole-field LOD-fades hairs to nothing).

**Perf / measurement:** ~10ms target is unproven until the loaded-VS `gl.finish` is measured (refute >6ms). C wastes 4× (regen per quad vertex); D = 4× less + keeps the trivial draw VS. Realistic CPU floor ~10.5–11ms (per-part record build/upload stays). `__bench` excludes tick — confirm Karl's 35fps is at ticksPerFrame=1 (at higher speed it's tick-bound, hair win invisible). Fix `hairsEmitted` = Σ(n·2)+Σ(K) or the FPS HUD zeroes. Side hairs dominate; caps are a minority — measure the split (maybe leave caps CPU).
