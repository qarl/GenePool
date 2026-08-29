// Run recorder: run one World to completion while streaming its events into a SQLite database, producing a
// self-contained, queryable run artifact (population trajectory, lineages, foraging -- see tools/events/
// sqlite-sink.mjs). Composes the verified pieces (World + event sink); the sink is a pure observer so the
// recorded run is byte-identical to a plain one. Engine-neutral observability -- a recorded run is content
// any downstream (analysis, replay, debugging) can query.
//
//   node tools/run-recorder.mjs [--seed 1] [--founders 300] [--food 900] [--ticks 5000] [--out run.db]
//        [--pool WxH] [--viewRadius 300] [--sensoryPeriod 50] [--maxPopulation N]
//   (--out omitted -> an in-memory DB, queried + summarized but not persisted.)

import { World } from '../engine/world.js';
import { Genotype } from '../engine/genotype.js';
import { createSqliteSink, writeRunMeta } from './events/sqlite-sink.mjs';

const NUM_GENES = 256, NUM_GENES_USED = 112;
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const argv = process.argv.slice(2);
const num = (name, def) => { const i = argv.indexOf('--' + name); return i !== -1 ? Number(argv[i + 1]) : def; };
const str = (name, def) => { const i = argv.indexOf('--' + name); return i !== -1 ? argv[i + 1] : def; };

const seed = num('seed', 1);
const founders = num('founders', 300);
const food = num('food', founders * 3);
const ticks = num('ticks', 5000);
const out = str('out', ':memory:');
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

const sink = createSqliteSink(out);
const world = new World(config, seed, { onEvent: sink.onEvent });
writeRunMeta(sink.db, { seed, founders, food, ticks, config });

const rng = mulberry32((seed >>> 0) ^ 0x5eed1234);
for (let i = 0; i < founders; i++) {
    const g = new Genotype(); g.randomize(rng);
    const genes = g.getGenes().slice();
    for (let k = NUM_GENES_USED; k < NUM_GENES; k++) genes[k] = 0; // junk-zeroed -> one interbreeding species
    world.loadSwimbot(i, { age: Math.floor(rng() * 20000), x: rng() * pw, y: rng() * ph, angle: rng() * 360 - 180, energy: 80, genes });
}
for (let i = 0; i < food; i++) world.loadFood(i, { x: rng() * pw, y: rng() * ph, type: 0, energy: config.foodBitEnergy });
world.setObstacle({ x: 40, y: 40 }, { x: 80, y: 40 });

const t0 = Date.now();
for (let t = 0; t < ticks; t++) world.tick();
sink.flush();
const ms = Date.now() - t0;

const db = sink.db;
const one = (sql) => db.prepare(sql).get();
console.log(`recorded ${ticks} ticks in ${ms}ms -> ${out}`);
console.log(`  final: pop=${world.getLivingSwimbotCount()} food=${world.getLivingFoodCount()} births=${one('SELECT count(*) c FROM births').c} deaths=${one('SELECT count(*) c FROM deaths').c} eats=${one('SELECT count(*) c FROM eats').c}`);
console.log(`  peak population: ${one('SELECT max(pop) m FROM ticks').m}`);
const top = db.prepare('SELECT parentId, count(*) n FROM births GROUP BY parentId ORDER BY n DESC LIMIT 3').all();
console.log(`  most prolific parents: ${top.map((r) => `#${r.parentId}(${r.n})`).join(' ') || '(none)'}`);
console.log(`  sample population trajectory:`);
for (const r of db.prepare(`SELECT tick, pop, food FROM ticks WHERE tick % ${Math.max(1, Math.floor(ticks / 8))} = 0 ORDER BY tick`).all()) {
    console.log(`    t=${String(r.tick).padStart(6)} pop=${String(r.pop).padStart(5)} food=${r.food}`);
}
sink.close();
if (out !== ':memory:') console.log(`\nquery it:  sqlite3 ${out} "SELECT tick,pop FROM ticks WHERE tick%500=0"`);
