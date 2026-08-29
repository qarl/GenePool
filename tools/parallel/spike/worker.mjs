// SPIKE — a worker: owns one partition of bots, runs the barrier-synced COOPERATIVE-GRID tick until shutdown.
// Heavy Swimbot state stays in this worker's heap; the frozen slots AND the CSR grid live in shared buffers.
// Four intra-tick barriers separate the counting-sort phases; the 5th (end of query) is redundant with the outer
// DONEGEN/TICKGEN handshake, so it's dropped. Worker 0 does the serial prefix sum, but EVERY worker calls every
// barrier the same number of times (only the prefix WORK is gated) -- otherwise the barrier deadlocks.

import { parentPort, workerData } from 'node:worker_threads';
import { Partition } from './partition.mjs';
import { CoopGrid } from './coop-grid.mjs';
import { CTL_TICKGEN, CTL_TICK, CTL_DONECOUNT, CTL_DONEGEN, CTL_SHUTDOWN, barrier } from './barrier.mjs';

const { frozenSab, ctrlSab, gridSpec, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, W, workerIndex } = workerData;
const f64 = new Float64Array(frozenSab);
const ctrl = new Int32Array(ctrlSab);
const coopGrid = new CoopGrid(gridSpec);
const part = new Partition(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, coopGrid, workerIndex, W);

parentPort.postMessage({ type: 'ready', idStart });

let tickGenSeen = 0;
for (;;) {
    while (Atomics.load(ctrl, CTL_TICKGEN) === tickGenSeen) Atomics.wait(ctrl, CTL_TICKGEN, tickGenSeen);
    tickGenSeen = Atomics.load(ctrl, CTL_TICKGEN);

    if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) {
        parentPort.postMessage({ type: 'fingerprint', idStart, fp: part.fingerprint() });
        break;
    }

    const tick = Atomics.load(ctrl, CTL_TICK);

    part.zeroGridCells();               // phase 1: zero my cell-range slice of count[]/cursor[]
    barrier(ctrl, W);                   // B1
    part.writeAndCount();               // phase 2: publish frozen slots + count my bots into cells
    barrier(ctrl, W);                   // B2
    if (workerIndex === 0) part.prefix(); // phase 3: exclusive prefix sum (serial); ALL workers still barrier
    barrier(ctrl, W);                   // B3
    part.scatter();                     // phase 4: scatter my bots into botIds[]
    barrier(ctrl, W);                   // B4
    part.updatePerceive(tick);          // phase 5: update + perceive (query shared grid); no barrier (outer handshake)

    if (Atomics.add(ctrl, CTL_DONECOUNT, 1) === W - 1) { // last finisher reports the tick complete
        Atomics.store(ctrl, CTL_DONECOUNT, 0);
        Atomics.add(ctrl, CTL_DONEGEN, 1);
        Atomics.notify(ctrl, CTL_DONEGEN);
    }
}
