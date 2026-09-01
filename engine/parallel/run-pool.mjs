// Run ONE full-ecology GenePool across CPU cores and report stats. This is the user-facing entry point for the
// parallel engine: a single pool, evolving (forage/eat/mate/reproduce/die/regen), spread over `workers` threads,
// producing EXACTLY the same result as the single-thread engine (proven bit-identical by run-g1.mjs) -- faster.
//
// Usage: node engine/parallel/run-pool.mjs [N] [ticks] [workers] [pool]
//   e.g. node engine/parallel/run-pool.mjs 6000 1000 10 16000
//
// Correctness is guaranteed by the gates (run separately):
//   node engine/parallel/run-g1.mjs        # bit-identical to world.js at W=1 and W>1
//   node engine/parallel/run-ecology.mjs   # deterministic across worker counts

import { runParallel } from './run.mjs';
import { makeEcologyConfig, makeFounders, makeFood } from './common.mjs';

const N = Number(process.argv[2] || 6000);
const ticks = Number(process.argv[3] || 1000);
const W = Number(process.argv[4] || 10);
const pool = Number(process.argv[5] || 16000);

const config = makeEcologyConfig(pool);
const founders = makeFounders(N, pool);
const food = makeFood(N * 4, pool);

console.log(`\nGenePool — single pool across ${W} cores  (founders=${N}, ticks=${ticks}, pool=${pool}x${pool})`);
const r1 = await runParallel(N, ticks, 1, pool, founders, config, food);
const rW = await runParallel(N, ticks, W, pool, founders, config, food);
console.log(`  1 thread:   ${String(r1.tps).padStart(6)} ticks/sec`);
console.log(`  ${W} threads:  ${String(rW.tps).padStart(6)} ticks/sec   ->  ${(r1.ms / rW.ms).toFixed(2)}x faster`);
console.log(`  final pool:  ${rW.totalBots - N} births over ${ticks} ticks (${N} founders -> ${rW.totalBots} lifetime bots)`);
console.log(`  determinism: ${rW.hash === r1.hash ? 'IDENTICAL across 1 and ' + W + ' threads ✓' : 'MISMATCH ✗'}   hash=${rW.hash}`);
