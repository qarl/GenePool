// Genotype — forked from JJ's Genotype.js as an ES module (PLAN-restructure.md §15).
//
// The genome science is preserved EXACTLY (crossover + mutation draw order and math are frozen by the E2
// oracle). Two changes from JJ, per the plan:
//   - randomness is INJECTED (an `rng` = () -> [0,1) function), never a global gpRandom (§3).
//   - rates (crossover/mutation) are INJECTED (config), not read as module globals (§11 / decision #4),
//     so a per-pool / schedulable rate is expressible without touching this file.
//   - genes are a canonical Uint8Array(256) (§12): setGenes canonicalizes (clamp/coerce/length), and the
//     buffer is owned per-instance (no getGenes-by-reference aliasing).

import { NUM_GENES, BYTE_SIZE, ONE_HALF } from './constants.js';
import { canonicalizeGenome } from './genome.js';
import { assert } from './assert.js';

export class Genotype {
    constructor() {
        this._genes = new Uint8Array(NUM_GENES);
    }

    getGeneValue(g) { return this._genes[g]; }

    // Returns the live buffer. Callers that persist it must snapshot (the sim never mutates another
    // genotype's buffer; setGenes/setAsOffspring only write THIS instance's).
    getGenes() { return this._genes; }

    // Canonicalize arbitrary input (clamp to [0,255], coerce, enforce length) into an owned buffer.
    setGenes(arr) { this._genes = canonicalizeGenome(arr); }

    setAllGenesToOneValue(v) {
        const clamped = v < 0 ? 0 : (v > 255 ? 255 : Math.trunc(v));
        this._genes = new Uint8Array(NUM_GENES).fill(clamped);
    }

    clear() { this._genes = new Uint8Array(NUM_GENES); }

    // Copy another genotype's bytes into an owned buffer (JJ's copyFromGenotype). The source is already
    // canonical (it is a Genotype), so a byte copy suffices; the fresh buffer avoids any aliasing.
    copyFromGenotype(g) { this._genes = g.getGenes().slice(); }

    // Fill with random bytes. Draw order = one rng() per gene (matches JJ's randomize()).
    randomize(rng) {
        for (let g = 0; g < NUM_GENES; g++) {
            this._genes[g] = Math.floor(rng() * BYTE_SIZE);
        }
    }

    // Crossover + mutation. Draw order (frozen by the E2 oracle):
    //   1 parent-pick, then per gene: crossover-test, copy, mutation-test, and IF mutating mutateGene()
    //   draws 3 more. rates = { crossoverRate, mutationRate }.
    setAsOffspring(parent0, parent1, rng, rates) {
        const { crossoverRate, mutationRate } = rates;
        let parent = 0;
        if (rng() < ONE_HALF) parent = 1;

        for (let g = 0; g < NUM_GENES; g++) {
            if (rng() < crossoverRate) parent = (parent === 0) ? 1 : 0;

            this._genes[g] = (parent === 0) ? parent0.getGeneValue(g) : parent1.getGeneValue(g);

            if (rng() < mutationRate) this.mutateGene(g, rng);

            assert(this._genes[g] >= 0 && this._genes[g] < BYTE_SIZE, 'setAsOffspring: gene out of range');
        }
    }

    // Mutate one gene in place. Draw order: amplitude = floor(rng()*rng()*256) [2 draws, left-to-right],
    // then a sign draw rng() > ONE_HALF. Wrap on overflow/underflow. (Matches JJ's mutateGene exactly.)
    mutateGene(g, rng) {
        let amplitude = Math.floor(rng() * rng() * BYTE_SIZE);
        amplitude = Math.round(amplitude);

        // Compute in a plain number so JJ's explicit wrap runs BEFORE the Uint8Array store (a Uint8Array
        // would auto-wrap the intermediate mod-256 first). Results match for the possible ranges, but this
        // mirrors JJ's logic exactly rather than relying on that coincidence.
        let v = this._genes[g];
        if (rng() > ONE_HALF) {
            v += amplitude;
            if (v >= BYTE_SIZE) v -= BYTE_SIZE;
        } else {
            v -= amplitude;
            if (v < 0) v += BYTE_SIZE;
        }
        this._genes[g] = v;
    }
}
