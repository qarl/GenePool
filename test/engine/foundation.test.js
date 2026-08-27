'use strict';
// Engine foundation — the addressed-draw RNG (decision D-d), canonical genome, constants.
//
// CJS test requiring the ESM engine modules (Node's require(esm), supported >=22). The engine/ package.json
// scopes type:module so this bridge works while the rest of the harness stays CJS.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { draw, makeStream, DOMAIN } = require('../../engine/rng.js');
const { canonicalizeGenome, genomesEqual, GENOME_LENGTH } = require('../../engine/genome.js');
const C = require('../../engine/constants.js');
const e1 = require('../fixtures/oracles/e1-decode.json');

const SEED = 12345;

// ---------- constants ----------
test('constants: forked values match JJ (BYTE_SIZE/NUM_GENES/parts) and the 112 boundary is single-sourced', () => {
    assert.equal(C.BYTE_SIZE, 256);
    assert.equal(C.NUM_GENES, 256);
    assert.equal(C.NUM_GENES_USED, 112);
    assert.equal(C.MIN_PARTS, 2);
    assert.equal(C.MAX_PARTS, 16);
    assert.equal(C.ROOT_PART, 0);
    assert.equal(GENOME_LENGTH, C.NUM_GENES);
});

// ---------- rng: the §0 contract ----------
test('rng.draw is deterministic: same address -> same value', () => {
    for (const addr of [[7, 0], [7, 1], [999, 3], [0, 0]]) {
        assert.equal(draw(SEED, DOMAIN.SWIMBOT_LIFE, ...addr), draw(SEED, DOMAIN.SWIMBOT_LIFE, ...addr));
    }
    // and always a real float in [0,1)
    for (let i = 0; i < 500; i++) {
        const v = draw(SEED, DOMAIN.SWIMBOT_LIFE, i, 0);
        assert.ok(Number.isFinite(v) && v >= 0 && v < 1, `draw out of [0,1): ${v}`);
    }
});

test('rng.draw: distinct addresses give distinct values below the birthday bound (sanity, NOT a guarantee)', () => {
    // Draw values are a 53-bit HASH of the address: distinct inputs are guaranteed, distinct OUTPUTS are
    // only expected below the ~2^26.5 birthday bound. 3600 draws is far below it, so we expect zero
    // collisions here -- but this is a sanity check, not a claim that draw values are unique keys (they
    // are consumed independently / tie-broken by stableID, never used as identities).
    const seen = new Map();
    let n = 0;
    for (let id = 0; id < 60; id++) {
        for (let ctr = 0; ctr < 60; ctr++) {
            const v = draw(SEED, DOMAIN.SWIMBOT_LIFE, id, ctr);
            n++;
            if (seen.has(v)) assert.fail(`unexpected collision below birthday bound: (${id},${ctr}) and ${seen.get(v)} -> ${v}`);
            seen.set(v, `(${id},${ctr})`);
        }
    }
    assert.equal(seen.size, n, 'no collisions expected at 3600 draws');
});

test('rng: disjoint DOMAIN tags never collide for the same address (key spaces are disjoint by construction)', () => {
    const domains = Object.values(DOMAIN);
    const vals = domains.map((d) => draw(SEED, d, 5, 9));
    assert.equal(new Set(vals).size, domains.length, 'the same address under different DOMAINs must differ');
});

test('rng: arity is distinguished (draw(...,id) != draw(...,id,0))', () => {
    assert.notEqual(draw(SEED, DOMAIN.SWIMBOT_LIFE, 5), draw(SEED, DOMAIN.SWIMBOT_LIFE, 5, 0));
});

test('rng: masterSeed matters and large (>2^32) address parts stay distinct', () => {
    assert.notEqual(draw(1, DOMAIN.SWIMBOT_LIFE, 5, 0), draw(2, DOMAIN.SWIMBOT_LIFE, 5, 0));
    // ids that only differ above the 32-bit boundary must not alias
    const a = draw(SEED, DOMAIN.SWIMBOT_LIFE, 5, 0);
    const b = draw(SEED, DOMAIN.SWIMBOT_LIFE, 5 + 4294967296, 0);
    assert.notEqual(a, b, 'address parts differing only in the high 32 bits must not collide');
});

test('rng: distribution is roughly uniform (sanity, not a rigorous statistical test)', () => {
    const B = 10, buckets = new Array(B).fill(0);
    const N = 100000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
        const v = draw(SEED, DOMAIN.POOL_FOUNDERS, i);
        buckets[Math.min(B - 1, Math.floor(v * B))]++;
        sum += v;
    }
    const mean = sum / N;
    assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean} not ~0.5`);
    for (let b = 0; b < B; b++) {
        assert.ok(buckets[b] > N / B * 0.9 && buckets[b] < N / B * 1.1, `bucket ${b} skewed: ${buckets[b]}`);
    }
});

test('rng.draw validates its inputs', () => {
    assert.throws(() => draw(SEED, 999, 1), /unknown DOMAIN/);
    assert.throws(() => draw(SEED, DOMAIN.SWIMBOT_LIFE, -1), /non-negative/);
    assert.throws(() => draw(SEED, DOMAIN.SWIMBOT_LIFE, 1.5), /non-negative safe integers/);
    assert.throws(() => draw(SEED, DOMAIN.SWIMBOT_LIFE, NaN), /non-negative safe integers/);
});

// ---------- rng: streams (own-decision randomness + resume) ----------
test('rng.makeStream: sequential, reproducible, and resumable from a saved position', () => {
    const s1 = makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 42);
    const first = [s1.next(), s1.next(), s1.next()];
    assert.equal(s1.position, 3);

    // same seed+domain+prefix reproduces the same sequence
    const s2 = makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 42);
    assert.deepEqual([s2.next(), s2.next(), s2.next()], first);

    // a stream draw equals the explicit addressed draw with the counter in the tail
    assert.equal(makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 42).next(), draw(SEED, DOMAIN.SWIMBOT_LIFE, 42, 0));

    // resume: set position and the continuation matches a fresh stream advanced to there
    const s3 = makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 42);
    s3.position = 3;
    const cont = [s3.next(), s3.next()];
    const fresh = makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 42);
    fresh.next(); fresh.next(); fresh.next();
    assert.deepEqual(cont, [fresh.next(), fresh.next()], 'resume from saved position must reproduce the stream');

    // different entity prefix => independent stream
    assert.notDeepEqual(first, [makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 43).next(),
        makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 43).next(), makeStream(SEED, DOMAIN.SWIMBOT_LIFE, 43).next()]);
});

// ---------- genome canonicalization ----------
test('genome: canonicalize clamps to [0,255] exactly as the E1 out-of-range oracle expects', () => {
    const oor = e1.entries.find((x) => x.name === 'out-of-range');
    assert.ok(oor && oor.rawGenes, 'E1 fixture must carry the out-of-range rawGenes');
    const canon = canonicalizeGenome(oor.rawGenes);
    assert.equal(canon.constructor.name, 'Uint8Array');
    assert.equal(canon.length, GENOME_LENGTH);
    // must equal the clamp the oracle froze (NOT the Uint8Array mod-256 wrap)
    for (let i = 0; i < GENOME_LENGTH; i++) {
        assert.equal(canon[i], oor.genes[i], `gene ${i}: engine clamp ${canon[i]} != oracle ${oor.genes[i]}`);
    }
    // sanity: a raw 300 would WRAP to 44 under new Uint8Array([...]); our clamp gives 255
    assert.equal(new Uint8Array([300])[0], 44, 'baseline: the ctor wraps');
    assert.equal(canon[0], 255, 'our clamp must NOT wrap');
});

test('genome: string genes are coerced; out-of-form input is rejected', () => {
    const strs = Array.from({ length: 256 }, (_, i) => String(i % 256));
    const c = canonicalizeGenome(strs);
    for (let i = 0; i < 256; i++) assert.equal(c[i], i % 256, `string gene ${i} not coerced`);
    assert.throws(() => canonicalizeGenome(new Array(255).fill(0)), /expected length 256/);
    assert.throws(() => canonicalizeGenome(new Array(257).fill(0)), /expected length 256/);
    assert.throws(() => canonicalizeGenome(null), /Array or typed array/);
    assert.throws(() => canonicalizeGenome('x'.repeat(256)), /Array or typed array/, 'a bare string must be rejected, not coerced char-by-char');
    const nan = new Array(256).fill(0); nan[5] = 'not a number';
    assert.throws(() => canonicalizeGenome(nan), /not a finite number/);
});

test('genome: genomesEqual and snapshot independence', () => {
    const a = canonicalizeGenome(new Array(256).fill(7));
    const b = canonicalizeGenome(new Array(256).fill(7));
    assert.ok(genomesEqual(a, b));
    b[0] = 8;
    assert.ok(!genomesEqual(a, b), 'a must be an independent snapshot (mutating b does not touch a)');
});
