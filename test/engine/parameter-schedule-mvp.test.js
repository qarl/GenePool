'use strict';
// Parameter-timeline MVP: the two opt-in divergences (mutationRateGeneScale, foodReseedWhenEmpty) are now SCHEDULABLE
// (§10) so a run can change them over time. This guards: (1) a schedule VALIDATES per-step; malformed steps rejected;
// (2) a scheduled run is deterministic; (3) the change takes effect AT tick T and not before (identical to the constant
// run for clock < T, then diverges) -- the core guarantee the "change parameters" timeline relies on.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashEntities } = require('../helpers/p1a-golden');

const load = async () => ({
    ...(await import('../../engine/world.js')),
    ...(await import('../../engine/config.js')),
    ...(await import('../../engine/pool-seed.mjs')),
});
const hashAt = (world, ticks) => { for (let t = 0; t < ticks; t++) world.tick(); return hashEntities(world.dumpSwimbots(), world.dumpFood()); };

test('config: schedules on the two MVP fields validate; malformed steps are rejected', async () => {
    const { resolveWorldConfig } = await load();
    // valid schedules
    assert.doesNotThrow(() => resolveWorldConfig({ mutationRateGeneScale: { schedule: [[0, 64], [2000, 16]] } }));
    assert.doesNotThrow(() => resolveWorldConfig({ foodReseedWhenEmpty: { schedule: [[0, false], [1000, true]] } }));
    // malformed step VALUES rejected (per-step, via eachVal)
    assert.throws(() => resolveWorldConfig({ mutationRateGeneScale: { schedule: [[0, 64], [2000, 0]] } }), /positive finite/);
    assert.throws(() => resolveWorldConfig({ mutationRateGeneScale: { schedule: [[0, -8]] } }), /positive finite/);
    assert.throws(() => resolveWorldConfig({ foodReseedWhenEmpty: { schedule: [[0, false], [10, 1]] } }), /must be a boolean/);
    // malformed schedule FORM still rejected (descending ticks)
    assert.throws(() => resolveWorldConfig({ mutationRateGeneScale: { schedule: [[2000, 16], [0, 64]] } }), /ascending/);
});

test('mutationRateGeneScale schedule: deterministic, and diverges from constant ONLY after T', async () => {
    const { makeStandardWorld } = await load();
    const T = 2000;
    const mk = (scale) => makeStandardWorld(3, { settings: { evolvableMutationRate: true, mutationRateGeneScale: scale } }).world;

    // deterministic: same seed + same schedule -> identical
    const sched = () => ({ schedule: [[0, 64], [T, 16]] });
    assert.equal(hashAt(mk(sched()), 4000), hashAt(mk(sched()), 4000), 'scheduled run is reproducible');

    // BEFORE T: schedule holds 64, identical to the constant-64 run
    assert.equal(hashAt(mk(64), T - 1), hashAt(mk(sched()), T - 1), 'identical to constant up to T-1');
    // AFTER T: the schedule switches to 16, so births past T mutate differently -> diverges
    assert.notEqual(hashAt(mk(64), 5000), hashAt(mk(sched()), 5000), 'diverges from constant after T');
});

test('foodReseedWhenEmpty schedule: off before T (stays empty), on after T (recovers)', async () => {
    const { World, resolveWorldConfig } = await load();
    const empty = (spec) => new World(resolveWorldConfig({
        pool: { left: 0, top: 0, right: 1000, bottom: 1000 }, foodRegenerationPeriod: 10, maxFood: 100, numFoodTypes: 1,
        foodReseedWhenEmpty: spec,
    }), 42, {});

    // scheduled OFF until tick 500, then ON
    const w = empty({ schedule: [[0, false], [500, true]] });
    for (let t = 0; t < 300; t++) w.tick();
    assert.equal(w.getLivingFoodCount(), 0, 'before T: reseed off -> pool stays empty (absorbing)');
    for (let t = 300; t < 900; t++) w.tick();
    assert.ok(w.getLivingFoodCount() > 0, 'after T: reseed on -> food recovers');

    // a schedule that is constantly-on behaves like the plain flag
    const on = empty({ schedule: [[0, true]] });
    for (let t = 0; t < 200; t++) on.tick();
    assert.ok(on.getLivingFoodCount() > 0, 'schedule [[0,true]] recovers like on');
});
