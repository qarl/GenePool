// SPIKE — the shared-memory control block + a reusable inter-worker barrier (Atomics). The per-tick handshake:
// main RELEASES a tick (bumps TICKGEN, notifies); workers run the cooperative-grid phases separated by barriers
// (zero -> count -> prefix -> scatter -> update+perceive), then the last worker to finish bumps DONEGEN so main
// (waiting via Atomics.waitAsync) can release the next tick. Workers may Atomics.wait; the main thread may NOT,
// so main uses waitAsync. Shutdown is a flag + a TICKGEN bump to wake the workers.
//
// CACHE-LINE PADDING: the hot contended atomics (BAR_COUNT hit 4x/tick by every worker; BAR_GEN spun on by all
// waiters; the DONE pair) are each placed on their OWN 64-byte line (16 int32s apart). Co-locating BAR_COUNT and
// BAR_GEN caused a coherence storm (every arrival's add invalidates the line the waiters spin-load) that scaled
// badly with W -- exactly the high-W overhead we're trying to remove.

export const CTL_TICKGEN = 0;    // main bumps to release a tick (workers wait on it)
export const CTL_TICK = 1;       // the tick number for this release
export const CTL_SHUTDOWN = 2;   // 1 -> workers post their fingerprint and exit
export const CTL_GROW = 3;       // 1 -> the TICKGEN bump is a GROW pseudo-step, not a tick (rebind SABs, don't run).
                                 // Read at wake alongside SHUTDOWN; written only on a rare grow, so the control line
                                 // sees no per-tick coherence traffic from it.
export const CTL_DONECOUNT = 16; // workers that finished this tick (reset by the last one) -- own line
export const CTL_DONEGEN = 32;   // bumped by the last finisher; main waits on it -- own line
export const CTL_BAR_COUNT = 48; // inter-worker barrier: arrivals (hottest, 4x/tick) -- own line
export const CTL_BAR_GEN = 64;   // inter-worker barrier: generation (spun on by all waiters) -- own line
// FREE-RUN mode (browser viewer): workers self-advance ticks (no per-tick main handshake); main only flips RUN
// to pause/resume and reads CTL_TICK. Low-contention (only worker 0 reads RUN/DELAY each tick). CTL_PARK is a
// never-changing slot worker 0 Atomics.waits on to sleep DELAY ms/tick (the speed throttle).
export const CTL_RUN = 80;       // 1 = run, 0 = paused (worker 0 gates on it; B1 makes the pause unanimous)
export const CTL_DELAY = 81;     // per-tick sleep in ms (worker 0); 0 = flat out
export const CTL_PARK = 96;      // dummy slot for worker 0's throttle sleep (main never changes it)
export const CTL_NEXTID = 112;   // worker 0 publishes _nextId here after each resolve; main reads it to decide when
                                 // to grow. Written 1x/tick -> its OWN line (away from TICKGEN parked workers load).
export const CTL_NEXTFOODID = 113; // worker 0 publishes _nextFoodId (same line as CTL_NEXTID: same writer/cadence)
export const CTL_SIZE = 128;

// Reusable centralized generation barrier across W workers. The last arrival resets the count, bumps the
// generation, and notifies; everyone else waits for the generation to change. Correct for repeated use (4x/tick
// and across ticks -- the generation just keeps incrementing; equality compare wraps harmlessly). At W=1 the
// first (only) arrival returns immediately, so the coop(W=1) reference path exercises every phase correctly.
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
