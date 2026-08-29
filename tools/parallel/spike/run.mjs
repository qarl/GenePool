// SPIKE — the parallel driver + correctness/perf A/B for the COOPERATIVE shared-grid version. Spawns W workers
// (each owning an id-range partition; they build ONE shared CSR neighbor grid cooperatively each tick), drives the
// barrier-synced tick loop, and verifies the result is BIT-IDENTICAL to (a) the single-thread JS-grid reference
// [grid impl correct] and (b) coop at W=1 [parallelization deterministic]. Then reports the speedup. Also runs a
// WALL-HUGGING fixture where coop MUST still match the JS grid (the only case that exercises the clamp/skip edges).
//
// Usage: node tools/parallel/spike/run.mjs [N] [ticks] [workers] [pool]
// The engine itself is untouched; this lives entirely in tools/.

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeFrozenBuffer } from './frozen-layout.mjs';
import { allocCoopGrid } from './coop-grid.mjs';
import { CTL_TICKGEN, CTL_TICK, CTL_DONEGEN, CTL_SHUTDOWN, CTL_SIZE } from './barrier.mjs';
import { makeConfig, makeFounders, makeWallFounders, MASTER_SEED, OBSTACLE } from './common.mjs';
import { runBaseline } from './baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CELL_SIZE = 300; // == SWIMBOT_VIEW_RADIUS (config leaves viewRadius default)

async function runParallel(N, ticks, W, poolSize, founders, config) {
    const frozenSab = makeFrozenBuffer(N);
    const gridSpec = allocCoopGrid(config.pool, CELL_SIZE, N);
    const ctrlSab = new SharedArrayBuffer(CTL_SIZE * Int32Array.BYTES_PER_ELEMENT);
    const ctrl = new Int32Array(ctrlSab);

    const chunk = Math.ceil(N / W);
    const workers = [];
    const fingerprints = new Map();
    let readyCount = 0, onReady, onAllFingerprints;
    const ready = new Promise(r => { onReady = r; });
    const dumped = new Promise(r => { onAllFingerprints = r; });

    for (let w = 0; w < W; w++) {
        const idStart = w * chunk;
        const idEnd = Math.min(N, (w + 1) * chunk);
        const worker = new Worker(join(HERE, 'worker.mjs'), {
            workerData: {
                frozenSab, ctrlSab, gridSpec, maxBots: N, masterSeed: MASTER_SEED, config,
                founders: founders.slice(idStart, idEnd), idStart, idEnd, obstacle: OBSTACLE, W, workerIndex: w,
            },
        });
        worker.on('message', (m) => {
            if (m.type === 'ready') { if (++readyCount === W) onReady(); }
            else if (m.type === 'fingerprint') { fingerprints.set(m.idStart, m.fp); if (fingerprints.size === W) onAllFingerprints(); }
        });
        worker.on('error', (e) => { console.error('worker error', e); process.exit(1); });
        workers.push(worker);
    }
    await ready;

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

const N = Number(process.argv[2] || 5000);
const ticks = Number(process.argv[3] || 200);
const W = Number(process.argv[4] || 8);
const pool = Number(process.argv[5] || 12000);

console.log(`\nGenePool intra-tick parallelism SPIKE — COOPERATIVE GRID  (N=${N}, ticks=${ticks}, pool=${pool})`);

// Main A/B: JS-grid single-thread reference vs coop at W=1 (parallelization-free) vs coop at W.
const config = makeConfig(pool);
const founders = makeFounders(N, pool);
const base = runBaseline(N, ticks, pool, founders, config);
console.log(`  baseline (JS grid, 1 thread): ${String(base.tps).padStart(6)} tps   hash=${base.hash}`);
const coop1 = await runParallel(N, ticks, 1, pool, founders, config);
console.log(`  coop grid (1 worker):         ${String(coop1.tps).padStart(6)} tps   hash=${coop1.hash}  ${coop1.hash === base.hash ? 'matches JS grid ✓' : 'DIFFERS FROM JS GRID ✗'}`);
const coopW = await runParallel(N, ticks, W, pool, founders, config);
console.log(`  coop grid (${W} workers):        ${String(coopW.tps).padStart(6)} tps   hash=${coopW.hash}  ${coopW.hash === coop1.hash ? 'deterministic ✓' : 'NONDETERMINISTIC ✗'}`);
console.log(`  speedup vs baseline: ${(base.ms / coopW.ms).toFixed(2)}x   (vs coop-1: ${(coop1.ms / coopW.ms).toFixed(2)}x)`);
const allOk = coop1.hash === base.hash && coopW.hash === coop1.hash;
console.log(`  correctness: ${allOk ? 'IDENTICAL across JS/coop-1/coop-' + W + ' ✓' : 'MISMATCH ✗'}`);

// Wall-hugging correctness: founders packed at the edges -> genitals at/past walls -> exercises clamp/skip.
const wallPool = 2500;
const wallN = Math.min(N, 1500);
const wallCfg = makeConfig(wallPool);
const wallFounders = makeWallFounders(wallN, wallPool);
const wallBase = runBaseline(wallN, 300, wallPool, wallFounders, wallCfg);
const wallPar = await runParallel(wallN, 300, Math.min(W, 6), wallPool, wallFounders, wallCfg);
console.log(`  wall-hugging A/B (N=${wallN}, pool=${wallPool}): coop ${wallPar.hash === wallBase.hash ? 'matches JS grid at the walls ✓' : 'DIFFERS AT WALLS ✗ (clamp/skip bug)'}`);
