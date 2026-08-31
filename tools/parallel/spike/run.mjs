// SPIKE — the parallel driver + correctness/perf A/B for the COOPERATIVE shared-grid version. Spawns W workers
// (each owning an id-range partition; they build ONE shared CSR neighbor grid cooperatively each tick), drives the
// barrier-synced tick loop, and verifies the result is BIT-IDENTICAL to (a) the single-thread JS-grid reference
// [grid impl correct] and (b) coop at W=1 [parallelization deterministic]. Then reports the speedup. Also runs a
// WALL-HUGGING fixture where coop MUST still match the JS grid (the only case that exercises the clamp/skip edges).
//
// Usage: node tools/parallel/spike/run.mjs [N] [ticks] [workers] [pool]
// The engine itself is untouched; this lives entirely in tools/.

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeFrozenBuffer } from './frozen-layout.mjs';
import { setupFood, makeFoodBuffer } from './food-layout.mjs';
import { makePostUpdateBuffer, makeResolutionBuffers } from './resolution-layout.mjs';
import { allocCoopGrid } from './coop-grid.mjs';

const NUM_GENES = 256; // engine genome length (constants.js NUM_GENES) -- for the shared genome SoA
import { CTL_TICKGEN, CTL_TICK, CTL_DONEGEN, CTL_SHUTDOWN, CTL_GROW, CTL_NEXTID, CTL_NEXTFOODID, CTL_SIZE } from './barrier.mjs';
import { makeEcologyConfig, makeFounders, makeFood, MASTER_SEED, OBSTACLE } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CELL_SIZE = 300; // == SWIMBOT_VIEW_RADIUS (config leaves viewRadius default)

export async function runParallel(N, ticks, W, poolSize, founders, config, food, warmup = 50, initialMaxBots = 0, forceGrowEvery = 0, initialMaxFood = 0, forceFoodGrowEvery = 0) {
    // Ids are never reused + monotonic, so the swimbot SABs are sized to a CAPACITY CEILING. That ceiling is no
    // longer a hard wall: worker 0 publishes nextId each tick and main GROWS the SABs (doubling) before nextId
    // reaches maxBots -- so a long run that mints > initialMaxBots lifetime ids keeps going, deterministically,
    // without ever hitting the resolve() minting clamp (which would stall births and diverge from world.js).
    // Slot==id is preserved across a grow (the review-rejected slot RECYCLING is NOT done), so G1/G2 hold.
    // `initialMaxBots` (0 -> default N*8) lets the grow gate start tiny to force grows.
    let maxBots = initialMaxBots || N * 8;
    let frozenSab = makeFrozenBuffer(maxBots);
    const gridSpec = allocCoopGrid(config.pool, CELL_SIZE, maxBots); // count/start/cursor are pool-sized (fixed); only botIds grows on a grow
    // Food SoA + food grid built ONCE; workers reconstruct read-only views. Food ids never reused; the SoA GROWS
    // on near-full (like the swimbots) so a run longer than any static headroom keeps regenerating -- else regen
    // would stop while world.js's unbounded food keeps spawning, diverging. `initialMaxFood` (0 -> sized for `ticks`)
    // lets the grow gate start tiny to force food-grows.
    let maxFood = initialMaxFood || (food.length + Math.ceil((ticks + 100) / (config.foodRegenerationPeriod || 20)) + 16);
    let { foodSab, foodGridSpec, numFood } = setupFood(food, config.pool, CELL_SIZE, maxFood);
    let puSab = makePostUpdateBuffer(maxBots); // post-update SoA (workers publish; worker 0 resolves from it)
    let resSabs = makeResolutionBuffers(maxBots, NUM_GENES);
    new Int32Array(resSabs.wantsEatSab).fill(-1);  // 0 is a valid foodId; -1 = "not eating"
    new Int32Array(resSabs.wantsMateSab).fill(-1);
    const ctrlSab = new SharedArrayBuffer(CTL_SIZE * Int32Array.BYTES_PER_ELEMENT);
    const ctrl = new Int32Array(ctrlSab);

    const chunk = Math.ceil(N / W);
    const workers = [];
    const fingerprints = new Map();
    let readyCount = 0, onReady, onAllFingerprints;
    const ready = new Promise(r => { onReady = r; });
    const dumped = new Promise(r => { onAllFingerprints = r; });

    for (let w = 0; w < W; w++) {
        const idStart = w * chunk;
        const idEnd = Math.min(N, (w + 1) * chunk);
        const worker = new Worker(join(HERE, 'worker.mjs'), {
            workerData: {
                frozenSab, ctrlSab, gridSpec, maxBots, masterSeed: MASTER_SEED, config,
                founders: founders.slice(idStart, idEnd), idStart, idEnd, obstacle: OBSTACLE, W, workerIndex: w,
                foodGridSpec, foodSab, numFood, puSab, resSabs, numFounders: N,
            },
        });
        worker.on('message', (m) => {
            if (m.type === 'ready') { if (++readyCount === W) onReady(); }
            else if (m.type === 'fingerprint') { fingerprints.set(m.idStart, m.fp); if (fingerprints.size === W) onAllFingerprints(); }
        });
        worker.on('error', (e) => { console.error('worker error', e); process.exit(1); });
        workers.push(worker);
    }
    await ready;

    const releaseTick = (tick) => {
        Atomics.store(ctrl, CTL_TICK, tick);
        const doneGenBefore = Atomics.load(ctrl, CTL_DONEGEN);
        Atomics.add(ctrl, CTL_TICKGEN, 1);
        Atomics.notify(ctrl, CTL_TICKGEN);
        return doneGenBefore;
    };
    const awaitTickDone = async (doneGenBefore) => {
        while (Atomics.load(ctrl, CTL_DONEGEN) === doneGenBefore) {
            const r = Atomics.waitAsync(ctrl, CTL_DONEGEN, doneGenBefore);
            if (r.async) await r.value;
        }
    };

    // Grow-on-near-full: double the swimbot SABs before nextId reaches maxBots. The safe window is BETWEEN ticks --
    // all workers are parked on TICKGEN, so nobody is touching a SAB and the copy is a clean snapshot. Threshold
    // maxBots/2 is provably below any one tick's minting (births/tick <= living/2 <= nextId/2), so the resolve()
    // minting clamp is never reached (reaching it would stall births and diverge from world.js). Copy ONLY the two
    // cross-tick carriers (frozen _f64 + the resolution/genome buffers); everything else is per-tick scratch.
    let growCount = 0, foodGrowCount = 0;
    const FOOD_MARGIN = 2; // grow food this many ids early -- regen adds <=1 food/tick and maybeGrow runs every tick,
                           // so the SoA never fills before we grow (a full SoA would SKIP a regen -> diverge).
    // `force` (test hook forceGrowEvery) forces a SWIMBOT grow regardless of nextId, to exercise the multi-grow
    // chain fast -- always safe: a grow only ENLARGES the buffers, moving the mint clamp further away. Swimbot and
    // food have INDEPENDENT triggers but share ONE handshake: the message carries whichever grew; the worker rebinds
    // whichever is present.
    const maybeGrow = async (force = false, forceFood = false) => {
        const growBots = force || Atomics.load(ctrl, CTL_NEXTID) >= (maxBots >> 1);
        const growFood = forceFood || Atomics.load(ctrl, CTL_NEXTFOODID) >= maxFood - FOOD_MARGIN;
        if (!growBots && !growFood) return;
        const msg = { type: 'grow' };
        let newMax, nFrozen, nBotIds, nPu, nRes, newMaxFood, nFoodSab, nFoodBotIds;
        if (growBots) {
            newMax = maxBots * 2;
            nFrozen = makeFrozenBuffer(newMax);
            nBotIds = new SharedArrayBuffer(newMax * Int32Array.BYTES_PER_ELEMENT); // only botIds scales with maxBots
            nPu = makePostUpdateBuffer(newMax);
            nRes = makeResolutionBuffers(newMax, NUM_GENES);
            // Copy the cross-tick carriers into the larger buffers; old region lands at [0,oldMax), new region stays 0.
            new Float64Array(nFrozen).set(new Float64Array(frozenSab));                                  // ghost read by next applyDeltas sweep
            new Uint8Array(nRes.genomeSab).set(new Uint8Array(resSabs.genomeSab));                       // genome accumulator (all genomes ever)
            new Int32Array(nRes.flagsSab).set(new Int32Array(resSabs.flagsSab));                         // pending resolution deltas ...
            new Float64Array(nRes.resolvedEnergySab).set(new Float64Array(resSabs.resolvedEnergySab));   //   (applied by next applyDeltas)
            new Int32Array(nRes.numFoodEatenDeltaSab).set(new Int32Array(resSabs.numFoodEatenDeltaSab));
            new Int32Array(nRes.numOffspringDeltaSab).set(new Int32Array(resSabs.numOffspringDeltaSab));
            new Int32Array(nRes.newbornCountSab).set(new Int32Array(resSabs.newbornCountSab));           // this-tick newborns, constructed ...
            new Float64Array(nRes.newbornRecSab).set(new Float64Array(resSabs.newbornRecSab));           //   by next applyDeltas
            new Int32Array(nRes.wantsEatSab).fill(-1);  // re-staged fresh each phase-5; MUST be -1 (a swept bot that was
            new Int32Array(nRes.wantsMateSab).fill(-1); // trying-to-mate is never rewritten -> copying its stale intent would resurrect a birth).
            // puSab: NOT cross-tick (rewritten in phase 5; swept read PU_ALIVE=0 -> skipped) -> a fresh zero buffer is correct.
            // grid count/start/cursor: pool-sized + rebuilt each tick -> workers reuse the originals; only botIds grows.
            msg.frozenSab = nFrozen; msg.botIdsSab = nBotIds; msg.maxBots = newMax; msg.puSab = nPu; msg.resSabs = nRes;
        }
        if (growFood) {
            newMaxFood = maxFood * 2;
            nFoodSab = makeFoodBuffer(newMaxFood);
            nFoodBotIds = new SharedArrayBuffer(newMaxFood * Int32Array.BYTES_PER_ELEMENT);
            new Float64Array(nFoodSab).set(new Float64Array(foodSab));                    // PERSISTENT food SoA (positions/type/alive/energy)
            new Int32Array(nFoodBotIds).set(new Int32Array(foodGridSpec.botIdsSab));      // STATIC food-grid scatter (cells reused, rebuilt on next regen)
            msg.foodSab = nFoodSab; msg.foodBotIdsSab = nFoodBotIds; msg.maxFood = newMaxFood;
        }
        for (const w of workers) w.postMessage(msg);
        const doneBefore = Atomics.load(ctrl, CTL_DONEGEN);
        Atomics.store(ctrl, CTL_GROW, 1);
        Atomics.add(ctrl, CTL_TICKGEN, 1);
        Atomics.notify(ctrl, CTL_TICKGEN);
        await awaitTickDone(doneBefore); // worker 0 acks (bumps DONEGEN) after the grow-barrier; CTL_GROW already cleared
        if (growBots) { maxBots = newMax; frozenSab = nFrozen; puSab = nPu; resSabs = nRes; growCount++; }        // adopt: copy sources for the next grow
        if (growFood) { maxFood = newMaxFood; foodSab = nFoodSab; foodGridSpec = { ...foodGridSpec, botIdsSab: nFoodBotIds, N: newMaxFood }; foodGrowCount++; }
    };

    const forced = (tk) => forceGrowEvery > 0 && tk % forceGrowEvery === 0;         // test hook: force a swimbot grow on a schedule
    const forcedFood = (tk) => forceFoodGrowEvery > 0 && tk % forceFoodGrowEvery === 0; // ditto for food
    const warm = Math.min(warmup, ticks); // untimed warmup (perf runs); 0 for bit-identity comparisons vs world.js
    for (let t = 0; t < warm; t++) { await awaitTickDone(releaseTick(t + 1)); await maybeGrow(forced(t + 1), forcedFood(t + 1)); }
    const t0 = performance.now();
    for (let t = 0; t < ticks; t++) { await awaitTickDone(releaseTick(warm + t + 1)); await maybeGrow(forced(warm + t + 1), forcedFood(warm + t + 1)); }
    const ms = performance.now() - t0;

    Atomics.store(ctrl, CTL_SHUTDOWN, 1);
    Atomics.add(ctrl, CTL_TICKGEN, 1);
    Atomics.notify(ctrl, CTL_TICKGEN);
    await dumped;
    await Promise.all(workers.map(w => w.terminate()));

    const fp = [];
    for (let w = 0; w < W; w++) fp.push(...fingerprints.get(w * chunk));
    fp.sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]));
    const hash = createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16);
    return { ms, tps: Math.round(ticks / (ms / 1000)), hash, totalBots: fp.length, grows: growCount, finalMaxBots: maxBots, foodGrows: foodGrowCount, finalMaxFood: maxFood, fp };
}

// CLI: quick coop-1 vs coop-W determinism + speedup on a full-ecology pool. (The authoritative correctness gate
// is run-g1.mjs = bit-identical to world.js; run-ecology.mjs = determinism; run-pool.mjs = the user runner.)
if (import.meta.url === `file://${process.argv[1]}`) await (async () => {
    const N = Number(process.argv[2] || 4000);
    const ticks = Number(process.argv[3] || 400);
    const W = Number(process.argv[4] || 8);
    const pool = Number(process.argv[5] || 12000);
    const config = makeEcologyConfig(pool);
    const founders = makeFounders(N, pool);
    const food = makeFood(N * 4, pool);
    console.log(`\nGenePool parallel — coop grid  (N=${N}, ticks=${ticks}, pool=${pool}, full ecology)`);
    const coop1 = await runParallel(N, ticks, 1, pool, founders, config, food);
    console.log(`  coop grid (1 worker):   ${String(coop1.tps).padStart(6)} tps   hash=${coop1.hash}`);
    const coopW = await runParallel(N, ticks, W, pool, founders, config, food);
    console.log(`  coop grid (${W} workers):  ${String(coopW.tps).padStart(6)} tps   hash=${coopW.hash}   ${coopW.hash === coop1.hash ? 'DETERMINISTIC ✓' : 'NONDETERMINISTIC ✗'}`);
    console.log(`  speedup (W vs 1): ${(coop1.ms / coopW.ms).toFixed(2)}x`);
})();
