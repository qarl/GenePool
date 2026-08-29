// SPIKE — the shared-memory control block + a reusable inter-worker barrier (Atomics). The per-tick handshake:
// main RELEASES a tick (bumps TICKGEN, notifies); each worker does phase A (writeFrozen), hits the barrier so
// ALL frozen slots are published before ANY step reads them, does phase B (step), then the last worker to finish
// bumps DONEGEN so main (waiting via Atomics.waitAsync) can release the next tick. Workers may Atomics.wait; the
// main thread may NOT, so main uses waitAsync. Shutdown is a flag + a TICKGEN bump to wake the workers.

export const CTL_TICKGEN = 0;    // main bumps to release a tick
export const CTL_TICK = 1;       // the tick number for this release
export const CTL_DONECOUNT = 2;  // workers that finished this tick (reset by the last one)
export const CTL_DONEGEN = 3;    // bumped by the last finisher; main waits on it
export const CTL_SHUTDOWN = 4;   // 1 -> workers post their fingerprint and exit
export const CTL_BAR_COUNT = 5;  // inter-worker barrier: arrivals
export const CTL_BAR_GEN = 6;    // inter-worker barrier: generation
export const CTL_SIZE = 7;

// Reusable centralized generation barrier across W workers. The last arrival resets the count, bumps the
// generation, and notifies; everyone else waits for the generation to change. Correct for repeated use.
export function barrier(ctrl, W) {
    const gen = Atomics.load(ctrl, CTL_BAR_GEN);
    if (Atomics.add(ctrl, CTL_BAR_COUNT, 1) === W - 1) {
        Atomics.store(ctrl, CTL_BAR_COUNT, 0);
        Atomics.add(ctrl, CTL_BAR_GEN, 1);
        Atomics.notify(ctrl, CTL_BAR_GEN);
    } else {
        while (Atomics.load(ctrl, CTL_BAR_GEN) === gen) Atomics.wait(ctrl, CTL_BAR_GEN, gen);
    }
}
