# Example worlds

Runnable, arbitrary-world configs for the GenePool engine — a **faithful, arbitrary-worlds artificial-life
sandbox**. Each is a complete world *definition* (the arena owns all params); the runner adds a seeded founder
population and records the run.

## Run one

```sh
node tools/run-recorder.mjs --config examples/maze.json --founders 500 --food 1500 --ticks 3000
```

This runs the world to completion and writes two artifacts:

- **`run.jsonl`** — the append-only **source of truth**: a self-describing, rebuildable event stream (header with
  config + seed + content-addressed `runId`; founder/food-init events; births with gene-inheritance masks; deaths;
  eats). A different founder set or config is a different `runId`.
- **`run.db`** — a disposable **SQLite catalog** rebuilt from the JSONL: a genome-hash index (first appearance) and
  the birth-DAG edges. Query it, e.g.:

```sh
sqlite3 run.db "SELECT founders, births, deaths, genomes FROM runs"
sqlite3 run.db "SELECT parent_id, count(*) n FROM births GROUP BY parent_id ORDER BY n DESC LIMIT 5"
```

Useful flags: `--seed N` (deterministic — same seed + same config ⇒ identical run), `--founders N`, `--food N`,
`--ticks N`, `--out run.jsonl`, `--db run.db`. Convenience overrides: `--topology walls|torus`, `--isolation 0.9`,
`--maxPopulation N`, `--viewRadius`, `--sensoryPeriod`.

## The examples

| Config | Demonstrates |
|---|---|
| **`torus.json`** | A seamless **toroidal** world — movement, perception, food spawn, and obstacle line-of-sight all wrap across every edge (no walls). |
| **`maze.json`** | An **obstacle FIELD** — several movement+vision blockers plus one *vision-only* "glass" wall (per-obstacle `mask` and `thickness`). The engine imposes no obstacle; an empty list is a bare pool. |
| **`drought.json`** | A **parameter schedule** (§10): food regenerates every 20 ticks, then slows to every 400 at tick 4000 — a drought that forces a population crash and selection. Any schedulable value can step over time. |
| **`big-pool.json`** | **Arbitrary size** (P3): a 40 000² pool where `foodSpread` auto-scales to `poolWidth/2`, so the ecology behaves sensibly with no per-size tuning. |

## Write your own

A config is plain JSON; every field is optional and defaults sensibly (a minimal `{}` is a working 8000² walled
world). Notable fields:

- `pool: { left, top, right, bottom }` — world bounds (any size; a minimal config just works).
- `topology: "walls" | "torus"`.
- `obstacles: [ { a:{x,y}, b:{x,y}, thickness?, mask?:{movement,vision} }, ... ]` — empty/absent = none.
- `reproductiveIsolation` — junk-DNA speciation gate `[0,1]` (default 0.9; `1.0` = nothing interbreeds).
- Ecology: `foodRegenerationPeriod`, `foodSpread`, `maxFood`, `maxPopulation` (default ∞ = no cap),
  `crossoverRate`, `mutationRate`, `maximumLifeSpan`, `viewRadius`, `numFoodTypes`.
- **Schedules (§10):** any of `foodRegenerationPeriod`, `maxFood`, `maxPopulation`, `reproductiveIsolation`,
  `crossoverRate`, `mutationRate`, `foodSpread` may be `{ "schedule": [[tick, value], ...] }` (ascending ticks) to
  change over time.
