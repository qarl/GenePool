'use strict';
// E1 — the DECODE-FIDELITY oracle corpus (genome -> phenotype).
//
// This is one of the two "eternal science oracles" of the engine restructure (PLAN-restructure.md
// §12/§17): the genome->body decode (Embryology) is provably RNG-free AND transcendental-free, so its
// output is a bit-exact PORTABLE function of the input bytes. We freeze that here against JJ's CURRENT
// simulation/ code; the fresh engine/ decode must reproduce these signatures byte-for-byte (old-vs-new),
// a check no re-baseline is allowed to silence.
//
// Unlike the old topology-only sig (numParts + category,angle to 4 decimals, in embryology.test.js),
// this signature captures EVERY field the decode writes, at FULL precision (JSON round-trips a double
// exactly, so a deep-equal is bit-exact) -- so a divergence in color, geometry, motion, or food-type
// decode cannot slip through (wave-4 genetics review).
//
// Determinism of the fixture: each corpus entry stores its RESOLVED 256 input bytes, so verification is
// setGenes(bytes) -> decode -> compare, with NO RNG at verify time (PRNG-agnostic). Seeds are used only
// to MINT the byte arrays when (re)generating the fixture.

const { loadSim } = require('../helpers/load-sim');
const { mulberry32 } = require('../helpers/prng');

const NUM_GENES = 256;
const clampByte = (v) => Math.max(0, Math.min(255, Math.trunc(v)));

// Per-part fields the decode writes (part 0 is the unwritten ROOT default and is skipped).
const PART_FIELDS = [
    'category', 'branch', 'parent', 'child',
    'angle', 'amp', 'phase', 'turnAmp', 'turnPhase', 'frequency',
    'splined', 'endCapSpline', 'width', 'length', 'red', 'green', 'blue',
];

// Normalize negative zero to +0: the decode can yield -0 (e.g. a reflected zero-amplitude part,
// amp *= -1), which is behaviorally identical to +0 but (a) is lost by JSON (stringifies to "0") and
// (b) trips deepStrictEqual(-0, 0). Normalizing consistently for BOTH old and new keeps the oracle
// bit-exact for every value that matters. (`-0 === 0` is true, so this maps -0 -> +0; any genuine
// small-magnitude value is untouched.)
const nz = (v) => (v === 0 ? 0 : v);

// A full-precision, all-fields signature of a decoded phenotype.
function signatureOf(phenotype) {
    const parts = [];
    for (let i = 1; i < phenotype.numParts; i++) {
        const p = phenotype.parts[i];
        const row = {};
        for (const f of PART_FIELDS) { const v = p[f]; row[f] = (typeof v === 'number') ? nz(v) : v; }
        parts.push(row);
    }
    return {
        numParts: phenotype.numParts,
        frequency: nz(phenotype.frequency),
        preferredFoodType: phenotype.preferredFoodType,
        digestibleFoodType: phenotype.digestibleFoodType,
        parts,
    };
}

// Decode a concrete byte array under a given numFoodTypes, returning its signature.
function decodeSignature(GP, emb, genes, numFoodTypes) {
    const g = new GP.Genotype();
    g.setGenes(genes.slice());               // concrete bytes; no RNG
    globalThis.globalTweakers.numFoodTypes = numFoodTypes;
    try {
        const p = emb.generatePhenotypeFromGenotype(g);
        return signatureOf(p);
    } finally {
        globalThis.globalTweakers.numFoodTypes = 1; // restore default
    }
}

// --- corpus definitions: each mints a concrete 256-byte array + a numFoodTypes ---
function mintCorpus(GP) {
    const entries = [];
    const push = (name, genes, numFoodTypes, extra) =>
        entries.push({ name, numFoodTypes, genes: genes.slice(), ...(extra || {}) });

    // 8 named presets (DARWIN..DENNETT = 0..7), single food type.
    const PRESET_NAMES = ['DARWIN', 'WALLACE', 'MENDEL', 'TURING', 'MARGULIS', 'WILSON', 'DAWKINS', 'DENNETT'];
    for (let i = 0; i < PRESET_NAMES.length; i++) {
        const g = new GP.Genotype();
        g.setToPreset(i);
        push('preset-' + PRESET_NAMES[i], readGenes(g), 1);
    }

    // uniform extremes
    { const g = new GP.Genotype(); g.setAllGenesToOneValue(0);   push('all-0', readGenes(g), 1); }
    { const g = new GP.Genotype(); g.setAllGenesToOneValue(255); push('all-255', readGenes(g), 1); }

    // seeded random genomes (bytes captured; seed only used to mint)
    for (const seed of [1, 2, 3, 42]) {
        globalThis.gpRandom = mulberry32(seed);
        const g = new GP.Genotype(); g.randomize();
        push('seed-' + seed, readGenes(g), 1);
    }

    // 2-food-type path (exercises floor(norm*2) for preferred/digestible food genes)
    { const g = new GP.Genotype(); g.setAllGenesToOneValue(0);   push('two-type-all-0', readGenes(g), 2); }
    { const g = new GP.Genotype(); g.setAllGenesToOneValue(255); push('two-type-all-255', readGenes(g), 2); }
    { globalThis.gpRandom = mulberry32(42); const g = new GP.Genotype(); g.randomize(); push('two-type-seed-42', readGenes(g), 2); }
    // preferred food gene (110) and digestible food gene (111) are SEPARATE genes; force them across the
    // 0.5 boundary in opposite directions so preferred=1, digestible=0. Without a preferred!=digestible
    // entry the oracle can't distinguish "preferred<-110, digestible<-111" from a port that reads one gene
    // for both (the commented-out legacy decode in Embryology.js) -- a real false-pass hole (E1 review).
    {
        globalThis.gpRandom = mulberry32(99);
        const g = new GP.Genotype(); g.randomize();
        const bytes = readGenes(g); bytes[110] = 255; bytes[111] = 0;
        push('two-type-split-food-genes', bytes, 2);
    }

    // OUT-OF-RANGE: rawGenes carries out-of-range values; `genes` is the clamped form the decode runs on.
    // The old decode asserts norm<=1, so it can only process the clamped bytes; the fresh engine/ must
    // additionally prove canonicalize(rawGenes) === genes (its explicit clamp, PLAN §12/CV-3).
    {
        globalThis.gpRandom = mulberry32(7);
        const g = new GP.Genotype(); g.randomize();
        const raw = readGenes(g);
        raw[0] = 300; raw[1] = -5; raw[2] = 1000; raw[3] = 255.9; // out of [0,255]
        const clamped = raw.map(clampByte);
        push('out-of-range', clamped, 1, { rawGenes: raw.slice() });
    }

    return entries;
}

function readGenes(g) {
    const out = new Array(NUM_GENES);
    for (let i = 0; i < NUM_GENES; i++) out[i] = g.getGeneValue(i);
    return out;
}

// Build the full signature set from JJ's current code (the frozen baseline).
function buildAll() {
    const GP = loadSim();
    const emb = new GP.Embryology();
    // Minting reseeds globalThis.gpRandom; snapshot + restore so we don't leak a mulberry32 into the
    // shared process for other tests that expect the sim's original gpRandom.
    const savedRandom = globalThis.gpRandom;
    try {
        return mintCorpus(GP).map((e) => ({
            name: e.name,
            numFoodTypes: e.numFoodTypes,
            genes: e.genes,
            ...(e.rawGenes ? { rawGenes: e.rawGenes } : {}),
            sig: decodeSignature(GP, emb, e.genes, e.numFoodTypes),
        }));
    } finally {
        globalThis.gpRandom = savedRandom;
    }
}

module.exports = { buildAll, decodeSignature, signatureOf, clampByte, PART_FIELDS, NUM_GENES };
