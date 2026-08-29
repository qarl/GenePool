// SPIKE — single-thread baseline: ONE partition covering all N bots, running the exact same SAB dataflow
// (writeFrozen -> step) the parallel version uses, minus the threads/barriers. Establishes (1) the correctness
// reference fingerprint the parallel run must match bit-for-bit, and (2) the single-thread wall-clock the
// parallel speedup is measured against. Run directly: `node tools/parallel/spike/baseline.mjs [N] [ticks] [pool]`.

import { createHash } from 'node:crypto';
import { makeFrozenBuffer, STRIDE } from './frozen-layout.mjs';
import { Partition } from './partition.mjs';
import { makeConfig, makeFounders, MASTER_SEED, OBSTACLE } from './common.mjs';

export function runBaseline(N, ticks, poolSize) {
    const config = makeConfig(poolSize);
    const founders = makeFounders(N, poolSize);
    const sab = makeFrozenBuffer(N);
    const f64 = new Float64Array(sab);
    const part = new Partition(f64, N, MASTER_SEED, config, founders, 0, N, OBSTACLE);

    const warm = Math.min(50, ticks);
    for (let t = 0; t < warm; t++) { part.writeFrozen(); part.step(t + 1); }

    const t0 = performance.now();
    for (let t = 0; t < ticks; t++) { part.writeFrozen(); part.step(warm + t + 1); }
    const ms = performance.now() - t0;

    const fp = part.fingerprint();
    const hash = createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16);
    return { ms, tps: Math.round(ticks / (ms / 1000)), hash, fingerprint: fp };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const N = Number(process.argv[2] || 2000);
    const ticks = Number(process.argv[3] || 300);
    const pool = Number(process.argv[4] || 8000);
    const r = runBaseline(N, ticks, pool);
    console.log(`baseline (1 thread): N=${N}, ${ticks} ticks in ${r.ms.toFixed(0)}ms = ${r.tps} tps  hash=${r.hash}`);
}
