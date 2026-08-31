// FOOD-GROW GATE — the food SoA + food grid grow-on-near-full must be BIT-IDENTICAL to world.js. Food ids are
// never reused; the SoA was a fixed ceiling, so a run longer than its static headroom stopped regenerating (SKIP a
// regen) while world.js's unbounded food kept spawning -> divergence. Food-grow doubles the food SoA + food grid
// between ticks (workers parked), copies the persistent food SoA + the static grid scatter, rebinds every worker --
// keeping food-id==slot, so the id-keyed fingerprint is unchanged. This gate forces food-grows (tiny initialMaxFood)
// and asserts bit-identity to world.js at W=1 AND W=8, for a NATURAL food-grow, a forced food-grow CHAIN, and a
// SIMULTANEOUS swimbot+food grow (both buffers in one handshake message). Same seed/founders/food/config as run-g1.
//
// Usage: node tools/parallel/spike/run-foodgrow.mjs [N] [ticks] [pool] [W]

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
const initialMaxFood = food.length + 4; // just above the founders' food -> regen fills it fast, forcing food-grows

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
const line = (label, r, ref) => console.log(`  ${label.padEnd(14)}: hash=${r.hash}  botGrows=${r.grows} foodGrows=${r.foodGrows}  maxFood ${initialMaxFood}->${r.finalMaxFood}   ${r.hash === ref ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);

console.log(`\nFOOD-GROW gate: parallel (food grow-on-near-full) vs world.js snapshot  (N=${N}, ticks=${ticks}, pool=${pool})`);
console.log(`  initialMaxFood=${initialMaxFood} (=founders' food + 4; forces food-grows). regenPeriod=${config.foodRegenerationPeriod}`);
const eng = runEngine(config, founders, food, N, ticks);
console.log(`  world.js snapshot:   hash=${eng.hash}   living=${eng.living}`);

// 1) NATURAL food-grow (regen fills the tiny SoA).
const nat1 = await runParallel(N, ticks, 1, pool, founders, config, food, 0, 0, 0, initialMaxFood);
const natW = await runParallel(N, ticks, W, pool, founders, config, food, 0, 0, 0, initialMaxFood);
console.log(`\n  Natural food-grow:`);
line('W=1', nat1, eng.hash); line(`W=${W}`, natW, eng.hash);
const natOk = nat1.hash === eng.hash && natW.hash === eng.hash && nat1.foodGrows > 0 && nat1.finalMaxFood > initialMaxFood;

// 2) Forced food-grow CHAIN (short run so doubling doesn't OOM) -- the 2nd..Nth grow copy from the already-grown
//    food SoA (a distinct path). 3) SIMULTANEOUS swimbot+food grow -- one handshake carries both buffer sets.
const cTicks = 48, every = 8, imb = 2 * N + 4;
const cEng = runEngine(config, founders, food, N, cTicks);
const chain1 = await runParallel(N, cTicks, 1, pool, founders, config, food, 0, 0, 0, initialMaxFood, every);
const chainW = await runParallel(N, cTicks, W, pool, founders, config, food, 0, 0, 0, initialMaxFood, every);
const both1 = await runParallel(N, cTicks, 1, pool, founders, config, food, 0, imb, every, initialMaxFood, every);
const bothW = await runParallel(N, cTicks, W, pool, founders, config, food, 0, imb, every, initialMaxFood, every);
console.log(`\n  Forced food chain (${cTicks} ticks, every ${every}):   world.js hash=${cEng.hash}`);
line('W=1', chain1, cEng.hash); line(`W=${W}`, chainW, cEng.hash);
console.log(`  Simultaneous swimbot+food grow (one handshake):`);
line('W=1', both1, cEng.hash); line(`W=${W}`, bothW, cEng.hash);
const chainOk = chain1.hash === cEng.hash && chainW.hash === cEng.hash && chain1.foodGrows >= 3;
const bothOk = both1.hash === cEng.hash && bothW.hash === cEng.hash && both1.grows >= 3 && both1.foodGrows >= 3;

const pass = natOk && chainOk && bothOk;
console.log(`\n  ${pass ? `FOOD-GROW is BIT-IDENTICAL to world.js at W=1 AND W=${W} — natural, a ${chain1.foodGrows}-grow chain, AND simultaneous with swimbot grow ✓✓` : 'FAILED ✗'}`);
process.exit(pass ? 0 : 1);
