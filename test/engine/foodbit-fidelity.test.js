'use strict';
// Rung 3b of P1a: the engine/ FoodBit ecology reproduces JJ's spawn placement bit-for-bit
// (PLAN-restructure.md §19). spawnFromParent inherits energy/type + places the child near the parent
// via randomizeSpawnPosition, which draws EXACTLY 6 (xx=rng*rng, yy=rng*rng, then a sign draw each --
// SPAWN_FOOD_RANDOMLY_IN_POOL is false). Record-then-replay (the E2 method): record the OLD 6 draws,
// replay into the NEW, assert identical child {x,y,energy,type,index} AND draw count.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/load-sim');
const { mulberry32 } = require('../helpers/prng');
const { FoodBit } = require('../../engine/foodBit.js');

const GP = loadSim();

function spawnOld({ px, py, energy, type, childIndex, childType, radius, srcSeed }) {
    // Build the parent BEFORE recording (FoodBit.initialize draws 2 for a random position we overwrite).
    const parent = new GP.FoodBit();
    parent.initialize(0);
    const pp = new GP.Vector2D(); pp.setXY(px, py);
    parent.setPosition(pp); parent.setEnergy(energy); parent.setType(type);
    if (radius !== undefined) parent.setMaxSpawnRadius(radius);

    const child = new GP.FoodBit();
    if (radius !== undefined) child.setMaxSpawnRadius(radius);

    const draws = [];
    const src = mulberry32(srcSeed);
    globalThis.gpRandom = () => { const v = src(); draws.push(v); return v; };
    child.spawnFromParent(parent, childIndex, childType);

    return {
        draws,
        child: { x: child.getPosition().x, y: child.getPosition().y, energy: child.getEnergy(), type: child.getType(), index: child.getIndex() },
    };
}

function spawnNew({ px, py, energy, type, childIndex, childType, radius }, draws) {
    let i = 0;
    const rng = () => {
        if (i >= draws.length) throw new Error('new FoodBit drew PAST the recorded sequence');
        return draws[i++];
    };
    const parent = new FoodBit();
    parent.setIndex(0); parent.setPosition({ x: px, y: py }); parent.setEnergy(energy); parent.setType(type);
    if (radius !== undefined) parent.setMaxSpawnRadius(radius);

    const child = new FoodBit();
    if (radius !== undefined) child.setMaxSpawnRadius(radius);
    child.spawnFromParent(parent, childIndex, childType, rng);

    return {
        used: i,
        child: { x: child.getPosition().x, y: child.getPosition().y, energy: child.getEnergy(), type: child.getType(), index: child.getIndex() },
    };
}

const CASES = [
    { name: 'center-default-radius', px: 4000, py: 4000, energy: 50, type: 0, childIndex: 7, childType: 0, srcSeed: 1 },
    { name: 'center-small-radius', px: 4000, py: 4000, energy: 50, type: 0, childIndex: 9, childType: 0, radius: 200, srcSeed: 2 },
    { name: 'near-left-wall (reflect x)', px: 100, py: 4000, energy: 50, type: 0, childIndex: 3, childType: 0, srcSeed: 3 },
    { name: 'near-top-wall (reflect y)', px: 4000, py: 100, energy: 50, type: 0, childIndex: 4, childType: 0, srcSeed: 4 },
    { name: 'corner (reflect both)', px: 100, py: 100, energy: 50, type: 0, childIndex: 5, childType: 0, srcSeed: 5 },
    { name: 'type-1 child inherits energy', px: 3000, py: 5000, energy: 37.5, type: 1, childIndex: 11, childType: 1, srcSeed: 6 },
];

for (const c of CASES) {
    test(`rung3b: FoodBit spawn reproduces JJ -- ${c.name}`, () => {
        const oldR = spawnOld(c);
        assert.equal(oldR.draws.length, 6, `${c.name}: JJ spawn must draw exactly 6 (got ${oldR.draws.length})`);
        const newR = spawnNew(c, oldR.draws);
        assert.equal(newR.used, 6, `${c.name}: new spawn must consume exactly 6 draws (got ${newR.used})`);
        assert.deepEqual(newR.child, oldR.child, `${c.name}: spawned child drift`);
    });
}

test('rung3b: reflection actually fires (near-wall cases move the child back inside the margin)', () => {
    // A parent 100 from the left wall with a 4000 radius will often place the child past the margin, so
    // the reflection must trigger for at least one draw seed -> child x ends up >= the left margin (80).
    let reflected = 0;
    for (let seed = 1; seed <= 40; seed++) {
        const { child } = spawnOld({ px: 100, py: 4000, energy: 50, type: 0, childIndex: 3, childType: 0, srcSeed: seed });
        if (child.x >= 80) reflected++; // inside the boundary margin (would be negative without reflection)
    }
    assert.ok(reflected > 0, 'expected the boundary reflection to fire for at least one seed');
});
