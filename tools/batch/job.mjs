// Batch job core (POOL-LEVEL parallelism): one whole World per job, run to completion, summarized. Each job
// is a PURE DETERMINISTIC function of its spec -- no shared state between jobs -- so running jobs across
// worker threads gives byte-identical results to running them sequentially (proven in
// test/engine/batch-determinism.test.js). This is the north-star "big batch runs" path: N independent seeds
// across N cores = ~N x throughput, with the tick engine (mixed-live perception) untouched and still
// bit-for-bit faithful to JJ. (Intra-tick parallelism -- speeding up a SINGLE pool -- is a separate effort.)

import { createHash } from 'node:crypto';
import { World } from '../../engine/world.js';
import { Genotype } from '../../engine/genotype.js';

const NUM_GENES = 256, NUM_GENES_USED = 112;
const POOL_DEFAULT = 8000;

const DEFAULT_CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};

// Small seedable PRNG for deterministic founder genomes/placement (its own stream; the engine uses its
// addressed RNG internally, seeded by masterSeed).
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Build a fresh, deterministically-seeded World from a job spec (NOT run). Founders get random genomes with
// junk DNA zeroed (JJ's founder rule -> they interbreed; see founder-seeding memory). Everything is a pure
// function of job.seed.
export function buildWorld(job) {
    const config = { ...DEFAULT_CONFIG, ...(job.config || {}) };
    if (job.pool) config.pool = job.pool;
    const world = new World(config, job.seed >>> 0);
    const bounds = world.getPoolBounds();
    const w = bounds.right - bounds.left, h = bounds.bottom - bounds.top;
    const rng = mulberry32((job.seed >>> 0) ^ 0x5eed1234); // founder stream, distinct from masterSeed

    const founders = job.founders ?? 300;
    const food = job.food ?? founders * 3;
    for (let i = 0; i < founders; i++) {
        const g = new Genotype(); g.randomize(rng);
        const genes = g.getGenes().slice();
        for (let k = NUM_GENES_USED; k < NUM_GENES; k++) genes[k] = 0; // zero junk DNA -> one interbreeding species
        world.loadSwimbot(i, {
            age: Math.floor(rng() * 20000),
            x: bounds.left + rng() * w, y: bounds.top + rng() * h,
            angle: rng() * 360 - 180, energy: 80, genes,
        });
    }
    for (let i = 0; i < food; i++) {
        world.loadFood(i, { x: bounds.left + rng() * w, y: bounds.top + rng() * h, type: 0, energy: config.foodBitEnergy });
    }
    world.setObstacle({ x: bounds.left + 40, y: bounds.top + 40 }, { x: bounds.left + 80, y: bounds.top + 40 });
    return world;
}

// Canonical hash of the final living state -- for exact parallel-vs-sequential determinism comparison.
function stateHash(world) {
    const h = createHash('sha256');
    const bots = world.dumpSwimbots().sort((a, b) => a.id - b.id);
    for (const b of bots) h.update(`${b.id}:${b.x}:${b.y}:${b.angle}:${b.energy}:${b.age}:${b.numOffspring}:${b.numFoodBitsEaten}|`);
    const food = world.dumpFood().sort((a, b) => a.id - b.id);
    for (const f of food) h.update(`${f.id}:${f.x}:${f.y}:${f.type};`);
    return h.digest('hex');
}

// Run one job to completion and return a serializable summary (safe to postMessage across a worker boundary).
export function runJob(job) {
    const founders = job.founders ?? 300;
    const world = buildWorld(job);
    for (let t = 0; t < job.ticks; t++) world.tick();
    return {
        seed: job.seed >>> 0,
        ticks: job.ticks,
        founders,
        finalPop: world.getLivingSwimbotCount(),
        finalFood: world.getLivingFoodCount(),
        births: world.getNextSwimbotId() - founders,
        deaths: world.getNumDeadSwimbots(),
        stateHash: stateHash(world),
    };
}
