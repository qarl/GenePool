# PLAN — a start/stop generator CLI that shares the app's background-jobs machinery

## Goal (Karl's ask)

> "a nice command line switch to start and stop background generation with hooks so that when the app
> launches, they don't step on each other and the app can start/stop them too from the jobs window."

Today Claude starts a generator by running the worker directly with **system node**:
`node tools/scrub/run-gen.mjs --seed 5 --out <db> --resume`. That bypasses the app's writer-authority
gate, `caffeinate`, and the `bg-jobs.json` registry. We want ONE start/stop path used by both the CLI
and the Jobs window, so the two never step on each other.

---

## ⭐ v4 — CROSS-PLATFORM coordination via a db-heartbeat (SUPERSEDES all ps-scan / isWriterLive-primary /
## engine-pin discussion below). Windows + Linux + macOS are REQUIRED (Karl, 2026-09-24: "we need windows/
## linux. so 'ps' is a no-go.")

Everything below that relies on `ps -Awwo …` (`scanGenerators`/`reconcileJobs`), on `-wal` mtime as the
primary liveness signal, or on the engine-pin (V1) is **obsolete**:
- `ps` is Unix-only → **dropped**. No process-table enumeration at all.
- The engine-pin (V1) is moot: since epoch **pmath-1** the engine is byte-identical on any V8/CPU, so any
  node produces identical runs — no need to spawn the app's exact Electron. `engineVersion` becomes the
  pmath epoch tag (informational), not a gate.

### The coordination point is the DB FILE itself — an atomic writer-claim + heartbeat in `run_meta`

Every writer opens the db through one chokepoint (`openRunWriter`). It claims ownership IN the db, in one
serialized SQLite transaction (works identically on Windows/Linux/macOS — just SQLite):

```
BEGIN IMMEDIATE                      -- SQLite's single write-lock; busy_timeout (e.g. 5s) handles contention
  read run_meta.writer_heartbeat, writer_pid, writer_token
  if heartbeat fresh (< STALE_MS, e.g. 4000ms):   -> owned. COMMIT; report "already running (pid)"; adopt/refuse.
  else (stale or absent):                         -> write my pid + fresh heartbeat + a random token; COMMIT. I own it.
```
Then the writer refreshes `writer_heartbeat` every ~1s (a tiny UPDATE) for its whole life.

**Atomicity (the double-writer guarantee):** `BEGIN IMMEDIATE` takes SQLite's exclusive write lock, so two
racers cannot both claim — the second blocks until the first COMMITs, then sees the fresh heartbeat and backs
off. This is a HARD atomic guarantee (stronger than the old scan), with **no lock/sidecar file** and **no ps**.

### The three properties, now portable
| question | how (v4) |
|---|---|
| is this db being written? | `run_meta.writer_heartbeat` is fresh |
| who to kill to stop it? | `run_meta.writer_pid` |
| reboot / pid-reuse safe? | liveness = heartbeat freshness (only the real writer refreshes it); never trust a bare pid. After reboot nothing refreshes → all stale → reclaimable |
| find external / orphan writers? | list the known run dirs (timelines + custom) + read each db's heartbeat — a dir listing + db read, both OS-neutral |

- **stop**: read `writer_pid`, `process.kill(pid)` (terminates on every OS; Windows kill is ungraceful — fine,
  a killed generator leaves a clean resumable prefix), watch heartbeat go stale, then `collapseToSingleFile`.
  Guard the kill on a FRESH heartbeat (fresh ⟹ the real writer is refreshing ⟹ the pid is valid, so no
  pid-reuse mis-kill); if already stale, don't kill (owner is gone) — just collapse.
- **discovery / Jobs list**: session-known dbs ∪ a listing of the run dirs; per-row "running" = fresh heartbeat.
  `bg-jobs.json` stays only as the UI's session list; the db heartbeat is the source of truth (self-heals).

### Bonus: closes the foreground blind spot
The old scan couldn't see the app's FOREGROUND run (it forks `generator.mjs` over IPC, not `run-gen.mjs
--out`). Since the heartbeat lives in the db and EVERY writer goes through `openRunWriter`, the foreground
writer now advertises itself too — the CLI and Jobs window see it correctly.

### Cross-platform surface (the only OS-specific bits)
- **keep-awake** (optional): `caffeinate -s -w` (macOS) / `systemd-inhibit` (Linux) / `SetThreadExecutionState`
  (Windows) behind one helper; absent → jobs still run, may pause on sleep. NOT required for correctness.
- **detached spawn**: Node's `spawn(..,{detached, stdio:'ignore'}).unref()` is cross-platform (add
  `windowsHide:true` on Windows).
- everything else (`BEGIN IMMEDIATE`, `run_meta` I/O, dir listing, `process.kill`, `collapseToSingleFile`) is
  already OS-neutral.

### What survives from the earlier reviews (still in force)
- No new on-disk sidecars (V2) — the heartbeat lives INSIDE the db, not a `.lock`. ✓ satisfies it even better.
- Shared `APP_NAME` constant for the userData path, not a discovery dotfile (V2/D3).
- The extraction into an Electron-free `gen-jobs.mjs` (D4) + `gen-ctl start/stop/list` (Section 2) + read-only
  `list` (D5) + two-commit rollout (V3) — all unchanged.
- `list` must NOT collapse dbs (read-only); collapse only on `stop`.

### Review v4.1 — folded findings (SUPERSEDES the sketch above where noted)

Verdict: sound + genuinely cross-platform; atomicity, reader-safety, determinism, reboot/pid-reuse all
confirmed. Two BLOCKERS on the *implementation* of the heartbeat, folded:

- **HB-B1 (BLOCKER) — the heartbeat MUST be an inline wall-clock beat, never `setInterval`.** `generateRun`
  (run-gen.mjs:75-83) is a fully SYNCHRONOUS `for` loop to `Infinity` — it blocks the event loop, so a timer
  callback never runs → the writer would stamp its claim once, never refresh, go stale within STALE_MS while
  fully alive → next starter reclaims → TWO writers (guaranteed, not a race). Fix: in the loop, after
  `world.tick()`, `if (Date.now()-lastBeat > REFRESH_MS){ beat(); lastBeat=Date.now(); }` as a tiny txn; AND
  stamp the heartbeat INSIDE `writeKeyframe`'s existing transaction (run-db.mjs:145-155) so a long keyframe
  write can't starve it.
- **HB-B2 (BLOCKER) — `writer_token` must be an active FENCE, not just written.** On each beat and inside
  `writeKeyframe`, re-read `run_meta.writer_token`; if it != my token (someone reclaimed me), ROLLBACK and
  `process.exit`. This converts a wrongful starvation-reclaim from "two divergent trajectories silently merged
  onto one tick grid" into "the reclaimed writer aborts before writing" — the safety net that makes any reclaim
  tolerable. Required, not optional.
- **HB-S1 (SHOULD) — not every writer funnels through `openRunWriter` today.** Raw writers:
  `commitParamEdit` (run-db.mjs:261), `commitImport` (:304), `collapseToSingleFile` (:344), and `recordStart`→
  `createSqliteSink` directly (main.mjs:58). Today they're safe by ORCHESTRATION (commit-edits behind
  `stopGeneratorAndWait`+`editTarget` BG_OWNED refusal; recordStart behind an `isWriterLive` check). Decision:
  route the claim through a shared helper used by `openRunWriter` AND the commit-edit/`recordStart` opens, OR
  state plainly they rely on caller-side serialization and are out of the atomic-claim's scope. (Prefer the
  shared helper for commit-edits since they truncate+rewrite; recordStart writes a user-chosen `.db` and can
  keep its isWriterLive guard.)
- **HB-S2 (SHOULD) — widen STALE_MS to ~10s (REFRESH ~1s).** Asymmetric cost: a false reclaim = silent
  corruption; a slow reclaim of a dead writer = a few extra seconds. Worst-case iteration = tick + keyframe
  (serialize+gzip multi-MB + thin DELETE) + a possible multi-second V8 full-GC can exceed 4s on a huge pool.
  Use REFRESH≈1s, STALE_MS≈10s (~10 missed beats), backstopped by the HB-B2 fence.
- **HB-S3 (SHOULD) — the claim LOSER must `close()` its sink.** Both racers open a WAL writer connection before
  either claims; the one that backs off must COMMIT/rollback and close, or it leaks a writer handle + `-shm`.
- **HB-N1 (confirmed, load-bearing) — the "any node" premise is VALIDATED.** pmath-1 neutralizes the V8 trig
  divergence: measured seed 7 → identical vector `a663a0fe 4d0842ea 39536da7` under system node (V8 14.1) AND
  the app's Electron (V8 15.2). So a CLI (system-node) run plays back identically in the app. No engine-pin.
- **HB-N2 — `collapseToSingleFile` on `stop` is unclaimed**; a concurrent `start` claiming the just-stale db can
  race it. Benign (collapse has busy_timeout + `catch{return false}` → declines), but note the window.
- **HB-N3 — discovery misses custom timelines saved OUTSIDE the known dirs** (Save-As allows any path). Covered
  only via `bg-jobs.json` session list — same accepted limitation as untracked reboot residue; state it.
- **HB-N4 — keep the two liveness thresholds in sync.** `run_meta` heartbeat (new truth) and `-wal` mtime
  (`isWriterLive`, still used at main.mjs:128,233,345,488) agree only because the beat touches `-wal`; keep
  STALE_MS consistent, or migrate those call sites to the heartbeat.

### ⭐ v4.2 — 5-LENS PANEL SYNTHESIS (final, BUILD-READY spec). Supersedes conflicts above.

Verdict (fence-concurrency, cross-platform, integration, crash/ops, product): the one-writer invariant TRULY
holds and the design is portable + self-healing — IFF the mechanism below is implemented exactly. Confirmed
sound: the SQLite write lock serializes claim-vs-keyframe (no window for two durable writers), determinism is
untouched (`run_meta` ∉ `world.serialize()`), live-scrub readers are undisturbed (WAL), and the foreground
blind spot is closed. All fixes folded:

**FENCE MECHANISM (pin exactly — it's a guarantee only if coded this way):**
- **Wide token** (`crypto.randomUUID()` or `randomBytes(16)` + `pid`), generated in the claim, NOT engine RNG,
  NOT a short `Math.random` (a collision silently defeats the fence). [fence-B1]
- Every fenced write = **`BEGIN IMMEDIATE`** (acquire write lock + current snapshot up front — change
  `writeKeyframe`'s current deferred `BEGIN`, run-db.mjs:146) → `SELECT writer_token` → `if (token!==mine)
  {ROLLBACK; process.exit}` → the snapshot/stats/**heartbeat+token**/frontier writes → **one** COMMIT. Same
  shape for the inline beat and the claim. [fence-B2, crash-S2]
- Fence covers ALL frontier/done-advancing commits: `writeKeyframe`, the inline beat, AND `writeStats`/`finish`
  (run-db.mjs:158,168) — a reclaimed writer reaching `finish` must not stamp `done=1`. [fence-S1, crash-S3]

**CLAIM PLACEMENT & LIFECYCLE:**
- The claim is the FIRST write action in `openRunWriter` — after `createSqliteSink`/`ensureSchema`, **before**
  the destructive resume-truncation (run-db.mjs:81-98), else two resuming racers both truncate. [integration-B3]
- The claim LOSER must `sink.close()` before backing off (createSqliteSink already made `-wal`/`-shm`). [HB-S3]
- Claim-time `SQLITE_BUSY` = "owned → back off/retry", NEVER "proceed". Set the claim conn's `busy_timeout`
  ≥ worst-case keyframe (≈ STALE_MS) so a claim during a long keyframe waits it out then reads fresh. [fence-N2, crash-S4]

**THRESHOLDS — ONE constant everywhere:** `REFRESH≈1s`, `STALE_MS≈10s`. Migrate/bump `isWriterLive`'s
`staleMs` (run-db.mjs:330, default 4000) to the same value, or route its call sites (main.mjs:128,233,246,248,
488,516) to the heartbeat. A split (4s vs 10s) re-opens a 6s double-writer back-door. [all-panels-S1, HB-N4]

**HEARTBEAT IMPL:** inline wall-clock beat in the sync loop (run-gen.mjs:75-83), NOT `setInterval` (never
fires — the loop blocks the event loop), AND stamp the beat inside `writeKeyframe`'s txn so a long keyframe
can't starve it. The only alive-but-silent window is `serialize()`+gzip+GC (which run OUTSIDE the lock) — the
FENCE, not STALE_MS, covers it. [HB-B1, fence-N3]

**STOP / KILL (reboot + pid-reuse safe):**
- Before `process.kill(writer_pid)`, sample the heartbeat TWICE ~1.2s apart: kill ONLY if it's **advancing**
  (a truly-live writer bumps it). Frozen-fresh (crashed within STALE_MS, pid maybe reused) or stale → do NOT
  kill; just wait-stale + collapse. This removes the pid-reuse mis-kill window entirely. [fence-S3, crash-B1]
- Lifecycle collapse (before-quit main.mjs:516, bgStop:246-249) keys on **pid-death** (`stopGeneratorAndWait`
  already awaits the child `'exit'` → provably dead → collapse unconditionally), NOT on the widened staleness
  window (or clean quit leaves sidecars). [integration-S1]

**NO STARTUP SWEEP:** launch discovery is a **read-only** dir listing + per-db heartbeat peek (wrap each in
try/catch → unknown=not-running). It must NEVER collapse/mutate the dbs it enumerates — collapse stays strictly
on `stop` and on an explicit single-db writer-open. (`reconcileJobs`'s current collapse-on-prune, main.mjs:225,
must not run over a dir listing — that's the sweep Karl rejected.) [crash-B2, D5]

**ALL WRITERS CLAIM (definitive table):** foreground `generator.mjs`, bg `run-gen`, CLI, `timeline:new` → via
`openRunWriter` ✓ (auto). `commitParamEdit`/`commitImport` (run-db.mjs:261,304) → route through the shared
claim helper (their `stopGeneratorAndWait` guard only stops the app's OWN child, not a detached/CLI writer).
`editTarget` (main.mjs:277) must consult the live heartbeat, not the stale `scrub.background` flag. `recordStart`
(main.mjs:58) → check the **heartbeat** (unified STALE_MS), not 4s `isWriterLive` (a >4s keyframe else opens a
2nd writer). [integration-B2, crash-B3, HB-S1]

**SELF-YIELD / HANDOFF:** backgrounding a running seed: after `stopGeneratorAndWait` kills our child, its
heartbeat stays fresh ~10s → `bgStart` must NOT adopt it; either the yield stamps the claim stale/nulls the
token, or `bgStart` skips the adopt-check for a db it just yielded and goes straight to `bgSpawn`. bg→fg
(`scrub:reopen`) must await `setBackground(off)` before reopening, else the new claim refuses. [integration-B1,S3]

**JOBS UI:** row shape unchanged (renderer untouched ✓). "changed" for detached/CLI jobs (no `child.on('exit')`)
comes from a periodic `reconcileJobs()` poll (read-only) firing `notifyJobs()` on a running→stopped transition.
[integration-S2]

**CROSS-PLATFORM (Windows+Linux+macOS required):**
- Keep-awake: platform-gate (`caffeinate`/`systemd-inhibit`/Windows no-op) AND attach an `'error'` listener —
  the current `spawn('caffeinate')` (main.mjs:193) throws an UNCAUGHT async ENOENT on non-mac (a real latent
  bug today). Optional for correctness. [xplat-B1, N6]
- Windows CLI launcher: ship `gen-ctl.cmd`/`.ps1` running the packaged `electron.exe` with
  `ELECTRON_RUN_AS_NODE=1` (no system node on Windows). [xplat-B2]
- `jobsDir()` per-OS: Win `%APPDATA%` (Roaming), Linux `$XDG_CONFIG_HOME??~/.config`, mac
  `~/Library/Application Support`, all `/<APP_NAME>`; honor env overrides; per-OS test (not mac-only). Highest
  silent-drift risk. [xplat-S1] Windows `Documents` is a Known Folder (may be OneDrive) → declare custom-timeline
  discovery app-only on Windows or query the known folder. [xplat-S2]
- `collapseToSingleFile`: retry a few times on Windows (handle-release delay after TerminateProcess; AV holds).
  [xplat-S3] Unify all `busy_timeout` values (4000/5000/2000) to one constant. [xplat-S4] `path.resolve()` every
  registry key (mixed separators). [xplat-S5] `windowsHide:true` + keep `{detached,stdio:'ignore'},.unref()`.
  [xplat-N1]
- Cross-arch bit-identity of runs is MEASURED by the CI matrix I added (ubuntu-x64 + macOS-arm64 + Electron all
  recompute the pmath golden) — not just asserted. [xplat-S6]

**DETERMINISM GATE:** `run_meta` writes are trajectory-neutral (confirmed), but gate the claim/heartbeat commit
on: `portable-determinism.test.js` green + a before/after snapshot-hash equality with the heartbeat active.
Document `synchronous=NORMAL` power-loss semantics (last committed keyframe(s) may roll back on power loss —
consistent, not corruption; SIGKILL loses nothing). [product, crash-S5]

**BUILD IN THREE COMMITS (corruption-critical primitive lands alone):**
1. Mechanical extraction → `tools/scrub/gen-jobs.mjs` (Electron-free; inject `onChanged`/`yieldForeground`/
   `jobsDir`); KEEP `bgList`+`sessionKnown`+IPC handlers in main; self-resolve `RUNGEN` via `import.meta.url`;
   spawn opts + keep-awake helper moved verbatim (+ the `'error'` fix). Add characterization tests for
   scan→adopt→prune (zero coverage today). Behavior-preserving, bisectable.
2. The `openRunWriter` **claim + heartbeat + fence** ALONE (wide token, BEGIN IMMEDIATE, kill-guard, threshold
   unification, all-writers-claim). Gated on the determinism cross-check. This is the only commit that can
   corrupt a run — reviewed on its own.
3. `gen-ctl start/stop/list` (+ Windows launcher, `restart` alias, `gen` wrapper) on the proven primitive.

**KARL DECISIONS — RESOLVED (2026-09-24):**
- (1) dir-start concurrency → **PARALLEL on all cores** (all-at-once, max throughput). `gen-ctl start <dir>`
  spawns one detached flat-out generator per timeline in the dir, all at once.
- (2) deploy timing → nothing running (clean slate), just land it.
- (3) B2 seed-vs-timeline scope → resolved by engineering (commit-edits route through the claim → any path safe).
- (4) **`list` reports LENGTH for external automation.** Per row: `name`, `path`, `running` (heartbeat
  advancing), `frontier` (ticks), `days` (= frontier / 5_184_000). Add **`--json`** (array of those objects)
  so Karl can script `list --json → decide → start/stop`. This does NOT add a bounded-run knob — the generator
  stays flat-out; STOPPING is external (his script calls `gen-ctl stop` when a level is reached). `list` stays
  READ-ONLY (never collapses). This is the automation surface: `start <dir>` (parallel) + `list --json` + `stop`.

**DOC HYGIENE:** the layers below (Section 3, D1–D5, V1–V4) are SUPERSEDED by v4/v4.1/v4.2 — treat those as a
"why we changed course" appendix; build from v4.2.

### (superseded) earlier open questions for the v4 review (panel)
1. `BEGIN IMMEDIATE` claim vs the generator's own periodic keyframe/heartbeat writes + live-scrub READERS
   (WAL allows readers alongside one writer) — confirm the claim contends only with other WRITERS, never
   blocks or is blocked by a read-only scrub reader.
2. Heartbeat cadence vs STALE_MS: 1s refresh / 4s stale — safe margin under GC pauses, a busy flat-out loop,
   and a loaded machine? What if a keyframe write itself takes >1s (huge pool) — does the heartbeat still tick
   (it's a separate tiny txn; ensure it's issued between keyframes, not starved)?
3. Claim TOCTOU is closed by BEGIN IMMEDIATE — but verify `commitParamEdit`/`commitImport` (which also open
   writers) and `recordStart` take the SAME claim path, so a branch-edit can't race a generator.
4. Writing `writer_pid`/heartbeat into `run_meta` on EVERY writer — does it perturb determinism or the golden
   hashes? (It must live in `run_meta`, which is NOT part of `world.serialize()`/the snapshot hash — confirm.)
5. Stop's kill-then-collapse across OSes; Windows ungraceful kill leaves `-wal` → next open collapses it. OK?
6. Does a stale heartbeat + a still-alive-but-wedged writer (e.g. paused in a debugger) risk a reclaim →
   two writers? (Only if a writer stops refreshing for >STALE_MS while still holding intent — acceptable? or
   raise STALE_MS?)

---

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
