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
- `snapshots(tick, json)` — **keyframes**, every **KEYFRAME_INTERVAL** ticks. ⚠️ **Size corrected by 5-panel D3:**
  `serialize()` ≈ 4.2 KB/living bot → ~1400 bots ≈ 5.9 MB/keyframe (raw). Compress (base64 genes + gzip column) and
  MEASURE/tune the interval in Phase 1. Drag-snap hides the interval; keyframe is a full-world restore anchor.
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

- **B1 (determinism seam) → ⚠️ SUPERSEDED by the 5-panel (see D1 below): REVERTED. Keep the `utilityProcess`.**
  Two reviewers (Electron + determinism) independently established the premise below is FALSE — in Electron,
  `utilityProcess` and the renderer share ONE V8, so `Math.*` is already bit-identical between them. The hidden window
  bought zero determinism and broke S3 (a sandboxed renderer can't write SQLite). Original (now-rejected) B1 text kept
  for provenance:
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

## 5-panel review — folded in (2026-09-05, THIS is the build spec; supersedes conflicting text above)
Five distinct-lens reviewers (Electron/IPC · cross-V8 determinism · SQLite/WAL/schema · DOM/UI+scrub UX · testing/goldens)
hunted new issues AND adversarially challenged the folded-in fixes. Three findings were BLOCKERs against folded-in
assumptions. Decisions D1–D11 below GOVERN.

**D1 — REVERT B1. Generator = `utilityProcess` (real Node, in-process `node:sqlite` write), NOT a hidden Chromium window.**
*Two independent reviewers:* Electron ships ONE V8; a `utilityProcess` runs Electron's bundled Node on that SAME V8 as
the renderer/`BrowserWindow`. `Math.sin/cos/hypot` are therefore bit-identical gen↔playback within one Electron build
(fdlibm is tier-invariant; MXCSR/FTZ defaults match; sqrt is HW-correctly-rounded). The hidden window bought zero
determinism and cost real things: Chromium background/occlusion throttling (a never-shown window's rAF never fires →
sim crawls), a sandbox that can't reach `node:sqlite` (→ forced per-event IPC firehose to main, the very structured-clone
cost the "2 threads not 3" decision rejected), and it directly contradicted S3 (main can't be read-only if it's the
writer). Reverting restores the §Threads model as written: generator owns the writer in-process (no per-event IPC), main
opens the same `.db` read-only (S3, proven correct). This SIMPLIFIES the build.

**D2 (BLOCKER) — Extract the analysis/EMA pipeline into a SHARED module; `stats` must fully reconstruct the panel.**
The species machinery (`tracked`, `popSig`, `computeSpecies`, `SIG_EMA`=0.08, `LIFE_EMA`=0.05 — viewer:945/956/959) is
viewer-only and NOT in `serialize()` (N2 confirmed). So the generator must run that same code to emit `stats` at all.
Extract it to a shared `.mjs` both generator and viewer import. Generator runs it at a **fixed tick cadence** (per
keyframe / per `STATS_INTERVAL`) — the live viewer's per-*frame* EMA cadence is frame-rate-dependent and NOT reproducible,
so the fixed cadence becomes the canonical contract. `stats` row schema = pop EMAs + per-lineage `{stableId, sig, count,
divEMA, lifeEMA}`. Add an **analysis-parity gate** (generator stats == reference stats at the fixed cadence), separate
from the engine-hash gate.

**D3 (BLOCKER) — Redo the size/cost model; compress; decouple STATS_INTERVAL from KEYFRAME_INTERVAL.**
Measured: `serialize()` ≈ **4.2 KB per living bot**, so ~1400 bots ≈ **5.9 MB/keyframe**; a 1M-tick run @ 2000 is
**0.6–3 GB, not 50 MB.** And N4's "~100 KB/scrub" is really **1–6 MB per `getKeyframe`** structured-cloned to the
renderer. Fixes: **base64 the genes** (256 B vs ~1 KB), **gzip the `json` column** (floats ~2–3×), and **decouple** a
dense-cheap `STATS_INTERVAL` (pop curve + panel, e.g. ~200–500 ticks — tiny rows) from a sparse `KEYFRAME_INTERVAL`
(full-world restore anchors). **MEASURE real compressed sizes + `getKeyframe` clone latency in Phase 1 and tune the two
intervals then** — do not hard-commit numbers now. (Disk is cheap for a personal tool, but IPC clone latency per snap is
the real UX cost → compression is load-bearing.)

**D4 — Crash-safe keyframe write + schema hardening (folds S1/S3/S4 tighter).**
Per keyframe, in **ONE transaction**: `flush()` events → insert snapshot → insert stats → **update `run_meta` frontier
LAST** → commit. Define **frontier = max fully-consistent tick**; the reader **clamps every query to ≤ frontier**
(`getKeyframe ≤ min(T,frontier)`). `snapshots(tick INTEGER PRIMARY KEY, json)` + `stats(tick INTEGER PRIMARY KEY, json)`,
written `INSERT OR REPLACE`. **S4's DELETE must cover `snapshots`+`stats`** too (not just events/ticks — and `ticks` has a
PK so re-sim throws UNIQUE without the delete). Move `snapshots`/`stats`/`run_meta` DDL **into the sink / a migration**
so generator and reader share one schema. **Fix the `run_meta` collision** — `main.mjs` uses `(k,v)`, the sink's
`writeRunMeta` uses `(key,value)` → "no such column" (proven); standardize on `(k,v)`, do NOT reuse `writeRunMeta`
unreconciled. keys: `seed, config, KEYFRAME_INTERVAL, STATS_INTERVAL, engineVersion, electronVersion, frontier, done,
perceptionMode`. Add a **"db ready" handshake** (readonly open on a not-yet-created file throws → generator posts
"created+WAL+first-commit" before main opens). Set `wal_autocheckpoint` explicitly + periodic PASSIVE checkpoint (multi-MB
snapshots blow the 4 MB default). Per-seed **write exclusivity**: write `run-<seed>.tmp.db` → rename on `done` (or lock);
a force-quit leaves a stale `-wal` → the resume path must open read-write first to recover.

**D5 — Cross-APP-VERSION replay guard (NEW; the determinism seam that actually matters).**
The only case where `Math.*` genuinely differs is across Electron releases (upgrade → new V8/fdlibm). Neither host fixes
it. Stamp `engineVersion` + Electron/V8 version in `run_meta` at generate time; on playback, if stored ≠ current:
keyframe-snap stays exact (renders stored `serialize()`), but **disable exact-refine / play-past-keyframe re-sim** (or
offer regenerate). Drag-snap is always immune.

**D6 — Determinism gate spec: full-`serialize()` hash + lockstep, THROUGH a JSON round-trip.**
Not a single swimbots-only hash (food energy / regen-stream / `nextId`s can diverge and corrupt the next tick). Hash the
full `serialize()` (swimbots+food-energy+RNG positions+ids+clock) AND lockstep-step restored-vs-continuous for ≥ a few
hundred ticks, asserting every tick. **Must round-trip `restore(JSON.parse(JSON.stringify(serialize())))`** — that's what
the `.db` stores, and it catches `NaN/±Infinity → null` silent corruption (D7). The existing
`test/engine/world-checkpoint.test.js` IS this gate in Node — extend it; it's the PRIMARY, V8-independent regression gate.
The in-Electron check reduces to a **one-time** "the two processes share V8" go/no-go (near-zero by construction).

**D7 — JSON codec finiteness (MINOR, latent).** JSON has no NaN/Inf. Add a cheap finiteness assert when the generator
serializes a keyframe; D6's JSON-round-trip gate is the automated catch.

**D8 — keyframe-0 = `serialize()` AFTER seeding, never a `build()` replay (MAJOR).** `build()` (viewer:558-585) reads
module-level params outside `config` (`P.n/food/pool`, `MAX_LIFESPAN`, `seedJunk()`…). S2 (config from `run_meta`) does
NOT capture those. Generator's first act: seed → `serialize()` = keyframe 0; playback restores it, never re-derives
founders. (This makes S2 necessary-but-not-sufficient; keyframe-0-as-snapshot closes the gap.)

**D9 — `death` event gains `age`; do it FIRST (Phase 1) for blast radius.** Deaths are `{tick,id,uuid}` — no age (world.js:187,
sqlite-sink.mjs:27), and today's lifespan polls live refs (viewer:1234-1242), lossy at >1 tick/frame. `age` is readable in
`die()`/before `_sweepDead`, deterministic, doesn't perturb the sim (all emits are `if(this._onEvent)` pure-reads). Blast
radius: `sqlite-sink.mjs` deaths table+insert, `world.js:187` emit, the JSONL source-of-truth, `genome-hash`/`ingest` —
do it ONCE before any `.db` is generated or every run gets re-cut.

**D10 — UI/UX (scrub-lens):** (a) `resetOverlays()` on EVERY `restore()`, not just seed-change — clock-delta fades
(`nowClock-deathTick`, viewer:1244) and junk drift (`clock-lastJunkClock`, :1215) corrupt on a jump; reset
known/fades/deathTick/deathFade0/lastJunkClock + tracked + pop EMAs. (b) **Drag-snap = read the `stats` row, ZERO re-sim**
(T lands on a keyframe); this also **kills N1** (save the SIG_EMA-*smoothed* sig → no plate jump) and the paused-crawl
(only recompute species while PLAYING; paused/snapped = render-only + panel from stats). (c) **Exact-refine re-sim =
opt-in / DEFAULT-OFF for v1** (blocks the render thread ~1–2 s; the deferred re-sim worker is the fix if wanted). (d)
Carry the generator's **stable lineage id** in the stats row so the species list doesn't rebuild every scrub step. (e)
Tag async `getKeyframe≤T` requests with a **seq**, apply only the latest (drop stale). (f) State machine:
FOLLOWING/PLAYING/PAUSED/DRAGGING/REFINING, explicit head-vs-frontier ownership. (g) Keep `world` as the SINGLE rendered
var; fork ONLY at the `window.pool` boundary in `boot()` (browser→`loop`; desktop→`startPlayback`) so the 6/6 visual
suite + `__golden`/`__bench` hooks stay intact. (h) Slider growing max: grow `.max` only when not dragging; FOLLOWING
pins `value=max`; past frontier → clamp + "waiting for generator." (i) Speed: remap `#speed` from ticks/frame to
×real-time (1×=60 t/s), cap at sim rate (beyond → scrub).

**D11 — BUILD ORDER (each phase verifiable in Node before touching Electron; adopt wholesale):**
- **Phase 0 — determinism gate FIRST, in Node (no app changes).** Extend `test/engine/world-checkpoint.test.js`: route
  through `JSON.parse(JSON.stringify(serialize()))`; run at KEYFRAME_INTERVAL with multiple keyframes; assert codec
  self-consistency `restore(kf[i])+resim==kf[i+1]` bit-for-bit. **GO/NO-GO 0:** green ⇒ "reconstruct any tick" is proven.
- **Phase 1 — schema + sink + `death.age` + shared analysis module + SIZE MEASUREMENT, gated in Node.** Add
  `snapshots/stats/run_meta`(frontier,done)/throttled `ticks`, `age` on death (D9, once), extract analysis (D2); extend
  `test/io/sqlite-events.test.js`; update JSONL/`genome-hash`. Measure compressed keyframe sizes + tune intervals (D3).
- **Phase 2 — generator = pure headless Node runner** (`tools/…/run-gen.mjs`, like `run-tw.mjs`): engine flat-out → full
  `.db`, one-txn keyframe write. **GO/NO-GO 2:** `node run-gen.mjs --seed S` produces `runs/run-S.db` here/in CI, no GUI.
- **Phase 3 — WAL concurrency + resume, gated in Node** (writer + read-only reader handles): frontier advances, zero
  BUSY, materializing reads; kill→resume→bit-identical `.db`. **GO/NO-GO 3:** riskiest new machinery green pre-Electron.
- **Phase 4 — pure `db-reader.mjs`** (`getKeyframe≤T, getStats@T, getFrontier, getPopSeries`, downsampled/bounded) +
  the **S2 non-default-config divergence test**. **GO/NO-GO 4.**
- **Phase 5 — in-browser determinism hook** (`window.__determinism`) + playwright gate vs the Node hash (headless_shell
  1217 V8 caveat noted). **GO/NO-GO 5.**
- **Phase 6 — wire generator into Electron as a `utilityProcess`** (per D1) + main WAL reader + IPC (frontier pushed,
  scrub reads coalesced) + a one-time in-Electron differential. **GO/NO-GO 6.**
- **Phase 7 — playback loop + bottom bar + overlays** (D10). Guard: visual **6/6 as a mandatory LOCAL pre-merge gate**
  (it's arm64-only, opt-in, NOT in CI) + Karl's eyes for scrub UX.
- *Wrong-order traps:* Electron WAL before the Node WAL gate ⇒ eyeball-only validation; `death.age` after generation ⇒
  re-cut every `.db`; S2 never shows in the visual suite; the gate is meaningless until it round-trips through JSON TEXT.

**Confirmed CORRECT-as-is (reviewers verified, do not re-litigate):** S3 core (cross-process WAL reader + materializing
reads — empirically proven); attaching `onEvent` doesn't perturb the sim; founder start-age is seeded (`mulberry32`, not
`Math.random` — engine has none) and reproducible on restore; grid rebuild-on-restore == incremental (existing lockstep
tests); N2 (don't touch serialize/restore); N5 throttled-ticks is determinism-safe.

## Provenance
Decisions from Karl (2026-09-05): build scrub + playback now; single-thread (multicore rejected after measurement);
generation + SQLite on a separate thread; save the stats; time in mm:ss not ticks; controls + scrub consolidated at the
bottom; only Seed + Speed inputs. Supersedes the manual Record button in [[genepool-desktop-app]].
