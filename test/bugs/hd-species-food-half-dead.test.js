'use strict';
// Bug H-d (docs/BUGS-original-genepool.md): the SPECIES start mode sets _numFoodBits = 2000
// and calls setFoodToSpeciesConfiguration(), which sets each bit's type/position but — unlike
// every other setFoodTo*() — never calls initialize(f). initialize() is what marks a food bit
// alive, so slots 1000..1999 stay dead and the flagship speciation pool begins with only ~half
// its intended food (worse for the very mode the competition cares about).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot } = require('../helpers/boot');

test('H-d: SPECIES start mode brings all its food bits alive', () => {
    const GP = loadSim();
    const gp = boot(42, GP.SimulationStartMode.SPECIES);
    // getNumFoodBits() counts type-0 only when numFoodTypes==2, so sum both types.
    const f1 = (typeof gp.getNumFoodBits1 === 'function') ? gp.getNumFoodBits1() : 0;
    const totalAlive = gp.getNumFoodBits() + f1;
    assert.equal(totalAlive, 2000, 'SPECIES should start with all 2000 food bits alive');
});
