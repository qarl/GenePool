# Visual golden-masters (`test/visual/`)

Headless WebGL2 pixel regression tests for `viewer-micrograph-gl.html`. A refactor that changes the rendered picture
fails a test instead of relying on eyeballs. This is also the byte-identical gate for the species-viewers **2a**
`render()`→`renderView` refactor (`docs/PLAN-visual-goldens.md`).

**Isolated + opt-in.** This dir has its own `node_modules` (only `playwright-core`), so the zero-dep core suite
(`node --test 'test/**/*.test.js'`) never touches it — specs here are named `*.visual.mjs`, not `*.test.js`, so the
core glob can't sweep them.

## Setup (one-time)
```
npm --prefix test/visual install                 # installs playwright-core (pinned)
```
Also requires the **pinned headless browser, build 1217** at
`~/Library/Caches/ms-playwright/chromium_headless_shell-1217/…`. If it's missing, the tests **skip** (not fail) with
an install hint; provision it with a Playwright whose browser revision is 1217 (e.g. the repo's venv Python
Playwright, or `npx playwright install chromium-headless-shell` at the matching version). `lib/browser.mjs` asserts
build 1217 — a silent browser bump would change SwiftShader and invalidate the goldens.

## Commands
```
npm --prefix test/visual test        # run the golden tests (node --test goldens.visual.mjs)
npm --prefix test/visual run gate-a  # determinism gate: render the noisiest scene in 2 launches -> byte-identical
npm --prefix test/visual run record  # (re)record goldens/*.png + METADATA.json   [subset: node record.mjs branchy dying]
```

## How it works
- **Determinism.** The render is a pure function of `(seed, ticks, frames, opts)` — no wall-clock / `Math.random` /
  DPR; animation time is the sim clock. The viewer's inert `window.__golden(seed, ticks, frames, cam, opts)` hook
  stops the rAF loop, rebuilds at the seed, advances the sim, renders, and returns raw `readPixels`.
- **SwiftShader.** Chromium runs headless with `--use-angle=swiftshader` — deterministic *software* WebGL2, so the
  bytes don't depend on a GPU/driver.
- **Compare policy.** EXACT 0-diff on the **recording arch** (arm64); cross-arch uses `maxΔ ≤ 1` **AND** a tiny
  differing-pixel-fraction cap (`maxΔ≤1` alone would mask a systematic whole-frame 1-LSB shift). The noise hash is an
  integer hash (not `fract(sin())`) precisely so cross-arch stays within that bound — do not revert it.
- **Scope.** This is a **local / opt-in arm64 gate**, NOT part of the ubuntu `node --test` CI (that runner is x64,
  unmeasured, and has no browser). Run it on arm64 (Karl's machine or an arm64 runner). The cross-arch tolerance was
  measured arm64 vs x86-64-under-Rosetta — a strong proxy, not native Intel.

## Scenes (`scenes.mjs`)
| scene | what it protects |
|-------|------------------|
| `founders` | fresh seeding + initial posed bodies |
| `adults` | many-creature path: frustum culling, LOD, detritus, wall |
| `branchy` | zoomed body detail: ribbons, tip-dome/branch-merge, hairs, cytoplasm+grain |
| `dying` | interleaved tick→render so specimens die mid-capture → the **death-fade** path (what 2a hoists) |

## Frame-rate regression (`perf.mjs`)
Times the render headless on a fixed **zoomed-out, whole-pool** scene (seed 1, 60k ticks, zoom 1 -> every living
creature on-screen + all detritus = the worst case) and compares to `perf/baseline.json`.
```
npm --prefix test/visual run perf              # measure + compare to the baseline (flags >8% median change)
npm --prefix test/visual run perf -- --update  # record the current result as the new baseline
node perf.mjs --junk 0.4                        # A/B the detritus load (fraction of MAX_JUNK)
```
Headless SwiftShader is far slower than a real GPU (baseline ~180 ms/frame), so the absolute number is meaningless --
it's a **consistent relative yardstick on the same machine/arch** for catching per-commit regressions. Workflow to
compare a change: `run perf -- --update` on the parent commit, make the change, `run perf` to see the delta. Uses an
inert `window.__bench` hook (performance.now for timing only; never affects render output, so goldens are untouched).
The baseline is arch-stamped and refuses to compare across arches.

## Rebaselining
`record.mjs` **refuses to run off the recording arch**. After an intentional visual change, re-record on arm64,
eyeball the goldens, and commit the new `*.png` + `METADATA.json` in the same change. `*.diff.png` artifacts (written
on failure) are gitignored. Rebaseline sparingly — each is a non-delta-compressible binary in history.
