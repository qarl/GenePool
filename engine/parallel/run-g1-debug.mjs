// G1 debugger: drive a single-thread Partition (W=1) through its phases IN-PROCESS (no workers) alongside
// world.js snapshot mode, comparing living-bot fingerprints EACH tick to find the FIRST divergence + the exact
// bot/field. Usage: node engine/parallel/run-g1-debug.mjs [N] [ticks] [pool]

import { World } from '../world.js';
import { Genotype } from '../genotype.js';
import { makeFrozenBuffer } from './frozen-layout.mjs';
import { setupFood } from './food-layout.mjs';
import { makePostUpdateBuffer, makeResolutionBuffers } from './resolution-layout.mjs';
import { allocCoopGrid, CoopGrid } from './coop-grid.mjs';
import { Partition } from './partition.mjs';
import { makeEcologyConfig, makeFounders, makeFood, MASTER_SEED, OBSTACLE } from './common.mjs';

const N = Number(process.argv[2] || 1500);
const ticks = Number(process.argv[3] || 300);
const pool = Number(process.argv[4] || 8000);
const NUM_GENES = 256;

const config = makeEcologyConfig(pool);
const founders = makeFounders(N, pool);
const food = makeFood(N * 4, pool);

// world.js snapshot
const world = new World({ ...config, perceptionMode: 'snapshot' }, MASTER_SEED);
for (let i = 0; i < N; i++) { const f = founders[i]; world.loadSwimbot(i, { age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy, genes: f.genes }); }
for (let i = 0; i < food.length; i++) world.loadFood(i, { x: food[i].x, y: food[i].y, type: food[i].type, energy: food[i].energy });
world.setObstacle(OBSTACLE[0], OBSTACLE[1]);

// single-thread Partition W=1 (drive phases directly, no barriers)
const maxBots = N * 8;
const maxFood = food.length + Math.ceil((ticks + 100) / (config.foodRegenerationPeriod || 20)) + 16;
const f64 = new Float64Array(makeFrozenBuffer(maxBots));
const coopGrid = new CoopGrid(allocCoopGrid(config.pool, 300, maxBots));
const fs = setupFood(food, config.pool, 300, maxFood);
const puF64 = new Float64Array(makePostUpdateBuffer(maxBots));
const rb = makeResolutionBuffers(maxBots, NUM_GENES);
const res = {
    wantsEat: new Int32Array(rb.wantsEatSab), wantsMate: new Int32Array(rb.wantsMateSab),
    resolvedEnergy: new Float64Array(rb.resolvedEnergySab), numFoodEatenDelta: new Int32Array(rb.numFoodEatenDeltaSab),
    numOffspringDelta: new Int32Array(rb.numOffspringDeltaSab), flags: new Int32Array(rb.flagsSab),
    genome: new Uint8Array(rb.genomeSab), newbornCount: new Int32Array(rb.newbornCountSab), newbornRec: new Float64Array(rb.newbornRecSab),
};
res.wantsEat.fill(-1); res.wantsMate.fill(-1);
const part = new Partition(f64, maxBots, MASTER_SEED, config, founders, 0, N, OBSTACLE, coopGrid, 0, 1, fs.foodGrid, fs.foodF64, fs.numFood, puF64, res, N);

function worldFP() {
    const m = new Map();
    for (const s of world.dumpSwimbots()) m.set(s.id, `${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.brainState},${s.chosenMate}`);
    return m;
}
function partFP() {
    const m = new Map();
    for (const sb of part._bots) {
        if (!sb.getAlive()) continue;
        const p = sb.getPosition();
        m.set(sb.getIndex(), `${p.x},${p.y},${sb.getAngle()},${sb.getEnergy()},${sb.getAge()},${sb.getNumOffspring()},${sb.getNumFoodBitsEaten()},${sb.getBrainState()},${sb.getChosenMateIndex()}`);
    }
    return m;
}
const FIELDS = ['x', 'y', 'angle', 'energy', 'age', 'numOffspring', 'numFoodBitsEaten', 'brainState', 'chosenMate'];

// The parallel applies tick T's resolution at the START of T+1 (applyDeltas), so its bot state lags world.js by
// one resolve. Compare with a one-tick OFFSET: parallel-state-right-after-applyDeltas(T) == world-after-(T-1).
let prevWorld = worldFP(); // world after tick 0 (initial)
for (let t = 1; t <= ticks; t++) {
    part.applyDeltas(); // applies (t-1)'s resolve + constructs (t-1)'s newborns -> parallel now == world-after-(t-1)
    const w = prevWorld, p = partFP();
    if (w.size !== p.size || [...w].some(([id, v]) => p.get(id) !== v)) {
        console.log(`\nDIVERGED comparing world-after-${t - 1} vs parallel: world living=${w.size}, parallel living=${p.size}`);
        let shown = 0;
        const F_ALIVE = 0, F_GX = 3, STRIDE = 11, PU_STRIDE = 4, PU_ALIVE = 0;
        for (const [id, wv] of w) {
            const pv = p.get(id);
            if (pv === wv) continue;
            if (pv === undefined) { console.log(`  bot ${id}: in world, MISSING in parallel`); if (++shown >= 8) break; continue; }
            const wa = wv.split(','), pa = pv.split(',');
            const diffs = FIELDS.map((f, i) => wa[i] !== pa[i] ? `${f}: world=${wa[i]} par=${pa[i]}` : null).filter(Boolean);
            console.log(`  bot ${id}: ${diffs.join('; ')}`);
            // If numOffspring diverged, probe the parallel birth-gate inputs for this bot.
            if (wa[5] !== pa[5]) {
                const mateId = res.wantsMate[id];
                const puAlive = part._puF64[id * PU_STRIDE + PU_ALIVE];
                console.log(`      [probe] wantsMate[${id}]=${mateId} puAlive=${puAlive}` +
                    (mateId >= 0 ? ` | frozenAlive[mate ${mateId}]=${f64[mateId * STRIDE + F_ALIVE]} junkSim=${part._junkDnaSimilarity(id, mateId).toFixed(4)} (limit ${'0.9'})` : ''));
            }
            if (++shown >= 8) break;
        }
        for (const [id] of p) if (!w.has(id)) { console.log(`  bot ${id}: in parallel, MISSING in world`); break; }
        process.exit(0);
    }
    part.zeroGridCells(); part.writeAndCount(); part.prefix(); part.scatter(); part.updatePerceive(t); part.resolve(t);
    world.tick();
    prevWorld = worldFP(); // world after tick t
}
console.log(`\nNO DIVERGENCE over ${ticks} ticks -- parallel W=1 == world.js snapshot, tick for tick. ✓`);
