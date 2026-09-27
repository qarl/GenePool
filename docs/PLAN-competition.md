# PLAN — pool-vs-pool competition (`compete` CLI, headless, disk-free)

## Goal (Karl)

> "put these seeds into competition… find a good pool in each, save it out… load two seeds, execute for 1 day
> in game time, see who dominates." Delivered as a command-line tool shipped WITH the app (run like `gen-ctl`,
> via electron-as-node / a `.cmd` shim), **headless, saving nothing big** (disk is ~full).

Confirmed defaults: champion pool = each seed's **largest species at day 1**; "dominates" = **most alive at the
1-day mark** (one side going extinct first = instant win).

## Key safety: ZERO engine change — teams tracked EXTERNALLY

Each creature's team (A or B) is tracked in a harness-side `Map<id, 'A'|'B'>`, NOT in the engine:
- Initial creatures get their team from which pool they were merged from.
- The engine already emits `{type:'birth', id, parentId, mateId, ...}` (world.js:563). On each birth the harness
  sets `teamOf[id] = teamOf[parentId]` (child inherits its primary parent's team; cross-team births are rare —
  the speciation gate isolates two different seeds' junk-DNA — and resolve to the parent's team).
- Living-per-team = iterate the world's living swimbots, look up `teamOf[id]`.

So the sim is byte-identical to a normal run; determinism, goldens, and the pmath epoch are all untouched. The
harness only READS events + world state.

## Delivery: `tools/scrub/compete.mjs` (+ `compete.cmd` for Windows)

Runs via node (dev) or the app's electron-as-node (packaged), cross-platform, like gen-ctl. Subcommands:

- `compete champion <seed|all>` — extract each seed's champion pool.
- `compete match <A> <B> [--days 1] [--json]` — headless match, print the result. A/B = seed numbers (use their
  champion pools) or `.pool` paths.

Nothing large is written; only the small champion `.pool` files (a single frame, ~few MB each; 50 ≈ ~200 MB).

## 1. Champion extraction (`compete champion`)

Per seed db: `openRunReader` → restore the frontier keyframe (day-1 world) → `createSpeciesAnalyzer` → find the
**largest species** (most members) → build a fresh `World` containing ONLY that species' creatures
(`loadSwimbot` each, preserving genes/age/energy) → `serialize()` → write `<userData>/champions/seed-N.pool`.
(Food is NOT part of the champion — the arena supplies fresh food.) Read-only on the seed dbs.

## 2. The match (`compete match A B`)

- Fresh `World` on a standard arena config (`poolConfig(POOL_DEFAULTS.pool, POOL_SETTINGS)`).
- Merge champion A (team A) and champion B (team B) with the Import=merge machinery (`loadSwimbot` with fresh
  ids, positions clamped into the pool). **Placement: team A seeded into one half, team B into the other**, so
  they start separated and expand into contact. Record each initial id's team.
- Add fresh food (arena's normal food count).
- Attach `world._onEvent`: on `birth`, `teamOf[id] = teamOf[parentId]`; (deaths need no handling — living count
  is read from the world).
- Tick `--days` × 5,184,000. Every `keyframeInterval` (2000) ticks, sample `{tick, aliveA, aliveB}` for a
  downsampled curve; detect first extinction of a side.
- **Result:** `{ winner: 'A'|'B'|'tie', aliveA, aliveB, extinctionTick|null, curve:[…] }`. Winner = more alive
  at the final tick; earlier total extinction of one side = instant win. Print human-readable + `--json`.

## Determinism / reproducibility

Same (A, B, days) → identical result: deterministic engine (pmath) + deterministic merge (fixed id/position
assignment) + fixed team labelling. No RNG in the harness.

## Performance (honest)

A 1-day match ≈ 5.2M ticks ≈ **~15 min** headless (single-thread; no DB overhead helps). Fine for a matchup or
two; a full round-robin of 50 would be long — `--days 0.5` (or fewer ticks) gives faster verdicts. Not
parallelised in v1 (could fan matches across cores later).

## Open questions (for review)

1. **Placement** — team A in one half / team B in the other (my default) vs fully intermixed vs concentric?
   Different placements change the contest (separation lets each establish before clashing).
2. **Arena size/food** — standard 3000 pool + default food? Or a bigger arena for two established species?
   Food scarcity is the pressure that decides domination — is default food the right level?
3. **Champion size normalization** — species vary in headcount; do we cap each champion to the same N (fair
   start) or let them enter at their natural size (bigger species starts ahead)? Fairness vs realism.
4. **Cross-team birth** — inherit `parentId`'s team (my default). Confirm that's the intended rule (vs mark
   "mixed"/exclude). Expected to be rare via the speciation gate.
5. **Win metric edge** — pure final headcount, or weight by total biomass/energy? (Default: headcount.)
6. `champion all` runtime — extracting 50 champions is 50 keyframe-restores + species computes (fast, seconds
   each); fine.

## Review 1 — folded (no blockers; sound + engine-non-invasive)

Team-tracking via birth events CONFIRMED correct (child ids never reused in the single-thread world.js engine;
parents always already labelled; deaths need no handling). Fixes folded:
- **Champion selection is a one-shot greedy cluster, NOT the viewer's incremental partition** — drop the
  "same as the viewer" claim. It's still deterministic + a reasonable "largest cluster." MUST pass the seed's
  stored config to `createSpeciesAnalyzer(config)` (evolvableMutationRate → cluster over NJ-1). Sanity-check the
  one-shot largest-count against the run's stored `stats` top lineage; warn on big divergence.
- **Cross-team mating is NOT guaranteed rare** (both seeds start junk-zeroed, only 1 day of drift). The tool
  MUST compute + report cross-pool `junkSim` (>0.9 ⇒ they'll interbreed) and COUNT cross-team births; hybrids go
  to a neutral 'H' bucket (not counted for either side), so a blended pool yields an honest "inconclusive /
  N hybrids" result, never a bogus winner.
- **Real half-placement** (not the import clamp, which piles creatures on the boundary): scatter team A into a
  left sub-disk (~pool·0.25, pool·0.5, r≈pool·0.22) and team B into a right one via a FIXED-SEED rng (mulberry32
  of the match seed) → deterministic, separated.
- **Target the day-1 keyframe**: `getKeyframe(5_184_000)` (clamps to frontier, lands on the nearest thinned
  keyframe ≤ day 1). Handle not-yet-day-1 (use latest) and extinct/tiny largest-species (warn/skip).
- **Fairness**: default equal-N — cap both champions to `min(countA,countB)`, take each team's top-N by energy;
  `--natural` allows real sizes. Report raw + normalized. (Shared arena `maxPopulation:2000` cap means a bigger
  starter fills the ceiling first.)
- **Arena**: `poolConfig(POOL_DEFAULTS.pool, POOL_SETTINGS)`; pin a deterministic masterSeed derived from A,B;
  assert each seed's stored config is compatible. Attach `_onEvent` AFTER the merge (so founder/food_init events
  are ignored); handler switches on `ev.type==='birth'` only.
- **Perf**: ~15–40 min per 1-day match single-thread; expose `--days` AND `--ticks`; early-stop on extinction.
  v1 not parallel. Champions to `<userData>/champions/` via `jobsDir()`; `.pool` uses the `gpool` shape.

## Rollout

`tools/scrub/compete.mjs` + `compete.cmd` (+ maybe a shared `pool-io` helper for load/save `.pool`). No engine
change, no golden change. Ship into the app's tools like gen-ctl. A live "watch a match in the viewer" mode is a
possible follow-on (also disk-free) — out of scope for v1.
