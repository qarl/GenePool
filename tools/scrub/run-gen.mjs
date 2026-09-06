// run-gen.mjs -- the headless run-ahead GENERATOR for scrub/playback. Simulates a seed flat-out, single-thread,
// mixed-live (the viewer's default perception), and writes a sparse, replayable run to `runs/run-<seed>.db` via
// run-db.mjs: gzipped keyframes every KEYFRAME_INTERVAL ticks + a dense stats row every STATS_INTERVAL + the event
// stream (ticks throttled, N5). In the desktop app this same code runs inside an Electron utilityProcess (D1) --
// same V8 as the playback renderer, so restore()+resim is bit-identical. Here it runs as plain Node so the whole
// path is testable without a GUI (D11 Phase 2).
//
//   node tools/scrub/run-gen.mjs --seed 7 [--ticks 20000] [--out runs/run-7.db]
//        [--keyframe 2000] [--stats 250] [--throttle 100] [--pool 8000] [--n 1500]
//
// Determinism note: a run is DEFINED by its keyframe-0 (serialize() taken after seeding, D8); playback restores
// that, never re-derives founders. So the generator owns the seeding -- here the tested common.mjs founders
// (junk-zeroed genomes, so speciation doesn't isolate every founder -> real births).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../../engine/world.js';
import { openRunWriter } from '../events/run-db.mjs';
import { makeStandardWorld, poolConfig, POOL_DEFAULTS } from '../../engine/pool-seed.mjs';

export const GEN_DEFAULTS = { ticks: 20000, keyframeInterval: 2000, statsInterval: 250, tickThrottle: 100, keyframeBudget: 500, ...POOL_DEFAULTS };

// Build the seed's world via the SHARED seeder (engine/pool-seed.mjs) so a generated run is IDENTICAL to what the live
// viewer shows for that seed -- region 3000, 220 junk-zeroed founders, 700 food, the viewer's config. onEvent is
// attached later so seeding events aren't recorded (keyframe-0 captures the seeded state instead, D8).
export function buildWorld(seed, { pool, n, food } = {}) {
    return makeStandardWorld(seed, { pool: pool ?? POOL_DEFAULTS.pool, n: n ?? POOL_DEFAULTS.n, food: food ?? POOL_DEFAULTS.food });
}

// Generate a run to `path`. Returns a small summary. `onProgress(tick)` / `onReady()` optional (the utilityProcess
// posts these to main). Scrub playback needs ONLY keyframes -- any tick is reconstructed by restore-nearest + resim --
// so we record NOTHING else (no events/stats/ticks). Combined with keyframe thinning, the file stays BOUNDED even
// under UNBOUNDED generation (o.ticks = Infinity): the generator runs one core flat-out until the process is killed.
export function generateRun(path, seed, opts = {}) {
    const o = { ...GEN_DEFAULTS, ...opts };
    const writer = openRunWriter(path, {
        seed: seed >>> 0, config: poolConfig(o.pool),
        keyframeInterval: o.keyframeInterval, keyframeBudget: o.keyframeBudget,
        engineVersion: o.engineVersion ?? null, perceptionMode: 'mixed-live',
    }, { resume: !!o.resume });

    let world, startTick = 0, keyframes = 0, resumed = false;
    if (writer.resumedFrom) {
        // S4/S5 crash-resume: restore from the last durable keyframe using the RUN'S stored config (S2), continue.
        world = World.restore(writer.runConfig().config, writer.resumedFrom.snapshot);
        startTick = writer.resumedFrom.tick;
        resumed = true;
    } else {
        ({ world } = buildWorld(seed, o));                 // no onEvent attached -> zero per-tick overhead
        writer.writeKeyframe(0, world.serialize()); keyframes++;   // keyframe-0 = seeded state (D8)
    }
    if (o.onReady) o.onReady({ path, frontier: startTick });   // db has a keyframe + WAL -> reader may open (S3 handshake)

    for (let t = startTick + 1; t <= o.ticks; t++) {           // o.ticks may be Infinity -> run until killed
        world.tick();
        if (t % o.keyframeInterval === 0) { writer.writeKeyframe(t, world.serialize()); keyframes++; if (o.onProgress) o.onProgress(t, t); }
    }
    writer.finish();   // (not reached for Infinity; the process is killed, and each keyframe commit is already durable)
    writer.close();
    return { path, seed: seed >>> 0, ticks: o.ticks, keyframes, resumed, resumedTick: resumed ? startTick : null, finalPop: world.getLivingSwimbotCount() };
}

// ---- CLI ----
function parseArgs(argv) {
    const a = {};
    for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1]; a[key] = (v === undefined || v.startsWith('--')) ? true : v; if (a[key] !== true) i++; } }
    return a;
}
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const a = parseArgs(process.argv.slice(2));
    if (a.seed === undefined) { console.error('usage: node tools/scrub/run-gen.mjs --seed S [--ticks T] [--out path] [--keyframe K] [--stats S] [--pool P] [--n N]'); process.exit(2); }
    const seed = Number(a.seed) >>> 0;
    const out = a.out || `runs/run-${seed}.db`;
    const opts = {};
    if (a.ticks) opts.ticks = Number(a.ticks);
    if (a.keyframe) opts.keyframeInterval = Number(a.keyframe);
    if (a.stats) opts.statsInterval = Number(a.stats);
    if (a.throttle) opts.tickThrottle = Number(a.throttle);
    if (a.pool) opts.pool = Number(a.pool);
    if (a.n) opts.n = Number(a.n);
    if (a.resume) opts.resume = true;
    mkdirSync(dirname(out), { recursive: true });
    const t0 = Date.now();
    const r = generateRun(out, seed, opts);
    const dt = (Date.now() - t0) / 1000;
    console.log(`generated ${r.path}: seed=${r.seed} ticks=${r.ticks} keyframes=${r.keyframes} finalPop=${r.finalPop} in ${dt.toFixed(1)}s (${(r.ticks / dt).toFixed(0)} t/s)`);
}
