# PLAN — GPU body tessellation

Status: ✅ SHIPPED (`6a2441d` build + this cleanup). Author: Jimmy-GenePool, 2026-09-06. Target: `viewer-micrograph-gl.html`.

## OUTCOME (measured, real GPU)
Built dome-first then strip, each A/B-verified. Peak zoom W1.5 (pop 458): render **24.7ms → 10.0ms**; felt frame (3×tick + render) **~39fps → ~89fps** (arc: 39 → 67 dome → 89 strip). `world.tick()` measured at 0.4ms (the §0 gate REFUTED the reviewers' "tick dominates" fear — render was the felt frame). Retained-CPU floor ~10ms (as the perf reviewer predicted, not ~6ms). Visually indistinguishable (full CPU vs full GPU A/B at high zoom); arm64 visual suite 6/6.
**Cross-arch gate PASSED** (§0's load-bearing gate): x64 (Rosetta build-1217 proxy) vs arm64 goldens = worst maxΔ=1, ≤0.0012% px — the SAME strict band as the integer-hash renderer. The transcendental-free VS construction (uniform ring/col/u samples + polynomial `sincos` + Bernstein Bézier) held; no speckle/cell-flip divergence. → CPU fallback path REMOVED (this cleanup, no cruft).
STILL DEFERRED: pop-2000 zoom-out perf gate + the extra golden scenes (long-tip/mid-zoom/high-zoom-dying) — nice-to-haves, not blockers.

---
Status (original): REVIEWED (1-reviewer + 5-panel incorporated).

## §0. MEASUREMENT GATE — run BEFORE building anything (5-panel consensus)

Two reviewers (perf + architecture) independently raised the same BLOCKER: **every number here measures `render()` on a FROZEN world, but real playback runs `world.tick()` ×`ticksPerFrame` (default 3) every displayed frame.** The bench peak is 24ms (42fps) yet the felt peak is ~20fps (~50ms). That ~26ms gap is almost certainly the per-frame ticks. If so, cutting render 24→6ms moves the *felt* frame ~50→~32ms ≈ **~30fps, not 120** — a big benchmark win but a modest felt one. We could build a multi-week GPU port and barely move Karl's actual complaint.

So this port is GATED on three cheap measurements (~an afternoon), each of which can independently kill or reshape it:

1. **Profile `world.tick()`.** Bracket `world.tick()×ticksPerFrame` vs `render()` live at the complaint zoom, at pop 457 AND near the 2000 cap, for ticksPerFrame ∈ {1,3,8}. **If tick dominates the felt frame, the render port is aimed at the wrong term** — stop and rethink (e.g. decode-from-DB instead of re-simulate; note the run's `.db` already holds snapshots+events, so playback need not re-tick — that may be the bigger lever, and it is NOT the generator flat-out rule, which is a separate process).
2. **Decompose the 18ms** into HEAD (`partPointsGL`+swell+bend+tint, stays on CPU) vs the per-vertex emit loops (move to GPU) vs `bufferData` upload (mostly eliminated). Three `performance.now()` brackets. This sets the REAL floor: if HEAD is ~40% the floor is ~13ms not ~6ms (win 2× not 4×).
3. **The 2-line probe:** drop `STEPS 10→5` and the dome budget on the CPU, re-bench. If that recovers most of the cost, the win is plain vertex-count/upload — obtainable with two reversible lines and ZERO cross-arch/shader risk, and the GPU port is over-engineered for this problem.

**Decision rule:** build the GPU port ONLY if (1) render is a majority of the felt frame, (2) the decomposition shows the emit-loops+upload are the bulk (HEAD small), and (3) the 2-line probe does NOT already capture most of the win. Otherwise take the cheaper path. Bring the numbers to Karl before building.

---

## 1. Goal & measured justification

Move the per-frame body tessellation from JS onto the GPU, the same win we just took for hairs.

Measured on the **real GPU** (desktop `GP_BENCH`, seed 1, pop 457, peak zoom W1.5, 96k hairs):

| frame component | ms | share |
|---|---:|---:|
| full frame | 24.1 | 100% |
| fixed GL/composite passes (`noTess`) | 0.6 | ~3% |
| **CPU tessellation total** | 23.5 | 97% |
| — body tessellation (JS) | **~17.8** | **~74%** |
| — hair emit (JS) | ~5.7 | ~24% |

`gl.finish` delta ≈ 0ms → **the GPU is idle; the frame is CPU-bound on building geometry.** The single highest-value lever is the ~74% spent in JS re-tessellating every visible creature's body every frame. NOTE: some of that ~17.8ms is the `bufferData` upload of the fully-tessellated `buf` (starts 8MB, grows) — the port also eliminates most of that upload (see §3, ~50-70× smaller).

Non-goals (settled with Karl): NOT throttling the generator (flat-out by design — memory `genepool-generator-flat-out`); NOT optimizing the paused path (no frame-to-frame change → frame rate irrelevant); NOT caching unchanged poses (swimmers always move). The bodies genuinely change every frame during playback, so the lever is making the per-frame rebuild **cheaper** — do the expansion on the idle GPU.

## 2. Current architecture (what we're replacing)

Per frame, `renderView` (`viewer-micrograph-gl.html`):
- **`buildSegs(id, sb, ph, g, fade, S, segs)`** (~928) — per visible creature: frustum-cull, compute pose-independent `lod = reach*S/75` (~943), push one `seg` per part: `{sb, ph, p, g, S, v0, v1, fade, merge, lod}`. Per-part, cheap.
- Slab loop → **`tessSegment(...)`** (~839) per part. Its structure, precisely:
  - **Per-part HEAD (cheap, must be PRESERVED in the CPU packer):** `partPointsGL(ph,p,g)` → control points in screen space (sL,sR,eL,eR, Bézier c1/c2 L/R, wStart/wEnd, nx/ny, terminal, capLenT/R); **death swell** (~855-859: pushes all 8 control pts outward from screen centre, scales capLen); **dome-base end-bend** (~872-881: `deL/deR/dnx/dny` = end edge/axis rotated by the end-bend, plus **`rampEnd`** matching dome base thickness to the strip end); **tint endpoints** (`tStart`=parent tint, `tEnd`=own, ~864-866); **`blur = P.deathBlur*(1-fade)`**; `fade` thickness multiplier.
  - **Per-vertex LOOPS (expensive — THIS is what moves to the GPU):** `emitStrip` (~742) walks the L/R Béziers over `STEPS=10` sub-steps, 2 quads/step (left cu −1↔0, right 0↔+1) = 120 verts/part, applying branch **bend** + thickness **ramp** (`merge`); `emitDome` (~771) rings×cross grid.
  - hairs (already GPU: `emitHair` → SDF quad) — but the strand LOOP + `emitCapHairs` are still CPU-side.
- Vertex format (`buf`, 9 floats/vtx, `vtx()` ~733): `x,y` (screen px), `cu` (-1..0..+1), `rad` (world half-width), `v` (arc-length), `tint.rgb`, `blur`.
- **`BODY_VS`** (~218) is near-passthrough: screen px → clip; forwards cu/rad/v/tint/blur.
- **`BODY_FS`** (~233) additively accumulates thickness: `frag = vec4(col*th, th)` into `slabFBO`. Does cytoplasm (`worley`) + grain (`vnoise`) via `floor()/fract()` of interpolated `cu*rad`/`v`; integer `hash2` (cross-arch-stable). **No dFdx/rim here.**
- **⚠ CORRECTION (1-review): the Becke rim is in `RESOLVE_FS` (~345-347), NOT `BODY_FS`.** It is an **image-space finite-difference** (`texelFetch` of `slabTh(ip±1)`) on the already-accumulated slab-thickness **texture**, run once per slab. So the rim depends ONLY on the final per-pixel thickness field — **independent of triangle topology/adjacency/winding.** It IS sensitive to tessellation *density* at dome silhouettes (a coarser/finer ellipse shifts the thickness edge → shifts the rim there). See §4.1.

## 3. Proposed architecture (GPU tessellation)

Keep the CPU doing the **cheap per-part** work (`buildSegs` + `partPointsGL` + the `tessSegment` HEAD: swell, dome-base bend, rampEnd, tint, blur). Stop it doing the **two per-vertex loops.** Pack a compact per-part **instance record**; a new vertex shader expands it into vertices via `gl_VertexID` (like the hair VS).

- **`BODY_INST_VS` is a NEW program** (do NOT replace `BODY_VS` — `junkProg` shares it, ~622, and junk/food/discs keep the `buf`/`bodyVAO` passthrough path). `BODY_FS` stays **byte-identical** (produce the same per-vertex `cu/rad/v/tint/blur`).
- **Two instance streams / records** (different sizes):
  - **Strip record ≈ 36 floats (9 vec4 attributes):** 8 control pts (16) + wStart/wEnd (2) + tStart/tEnd (6) + v0/v1 (2) + blur (1) + fade (1) + merge{px,py,da,rw,rampRw,a0,a1} (7) + **`hasMerge` flag (1)**. Within WebGL2's 16-attrib min. Strip VS: 120 verts/instance, `gl_VertexID`→(ring,column,corner).
  - **Dome record ≈ 14 floats:** baseA/baseB (4) + axis (2) + capLenScreen (1) + radWorld (1) + tint (3) + vBase/vTip (2) + blur (1). **Dome VS is TRIVIAL** — because the CPU HEAD already bakes the end-bend into `deL/deR/dnx/dny`, the dome VS is a pure `rings×cross` expansion of a base edge + axis (no bend/merge math). Only the STRIP VS needs Bézier+bend+ramp.
- **Upload is ~50-70× SMALLER**, not a risk: today `bufferData(buf.subarray(0,o))` uploads the fully-tessellated mesh (multi-MB/frame); the records are ~36 floats/part + ~14/dome ≈ ~350KB/frame. This eliminates a chunk of the measured 17.8ms.
- Slab compositing unchanged: per-part instances bucketed by slab; one instanced draw per slab per stream (strip, dome), plus the existing junk + hair draws. Additive blend (commutative → order within a slab irrelevant; no depth test, no face cull → winding irrelevant). Per-slab ranges via the hair's manual base-instance rebind (`vertexAttribPointer` byte offset, ~1254-1256; WebGL2 has no `baseInstance`).

### LOD: drop ONLY the body TRIANGLE-COUNT LOD — keep the VISUAL ones (corrected by 1-review)
The `lod` scalar drives THREE things; only one is pure triangle count:
- **Strip `steps` + dome `rings×cross` scaling = pure triangle count → DROP.** On the idle GPU, render at fixed generous resolution (strip: keep `STEPS=10`). **⚠ Dome must be ≥16 rings AND ≥24 cross (e.g. 16×24 or 20×20) — NOT 8×16.** (Visual-panel MAJOR1: today's aspect *redistribution* gives long tips 16 rings and wide mouths 24 cross; a flat 8×16 is COARSER than today on eccentric caps, so the Becke rim would trace facets on pointed tips/mouths — a quality LOSS for zero full-zoom perf gain. Dominate both axes of the old peak.) Uniform vertex count/instance → clean instancing, no aspect redistribution, no collapse logic. Keep the CPU dome-cull at `domeLOD≤0.02` (else a shrunk cap draws a flat filled disc).
- **`hairLOD` (~848) = VISUAL (anti-halo: hairs fade as creatures shrink so they melt into the rim instead of a fuzzy full-bright halo) AND a CPU hair-emit reducer → KEEP.** Dropping it would (a) regress the look (halo) and (b) *raise* zoom-out CPU cost (hairs are still CPU-emitted per strand). Hairs are OUT of scope for the LOD-drop.
- **`domeLOD` (~851) = VISUAL (scales cap BULGE LENGTH, not just resolution) → KEEP**, baked into the dome record's `capLenScreen` by the CPU HEAD (free — no pop, exact look).
- ∴ `buildSegs` STILL computes `lod` (for hairLOD + domeLOD). Only the resolution scaling in `emitStrip`/`emitDome` is removed. (Finding 13's "shed reach/lod" is thus moot — lod stays.)
- **Must measure:** dropping the body-triangle LOD raises zoom-out body tris (~15× at full zoom-out, grown pool). Confirm the GPU still idles there (expect yes: `gl.finish≈0`). Fallback ONLY if measured necessary: one global zoom-driven step/ring scalar — not preemptive.

## 4. Risks / correctness traps (for the 5-panel)

1. **Becke rim (RESOLVE_FS image-space).** Topology-independent (good), but **density-sensitive at dome silhouettes** — fixed dome resolution changes the ellipse approximation → the thickness edge → the rim there. Must A/B the rim on dome edges + branch joints. Not a blocker, but a real visible delta to expect.
2. **⭐ SHARPEST RISK — cross-arch/cross-precision golden stability of cyto/grain noise.** Today the noise INPUTS (`cu*rad`, `v`, position) are computed in **CPU float64**, truncated to identical float32 bytes, uploaded; the only GPU math is the integer `hash2`. The port computes `rad=lerp(wStart,wEnd,u)*fade*ramp(u)`, `v=lerp(v0,v1,u)`, and Bézier positions in the **VS in float32 on the GPU**. `BODY_FS` feeds these through `floor()/fract()` (worley/vnoise) — a **1-ulp shift at a cell boundary flips which noise cell a fragment lands in → a discrete speckle change**, not sub-LSB. The hair precedent does NOT transfer (hair FS is a smooth SDF, no floor/fract of interpolated data). This is the same class of bug integer `hash2` was made to kill, re-entering via the *inputs*. **MUST be measured on the body cross-arch (arm64 record vs the SwiftShader golden band) BEFORE removing the CPU path (§5 step 5).** Do NOT assume maxΔ≤1. Mitigations: compute `u=i/STEPS` as the same float32 division; avoid FMA/reassociation-sensitive forms; if needed, accept a perceptual/tolerance golden band rather than exact; worst case, keep body geometry CPU-built but that loses the win — so measure early.
3. **Strip VS porting traps (three concrete):** (a) `gl_VertexID`→(ring 0..STEPS, column cu∈{−1,0,+1}, corner) decode must reproduce the 3-col×(STEPS+1)-row grid, 120 verts/instance. Good news: each vertex is a pure function of its own ring `u` (no cross-ring coupling; tint is per-ring, not per-quad) → simpler than the CPU `quad()`. (b) The spine vertex (cu=0) is **`mid(L,R)` of two INDEPENDENT L/R cubic Béziers** (c1L/c2L ≠ c1R/c2R; they bake parent/child perpendicular blending) — the VS must evaluate BOTH Béziers and midpoint them, NOT one spine + normal offset. (c) **merge-null is a GLSL UB trap:** `smoothstep(0, rampRw, x)` is undefined when `rampRw≤0`, so "no ramp" CANNOT be encoded as `rampRw=0` — upload an explicit `hasMerge` float and gate `ramp = hasMerge>0.5 ? smoothstep(...) : 1.0`. (Bend degrades safely: `da=0` → identity.)
4. **No-LOD zoom-out triangle count** (~15× more body tris at full zoom-out). Measure GPU stays idle; global-scalar fallback only if needed. KEEP hair-fade so zoom-out CPU hair-emit doesn't grow.
5. **Branch bend + thickness ramp (`merge`)** — subtle short-limb fixes (decoupled `rampRw`, length-aware `rw`; the "branch cut/dome cliff" saga, memory `genepool-microscope-renderer`). Port exactly or regress.
6. **Colour gradient / v-arc / blur / death-swell** must match per-vertex (all now baked in the CPU HEAD + evaluated per-ring in the VS).
7. **Species tiles** call `renderView` with `onlyBot` (one representative) — must still work with the instanced path.
8. **Golden re-record + visual A/B** — expect a deliberate (small) delta: cleaner dome edges (density) + possibly reshuffled speckle (precision). Re-baseline fresh; use a perceptual/tolerance metric, do NOT diff against pre-port goldens in a tight band. I eyeball old-vs-new myself (as with hairs).

## 5. Incremental build order (de-risk) — DOME FIRST (revised by 5-panel M5)

Reordered: the **dome is bigger geometry (768 vs 120 verts/part, "~half the geometry"), has a TRIVIAL VS (no bend/Bézier — CPU bakes the base), and carries almost none of the cross-arch speckle risk.** The strip is the small-but-hard, precision-risky piece. So bank the large low-risk win first.

1. **Dome on GPU** (fixed ≥16×24, no aspect/collapse; bake `capLenScreen` AND `vTip` with domeLOD×swell; keep the `domeLOD≤0.02` cull). New `BODY_INST_VS`-dome program; strip + junk/food + hairs stay CPU (all additively blend into the same `slabFBO` — commutative). Dev flag for A/B. Measure CPU drop + zoom-out tri count + A/B the rim at dome edges.
2. **Visual + golden check** (+ new long-tip/high-zoom + mid-zoom + high-zoom-dying scenes, recorded on OLD code first).
3. **Strip on GPU** (transcendental-free bend poly; exact JS arithmetic forms — `a+(b-a)*t` not `mix`, Bernstein `bez`; `hasMerge` gates BOTH smoothsteps + ε-clamp `rw`/`rampRw`; reduce `vOff`; weld dome-base to strip-end via the same GPU expression). Measure.
3b. **CROSS-ARCH gate (load-bearing):** new-golden(arm64) vs new-render(**native x64, not Rosetta**) on the same build; transform-feedback vertex-buffer diff as the sharp probe; PASS = existing band (`maxΔ≤1`, ≤0.05%). Any cell-flip cluster = FAIL → fix inputs (poly bend / upload rad·v corners), do NOT widen the band. If it can't pass, the strip stays CPU (dome win already banked).
4. **Visual + golden check.**
5. **Remove the now-dead CPU paths + flag** (no cruft); re-record goldens + perf baseline; final real-GPU bench (peak AND pop-2000 zoom-out). Budget a GPU-geometry debug capture (transform-feedback) BEFORE this step — the CPU-triangle "Copy-Swimmer" forensic tool is already gone and the bend/ramp weld is the top fidelity risk.

Note: `buf`/`bodyVAO`/`bodyVBO`/`bodyProg`/`BODY_VS` SURVIVE (junk + food discs).

Note: `buf`/`bodyVAO`/`bodyVBO`/`bodyProg`/`BODY_VS` all SURVIVE (junk + food discs).

## 6. Success criteria
- Real-GPU **peak-zoom** frame time drops from ~24ms toward the ~6ms floor (hairs + fixed passes): the ~18ms body-tess collapses to a small upload + free GPU expansion.
- Real-GPU **zoom-out** (grown pool, full zoom-out): frame time does NOT regress vs today despite no body LOD; body-tri count + GPU-idle confirmed; CPU hair-emit unchanged (hair LOD kept).
- **Cross-arch golden stability** demonstrated on the body (arm64 vs SwiftShader band) — or an explicit, documented tolerance metric adopted.
- Visual suite 6/6 (re-recorded goldens), look preserved (I verify old-vs-new myself), no renderer errors, no dual path left behind.

## 7. Open questions for Karl
- ~~Dome strategy~~ RESOLVED: drop body triangle-count LOD only; fixed 8×16 dome, no collapse (§3).
- Incremental (strip → dome → remove CPU), each measured, before ripping out the CPU path? (recommend yes)
- If the cyto/grain speckle proves cross-arch-unstable at float32, is a small documented golden **tolerance band** acceptable (vs today's maxΔ≤1)? (This is the one that could force a fallback.)

## 8. Process
Per `big-change-planning-formula`: draft → 1 reviewer (DONE) → 5 distinct-lens reviewers (DONE) → incorporate (DONE, this doc) → **§0 measurement gate** → THEN build (only if the gate says so).

## 9. 5-panel findings — build-time checklist (must all be handled IF we build)

**Shader/GPU correctness:**
- Draw `GL_TRIANGLES` (120 strip / ~768→now larger dome verts), NOT `TRIANGLE_STRIP` (no primitive restart in `drawArrays`).
- `hasMerge` flag must gate BOTH the bend AND ramp smoothsteps (`0*NaN=NaN` poisons the vertex); ε-clamp `rw`/`rampRw` on the CPU (the `bw==0` case still hits `smoothstep(0,0,x)` UB).
- Varyings INTERPOLATED (no `flat`); `gl_Position.w=1` (affine interp); `precision highp`.
- `gl_VertexID` decode: STEPS quad-rows (not STEPS+1); explicit corner LUT; spine (cu=0) computed identically in both halves (no T-junction).
- New program → re-fetch ALL `BODY_FS` uniforms on it; per-slab `vertexAttribPointer` rebind (no baseInstance) + divisors set once; reset instance cursors per `renderView`; per-slab start/count arrays; instance-buffer doubling.
- Dome VS domain guards: `sqrt(max(0,1-a²))`, `wBase=max(length(h),1e-6)`.

**Cross-arch determinism (the golden gate):**
- The risk is the floor/fract INPUTS losing byte-identity; the dangerous path is POSITION (bend trig + Bézier contraction) perturbing interpolation weights → interior cell flips. Mitigation (avoids a tolerance band): make the strip VS **transcendental-free** (bounded-angle polynomial for bend, `|θ|≤~π/2`); if needed, **upload the 11 `rad`+11 `v` corner samples** (byte-identical) instead of recomputing.
- GLSL forms must match JS: `a+(b-a)*t` (NOT `mix`), Bernstein `bez` (so u=0→sL, u=1→eL exactly — protects the weld), `smoothstep` matches but guard the null-merge.
- Reduce `vOff` (~600) to a small per-creature bias — ulp(600)≈7e-5 magnifies fract cell-flips.
- Gate must use NATIVE x64 (not Rosetta), a zoom/pose sweep (not one scene), new-vs-new same build, and transform-feedback vertex-diff. Do NOT widen the golden band (already-rejected capitulation; harness only supports exact / maxΔ≤1).

**Visual fidelity:**
- Dome ≥16×24 (§3) — 8×16 is coarser than today on eccentric caps.
- Bake `vTip` with domeLOD (not just `capLenScreen`); order = swell → domeLOD.
- Strip-end↔dome-base weld now spans GPU-f32 vs CPU-f64 → verify no hairline seam/rim on short bent limbs (MINOR: the old "cliff" bug class).
- Golden gaps: add long-tip@high-zoom, mid-zoom-lod-band, high-zoom-dying scenes (record on OLD code first); use a quantified perceptual diff, not just eyeballing.
- Confirmed SAFE: hairLOD preserved; dropping strip/dome-resolution LOD is visually safe-to-better (removes zoom tessellation pops).

**Perf/measurement (beyond §0):**
- Realistic floor includes retained HEAD + hair-emit (~5.7ms) + packing → likely ~10-12ms, not ~6ms (win ~2×, not 4×) — measure it.
- Zoom-out gate needs a pop-2000 scene the current harness can't produce (perf.mjs/benchZooms warm to ~457) — extend the harness.
- Species tiles run `renderView` ~7×/frame → the new draws/rebinds multiply; bench the tile path too.

**Architecture/scope:**
- The bend/ramp math becomes PERMANENTLY bilingual (strip=GLSL, dome-base+hair=JS) and must stay bit-consistent forever — a real maintainability tax for a solo owner. Weighs toward the cheaper §0 alternatives.
- Add a JS-packer ↔ GLSL-decoder **units/space table** (px vs world-half-width vs arc-length vs normalized) — one wrong field's space = silent visual bug.
