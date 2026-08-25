'use strict';
// Bug H-c (docs/BUGS-original-genepool.md): startSimulation() seeds the default 1000 food
// (randomizeFood) BEFORE the mode switch, but each setFoodTo*() config only re-initializes the
// prefix of bits it uses and never kills the rest — so RACE / BIG_BANG / NEIGHBORHOOD /
// BAD_PARENTS run with the leftover default food still alive. Worst case: BAD_PARENTS is meant
// to have 5 food bits but runs with ~1000, defeating the "bad parents" starvation scenario.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot } = require('../helpers/boot');

const aliveFood = (gp) =>
    gp.getNumFoodBits() + ((typeof gp.getNumFoodBits1 === 'function') ? gp.getNumFoodBits1() : 0);

test('H-c: preset modes seed only their intended amount of food (no stray default food)', () => {
    const GP = loadSim();
    const M = GP.SimulationStartMode;

    // exact intended counts where they're fixed constants
    for (const [mode, expected] of [
        ['BAD_PARENTS', 5],
        ['BIG_BANG', 500],
        ['NEIGHBORHOOD', 784], // 28 * 28
    ]) {
        const gp = boot(42, M[mode]);
        assert.equal(aliveFood(gp), expected, `${mode} should seed exactly ${expected} food bits`);
    }

    // RACE builds its count incrementally; just prove it isn't the stray default 1000
    const race = boot(42, M.RACE);
    const raceFood = aliveFood(race);
    assert.ok(raceFood > 0 && raceFood < 1000, `RACE food should be its own small set, got ${raceFood}`);
});
