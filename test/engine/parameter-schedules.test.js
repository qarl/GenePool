'use strict';
// §10 — PARAMETER SCHEDULES. A schedulable per-pool value may be a scalar (constant) or a step-schedule
// { schedule: [[tick,value],...] } so a world CHANGES over time. Resolution is a pure STEP function of (spec, tick)
// -- no run-state accumulator -- so it is deterministic, byte-identical when unused, and checkpoint-safe.

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function load() {
    const { scheduleValue, validateScheduleForm, resolveWorldConfig } = await import('../../engine/config.js');
    const { World } = await import('../../engine/world.js');
    return { scheduleValue, validateScheduleForm, resolveWorldConfig, World };
}
const FIX = require('../fixtures/jj-macro-seed42.json');
const GENES = FIX.init.swimbots.map(s => Array.from(Buffer.from(s.genes, 'base64')));
const genesOf = (i) => GENES[i % GENES.length];
const POOL = { left: 0, top: 0, right: 1500, bottom: 1500 };

test('scheduleValue: scalar is returned as-is; a schedule steps at its tick boundaries', async () => {
    const { scheduleValue } = await load();
    assert.equal(scheduleValue(20, 0), 20);
    assert.equal(scheduleValue(20, 9999), 20);          // scalar constant
    assert.equal(scheduleValue(Infinity, 5), Infinity); // scalar Infinity (an uncapped ceiling)
    const s = { schedule: [[0, 20], [100, 5], [300, 40]] };
    assert.equal(scheduleValue(s, 0), 20);
    assert.equal(scheduleValue(s, 99), 20);
    assert.equal(scheduleValue(s, 100), 5);             // steps exactly at the tick
    assert.equal(scheduleValue(s, 299), 5);
    assert.equal(scheduleValue(s, 300), 40);
    assert.equal(scheduleValue(s, 99999), 40);          // holds the last value
    assert.equal(scheduleValue({ schedule: [[50, 7]] }, 0), 7); // before the first step -> the first value holds
});

test('validateScheduleForm rejects malformed schedules at config time', async () => {
    const { resolveWorldConfig } = await load();
    assert.throws(() => resolveWorldConfig({ foodRegenerationPeriod: { schedule: [] } }), /at least one/);
    assert.throws(() => resolveWorldConfig({ maxPopulation: { schedule: [[100, 5], [50, 3]] } }), /ascending/);
    assert.throws(() => resolveWorldConfig({ foodSpread: { schedule: [['x', 5]] } }), /tick>=0/);
    assert.throws(() => resolveWorldConfig({ maxFood: { schedule: [[-1, 5]] } }), /tick>=0/);
    // a well-formed schedule + all scalars resolve without throwing
    const r = resolveWorldConfig({ foodRegenerationPeriod: { schedule: [[0, 20], [500, 60]] } });
    assert.deepEqual(r.foodRegenerationPeriod, { schedule: [[0, 20], [500, 60]] });
});

function runIso(World, iso, ticks = 300) {
    const w = new World({ pool: POOL, reproductiveIsolation: iso }, 7);
    for (let i = 0; i < 50; i++) w.loadSwimbot(i, { age: 3000 + i * 7, x: 500 + (i * 13) % 500, y: 500 + (i * 11) % 500, angle: (i * 23) % 360, energy: 85, genes: genesOf(i) });
    for (let i = 0; i < 200; i++) w.loadFood(i, { x: (i * 61) % 1500, y: (i * 97) % 1500, type: 0, energy: 50 });
    for (let t = 0; t < ticks; t++) w.tick();
    return w;
}

test('§10: a scheduled reproductiveIsolation step actually changes the run at its tick', async () => {
    const { World } = await load();
    // permissive throughout vs permissive-then-blocked-at-100 vs blocked throughout -- the scheduled run must
    // differ from BOTH endpoints (it bred before 100 like 0.0, then stopped like 1.0).
    const permissive = runIso(World, 0.0).dumpSwimbots();
    const scheduled = runIso(World, { schedule: [[0, 0.0], [100, 1.0]] }).dumpSwimbots();
    const strict = runIso(World, 1.0).dumpSwimbots();
    assert.notDeepEqual(scheduled, permissive, 'the step at tick 100 must change the outcome vs always-permissive');
    assert.notDeepEqual(scheduled, strict, 'the scheduled run bred before the step, so it must differ from always-strict');
    assert.ok(scheduled.length <= permissive.length && scheduled.length >= strict.length, `scheduled pop ${scheduled.length} should sit between strict ${strict.length} and permissive ${permissive.length}`);
});

test('§10: a schedule is checkpoint-safe (serialize before the step, restore, resume across it == uninterrupted)', async () => {
    const { World } = await load();
    const iso = { schedule: [[0, 0.0], [100, 1.0]] };
    const uninterrupted = runIso(World, iso, 300).dumpSwimbots();

    // run to 90 (before the step), serialize, restore, resume to 300 (crossing the step at 100)
    const w = new World({ pool: POOL, reproductiveIsolation: iso }, 7);
    for (let i = 0; i < 50; i++) w.loadSwimbot(i, { age: 3000 + i * 7, x: 500 + (i * 13) % 500, y: 500 + (i * 11) % 500, angle: (i * 23) % 360, energy: 85, genes: genesOf(i) });
    for (let i = 0; i < 200; i++) w.loadFood(i, { x: (i * 61) % 1500, y: (i * 97) % 1500, type: 0, energy: 50 });
    for (let t = 0; t < 90; t++) w.tick();
    const resumed = World.restore({ pool: POOL, reproductiveIsolation: iso }, w.serialize());
    for (let t = 90; t < 300; t++) resumed.tick();
    assert.deepEqual(resumed.dumpSwimbots(), uninterrupted, 'restore must re-resolve the schedule from the resumed clock -> identical across the step');
});
