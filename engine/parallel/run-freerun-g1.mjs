// FREE-RUN bit-identity gate. The free-run path (workers self-advance ticks, no per-tick main handshake -- what the
// browser viewer runs) had NO headless test: every prior gate drives the HANDSHAKE worker (worker.mjs). This runs
// the SHARED freeRunLoop headlessly (worker-freerun.mjs) and asserts it is BIT-IDENTICAL to world.js at W=1 and W=8,
// (a) with no grow, and (b) forcing swimbot AND food grows (tiny initial ceilings) -- proving free-run GROW before
// the browser inherits it. Same seed/founders/food/config as run-g1 -> the same world.js reference.
//
// Usage: node engine/parallel/run-freerun-g1.mjs [N] [ticks] [pool] [W]

import { createHash } from 'node:crypto';
import { World } from '../world.js';
import { runFreeRun } from './run-freerun.mjs';
import { makeEcologyConfig, makeFounders, makeFood, MASTER_SEED, OBSTACLE } from './common.mjs';

const N = Number(process.argv[2] || 1500);
const ticks = Number(process.argv[3] || 300);
const pool = Number(process.argv[4] || 8000);
const W = Number(process.argv[5] || 8);

const config = makeEcologyConfig(pool);
const founders = makeFounders(N, pool);
const food = makeFood(N * 4, pool);

function hashWorld(world) {
    const fp = world.dumpSwimbots()
        .sort((a, b) => a.id - b.id)
        .map(s => `${s.id}:${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.brainState}`);
    return { hash: createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16), living: fp.length };
}
function runEngine(nTicks) {
    const world = new World({ ...config, perceptionMode: 'snapshot' }, MASTER_SEED);
    for (let i = 0; i < N; i++) { const f = founders[i]; world.loadSwimbot(i, { age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy, genes: f.genes }); }
    for (let i = 0; i < food.length; i++) world.loadFood(i, { x: food[i].x, y: food[i].y, type: food[i].type, energy: food[i].energy });
    world.setObstacle(OBSTACLE[0], OBSTACLE[1]);
    for (let t = 0; t < nTicks; t++) world.tick();
    return hashWorld(world);
}

console.log(`\nFREE-RUN bit-identity: self-advancing workers vs world.js snapshot  (N=${N}, ticks=${ticks}, pool=${pool})`);
const eng = runEngine(ticks);
console.log(`  world.js snapshot:   hash=${eng.hash}   living=${eng.living}`);

// (a) no grow -- generous ceilings so free-run runs straight through.
const fr1 = await runFreeRun(N, ticks, 1, pool, founders, config, food);
const frW = await runFreeRun(N, ticks, W, pool, founders, config, food);
const noGrowOk = fr1.hash === eng.hash && frW.hash === eng.hash;
console.log(`\n  No grow:`);
console.log(`  free-run W=1:        hash=${fr1.hash}   ${fr1.hash === eng.hash ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
console.log(`  free-run W=${W}:        hash=${frW.hash}   ${frW.hash === eng.hash ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);

// (b) forced grows -- tiny swimbot + food ceilings so both grow mid-run (worker-side trigger, main-side allocate).
const imb = 2 * N + 4, imf = food.length + 4;
const g1 = await runFreeRun(N, ticks, 1, pool, founders, config, food, imb, imf);
const gW = await runFreeRun(N, ticks, W, pool, founders, config, food, imb, imf);
const growOk = g1.hash === eng.hash && gW.hash === eng.hash && g1.grows > 0 && g1.foodGrows > 0;
console.log(`\n  Grow (initialMaxBots=${imb}, initialMaxFood=${imf}):`);
console.log(`  free-run W=1:        hash=${g1.hash}   grows=${g1.grows} foodGrows=${g1.foodGrows}  maxBots->${g1.finalMaxBots} maxFood->${g1.finalMaxFood}   ${g1.hash === eng.hash ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
console.log(`  free-run W=${W}:        hash=${gW.hash}   grows=${gW.grows} foodGrows=${gW.foodGrows}  maxBots->${gW.finalMaxBots} maxFood->${gW.finalMaxFood}   ${gW.hash === eng.hash ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);

const pass = noGrowOk && growOk;
console.log(`\n  ${pass ? `FREE-RUN is BIT-IDENTICAL to world.js at W=1 AND W=${W} — no-grow AND across forced swimbot+food grows ✓✓` : 'FAILED ✗'}`);
process.exit(pass ? 0 : 1);
