// Batch worker: receives job specs, runs each to completion via the deterministic runJob, posts the summary
// back. runJob is a pure function of the job spec, so which worker runs a job (or in what order) cannot
// affect its result. One job in flight per worker at a time (the orchestrator only sends the next after a
// result), so `null` = shut down.
import { parentPort } from 'node:worker_threads';
import { runJob } from './job.mjs';

parentPort.on('message', (job) => {
    if (job === null) { parentPort.close(); return; }
    try {
        parentPort.postMessage({ ok: true, result: runJob(job) });
    } catch (e) {
        parentPort.postMessage({ ok: false, seed: job && job.seed, error: String((e && e.stack) || e) });
    }
});
