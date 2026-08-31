// Run recorder (§14): run one World to completion, streaming its events into a JSONL run file (the append-only
// SOURCE OF TRUTH), then ingest that JSONL into a disposable SQLite CATALOG (genome-hash index + birth-DAG). The
// sink is a pure observer, so the recorded run is byte-identical to a plain one. The JSONL is self-describing +
// rebuildable (founder events carry full initial state; food_init events; header carries config+seed+runId, and
// runId folds the founder genomes so a different founder set is a different run).
//
//   node tools/run-recorder.mjs [--seed 1] [--founders 300] [--food 900] [--ticks 5000]
//        [--out run.jsonl] [--db run.db] [--pool WxH] [--viewRadius 300] [--sensoryPeriod 50] [--maxPopulation N]

import { World } from '../engine/world.js';
import { Genotype } from '../engine/genotype.js';
import { createJsonlSink } from './events/jsonl-sink.mjs';
import { ingest } from './events/ingest-jsonl.mjs';
import { computeRunId } from './events/run-identity.mjs';

const NUM_GENES = 256, NUM_GENES_USED = 112;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const argv = process.argv.slice(2);
const num = (name, def) => { const i = argv.indexOf('--' + name); return i !== -1 ? Number(argv[i + 1]) : def; };
const str = (name, def) => { const i = argv.indexOf('--' + name); return i !== -1 ? argv[i + 1] : def; };

const seed = num('seed', 1);
const founders = num('founders', 300);
const food = num('food', founders * 3);
const ticks = num('ticks', 5000);
const out = str('out', 'run.jsonl');
const dbOut = str('db', out.replace(/\.jsonl$/, '') + '.db');
const poolStr = str('pool', '8000x8000');
const [pw, ph] = poolStr.split('x').map(Number);

const config = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
    pool: { left: 0, top: 0, right: pw, bottom: ph },
};
if (argv.includes('--viewRadius')) config.viewRadius = num('viewRadius');
if (argv.includes('--sensoryPeriod')) config.sensoryPeriod = num('sensoryPeriod');
if (argv.includes('--maxPopulation')) config.maxPopulation = num('maxPopulation');

// Build the initial conditions deterministically from the seed, so they can be recorded into the run file.
const rng = mulberry32((seed >>> 0) ^ 0x5eed1234);
const founderSpecs = [];
for (let i = 0; i < founders; i++) {
    const g = new Genotype(); g.randomize(rng);
    const genes = g.getGenes().slice();
    for (let k = NUM_GENES_USED; k < NUM_GENES; k++) genes[k] = 0; // junk-zeroed -> one interbreeding species
    founderSpecs.push({ id: i, genes, age: Math.floor(rng() * 20000), x: rng() * pw, y: rng() * ph, angle: rng() * 360 - 180, energy: 80 });
}
const foodSpecs = [];
for (let i = 0; i < food; i++) foodSpecs.push({ id: i, x: rng() * pw, y: rng() * ph, type: 0, energy: config.foodBitEnergy });

// runId content-addresses the run's ACTUAL initial conditions incl. the founder genomes (§14 must-fix): a
// different founder set -> a different runId -> correct dedupe/rebuild. Excludes tick count (a short run is a
// prefix of a longer one).
const runId = computeRunId({ seed, config, founders: founderSpecs.map((f) => ({ genes: Array.from(f.genes), age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy })), food: foodSpecs });

const sink = createJsonlSink(out, { runId, seed, config });
const world = new World(config, seed, { onEvent: sink.onEvent });
for (const f of founderSpecs) world.loadSwimbot(f.id, f);
for (const f of foodSpecs) world.loadFood(f.id, f);
world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });

const t0 = Date.now();
try { for (let t = 0; t < ticks; t++) world.tick(); }
finally { sink.close(); } // always flush + close the fd, even if a tick throws
const ms = Date.now() - t0;

// Ingest the JSONL source-of-truth -> the catalog.
const cat = ingest(out, dbOut);
console.log(`recorded ${ticks} ticks in ${ms}ms`);
console.log(`  runId=${runId}`);
console.log(`  final: pop=${world.getLivingSwimbotCount()} food=${world.getLivingFoodCount()} founders=${cat.founders} births=${cat.births} deaths=${cat.deaths} eats=${cat.eats} distinctGenomes=${cat.genomes}`);
const top = cat.db.prepare('SELECT parent_id, count(*) n FROM births WHERE run_id = ? GROUP BY parent_id ORDER BY n DESC LIMIT 3').all(runId);
console.log(`  most prolific parents: ${top.map((r) => `#${r.parent_id}(${r.n})`).join(' ') || '(none)'}`);
cat.db.close();
console.log(`\n  JSONL (source of truth): ${out}\n  catalog (SQLite):        ${dbOut}   e.g. sqlite3 ${dbOut} "SELECT founders,births,genomes FROM runs"`);
