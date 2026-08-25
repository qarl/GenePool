# Gene Pool — tests

Zero-dependency tests using Node's built-in runner. Nothing to `npm install`.
Requires **Node ≥ 22** (the glob run command below needs `node --test` positional
globs, added in Node 21; CI pins 22).

**Run (from the repo root):**

```
node --test 'test/**/*.test.js'
```

`node:test` runs each test file in its own child process.

## Layout

- `helpers/` — shared harness (also reused by the future headless CLI):
  - `load-sim.js` — loads JJ's **unmodified** `GenePool/simulation/*.js` into Node by
    concatenating them in `index.html` order and running once via `vm.runInThisContext`
    (reproduces the browser's shared `<script>` scope). Memoized. Exposes `__GP`.
  - `prng.js` — `mulberry32`, a small public-domain seedable PRNG.
  - `boot.js` — boot a seeded, rendering-off `GenePool`; `step(gp, n)`; `poolDataNoCamera(gp)`.
  - `invariants.js` — architecture-agnostic structural invariants (`checkInvariants`).
- `sim/` — simulation-level tests (smoke, determinism, invariants over a run).

## How it works (the load-bearing details)

- **Seed AFTER `loadSim`, before `initialize()`.** The bundle's top-level
  `function gpRandom()` redefines the global on load, so an earlier seed is clobbered.
  Construction is RNG-free, so seeding between load and the first `initialize()` draw works.
- **Rendering is off.** `initialize()` / `startSimulation()` set `_rendering = true`; the
  render path needs a real canvas, so `boot()` calls `setRendering(false)`.
- **Camera excluded from comparisons.** `getPoolData().cameraX/Y/Scale` are
  wall-clock/render-derived and not deterministic — `poolDataNoCamera()` strips them.
- **Determinism is per-Node-version.** Same seed → byte-identical state within one Node
  version. Goldens (added later) will be pinned to a specific Node version; these smoke
  tests self-compare in-process, so they pass on any version.

Nothing here modifies JJ's `GenePool/` sources — tests drive the sim through its public API.
