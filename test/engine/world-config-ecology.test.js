'use strict';
// Config-driven ecology knobs (north-star "arbitrary/tunable worlds"): config.viewRadius (perception range;
// also the grid cellSize + the getCloseness normalizer) and config.sensoryPeriod (every-Nth-tick perception
// cadence). Faithful defaults (SWIMBOT_VIEW_RADIUS=300, BRAIN_SENSORY_UPDATE_PERIOD=50) keep the whole
// fidelity suite bit-for-bit; these tests prove the knobs actually take effect when set.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};
const genes = Array.from(boot(42).getPoolData().swimbotArray[0].genes);

test('config.viewRadius gates perception range (grid + filter both honor it)', () => {
    // a candidate 250 units away is perceived iff viewRadius covers it (250 is well inside 500, well outside
    // 100 -- robust to the small genital-vs-center offset).
    function numPerceived(viewRadius) {
        const world = new World({ ...CONFIG, viewRadius }, 1);
        world.loadSwimbot(0, { age: 5000, x: 4000, y: 4000, angle: 0, energy: 80, genes });
        world.loadSwimbot(1, { age: 5000, x: 4250, y: 4000, angle: 0, energy: 80, genes });
        world._rebuildGrids();
        world._giveSwimbotNearbyEnvironmentalStimuli(world._swimbots.get(0));
        return world._numNearby;
    }
    assert.equal(numPerceived(100), 0, 'candidate at 250 should be OUT of a 100 view radius');
    assert.equal(numPerceived(500), 1, 'candidate at 250 should be IN a 500 view radius');
});

function seed42World(extraConfig) {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const world = new World({ ...CONFIG, ...extraConfig }, 5);
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    }
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });
    return world;
}
const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());
const run = (w, n) => { for (let t = 0; t < n; t++) w.tick(); return w; };

test('config.sensoryPeriod changes the ecology (and each setting is deterministic)', () => {
    // A different perception cadence => a different (but still deterministic) run. Default vs a faster period.
    const dflt = hash(run(seed42World({}), 300));            // sensoryPeriod defaults to 50
    const fast = hash(run(seed42World({ sensoryPeriod: 10 }), 300));
    assert.notEqual(fast, dflt, 'sensoryPeriod=10 produced the same run as the default 50 -- knob had no effect');
    // determinism within a setting
    assert.equal(hash(run(seed42World({ sensoryPeriod: 10 }), 300)), fast, 'sensoryPeriod run is non-deterministic');
});

test('config.viewRadius changes the ecology (and is deterministic)', () => {
    const dflt = hash(run(seed42World({}), 300));            // viewRadius defaults to 300
    const wide = hash(run(seed42World({ viewRadius: 600 }), 300));
    assert.notEqual(wide, dflt, 'viewRadius=600 produced the same run as the default 300 -- knob had no effect');
    assert.equal(hash(run(seed42World({ viewRadius: 600 }), 300)), wide, 'viewRadius run is non-deterministic');
});
