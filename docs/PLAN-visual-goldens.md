# PLAN — headless visual golden-masters for the WebGL viewer

Goal: run `viewer-micrograph-gl.html` **headless** and pixel-compare its render against stored **golden PNGs**,
so a refactor that changes the picture fails a test instead of Karl's eyes. This is also the concrete machinery
behind the species-viewers **2a byte-identical gate** (`docs/PLAN-species-viewers.md`) — that gate is unbuildable
without it.

Status: **capability PROVEN** — headless WebGL2 render captured; the `__golden` hook + arch-stable integer-hash noise
are BUILT & committed (`4413146`); **gate (a) empirically proven** (3 separate arm64 launches of the noisiest frame →
identical sha256, byte-identical PNGs → same-machine 0-diff holds, and `maxΔ=1` is confined to the cross-arch axis).
The `test/visual/` harness is **BUILT & green** (all 4-lens fixes baked in): `capture`/`compare`/`server`/`browser`/
`png` libs, `scenes.mjs` (founders/adults/branchy/dying), `record.mjs` (arch-guarded), `gate-a.mjs`, and
`goldens.visual.mjs` (`node --test`, 4/4 pass exact-0 on arm64). Goldens + METADATA committed. Core zero-dep suite
still 299/0 (glob doesn't sweep `*.visual.mjs`). Reviewed twice (a first-draft agent + a 4-lens review vs committed
code): correctness=sound-with-fixes, hash-quality=ship-as-is, harness-design=ready-with-fixes, flakiness=robust-with-fixes.
Remaining: step 4 (wire the actual 2a refactor when it exists) + the deferred `empty` scene (needs a skip-founders hook arg).

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
- **Browser provisioning must be scripted AND asserted, not assumed.** The POC's "no download" only holds because
  Karl's venv already cached `chromium_headless_shell-1217`; on a fresh checkout / CI the cache lookup throws. Prereq:
  a pinned `npx playwright install chromium-headless-shell` at the Playwright version matching **build 1217**, on the
  recording arch. **ASSERT the running build == 1217** — `capture.mjs`'s prototype does `readdirSync(...).find(d =>
  d.startsWith('chromium_headless_shell-'))`, which grabs *any* cached build (a silent SwiftShader bump → false golden
  diffs); pin it, and derive platform/arch from `process.platform`/`process.arch`, not a hardcoded `mac-arm64`. Pin an
  exact `playwright-core` in `package.json`. Record browser build + `process.version` in `goldens/METADATA.json` and
  fail the compare on mismatch.
- **`.gitignore`:** add `test/visual/node_modules/`. (The repo `.gitignore` DOES exist — it ignores `.DS_Store`,
  `*.swp`, `run.jsonl`, etc. — just not node_modules.) Ensure `test/visual/goldens/*.png` are **committed** (never
  slip a `*.png` ignore in) — they're the reference.

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
  - **Compare rule (codified — closes the masking hole):** pass iff **`maxΔ ≤ 1` AND nonzero-diff-pixel-fraction ≤ ε**
    (ε ≈ 0.05%; measured residual was 0.000%). `maxΔ≤1` ALONE silently passes a *systematic* whole-frame 1-LSB shift
    (a gamma/tone/AA-feather regression) — the **count cap is the real guard**. On the **recording arch (arm64 dev
    loop) require exact 0**; the tolerance is only for the rare cross-arch check.
  - On any mismatch, write a **highlighted diff PNG to a FILE** the harness/CI can archive (not just an in-page data URL).
- **Two gates:** (a) **PROVEN 2026-09-03** — same scene, **two SEPARATE browser launches** on arm64 → identical
  sha256 / byte-identical (twice-in-one-process shares a warm JIT, so it's weaker; the two-launch form is the real
  guard and it's green). (b) render vs stored golden → passes the compare rule above. Gate (a) greens before any
  golden is trusted.

## Golden scenes (few + meaningful; each one PNG under `test/visual/goldens/`)
- `founders` — seed 1, ticks 0 (fresh pool layout).
- `adults` — seed 1, ticks ~3000 (grown, posed, mid-undulation; exercises ribbons/domes/hairs/cyto).
- `branchy` — a seed known to grow a multi-branch specimen (exercises the branch-merge/dome path — the hard-won fix).
- `dying` — **interleaved tick→render** so a specimen dies MID-capture and the death-fade path (`fades`/`deathTick`)
  actually renders. **Required to gate 2a** — that death-fade bookkeeping is precisely what 2a hoists; a plain
  ticks-then-render capture never exercises it, so this scene is load-bearing, not optional.
- `empty` — no swimbots (wall + detritus only). NOTE the hook always seeds founders → needs a skip-founders/config
  override on `__golden`, or drop it and cover wall/background via a corner crop of another scene.
- (later) species-viewers layout once it exists.

## Build order
1. **Harness skeleton** `test/visual/` — `package.json` (pinned playwright-core), `.gitignore` line, a scripted+
   **asserted** browser install (build 1217; NOT glob-any-cached). `capture.mjs`: start serve.mjs on an **ephemeral
   port** (`listen(0)`, read `address().port`) with a real **readiness wait** (poll until 200) and a serve.mjs
   **`.on('error')`** so a bind failure is loud, not silent; launch Chromium w/ SwiftShader; wait on
   **`waitForFunction(()=>window.__golden)`** (drop flaky `networkidle`); **throw on any pageerror/console.error**;
   `__golden`→readPixels→raw RGBA; **assert `thickFmt`==RGBA16F, fail loudly on RGBA8 fallback.** `compare.mjs`: lean —
   exact-hash + `maxΔ` + nonzero-fraction + a diff PNG **to disk** (do NOT port arch-probe's `blur()` — blur is OUT).
   Factor the copy-pasted PNG encoder into one `png.mjs`.
2. **Hook — DONE & committed (`4413146`)** (`loopStopped`, DITHER off, explicit cam, focus-on-biggest). So this step is
   **verify gate (a)** — two SEPARATE arm64 launches of the noisiest scene → 0 diff (**PROVEN 2026-09-03**). Hook TODO
   still: **return `thickFmt`/`floatRT`**, and add an **interleaved tick→render mode** (for the `dying` scene, step 4).
3. **Record goldens.** Spec files named **`*.visual.mjs`, NOT `*.test.js`** — the core `node --test 'test/**/*.test.js'`
   glob imports playwright-core at load and would break the zero-dep suite + ubuntu CI (reproduced). Run via a separate
   `GP_VISUAL=1 node --test 'test/visual/**/*.visual.mjs'`. **Eyeball `founders`@0** first. Add a
   `record.mjs`/`--update-goldens` that **refuses to run off the recording arch / wrong build**.
4. **Wire the species-viewers 2a gate:** capture `adults`+`branchy`+**`dying`** on the CURRENT 900×760, do the
   `render()`→`renderView` refactor, require **exact 0**. ⚠ The death-fade bookkeeping (`known`/`deathTick`/`fades`)
   that 2a HOISTS is ONLY exercised by the interleaved **`dying`** scene — so it's load-bearing, or the gate has a hole
   exactly where 2a's risk is.
5. **CI/README** — state the visual gate is a **local/opt-in arm64 gate, NOT part of the ubuntu `node --test` CI**
   (measured arm64 vs Rosetta-x64 only; ubuntu is x64, unmeasured, no playwright). If ever in CI → arm64 runner or
   re-measure. Extend `test/README.md` with the invocation + version/arch-pinning caveats.

## Risks / limits
- SwiftShader pixels ≠ real-GPU pixels; goldens are regression sentinels, not ground-truth-appearance. Fine for the
  refactor-safety mission.
- **Cross-arch — RESOLVED (ONE committed golden, not per-arch).** SwiftShader JITs per-arch (arm64 LLVM / x86-64
  Subzero); everything is bit-identical EXCEPT transcendentals. The old `fract(sin())` noise diverged badly (maxΔ=255,
  ~20% >16, cell-coherent so **blur-tolerance was measured and REJECTED**), so it was **swapped to an integer hash**
  (DONE) → real-viewer cross-arch `maxΔ=1`. The residual couple of `pow`/`exp` LSBs are handled by the codified
  `maxΔ≤1 + fraction≤ε` rule. **Scope:** local/opt-in **arm64** gate, exact-0 on arm64; the cross-arch number was
  arm64-vs-**Rosetta**-x64 (strong proxy, not native Intel — so `maxΔ=1` is indicative; a definitive cross-arch
  rebaseline should eventually run native x64, or just treat goldens as arm64 regression sentinels). Any
  browser/Node/arch bump needs a deliberate, ASSERTED rebaseline.
- **Probe `EXT_color_buffer_float` in the hook** — if SwiftShader lacks it, `thickFmt` falls back RGBA16F→RGBA8
  (viewer ~105–107) and the golden then tests a *degraded, thickness-clipped* path unlike Karl's GPU. **Hard-fail**
  (not just log): the hook must return the format and the harness aborts on RGBA8.
- **Death-fade path** is unreachable by plain ticks-then-render (build() clears `fades`; no ticks between frames) —
  and it's exactly the bookkeeping 2a HOISTS, so it's load-bearing. The **`dying` scene + interleaved tick→render hook
  mode** (build order steps 2–4) is REQUIRED, not optional.
- **2a tie-in gates MAIN-VIEW invariance only.** This harness proves `render()`→`renderView` keeps the 900×760 output
  byte-identical — exactly the extraction guarantee. It cannot yet gate the new 256² small-tile renders (`W`/`H` are
  module consts; the variable-size FBO path is new code with no prior golden). Don't over-trust the gate past that.
- Text (species counts, later) may rasterize differently across builds — but there is **no in-canvas text today**
  (HUD is HTML). When counts land, render labels on a separate layer or tolerance-mask those rects.
- `readPixels` on the default framebuffer must run before the next rAF; the hook owns the loop (via `loopStopped`),
  so it's exact. Confirmed: `render()` leaves the **default FBO bound** (viewer ~952) with the composited frame.
