// API GATE — the first-class `runPoolParallel({config, seed, founders, food, workers, ticks})` must be BIT-IDENTICAL
// to single-thread world.js snapshot mode for the SAME inputs, for ARBITRARY seed + obstacle (not just the fixed
// MASTER_SEED/OBSTACLE that run-g1 bakes in). This proves the seed + obstacle threading and the config-resolve are
// correct, at W=1 AND W=8, with a single obstacle, with NO obstacle, and from a MINIMAL config.
//
// Usage: node tools/parallel/spike/run-api.mjs

import { createHash } from 'node:crypto';
import { World } from '../../../engine/world.js';
import { runPoolParallel } from './run.mjs';
import { makeEcologyConfig, makeFounders, makeFood } from './common.mjs';

function hashWorld(world) {
    const fp = world.dumpSwimbots()
        .sort((a, b) => a.id - b.id)
        .map(s => `${s.id}:${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.brainState}`);
    return createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16);
}
function runEngine(config, seed, founders, food, ticks) {
    const world = new World({ ...config, perceptionMode: 'snapshot' }, seed);
    for (let i = 0; i < founders.length; i++) { const f = founders[i]; world.loadSwimbot(i, { age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy, genes: f.genes }); }
    for (let i = 0; i < food.length; i++) world.loadFood(i, { x: food[i].x, y: food[i].y, type: food[i].type, energy: food[i].energy });
    for (let t = 0; t < ticks; t++) world.tick();
    return hashWorld(world);
}

const N = 1500, ticks = 200, pool = 8000;
const founders = makeFounders(N, pool), food = makeFood(N * 4, pool);
let allOk = true;
const check = (label, cfg, seed, fnd = founders, fd = food) => async () => {
    const eng = runEngine(cfg, seed, fnd, fd, ticks);
    const a1 = await runPoolParallel({ config: cfg, seed, founders: fnd, food: fd, workers: 1, ticks });
    const aW = await runPoolParallel({ config: cfg, seed, founders: fnd, food: fd, workers: 8, ticks });
    const ok = a1.hash === eng && aW.hash === eng;
    allOk = allOk && ok;
    console.log(`  ${label.padEnd(34)}: world=${eng} api W1=${a1.hash} W8=${aW.hash}  ${ok ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
};

console.log(`\nAPI gate: runPoolParallel vs world.js snapshot  (N=${N}, ticks=${ticks}, pool=${pool})`);
// non-default seed + a single obstacle at coords that are NOT common.mjs's default OBSTACLE (so an ignored
// obstacle param -- defaulting to OBSTACLE -- would DIVERGE and be caught).
await check('single obstacle (non-default coords)', { ...makeEcologyConfig(pool), obstacles: [{ a: { x: 900, y: 3200 }, b: { x: 1600, y: 3200 } }] }, 12345)();
// a single obstacle near the wall of a NON-DEFAULT (smaller) pool -> exercises config-pool endpoint clamping
// (the spike obstacle now gets setPoolBounds(config.pool)).
await check('obstacle near wall, pool 2500', { ...makeEcologyConfig(2500), obstacles: [{ a: { x: 2495, y: 100 }, b: { x: 2495, y: 2400 } }] }, 91, makeFounders(N, 2500), makeFood(N * 4, 2500))();
// no obstacle at all (empty field)
await check('no obstacle, seed 777', makeEcologyConfig(pool), 777)();
// a MINIMAL config: only pool -> resolveWorldConfig fills the rest identically on both paths
await check('minimal config {pool}, seed 42', { pool: { left: 0, top: 0, right: pool, bottom: pool } }, 42)();

// NEGATIVE paths: runPoolParallel must LOUDLY REJECT every world it can't reproduce (not silently diverge).
console.log(`\n  rejects unsupported configs:`);
let rejOk = true;
const mustReject = async (label, cfg) => {
    let threw = false;
    try { await runPoolParallel({ config: cfg, seed: 1, founders, food, workers: 1, ticks: 5 }); }
    catch { threw = true; }
    rejOk = rejOk && threw;
    console.log(`  ${label.padEnd(34)}: ${threw ? 'REJECTED ✓' : 'ACCEPTED (should have thrown) ✗'}`);
};
await mustReject('torus topology', { ...makeEcologyConfig(pool), topology: 'torus' });
await mustReject('numFoodTypes: 2', { ...makeEcologyConfig(pool), numFoodTypes: 2 });
await mustReject('two obstacles', { ...makeEcologyConfig(pool), obstacles: [{ a: { x: 40, y: 40 }, b: { x: 80, y: 40 } }, { a: { x: 200, y: 200 }, b: { x: 400, y: 200 } }] });
await mustReject('non-default thickness', { ...makeEcologyConfig(pool), obstacles: [{ a: { x: 40, y: 40 }, b: { x: 80, y: 40 }, thickness: 60 }] });
await mustReject('masked (vision-off) obstacle', { ...makeEcologyConfig(pool), obstacles: [{ a: { x: 40, y: 40 }, b: { x: 80, y: 40 }, mask: { movement: true, vision: false } }] });
await mustReject('a §10 schedule', { ...makeEcologyConfig(pool), foodRegenerationPeriod: { schedule: [[0, 20], [100, 40]] } });

const pass = allOk && rejOk;
console.log(`\n  ${pass ? 'runPoolParallel is BIT-IDENTICAL to world.js (arbitrary seed/obstacle/pool, W=1 & W=8) AND rejects everything it cannot model ✓✓' : 'FAILED ✗'}`);
process.exit(pass ? 0 : 1);
