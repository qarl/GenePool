'use strict';
// Guards the min-heap partial-select + LAZY obstruction in _giveSwimbotNearbyEnvironmentalStimuli. The
// world-p2 grid==brute A/B canNOT catch a bug here (both paths call the same selection code), so this test
// compares the engine's selected closest-20 against an INDEPENDENT brute-force reference computed in the
// test (filter in-view -> filter non-obstructed -> sort by (d2,id) -> take 20), in a scenario with >20
// in-view candidates where an obstacle OBSTRUCTS some of the nearest, forcing farther ones to be promoted
// into the 20 (the exact case lazy obstruction must get right). Selected set AND order must match exactly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { World } = require('../../engine/world.js');

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};
const VIEW_R2 = 300 * 300;
const genes = Array.from(boot(42).getPoolData().swimbotArray[0].genes);

test('perception closest-20: heap + lazy obstruction == independent brute filter/sort, with promotion', () => {
    const world = new World(CONFIG, 1);
    const LX = 4000, LY = 4000;
    world.loadSwimbot(1000, { age: 5000, x: LX, y: LY, angle: 0, energy: 80, genes }); // the looker

    // 35 candidates ringed around the looker at varied radii/angles (all within the 300 view radius), ids
    // deliberately NOT in distance order so the (d2,id) tiebreak + ordering is exercised.
    let k = 0;
    for (let ring = 0; ring < 5; ring++) {
        const r = 40 + ring * 50; // 40,90,140,190,240 -- all < 300
        for (let a = 0; a < 7; a++) {
            const theta = (a / 7) * Math.PI * 2 + ring * 0.3;
            const id = 900 - k; // descending ids (reverse-ish of creation) to stress the id tiebreak
            world.loadSwimbot(id, { age: 5000, x: LX + r * Math.cos(theta), y: LY + r * Math.sin(theta), angle: 0, energy: 80, genes });
            k++;
        }
    }
    // An obstacle segment just NORTH of the looker: blocks line-of-sight to candidates above it (several of
    // which are among the nearest), forcing promotion of farther, unobstructed candidates.
    world.setObstacle({ x: LX - 250, y: LY + 60 }, { x: LX + 250, y: LY + 60 });

    world._rebuildGrids(); // drives perception directly (no tick()); tick() would have built the grid
    const looker = world._swimbots.get(1000);
    world._giveSwimbotNearbyEnvironmentalStimuli(looker);
    const selected = [];
    for (let i = 0; i < world._numNearby; i++) selected.push(world._nearbyArray[i].getIndex());

    // INDEPENDENT reference (does not touch the engine's selection code)
    const lg = looker.getGenitalPosition();
    const inView = [];
    for (const s of world._swimbots.values()) {
        if (s === looker) continue;
        const d2 = lg.getDistanceSquaredTo(s.getGenitalPosition());
        if (d2 < VIEW_R2) inView.push({ s, d2, id: s.getIndex() });
    }
    const byKey = (a, b) => (a.d2 - b.d2) || (a.id - b.id);
    const distOnlyTop20 = [...inView].sort(byKey).slice(0, 20).map((c) => c.id);
    const refTop20 = inView
        .filter((c) => !world._obstacle.getObstruction(lg, c.s.getGenitalPosition()))
        .sort(byKey).slice(0, 20).map((c) => c.id);

    // scenario sanity: enough candidates, and obstruction actually CHANGED the top-20 (promotion happened)
    assert.ok(inView.length > 20, `need >20 in-view candidates, got ${inView.length}`);
    assert.notDeepEqual(distOnlyTop20, refTop20, 'obstruction did not affect the top-20 -- lazy-obstruction path not exercised; retune the obstacle');

    // the engine's selection must equal the independent reference, set AND order
    assert.deepEqual(selected, refTop20, 'heap+lazy-obstruction selection diverged from brute filter/sort');
});
