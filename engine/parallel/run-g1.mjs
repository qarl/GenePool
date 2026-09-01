// PRODUCTIONIZE G1 — the bit-identity gate. The worker-parallel engine (W=1) must produce EXACTLY the same
// living population as the single-thread world.js SNAPSHOT-mode tick, from the same seed/founders/food/config,
// over a full-ecology run (forage + eat + mate + reproduce + die + regen). If W=1 == world.js, the parallel
// replica faithfully reproduces the engine; combined with the G2 determinism gate (coop-W == coop-1), the
// parallel mode is proven correct.
//
// Usage: node engine/parallel/run-g1.mjs [N] [ticks] [pool]

import { createHash } from 'node:crypto';
import { World } from '../world.js';
import { runParallel } from './run.mjs';
import { makeEcologyConfig, makeFounders, makeWallFounders, makeFood, MASTER_SEED, OBSTACLE } from './common.mjs';

const N = Number(process.argv[2] || 1500);
const ticks = Number(process.argv[3] || 300);
const pool = Number(process.argv[4] || 8000);

const config = makeEcologyConfig(pool);
const founders = makeFounders(N, pool);
const food = makeFood(N * 4, pool);

// Canonical fingerprint of living swimbots (sorted by id), field-for-field identical to Partition.fingerprint.
function hashWorld(world) {
    const fp = world.dumpSwimbots()
        .sort((a, b) => a.id - b.id)
        .map(s => `${s.id}:${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.brainState}`);
    return { hash: createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16), living: fp.length };
}

// Single-thread world.js in SNAPSHOT mode (the order-independent tick the parallel executor replicates).
function runEngine(cfg, fnd, fd, nBots, nTicks) {
    const world = new World({ ...cfg, perceptionMode: 'snapshot' }, MASTER_SEED);
    for (let i = 0; i < nBots; i++) { const f = fnd[i]; world.loadSwimbot(i, { age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy, genes: f.genes }); }
    for (let i = 0; i < fd.length; i++) world.loadFood(i, { x: fd[i].x, y: fd[i].y, type: fd[i].type, energy: fd[i].energy });
    world.setObstacle(OBSTACLE[0], OBSTACLE[1]);
    const t0 = performance.now();
    for (let t = 0; t < nTicks; t++) world.tick();
    const ms = performance.now() - t0;
    return { ...hashWorld(world), tps: Math.round(nTicks / (ms / 1000)) };
}

const W = Number(process.argv[5] || 8);
console.log(`\nG1 bit-identity: parallel vs world.js snapshot  (N=${N}, ticks=${ticks}, pool=${pool}, full ecology)`);
const eng = runEngine(config, founders, food, N, ticks);
console.log(`  world.js snapshot (1 thread): ${String(eng.tps).padStart(6)} tps   hash=${eng.hash}   living=${eng.living}`);
const par1 = await runParallel(N, ticks, 1, pool, founders, config, food, 0); // warmup=0 -> exactly `ticks` ticks
console.log(`  parallel W=1:                 ${String(par1.tps).padStart(6)} tps   hash=${par1.hash}   ${par1.hash === eng.hash ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
const parW = await runParallel(N, ticks, W, pool, founders, config, food, 0);
console.log(`  parallel W=${W}:                 ${String(parW.tps).padStart(6)} tps   hash=${parW.hash}   ${parW.hash === eng.hash ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
console.log(`  G1+G2: ${par1.hash === eng.hash && parW.hash === eng.hash ? `parallel is BIT-IDENTICAL to world.js at W=1 AND W=${W} ✓✓` : 'FAILED ✗'}`);

// WALL-HUGGING G1: founders packed at the edges -> genitals at/past walls -> exercises the coop grid's
// clamp/skip edges. coop must STILL be bit-identical to world.js here (the clamp regression check).
const wPool = 2500, wN = Math.min(N, 1500), wTicks = 250;
const wCfg = makeEcologyConfig(wPool), wFnd = makeWallFounders(wN, wPool), wFd = makeFood(wN * 4, wPool);
const wEng = runEngine(wCfg, wFnd, wFd, wN, wTicks);
const wPar = await runParallel(wN, wTicks, Math.min(W, 6), wPool, wFnd, wCfg, wFd, 0);
console.log(`  wall-hugging G1 (N=${wN}, pool=${wPool}): coop ${wPar.hash === wEng.hash ? 'BIT-IDENTICAL to world.js at the walls ✓' : 'DIVERGED AT WALLS ✗'}`);
