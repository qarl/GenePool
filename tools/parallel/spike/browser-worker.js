// Browser Web Worker running one partition of the PARALLEL engine (the browser twin of worker.mjs). Same
// barrier-synced cooperative-grid tick, same Partition + engine code -- only the plumbing differs: an init
// postMessage carries the shared buffers + params (instead of node:worker_threads workerData), and there is no
// parentPort (self.postMessage / self.onmessage). Atomics.wait blocks this worker between ticks (allowed off the
// main thread, exactly like Node). This is the real engine multi-core IN the browser.

import { Partition } from './partition.mjs';
import { CoopGrid } from './coop-grid.mjs';
import { CTL_TICK, CTL_SHUTDOWN, CTL_RUN, CTL_DELAY, CTL_PARK, barrier } from './barrier.mjs';

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

    // FREE-RUN loop: the workers self-advance ticks in lockstep (the 5 barriers keep them aligned) with NO
    // per-tick handshake to the main thread -- main only flips CTL_RUN (pause) + CTL_DELAY (throttle) and reads
    // CTL_TICK / the render buffer. This removes the main-thread coordination that dominated small-pool ticks.
    // localTick is per-worker but stays identical across workers (lockstep via the barriers) -> deterministic.
    // PAUSE: only worker 0 gates on CTL_RUN; the others block at B1 waiting for it, so the pause is unanimous
    // (no barrier-width mismatch). Shutdown is main calling terminate() (reliable even inside Atomics.wait).
    let localTick = 0;
    for (;;) {
        if (workerIndex === 0) {
            while (Atomics.load(ctrl, CTL_RUN) === 0) {
                if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) return;
                Atomics.wait(ctrl, CTL_RUN, 0, 250);
            }
            const delay = Atomics.load(ctrl, CTL_DELAY); // speed throttle: sleep DELAY ms/tick (0 = flat out)
            if (delay > 0) Atomics.wait(ctrl, CTL_PARK, Atomics.load(ctrl, CTL_PARK), delay); // CTL_PARK never changes -> times out
        }
        if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) return;
        localTick++;
        const tick = localTick;

        part.applyDeltas(); part.zeroGridCells();
        barrier(ctrl, W); // B1 (also the unanimous pause-sync: worker 0 reaches here only when RUN==1)
        part.writeAndCount();
        barrier(ctrl, W); // B2
        if (workerIndex === 0) part.prefix();
        barrier(ctrl, W); // B3
        part.scatter();
        barrier(ctrl, W); // B4
        part.updatePerceive(tick);
        barrier(ctrl, W); // B5
        if (workerIndex === 0) { part.resolve(tick); Atomics.store(ctrl, CTL_TICK, tick); }
    }
};
