// Browser Web Worker running one partition of the PARALLEL engine (the browser twin of worker.mjs). Same
// barrier-synced cooperative-grid tick, same Partition + engine code -- only the plumbing differs: an init
// postMessage carries the shared buffers + params (instead of node:worker_threads workerData), and there is no
// parentPort (self.postMessage / self.onmessage). Atomics.wait blocks this worker between ticks (allowed off the
// main thread, exactly like Node). This is the real engine multi-core IN the browser.

import { Partition } from './partition.mjs';
import { CoopGrid } from './coop-grid.mjs';
import { CTL_TICKGEN, CTL_TICK, CTL_DONEGEN, CTL_SHUTDOWN, barrier } from './barrier.mjs';

self.onmessage = (e) => {
    const d = e.data;
    if (d.type !== 'init') return;

    const f64 = new Float64Array(d.frozenSab);
    const ctrl = new Int32Array(d.ctrlSab);
    const W = d.W, workerIndex = d.workerIndex;
    const coopGrid = new CoopGrid(d.gridSpec);
    const foodF64 = new Float64Array(d.foodSab);
    const foodGrid = new CoopGrid(d.foodGridSpec);
    const puF64 = new Float64Array(d.puSab);
    const res = {
        wantsEat: new Int32Array(d.resSabs.wantsEatSab), wantsMate: new Int32Array(d.resSabs.wantsMateSab),
        resolvedEnergy: new Float64Array(d.resSabs.resolvedEnergySab), numFoodEatenDelta: new Int32Array(d.resSabs.numFoodEatenDeltaSab),
        numOffspringDelta: new Int32Array(d.resSabs.numOffspringDeltaSab), flags: new Int32Array(d.resSabs.flagsSab),
        genome: new Uint8Array(d.resSabs.genomeSab), newbornCount: new Int32Array(d.resSabs.newbornCountSab),
        newbornRec: new Float64Array(d.resSabs.newbornRecSab),
    };
    const renderF32 = new Float32Array(d.renderSab);
    const part = new Partition(f64, d.maxBots, d.masterSeed, d.config, d.founders, d.idStart, d.idEnd, d.obstacle,
        coopGrid, workerIndex, W, foodGrid, foodF64, d.numFood, puF64, res, d.numFounders, renderF32);

    self.postMessage({ type: 'ready' });

    // Blocking tick loop (dedicated worker thread). Waits for main to release each tick via the ctrl SAB.
    // tickGenSeen is PERSISTENT across iterations (init 0) -- exactly like worker.mjs. Re-reading it fresh each
    // loop would let a worker that raced back after B5 skip a tick the main already released -> barrier deadlock.
    let tickGenSeen = 0;
    for (;;) {
        while (Atomics.load(ctrl, CTL_TICKGEN) === tickGenSeen) {
            if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) return;
            Atomics.wait(ctrl, CTL_TICKGEN, tickGenSeen, 1000);
        }
        tickGenSeen = Atomics.load(ctrl, CTL_TICKGEN);
        if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) return;
        const tick = Atomics.load(ctrl, CTL_TICK);

        part.applyDeltas(); part.zeroGridCells();
        barrier(ctrl, W);
        part.writeAndCount();
        barrier(ctrl, W);
        if (workerIndex === 0) part.prefix();
        barrier(ctrl, W);
        part.scatter();
        barrier(ctrl, W);
        part.updatePerceive(tick);
        barrier(ctrl, W);
        if (workerIndex === 0) {
            part.resolve(tick);
            Atomics.add(ctrl, CTL_DONEGEN, 1);
            Atomics.notify(ctrl, CTL_DONEGEN);
        }
    }
};
