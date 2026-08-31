'use strict';
// GENOME-ID = content-hash of the canonical 256 bytes (§12): deterministic, clones collide, any change diverges.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashGenome } = require('../../tools/events/genome-hash.mjs');

function genes(fill) { const g = new Uint8Array(256); for (let i = 0; i < 256; i++) g[i] = fill(i); return g; }

test('hashGenome is deterministic and clones collide', () => {
    const a = genes((i) => (i * 7) % 256);
    const b = genes((i) => (i * 7) % 256); // identical content, different object
    const h = hashGenome(a);
    assert.match(h, /^[0-9a-f]{64}$/, 'sha256 hex, 64 chars');
    assert.equal(hashGenome(a), h, 'same object -> same hash');
    assert.equal(hashGenome(b), h, 'a distinct clone (byte-equal) collides -> same GENOME-ID');
    // Array form hashes the same as the Uint8Array form
    assert.equal(hashGenome(Array.from(a)), h, 'array and typed-array of the same bytes hash identically');
});

test('a one-byte change yields a different hash', () => {
    const a = genes((i) => (i * 7) % 256);
    const h = hashGenome(a);
    for (const idx of [0, 111, 112, 255]) { // incl. the junk boundary (112) and the ends
        const c = Uint8Array.from(a); c[idx] = (c[idx] + 1) % 256;
        assert.notEqual(hashGenome(c), h, `flipping gene ${idx} must change the GENOME-ID`);
    }
});

test('hashGenome rejects a wrong length', () => {
    assert.throws(() => hashGenome(new Uint8Array(255)), /expected 256/);
    assert.throws(() => hashGenome(null), /expected 256/);
});
