// Browser Web Worker running one partition of the PARALLEL engine (the browser twin of worker-freerun.mjs). It runs
// the SHARED freeRunLoop -- the exact loop the Node bit-identity gate proves (run-freerun-g1.mjs) -- so the browser
// inherits proven determinism. Only the plumbing differs from Node: an init postMessage carries the shared buffers
// (instead of workerData), self.postMessage / self.onmessage instead of parentPort, and GROW is delivered via
// onmessage rather than receiveMessageOnPort (a browser worker blocked in Atomics.wait can't receive a message, so
// the loop RETURNS on a grow to free the event loop; the 'grow' message then rebinds and re-enters the loop).

import { Partition } from './partition.mjs';
import { CoopGrid } from './coop-grid.mjs';
import { freeRunLoop } from './freerun-loop.mjs';
import { CTL_GROWREQ, barrier } from './barrier.mjs';

let ctrl, W, workerIndex, part, gridSpec, foodGridSpec, coopGrid, foodGrid, renderF32, pendingStartTick = 0;

function makeResViews(sabs) {
    return {
        wantsEat: new Int32Array(sabs.wantsEatSab), wantsMate: new Int32Array(sabs.wantsMateSab),
        resolvedEnergy: new Float64Array(sabs.resolvedEnergySab), numFoodEatenDelta: new Int32Array(sabs.numFoodEatenDeltaSab),
        numOffspringDelta: new Int32Array(sabs.numOffspringDeltaSab), flags: new Int32Array(sabs.flagsSab),
        genome: new Uint8Array(sabs.genomeSab), newbornCount: new Int32Array(sabs.newbornCountSab),
        newbornRec: new Float64Array(sabs.newbornRecSab),
    };
}

// Run free ticks until the loop yields. It only yields here on GROW (maxTicks=0 = unbounded) or SHUTDOWN. On GROW,
// worker 0 asks main to hand over the bigger SABs and we RETURN so the event loop can receive main's 'grow' message.
function runLoop(startTick) {
    const r = freeRunLoop(ctrl, W, workerIndex, part, { startTick, maxTicks: 0 });
    if (r.reason === 'grow') {
        pendingStartTick = r.tick;
        if (workerIndex === 0) self.postMessage({ type: 'grow-ready' });
        return; // yield; onmessage('grow') resumes via runLoop(pendingStartTick)
    }
    // 'shutdown' -> fall out; main terminate()s the worker.
}

self.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'init') {
        ctrl = new Int32Array(d.ctrlSab); W = d.W; workerIndex = d.workerIndex;
        gridSpec = d.gridSpec; foodGridSpec = d.foodGridSpec;
        coopGrid = new CoopGrid(gridSpec);
        foodGrid = new CoopGrid(foodGridSpec);
        renderF32 = new Float32Array(d.renderSab);
        part = new Partition(new Float64Array(d.frozenSab), d.maxBots, d.masterSeed, d.config, d.founders, d.idStart, d.idEnd,
            d.obstacle, coopGrid, workerIndex, W, foodGrid, new Float64Array(d.foodSab), d.numFood,
            new Float64Array(d.puSab), makeResViews(d.resSabs), d.numFounders, renderF32);
        self.postMessage({ type: 'ready' });
        setTimeout(() => runLoop(0), 0); // start async so this handler returns (keeps onmessage free for 'grow')
        return;
    }
    if (d.type === 'grow') { // main allocated the bigger SABs; rebind whichever grew (same code as worker-freerun)
        if (d.frozenSab) {
            coopGrid = new CoopGrid({ ...gridSpec, botIdsSab: d.botIdsSab, N: d.maxBots });
            if (d.renderSab) renderF32 = new Float32Array(d.renderSab); // render SoA grows with the swimbots (browser-only)
            part.rebindGrow(new Float64Array(d.frozenSab), d.maxBots, coopGrid, new Float64Array(d.puSab), makeResViews(d.resSabs), renderF32);
        }
        if (d.foodSab) {
            foodGrid = new CoopGrid({ ...foodGridSpec, botIdsSab: d.foodBotIdsSab, N: d.maxFood });
            part.rebindFoodGrow(new Float64Array(d.foodSab), d.maxFood, foodGrid);
        }
        barrier(ctrl, W);                                            // all workers rebound
        if (workerIndex === 0) Atomics.store(ctrl, CTL_GROWREQ, 0);  // clear (safe post-barrier)
        barrier(ctrl, W);                                            // clear visible before any worker re-enters
        runLoop(pendingStartTick);                                   // resume, continuing the tick counter
    }
};
