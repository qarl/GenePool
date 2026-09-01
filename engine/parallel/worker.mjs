// SPIKE — a worker: owns one partition of bots, runs the barrier-synced COOPERATIVE-GRID tick until shutdown.
// Heavy Swimbot state stays in this worker's heap; the frozen slots AND the CSR grid live in shared buffers.
// Four intra-tick barriers separate the counting-sort phases; the 5th (end of query) is redundant with the outer
// DONEGEN/TICKGEN handshake, so it's dropped. Worker 0 does the serial prefix sum, but EVERY worker calls every
// barrier the same number of times (only the prefix WORK is gated) -- otherwise the barrier deadlocks.

import { parentPort, workerData, receiveMessageOnPort } from 'node:worker_threads';
import { Partition } from './partition.mjs';
import { CoopGrid } from './coop-grid.mjs';
import { CTL_TICKGEN, CTL_TICK, CTL_DONEGEN, CTL_SHUTDOWN, CTL_GROW, CTL_NEXTID, CTL_NEXTFOODID, CTL_PARK, barrier } from './barrier.mjs';

const { frozenSab, ctrlSab, gridSpec, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, W, workerIndex,
        foodGridSpec, foodSab, numFood, puSab, resSabs, numFounders, renderSab, wantCheckpoint } = workerData;
const ctrl = new Int32Array(ctrlSab);
const coopGrid = new CoopGrid(gridSpec);
// The food SoA + food grid were populated ONCE by main before spawn; the worker just reconstructs read-only views.
const foodF64 = foodSab ? new Float64Array(foodSab) : null;
const foodGrid = foodGridSpec ? new CoopGrid(foodGridSpec) : null;
const renderF32 = renderSab ? new Float32Array(renderSab) : null;

// Reconstruct the cross-worker resolution views over a set of resolution SABs. Used at startup AND on a grow (the
// SABs are reallocated bigger; the views must point at the new backing). Kept in one place so both paths agree.
function makeResViews(sabs) {
    return sabs ? {
        wantsEat: new Int32Array(sabs.wantsEatSab),
        wantsMate: new Int32Array(sabs.wantsMateSab),
        resolvedEnergy: new Float64Array(sabs.resolvedEnergySab),
        numFoodEatenDelta: new Int32Array(sabs.numFoodEatenDeltaSab),
        numOffspringDelta: new Int32Array(sabs.numOffspringDeltaSab),
        flags: new Int32Array(sabs.flagsSab),
        genome: new Uint8Array(sabs.genomeSab),
        newbornCount: new Int32Array(sabs.newbornCountSab),
        newbornRec: new Float64Array(sabs.newbornRecSab),
    } : null;
}

const f64 = new Float64Array(frozenSab);
const puF64 = puSab ? new Float64Array(puSab) : null; // post-update SoA (published in phase 5, read in resolve)
const res = makeResViews(resSabs);
const part = new Partition(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, coopGrid, workerIndex, W, foodGrid, foodF64, numFood, puF64, res, numFounders, renderF32);

// GROW (grow-on-near-full): main reallocated some SABs bigger and copied the cross-tick carriers into them, then
// postMessaged the new SABs + set CTL_GROW + woke us. We were parked in Atomics.wait, so the message wasn't
// delivered by our (idle) event loop -- pull it SYNCHRONOUSLY here. Main's event loop IS live (it awaits DONEGEN via
// waitAsync), so postMessage delivers; poll until it arrives, sleeping ~1ms between polls on the never-changing
// CTL_PARK slot so we don't busy-spin. Rebind whichever grew (SWIMBOT: g.frozenSab present; FOOD: g.foodSab
// present -- independent triggers, one handshake), barrier so all workers are on the new backing before any tick
// runs, then worker 0 clears CTL_GROW + acks main via DONEGEN. Keeps slot==id / food-id==slot -> the id-keyed
// fingerprint is unchanged -> G1/G2 hold across a grow.
function handleGrow() {
    let m;
    while (!(m = receiveMessageOnPort(parentPort))) Atomics.wait(ctrl, CTL_PARK, Atomics.load(ctrl, CTL_PARK), 1);
    const g = m.message;
    if (g.frozenSab) { // SWIMBOT grow: frozen + coop grid (botIds only) + pu + res
        const newGrid = new CoopGrid({ ...gridSpec, botIdsSab: g.botIdsSab, N: g.maxBots }); // reuse count/start/cursor (per-tick scratch); only botIds grows
        part.rebindGrow(new Float64Array(g.frozenSab), g.maxBots, newGrid, g.puSab ? new Float64Array(g.puSab) : null, makeResViews(g.resSabs), renderF32);
    }
    if (g.foodSab) {   // FOOD grow: food SoA + food grid (foodBotIds only; static grid was copied, cells reused)
        const newFoodGrid = new CoopGrid({ ...foodGridSpec, botIdsSab: g.foodBotIdsSab, N: g.maxFood });
        part.rebindFoodGrow(new Float64Array(g.foodSab), g.maxFood, newFoodGrid);
    }
    barrier(ctrl, W);                       // all workers rebound before any tick touches the new backing
    if (workerIndex === 0) {
        Atomics.store(ctrl, CTL_GROW, 0);   // clear (safe post-barrier: every worker already read CTL_GROW==1)
        Atomics.add(ctrl, CTL_DONEGEN, 1);  // ack: main awaits this like a tick, then releases the real next tick
        Atomics.notify(ctrl, CTL_DONEGEN);
    }
}

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
        part.applyDeltas(); // flush the LAST tick's resolution (normally applied at the next tick's start) so the
        // fingerprint / checkpoint is fully resolved. C2: wantCheckpoint ships each partition's full living-bot state
        // (+ worker 0's ecology) so main can rebuild a resumable World; else the lean id-keyed fingerprint (G1/G2).
        if (wantCheckpoint) parentPort.postMessage({ type: 'checkpoint', idStart, ...part.checkpoint(workerIndex === 0) });
        else parentPort.postMessage({ type: 'fingerprint', idStart, fp: part.fingerprint() });
        break;
    }

    if (Atomics.load(ctrl, CTL_GROW) === 1) { handleGrow(); continue; } // grow pseudo-step: rebind, don't run a tick

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
        Atomics.store(ctrl, CTL_NEXTID, part.getNextId());         // publish for main's grow decision (before DONEGEN)
        Atomics.store(ctrl, CTL_NEXTFOODID, part.getNextFoodId()); // ditto for food-grow
        Atomics.add(ctrl, CTL_DONEGEN, 1);
        Atomics.notify(ctrl, CTL_DONEGEN);
    }
}
