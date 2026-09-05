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
import { makeEcologyConfig, makeFounders, makeFood, OBSTACLE } from '../../engine/parallel/common.mjs';
import { openRunWriter } from '../events/run-db.mjs';

export const GEN_DEFAULTS = { ticks: 20000, keyframeInterval: 2000, statsInterval: 250, tickThrottle: 100, pool: 8000, n: 1500 };

// Build the fully-seeded world for a seed, with NO onEvent attached yet (so seeding's founder/food_init events
// aren't recorded -- keyframe-0 captures the seeded state instead, D8). Deterministic from the seed.
export function buildWorld(seed, { pool = GEN_DEFAULTS.pool, n = GEN_DEFAULTS.n } = {}) {
    const s = seed >>> 0;
    const config = makeEcologyConfig(pool);
    const founders = makeFounders(n, pool, s);
    const food = makeFood(n * 4, pool, (s + 1) >>> 0);
    const world = new World(config, s);                          // mixed-live (default)
    for (let i = 0; i < n; i++) { const f = founders[i]; world.loadSwimbot(i, { age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy, genes: f.genes }); }
    for (let i = 0; i < food.length; i++) world.loadFood(i, { x: food[i].x, y: food[i].y, type: food[i].type, energy: food[i].energy });
    world.setObstacle(OBSTACLE[0], OBSTACLE[1]);
    return { world, config };
}

// Minimal stats until the shared species/analysis module lands (D2); run-db is agnostic to the stats shape.
function computeStats(world, tick) {
    return { tick, pop: world.getLivingSwimbotCount(), food: world.getLivingFoodCount() };
}

// Generate a full run to `path`. Returns a small summary. `onProgress(tick, frontier)` optional (utilityProcess
// posts progress to main from here in Phase 6).
export function generateRun(path, seed, opts = {}) {
    const o = { ...GEN_DEFAULTS, ...opts };
    const { world, config } = buildWorld(seed, o);
    const writer = openRunWriter(path, {
        seed: seed >>> 0, config,
        keyframeInterval: o.keyframeInterval, statsInterval: o.statsInterval,
        engineVersion: o.engineVersion ?? null, perceptionMode: 'mixed-live',
    });
    // throttle the per-tick 'tick' event (N5); births/deaths/eats always pass through.
    world._onEvent = (e) => { if (e.type === 'tick' && (e.tick % o.tickThrottle) !== 0) return; writer.onEvent(e); };

    let keyframes = 0;
    writer.writeKeyframe(0, world.serialize(), computeStats(world, 0)); keyframes++;   // keyframe-0 = seeded state (D8)
    for (let t = 1; t <= o.ticks; t++) {
        world.tick();
        if (t % o.keyframeInterval === 0) { writer.writeKeyframe(t, world.serialize(), computeStats(world, t)); keyframes++; if (o.onProgress) o.onProgress(t, t); }
        else if (t % o.statsInterval === 0) { writer.writeStats(t, computeStats(world, t)); if (o.onProgress) o.onProgress(t, t); }
    }
    writer.finish();
    writer.close();
    return { path, seed: seed >>> 0, ticks: o.ticks, keyframes, finalPop: world.getLivingSwimbotCount() };
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
    mkdirSync(dirname(out), { recursive: true });
    const t0 = Date.now();
    const r = generateRun(out, seed, opts);
    const dt = (Date.now() - t0) / 1000;
    console.log(`generated ${r.path}: seed=${r.seed} ticks=${r.ticks} keyframes=${r.keyframes} finalPop=${r.finalPop} in ${dt.toFixed(1)}s (${(r.ticks / dt).toFixed(0)} t/s)`);
}
