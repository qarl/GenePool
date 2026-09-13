'use strict';
// evolvableMutationRate (opt-in): one junk byte (MUTATION_RATE_GENE) becomes a coding gene that scales a lineage's own
// mutation rate = base * 2^(avg(int8 of the two parents' genes)/K). When on: that byte is kept RANDOM in founders (not
// junk-zeroed) and EXCLUDED from the reproductive-isolation (junk) metric. When off: it's a plain zeroed junk byte, and
// the whole engine is byte-identical to JJ (the rest of the suite guards that).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashEntities } = require('../helpers/p1a-golden');

const load = async () => ({
    ...(await import('../../engine/pool-seed.mjs')),
    ...(await import('../../engine/world.js')),
    ...(await import('../../engine/genotype.js')),
    ...(await import('../../engine/config.js')),
    ...(await import('../../engine/constants.js')),
});
const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

test('seeding: OFF zeroes the gene like junk; ON keeps it random and leaves the rest of the junk zeroed', async () => {
    const { makeStandardWorld, MUTATION_RATE_GENE, NUM_GENES_USED, NUM_GENES } = await load();

    const off = makeStandardWorld(7, {}).world.dumpSwimbots();
    for (const s of off) assert.equal(s.genes[MUTATION_RATE_GENE], 0, 'flag off: the gene is zeroed junk');

    const on = makeStandardWorld(7, { settings: { evolvableMutationRate: true } }).world.dumpSwimbots();
    const vals = on.map(s => s.genes[MUTATION_RATE_GENE]);
    assert.ok(new Set(vals).size > 1, 'flag on: the gene varies across founders (random, not zeroed)');
    // the OTHER junk bytes stay zeroed
    for (const s of on) for (let k = NUM_GENES_USED; k < NUM_GENES; k++) {
        if (k === MUTATION_RATE_GENE) continue;
        assert.equal(s.genes[k], 0, `flag on: junk byte ${k} still zeroed`);
    }
});

test('mating gate: the gene is excluded from the junk/speciation metric only when the flag is on', async () => {
    const { World, Genotype, resolveWorldConfig, MUTATION_RATE_GENE, NUM_GENES } = await load();

    const g1 = new Genotype(), g2 = new Genotype();
    const a = new Uint8Array(NUM_GENES), b = new Uint8Array(NUM_GENES);
    a[MUTATION_RATE_GENE] = 0; b[MUTATION_RATE_GENE] = 200;   // differ ONLY in the mutation-rate byte
    g1.setGenes(a); g2.setGenes(b);

    const wOff = new World(resolveWorldConfig({}), 1, {});
    assert.ok(wOff._getJunkDnaSimilarity(g1, g2) < 1, 'flag off: the differing byte counts -> similarity < 1');

    const wOn = new World(resolveWorldConfig({ evolvableMutationRate: true }), 1, {});
    assert.equal(wOn._getJunkDnaSimilarity(g1, g2), 1, 'flag on: the byte is excluded -> similarity == 1');
});

test('config: defaults + validation', async () => {
    const { resolveWorldConfig } = await load();

    const d = resolveWorldConfig({});
    assert.equal(d.evolvableMutationRate, false);
    assert.equal(d.mutationRateGeneScale, 64);
    assert.equal(resolveWorldConfig({ evolvableMutationRate: true }).evolvableMutationRate, true);
    assert.throws(() => resolveWorldConfig({ evolvableMutationRate: 1 }), /must be a boolean/);
    assert.throws(() => resolveWorldConfig({ mutationRateGeneScale: 0 }), /positive finite/);
    assert.throws(() => resolveWorldConfig({ mutationRateGeneScale: -5 }), /positive finite/);
});

test('flag off: a full run is byte-identical to a run built with no settings at all (oracle-safe)', async () => {
    const { makeStandardWorld } = await load();
    const run = (opts) => { const { world } = makeStandardWorld(5, opts); for (let t = 0; t < 3000; t++) world.tick(); return hash(world); };
    // passing the flag explicitly-off must not perturb anything vs the bare default path
    assert.equal(run({}), run({ settings: { evolvableMutationRate: false } }), 'explicit-off == default');
});

test('flag on: a run is deterministic (same seed+config -> identical) and actually breeds', async () => {
    const { makeStandardWorld } = await load();
    const opts = { settings: { evolvableMutationRate: true } };
    const run = () => { const { world } = makeStandardWorld(3, opts); let births = 0;
        world._onEvent = (e) => { if (e.type === 'birth') births++; };
        for (let t = 0; t < 4000; t++) world.tick(); return { h: hash(world), births }; };
    const a = run(), b = run();
    assert.equal(a.h, b.h, 'same seed+config -> identical run');
    assert.ok(a.births > 0, 'the pool actually reproduces with the flag on');
});

test('flag on vs off: same seed DIVERGES (the gene actually influences the run)', async () => {
    const { makeStandardWorld } = await load();
    const run = (opts) => { const { world } = makeStandardWorld(3, opts); for (let t = 0; t < 4000; t++) world.tick(); return hash(world); };
    assert.notEqual(run({}), run({ settings: { evolvableMutationRate: true } }),
        'turning the gene on must change the evolved outcome (else it does nothing)');
});

test('species metric: the display clustering excludes gene 255 when active, matching the engine gate', async () => {
    const { Genotype, NUM_GENES, MUTATION_RATE_GENE } = await load();
    const { junkOf, junkSim, NJ, SPECIES_ISO } = await import('../../engine/analysis/species.mjs');

    // two creatures whose junk genes are IDENTICAL except the mutation-rate byte (255), maximally different there
    const mk = (b255) => { const g = new Genotype(); const a = new Uint8Array(NUM_GENES); a[MUTATION_RATE_GENE] = b255; g.setGenes(a); return { getGenotype: () => g }; };
    const A = mk(0), B = mk(255);

    // full span (flag off): the byte counts -> similarity < 1, but the nudge is tiny (never crosses SPECIES_ISO=0.9),
    // which is why leaving it in was only cosmetic, never a spurious split.
    const full = junkSim(junkOf(A), junkOf(B));
    assert.ok(full < 1, 'full span: the differing byte lowers similarity');
    assert.ok(full > SPECIES_ISO, 'full span: even the max difference never splits the species (cosmetic only)');

    // active span (flag on -> nj = NJ-1 drops the last junk gene, index 255): excluded -> exactly 1, == the engine gate.
    const excl = junkSim(junkOf(A, NJ - 1), junkOf(B, NJ - 1));
    assert.equal(excl, 1, 'active span: gene 255 excluded -> identical junk -> similarity 1');
});

test('rate mapping: 2^(s/64) is neutral at 0, doubles at +64, halves at -64', () => {
    const mult = (s) => Math.pow(2, s / 64);
    assert.equal(mult(0), 1);
    assert.equal(mult(64), 2);
    assert.equal(mult(-64), 0.5);
    assert.ok(Math.abs(mult(127) - 3.957) < 0.01 && mult(-128) === 0.25, 'extremes ~4x / 0.25x');
});
