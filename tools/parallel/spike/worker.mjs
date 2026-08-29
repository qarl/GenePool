// SPIKE — a worker: owns one partition of bots, runs the barrier-synced COOPERATIVE-GRID tick until shutdown.
// Heavy Swimbot state stays in this worker's heap; the frozen slots AND the CSR grid live in shared buffers.
// Four intra-tick barriers separate the counting-sort phases; the 5th (end of query) is redundant with the outer
// DONEGEN/TICKGEN handshake, so it's dropped. Worker 0 does the serial prefix sum, but EVERY worker calls every
// barrier the same number of times (only the prefix WORK is gated) -- otherwise the barrier deadlocks.

import { parentPort, workerData } from 'node:worker_threads';
import { Partition } from './partition.mjs';
import { CoopGrid } from './coop-grid.mjs';
import { CTL_TICKGEN, CTL_TICK, CTL_DONEGEN, CTL_SHUTDOWN, barrier } from './barrier.mjs';

const { frozenSab, ctrlSab, gridSpec, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, W, workerIndex,
        foodGridSpec, foodSab, numFood, puSab, resSabs, numFounders } = workerData;
const f64 = new Float64Array(frozenSab);
const ctrl = new Int32Array(ctrlSab);
const coopGrid = new CoopGrid(gridSpec);
// The food SoA + food grid were populated ONCE by main before spawn; the worker just reconstructs read-only views.
const foodF64 = foodSab ? new Float64Array(foodSab) : null;
const foodGrid = foodGridSpec ? new CoopGrid(foodGridSpec) : null;
const puF64 = puSab ? new Float64Array(puSab) : null; // post-update SoA (published in phase 5, read in resolve)
const res = resSabs ? {
    wantsEat: new Int32Array(resSabs.wantsEatSab),
    wantsMate: new Int32Array(resSabs.wantsMateSab),
    resolvedEnergy: new Float64Array(resSabs.resolvedEnergySab),
    numFoodEatenDelta: new Int32Array(resSabs.numFoodEatenDeltaSab),
    numOffspringDelta: new Int32Array(resSabs.numOffspringDeltaSab),
    flags: new Int32Array(resSabs.flagsSab),
    genome: new Uint8Array(resSabs.genomeSab),
    newbornCount: new Int32Array(resSabs.newbornCountSab),
    newbornRec: new Float64Array(resSabs.newbornRecSab),
} : null;
const part = new Partition(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, coopGrid, workerIndex, W, foodGrid, foodF64, numFood, puF64, res, numFounders);

parentPort.postMessage({ type: 'ready', idStart });

// The tick now has a SERIAL TAIL: after all workers finish phase 5 (update+perceive+publish post-update), WORKER 0
// alone resolves cross-worker ecology (eats/births/regen) -> deltas the owners apply next tick. So the tick isn't
// "done" until worker 0's resolve completes -> only worker 0 bumps DONEGEN (after resolve). Every worker still
// calls all 5 intra-tick barriers the same number of times (no deadlock); the resolve is worker-0-only WORK.
let tickGenSeen = 0;
for (;;) {
    while (Atomics.load(ctrl, CTL_TICKGEN) === tickGenSeen) Atomics.wait(ctrl, CTL_TICKGEN, tickGenSeen);
    tickGenSeen = Atomics.load(ctrl, CTL_TICKGEN);

    if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) {
        parentPort.postMessage({ type: 'fingerprint', idStart, fp: part.fingerprint() });
        break;
    }

    const tick = Atomics.load(ctrl, CTL_TICK);

    part.applyDeltas();                 // phase 1a: apply last tick's deltas + newborns + drop dead (S2a: no-op)
    part.zeroGridCells();               // phase 1b: zero my cell-range slice of count[]/cursor[]
    barrier(ctrl, W);                   // B1
    part.writeAndCount();               // phase 2: publish frozen slots + count my bots into cells
    barrier(ctrl, W);                   // B2
    if (workerIndex === 0) part.prefix(); // phase 3: exclusive prefix sum (serial); ALL workers still barrier
    barrier(ctrl, W);                   // B3
    part.scatter();                     // phase 4: scatter my bots into botIds[]
    barrier(ctrl, W);                   // B4
    part.updatePerceive(tick);          // phase 5: update + perceive + publish post-update SoA
    barrier(ctrl, W);                   // B5: all post-update state visible before worker 0 resolves

    if (workerIndex === 0) {            // phase 6: serial cross-worker resolution -> deltas -> tick done
        part.resolve(tick);
        Atomics.add(ctrl, CTL_DONEGEN, 1);
        Atomics.notify(ctrl, CTL_DONEGEN);
    }
}
