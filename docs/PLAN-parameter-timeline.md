# PLAN — Interactive Parameter Timeline ("change parameters") — v2

> **Status:** hardened through THREE review rounds (1-agent first pass → 5 distinct-lens → final-gate → a second 5 distinct-lens on the hardened text). All blockers folded. Determinism verdict: **airtight for the MVP**. The last round's one real MVP blocker was the **T=0 edit** (triple-flagged) — now fixed in I2 — plus build-readiness concreteness (named `commitParamEdit`, IPC channel, validation-in-main, the schedule-builder helper, config-check replacement, the same-seed frontier epoch race) all folded into the Commit Routine spec + App layer. **Build-ready for the MVP slice** pending Karl's green-light on the slicing + the `fixBranchCategoryGene` defer/slice-3 call. MVP has a required manual app-verification gate (see Scope assumptions).

## Goal / UX

Turn a run into an **editable parameter timeline**. In the desktop editor: a **"change parameters"** button opens a dialog pre-filled with the option values effective at the current playhead; the user edits and commits; that writes an **option-keyframe** (a §10 schedule step) into the run's stored config, **discards generated frames from that point on**, and resumes generation under the new values. Later: markers on the timeline + a window that auto-opens when you land on a keyframe.

This is an extension of the already-built §10 schedule machinery (`scheduleValue`/`_sched`, commit `da418b6`), not a new mechanism: an option-keyframe *is* a `[tick,value]` step; "discard after" *is* the crash-safe truncate-and-resume we already use.

## Scope & slicing (per the scope + app reviews — build in this order)

- **MVP (slice 1): `mutationRateGeneScale` + `foodReseedWhenEmpty` only.** Neither touches founders → **no per-swimbot stamp, no rebuild-from-founders, no species-analyzer change**. This delivers the whole "change a parameter mid-run and watch it diverge" loop, is byte-identical for constant configs, and is the safe first cut. UI = the button + an in-page dialog for these two + commit; **one static marker at the edit tick** (no auto-open).
- **Slice 2: `evolvableMutationRate`.** Adds founder-seeding resolution, the species-analyzer limitation (below), and the rebuild-from-founders path for tick-0 edits.
- **Slice 3 (or defer): `fixBranchCategoryGene`.** The per-swimbot birth-stamp is the heaviest, most restore-fragile piece and the *least* observable edit (only new bodies change). Strong recommendation: either defer, or expose it **tick-0-only** via rebuild-from-founders and skip the mid-run stamp entirely.
- **Deferred (explicitly out of the first passes):** timeline markers beyond a single dot, **auto-open-on-landing**, and everything structural/JJ-scalar. Auto-open has a hard prerequisite (landability, see App Layer) and is pure polish.

## Commit Invariants (EVERY slice must obey — the convergent findings)

These are the rules the reviews forced; the commit routine is only correct if all hold.

- **I1 — Seed the baseline step (determinism + correctness, HIGH).** `scheduleValue` uses "first-step value holds for all earlier ticks" (config.js:59). So converting a **scalar** field to a schedule with a lone `[T,v]` makes `v` apply to ALL ticks, including `[0,T)` — silently rewriting history backward. **On any scalar→schedule conversion (or when T precedes the existing first step), prepend `[0, effectiveOldValue]`** so the new value only takes effect from T on.
- **I2 — Truncate anchor is strictly `< T`, with a defined T=0 case (persistence + correctness + readiness, HIGH — triple-flagged).** Resume re-sims from `anchor+1` (run-gen.mjs:70). If a kept snapshot sits exactly at T, tick T is never recomputed and the change slips to T+1. **Anchor at nearest snapshot with tick `< T`; delete `tick >= T`** so tick T regenerates under the new value.
  - **T=0 EDGE (was a run-destroying gap):** at T=0 there is **no** snapshot `< 0`, and `delete tick >= 0` wipes keyframe-0 (the run definition) → the resume child finds nothing to restore → it falls into the *fresh* `buildWorld` branch (run-gen.mjs:58) and silently re-seeds from `POOL_SETTINGS`, discarding the edit. And tick 0 IS reachable (head starts at 0, snapTo lands on it, button not disabled). **Rule for MVP (non-founder) fields:** at T=0 keep keyframe-0, anchor=0, **delete `tick > 0`**, resim from tick 1 — valid because MVP fields never affect seeding (`mutationRateGeneScale` first matters at reproduction, `foodReseedWhenEmpty` only at food=0). Generalized anchor rule: `anchor = nearest snapshot with tick < T, ELSE keyframe-0 when T==0; delete tick > anchor`. The commit **must guard a null anchor** (never proceed with anchor undefined). Add a T=0 test. (Founder-affecting fields at T=0 → rebuild-from-founders, slices 2/3.)
- **I3 — Config-write + truncate are ONE transaction (persistence, HIGH).** A crash between "write new schedule" and "truncate" leaves a silent hybrid run (new config, stale post-T frames) that resume **cannot heal** (it only rewinds to the last keyframe, which is past T). The config-schedule write + multi-table `DELETE tick >= T` + `frontier` rewind + `done='0'` must commit as **one SQLite transaction on one connection**.
- **I4 — Validate BEFORE mutating (correctness).** `resolveWorldConfig`/`validateScheduleForm` currently only run at resume (via `World.restore`), i.e. *after* the child is killed and frames deleted — a bad edit leaves the run truncated + dead. **Build the candidate config, run `resolveWorldConfig` on it, and confirm the ordered insert, before killing the child or touching the DB.**
- **I5 — `runConfig` is the load-bearing key (persistence).** Resume reconstructs from `writer.runConfig().config` (run-db.mjs:175); the plain `config` key is not read on resume. Editing only `config` is an **inert no-op** (marker drawn, simulation unchanged). Write **both `runConfig` and `config`**, before resume.
- **I6 — Lifecycle: await exit, close, then fork (persistence + app).** `stopGenerator` (main.mjs:68-73) kills without awaiting; the child holds the WAL writer. Use a **dedicated commit routine** (not the shared `stopGenerator`, which also serves quit/seed-switch — awaiting there risks hanging quit) that: signals → **awaits the child `exit`** → opens the truncate/commit connection → commits (I3) → **closes it** → forks the resume child. Add `PRAGMA busy_timeout` to the writer connection (sqlite-sink.mjs:22) as defense-in-depth.
- **I7 — Ordered insert/replace.** Build the field's schedule by inserting/replacing at T keeping ticks ascending (validateScheduleForm allows equal ticks — config.js:75 uses `<` not `<=`, so a dup-tick would silently last-win; avoid by replace-on-equal). Later steps `> T` that survive the truncation are kept (they correctly re-fire on resim) — do NOT drop them.
- **I8 — Resolve ABSENT keys via defaults (MVP blocker, final-gate finding).**
  - *(see the Commit Routine spec below for the exact functions/signatures these invariants map to)*

### Commit routine — buildable spec (readiness review; names the load-bearing artifacts)

An implementer must NOT reuse `openRunWriter(resume:true)` for the commit — its resume path truncates at the *last* keyframe (`tick > lastKf`), not at `>= T`, and runs before any config write. Name the artifacts:

- **`run-db.mjs` — new export `commitParamEdit(path, { newRunConfig, tick })`** (single raw `DatabaseSync(path)` connection, `PRAGMA busy_timeout`, ONE transaction — I3):
  `anchor = SELECT tick FROM snapshots WHERE tick < :T ORDER BY tick DESC LIMIT 1` (ELSE 0 when T==0 — I2); guard null; `BEGIN`; `DELETE FROM {snapshots,stats,births,deaths,eats,ticks} WHERE tick > :anchor`; `setMeta('runConfig', newRunConfig)` **and** `setMeta('config', newRunConfig.config)` (I5); `setMeta('frontier', anchor)`; `setMeta('done','0')`; `COMMIT`; close. Returns `{anchor}`.
- **Schedule builder** (a small pure helper, e.g. in `config.js` next to `scheduleValue`): `withKeyframe(spec, tick, newVal, defaultVal)` → resolve `effectiveOld = scheduleValue(spec ?? defaultVal, 0)`; if `spec` is scalar/absent, start `[[0, effectiveOld]]` (I1); ordered-insert `[tick,newVal]` with **replace-on-equal** (I7); keep later steps `> tick`. At T=0 this collapses to `[[0,newVal]]` (prepend then replace-on-equal — do not double-seed).
- **Validation owner = MAIN (I4):** main builds the candidate `runConfig`, runs `resolveWorldConfig(candidate.config)` (throws on bad step), and on error returns `{ok:false,error}` to the renderer **without** killing the child or touching the DB. Only on success does it run the I6 lifecycle (await child `exit` → `commitParamEdit` → fork resume).
- **IPC:** add `commit({seed, field, value, tick})` to `desktop/preload.cjs` (`window.pool.scrub.commit`) + `ipcMain.handle('scrub:commit', …)` in `main.mjs`. It resolves like `selectSeed`: `{ok, frontier, runConfig, lastHead, error?}` (there is **no pushed `ready` event** — the renderer awaits this invoke, then runs the selectSeed refresh body).
- **config.js validation:** **REPLACE** (not add) the scalar checks at config.js:168-173 for the two MVP fields with `eachVal`-based validators (add a boolean `eachVal` validator — none exists yet); add both fields to `SCHEDULABLE_FIELDS`.
- **Lifecycle robustness (I6):** the await-child-`exit` uses a **force-kill (SIGKILL) + timeout fallback** so a future SIGTERM handler on the child can't deadlock the commit. The two MVP fields are NOT stored in `runConfig.config` — `poolConfig` (pool-seed.mjs:20-29) omits them; they only acquire their defaults (`false`/`64`) at `World` construction via `resolveWorldConfig` (config.js:126,130). Desktop's stored config carries only `POOL_SETTINGS = {fixBranchCategoryGene, evolvableMutationRate}` (main.mjs:66). So `scheduleValue(cfg[field], head)` on an MVP field returns **`undefined`**, not `false`/`64`. Both the **dialog pre-fill** and the **I1 baseline `effectiveOldValue`** MUST resolve an absent key through the `resolveWorldConfig` defaults first (else pre-fill is blank and I1 seeds `[0, undefined]` → I4 rejects every first-time edit; for `mutationRateGeneScale`, an undefined that slipped past would give `Math.pow(2, x/undefined)` = NaN → genome-wide corruption, which I4 is what's masking). Test: editing a field **absent** from the stored config (distinct from the scalar case).

## Engine — make options time-varying (default byte-identical)

**Config validation (blocker #1, first pass).** `resolveWorldConfig` throws on a schedule object for all four fields (config.js:162-172). Add the (slice's) fields to `SCHEDULABLE_FIELDS`, and rewrite their value-checks to validate **each step's value** via the `eachVal` walker (config.js:143-147): boolean for the flags, positive-finite-number for `mutationRateGeneScale`.

Read live per event (not cached) via `scheduleValue`/`_sched`:
- **`mutationRateGeneScale`** — `this._sched(...)` at reproduction (world.js ~528).
- **`foodReseedWhenEmpty`** — replace cached `this._foodReseedWhenEmpty` (world.js:133) with a live read at the reseed branch (world.js ~635).
- **`evolvableMutationRate`** *(slice 2)* — replace cached `this._evolvableMutationRate` (world.js:126) at: reproduction (~525); mating gate `_getJunkDnaSimilarity` (world.js:281) — **hoist the read OUT of the 112→256 loop** (perf, hot path); founder seeding **pool-seed.mjs:41** (`scheduleValue(spec, 0) === true`); and the display analyzer **species.mjs:75** (see limitation below). Diagnostic-only reader to update for accuracy: `tools/scrub/peek-mutrate.mjs:46,52` (`=== true`) — determinism-neutral.

**Byte-identical guarantee:** `scheduleValue(scalar,tick) === scalar`, so constant configs (the default, every golden/gate) read exactly as the cached fields did. Confirmed sound by the determinism lens; goldens hash `dumpSwimbots()`, separate from `serializeCheckpoint()` (O1 ✓).

**Context:** `desktop/main.mjs:66` ships `POOL_SETTINGS = {fixBranchCategoryGene:true, evolvableMutationRate:true}` as constants; this feature supersedes the "wipe runs/ on POOL_SETTINGS change" hack. Dialog defaults for a normal desktop run: `64 / false` (MVP fields).

## `fixBranchCategoryGene` (slice 3) — the birth-stamp, done right

Bodies decode once at `create()` and freeze; restore re-decodes. Making the flag time-varying requires the decode to use the value **as of each swimbot's birth**. Corrected call-graph (final-gate finding — the earlier "≥5 sites" was inaccurate):
- There is **exactly one decode read**: `generatePhenotypeFromGenotype(this._genotype, this._config)` at **swimbot.js:173**. The "world.js:559/220/813" are `create()` **callers** that all funnel through it — not separate decode sites. `create()` (swimbot.js:161) takes **no config override** today, so threading a per-bot fix value **is a real `create()`/decode signature change**, not a tweak.
- **Decode fallback:** `generatePhenotypeFromGenotype` keeps a `config.fixBranchCategoryGene` fallback so untouched callers stay correct — notably `engine/parallel/partition.mjs:149-150` (correct path; note it does NOT implement evolvableMutationRate either — pre-existing, out of scope) and `engine/pool.js:32`, which today decodes with `{numFoodTypes}` only and **omits `fixBranchCategoryGene` entirely** (test-only path, already ignores the flag).
- **Live birth must also resolve the schedule:** the birth decode (swimbot.js:173 via world.js:559) must read `scheduleValue(fix, this._clock)` so a restored body matches how it was actually born. State this explicitly.
- **Restore uses birth value, never live config:** `makeBot` resolves `sd.fixStamp ?? scheduleValue(config.fixBranchCategoryGene, birthTick)` and passes it INTO the decode **before** `restoreCheckpointState` overlays geometry (fixing the current create-then-restore order, world.js:813-819). `age` is in `serializeCheckpoint` (swimbot.js:1036); **nail the off-by-one** — `_age` starts 0 at create and increments at swimbot.js:386, and newborns are staged to T+1 (world.js:560-561), so `birthTick = snapshotClock − sd.age` needs verification against a scrub-identity test. (Founders survive regardless: derived birthTick goes negative → `scheduleValue` clamps to the tick-0 step, which I1 pins.)
- **Do NOT use the "stamp only when scheduled" optimization for the restore read** — a scalar-era snapshot has no `fixStamp`, and after the edit converts the field to a schedule, a naive `undefined === true` → fix=false → wrong `numParts` → `restoreCheckpointState` reads `d.parts[p]` off the end → crash/corruption. The `?? scheduleValue(...)` fallback (or: always write the stamp — golden-safe per O1) closes this. Prefer the **age-derived fallback** so old snapshots migrate correctly with no format change.

## `evolvableMutationRate` species analyzer (slice 2) — state the limitation

`createSpeciesAnalyzer` fixes `nj` (NJ or NJ−1) **once at construction** and sizes all incremental sums by it (species.mjs:75,83,88,96); membership is fixed at birth. So a **scheduled on↔off** `evolvableMutationRate` cannot be faithfully tracked by the incremental analyzer (you can't re-key past members' sums mid-run). This is **display/stats only** (never re-enters `world.tick()` → determinism-neutral), but the species panel will mis-cluster while the field is scheduled. Two concrete fixes even short of full tracking: (1) select `nj` via `scheduleValue(config.evolvableMutationRate, 0) === true` — the raw `=== true` (species.mjs:75) is **false for ANY schedule object**, so even an always-on-via-schedule config (e.g. the natural I1 result `[[0,false],[T,true]]`, or `[[0,true]]`) would wrongly cluster on the full span; (2) build the analyzer from the run's **stored** config, not the local one (run-gen.mjs:49). Slice-2 decision: accept the on↔off display imprecision (document it), or rebuild the analyzer at each keyframe boundary (heavier — likely not worth it).

## Rebuild-from-founders (slices 2/3, tick-0 founder-affecting edits)

A run is defined by keyframe-0 = post-seeding `serialize()`; restore never re-seeds. So a **tick-0** edit of a founder-affecting option (`evolvableMutationRate` byte-255 zeroing; `fixBranchCategoryGene` founder bodies) needs a rebuild, not truncate-resume:
- Go through the **fresh** path (`resume:false` / delete the file) so `openRunWriter` rewrites `config`+`runConfig` (run-db.mjs:106,108) — resume would NOT.
- Pass the edited founder options in the fork `opts.settings` — `buildWorld` seeds from `o.settings` (run-gen.mjs:59), NOT stored meta.
- **Atomic + WAL sidecars (persistence review):** write to a temp DB, **checkpoint + close** it so its own `-wal`/`-shm` are gone, then `rename()` into place — and **delete the destination's stale `run-<seed>.db-wal`/`-shm`** first (safe once all old connections are closed). A bare `rename()` of just the main file leaves the old, un-checkpointed `-wal` (the killed writer never checkpointed; the read-only reader can't) beside a different DB → SQLite may reset or corrupt on next open. So: checkpoint temp → delete dest sidecars → rename main into place.

## App layer

**MVP dialog:** an **in-page DOM dialog** inside the existing `BrowserWindow` (like the scrub bar) — not a second Electron window (avoids window-management + flicker). Pre-fill from `scheduleValue(cfg[field], head)` **with the absent-key default fallback (I8)** — MVP fields aren't in the stored config, so fall back to `resolveWorldConfig` defaults (`foodReseedWhenEmpty=false`, `mutationRateGeneScale=64`).

**Observability expectation (final-gate finding, not a defect):** `mutationRateGeneScale` is read only inside `if (evolvableMutationRate)` (world.js:530) — true on desktop, so it's live — and `foodReseedWhenEmpty` only fires at `_livingFoodCount==0` (near extinction). So the visible "watch it diverge" demo effectively rides on `mutationRateGeneScale`; `foodReseedWhenEmpty`'s effect only shows in a pool that would otherwise die. Set expectations accordingly when demoing the MVP.

**Imports (readiness):** the viewer imports only world/genotype/species/pool-seed (viewer:234-237). Add `import { scheduleValue, resolveWorldConfig } from './engine/config.js'` for the dialog pre-fill (I8 default fallback).

**Commit = awaited invoke (app lens).** Model the commit as `await window.pool.scrub.commit(...)` resolving `{ok, frontier, runConfig, lastHead, error?}` — NOT a listened-for event (none is pushed). On `!ok`, leave the regenerating state and surface `#err`. On ok, run the selectSeed refresh body (viewer:2456-2467).

**Commit refresh (blockers, app lens):**
- **Assign, don't max, the frontier.** The renderer merges frontier with `Math.max` (viewer:2472) — it will never see a commit's rewind. After commit, **assign** `frontier` from the value main returns (as `selectSeed` does, viewer:2459) and re-clamp `head`.
- **Same-seed frontier EPOCH token (readiness — real race).** `onFrontier` only drops updates for a *different* seed (viewer:2472); a commit keeps the same seed, so the **killed old child's late in-flight `progress`/frontier messages can `Math.max` the rewound frontier back up** after the assign. Add a generation/epoch token (bump on commit; drop frontier messages tagged with an older epoch, or latch frontier until the new `ready`).
- **Rebind `cfg`.** The renderer captures `cfg` once (viewer:2459) and ticks/restores against it (viewer:2448,2504). After commit, **re-fetch `runConfig` and rebind `cfg`** before re-snapping (`resetOverlays(head,cfg)` rebuilds `speciesModel`, so that self-heals once cfg is rebound), or edited frames replay under stale values and the next dialog pre-fills stale.
- **Refresh `graphData`.** The graph caches its downsampled series (viewer:2284) and only refetches on a 1.5s timer while open → phantom post-T history after a rewind. Call `refreshGraph()` (or clear `graphData`) on commit. Also mirror `selectSeed`'s `_lastReportedHead = head` reset (viewer:2462).
- **Restart affordance / lockout.** During stop→truncate→resume, `scrub=null` → reads return sentinels (safe; nothing polls them every frame). Define a "regenerating…" state that **disables the transport, the seed selector, AND the commit button (re-entrancy), and gates the `playbackLoop` tick** (viewer:2506) so it doesn't keep ticking the soon-discarded world; re-snaps when the commit invoke resolves.
- **T = current head** (not "snapped tick"): during playback `head` is an arbitrary tick (viewer:2509), which is fine for I2. Reconcile the plan's earlier "snapped tick" wording — the edit tick is the current head.

**Deferred — markers/auto-open landability (app lens, hard prerequisite):** `snapTo` restores the nearest snapshot with **no resim** (viewer:2441-2450), so the playhead only lands on snapshot-grid ticks; arbitrary option-keyframe ticks are **not landable**, so `head === markerTick` (auto-open, edit-existing) is essentially unreachable. Resolving this needs one of: force a snapshot keyframe at each option-keyframe T; make `snapTo` resim to exact T; or match against the slider *target* within a tolerance. **Deferred with this prerequisite recorded.** For MVP, "change parameters" commits at the snapped tick and drops one static marker; editing-existing and auto-open come later.

## Determinism & testing

- Full suite + JJ motion goldens + seed-42 baseline **byte-identical** (constant configs unaffected).
- Config: schedules on the slice's fields validate (per-step) instead of throwing; malformed step rejected.
- Per-option schedule determinism (same seed+schedule → identical); scheduled run differs from constant only after T.
- **Scrub-identity:** straight-through run == truncate-resume at the keyframe, byte-for-byte — including (slice 3) the `fixBranchCategoryGene` body case AND the **scalar→schedule migration** (restore of a pre-edit, un-stamped snapshot under the new schedule reproduces the live run). Precedent: parameter-schedules.test.js:68-77.
- **I1 test:** first keyframe on a scalar field leaves `[0,T)` frames unchanged (baseline step seeded).
- **I2 test:** editing exactly on a keyframe tick recomputes tick T.
- **I3/I4 test:** interrupted commit leaves the run either fully old or fully applied-and-resumable; malformed edit leaves the run intact (validate-first).
- Rebuild-from-founders (slice 2/3): tick-0 founder edit yields expected founder byte-255/body and differs from the (incapable) truncate-resume path.

## Build order

1. **MVP engine:** `mutationRateGeneScale` + `foodReseedWhenEmpty` live-read + config validation; goldens byte-identical + per-option schedule tests.
2. **MVP persistence:** commit routine honoring **I1–I7** (validate-first, baseline step, atomic config+truncate txn @ anchor `<T`, runConfig+config, await-exit lifecycle, busy_timeout); run-db Node test + scrub-identity + interrupted-commit test.
3. **MVP app:** button + in-page dialog (two options) + commit IPC + assign-frontier + rebind-cfg + regenerating affordance + one static marker. **Ship.**
4. **Slice 2:** `evolvableMutationRate` (founder resolve-at-0, analyzer from stored config + documented scheduled-toggle limitation, rebuild-from-founders for tick-0).
5. **Slice 3 / defer:** `fixBranchCategoryGene` — reconsider tick-0-only vs the mid-run age-fallback stamp.
6. **Deferred:** landability mechanism → markers + auto-open-on-landing.
- **Gate:** determinism/persistence tests green before app work.

## Confirmed sound by review (no action)

- O1: `dumpSwimbots()` (golden) vs `serializeCheckpoint()` (restore) are separate; stamp/scalar path leaves goldens untouched.
- Keyframe thinning keeps tick 0 + newest, so an anchor `< T` always exists (run-db.mjs:130).
- Truncate-resume for T>0 non-founder options is correct (schedule feeds old value `[anchor,T)`, new from T).
- Cross-arch: `scheduleValue` is arithmetic-free — no new float determinism surface.
- `foodReseedWhenEmpty` toggled off after reseeding is coherent; `numFoodTypes==2` not worsened (pre-existing reseed-picks-type-1-when-both-empty quirk noted, not a blocker).
- **Determinism airtight for the MVP** (final determinism pass, no defects): I1/I2/I8 compose correctly with the `anchor+1` resim; the two MVP read sites are exhaustive; goldens hash `getPoolData()` with no config in the payload; cross-arch clean (`scheduleValue` is comparison-only).

**Scope assumptions (state explicitly):**
- **MVP reproducibility rests on the SERIAL engine** (desktop path: main → generator.mjs → run-gen `World`). The parallel engine (`engine/parallel/partition.mjs`) does not read `mutationRateGeneScale`/`foodReseedWhenEmpty` (same pre-existing gap as `evolvableMutationRate`). Fine because parameter-timeline runs are always serial run-gen runs; it would only bite if someone edited a parallel-generated run.
- **Untestable-headlessly paths need a MANUAL app gate:** the I6 Electron lifecycle (await-exit → commit → fork), the app refresh (assign-frontier, rebind-cfg, epoch token, regenerating lockout). No headless coverage — call out a visual verification step at the MVP gate (the grow-SAB glue burned us the same way before).

## Open items for Karl (UX calls — only when we reach the UI)

- **O3.** On commit, auto-pause playback (you're editing) or keep playing from T?
- **O4.** Marker visual + whether tick 0 gets a marker. *(hosting surface: an overlay aligned to the slider track, since `<input type=range>` can't host ticks and the graph canvas is only visible when the graph is open.)*
- *(O2 auto-open — deferred with the landability prerequisite above.)*
