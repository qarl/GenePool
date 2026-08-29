'use strict';
// Tick performance benchmark for the headless engine/ (NOT part of `node --test` -- it's a .cjs script, run
// on demand). Measures raw tick throughput across population sizes, spatial-grid on vs off, and a NORMALIZED
// per-swimbot cost (us/tick/swimbot) that exposes scaling: roughly flat => O(n) per tick; rising => O(n^2).
//
//   node test/perf/tick-benchmark.cjs            # default sizes
//   GP_SIZES=100,1000,10000 node test/perf/tick-benchmark.cjs
//
// Pools are seeded with junk-DNA-zeroed founders (JJ's rule -> they interbreed, a realistic live ecology)
// at wide ages (no synchronized die-off), food = 2x swimbots. Population drifts a little over the window, so
// the per-swimbot cost is normalized by the AVERAGE live population actually observed.

const { boot } = require('../helpers/boot');
const { World } = require('../../engine/world.js');
const { Genotype } = require('../../engine/genotype.js');

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};
const POOL = 8000, NUM_GENES = 256, NUM_GENES_USED = 112;
const SIZES = (process.env.GP_SIZES ? process.env.GP_SIZES.split(',').map(Number) : [100, 500, 1000, 2000, 5000]);
const WARMUP = 30;

// mulberry32 for founder genome/placement (its own stream; the engine uses its addressed rng internally).
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// one real canonicalized genome from JJ's seed-42 pool, reused for every founder (behavior is irrelevant to
// tick COST; we only need a valid, decodable genome). Junk DNA is zeroed so founders interbreed.
const baseGenes = Array.from(boot(42).getPoolData().swimbotArray[0].genes);
for (let k = NUM_GENES_USED; k < NUM_GENES; k++) baseGenes[k] = 0;

function build(n, useGrid, seed) {
    const rng = mulberry32(seed);
    const W = new World(CONFIG, seed, { useSpatialGrid: useGrid });
    for (let i = 0; i < n; i++) {
        const g = new Genotype(); g.setGenes(baseGenes);
        W.loadSwimbot(i, { age: Math.floor(rng() * 20000), x: rng() * POOL, y: rng() * POOL, angle: rng() * 360 - 180, energy: 80, genes: g.getGenes() });
    }
    for (let i = 0; i < n * 2; i++) W.loadFood(i, { x: rng() * POOL, y: rng() * POOL, type: 0, energy: 50 });
    W.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });
    return W;
}

function measure(n, useGrid, ticks) {
    const W = build(n, useGrid, 12345);
    for (let i = 0; i < WARMUP; i++) W.tick();
    let popSum = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ticks; i++) { W.tick(); popSum += W.getLivingSwimbotCount(); }
    const ns = Number(process.hrtime.bigint() - t0);
    const avgPop = popSum / ticks;
    const msPerTick = ns / ticks / 1e6;
    return { ticksPerSec: Math.round(1e9 / (ns / ticks)), msPerTick, avgPop, usPerTickPerBot: (ns / ticks / 1e3) / avgPop };
}

console.log(`headless engine tick benchmark  (node ${process.version}, warmup ${WARMUP})\n`);
console.log('  N     grid  |  ticks/sec |  ms/tick | avg pop | us/tick/bot');
console.log('  ------------+------------+----------+---------+------------');
for (const n of SIZES) {
    const ticks = Math.max(120, Math.round(400000 / n)); // more ticks for small pools (stable timing)
    for (const grid of [true, false]) {
        const r = measure(n, grid, ticks);
        console.log(`  ${String(n).padStart(5)}  ${grid ? 'on ' : 'off'}   | ${String(r.ticksPerSec).padStart(10)} | ${r.msPerTick.toFixed(3).padStart(8)} | ${String(Math.round(r.avgPop)).padStart(7)} | ${r.usPerTickPerBot.toFixed(3).padStart(10)}`);
    }
}
console.log('\n(us/tick/bot roughly flat across N => O(n)/tick; grid vs off shows the P2 perception speedup, which grows with N.)');
