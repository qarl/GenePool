// SPIKE — the parallel driver + correctness/perf A/B. Spawns W workers (each owning an id-range partition sharing
// one frozen-snapshot SharedArrayBuffer), drives the barrier-synced tick loop, then verifies the result is
// BIT-IDENTICAL to the single-thread baseline and reports the speedup. This answers the one question: does
// worker-thread intra-tick parallelism beat single-thread NET of the SAB-write + barrier + local-rebuild overhead?
//
// Usage: node tools/parallel/spike/run.mjs [N] [ticks] [workers] [pool]
// The engine itself is untouched; this lives entirely in tools/.

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeFrozenBuffer } from './frozen-layout.mjs';
import { CTL_TICKGEN, CTL_TICK, CTL_DONEGEN, CTL_SHUTDOWN, CTL_SIZE } from './barrier.mjs';
import { makeConfig, makeFounders, MASTER_SEED, OBSTACLE } from './common.mjs';
import { runBaseline } from './baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

async function runParallel(N, ticks, W, poolSize) {
    const config = makeConfig(poolSize);
    const founders = makeFounders(N, poolSize);
    const frozenSab = makeFrozenBuffer(N);
    const ctrlSab = new SharedArrayBuffer(CTL_SIZE * Int32Array.BYTES_PER_ELEMENT);
    const ctrl = new Int32Array(ctrlSab);

    const chunk = Math.ceil(N / W);
    const workers = [];
    const fingerprints = new Map();
    let readyCount = 0;
    let onReady, onAllFingerprints;
    const ready = new Promise(r => { onReady = r; });
    const dumped = new Promise(r => { onAllFingerprints = r; });

    for (let w = 0; w < W; w++) {
        const idStart = w * chunk;
        const idEnd = Math.min(N, (w + 1) * chunk);
        const worker = new Worker(join(HERE, 'worker.mjs'), {
            workerData: {
                frozenSab, ctrlSab, maxBots: N, masterSeed: MASTER_SEED, config,
                founders: founders.slice(idStart, idEnd), idStart, idEnd, obstacle: OBSTACLE, W,
            },
        });
        worker.on('message', (m) => {
            if (m.type === 'ready') { if (++readyCount === W) onReady(); }
            else if (m.type === 'fingerprint') { fingerprints.set(m.idStart, m.fp); if (fingerprints.size === W) onAllFingerprints(); }
        });
        worker.on('error', (e) => { console.error('worker error', e); process.exit(1); });
        workers.push(worker);
    }
    await ready; // all partitions constructed (exclude construction from timing)

    const releaseTick = (tick) => {
        Atomics.store(ctrl, CTL_TICK, tick);
        const doneGenBefore = Atomics.load(ctrl, CTL_DONEGEN);
        Atomics.add(ctrl, CTL_TICKGEN, 1);
        Atomics.notify(ctrl, CTL_TICKGEN);
        return doneGenBefore;
    };
    const awaitTickDone = async (doneGenBefore) => {
        while (Atomics.load(ctrl, CTL_DONEGEN) === doneGenBefore) {
            const r = Atomics.waitAsync(ctrl, CTL_DONEGEN, doneGenBefore);
            if (r.async) await r.value;
        }
    };

    const warm = Math.min(50, ticks);
    for (let t = 0; t < warm; t++) await awaitTickDone(releaseTick(t + 1));

    const t0 = performance.now();
    for (let t = 0; t < ticks; t++) await awaitTickDone(releaseTick(warm + t + 1));
    const ms = performance.now() - t0;

    // shutdown -> workers post fingerprints then exit
    Atomics.store(ctrl, CTL_SHUTDOWN, 1);
    Atomics.add(ctrl, CTL_TICKGEN, 1);
    Atomics.notify(ctrl, CTL_TICKGEN);
    await dumped;
    await Promise.all(workers.map(w => w.terminate()));

    const fp = [];
    for (let w = 0; w < W; w++) fp.push(...fingerprints.get(w * chunk));
    fp.sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]));
    const hash = createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16);
    return { ms, tps: Math.round(ticks / (ms / 1000)), hash };
}

const N = Number(process.argv[2] || 2000);
const ticks = Number(process.argv[3] || 300);
const W = Number(process.argv[4] || 4);
const pool = Number(process.argv[5] || 8000);

console.log(`\nGenePool intra-tick parallelism SPIKE  (N=${N}, ticks=${ticks}, pool=${pool})`);
const base = runBaseline(N, ticks, pool);
console.log(`  baseline (1 thread):   ${String(base.tps).padStart(6)} tps   (${base.ms.toFixed(0)}ms)   hash=${base.hash}`);
const par = await runParallel(N, ticks, W, pool);
console.log(`  parallel (${W} workers): ${String(par.tps).padStart(6)} tps   (${par.ms.toFixed(0)}ms)   hash=${par.hash}`);
console.log(`  speedup: ${(base.ms / par.ms).toFixed(2)}x   determinism: ${base.hash === par.hash ? 'IDENTICAL ✓' : 'MISMATCH ✗ (parallel != single-thread!)'}`);
