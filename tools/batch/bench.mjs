// Batch-scaling benchmark: run a FIXED batch of jobs across increasing worker counts, reporting throughput
// and speedup, and confirming the results are IDENTICAL regardless of worker count (determinism is not a
// function of parallelism). Run on demand:
//   node tools/batch/bench.mjs [--jobs N] [--ticks T] [--founders F]
import { availableParallelism } from 'node:os';
import { runBatch } from './run.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i !== -1 ? Number(argv[i + 1]) : def; };
const cores = availableParallelism();
const nJobs = arg('jobs', 32);
const ticks = arg('ticks', 1500);
const founders = arg('founders', 300);

const jobs = [];
for (let s = 0; s < nJobs; s++) jobs.push({ seed: s + 1, founders, food: founders * 3, ticks });

const counts = [...new Set([1, 2, 4, 8, cores].filter((w) => w >= 1 && w <= cores))].sort((a, b) => a - b);

console.log(`batch-scaling: ${nJobs} jobs x ${ticks} ticks x ${founders} founders  (cores=${cores})\n`);
console.log('  workers |   wall ms | pool-ticks/s |  speedup | determinism');
console.log('  --------+-----------+--------------+----------+------------');

let baselineMs = null, refHashes = null;
for (const w of counts) {
    const t0 = Date.now();
    const res = await runBatch(jobs, { workers: w });
    const ms = Date.now() - t0;
    if (baselineMs === null) baselineMs = ms;
    const hashes = res.map((r) => r.stateHash);
    let det = 'OK';
    if (refHashes === null) refHashes = hashes;
    else for (let i = 0; i < hashes.length; i++) if (hashes[i] !== refHashes[i]) det = `FAIL@${i}`;
    const tps = (nJobs * ticks / (ms / 1000) / 1000).toFixed(1);
    console.log(`  ${String(w).padStart(7)} | ${String(ms).padStart(9)} | ${String(tps + 'k').padStart(12)} | ${(baselineMs / ms).toFixed(2).padStart(7)}x | ${det}`);
}
console.log('\n(determinism OK across all worker counts => results are independent of parallelism.)');
