'use strict';
// Guards POOL-LEVEL batch parallelism (tools/batch): running independent World jobs across worker threads
// must be BYTE-IDENTICAL to running them sequentially -- each job is a pure deterministic function of its
// spec, so which worker runs it (or in what order) cannot change the result. This is the safety property
// that makes batch parallelism a free ~N x throughput win with the tick engine untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runJob } = require('../../tools/batch/job.mjs');       // require(ESM): Node >= 22.12 (as elsewhere)
const { runBatch } = require('../../tools/batch/run.mjs');

test('batch: parallel (worker threads) results are byte-identical to sequential', async () => {
    const jobs = [];
    for (let s = 1; s <= 6; s++) jobs.push({ seed: s, founders: 120, food: 240, ticks: 300 });

    const seq = jobs.map(runJob);                    // in-process reference
    const par = await runBatch(jobs, { workers: 3 }); // across 3 worker threads

    assert.equal(par.length, seq.length);
    for (let i = 0; i < jobs.length; i++) {
        assert.equal(par[i].stateHash, seq[i].stateHash, `job seed ${jobs[i].seed}: parallel hash != sequential`);
        assert.equal(par[i].finalPop, seq[i].finalPop, `job seed ${jobs[i].seed}: finalPop differs`);
        assert.equal(par[i].births, seq[i].births);
    }
    // sanity: the jobs are genuinely independent pools (different seeds -> different outcomes), so the
    // "identical" check above is meaningful and not comparing all-identical trivial states.
    assert.ok(new Set(seq.map((r) => r.stateHash)).size > 1, 'seeds did not produce independent pools');
});

test('batch: runJob is deterministic (same spec twice -> identical state hash)', () => {
    const job = { seed: 42, founders: 100, food: 200, ticks: 250 };
    assert.equal(runJob(job).stateHash, runJob(job).stateHash);
});

test('batch: runBatch with workers=1 equals the sequential map', async () => {
    const jobs = [{ seed: 10, founders: 80, food: 160, ticks: 200 }, { seed: 11, founders: 80, food: 160, ticks: 200 }];
    const one = await runBatch(jobs, { workers: 1 });
    const seq = jobs.map(runJob);
    for (let i = 0; i < jobs.length; i++) assert.equal(one[i].stateHash, seq[i].stateHash);
});
