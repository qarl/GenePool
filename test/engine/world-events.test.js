'use strict';
// Event-emission layer (P5 observability foundation): an opt-in options.onEvent sink receives {type,tick,...}
// events for births / deaths / eats + a per-tick summary. Default (no sink) = zero overhead. The sink is a
// pure OBSERVER, so an instrumented run is byte-identical to a plain one -- proven here. The emitted events
// must also match the actual dynamics (birth count == real births, death count == real deaths, etc.).

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

function seed42World(seed, options) {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const world = new World(CONFIG, seed, options);
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    }
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });
    return world;
}
const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

test('events: emitted birth/death/eat/tick match the actual dynamics', () => {
    const events = [];
    const world = seed42World(7, { onEvent: (e) => events.push(e) });
    const startId = world.getNextSwimbotId();
    const TICKS = 700; // long enough that births, deaths, AND eats all occur (matches world-p1b's sanity window)
    for (let t = 0; t < TICKS; t++) world.tick();

    const of = (type) => events.filter((e) => e.type === type);
    assert.equal(of('birth').length, world.getNextSwimbotId() - startId, 'birth events != actual births (nextId delta)');
    assert.equal(of('death').length, world.getNumDeadSwimbots(), 'death events != actual deaths');
    assert.equal(of('tick').length, TICKS, 'tick events != number of ticks');
    assert.ok(of('birth').length > 0 && of('death').length > 0 && of('eat').length > 0, 'run did not exercise all event types');

    // structural validity + ordering
    for (const e of of('birth')) {
        assert.ok(Number.isInteger(e.id) && e.id >= startId, 'birth id not a new never-reused id');
        assert.ok(e.parentId >= 0 && e.mateId >= 0, 'birth missing parent/mate');
        assert.ok(e.tick >= 1 && e.tick <= TICKS);
    }
    for (const e of of('eat')) assert.ok(e.id >= 0 && Number.isInteger(e.foodId), 'eat event malformed');
    assert.equal(of('tick').at(-1).tick, TICKS, 'last tick event has wrong tick number');
    // events are emitted in tick order (tick field non-decreasing)
    let last = 0;
    for (const e of events) { assert.ok(e.tick >= last, 'events not in tick order'); last = e.tick; }
});

test('events: an instrumented run is byte-identical to a plain run (sink is a pure observer)', () => {
    const plain = seed42World(7);
    const instr = seed42World(7, { onEvent: () => {} });
    for (let t = 0; t < 300; t++) { plain.tick(); instr.tick(); }
    assert.equal(hash(instr), hash(plain), 'event emission changed the simulation (sink must be a pure observer)');
    assert.equal(instr.getNextSwimbotId(), plain.getNextSwimbotId());
});
