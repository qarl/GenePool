'use strict';
// Phase 1 (scrub/playback): the run DATABASE (tools/events/run-db.mjs). Proves the storage layer preserves the
// Phase-0 codec end-to-end -- a keyframe stored as a gzipped BLOB and read back through the reader still restores
// bit-for-bit, and any exact tick reconstructs as restore(nearest keyframe) + resim -- plus crash-safe frontier
// semantics (readers clamp to it), config round-trip (S2), and bounded reader queries (N4).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { boot } = require('../helpers/boot');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};
function makeWorld(seed, onEvent) {
    const gp = boot(42); const pd = gp.getPoolData();
    const world = new World(CONFIG, seed, onEvent ? { onEvent } : undefined);
    for (const s of pd.swimbotArray) world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });
    return world;
}
const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

test('run-db: gzipped keyframes reconstruct bit-for-bit through the reader; frontier/config/queries hold', async () => {
    const { openRunWriter, openRunReader } = await import('../../tools/events/run-db.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'gp-rundb-'));
    const path = join(dir, 'run-7.db');
    try {
        const KEYF = 200, STATS = 100, TOTAL = 800, SEED = 7;
        const w = openRunWriter(path, { seed: SEED, config: CONFIG, keyframeInterval: KEYF, statsInterval: STATS, engineVersion: 'test', perceptionMode: 'mixed-live' });
        const world = makeWorld(SEED, w.onEvent);

        const refKf = new Map();       // keyframe tick -> hash of the continuous run at that tick
        const kfTicks = [];
        const statsAt = (t, world) => ({ tick: t, pop: world.getLivingSwimbotCount(), food: world.getLivingFoodCount() });

        w.writeKeyframe(0, world.serialize(), statsAt(0, world)); refKf.set(0, hash(world)); kfTicks.push(0);
        for (let t = 1; t <= TOTAL; t++) {
            world.tick();
            if (t % KEYF === 0) { w.writeKeyframe(t, world.serialize(), statsAt(t, world)); refKf.set(t, hash(world)); kfTicks.push(t); }
            else if (t % STATS === 0) { w.writeStats(t, statsAt(t, world)); }
        }
        w.finish();
        w.close();

        // ---- read back ----
        const r = openRunReader(path);
        try {
            assert.equal(r.frontier(), TOTAL, 'frontier should be the last written tick');
            assert.equal(r.meta('done'), '1', 'done flag should be set by finish()');

            // config round-trip (S2): the reader restores with the RUN's seed+config, not viewer defaults
            const rc = r.runConfig();
            assert.equal(rc.seed, SEED, 'runConfig.seed');
            assert.deepEqual(rc.config, CONFIG, 'runConfig.config round-trips exactly');

            // (a) every stored gzipped keyframe restores to exactly the continuous state at its tick
            for (const kt of kfTicks) {
                const got = r.getKeyframe(kt);
                assert.equal(got.tick, kt, `getKeyframe(${kt}) should return the keyframe AT ${kt}`);
                assert.equal(hash(World.restore(CONFIG, got.snapshot)), refKf.get(kt), `gz keyframe @ ${kt} != continuous`);
            }

            // getKeyframe(T) returns the NEAREST keyframe <= T
            assert.equal(r.getKeyframe(250).tick, 200, 'nearest keyframe <= 250 is 200');
            assert.equal(r.getKeyframe(199).tick, 0, 'nearest keyframe <= 199 is 0');

            // (b) exact-tick reconstruction: restore(nearest kf) + resim remainder == a fresh continuous run to T
            const T = 550;
            const cont = makeWorld(SEED); for (let t = 0; t < T; t++) cont.tick();
            const kf = r.getKeyframe(T);                        // -> keyframe @ 400
            const C = World.restore(CONFIG, kf.snapshot);
            for (let t = kf.tick; t < T; t++) C.tick();          // resim 400 -> 550
            assert.equal(hash(C), hash(cont), `restore(kf@${kf.tick}) + resim to ${T} != continuous @ ${T}`);

            // stats: nearest stats row <= T, and the panel is available instantly at a keyframe
            assert.equal(r.getStats(250).tick, 200, 'nearest stats <= 250 is 200');
            assert.equal(r.getStats(150).tick, 100, 'nearest stats <= 150 is 100 (dense cadence)');
            assert.equal(r.getStats(800).stats.pop, world.getLivingSwimbotCount(), 'stats@frontier pop matches live');

            // frontier clamp: asking beyond the frontier returns the frontier keyframe, never null/garbage
            assert.equal(r.getKeyframe(999999).tick, 800, 'getKeyframe clamps to frontier');

            // no duplicate keyframe rows (INSERT OR REPLACE / one-row-per-tick)
            const nSnaps = r.db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
            assert.equal(nSnaps, kfTicks.length, 'one snapshot row per keyframe tick');

            // getPopSeries is bounded and ordered
            const series = r.getPopSeries({ maxPoints: 5 });
            assert.ok(series.length <= 5, 'getPopSeries respects maxPoints');
            assert.ok(series.every((row, i) => i === 0 || row.tick > series[i - 1].tick), 'pop series is tick-ordered');
        } finally { r.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
