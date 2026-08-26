'use strict';
// Characterizes Gene Pool's assert / assertInteger (Utility.js) -- the "systemic enabler" (S1) behind
// several bugs. assert() only alert()s (which the harness turns into a throw; in the browser it's a
// dismissable popup that does NOT halt). assertInteger(v) tests `v - Math.floor(v) > 0`, which is a
// blind check: it passes for numeric STRINGS, NaN, Infinity, and out-of-range integers -- exactly the
// gaps that let the string-gene (M-stringgene) and unvalidated-load bugs through. This test pins that
// behaviour so the blind spots are documented (and so a future real validator is a deliberate change).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/boot');

const GP = loadSim();

test('assert: alerts (throws, in this harness) on a false assertion, is a no-op on a true one', () => {
    assert.doesNotThrow(() => GP.assert(true, 'ok'));
    assert.throws(() => GP.assert(false, 'boom'), /assertion failed/, 'a false assertion must alert -> throw');
});

test('assertInteger: correctly rejects real non-integer floats', () => {
    assert.throws(() => GP.assertInteger(1.5, 'x'), /not an integer/);
    assert.throws(() => GP.assertInteger(2.0001, 'x'), /not an integer/);
});

test('assertInteger: is BLIND to numeric strings / NaN / Infinity / out-of-range integers (S1)', () => {
    // These are NOT valid gene/index values, yet assertInteger passes them silently -- the documented
    // S1 blind spots (value - Math.floor(value) > 0 is false for all of them).
    assert.doesNotThrow(() => GP.assertInteger('225', 'numeric string'));      // string that coerces
    assert.doesNotThrow(() => GP.assertInteger(NaN, 'NaN'));                    // NaN - NaN = NaN, !>0
    assert.doesNotThrow(() => GP.assertInteger(Infinity, 'Infinity'));         // Inf - Inf = NaN, !>0
    assert.doesNotThrow(() => GP.assertInteger(300, 'out-of-range integer'));  // integer, but > 255
    assert.doesNotThrow(() => GP.assertInteger(-5, 'negative integer'));       // integer, but < 0
    assert.doesNotThrow(() => GP.assertInteger(5, 'valid integer'));           // genuinely fine
});
