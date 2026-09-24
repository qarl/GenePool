# PLAN — a start/stop generator CLI that shares the app's background-jobs machinery

## Goal (Karl's ask)

> "a nice command line switch to start and stop background generation with hooks so that when the app
> launches, they don't step on each other and the app can start/stop them too from the jobs window."

Today Claude starts a generator by running the worker directly with **system node**:
`node tools/scrub/run-gen.mjs --seed 5 --out <db> --resume`. That bypasses the app's writer-authority
gate, `caffeinate`, and the `bg-jobs.json` registry. We want ONE start/stop path used by both the CLI
and the Jobs window, so the two never step on each other.

## What already works (do not rebuild)

- `run-db.mjs`: `isWriterLive(dbPath)` (‑wal freshness = a live writer, writer-agnostic + crash-safe),
  `collapseToSingleFile(dbPath)`, `openRunReader`. Electron-free — usable from a CLI.
- `main.mjs` background section: `bgSpawn` (detached spawn + co-spawned `caffeinate -w <pid>`),
  `bgStart` (gate on `isWriterLive`/scan → adopt instead of a 2nd writer), `bgStop` (kill recorded pid +
  scan pid, SIGKILL escalate, then collapse), `scanGenerators` (ps scan, matches ANY `run-gen.mjs …
  --out <path>` regardless of who spawned it), `reconcileJobs` (adopt untracked live gens; prune+collapse
  dead ones). **The app already adopts and can stop an externally-started generator.**

So the missing piece is only the **start side** of the CLI: honor the writer gate, co-spawn caffeinate,
write the same registry — plus a clean stop that matches the app's.

## Design

### 1. Extract a shared, Electron-free module: `tools/scrub/gen-jobs.mjs`

Move the pure logic out of `main.mjs` so both sides import the SAME code (single source of truth for the
registry format, the ps-scan regex, the spawn args, and the stop sequence):

- `jobsDir()` — resolve `~/Library/Application Support/GenePool` WITHOUT Electron (darwin default;
  overridable via `GENEPOOL_USERDATA` for tests). Verify this equals `app.getPath('userData')` on macOS.
- `loadJobs()/persistJobs()` — atomic tmp+rename write of `bg-jobs.json`.
- `scanGenerators()` — unchanged regex/logic.
- `bgSpawn(dbPath, {seed, settings})` — detached `spawn(nodeBin, [RUNGEN, --seed, --out, --resume,
  --ticks Infinity, --settings …])` + `caffeinate -s -w <pid>`. `nodeBin` = `process.execPath` (Electron-
  as-node from the app; system node from the CLI — both run the same run-gen.mjs, both match the ps scan).
- `bgStart(dbPath, meta)` / `bgStop(dbPath)` / `reconcileJobs()` — moved verbatim, made to take the
  registry object rather than a module global (or keep a module-level registry; decide in review).
- `POOL_SETTINGS` shared so a FRESH CLI run matches the app's config exactly. (‑‑resume ignores it.)

`main.mjs` then imports and delegates; its IPC handlers (`jobs:*`) are thin wrappers. The `child.on('exit')`
UI-notify hook stays in main (needs `win`); the CLI has no UI, so its spawned child just exits and the next
`reconcile`/scan collapses it.

### 2. New CLI: `tools/scrub/gen-ctl.mjs`

```
node tools/scrub/gen-ctl.mjs start <seed|path> [--days N]   # default: unbounded (flat-out)
node tools/scrub/gen-ctl.mjs stop  <seed|path|all>
node tools/scrub/gen-ctl.mjs list                            # what the Jobs window shows
```

- `start`: resolve seed→`<timelines>/seed-N.db` (or a literal path). If `isWriterLive` OR the ps-scan
  already shows it → **adopt** (record in registry, no 2nd writer), print "already running (pid …)".
  Else `bgSpawn` + record. `--days N` → pass `--until <N*5184000>` (needs a run-gen `--until` flag;
  otherwise omit and stay unbounded per Karl's flat-out rule — default is unbounded regardless).
- `stop`: `bgStop(dbPath)` (kill + collapse). `all` → every entry in registry ∪ scan.
- `list`: `reconcileJobs()` then print dbPath, pid, running?, day (frontier/5_184_000), background flag.

### 3. Coordination contract ("don't step on each other")

- **Single writer** is enforced by `isWriterLive` on BOTH start paths + SQLite's WAL single-writer lock +
  `busy_timeout` as the backstop. The CLI must gate BEFORE spawn, exactly like `bgStart`.
- The app on launch runs `reconcileJobs()` → adopts any CLI-started generator into the Jobs window and can
  stop it. The CLI reads/writes the SAME `bg-jobs.json`, so `list`/`stop` see the app's jobs too.
- When the app is the FOREGROUND writer of a db (its own `scrub.child`), CLI `stop <that db>` will kill it;
  document that `stop` targets background/detached generators — stopping the app's foreground run from the
  CLI is allowed but will just make the app reopen read-only on next poll.

## Hazards / open questions (for review)

1. **Double-writer TOCTOU**: `isWriterLive` check → spawn has a gap. A fresh generator's ‑wal isn't warm
   for up to `staleMs` (4s), so two near-simultaneous starts could both pass the gate. Backstop: SQLite WAL
   lock + busy_timeout (second writer gets SQLITE_BUSY, no corruption) — but run-gen may crash on BUSY
   rather than exit cleanly. Do we need an atomic lockfile (O_EXCL) keyed on dbPath as the real gate?
2. **`app.getPath('userData')` vs a hand-rolled path** — must be byte-identical or the CLI and app use
   different registries. Verify on macOS; fail loudly if the dir doesn't exist.
3. **node binary parity**: app spawns Electron-as-node, CLI spawns system node (v25). Same run-gen.mjs,
   same V8 family, determinism goldens hold cross-arch — but confirm a run resumed/continued is unaffected
   (one writer at a time per db, so no in-db mixing; still worth a note).
4. **`caffeinate` from a detached CLI** — the CLI process exits immediately after spawn; does `caffeinate
   -w <child.pid>` (watching the generator, not the CLI) survive? It should (own detached process). Verify.
5. **`stop all` blast radius** — should it also kill the app's foreground run? Propose: no by default;
   `--include-foreground` if ever needed. (Likely CLI is used when the app is closed anyway.)
6. **Refactor risk**: moving `bgStart/bgStop/scanGenerators` out of `main.mjs` must not regress the tested
   Jobs-window behavior. Keep `test/io/bg-writer-guard.test.js` green; add CLI-level tests.

## Test plan

- Unit (headless, no Electron): `gen-jobs.mjs` — `jobsDir()` matches the known macOS path; registry
  round-trips; `scanGenerators` parses spaced paths; start refuses/adopts when `isWriterLive`.
- Integration: CLI `start` a throwaway db → appears in `scanGenerators` and `bg-jobs.json` → CLI `stop`
  kills it and collapses sidecars (no ‑wal/‑shm left). Then: start via CLI, confirm a mock "app launch"
  (`reconcileJobs`) adopts it.
- Regression: full suite stays green (esp. bg-writer-guard, merge-import, commit-param-edit).

---

## Review 1 — folded findings (SUPERSEDES the design above where noted)

The first review confirmed the direction but found the concurrency model was under-specified. Key correction:
**two writers on one WAL db do NOT corrupt the file and do NOT fail-fast.** Short keyframe txns +
`busy_timeout=4000` (sqlite-sink.mjs:25) make the loser *retry and succeed*, so both generators alternately
`INSERT OR REPLACE INTO snapshots(tick,…)` (run-db.mjs:74) from two divergent trajectories onto the same
tick grid. The file stays valid; the RUN becomes an undetectable mix of two sims. Worse than a crash. So a
deterministic atomic gate is mandatory, not optional.

### D1 (BLOCKER→resolved). The gate moves INTO `openRunWriter`, as a pid-stamped O_EXCL lock

`isWriterLive` (‑wal mtime freshness, staleMs=4000) is NOT sufficient on its own: ‑wal mtime only advances
on commit, and commits are per-keyframe (every `keyframeInterval`=2000 ticks). A heavy flat-out run can go
>4 s between keyframes, so `isWriterLive` reports **false while the writer is fully alive** → a second start
passes the gate. The dangerous case is start-vs-already-running-slow-generator, not just two fresh starts.

Decision: acquire an **atomic O_EXCL lockfile at the one chokepoint every writer already passes —
`openRunWriter` (run-db.mjs)**. Then ALL writers are gated identically and automatically: app foreground
(`generator.mjs`), app background (`bgSpawn`→`run-gen.mjs`), CLI (`gen-ctl`→`run-gen.mjs`), and tests. No
caller can forget the gate. Lock rules:
- Lockfile `<db>.lock` (or `.<db>.lock`), contents = the writer **pid** (= what `scanGenerators` finds =
  what `bgStop` kills), so scan/reconcile/stop/adopt stay consistent.
- **Reclaim on dead pid**: on acquire, if the lock exists, `process.kill(pid,0)`; if dead → unlink + retake.
  This is what keeps it inside Karl's rules — we NEVER sweep directories; we reclaim exactly the one lock for
  the one db we're opening, on demand. A crash-leftover lock can never wedge a future start.
- Released on clean `finish()`/close. So **at rest there are no sidecars** (matches "delete them as
  aggressively as you can"); only a crash leaves a `.lock`, and it self-reclaims on the next start.
- `isWriterLive` stays as the cheap, no-open probe for the UI/adopt path ("is something writing this?"); the
  lock is the authoritative "may I BECOME the writer?" gate. Two different questions, both kept.
- **Sidecar-aversion note for the panel:** this introduces a new (transient, dot-prefixed, auto-deleted)
  sidecar. That's the one thing to sanity-check against Karl's hard rule. Alternative considered and
  rejected as insufficient alone: a wall-clock ‑wal heartbeat (closes the *staleness* hole but not the
  fresh-start TOCTOU, and poisoning makes TOCTOU non-trivial). The panel should confirm lock-in-openWriter
  is the right call vs. heartbeat-only vs. both.

### D2 (BLOCKER→resolved). The app's FOREGROUND run is invisible to the ps-scan — `stop` must say so

The app's foreground generator is `desktop/generator.mjs` via `utilityProcess.fork` (main.mjs:142) and gets
the db path over **IPC**, not as `run-gen.mjs --out <path>` on argv — so the scan regex (main.mjs:209)
cannot see its pid/path. Correction to §3: CLI `stop <that db>` would NOT kill it (no scan pid → `bgStop`
spins 40×150 ms and gives up, a 6 s no-op). Once the lock (D1) carries the foreground writer's pid, `stop`
CAN identify it: **db is live + lock pid is alive + not in our scan = owned by the running app**. `stop`
then reports "owned by the running app — stop it in the Jobs window" instead of pretending. (`start` on that
db is already safe: it adopts.) The lock makes the previously-invisible foreground writer *visible and
attributable* — a second reason D1 is the right primitive.

### D3 (SHOULD→resolved). Do not hand-roll the userData path — the name already drifted once

`tools/scrub/peek-mutrate.mjs:10` still hard-codes `…/genepool-desktop/runs` while the live app is
`app.setName('GenePool')` → `…/GenePool/timelines` (main.mjs:28,82). A guessed path risks pointing the CLI at
a DIFFERENT registry/lock dir than the app → defeats the whole feature. Decision: **the app writes its
resolved `app.getPath('userData')` to a fixed discovery file on launch** (e.g. `~/.genepool/userdata-path`),
and the CLI reads that. Fallbacks: `GENEPOOL_USERDATA` env override; then the macOS default; and the CLI
**hard-fails (never `mkdir`s a divergent tree)** if it can't confirm the dir exists. A test asserts the
resolved path === `app.getPath('userData')` on macOS.

### D4 (SHOULD→resolved). Extraction coupling — inject, don't reference

Moving `bgStart/bgStop/scanGenerators/reconcileJobs/bgSpawn/bgList` into `gen-jobs.mjs` must break these
`main.mjs` couplings by injection (app passes the real thing; CLI passes a noop):
- `win`/`notifyJobs()` (bgSpawn exit handler :195, bgStop :250) → injected `onChanged` callback.
- `scrub` + `stopGeneratorAndWait` in bgStart :232 ("hand off if WE are the foreground writer") → injected
  `yieldForeground` hook. CLI has no `scrub` → noop.
- `app.getPath('userData')` (:176,82,184) → all through `jobsDir()` (D3).
- `POOL_SETTINGS` (:81) → into the shared module.
- `bgSpawn`'s `child.on('exit')` cleanup is **app-only best-effort**; the real cleanup is `reconcileJobs`
  (which the CLI and the app-on-launch both run). Make the exit handler injected/optional so it isn't
  misleading dead code in the CLI.
- `nodeBin` for the spawn: default to **Electron-as-node when available** (fresh-run bit-reproducibility
  with the app), else system node (document the engine seam; determinism tests stay single-engine — N1).

### D5 (NIT→resolved). `list` is read-only

`reconcileJobs()` collapses dead runs (a write). CLI `list` uses a **read-only** variant that reports
`running?`/`day` without collapsing, so a status check never mutates files. (`start`/`stop` still reconcile.)

### Confirmed non-issues (no action)
- **caffeinate from a detached CLI**: fine — it watches the *generator* pid, survives CLI exit (N2).
- **`--ticks Infinity`** already works (run-gen.mjs:106,75); no `--until` needed — default stays unbounded
  per the flat-out rule (N3).
- **`bg-jobs.json` cross-process race**: tolerable — the registry is advisory and self-heals from
  `scanGenerators`/`reconcileJobs`; the **lock** is the atomic primitive, not the JSON (N4).
- **SIGTERM mid-loop**: safe — keyframe writes are atomic single txns and resume truncates past `frontier`,
  so a killed generator leaves a clean prefix (N6).

### Test additions from review 1
- Two concurrent `openRunWriter`/`start` on one db → exactly one writer; the second is refused/adopts.
- Crash-leftover lock with a **dead** pid → next `start` reclaims and succeeds (proves it never wedges).
- `jobsDir()` resolved path === `app.getPath('userData')` (macOS); CLI hard-fails if the dir is absent.
- `test/io/bg-writer-guard.test.js` stays green (isWriterLive/collapse semantics unchanged).

---

## Panel synthesis (5 lenses) — v3, SUPERSEDES D1/D3 above

The 5-lens panel (concurrency, determinism, product-rules, refactor, crash/ops) converged on two headline
corrections. Both are folded in here; where this section conflicts with D1–D5 above, THIS wins.

### V1 (BLOCKER, MEASURED) — pin the generator to the app's exact engine; gate resume on engineVersion
The engine calls `Math.sin/cos/pow/hypot` every tick (swimbot.js:308-351, world.js:533, obstacle-field.js:130);
these are V8's fdlibm — stable within a V8 version, NOT across versions. **Confirmed empirically 2026-09-24:**
seed 7 × 4000 ticks → finalPop **265** under system node (V8 14.1.146.11-node.25) vs **275** under the app's
Electron (V8 15.2.124.19-electron.0). A run generated/resumed by the wrong engine silently forks.
- Every generator spawn (foreground, background, AND the CLI) must use the **app's bundled Electron-as-node**
  and hard-fail if it's absent — never system node. `gen-ctl` becomes the ONLY sanctioned start path.
- Populate `engineVersion` (currently always `null` — run-gen.mjs:42 passes `?? null`, nothing sets it) with
  `process.versions.v8`; on resume, refuse (or `--force`) if the running engine ≠ the run's stored version.
- Bake POOL_SETTINGS as run-gen's default (or route only through gen-ctl) so a FRESH run is app-identical no
  matter who starts it — today `run-gen --resume <fresh-path>` builds a wrong-config fresh run (settings off).
- **Existing debt:** the 50 seed dbs were generated under system node → they won't play back faithfully in
  the app. Decide with Karl whether to regenerate under the app engine (they're determinism-invalidated, not
  corrupt). Drop the "No engine/determinism changes" claim — choosing the engine IS a determinism policy.

### V2 (BLOCKER) — NO new on-disk artifacts. Drop the `.lock` sidecar AND the discovery dotfile.
The `.lock` design (D1) is unsound *and* unwanted: (a) unbounded flat-out runs NEVER call `finish()`/close —
they die by signal (no SIGTERM handler exists), so "released on clean close" is dead code and a `.lock` would
linger after EVERY normal stop/quit, not just crashes — squarely his #1 aversion; (b) reclaim via
`unlink`+`O_EXCL create` is non-atomic (two reclaimers → two writers); (c) pid-only identity wedges or
mis-kills on pid reuse after reboot; (d) it's a third sidecar species beside `-wal`/`-shm`. The discovery
dotfile `~/.genepool/…` (D3) is a second new artifact in his home for no reason.

**Revised gate (no new files): harden the machinery that already exists.**
- **Authority = the cmdline ps-scan** (`run-gen.mjs … --out <db>`), which is inherently reboot- and
  pid-reuse-safe (a recycled pid won't carry that cmdline). Make `reconcileJobs` trust the cmdline match, not
  bare `process.kill(pid,0)` — this also fixes an EXISTING phantom-job bug (main.mjs:224).
- **Close the `isWriterLive` staleness hole** (‑wal mtime only advances per-keyframe; >4 s between keyframes
  on heavy runs → false "not live") with a cheap **wall-clock ‑wal heartbeat** in the writer loop —
  determinism-neutral, no new file. Now isWriterLive reliably catches the app's foreground writer too.
- **CLI honors the same gate**: `start` → scan+isWriterLive → adopt/refuse if already written; else
  spawn(app-Electron)+caffeinate+register. Same code path as `bgStart`.
- **Discovery = a shared `APP_NAME` constant** imported by both `app.setName(APP_NAME)` and the CLI's
  `jobsDir()` (they can't drift); `GENEPOOL_USERDATA` env override for headless/CI; hard-fail if the dir is
  absent (never mkdir a divergent tree). No dotfile.
- **Residual:** two `start`s on the SAME db in the SAME ~1 s remain the only unguarded race. Founding
  (tick 0) is byte-identical for both, and the app serializes its own starts, so the exposure is a narrow
  CLI-vs-app same-instant collision; mitigate with spawn-then-verify (kill the newer pid on a double-sighting).
  A HARD atomic guarantee would cost either a lockfile (a sidecar) or a native `flock` module — offer to Karl,
  don't build unprompted.

### V3 (from refactor lens) — land it in TWO commits, extraction before behavior
1. **Mechanical extraction** (behavior-preserving): move `scanGenerators`/`reconcileJobs`/`bgSpawn`/`bgStart`/
   `bgStop`/registry I/O/`dayOf` into an Electron-free `tools/scrub/gen-jobs.mjs`; inject `onChanged`
   (notifyJobs) and `yieldForeground` (scrub+stopGeneratorAndWait). KEEP `bgList`+`sessionKnown`+the four
   `jobs:*` IPC handlers in `main.mjs` (UI concern). Self-resolve `RUNGEN` via `import.meta.url` (no ROOT
   param). Keep spawn opts verbatim (detached, stdio, unref, `ELECTRON_RUN_AS_NODE`, caffeinate). Move
   POOL_SETTINGS to a shared config module (or pool-seed.mjs), NOT gen-jobs. Add characterization tests for
   the ps-scan/adopt/prune logic (currently ZERO coverage — bg-writer-guard tests only run-db primitives).
   IPC row shape stays byte-identical → renderer untouched (confirmed).
2. **Behavior change** (own commit/review): the engine-pin + engineVersion gate (V1) and the heartbeat +
   cmdline-authority (V2). Keeps the diff bisectable.

### V4 (crash/ops) — self-healing checklist
- `stopGenerator`/`bgStop` already wait for the writer to die + `checkpointClose` → sidecars collapse on stop.
- Launch reconcile does NOT clean UNTRACKED reboot residue (dbs never in bg-jobs.json) — state this plainly;
  don't sweep. Those collapse when the db is next opened. Acceptable per Karl's crash-leftover rule.
- Packaging: **assert `asar: false`** (spawn runs run-gen.mjs as a real file). `.app`-replaced-mid-run is fine
  (old binary stays mapped; stable install path keeps the ps-scan matching).
- ENOSPC and SIGKILL leave a clean resumable prefix (frontier-last, atomic keyframe txn) — no manual cleanup.

### Product decisions
- **Decided (me):** no new artifacts (V2); pin engine (V1); drop `--days` (unrequested, points back toward a
  bounded run — against the flat-out rule); `start`/`stop`/`list` surface only; a `restart` alias + a short
  `gen` wrapper for ergonomics.
- **For Karl:** (1) `start` across a whole dir — run ALL at once (pegs every core) or one-at-a-time? (2)
  regenerate the 50 system-node seed dbs under the app engine, or leave them? (3) deploy timing (the refactor
  bounces the running app). Ask in prose, no menu.

## Rollout

Files: new `tools/scrub/gen-jobs.mjs`, new `tools/scrub/gen-ctl.mjs`, slimmed `desktop/main.mjs`, maybe a
`--until` flag on `run-gen.mjs`, new `test/io/gen-ctl.test.js`. Hot-swap main.mjs into the packaged app
(needs relaunch). No engine/determinism changes.
