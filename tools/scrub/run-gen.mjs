// run-gen.mjs -- the headless run-ahead GENERATOR for scrub/playback. Simulates a seed flat-out, single-thread,
// mixed-live (the viewer's default perception), and writes a sparse, replayable run to `runs/seed-<seed>.db` via
// run-db.mjs: gzipped keyframes every KEYFRAME_INTERVAL ticks + a dense stats row every STATS_INTERVAL + the event
// stream (ticks throttled, N5). In the desktop app this same code runs inside an Electron utilityProcess (D1) --
// same V8 as the playback renderer, so restore()+resim is bit-identical. Here it runs as plain Node so the whole
// path is testable without a GUI (D11 Phase 2).
//
//   node tools/scrub/run-gen.mjs --seed 7 [--ticks 20000] [--out runs/seed-7.db]
//        [--keyframe 2000] [--stats 250] [--throttle 100] [--pool 8000] [--n 1500]
//
// Determinism note: a run is DEFINED by its keyframe-0 (serialize() taken after seeding, D8); playback restores
// that, never re-derives founders. So the generator owns the seeding -- here the tested common.mjs founders
// (junk-zeroed genomes, so speciation doesn't isolate every founder -> real births).

import { mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../../engine/world.js';
import { openRunWriter } from '../events/run-db.mjs';
import { makeStandardWorld, poolConfig, POOL_DEFAULTS } from '../../engine/pool-seed.mjs';
import { createSpeciesAnalyzer } from '../../engine/analysis/species.mjs';

export const GEN_DEFAULTS = { ticks: 20000, keyframeInterval: 2000, statsInterval: 250, tickThrottle: 100, keyframeBudget: 500, ...POOL_DEFAULTS };

// Build the seed's world via the SHARED seeder (engine/pool-seed.mjs) so a generated run is IDENTICAL to what the live
// viewer shows for that seed -- region 3000, 220 junk-zeroed founders, 700 food, the viewer's config. onEvent is
// attached later so seeding events aren't recorded (keyframe-0 captures the seeded state instead, D8).
export function buildWorld(seed, { pool, n, food, settings } = {}) {
    return makeStandardWorld(seed, { pool: pool ?? POOL_DEFAULTS.pool, n: n ?? POOL_DEFAULTS.n, food: food ?? POOL_DEFAULTS.food, settings: settings ?? {} });
}

// Generate a run to `path`. Returns a small summary. `onProgress(tick)` / `onReady()` optional (the utilityProcess
// posts these to main). Scrub playback needs ONLY keyframes -- any tick is reconstructed by restore-nearest + resim --
// so we record NOTHING else (no events/stats/ticks). Combined with keyframe thinning, the file stays BOUNDED even
// under UNBOUNDED generation (o.ticks = Infinity): the generator runs one core flat-out until the process is killed.
export function generateRun(path, seed, opts = {}) {
    const o = { ...GEN_DEFAULTS, ...opts };
    const runConfig = poolConfig(o.pool, o.settings ?? {});   // per-pool experiment settings baked into the run's stored config
    const writer = openRunWriter(path, {
        seed: seed >>> 0, config: runConfig,
        keyframeInterval: o.keyframeInterval, keyframeBudget: o.keyframeBudget,
        engineVersion: o.engineVersion ?? null, perceptionMode: 'mixed-live',
    }, { resume: !!o.resume });

    // Per-keyframe STATS: whole-pool diversity (popDivEMA) + life expectancy (popLifeEMA, EMA of age-at-death), the same
    // metrics the viewer's upper-left overlay shows. Diversity is recomputed per keyframe; life is folded per DEATH via a
    // lightweight world event handler (only 'death' is used). Measured overhead is within noise (tick cost dominates), so
    // the generator stays flat-out. NOTE: on resume the EMAs restart (fresh analyzer) -> a resumed run's early stats are
    // null/rebuilding; a fresh run (the wipe-and-regenerate flow) has full-history stats.
    const analyzer = createSpeciesAnalyzer(runConfig);   // exclude the mutation-rate gene from clustering when it's active (matches the engine gate)
    const statsRow = () => ({ div: analyzer.popDivEMA, life: analyzer.popLifeEMA });

    let world, startTick = 0, keyframes = 0, resumed = false;
    if (writer.resumedFrom) {
        // S4/S5 crash-resume: restore from the last durable keyframe using the RUN'S stored config (S2), continue.
        world = World.restore(writer.runConfig().config, writer.resumedFrom.snapshot);
        startTick = writer.resumedFrom.tick;
        resumed = true;
    } else {
        // Seed founders from the run's STORED config (the recipe), NOT o.settings -- so a tick-0 parameter edit
        // (commitParamEdit deletes keyframe-0 + rewrites the stored config) re-seeds under the EDITED config on resume.
        // For a plain fresh run the stored config == poolConfig(o.pool,o.settings), so this is byte-identical.
        const seedCfg = writer.runConfig()?.config ?? runConfig;
        ({ world } = makeStandardWorld(seed, { n: o.n, food: o.food, config: seedCfg }));   // no onEvent; death handler attached next
        analyzer.recompute(world._swimbots.values());
        writer.writeKeyframe(0, world.serialize(), statsRow()); keyframes++;   // keyframe-0 = seeded state (D8) + its stats
    }
    world._onEvent = (e) => { if (e && e.type === 'death') analyzer.foldDeath(null, e.age); };   // fold age-at-death into popLifeEMA (pop-level; null sb skips the lineage EMA)
    if (o.onReady) o.onReady({ path, frontier: startTick });   // db has a keyframe + WAL -> reader may open (S3 handshake)

    // EXTINCTION = terminal: once every swimbot is dead there are no parents, so no births can ever occur -- the pool
    // stays dead. Stop generating rather than tick a frozen dead world forever (Karl). A resumed extinct run (restored
    // world already at 0 living) skips the loop outright. This is a natural end state, NOT a throttle of a live run.
    let living = world.getLivingSwimbotCount();
    try {
        for (let t = startTick + 1; t <= o.ticks && living > 0; t++) {   // o.ticks may be Infinity -> run until killed or extinct
            world.tick();
            living = world.getLivingSwimbotCount();
            writer.maybeBeat();                                     // inline wall-clock heartbeat (the loop is synchronous and blocks the event loop, so a timer never fires); also the token FENCE check
            if (t % o.keyframeInterval === 0 || living === 0) {          // keyframe on the interval, plus a FINAL one at extinction
                analyzer.recompute(world._swimbots.values());            // refresh diversity for this keyframe (life is folded per death above)
                writer.writeKeyframe(t, world.serialize(), statsRow()); keyframes++;
                if (o.onProgress) o.onProgress(t, t);
            }
        }
        writer.finish();   // reached on extinction / finite ticks (for Infinity+never-extinct, the process is killed instead; each keyframe commit is already durable)
    } catch (e) {
        // FENCED = another writer reclaimed this db (we were presumed dead). Stop WITHOUT finishing (we no longer own it);
        // the reclaimer is authoritative. Any other error propagates.
        if (e && e.code === 'FENCED') { try { writer.close(); } catch { /* */ } return { path, seed: seed >>> 0, ticks: o.ticks, keyframes, resumed, reclaimed: true, finalPop: world.getLivingSwimbotCount() }; }
        throw e;
    }
    writer.close();
    return { path, seed: seed >>> 0, ticks: o.ticks, keyframes, resumed, resumedTick: resumed ? startTick : null, finalPop: world.getLivingSwimbotCount() };
}

// ---- CLI ----
function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1]; a[key] = (v === undefined || v.startsWith('--')) ? true : v; if (a[key] !== true) i++; } }
    return a;
}
// Detect "run as a CLI script" robustly: compare REAL paths (handles spaces/non-ASCII in the path -- which the old
// `file://`+argv compare percent-encoded into a mismatch -- and symlinks). Load-bearing for the detached background
// generator spawned from the packaged .app (paths with spaces, iCloud dirs, symlinked bundles).
let isMain = false;
try { isMain = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ''); } catch { isMain = false; }
if (isMain) {
    const a = parseArgs(process.argv.slice(2));
    if (a.seed === undefined) { console.error('usage: node tools/scrub/run-gen.mjs --seed S [--ticks T] [--out path] [--keyframe K] [--stats S] [--pool P] [--n N]'); process.exit(2); }
    const seed = Number(a.seed) >>> 0;
    const out = a.out || `runs/seed-${seed}.db`;
    const opts = {};
    if (a.ticks) opts.ticks = Number(a.ticks);
    if (a.keyframe) opts.keyframeInterval = Number(a.keyframe);
    if (a.stats) opts.statsInterval = Number(a.stats);
    if (a.throttle) opts.tickThrottle = Number(a.throttle);
    if (a.pool) opts.pool = Number(a.pool);
    if (a.n) opts.n = Number(a.n);
    if (a.resume) opts.resume = true;
    if (a.fix) opts.settings = { ...(opts.settings || {}), fixBranchCategoryGene: true };   // match the desktop app's fix-on decode for FRESH runs (resumed runs keep their stored config)
    if (a.settings) { try { opts.settings = { ...(opts.settings || {}), ...JSON.parse(a.settings) }; } catch { console.error('bad --settings JSON'); process.exit(2); } }
    mkdirSync(dirname(out), { recursive: true });
    const t0 = Date.now();
    let r;
    try { r = generateRun(out, seed, opts); }
    catch (e) {
        if (e && e.code === 'WRITER_LIVE') { console.log(`already being generated (pid ${e.pid}) -- ${out}`); process.exit(0); }   // adopt, don't double-write
        throw e;
    }
    const dt = (Date.now() - t0) / 1000;
    if (r.reclaimed) { console.log(`reclaimed by another writer -- stopped ${out} (keyframes=${r.keyframes})`); process.exit(0); }
    console.log(`generated ${r.path}: seed=${r.seed} ticks=${r.ticks} keyframes=${r.keyframes} finalPop=${r.finalPop} in ${dt.toFixed(1)}s (${(r.ticks / dt).toFixed(0)} t/s)`);
}
