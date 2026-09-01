// Shared FREE-RUN tick loop for the parallel engine, used by BOTH the browser worker (browser-worker.js) and the
// Node free-run harness/test (worker-freerun.mjs). Workers self-advance ticks in lockstep via the 5 phase barriers,
// with NO per-tick main handshake -- main only flips CTL_RUN (pause) / CTL_DELAY (throttle) and reads CTL_TICK +
// the render buffer. Extracting it here means the Node test exercises the EXACT loop the browser runs.
//
// It RETURNS a reason when it must yield to the environment-specific shell, because the two things a shell does
// differ by environment: SHUTDOWN, DONE (hit maxTicks -- the deterministic Node bit-identity test stops exactly
// there; the browser passes 0 = unbounded), and GROW (rebinding needs the event loop to receive new SABs, which is
// receiveMessageOnPort in Node vs onmessage in the browser). On GROW the shell rebinds and re-invokes with
// startTick set to continue the counter -- the exit is at a clean BETWEEN-tick boundary (after resolve, before the
// next applyDeltas), synced by a grow-check barrier so every worker leaves on the same tick (no barrier-width skew).
//
// PAUSE: only worker 0 gates on CTL_RUN; the others block at B1 waiting for it, so the pause is unanimous.

import { CTL_TICK, CTL_SHUTDOWN, CTL_RUN, CTL_DELAY, CTL_PARK, CTL_GROWREQ, CTL_NEXTID, CTL_NEXTFOODID, barrier } from './barrier.mjs';

export function freeRunLoop(ctrl, W, workerIndex, part, { startTick = 0, maxTicks = 0 } = {}) {
    let localTick = startTick;
    for (;;) {
        if (workerIndex === 0) {
            while (Atomics.load(ctrl, CTL_RUN) === 0) {
                if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) return { reason: 'shutdown', tick: localTick };
                Atomics.wait(ctrl, CTL_RUN, 0, 250);
            }
            const delay = Atomics.load(ctrl, CTL_DELAY); // speed throttle: sleep DELAY ms/tick (0 = flat out)
            if (delay > 0) Atomics.wait(ctrl, CTL_PARK, Atomics.load(ctrl, CTL_PARK), delay); // CTL_PARK never changes -> times out
        }
        if (Atomics.load(ctrl, CTL_SHUTDOWN) === 1) return { reason: 'shutdown', tick: localTick };
        if (maxTicks > 0 && localTick >= maxTicks) return { reason: 'done', tick: localTick };
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
        if (workerIndex === 0) {
            part.resolve(tick);
            Atomics.store(ctrl, CTL_TICK, tick);
            Atomics.store(ctrl, CTL_NEXTID, part.getNextId());
            Atomics.store(ctrl, CTL_NEXTFOODID, part.getNextFoodId());
            if (part.needsGrow()) Atomics.store(ctrl, CTL_GROWREQ, 1); // request a grow before minting/regen would overflow
        }
        barrier(ctrl, W); // B6: worker 0's CTL_GROWREQ write happens-before every worker's read -> unanimous exit
        if (Atomics.load(ctrl, CTL_GROWREQ) === 1) return { reason: 'grow', tick: localTick };
    }
}
