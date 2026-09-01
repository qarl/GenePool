# Parallel engine — the dead-ghost frozen-slot divergence (FOUND + FIXED)

**Status:** ✅ RESOLVED 2026-09-01 (`engine/parallel/partition.mjs` `writeAndCount`). Found while building the
live-World bridge (`runPoolParallelToWorld`, "C"); its full-state gate + an independent review surfaced it.
**Severity was:** correctness — the parallel engine could **silently diverge** from single-thread `world.js`
snapshot mode outside the narrow domain the G1 gate covers. Kept as a record because the bug was subtle and the
one-tick-ghost contract is easy to reintroduce.

## Symptom
`runPoolParallel` / `runPoolParallelToWorld` are contracted "bit-identical to `world.js` snapshot, or loudly
reject." Bit-identity held at the G1 gate point (N=1500, ticks=300) but broke, silently, on:
- **Old-age death** — any run where a bot dies of old age (`age > maximumLifeSpan`). (Old-age *shrinking* and
  *starvation* death stayed bit-identical — only the death-of-a-pursued-bot case mattered, see root cause.)
- **Large-N long runs** — e.g. N≥2000 over ≥~2500 ticks. Living counts still matched; per-bot state drifted.

Both were the SAME bug. It is rare-ish because it needs a bot to be pursuing a specific mate that dies — the
probability rises with population × ticks, and old-age death just makes deaths (hence pursued-mate deaths) common.

## Root cause
When a swimbot dies, the parallel engine keeps it ONE more tick as a "ghost" (so a pursuer's lingering `_chosenMate`
SlotView still resolves) — mirroring `world.js` snapshot mode, where a swept bot's `FrozenSwimbot` lingers one tick
via `markDead()`. But `markDead()` **does not move the ghost** — it keeps the tick-START genital from the ghost's
last live `_buildSnapshot` refresh. The parallel `writeAndCount` (Phase 2) instead re-wrote EVERY kept bot's frozen
slot each tick, including the dead ghost — and a dead bot skips `update()`, so `getGenitalPosition()` returned its
**post-final-update** position. So on the ghost tick a pursuer read the ghost's post-update genital in parallel vs
the tick-start genital in `world.js` → it steered toward a slightly different point → a ~1e-7 delta that amplified.

Pinpointed with `run-g1-debug.mjs 2000 2500 8000`: first divergence tick 1628, at **W=1** (so not worker
parallelism — a `Partition`-vs-`world.js` tick difference), bot 406 x = ...98944 (world) vs ...99232 (parallel).

## Fix
`writeAndCount`: for a DEAD (ghost) bot, set only `F_ALIVE = 0` and **preserve** the rest of its frozen slot (above
all the genital) — leaving this tick's earlier live write intact, exactly the tick-start position `world.js`'s ghost
keeps. Live bots are written as before. Not counted into the grid (dead == unperceivable), unchanged. The one-tick
ghost lifecycle is unchanged (next tick `applyDeltas` drops it, since `F_ALIVE` is now 0).

## Verification (all bit-identical after the fix)
- `run-g1` (`19cf7ef`), `run-api`, `run-grow`, `run-foodgrow`, `run-freerun-g1`: all still green.
- `run-g1.mjs 2000 2500 8000`: W=1 AND W=8 bit-identical (was DIVERGED); `run-g1-debug` 2000/2500: no divergence.
- Old-age death: N=800/ls=10500, N=1200/ls=11000, N=800/ls=9000 — all MATCH (were DIVERGED).
- Sweep (W=8): N=2500 dense & sparse × 2500t; N=3000×2000t; N=2000×3000t/ls=15000; N=1200 sparse/ls=11000 — all MATCH.
- `run-tw.mjs` (the C bridge): the sparse-food ghost-VIEW scenario (ghostViews=2) is now bit-identical end-to-end.

## Note
This retroactively validates `runPoolParallel` (shipped in "A") far beyond its original G1-only verification, and
makes `runPoolParallelToWorld`'s ghost-view extraction correct (the frozen slot now holds the faithful ghost genital).
No guard is needed; the previously-considered "reject old-age runs" guard was removed as unnecessary.
