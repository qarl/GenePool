// PRODUCTIONIZE — the FULL-ECOLOGY determinism runner. Metabolism/eating (S2b) [+births S3, +regen S4] on, so
// the pool actually forages and evolves. The gate here is DETERMINISM under parallelism: coop(W) must be
// BIT-IDENTICAL to coop(W=1) at every worker count (same seed, same everything). The separate G1 gate
// (== single-thread world.js snapshot) lands once births + regen are wired.
//
// Usage: node tools/parallel/spike/run-ecology.mjs [N] [ticks] [W] [pool]

import { runParallel } from './run.mjs';
import { makeEcologyConfig, makeFounders, makeFood } from './common.mjs';

const N = Number(process.argv[2] || 3000);
const ticks = Number(process.argv[3] || 300);
const W = Number(process.argv[4] || 8);
const pool = Number(process.argv[5] || 8000);

const config = makeEcologyConfig(pool);
const founders = makeFounders(N, pool);
const food = makeFood(N * 4, pool);

console.log(`\nFULL-ECOLOGY parallel determinism  (N=${N}, ticks=${ticks}, pool=${pool}, metabolism ON)`);
const c1 = await runParallel(N, ticks, 1, pool, founders, config, food);
console.log(`  coop grid (1 worker):   ${String(c1.tps).padStart(6)} tps   hash=${c1.hash}   bots(incl dead)=${c1.totalBots} (founders ${N} + ${c1.totalBots - N} births)`);
const cW = await runParallel(N, ticks, W, pool, founders, config, food);
console.log(`  coop grid (${W} workers):  ${String(cW.tps).padStart(6)} tps   hash=${cW.hash}   ${cW.hash === c1.hash ? 'DETERMINISTIC ✓' : 'NONDETERMINISTIC ✗'}`);
console.log(`  speedup (W vs 1): ${(c1.ms / cW.ms).toFixed(2)}x`);
