// Node FREE-RUN worker: the headless twin of browser-worker.js. It runs the SHARED freeRunLoop (workers self-advance
// ticks, no per-tick main handshake) so the Node bit-identity gate exercises the EXACT loop the browser runs -- the
// free-run path had no headless test before. The tick logic is identical to the handshake worker (worker.mjs); only
// the driver differs. maxTicks stops it at an exact tick for a deterministic fingerprint; grow is handled here.
//
// GROW in free-run: the loop returns 'grow' at a between-tick boundary (all workers exit together via the B6 grow
// barrier). Main allocated the bigger SABs and postMessaged them; we pull them SYNCHRONOUSLY via receiveMessageOnPort
// (Node) exactly like the handshake worker (the browser shell will instead await onmessage -- same rebind, different
// delivery). Rebind whichever grew, barrier, worker 0 clears CTL_GROWREQ, then RE-ENTER the loop continuing the tick
// counter. Keeps slot==id / food-id==slot -> deterministic across the grow (proven bit-identical by run-freerun.mjs).

import { parentPort, workerData, receiveMessageOnPort } from 'node:worker_threads';
import { Partition } from './partition.mjs';
import { CoopGrid } from './coop-grid.mjs';
import { freeRunLoop } from './freerun-loop.mjs';
import { CTL_GROWREQ, CTL_PARK, barrier } from './barrier.mjs';

const { frozenSab, ctrlSab, gridSpec, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, W, workerIndex,
        foodGridSpec, foodSab, numFood, puSab, resSabs, numFounders, renderSab, maxTicks } = workerData;
const ctrl = new Int32Array(ctrlSab);
let coopGrid = new CoopGrid(gridSpec);
const foodF64 = foodSab ? new Float64Array(foodSab) : null;
let foodGrid = foodGridSpec ? new CoopGrid(foodGridSpec) : null;
const renderF32 = renderSab ? new Float32Array(renderSab) : null;

function makeResViews(sabs) {
    return sabs ? {
        wantsEat: new Int32Array(sabs.wantsEatSab), wantsMate: new Int32Array(sabs.wantsMateSab),
        resolvedEnergy: new Float64Array(sabs.resolvedEnergySab), numFoodEatenDelta: new Int32Array(sabs.numFoodEatenDeltaSab),
        numOffspringDelta: new Int32Array(sabs.numOffspringDeltaSab), flags: new Int32Array(sabs.flagsSab),
        genome: new Uint8Array(sabs.genomeSab), newbornCount: new Int32Array(sabs.newbornCountSab),
        newbornRec: new Float64Array(sabs.newbornRecSab),
    } : null;
}

const f64 = new Float64Array(frozenSab);
const puF64 = puSab ? new Float64Array(puSab) : null;
const res = makeResViews(resSabs);
const part = new Partition(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, coopGrid, workerIndex, W, foodGrid, foodF64, numFood, puF64, res, numFounders, renderF32);

// Rebind to the grown SABs (same as worker.mjs handleGrow). Worker 0 first tells main to hand them over (main is
// waiting on that message before it copies/allocates -- all workers are past the B6 grow barrier, so the buffers are
// stable). Then every worker pulls the new SABs synchronously, rebinds whichever grew, barriers, and worker 0 clears
// the grow request so the resumed loop doesn't immediately re-request.
function handleFreeGrow() {
    if (workerIndex === 0) parentPort.postMessage({ type: 'grow-ready' });
    let m;
    while (!(m = receiveMessageOnPort(parentPort))) Atomics.wait(ctrl, CTL_PARK, Atomics.load(ctrl, CTL_PARK), 1);
    const g = m.message;
    if (g.frozenSab) {
        coopGrid = new CoopGrid({ ...gridSpec, botIdsSab: g.botIdsSab, N: g.maxBots });
        part.rebindGrow(new Float64Array(g.frozenSab), g.maxBots, coopGrid, g.puSab ? new Float64Array(g.puSab) : null, makeResViews(g.resSabs), renderF32);
    }
    if (g.foodSab) {
        foodGrid = new CoopGrid({ ...foodGridSpec, botIdsSab: g.foodBotIdsSab, N: g.maxFood });
        part.rebindFoodGrow(new Float64Array(g.foodSab), g.maxFood, foodGrid);
    }
    barrier(ctrl, W);
    if (workerIndex === 0) Atomics.store(ctrl, CTL_GROWREQ, 0); // safe post-barrier: every worker already saw ==1
    barrier(ctrl, W); // ensure the clear is visible before any worker re-enters the loop (else it re-requests)
}

parentPort.postMessage({ type: 'ready', idStart });

let startTick = 0;
for (;;) {
    const r = freeRunLoop(ctrl, W, workerIndex, part, { startTick, maxTicks });
    if (r.reason === 'grow') { handleFreeGrow(); startTick = r.tick; continue; }
    part.applyDeltas(); // shutdown/done: flush the last tick's resolution so the fingerprint is fully resolved
    parentPort.postMessage({ type: 'fingerprint', idStart, fp: part.fingerprint() });
    break;
}
