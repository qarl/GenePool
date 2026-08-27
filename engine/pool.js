// Pool construction (P0 slice) — build a seeded pool of N founder entities, deterministically.
//
// NO simulation behavior yet (no movement/eat/mate/death, no positions -- placement is excluded from P0,
// PLAN §19/CV-4). This is the P0 de-risk milestone: a seeded pool CONSTRUCTS deterministically -- same
// masterSeed + config => identical entities.
//
// Each entity gets a MONOTONIC, never-reused ID (the birth counter, starting at 0), and its founder genome
// is drawn from a stream ADDRESSED on that ID under DOMAIN.POOL_FOUNDERS (decision D-d, §3). So founder i's
// genome is a pure function of (masterSeed, i) -- independent of the other founders and of any food/other
// randomness. Establishing the ID->seed binding here is what the P0 review asked to "pull forward" so P1
// inherits the discipline.

import { makeStream, DOMAIN } from './rng.js';
import { Genotype } from './genotype.js';
import { Embryology } from './embryology.js';

export function constructPool(config) {
    const { masterSeed, poolSize, numFoodTypes } = config;
    const embryology = new Embryology();
    const decodeConfig = { numFoodTypes };

    const entities = [];
    let nextId = 0;
    for (let n = 0; n < poolSize; n++) {
        const id = nextId++;                       // monotonic, never reused
        const stream = makeStream(masterSeed, DOMAIN.POOL_FOUNDERS, id);
        const genotype = new Genotype();
        genotype.randomize(() => stream.next());   // 256 draws addressed on (POOL_FOUNDERS, id, counter)
        // NB for P1: the genome consumes counters 0..255 of this founder's POOL_FOUNDERS stream. When P1
        // adds founder placement/age/angle, it must CONTINUE this same stream (position >= 256), not
        // restart at 0, or it would re-draw the genome range (§3 "internally ordered").
        const phenotype = embryology.generatePhenotypeFromGenotype(genotype, decodeConfig);
        entities.push({ id, genotype, phenotype });
    }

    return { config, entities, nextId };
}
