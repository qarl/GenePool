'use strict';
// E2 — the GENETICS-FIDELITY oracle (crossover + mutation).
//
// The second "eternal science oracle" (PLAN-restructure.md §12/§17). Genotype.setAsOffspring draws
// randomness in a data-dependent ORDER (1 parent-pick, then per gene: crossover-test, mutation-test,
// and IF it mutates, mutateGene draws 3 more: floor(gpRandom()*gpRandom()*256), then a sign draw). The
// exact child depends on (parents, crossoverRate, mutationRate, and the draw SEQUENCE + its consumption
// order). We pin all of that here.
//
// PRNG-AGNOSTIC by construction (wave-4 genetics review): the fixture records the EXPLICIT array of draw
// values consumed -- NOT a mulberry32 seed. Both JJ's current setAsOffspring and the fresh engine's must,
// when fed that same array in order, produce the identical child. So swapping the production PRNG later
// cannot invalidate this oracle; it pins the draw-ORDER and the mutation MATH, engine-independently.

const { loadSim } = require('../helpers/load-sim');
const { mulberry32 } = require('../helpers/prng');

const NUM_GENES = 256;
// Base draws with zero mutations = 1 (parent pick) + 256*(crossover-test + mutation-test).
const BASE_DRAWS = 1 + NUM_GENES * 2;
// setAsOffspring reads CROSSOVER_RATE / MUTATION_RATE as sim globals (Parameters.js); the fresh engine
// injects them via config. We record the sim's LIVE values (bridged through __GP) so the fixture rate can
// never silently drift out of sync with the draws/children it was generated under (E2 review, finding 1).

function readGenes(g) {
    const out = new Array(NUM_GENES);
    for (let i = 0; i < NUM_GENES; i++) out[i] = g.getGeneValue(i);
    return out;
}
function makePreset(GP, i) { const g = new GP.Genotype(); g.setToPreset(i); return readGenes(g); }
function makeSeeded(GP, seed) { globalThis.gpRandom = mulberry32(seed); const g = new GP.Genotype(); g.randomize(); return readGenes(g); }
function makeUniform(GP, v) { const g = new GP.Genotype(); g.setAllGenesToOneValue(v); return readGenes(g); }

// Run JJ's setAsOffspring against an INJECTED draw sequence, capturing the exact draws consumed + child.
function breedWithInjectedDraws(GP, parent0Genes, parent1Genes, drawSeed) {
    const p0 = new GP.Genotype(); p0.setGenes(parent0Genes.slice());
    const p1 = new GP.Genotype(); p1.setGenes(parent1Genes.slice());

    // A long deterministic pool of draw values (source can be anything; the CONSUMED prefix is recorded).
    const pool = mulberry32(drawSeed);
    const consumed = [];
    const prev = globalThis.gpRandom;
    globalThis.gpRandom = () => { const v = pool(); consumed.push(v); return v; };
    let child;
    try {
        child = new GP.Genotype();
        child.setAsOffspring(p0, p1);
    } finally {
        globalThis.gpRandom = prev;
    }
    const childGenes = readGenes(child);
    const numMutations = (consumed.length - BASE_DRAWS) / 3; // each mutation adds exactly 3 draws
    return { draws: consumed, child: childGenes, numMutations };
}

function mintCases(GP) {
    return [
        { name: 'darwin-x-wallace', p0: makePreset(GP, 0), p1: makePreset(GP, 1), drawSeed: 101 },
        { name: 'wilson-x-dennett', p0: makePreset(GP, 5), p1: makePreset(GP, 7), drawSeed: 303 },
        { name: 'seed1-x-seed2', p0: makeSeeded(GP, 1), p1: makeSeeded(GP, 2), drawSeed: 202 },
        { name: 'seed42-x-mendel', p0: makeSeeded(GP, 42), p1: makePreset(GP, 2), drawSeed: 505 },
        // uniform parents make mutations visible as any gene that is neither 0 nor 255:
        { name: 'all0-x-all255', p0: makeUniform(GP, 0), p1: makeUniform(GP, 255), drawSeed: 404 },
    ];
}

function buildAll() {
    const GP = loadSim();
    // Read the sim's LIVE rates (not a hardcoded copy) so record and generation can't diverge.
    const crossoverRate = GP.CROSSOVER_RATE;
    const mutationRate = GP.MUTATION_RATE;
    if (!Number.isFinite(crossoverRate) || !Number.isFinite(mutationRate)) {
        throw new Error(`E2: sim rates not bridged (crossover=${crossoverRate}, mutation=${mutationRate})`);
    }
    // Minting reseeds globalThis.gpRandom; snapshot + restore so we don't leak a mulberry32 into the
    // shared process (E2 review, finding 3). breed/replay already save/restore around each call.
    const savedRandom = globalThis.gpRandom;
    try {
        return mintCases(GP).map((c) => {
            const { draws, child, numMutations } = breedWithInjectedDraws(GP, c.p0, c.p1, c.drawSeed);
            return {
                name: c.name,
                crossoverRate,   // the sim's live value
                mutationRate,    // the sim's live value
                parent0: c.p0,
                parent1: c.p1,
                draws,           // the exact, ordered draw values consumed (PRNG-agnostic)
                child,           // the exact child bytes JJ's genetics produced
                numMutations,    // derived: (draws.length - BASE_DRAWS)/3
            };
        });
    } finally {
        globalThis.gpRandom = savedRandom;
    }
}

// Replay a recorded draw array through JJ's current setAsOffspring and return the child bytes.
// (Used by the test to prove the current code reproduces the frozen child from the frozen draws.)
function replay(GP, parent0Genes, parent1Genes, draws) {
    const p0 = new GP.Genotype(); p0.setGenes(parent0Genes.slice());
    const p1 = new GP.Genotype(); p1.setGenes(parent1Genes.slice());
    let i = 0;
    const prev = globalThis.gpRandom;
    globalThis.gpRandom = () => {
        if (i >= draws.length) throw new Error('E2 replay: draw sequence exhausted (draw order changed?)');
        return draws[i++];
    };
    let child;
    try { child = new GP.Genotype(); child.setAsOffspring(p0, p1); }
    finally { globalThis.gpRandom = prev; }
    return { child: readGenes(child), used: i };
}

module.exports = { buildAll, replay, loadSim, NUM_GENES, BASE_DRAWS };
