# PLAN — GPU hair rendering (kill the facets, move the warp off the CPU)

Follows `docs/PLANNING-PROCESS.md`.

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

## Provenance
Karl (2026-09-06): facets on long zoomed hairs; asked whether a hair/vertex shader kills facets + beats CPU warping.
Analysis: hairs are 4-segment CPU-tessellated circular arcs (HAIR_NSEG=4) with a passthrough shader. Recommendation:
instanced analytic-arc hairs (fragment SDF), vertex-shader high-N strip as fallback.
