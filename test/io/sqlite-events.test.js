'use strict';
// P5: the engine's event stream -> a real, queryable SQLite DB (node:sqlite, no dependency). Runs a sim with
// the SQLite sink, then QUERIES the DB and cross-checks against the engine's own actuals -- proving the DB
// faithfully captures the run and supports real analytical queries (population trajectory, lineages).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('../helpers/boot');
const { World } = require('../../engine/world.js');
const { createSqliteSink, writeRunMeta } = require('../../tools/events/sqlite-sink.mjs');

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};

test('sqlite sink: the DB captures the run and answers analytical queries', () => {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const sink = createSqliteSink(':memory:');
    const world = new World(CONFIG, 7, { onEvent: sink.onEvent });
    writeRunMeta(sink.db, { seed: 7, config: CONFIG });
    const founderIds = new Set();
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
        founderIds.add(s.id);
    }
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });

    const startId = world.getNextSwimbotId();
    const TICKS = 700;
    for (let t = 0; t < TICKS; t++) world.tick();
    sink.flush(); // write pending events but keep the DB open for querying (close() would close it)
    const db = sink.db;

    const one = (sql) => db.prepare(sql).get();
    // counts in the DB must equal the engine's own accounting
    assert.equal(one('SELECT count(*) c FROM births').c, world.getNextSwimbotId() - startId, 'births table != actual births');
    assert.equal(one('SELECT count(*) c FROM deaths').c, world.getNumDeadSwimbots(), 'deaths table != actual deaths');
    assert.equal(one('SELECT count(*) c FROM ticks').c, TICKS, 'ticks table != number of ticks');
    assert.ok(one('SELECT count(*) c FROM eats').c > 0, 'no eat rows recorded');

    // population trajectory query: the last tick row must equal the live population
    const lastTick = db.prepare('SELECT tick, pop, food FROM ticks ORDER BY tick DESC LIMIT 1').get();
    assert.equal(lastTick.tick, TICKS);
    assert.equal(lastTick.pop, world.getLivingSwimbotCount(), 'ticks.pop != live count at end');
    assert.equal(lastTick.food, world.getLivingFoodCount(), 'ticks.food != live food at end');

    // lineage integrity: every birth's parent and mate must be a founder or a previously-born swimbot
    const bornBefore = new Set(founderIds);
    for (const b of db.prepare('SELECT tick, id, parentId, mateId FROM births ORDER BY id').all()) {
        assert.ok(bornBefore.has(b.parentId), `birth ${b.id}: parent ${b.parentId} never existed`);
        assert.ok(bornBefore.has(b.mateId), `birth ${b.id}: mate ${b.mateId} never existed`);
        bornBefore.add(b.id);
    }

    // an actual analytical query works: most prolific parents
    const topParents = db.prepare('SELECT parentId, count(*) n FROM births GROUP BY parentId ORDER BY n DESC LIMIT 3').all();
    assert.ok(topParents.length > 0 && topParents[0].n >= 1, 'group-by lineage query returned nothing');

    // run_meta round-trips
    assert.equal(one("SELECT value v FROM run_meta WHERE key='seed'").v, '7');
});
