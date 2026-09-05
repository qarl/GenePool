# PLAN — scrub + playback (generate-ahead, deterministic replay)

Turn the desktop app from a live-watcher into a **generate-then-scrub player**. Pick a seed → a background generator
runs the sim flat-out and records a **sparse** run to SQLite; the viewer plays *from the database*, and because the sim
is deterministic any exact tick is reconstructed by restoring the nearest keyframe and re-simulating the remainder.

## Model
- **Determinism is the trick** (like a video codec): store sparse **keyframes** (`World.serialize()`), not every frame;
  "decode" a tick by `restore(nearest keyframe ≤ T)` + `tick()` the remainder. `restore` resumes bit-identically
  (`engine/world.js:693/743`), so reconstruction is frame-perfect.
- **Everything is single-thread DEFAULT perception.** Measured: ~900 ticks/s at high population (~1400 bots) up to
  ~2,600/s at ~800 bots (≈1.3M bot-ticks/s ÷ pop). The parallel/snapshot engine was measured and REJECTED for this: it
  scales only ~3× at W=10 AND needs snapshot mode (~4× slower/tick), netting ≈ single-thread default while making
  playback re-sim slower — not worth it. Generation racing ahead single-thread easily outpaces viewing.

## Threads (this is the core of Karl's question)
Single-threaded JS means two loops on the same thread **would** block each other — so they must be on **separate
threads**:
- **Generator** = an Electron **`utilityProcess`** (real Node, isolated). Runs the JS engine from tick 0 flat-out,
  writing keyframes + events + stats to the run's `.db` via `node:sqlite`. This is where the "SQLite in a separate
  thread" happens — and it's essential, not just nice: it keeps all sim + DB-write work off the render thread.
- **Main** opens the SAME `.db` as a **concurrent reader**. `node:sqlite` in **WAL mode** (the sink already sets
  `journal_mode=WAL`) allows one writer + readers at once, so main can answer "nearest keyframe ≤ T" while the generator
  is still writing. No blocking, no IPC of the whole stream.
- **Renderer** = the player: scrub UI + `restore` + small re-sim delta + render. Re-sim deltas are small (≤ keyframe
  interval), so keeping them in the renderer is fine; drag-snap (below) means it rarely re-sims at all.

So: generator thread and playback thread run on different cores → they genuinely don't stall each other. ✔ (Answering
Karl: not because single-threaded — *because separate-threaded*.)

**Decision — keep the DB writer INSIDE the generator (2 threads, not 3).** Karl asked whether to split the run-ahead
writer into its own thread (display sim / run-ahead sim / run-ahead writer). Rejected as not worthwhile: we're
COMPUTE-bound, not I/O-bound — the sim does ~1,000 ticks/s while batched WAL inserts do >100,000/s, so a writer thread
would sit ~99% idle. Worse, feeding it means shipping thousands of small event objects/s across a thread boundary
(structured-clone), which can cost MORE than the inline batched insert; and the one real cost, `World.serialize()` per
keyframe, must run on the sim thread anyway (it needs the live world). If profiling ever shows writes stalling the sim,
splitting off a writer (queue + worker) is a trivial later add. The third thread that WOULD earn its keep is a **playback
re-sim worker** (to keep the UI live during an exact-tick refine) — deferred unless the refine visibly stutters.

## Data — per-seed run cached as one `.db` (efficient files)
Each seed = a run = one `runs/run-<seed>.db`. Select a seed → if its `.db` exists, just play it; else spawn the
generator to build it. So generation is a **cache** — new seeds only. Schema (extends the recorder we built):
- `snapshots(tick, json)` — **keyframes**, every **KEYFRAME_INTERVAL** ticks (default **2000** — efficient files: a
  ~few-hundred-bot snapshot ≈ 100 KB → ~50 MB per 1M ticks; drag-snap hides the interval).
- `stats(tick, json)` — the analysis panel **saved at each keyframe** (population + species table: sig/count/diversity/
  lifespan + pop aggregates), so a keyframe-snap shows the full panel *instantly* with no recompute and no lifespan
  history replay. (Karl's "save the stats.")
- `births / deaths / eats` — per event (from `createSqliteSink`); `ticks` — **throttled** (pop/food every ~100 ticks,
  not every tick) so the file stays small while keeping a smooth population curve.
- `run_meta(k,v)` — seed, config, KEYFRAME_INTERVAL, engineVersion, frontier(maxTick), done-flag.

## Playback + scrub UX
- **Drag = snap to nearest keyframe** — restore + render only (milliseconds, no re-sim), *regardless of interval*. So
  scrubbing feels instant at keyframe granularity even with sparse (2k) keyframes.
- **Release = optional exact-tick refine** — re-sim the sub-keyframe remainder (≤ interval ÷ ~900-2,600 = ~1-2 s at 2k).
  Opt-in / can be skipped; keyframe granularity is likely plenty for study.
- **Play** = keep a "playback world" and `tick()` it forward at the chosen **Speed**, rendering each frame; smooth up to
  ~the sim rate (≈40× real-time at high pop). Faster than that → scrub. Playing past the frontier waits for the generator.
- **Frontier** = the generator's current maxTick (grows); it's the slider's max. Generator posts progress to main → renderer.

## Time display (Karl: seconds/minutes, not ticks)
Define **TICKS_PER_SECOND = 60** (1× speed = real-time = 60 ticks/s, the natural mapping). The slider and readouts show
**mm:ss** (e.g. `03:12 / 11:07`), never raw ticks. (40k-tick lifespan ≈ 11 min at 60/s.) Constant, easily changed.

## UI layout (Karl: consolidate controls + scrub at the BOTTOM; only seed + speed)
- **Top:** just the title (or nothing). Main micrograph (left) + species panel (right) unchanged, given the freed height.
- **Bottom bar (new):** `[Seed ▸] [Speed ▸] [▶/⏸] [═══════ scrub slider ═══════] [mm:ss / mm:ss]`. Minimal — Seed and
  Speed are the only inputs (per Karl). Reset is implicit (change seed = new run). The old top header controls move here.
- **Save/Load** of a run = its `.db` file (it already exists on disk under `runs/`); expose via the app menu, not the bar.
  Recording is now automatic (generation *is* the recording), so the Record button goes away.

## What changes in the viewer
- The live tick-loop becomes a **playback loop**: instead of `world.tick()` each frame, it advances/anchors the playback
  head and renders the reconstructed world. The render, species panel, plates, diversity bar, lifespan circles, detritus
  are unchanged — they read the reconstructed world + the `stats` row (or recompute from the restored world).
- Overlays: species/diversity/plate recompute instantly from the restored world; **lifespan** comes from the saved
  `stats` row at the keyframe (or is replayed from `deaths` for an exact tick).
- Backward compatible: the plain-browser viewer (no `window.pool`) keeps its old live loop; scrub/playback is desktop-only.

## Open decisions / risks
- **KEYFRAME_INTERVAL = 2000** (efficiency) — confirm; drag-snap makes it feel instant, exact-refine ~1-2 s.
- **Exact-tick refine**: default on or off? (Off = pure keyframe granularity, zero re-sim, snappiest.)
- **`utilityProcess` ↔ main ↔ renderer** wiring + WAL concurrent read is the main new machinery to get right (readers
  must reopen/checkpoint to see the writer's latest WAL frames — verify the generator `flush`es and main sees frontier).
- Generator lifecycle: kill/restart on seed change; resume a partial `.db` (has done-flag + frontier).
- Playback speed caps at the sim rate (~40× at high pop); beyond that, scrub. Acceptable.
- Determinism must hold across the app's Node (generator) and Chromium (renderer) engines — same JS engine, default
  perception; a differential check (generator tick T vs renderer restore+resim to T) should be a test.

## Testing
- Determinism: generator's state at tick T (via its own restore+resim, or a stored keyframe) == renderer restore(nearest)
  +resim to T, bit-identical (hash swimbots). This is the load-bearing gate.
- WAL concurrency: main reads keyframes while the generator writes; no lock errors; frontier advances.
- Headless: drive the scrub (set head to T) and assert the reconstructed population/hash matches a direct run to T.
- The existing browser visual suite stays green (plain-browser path untouched).

## Hardening review — folded in (2026-09-05, before the 5-panel)
A single review hardened this plan; the changes below are now the plan (verdict: core approach sound —
serialize/restore is state-complete incl. RNG; WAL cross-process reader works):

- **B1 (determinism seam) → CHANGE THE GENERATOR HOST.** Generation in a Node `utilityProcess` runs a *different V8
  version* than the Chromium renderer that re-sims; the sim uses `Math.sin/cos/hypot` (swimbot.js:308-309/338/350-351),
  which are fdlibm and NOT bit-guaranteed across V8 versions → an exact-tick re-sim could diverge from the generator.
  (RNG is safe — pure integer lanes, rng.js:30-59; `sqrt` is correctly-rounded.) **Decision: run the generator in a
  HIDDEN/offscreen Chromium `BrowserWindow` (or a renderer Worker), NOT a utilityProcess — same V8 as playback →
  determinism is free**, and writes still funnel through main's existing IPC → `sqlite-sink`. Drag-snap is immune either
  way (it renders a stored keyframe, no re-sim); this only matters for exact-tick/"play". Still add the cross-engine
  determinism gate (generator keyframe-hash == renderer restore+resim hash) as a build go/no-go.
- **B2 (lifespan/overlay reconstruction) → REWRITE.** The `deaths` event/table is `{tick,id}` only — **no age/genes**
  (world.js:187, sqlite-sink.mjs:27) — and today's lifespan is computed by *polling* live refs at the alive→dead
  transition (viewer:1234-1242), which is **lossy at >1 tick/frame** (i.e. during scrub/fast playback) and feeds
  order-dependent EMAs needing the `tracked` map since tick 0. Decision: **reconstruct by re-simming keyframe→T with
  `onEvent` attached** (event-driven death detection; add `age` to the death event OR read the bot's age before
  `_sweepDead`), seeding `popLifeEMA` from the keyframe's `stats` row; per-lineage `lifeEMA` rebuilds from the keyframe
  (accept drift) or serialize `tracked`. Special-case founders (they emit `'founder'` with a RANDOM start age, world.js:224,
  not `'birth'`). Species/diversity/plate still recompute from the restored world (but keyframe-snap gives the RAW
  centroid, not the `SIG_EMA`-smoothed plate — N1, acceptable, note it).
- **S1 flush cadence:** the sink batches (batchSize 5000) so events/ticks lag the reader — generator must `flush()` +
  commit `run_meta` frontier(maxTick) **each keyframe**; keep keyframes autocommitted (that's what makes live drag-scrub
  work while generating).
- **S2 config source:** playback must `restore(config,…)` with the **run's config from `run_meta`**, NOT the viewer's
  hardcoded `build()` defaults (viewer:561-567) — mismatch diverges silently.
- **S3 WAL hygiene:** main opens the .db **after** the generator creates it + sets WAL; main **never writes** (set
  `busy_timeout`, effectively read-only); use materializing reads (`.all()/.get()`), not a lingering iterator (or it
  starves the writer's auto-checkpoint). Local FS (`runs/`) — fine. Readers never hit SQLITE_BUSY in WAL.
- **S4 resume-partial:** on generator restart from the last autocommitted keyframe, first `DELETE` any events/ticks with
  `tick > lastKeyframeTick` (batched rows past it may be torn/duplicated), then re-sim forward.
- **S5 seed-change/edges:** kill+respawn generator AND reset playback world + overlay EMAs (reuse build()/loadWorld reset,
  viewer:581-583/612-614) or `tracked`/`popLifeEMA` bleed across runs; exact-refine = release-only, debounced.
- **N4 IPC surface to build:** `getKeyframe≤T`, `getStats@T`, `getFrontier`, `getPopSeries` (renderer is sandboxed →
  main reads the .db and ships JSON, ~100KB/scrub, ms latency). **N5:** `ticks` throttle = generator-side `tick%100==0`
  filter. **N2:** do NOT touch serialize/restore — it's state-complete (verified).

NEXT: 5-panel review of this hardened plan, then build.

## Provenance
Decisions from Karl (2026-09-05): build scrub + playback now; single-thread (multicore rejected after measurement);
generation + SQLite on a separate thread; save the stats; time in mm:ss not ticks; controls + scrub consolidated at the
bottom; only Seed + Speed inputs. Supersedes the manual Record button in [[genepool-desktop-app]].
