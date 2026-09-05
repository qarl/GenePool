// Embarrassingly-parallel batch: run extract-seed for seeds 1..N, `concurrency` at a time (one seed per core).
//   node tools/pca/run-batch.mjs <N> <ticks> <outDir> [concurrency]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = Number(process.argv[2] ?? 100), TICKS = Number(process.argv[3] ?? 200000);
const outDir = process.argv[4] || '.', CONC = Number(process.argv[5] ?? 10);
const HERE = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });

const seeds = Array.from({ length: N }, (_, i) => i + 1);
let done = 0, failed = 0, next = 0;
const t0 = Date.now();

function runOne(seed){
  return new Promise(res => {
    const p = spawn(process.execPath, [join(HERE, 'extract-seed.mjs'), String(seed), String(TICKS), outDir], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', code => { if (code === 0) done++; else { failed++; console.error(`seed ${seed} FAILED (code ${code})`); } res(); });
  });
}
async function worker(){ while (next < seeds.length){ const s = seeds[next++]; await runOne(s); const el=((Date.now()-t0)/1000).toFixed(0); process.stdout.write(`  [${done+failed}/${N}] ${el}s elapsed\n`); } }

console.log(`batch: ${N} seeds x ${TICKS} ticks, ${CONC}-wide -> ${outDir}`);
await Promise.all(Array.from({ length: CONC }, () => worker()));
console.log(`batch done: ${done} ok, ${failed} failed, ${((Date.now()-t0)/1000).toFixed(0)}s total`);
