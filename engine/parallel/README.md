# Parallel GenePool engine (worker-thread, bit-identical)

Runs **one** GenePool pool across CPU cores and produces **exactly** the same result as the single-thread
engine — bit-for-bit, deterministically, at any worker count — only faster. (The directory is still named
`spike/` for git history; the code is productionized, not a spike.)

## How it works

- **Worker-owns-partition.** Each worker holds the *real* `Swimbot` objects for a slice of the pool; the heavy
  state (phenotype/brain/vectors) never crosses threads.
- **Shared frozen snapshot.** The small per-bot view everyone perceives (position, one attraction metric, …)
  lives in a `SharedArrayBuffer` (SoA). Perception runs the *same* `engine/perception.js` as `world.js`.
- **Cooperative neighbor grid.** A counting-sort CSR grid is built in shared memory by all workers together
  (zero → count → prefix-sum → scatter), so the build shrinks with worker count. `Atomics` barriers sync the
  phases; the race-ordered scatter washes out through the perception min-heap `(d²,id)` total order.
- **Serial deterministic resolution.** After the parallel update+perceive phase, **worker 0** resolves the
  cross-worker ecology (eats lowest-id-per-food; births ascending-parent-id; food regen) in ascending global-id
  order and writes back per-bot results; owners apply them at the next tick's start (the engine's T+1 birth
  semantics). Energy is written as the exact final value to SET (a delta would lose bit-identity to float
  non-associativity).

This mirrors `world.js`'s `perceptionMode:'snapshot'` tick, which is order-independent by design.

## Run it

    node engine/parallel/run-pool.mjs [founders] [ticks] [workers] [pool]
    # e.g. node engine/parallel/run-pool.mjs 6000 1000 10 16000

## Correctness gates

    node engine/parallel/run-g1.mjs       # BIT-IDENTICAL to world.js snapshot mode (W=1, W>1, and at walls)
    node engine/parallel/run-ecology.mjs  # DETERMINISTIC: coop-W == coop-1, full ecology
    node engine/parallel/run-g1-debug.mjs # tick-by-tick divergence finder (with the one-tick apply-lag offset)

`run-g1` is the strong gate: the parallel run at W=1 **and** W>1 is bit-identical to the single-thread engine
over a full-ecology run (forage/eat/mate/reproduce/die/regen), including a wall-hugging fixture.

## Measured (Apple M4 Max, 14 cores)

~4.5–4.9× at 8 workers on a large pool; scales 4→6→8, plateaus ~8. Speedup grows with pool size (the serial
resolve/regen tail is a smaller fraction). Always bit-identical to single-thread.

## Known limits / next steps

- **Capacity.** Ids are never reused, so buffers are sized to a ceiling (`maxBots = founders × 8`); worker 0
  stops minting at the ceiling. The real fix is slot-recycling (an id↔slot map with a ≥1-tick ghost).
- **2 food types.** The eat path assumes one food type (no `FOOD_TYPE_OFFSET`); add it for 2-type worlds.
- **Amdahl.** Worker 0's serial resolve/regen tail caps very food-rich pools; eats can be parallelized
  (per-food atomic lowest-id claim) if needed.
- **Not yet wired into `World`** as a first-class `executor` option — it's a standalone runner over the engine.
