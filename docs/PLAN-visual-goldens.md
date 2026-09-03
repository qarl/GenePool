# PLAN — headless visual golden-masters for the WebGL viewer

Goal: run `viewer-micrograph-gl.html` **headless** and pixel-compare its render against stored **golden PNGs**,
so a refactor that changes the picture fails a test instead of Karl's eyes. This is also the concrete machinery
behind the species-viewers **2a byte-identical gate** (`docs/PLAN-species-viewers.md`) — that gate is unbuildable
without it.

Status: **capability PROVEN** (headless WebGL2 render captured). Harness + hook NOT built yet. Plan for review.

## What's already de-risked (proof done, 2026-09-03)
- Headless **Chromium** renders the viewer's **WebGL2** via **SwiftShader** (`ANGLE … SwiftShader Device, Vulkan
  1.3.0`) — a *software* rasterizer that kills GPU/driver variance. Full specimen render captured to PNG. POC:
  `scratchpad/visual-poc/{shoot.mjs,shot.png}`. **CAVEAT (see P0):** SwiftShader JITs to the host CPU, so bytes are
  identical only for the **same SwiftShader build + same CPU arch** (arm64≠x86-64), NOT "any machine."
- Driver = **`playwright-core`** (2 MB, pure JS) pointed via `executablePath` at the **already-cached** browser
  (`~/Library/Caches/ms-playwright/chromium_headless_shell-1217/…`, installed by the venv's Python Playwright). **No
  browser download.** Launch args: `--use-gl=angle --use-angle=swiftshader --force-color-profile=srgb`.
- Page is served by the repo's own **`engine/parallel/serve.mjs`** (COOP/COEP + module MIME) — needed because the
  viewer is `<script type="module">` importing `./engine/*.js` (file:// can't).

## Why goldens are even possible here (determinism audit — verified)
The viewer's render is a **pure function of `(seed, tickCount, frameCount)`**. Audited: **no `Math.random`, no
`Date.now`/`performance.now`, no `devicePixelRatio`** anywhere in the file. Specifically:
- `world = new World(config, seed)` — engine is deterministic (byte-identical per Node version; see `test/README.md`).
- Animation time is `hairTime = world.getClock()` — driven by tick count, **not** wall-clock.
- Floating detritus is seeded `mulberry32((seed>>>0) ^ 0x5eed1234)` and drifts `j.x+=j.vx` **once per `render()`** —
  deterministic given frame count.
So pinning `(seed, ticks, frames)` + SwiftShader ⇒ reproducible pixels. Reproducibility is pinned to the
**SwiftShader build (browser 1217) + CPU arch + Node version** (arch is the dominant cross-machine axis under
software rendering — `fract(sin()*k)` noise, `exp`, `pow` in the shaders JIT differently arm64 vs x86-64; consistent
with the README's existing "goldens pinned to a Node version" note). Goldens detect *regressions*, they are not
"what Karl's GPU shows."

## Prerequisites (P1 — not Karl-local accidents)
- **Browser provisioning must be scripted, not assumed.** The POC's "no download" only holds because Karl's venv
  already cached `chromium_headless_shell-1217`; on a fresh checkout / CI the cache lookup throws. Prereq: a pinned
  `npx playwright install chromium-headless-shell` at the Playwright version matching **build 1217**, on the
  **golden-recording arch**. Document it; don't rely on the ambient cache.
- **`.gitignore`:** add `test/visual/node_modules/` (the repo `.gitignore` currently ignores none). Ensure
  `test/visual/goldens/*.png` are **committed** (not ignored) — they're the reference.

## Architecture
- **Location:** `test/visual/` — repo-native Node, its **own `package.json` + gitignored `node_modules`** (only
  `playwright-core`). The core `node --test` suite stays **zero-dep**; visual tests are opt-in (env flag / separate
  invocation) so `test/**/*.test.js` still needs no install. One-time: `npm --prefix test/visual install`.
- **Deterministic render hook** (small edit to the viewer, INERT by default): expose
  `window.__golden = async (seed, ticks, frames=1) => {…}` that (1) **truly stops the rAF loop**, (2) rebuilds the
  world with `seed`, (3) `world.tick()` × `ticks`, (4) `render()` × `frames`, (5) returns raw pixels. Guard so normal
  boot is **unchanged** (only runs when called) — preserves current visuals AND keeps the species-viewers 2a
  baseline honest. Loop-stop detail (P1): **`running=false` does NOT stop rendering** — `loop()` calls `render()` +
  `requestAnimationFrame` unconditionally and `running` only gates `world.tick()` (viewer ~998–1001). Add a
  module-level `let loopStopped=false; function loop(){ if(loopStopped) return; … }` and set it before the
  rebuild→tick→render→readPixels sequence, so no stray rAF fires `render()` between our `render()` and `readPixels`
  (which — with no `preserveDrawingBuffer` — could hand back a cleared/garbage backbuffer). Also in the hook, for
  cross-build hardening + explicitness: `gl.disable(gl.DITHER)`; set `cam = {x:pool/2, y:pool/2, zoom:<scene>}`
  explicitly (build() preserves `cam.zoom`, viewer ~513); and log which `thickFmt` was chosen (P2 below).
- **Capture = `gl.readPixels` of the default framebuffer, in-page, right after `render()`** — raw RGBA, exact. NOT
  the compositor `screenshot()` (that needs `preserveDrawingBuffer`, and adds premultiply/compositor variance;
  `drawImage`-after-the-fact reads a cleared buffer — that's why the POC coverage probe read 0). readPixels is the
  canonical golden source; ship RGBA (or a PNG encoded in-page) to Node. Flip rows (readPixels is bottom-up) so the
  saved PNG is viewable; for the diff, flip is cosmetic (readPixels-vs-readPixels is self-consistent).
- **Compare (Node) — TWO modes:**
  - **Exact (0-diff)** for *same-arch, same-run* gates: harness-determinism gate (a) and the species-viewers **2a
    refactor gate**. Hash the raw RGBA `Uint8Array`; PNG is never a comparison surface.
  - **Committed regression goldens** (Karl's call: ONE golden set in the repo, NOT one per arch). **MEASURED
    2026-09-03** (arm64-native vs x86-64-under-Rosetta SwiftShader; `scratchpad/visual-poc/arch-probe.mjs`): the two
    arches even use different JIT backends (arm64=LLVM, x64=Subzero). Everything is **byte-identical** — linear
    arithmetic maxΔ=0, `exp`/`pow` maxΔ=0 — **EXCEPT** the `fract(sin()*43758.5453)` value-noise/worley (cyto+grain),
    which diverges hard: raw meanΔ≈13, maxΔ up to 255, ~20% of pixels >16. **Blur does NOT fix it** — the disagreement
    is coherent at **cell scale** (whole cells flip), not high-frequency dither (r=1..3 blur leaves meanΔ≈13). A loose
    tolerance that survives it would be blind to real regressions in exactly the textured interior we most want to
    protect. **So blur-tolerance is OUT.**
  - **FIX — DONE (`viewer-micrograph-gl.html` hash2, 2026-09-03).** Swapped the noise hash to an integer hash (uint
    mul/xor/shift, `float()/2^32`), keeping the value-noise/worley STRUCTURE. **Real-viewer cross-arch result** (the
    noise-heavy zoomed grain frame, arm64-LLVM vs x86-64-Subzero, `scratchpad/visual-poc/viewer-crossarch.mjs`):
    **maxΔ=1, meanΔ=0.0000, 0.000% of pixels differ** — down from maxΔ=255 / ~20% >16. So ONE committed golden works
    cross-arch with a trivial **`maxΔ ≤ 1`** tolerance (a real regression is many pixels off by a lot; nothing like a
    few 1-LSB pixels). The residual 1 LSB is a couple of pixels from some other transcendental (hair `sin` / rim
    `exp` at an AA edge) — not worth chasing to literal 0. Karl to eyeball the grain look (`grain-compare.png`).
  - On any mismatch, write a **highlighted diff PNG** as a human artifact only (encode in-page via canvas → data URL).
- **Two gates:** (a) render the same scene **twice** in one run → **0 diff** proves the *harness* is deterministic;
  (b) render vs stored golden → 0 diff proves *no regression*. Gate (a) is the first thing to green.

## Golden scenes (few + meaningful; each one PNG under `test/visual/goldens/`)
- `founders` — seed 1, ticks 0 (fresh pool layout).
- `adults` — seed 1, ticks ~3000 (grown, posed, mid-undulation; exercises ribbons/domes/hairs/cyto).
- `branchy` — a seed known to grow a multi-branch specimen (exercises the branch-merge/dome path — the hard-won fix).
- `empty` — a scene with no swimbots (wall + detritus only; catches background/wall regressions).
- (later) species-viewers layout once it exists.

## Build order
1. **Harness skeleton** `test/visual/` — `package.json` (playwright-core), `.gitignore` line, scripted browser
   provisioning (pinned build 1217 / recording arch), a `capture.mjs` (start serve.mjs on a private port → launch
   Chromium w/ SwiftShader → `page.evaluate(__golden…)` → readPixels → raw RGBA), and a `compare.mjs` (hash + delta +
   human diff image). Seed from `scratchpad/visual-poc/shoot.mjs`.
2. **Add `window.__golden` hook** to the viewer (inert-by-default): `loopStopped` guard, `gl.disable(DITHER)`,
   explicit `cam`, `thickFmt` log. Prove **gate (a)**: two runs of `adults` → 0 diff (proves harness determinism
   before any golden is trusted).
3. **Record goldens** for the scene set; **eyeball `founders`@0** first (confirm posed bodies, not a degenerate
   rest-frame). Add a `test/visual/*.test.js` that renders each and asserts 0 diff (skipped unless `GP_VISUAL=1` +
   install present). Document `--update-goldens`.
4. **Wire into the species-viewers 2a gate:** capture `adults`+`branchy` goldens on the CURRENT 900×760, do the
   `render()`→`renderView` refactor, re-run → require 0 diff. (This *is* PLAN-species-viewers Step 2a's gate.)
5. **CI note / README** — extend `test/README.md` with the visual-test invocation + version-pinning caveats.

## Risks / limits
- SwiftShader pixels ≠ real-GPU pixels; goldens are regression sentinels, not ground-truth-appearance. Fine for the
  refactor-safety mission.
- **Cross-arch (P0, Karl's directive = ONE committed golden set, approximate match — NOT per-arch).** SwiftShader
  JITs to the host CPU, so bytes differ arm64↔x86-64. But the difference is *structurally benign*: correctly-rounded
  IEEE add/mul/sub carry geometry + absorption + rim identically (worst case 1-ULP silhouette jitter from FMA
  contraction); the real disagreement is the high-frequency `fract(sin())` noise in cyto/grain. → the **blur→
  tolerance** compare mode above is what makes a single golden portable. **Measure the actual delta before locking
  the tolerance** (synthetic shader probe rendered on arm64 native + x86-64 under Rosetta; browserVersion
  147.0.7727.15 mac-x64 headless-shell). A browser/Node bump still needs a deliberate rebaseline (log it).
- **Probe `EXT_color_buffer_float` in the hook** — if SwiftShader lacks it, `thickFmt` falls back RGBA16F→RGBA8
  (viewer ~105–107) and the golden then tests a *degraded, thickness-clipped* path unlike Karl's GPU. Assert/log the
  chosen format; if it's RGBA8, the harness is measuring the wrong pipeline — flag loudly.
- **Coverage gap — the death-fade path is not exercised** by build→tick→render (no frame history, so a bot that dies
  vanishes rather than fading). Either add a scene that drives several `render()` calls across some deaths, or note
  the gap so nobody assumes fade-rendering is golden-protected.
- **2a tie-in gates MAIN-VIEW invariance only.** This harness proves `render()`→`renderView` keeps the 900×760 output
  byte-identical — exactly the extraction guarantee. It cannot yet gate the new 256² small-tile renders (`W`/`H` are
  module consts; the variable-size FBO path is new code with no prior golden). Don't over-trust the gate past that.
- Text (species counts, later) may rasterize differently across builds — but there is **no in-canvas text today**
  (HUD is HTML). When counts land, render labels on a separate layer or tolerance-mask those rects.
- `readPixels` on the default framebuffer must run before the next rAF; the hook owns the loop (via `loopStopped`),
  so it's exact. Confirmed: `render()` leaves the **default FBO bound** (viewer ~952) with the composited frame.
