'use strict';
// P0 milestone — a seeded pool of N entities CONSTRUCTS deterministically (no simulation behavior).
//
// Same masterSeed + config => byte-identical entities (genome + decoded phenotype). Founders are addressed
// on their monotonic ID under DOMAIN.POOL_FOUNDERS (decision D-d), so a founder's genome is a pure function
// of (masterSeed, id) -- independent of pool size and of any other randomness. Positions are excluded (P0).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signatureOf } = require('../oracles/e1-corpus');
const { constructPool } = require('../../engine/pool.js');
const { makeConfig } = require('../../engine/config.js');
const { Embryology } = require('../../engine/embryology.js');

function readGenes(genotype) { const out = new Array(256); for (let i = 0; i < 256; i++) out[i] = genotype.getGeneValue(i); return out; }
// A portable, positions-excluded signature of an entity: id + canonical genome bytes + full decode sig.
function entitySig(e) { return { id: e.id, genes: readGenes(e.genotype), body: signatureOf(e.phenotype) }; }
function poolSig(pool) { return pool.entities.map(entitySig); }

test('construction is deterministic: same masterSeed + config => identical pool', () => {
    const cfg = makeConfig({ masterSeed: 12345, poolSize: 25, numFoodTypes: 1 });
    const a = poolSig(constructPool(cfg));
    const b = poolSig(constructPool(cfg));
    assert.deepEqual(a, b, 'same seed/config must construct an identical pool');
    assert.equal(a.length, 25);
    assert.deepEqual(a.map((e) => e.id), Array.from({ length: 25 }, (_, i) => i), 'IDs must be monotonic 0..N-1');
});

test('each founder genome is a pure function of (masterSeed, id) -- independent of pool size', () => {
    const small = poolSig(constructPool(makeConfig({ masterSeed: 7, poolSize: 3, numFoodTypes: 1 })));
    const large = poolSig(constructPool(makeConfig({ masterSeed: 7, poolSize: 30, numFoodTypes: 1 })));
    // ids 0,1,2 must be byte-identical whether the pool has 3 or 30 founders (addressed-per-ID, not
    // dependent on a shared sequential stream / on how many came after).
    for (let id = 0; id < 3; id++) {
        assert.deepEqual(small[id], large[id], `founder ${id} changed with pool size (not addressed per-ID)`);
    }
});

test('a different masterSeed yields different founders', () => {
    const a = poolSig(constructPool(makeConfig({ masterSeed: 1, poolSize: 10, numFoodTypes: 1 })));
    const b = poolSig(constructPool(makeConfig({ masterSeed: 2, poolSize: 10, numFoodTypes: 1 })));
    assert.notDeepEqual(a, b, 'different seeds should not produce the same founders');
});

test('numFoodTypes reaches the decode (a 2-type pool can decode preferred != digestible somewhere)', () => {
    const two = constructPool(makeConfig({ masterSeed: 99, poolSize: 60, numFoodTypes: 2 }));
    const anySplit = two.entities.some((e) => e.phenotype.preferredFoodType !== e.phenotype.digestibleFoodType);
    const anyOne = two.entities.some((e) => e.phenotype.preferredFoodType === 1 || e.phenotype.digestibleFoodType === 1);
    assert.ok(anyOne, 'numFoodTypes=2 must let food-type traits reach 1 (the config reached the decode)');
    assert.ok(anySplit, 'across 60 founders, some should have preferred != digestible (two distinct food genes)');
    // and a 1-type pool never sets them
    const one = constructPool(makeConfig({ masterSeed: 99, poolSize: 60, numFoodTypes: 1 }));
    assert.ok(one.entities.every((e) => e.phenotype.preferredFoodType === 0 && e.phenotype.digestibleFoodType === 0),
        'numFoodTypes=1 must leave both food traits 0');
});

test('the shared Embryology instance does not leak state (pooled decode == fresh-instance decode)', () => {
    // constructPool reuses one Embryology across all founders. This independently guards against a
    // cross-founder decode leak (also covered by science-fidelity.test.js's call-order test on the same
    // class -- keep BOTH): re-decode each founder's genotype with a FRESH instance and require identity.
    const cfg = makeConfig({ masterSeed: 555, poolSize: 12, numFoodTypes: 2 });
    const pool = constructPool(cfg);
    for (const e of pool.entities) {
        const freshSig = signatureOf(new Embryology().generatePhenotypeFromGenotype(e.genotype, { numFoodTypes: cfg.numFoodTypes }));
        assert.deepEqual(signatureOf(e.phenotype), freshSig, `founder ${e.id}: shared-instance decode diverged from a fresh-instance decode`);
    }
});

test('config: validates inputs (rates in [0,1], safe-integer seed, non-negative counts); no upper caps', () => {
    assert.throws(() => makeConfig({ masterSeed: -1 }), /masterSeed/);
    assert.throws(() => makeConfig({ masterSeed: 2 ** 60 }), /masterSeed/);
    assert.throws(() => makeConfig({ poolSize: -5 }), /poolSize/);
    assert.throws(() => makeConfig({ numFoodTypes: 0 }), /numFoodTypes/);
    assert.throws(() => makeConfig({ crossoverRate: 'banana' }), /crossoverRate/);
    assert.throws(() => makeConfig({ mutationRate: 1.5 }), /mutationRate/);
    // no world bounds: a huge pool and numFoodTypes>2 are legal configs (the engine imposes no cap)
    assert.ok(makeConfig({ poolSize: 5000000, numFoodTypes: 5 }));
});

test('genomes are canonical Uint8Array(256); empty pool is legal', () => {
    const pool = constructPool(makeConfig({ masterSeed: 3, poolSize: 5, numFoodTypes: 1 }));
    for (const e of pool.entities) {
        assert.equal(e.genotype.getGenes().constructor.name, 'Uint8Array');
        assert.equal(e.genotype.getGenes().length, 256);
    }
    const empty = constructPool(makeConfig({ masterSeed: 3, poolSize: 0, numFoodTypes: 1 }));
    assert.equal(empty.entities.length, 0, 'a pool of 0 entities is a valid, faithful world');
    assert.equal(empty.nextId, 0);
});
