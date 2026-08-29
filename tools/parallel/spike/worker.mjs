// SPIKE — a worker: owns one partition of bots, runs the barrier-synced two-phase tick until shutdown. The
// heavy Swimbot state stays in this worker's heap; only the frozen slots are shared. See barrier.mjs for the
// handshake. On shutdown it posts its partition's fingerprint so main can verify parallel == single-thread.

import { parentPort, workerData } from 'node:worker_threads';
import { Partition } from './partition.mjs';
import { CTL_TICKGEN, CTL_TICK, CTL_DONECOUNT, CTL_DONEGEN, CTL_SHUTDOWN, barrier } from './barrier.mjs';

const { frozenSab, ctrlSab, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, W } = workerData;
const f64 = new Float64Array(frozenSab);
const ctrl = new Int32Array(ctrlSab);
const part = new Partition(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle);

parentPort.postMessage({ type: 'ready', idStart });

let tickGenSeen = 0;
for (;;) {
    // Wait for main to release a tick (load-then-wait so a bump that already happened is not missed).
    while (Atomics.load(ctrl, CTL_TICKGEN) === tickGenSeen) Atomics.wait(ctrl, CTL_TICKGEN, tickGenSeen);
    tickGenSeen = Atomics.load(ctrl, CTL_TICKGEN);

    if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) {
        parentPort.postMessage({ type: 'fingerprint', idStart, fp: part.fingerprint() });
        break;
    }

    const tick = Atomics.load(ctrl, CTL_TICK);
    part.writeFrozen();      // phase A: publish my frozen slots
    barrier(ctrl, W);        // all slots published before any step reads them
    part.step(tick);         // phase B: rebuild read structures + update+perceive my bots

    if (Atomics.add(ctrl, CTL_DONECOUNT, 1) === W - 1) { // last finisher reports the tick complete
        Atomics.store(ctrl, CTL_DONECOUNT, 0);
        Atomics.add(ctrl, CTL_DONEGEN, 1);
        Atomics.notify(ctrl, CTL_DONEGEN);
    }
}
