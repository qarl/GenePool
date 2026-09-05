'use strict';
// Phase 2 (scrub/playback) GO/NO-GO: the headless generator (tools/scrub/run-gen.mjs) writes a run .db that
// reconstructs bit-for-bit -- restore(nearest keyframe) + resim == a fresh deterministic run to the same tick,
// restoring with the run's OWN stored config (S2, not test defaults). No Electron, no GUI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

test('run-gen: generated .db reconstructs bit-for-bit against a fresh continuous run (S2 config from run_meta)', async () => {
    const { generateRun, buildWorld } = await import('../../tools/scrub/run-gen.mjs');
    const { openRunReader } = await import('../../tools/events/run-db.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'gp-rungen-'));
    const path = join(dir, 'run-7.db');
    const SEED = 7, N = 600, POOL = 8000, TICKS = 600, KEYF = 200, STATS = 100;
    try {
        const summary = generateRun(path, SEED, { ticks: TICKS, keyframeInterval: KEYF, statsInterval: STATS, n: N, pool: POOL });
        assert.equal(summary.keyframes, TICKS / KEYF + 1, 'keyframe count = ticks/interval + keyframe-0');

        const r = openRunReader(path);
        try {
            assert.equal(r.frontier(), TICKS, 'frontier = last tick');
            assert.equal(r.meta('done'), '1', 'done flag set');
            assert.equal(r.meta('perceptionMode'), 'mixed-live', 'run records its perception mode');
            const rc = r.runConfig();
            assert.equal(rc.seed, SEED, 'stored seed');

            // (a) a stored keyframe restores to exactly the continuous run at its tick
            const contAt = (T) => { const { world } = buildWorld(SEED, { n: N, pool: POOL }); for (let t = 0; t < T; t++) world.tick(); return world; };
            const kf400 = r.getKeyframe(400);
            assert.equal(kf400.tick, 400, 'keyframe @ 400');
            assert.equal(hash(World.restore(rc.config, kf400.snapshot)), hash(contAt(400)), 'keyframe @400 != continuous (restore w/ stored config)');

            // (b) exact between-keyframe tick: restore(nearest kf) + resim == continuous, all via the run's stored config
            const T = 550;
            const kf = r.getKeyframe(T);                 // -> kf @ 400
            const C = World.restore(rc.config, kf.snapshot);
            for (let t = kf.tick; t < T; t++) C.tick();
            assert.equal(hash(C), hash(contAt(T)), `restore(kf@${kf.tick})+resim to ${T} != continuous @ ${T}`);

            // the run actually evolved (real dynamics crossed): births happened, pop is alive
            assert.ok(summary.finalPop > 0, 'run went extinct');
            assert.ok(r.getStats(T).stats.pop > 0, 'stats row has a live population');
        } finally { r.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
