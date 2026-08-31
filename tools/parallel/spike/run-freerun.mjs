// Node driver for the FREE-RUN parallel path (the headless twin of what viewer-parallel.html does in the browser):
// workers self-advance ticks with no per-tick main handshake; main only starts them (CTL_RUN), reacts to grow
// requests, and collects the final fingerprint. This exists so the free-run loop -- previously browser-only and
// untested -- has a headless BIT-IDENTITY gate (run-freerun-g1.mjs), and so free-run GROW is proven in Node before
// the browser inherits it. maxTicks stops every worker at the same tick for a deterministic fingerprint.

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeFrozenBuffer } from './frozen-layout.mjs';
import { setupFood } from './food-layout.mjs';
import { makePostUpdateBuffer, makeResolutionBuffers } from './resolution-layout.mjs';
import { allocCoopGrid } from './coop-grid.mjs';
import { growSwimbotBuffers, growFoodBuffers } from './grow-buffers.mjs';
import { CTL_RUN, CTL_SHUTDOWN, CTL_NEXTID, CTL_NEXTFOODID, CTL_SIZE } from './barrier.mjs';
import { MASTER_SEED, OBSTACLE } from './common.mjs';

const NUM_GENES = 256;
const HERE = dirname(fileURLToPath(import.meta.url));
const CELL_SIZE = 300;

export async function runFreeRun(N, ticks, W, poolSize, founders, config, food, initialMaxBots = 0, initialMaxFood = 0) {
    let maxBots = initialMaxBots || N * 8;
    let frozenSab = makeFrozenBuffer(maxBots);
    const gridSpec = allocCoopGrid(config.pool, CELL_SIZE, maxBots); // count/start/cursor pool-sized; only botIds grows
    let maxFood = initialMaxFood || (food.length + Math.ceil((ticks + 100) / (config.foodRegenerationPeriod || 20)) + 16);
    let { foodSab, foodGridSpec, numFood } = setupFood(food, config.pool, CELL_SIZE, maxFood);
    let puSab = makePostUpdateBuffer(maxBots);
    let resSabs = makeResolutionBuffers(maxBots, NUM_GENES);
    new Int32Array(resSabs.wantsEatSab).fill(-1);
    new Int32Array(resSabs.wantsMateSab).fill(-1);
    const ctrlSab = new SharedArrayBuffer(CTL_SIZE * Int32Array.BYTES_PER_ELEMENT);
    const ctrl = new Int32Array(ctrlSab);

    const chunk = Math.ceil(N / W);
    const workers = [];
    const fingerprints = new Map();
    let readyCount = 0, onReady, onDone;
    const ready = new Promise(r => { onReady = r; });
    const done = new Promise(r => { onDone = r; });
    let growCount = 0, foodGrowCount = 0;

    // main-side grow (mirrors run.mjs maybeGrow, but triggered by worker 0's 'grow-ready' instead of a tick barrier).
    // All workers are past the B6 grow barrier and spin-waiting for the new SABs, so the copy source is stable.
    const doGrow = () => {
        const growBots = Atomics.load(ctrl, CTL_NEXTID) >= (maxBots >> 1);
        const growFood = Atomics.load(ctrl, CTL_NEXTFOODID) >= maxFood - 2;
        const msg = { type: 'grow' };
        let botG, foodG;
        if (growBots) { botG = growSwimbotBuffers(frozenSab, resSabs, maxBots * 2); Object.assign(msg, botG); }
        if (growFood) { foodG = growFoodBuffers(foodSab, foodGridSpec.botIdsSab, maxFood * 2); Object.assign(msg, foodG); }
        for (const w of workers) w.postMessage(msg);
        if (growBots) { maxBots = botG.maxBots; frozenSab = botG.frozenSab; puSab = botG.puSab; resSabs = botG.resSabs; growCount++; }
        if (growFood) { maxFood = foodG.maxFood; foodSab = foodG.foodSab; foodGridSpec = { ...foodGridSpec, botIdsSab: foodG.foodBotIdsSab, N: foodG.maxFood }; foodGrowCount++; }
    };

    for (let w = 0; w < W; w++) {
        const idStart = w * chunk, idEnd = Math.min(N, (w + 1) * chunk);
        const worker = new Worker(join(HERE, 'worker-freerun.mjs'), {
            workerData: {
                frozenSab, ctrlSab, gridSpec, maxBots, masterSeed: MASTER_SEED, config,
                founders: founders.slice(idStart, idEnd), idStart, idEnd, obstacle: OBSTACLE, W, workerIndex: w,
                foodGridSpec, foodSab, numFood, puSab, resSabs, numFounders: N, maxTicks: ticks,
            },
        });
        worker.on('message', (m) => {
            if (m.type === 'ready') { if (++readyCount === W) onReady(); }
            else if (m.type === 'grow-ready') doGrow();
            else if (m.type === 'fingerprint') { fingerprints.set(m.idStart, m.fp); if (fingerprints.size === W) onDone(); }
        });
        worker.on('error', (e) => { console.error('freerun worker error', e); process.exit(1); });
        workers.push(worker);
    }
    await ready;

    const t0 = performance.now();
    Atomics.store(ctrl, CTL_RUN, 1); Atomics.notify(ctrl, CTL_RUN); // release the free-running workers
    await done;                                                     // they stop themselves at maxTicks + fingerprint
    const ms = performance.now() - t0;
    Atomics.store(ctrl, CTL_SHUTDOWN, 1);                          // any worker still parked (shouldn't be) exits
    await Promise.all(workers.map(w => w.terminate()));

    const fp = [];
    for (let w = 0; w < W; w++) fp.push(...fingerprints.get(w * chunk));
    fp.sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]));
    const hash = createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16);
    return { ms, tps: Math.round(ticks / (ms / 1000)), hash, totalBots: fp.length, grows: growCount, foodGrows: foodGrowCount, finalMaxBots: maxBots, finalMaxFood: maxFood };
}
