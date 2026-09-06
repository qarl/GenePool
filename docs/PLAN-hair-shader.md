# PLAN — GPU hair rendering (kill the facets, move the warp off the CPU)

Follows `docs/PLANNING-PROCESS.md`.

> ⚠️ **The "## 5-panel review — folded in" section at the bottom is the GOVERNING spec** (decisions P1–P6 + the
> corrected build order); then the "## Hardening review — folded in" (H1–H10). **Headline (P1): the instanced
> VERTEX-SHADER HIGH-N STRIP is now the PRIMARY approach; the fragment arc-SDF is demoted to an optional, Phase-0-gated
> upgrade.** All earlier "arc-SDF is primary" text is superseded.

## Problem
Zoomed in on long hairs, you see **facets** (visible kinks). And every hair is **warped on the CPU every frame**.

## Current implementation (viewer-micrograph-gl.html)
- Each hair is a **4-segment polyline** — `HAIR_NSEG = 4` (line 784). `emitHair(rx,ry, nx,ny, len, wid, theta, bright)`
  (785-796) walks the strand in **screen space on the CPU**, stepping `ang += theta/HAIR_NSEG` per segment (constant
  curvature ⇒ the strand is a **circular arc**), tapering width `wid*(1-frac)` and intensity `(1-frac)*bright` to the
  tip, emitting a tapered triangle strip (2 triangles × 4 segments = **8 triangles/hair**) via `hairTri`/`hairVtx` into
  `hairBuf` (`[x,y,alpha]`, screen-space; line 771-773).
- The hair **shader is a trivial passthrough**: `HAIR_VS` (425-435) maps screen px → clip; `HAIR_FS` (436-443) outputs
  `uColor * vA * uBright` with **additive blend (ONE,ONE)** into a dedicated `hairFBO` (1247-1255), later composited +
  bloomed. So **all curve/taper/sway geometry is CPU**.
- Per-hair params are computed upstream, per frame, from the phenotype:
  - **Side hairs** (867-893): roots sampled along the body-part's Bézier edges (`bez(pt.sL,pt.c1L,pt.c2L,pt.eL,u)`),
    count `n = round(gLen/hairSpace)`, length `= hairLen*(localThickness/3)*red*grow*S`, `beat = hairSway*sin(v*hairWave
    - hairTime*hairBeat)`, drag `-hairDrag*(v·perp)`, per-strand jitter `hairJit` (angle/length), growth-gate `grow`,
    death/LOD fade `hbright`. Left/right edges, beat mirrored.
  - **Cap hairs** (`emitCapHairs`, 799-813): a fan around mouth/tip domes, same spacing/laws.
- **LOD**: hairs are culled below a zoom threshold and cross-faded (`hairLOD`, `HAIR gate` in buildSegs) — so this only
  renders when you're zoomed in enough to care (exactly where facets show).
- `theta` (the bend fed to `emitHair`) = `±beat - hairDrag*(v·perp)` — sway + drag, i.e. a per-frame time-varying arc.

## Goal
1. **No facets at any zoom** (resolution-independent curve).
2. **Move the per-hair tessellation/warp off the CPU** (big per-frame CPU win).
3. **Look-identical** to today (glow, taper, additive, bloom, LOD fade, growth-gate, jitter, sway/drag).

## Why a vertex shader ALONE is not enough
WebGL2 has **no geometry or tessellation shaders**, so a vertex shader can't add vertices — a fixed segment count stays
faceted (just finer if we raise N). A vertex shader *does* move the warp to the GPU (upload params, not tessellated
verts), so it's a real CPU win and lets us afford more segments — but the facet-free fix needs the fragment approach.

## Proposed design — INSTANCED ANALYTIC-ARC HAIRS
Each hair becomes **one instanced quad**; the strand is drawn **analytically in the fragment shader** as a circular arc
(the exact curve the CPU builds today), so it's smooth at any zoom, with **one draw call** for all hairs.

- **CPU keeps computing per-hair PARAMS only** (root, outward dir, length, width, `theta` bend, brightness) — the same
  work it does now *up to* the `emitHair` call — but instead of tessellating, it writes ~8 floats to a per-instance
  buffer. The expensive part removed is the per-segment trig + 8-triangle emit + the big vertex upload.
  - Params are written in **world space** (root x/y, dir, len, curvature, phase, bright); the shaders project with the
    camera uniforms (`cam`, `sc()`, `W/H`) — so no per-frame screen-space recompute when only the camera moves. (Note:
    `beat`/`drag` still animate per frame via `hairTime`/velocity, so those params refresh each frame regardless — but
    they're cheap per-hair scalars, not per-vertex geometry.)
- **Vertex shader**: expand a unit quad (via instancing + a 4-vertex template or `gl_VertexID`) into the strand's
  **screen-space oriented bounding box** — a rectangle hugging the arc from root to tip, widened by the (tapered) half-
  width + a small AA margin. Pass the arc parameters (center, radius, start/tip angle, root/tip width, bright) to the
  fragment shader as flats/varyings.
- **Fragment shader**: for each pixel, compute **distance to the circular arc** (distance to the arc's center minus
  radius, clamped to the arc's angular span → the classic arc SDF; the constant-curvature strand makes this closed-form,
  unlike a general Bézier which needs a cubic solve). Taper the half-width and the intensity along the arc parameter,
  apply the same glow falloff, output additive colour. Degenerate case `theta≈0` ⇒ straight-segment distance (line SDF).
- **Blend/target unchanged**: same `hairFBO`, additive `ONE,ONE`, same composite + bloom path → the glow/bloom look is
  preserved by construction.

Fallback if the arc-SDF proves fiddly: **instanced high-N strip in the vertex shader** (params in, `gl_VertexID` builds
a 16–24-seg tapered strip on the GPU). Still removes the CPU warp; facets become negligible rather than zero. Same
instance-buffer plumbing, so it's a drop-in swap for the fragment approach.

## What must be preserved (fidelity checklist)
Side hairs AND cap-fan hairs; width taper + intensity taper to the tip; additive glow colour `(1,1,0.97)*hair`;
growth-gate dimming (baby hairs); death/LOD cross-fade (`hbright`/`hairLOD`); per-strand length/angle jitter (`hairJit`);
metachronal `beat` + physical `drag`; left/right mirroring; bloom contribution; the LOD zoom-threshold cull.

## Risks / open questions (for the reviewers)
- Arc-distance SDF correctness + numerics near `theta→0`, tiny radius, and near the arc endpoints; AA at thin widths.
- Bounding-quad sizing: must cover the whole swept arc + width + AA at all zooms without over-drawing.
- Instancing cost vs benefit: is a single instanced draw actually faster than the current one big buffer? (measure.)
- Additive **overlap**: many thin overlapping hairs currently sum via the triangle coverage; an SDF quad must sum the
  same way (no double-count where a hair's own quad overlaps itself on a tight arc).
- Preserving byte-ish visual parity — the render WILL change slightly; goldens must be re-recorded and eyeballed.
- Determinism: hair geometry is view-only (not the sim), so no engine-determinism impact; but keep the golden/visual
  suite green (re-record).
- Capture/`__golden`/`__bench` hooks + the species-tile mini-render path also draw hairs — must go through the new path.

## Build order (each gate before the next)
0. Prototype the arc-SDF fragment shader in isolation (one hair, static) — confirm smoothness + AA. GO/NO-GO.
1. Instance-buffer plumbing: CPU writes per-hair params instead of `emitHair` tessellation; new hair program; render one
   part's hairs. Behind a runtime toggle (A/B vs the current path).
2. Wire side hairs + cap hairs through the params path; match taper/jitter/beat/drag/growth/LOD.
3. Visual A/B vs current (Karl's eyes) + re-record goldens; perf measure (CPU frame time zoomed-in, hair-heavy scene).
4. Remove the toggle (or keep it) once parity is accepted.

## Hardening review — folded in (2026-09-06, before the 5-panel; these DECISIONS govern + supersede conflicting text above)
A single reviewer hardened this plan against the code. Verdict: approach (instanced analytic-arc hairs, fragment
arc-SDF) is SOUND + BUILDABLE in WebGL2, but one central claim was wrong (per-slab compositing) and several "edge" cases
are actually the common case. Decisions:

- **H1 (BLOCKER) — hairs are depth-composited PER SLAB; do 8 instanced draws, NOT one.** Hairs bucket into
  `hairStart[k]/hairCount[k]` over `K_SLABS=8` (viewer ~1200); each slab clears `hairFBO`, draws only its hairs
  (~1247-1256), and the resolve pass depth-attenuates them (`atten=exp(-prevFA)`, ~325/347) — this is what stops
  overlapping swimmers' hairs blowing out. A single all-hairs draw collapses the 8 attenuation levels → reintroduces the
  blow-out. ⇒ **My "one draw call for all hairs / same hairFBO … preserved by construction" was FALSE.** Keep the
  per-slab structure: **8 instanced draws**, one per slab into `hairFBO`. WebGL2 has **no baseInstance**, so before each
  slab's `drawArraysInstanced(TRIANGLES/STRIP, 0, 4, hairCount[k])` rebind each divisor-1 attribute's
  `vertexAttribPointer` with `byteOffset = hairStart[k]*stride`.
- **H2 (MAJOR) — params in SCREEN space, not world space.** Hair roots are derived screen-space today (`bez()` of screen
  points ~878, + merge-bend rotation ~879-881, + death-swell, + `*S`). World-space params would force reproducing
  merge-bend/death-swell/dome-weld in the shader (big refactor, real fidelity risk) for ~zero payoff (`render()`
  re-derives every hair every frame anyway; beat/drag animate per frame). ⇒ **Instance params = exactly emitHair's
  current inputs `{rx,ry, nx,ny, len, wid, theta, bright}` (screen space).** VS does screen→clip like the current
  `HAIR_VS` (~433); no camera uniforms. Supersedes the "world space … shaders project with the camera" text.
- **H3 (MAJOR) — θ≈0 is the CONSTANT case, not an edge case.** `beat=hairSway*sin(…)` (~885) crosses 0 twice per cycle
  for every hair, and `theta=beat−hairDrag*(v·perp)`. So `R=len/θ→∞` (catastrophic float cancellation) and any
  arc↔line discontinuity flickers on every hair every cycle. ⇒ Use a numerically stable arc-SDF (Inigo-Quilez
  half-aperture form, or arc-local coords) with a **seamless arc↔line blend over a small θ band**. Phase 0 MUST test an
  animated sweep of θ through 0, not a static hair.
- **H4 (MAJOR) — bounding quad must include the arc SAGITTA.** The arc bulges laterally by `sagitta≈R(1−cos(θ/2))≈
  len·θ/8` beyond the root→tip chord; a chord-aligned OBB + halfwidth CUTS the strand. ⇒ perp extent =
  `sagitta + halfwidth + AA`. Also **clamp |θ|** (≈2.5) and verify the real `part.velocity` range (with `hairDrag=1.0`
  a fast part could push |θ|>π where the arc curls >180° and the OBB + arc-param mapping degenerate).
- **H5 (MAJOR) — restate the goal: NOT "look-identical".** Today's hairs are hard-edged flat ribbons (`antialias:false`,
  ~188): **constant alpha ACROSS width**, linear alpha taper ALONG length (~789-792); the 4-segment joint gaps ARE the
  facets. An SDF necessarily adds edge AA + removes seams → intentionally smoother. ⇒ Goal = "**no facets; glow/taper/
  colour/additive preserved; edges necessarily smoother**." Match the profile: **flat box across width** (≤1px AA), not
  a Gaussian/"glow falloff across width"; `alpha=(1−param)*bright` along length. Neighbour-hair additive **summing is
  preserved** (each instance is its own additive fragment); only **self-overlap on an extreme arc** differs (SDF
  min-distance vs summed triangles) — acceptable, note it.
- **H6 (MAJOR) — the perf harness measures ZERO hairs; fix it before trusting numbers.** `hairLOD` fades hairs OUT at
  low zoom (~827) and `perf.mjs` runs at `zoom:1` → no hairs; facets appear at HIGH zoom where the frustum cull leaves
  few creatures (little hair CPU); the CPU bulk is at MEDIUM zoom. And `__bench` reports fused `gl.finish()` wall time
  while the win is CPU-side and the SDF's larger fragment footprint is a GPU-side RISK. ⇒ add a **medium-zoom,
  many-haired-creature** perf scene and **time the CPU emit loop separately** from GPU (before `gl.finish()`); Phase 3
  must prove the CPU win AND bound the new GPU cost.
- **H7 (MINOR) — Copy-Swimmer capture (`CAP.hairs`) breaks.** `hairTri` pushes corners into `CAP.hairs` (~773) for
  `captureCreatureGeom` (~962-970); instance params bypass `hairTri`. ⇒ either exclude hairs from the capture, or
  reconstruct arc→triangles for the capture path only. (Add `CAP` to the fidelity/hook list.)
- **H8 (MINOR) — goldens are EXACT-0 on the recording arch → don't lose the net mid-change.** Default the runtime toggle
  to the **OLD** path so `branchy` (zoom 26, hairs) + `speciated` mini stay green through Phases 1-2; A/B, then
  **re-record + flip the default in ONE commit**. Confirm the SDF's `atan2`/`sqrt` are cross-arch stable (maxΔ≤1,
  integer-hash-noise discipline) or widen the cross-arch tolerance for the hair scenes only.
- **H9 (MINOR) — the taper needs the per-pixel arc PARAMETER, under-specified.** param = angle-about-center ÷ θ (arc
  branch) / chord projection (line branch, θ→0); map param→width and param→alpha, `w→0` at param=1, flat root cap
  (occluded by the body). Phase 0 must prototype the param mapping, not just distance-to-arc.
- **H10 (MINOR) — beef up the gates.** Phase 0 must prove: animated θ-through-0 (H3), sagitta coverage at max θ (H4),
  tapered width+alpha as f(param) (H9), thin-width AA at several zooms. Phase 3 must include the medium-zoom CPU-vs-GPU
  split (H6).

**Verified correct (panel need not re-litigate):** the strand IS a circular arc (`ang += theta/HAIR_NSEG`, constant
curvature; `R≈len/theta`); WebGL2 has VS/FS only (no geometry/tessellation) so a fixed-N VS stays faceted; instancing +
`gl_VertexID` quad expansion is the right primitive (the fullscreen triangle already uses `gl_VertexID`, ~301); hairs are
view-only (no engine-determinism impact); the fidelity checklist is complete EXCEPT per-slab compositing (H1) + `CAP`
(H7); the VS-high-N-strip fallback is a clean drop-in.

## 5-panel review — folded in (2026-09-06; THIS is the governing spec; supersedes conflicting text above, incl. H1–H10 where noted)
Five distinct-lens reviewers (WebGL2 pipeline · shader-math/numerics · performance · fidelity/goldens · integration).
Three independent technical lenses converged on the same conclusion. Decisions P1–P6 govern.

- **P1 (THE DECISION) — the instanced VERTEX-SHADER HIGH-N STRIP is PRIMARY; the fragment arc-SDF is an optional,
  Phase-0-gated upgrade (was: SDF primary, strip fallback — INVERTED).** Perf, fidelity, and shader-math all independently
  said so:
  - **It kills the facets.** A 16–24-seg strip's max chord deviation ≈ `len·θ/(2·(2·N)²)`; at the complaint zoom
    (branchy, zoom-26), `len≈300px, θ≈2.5 → ~0.16px` — already sub-pixel/facet-free (len=100 → 0.05px).
  - **It captures the FULL perf win.** Both approaches ship the same ~8 params/hair and move the per-hair warp
    (~60–75% of per-hair CPU) to the GPU; the SDF adds *nothing* to the CPU win.
  - **It's the LOWER-RISK and HIGHER-FIDELITY path.** It keeps the PROVEN trivial passthrough `HAIR_FS` (436-443) →
    **no new per-pixel transcendentals**, so: no θ→0 cancellation (a real BLOCKER for the SDF — see P6), no in-shader
    `atan2` (absent from all shaders today; unmeasured cross-arch risk), no OBB fragment overdraw, no thin-line AA
    shimmer, no self-overlap loss on the beat peak, and — critically — **no dimming of the hero `branchy` frame** (the
    SDF's AA on ~2.3px-wide hairs would drop peak additive intensity ~40% + lower bloom). It also stays hard-edged →
    byte-closer to today and keeps `maxΔ≤1` cross-arch by construction.
  - **The SDF's only unique wins** are true AA on sub-pixel strands + a 1-quad footprint — and its AA is as likely to
    make the hero frame look *worse* (dimmer/softer) as better. ⇒ **Build the strip. Prototype the SDF in Phase 0 and
    adopt it ONLY if it clears a `branchy` cross-arch (`maxΔ≤1`, `diffFraction≤0.0005`) + brightness A/B gate.**
  - ⇒ **This retires the SDF-specific risks the hardening pass wrestled with** (H3 θ≈0, H4 sagitta/clamp, H5 flat-box
    AA, H9 taper param) — they now apply ONLY to the optional SDF upgrade (P6), not the shipping path. The strip's VS
    computes the arc at N discrete vertices (the same `ang`-stepping emitHair does, but on the GPU) — stable, no SDF.

- **P2 (WebGL2 pipeline) — instancing mechanics (this is the codebase's FIRST instancing):** dedicated **instanced VAO**
  with `vertexAttribDivisor(loc,1)` set **once at init** (in `initGL`, NOT `makeFBOSet` → survives resize/build/seed);
  **`TRIANGLE_STRIP` + `gl_VertexID`** corner/segment expansion (not `TRIANGLES`); instance params = 2×`vec4` divisor-1
  `{rx,ry,nx,ny,len,wid,theta,bright}` (screen space, H2). Per slab: `drawArraysInstanced(TRIANGLE_STRIP, 0, 2N+2,
  hairCount[k])`, rebinding each divisor-1 attribute's `vertexAttribPointer(byteOffset = hairStart[k]*stride +
  fieldOffset)` with the instance VBO bound to `ARRAY_BUFFER` and the instanced VAO bound. **`hairStart[k]` must be an
  INSTANCE index (paramsWritten/8), not the vertex index (`ho/3`) it is today.** Confirmed: no `baseInstance` in core
  WebGL2 (H1 correct), 8 per-slab draws is NOT a regression (already 8 today). Optional cleaner form: params in a
  texture/UBO + `texelFetch(uBase + gl_InstanceID)`, per-slab `uBase` uniform — removes all rebinds.

- **P3 (performance) — the perf gate + measurement (H6 was necessary but insufficient):**
  - `__bench` runs **SwiftShader** (software raster) → its GPU number CPU-rasterizes shaders and is a **pessimistic
    upper bound only**; the real-GPU verdict must come from **Karl's machine**. `EXT_disjoint_timer_query` is **absent in
    Safari** → don't gate on a GPU timer.
  - Instrument `__bench` to return `{tCPU, tGPU, nHairs, living}` — `tCPU` timed **before `gl.finish()`** (the CPU-emit
    metric); assert `nHairs>0` or the scene silently measures nothing (hairs are LOD-faded to zero at zoom-1, so the
    current perf scene measures ZERO hair cost).
  - **Add a medium-zoom "hairy" scene** (tune zoom so several creatures sit at lod≥0.5; assert `nHairs>2000`).
  - **GO to ship the strip:** `tCPU` median drops **≥15%** on `hairy` (A/B via the toggle). **SDF-over-strip:** only if
    `branchy` real-GPU regression ≤8% AND no cross-arch fail AND facets actually still visible to Karl at his zoom.
  - **Live FPS overlay + the A/B toggle = the real before/after** (Karl's request) — read old↔new on his GPU live.

- **P4 (fidelity/goldens):** the strip **avoids** the SDF's fidelity hazards (hero-frame dimming, beat-peak self-sum
  loss, cap-fan brightening) — all are SDF-only. Golden discipline (applies to whichever path): **do NOT blind re-record**
  — first measure per-scene hair-pixel presence on the OLD build; the provably-hairless scenes (`founders` ticks-0 bald,
  `adults` zoom-1) MUST diff **exactly 0** under the new path (the state-leak guard that catches a botched instance
  path); `speciated.mini` (256², widS≈1.25px) is the most AA-sensitive. For the strip, EXACT-0 on the recording arch
  should hold (no new transcendentals); re-record only the hair scenes, in one commit, with the non-hair scenes held
  fixed as the anti-masking guard.

- **P5 (integration) — toggle + coverage + build order:** ALL hair paths funnel through `renderView` (main, species
  minis, `__golden`, `__bench`, desktop `playbackLoop`, `resizeMain`, `interaction.visual.mjs`), so **one toggle covers
  everything**; the only separate path is CAP. Add **`window.__hairMode`** (default `'cpu'`, **read once per view**,
  snapshot to a local like `_cam` at ~1165) that gates the THREE seams atomically: emit-fn selection
  (`emitHair`→hairBuf vs `emitHairInstance`→instanceBuf), buffer upload, and draw. Land the toggle channel in **Phase 1**
  so A/B is testable headlessly from first light. **CAP/`captureCreatureGeom` is DEAD CODE (no caller anywhere) →
  delete it** (resolves H7 cleanly). Resize is a non-issue (hair program/VAO/VBO live in `initGL`, untouched by
  `makeFBOSet`) — state it so nobody wires an instance buffer into `makeFBOSet`.

- **P6 (shader-math) — applies ONLY IF the optional SDF upgrade is pursued:** ① near θ=0 the IQ arc-SDF still cancels
  catastrophically — **branch to the exact segment SDF**, switching on **sagitta-in-pixels < 0.5** (inherently
  C0-seamless, no blend band → no flicker; corrects H3). ② derive the taper param by **chord projection + a
  cross-product sign test — NO `atan2` in the fragment shader** (corrects H8/H9). ③ build the OBB from the **real tip**
  (`chord = 2R·sin(θ/2)` ≪ len) + one-sided sagitta; **clamp `|θ|≤~2`** (θ genuinely exceeds π for fast tails —
  `velocity`=per-tick displacement × `hairDrag=1.0`; the clamp also prevents self-overlap, dissolving the additive
  double-count concern; corrects H4's 2.5). ④ **energy-conserving thin-line AA** (hold a ≥0.5px footprint, scale alpha
  by `w/wc`) or sub-pixel strands shimmer (corrects H5). ⑤ bloom spreads any hair-edge cross-arch delta to ~9×9 →
  **expect to widen the hair-scene tolerance**; measure `branchy` arm64-vs-x64 in Phase 0. The strip needs NONE of this.

**CORRECTED BUILD ORDER (adopt):**
- **Phase 0** — a **servable** `hair-proto.html` (served by test/visual `server.mjs`, rendered headlessly via playwright
  + cached SwiftShader). Prototype BOTH the high-N strip AND the arc-SDF; headless-capture the gates (facet-free at
  branchy zoom; for the SDF also: animated θ-through-0, sagitta at max θ, taper, thin-AA, and **cross-arch maxΔ≤1 on
  branchy**). GO/NO-GO — and the SDF-vs-strip decision is made HERE on evidence.
- **Phase 1** — instance plumbing behind `window.__hairMode` (default `'cpu'`, read once per view); land the toggle in
  `__golden`/`__bench`/`interaction` first; render one part's hairs via the strip.
- **Phase 2** — wire side + cap hairs through the params path (taper/jitter/beat/drag/growth/LOD); record a NEW-path
  golden family (`*.gpu.png`) + a **fast-motion hairy scene** (the θ range neither existing golden exercises); run
  `interaction.visual.mjs` under `'gpu'` as a free GL-error net.
- **Phase 3** — Karl's-eyes A/B (incl. the fast-motion scene) + FPS overlay; H6 medium-zoom CPU-vs-GPU split.
- **Phase 4** — flip `__hairMode` default to `'gpu'`, re-record the hair goldens as the new reference (non-hair scenes
  held fixed), delete CAP — all in ONE commit.

## Provenance
Karl (2026-09-06): facets on long zoomed hairs; asked whether a hair/vertex shader kills facets + beats CPU warping.
Analysis: hairs are 4-segment CPU-tessellated circular arcs (HAIR_NSEG=4) with a passthrough shader. Recommendation:
instanced analytic-arc hairs (fragment SDF), vertex-shader high-N strip as fallback.
