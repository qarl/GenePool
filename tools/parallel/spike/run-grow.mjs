// GROW GATE — the grow-on-near-full SABs must be BIT-IDENTICAL to the no-grow path (and thus to world.js). A long
// run mints more lifetime ids than the initial buffer holds; before grow, worker 0's minting clamped at maxBots
// (stalling births -> diverging from world.js). Grow doubles the swimbot SABs between ticks (workers parked),
// copies the two cross-tick carriers, rebinds every worker, and continues -- keeping slot==id, so the id-keyed
// fingerprint is unchanged. This gate FORCES several grows (tiny initialMaxBots) and asserts the fingerprint still
// matches world.js at W=1 AND W=8. Same seed/founders/food/config as run-g1 -> the same world.js reference.
//
// Usage: node tools/parallel/spike/run-grow.mjs [N] [ticks] [pool] [W]

import { createHash } from 'node:crypto';
import { World } from '../../../engine/world.js';
import { runParallel } from './run.mjs';
import { makeEcologyConfig, makeFounders, makeFood, MASTER_SEED, OBSTACLE } from './common.mjs';

const N = Number(process.argv[2] || 1500);
const ticks = Number(process.argv[3] || 300);
const pool = Number(process.argv[4] || 8000);
const W = Number(process.argv[5] || 8);

const config = makeEcologyConfig(pool);
const founders = makeFounders(N, pool);
const food = makeFood(N * 4, pool);

// initialMaxBots just above 2N: keeps tick 1 safe (nextId=N < maxBots/2), then forces repeated grows as births
// push the lifetime id count past it. The default (N*8) would never grow on this run -> this is the point of the gate.
const initialMaxBots = 2 * N + 4;

function hashWorld(world) {
    const fp = world.dumpSwimbots()
        .sort((a, b) => a.id - b.id)
        .map(s => `${s.id}:${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.brainState}`);
    return { hash: createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16), living: fp.length };
}

function runEngine(cfg, fnd, fd, nBots, nTicks) {
    const world = new World({ ...cfg, perceptionMode: 'snapshot' }, MASTER_SEED);
    for (let i = 0; i < nBots; i++) { const f = fnd[i]; world.loadSwimbot(i, { age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy, genes: f.genes }); }
    for (let i = 0; i < fd.length; i++) world.loadFood(i, { x: fd[i].x, y: fd[i].y, type: fd[i].type, energy: fd[i].energy });
    world.setObstacle(OBSTACLE[0], OBSTACLE[1]);
    for (let t = 0; t < nTicks; t++) world.tick();
    return hashWorld(world);
}

console.log(`\nGROW gate: parallel (grow-on-near-full) vs world.js snapshot  (N=${N}, ticks=${ticks}, pool=${pool})`);
console.log(`  initialMaxBots=${initialMaxBots} (=2N+4; forces grows). Default would be N*8=${N * 8} (no grow).`);

const eng = runEngine(config, founders, food, N, ticks);
console.log(`  world.js snapshot:   hash=${eng.hash}   living=${eng.living}`);

const par1 = await runParallel(N, ticks, 1, pool, founders, config, food, 0, initialMaxBots);
const g1ok = par1.hash === eng.hash;
console.log(`  parallel W=1:        hash=${par1.hash}   grows=${par1.grows}  maxBots ${initialMaxBots}->${par1.finalMaxBots}   ${g1ok ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);

const parW = await runParallel(N, ticks, W, pool, founders, config, food, 0, initialMaxBots);
const gWok = parW.hash === eng.hash;
console.log(`  parallel W=${W}:        hash=${parW.hash}   grows=${parW.grows}  maxBots ${initialMaxBots}->${parW.finalMaxBots}   ${gWok ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);

const grew = par1.grows > 0 && parW.grows > 0;
const natOk = g1ok && gWok && grew && par1.finalMaxBots > initialMaxBots;

// MULTI-GROW CHAIN: force a grow every few ticks so the 2nd..Nth grow (which copy from the ALREADY-GROWN buffers,
// a distinct path from the first) are exercised, at W=1 and W=8, both still bit-identical to world.js. Uses a SHORT
// run with its own reference -- each grow DOUBLES the buffers, so forcing many over a long run would OOM.
const chainTicks = 48, growEvery = 8; // -> 6 grows: 3004 * 2^6 = ~192k slots
console.log(`\n  Multi-grow chain (${chainTicks} ticks, forceGrowEvery=${growEvery}):`);
const chainEng = runEngine(config, founders, food, N, chainTicks);
const chain1 = await runParallel(N, chainTicks, 1, pool, founders, config, food, 0, initialMaxBots, growEvery);
const chainW = await runParallel(N, chainTicks, W, pool, founders, config, food, 0, initialMaxBots, growEvery);
const c1ok = chain1.hash === chainEng.hash, cWok = chainW.hash === chainEng.hash;
console.log(`  world.js snapshot:   hash=${chainEng.hash}   living=${chainEng.living}`);
console.log(`  parallel W=1:        hash=${chain1.hash}   grows=${chain1.grows}  maxBots ${initialMaxBots}->${chain1.finalMaxBots}   ${c1ok ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
console.log(`  parallel W=${W}:        hash=${chainW.hash}   grows=${chainW.grows}  maxBots ${initialMaxBots}->${chainW.finalMaxBots}   ${cWok ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
const chainOk = c1ok && cWok && chain1.grows >= 3;

const pass = natOk && chainOk;
console.log(`\n  ${!grew ? 'NO GROW TRIGGERED — increase ticks (gate did not exercise grow) ✗'
    : pass ? `GROW is BIT-IDENTICAL to world.js at W=1 AND W=${W} — natural (${par1.grows} grow) AND a forced ${chain1.grows}-grow chain ✓✓`
    : 'FAILED ✗'}`);
process.exit(pass ? 0 : 1);
