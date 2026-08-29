// Batch orchestrator: run many independent World jobs across worker threads (pool-level parallelism -> ~N x
// throughput on N cores). Results come back in the SAME order as `jobs` and are byte-identical to running
// them sequentially (each job is a pure deterministic function of its spec). workers<=1 runs in-process.
//
// Library:   import { runBatch } from './run.mjs';  const results = await runBatch(jobs, { workers: 8 });
// CLI:       node tools/batch/run.mjs [--jobs N] [--workers W] [--founders F] [--food M] [--ticks T] [--seq]
//   --seq also runs the batch single-threaded and asserts identical stateHashes (determinism check) + shows
//   the parallel speedup.

import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { availableParallelism } from 'node:os';
import { runJob } from './job.mjs';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);

export async function runBatch(jobs, { workers = 4 } = {}) {
    if (workers <= 1 || jobs.length <= 1) return jobs.map(runJob);

    const results = new Array(jobs.length);
    let next = 0, done = 0;
    const pool = [];

    await new Promise((resolve, reject) => {
        const assign = (worker) => {
            if (next >= jobs.length) return; // no more work; worker idles until terminated
            const idx = next++;
            worker._jobIdx = idx;
            worker.postMessage(jobs[idx]);
        };
        const n = Math.min(workers, jobs.length);
        for (let i = 0; i < n; i++) {
            const worker = new Worker(WORKER_URL);
            pool.push(worker);
            worker.on('message', (msg) => {
                if (!msg.ok) { reject(new Error(`batch job failed (seed ${msg.seed}): ${msg.error}`)); return; }
                results[worker._jobIdx] = msg.result;
                if (++done === jobs.length) { resolve(); return; }
                assign(worker);
            });
            worker.on('error', reject);
            assign(worker);
        }
    });
    await Promise.all(pool.map((w) => w.terminate()));
    return results;
}

// --- CLI ---
async function main() {
    const argv = process.argv.slice(2);
    const arg = (name, def) => { const i = argv.indexOf('--' + name); return i !== -1 ? Number(argv[i + 1]) : def; };
    const nJobs = arg('jobs', 16);
    const workers = arg('workers', Math.max(1, availableParallelism() - 1));
    const founders = arg('founders', 300);
    const food = arg('food', founders * 3);
    const ticks = arg('ticks', 2000);
    const seq = argv.includes('--seq');

    const jobs = [];
    for (let s = 0; s < nJobs; s++) jobs.push({ seed: s + 1, founders, food, ticks });

    console.log(`batch: ${nJobs} jobs x ${ticks} ticks, ${founders} founders each, workers=${workers} (cores=${availableParallelism()})`);

    const t0 = Date.now();
    const par = await runBatch(jobs, { workers });
    const parMs = Date.now() - t0;
    console.log(`\nparallel: ${parMs} ms  (${(nJobs * ticks / (parMs / 1000) / 1000).toFixed(1)}k pool-ticks/s)`);
    for (const r of par.slice(0, 8)) console.log(`  seed ${r.seed}: pop=${r.finalPop} food=${r.finalFood} births=${r.births} deaths=${r.deaths} hash=${r.stateHash.slice(0, 12)}`);
    if (par.length > 8) console.log(`  ... (${par.length - 8} more)`);

    if (seq) {
        const t1 = Date.now();
        const one = jobs.map(runJob);
        const seqMs = Date.now() - t1;
        let mismatches = 0;
        for (let i = 0; i < jobs.length; i++) if (one[i].stateHash !== par[i].stateHash) mismatches++;
        console.log(`\nsequential: ${seqMs} ms`);
        console.log(`speedup: ${(seqMs / parMs).toFixed(2)}x on ${workers} workers`);
        console.log(mismatches === 0
            ? `determinism: OK -- all ${jobs.length} parallel results byte-identical to sequential`
            : `determinism: FAIL -- ${mismatches}/${jobs.length} results differ!`);
        if (mismatches) process.exit(1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
