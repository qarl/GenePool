'use strict';
// Bug C2 (docs/BUGS-original-genepool.md): a UI range slider's .value is a STRING, and
// ui.js passes it to setFoodBitEnergy() unparsed. It's stored raw on every food bit, so
// eating later does `_energy += "50"` — string concatenation, not addition — injecting
// energy from nothing (e.g. 30 + "50" -> "3050"). Fix: setFoodBitEnergy coerces to a number.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');

test('C2: setFoodBitEnergy coerces a slider string to a number', () => {
    const gp = boot(42);
    gp.setFoodBitEnergy('50'); // exactly what ui.js hands it: input.value is a string
    assert.equal(typeof gp.getFoodBitEnergy(), 'number', 'foodBitEnergy must be a number, not a string');
    assert.equal(gp.getFoodBitEnergy(), 50);
});
