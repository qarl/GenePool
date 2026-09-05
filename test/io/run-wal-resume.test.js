'use strict';
// Phase 3 (scrub/playback) -- the panel's "riskiest new machinery", gated in Node (no Electron):
//   (1) WAL concurrency (S3): a SEPARATE read-only connection sees the writer's freshly-committed keyframes/frontier
//       promptly, with no reopen and no SQLITE_BUSY -- proving main can scrub a run the generator is still writing.
//   (2) crash-resume (S4): reopening a PARTIAL run truncates everything past the last durable keyframe and continues,
//       producing a run BIT-IDENTICAL to one that was never interrupted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());
const SEED = 7, N = 600, POOL = 8000, KEYF = 200, STATS = 100, THROTTLE = 100;

test('WAL (S3): a read-only reader sees the writer\'s fresh commits, no reopen, no BUSY', async () => {
    const { openRunWriter, openRunReader } = await import('../../tools/events/run-db.mjs');
    const { buildWorld } = await import('../../tools/scrub/run-gen.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'gp-wal-'));
    const path = join(dir, 'run.db');
    try {
        const { world, config } = buildWorld(SEED, { n: N, pool: POOL });
        const w = openRunWriter(path, { seed: SEED, config, keyframeInterval: KEYF, statsInterval: STATS, perceptionMode: 'mixed-live' });
        w.writeKeyframe(0, world.serialize(), { tick: 0, pop: world.getLivingSwimbotCount() });

        // open the reader AFTER the file exists + WAL is set + first commit is durable (the "db ready" handshake, S3)
        const r = openRunReader(path);
        try {
            assert.equal(r.frontier(), 0, 'reader sees the initial frontier');
            let lastFrontier = 0;
            for (let t = 1; t <= 600; t++) {
                world.tick();
                if (t % KEYF === 0) w.writeKeyframe(t, world.serialize(), { tick: t, pop: world.getLivingSwimbotCount() });
                else if (t % STATS === 0) w.writeStats(t, { tick: t, pop: world.getLivingSwimbotCount() });
                if (t % STATS === 0) {
                    const f = r.frontier();                       // SAME read-only connection, no reopen
                    assert.equal(f, t, `reader frontier should track the writer (saw ${f}, expected ${t})`);
                    assert.ok(f >= lastFrontier, 'frontier is monotonic'); lastFrontier = f;
                }
            }
            // the reader can reconstruct a mid-run keyframe the writer produced while it was open
            const kf = r.getKeyframe(400);
            assert.equal(kf.tick, 400, 'reader sees keyframe @400 committed after it opened');
            const contAt = (T) => { const { world } = buildWorld(SEED, { n: N, pool: POOL }); for (let i = 0; i < T; i++) world.tick(); return world; };
            assert.equal(hash(World.restore(config, kf.snapshot)), hash(contAt(400)), 'live-read keyframe reconstructs correctly');
        } finally { r.close(); }
        w.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume (S4): reopening a partial run truncates past the last keyframe and continues bit-identically', async () => {
    const { openRunWriter, openRunReader } = await import('../../tools/events/run-db.mjs');
    const { generateRun, buildWorld } = await import('../../tools/scrub/run-gen.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'gp-resume-'));
    const partial = join(dir, 'run-partial.db');
    const K1 = 500, K2 = 800;   // partial to 500 (last keyframe 400, frontier 500) -> resume -> 800
    try {
        // ---- build a PARTIAL run to K1 and DON'T finish (simulates a kill): frontier=500 > last keyframe=400,
        //      so there are stats/event rows past the last keyframe that resume must truncate. ----
        {
            const { world, config } = buildWorld(SEED, { n: N, pool: POOL });
            const w = openRunWriter(partial, { seed: SEED, config, keyframeInterval: KEYF, statsInterval: STATS, perceptionMode: 'mixed-live' });
            world._onEvent = (e) => { if (e.type === 'tick' && (e.tick % THROTTLE) !== 0) return; w.onEvent(e); };
            w.writeKeyframe(0, world.serialize(), { tick: 0, pop: world.getLivingSwimbotCount() });
            for (let t = 1; t <= K1; t++) {
                world.tick();
                if (t % KEYF === 0) w.writeKeyframe(t, world.serialize(), { tick: t, pop: world.getLivingSwimbotCount() });
                else if (t % STATS === 0) w.writeStats(t, { tick: t, pop: world.getLivingSwimbotCount() });
            }
            w.close();  // no finish() -> partial run (done stays 0)
        }
        // sanity: the partial really has rows past the last keyframe (something to truncate)
        {
            const r = openRunReader(partial);
            assert.equal(r.frontier(), K1, 'partial frontier advanced past the last keyframe (stats-only)');
            assert.equal(r.meta('done'), '0', 'partial run is not marked done');
            assert.equal(r.db.prepare('SELECT MAX(tick) m FROM snapshots').get().m, 400, 'last durable keyframe is 400');
            r.close();
        }

        // ---- RESUME the partial to K2 (restores from keyframe 400, truncates 401..500, continues) ----
        const res = generateRun(partial, SEED, { ticks: K2, keyframeInterval: KEYF, statsInterval: STATS, tickThrottle: THROTTLE, n: N, pool: POOL, resume: true });
        assert.equal(res.resumed, true, 'generateRun reported a resume');
        assert.equal(res.resumedTick, 400, 'resumed from the last durable keyframe (400)');

        // ---- an UNINTERRUPTED run to K2 for reference ----
        const ref = join(dir, 'run-ref.db');
        generateRun(ref, SEED, { ticks: K2, keyframeInterval: KEYF, statsInterval: STATS, tickThrottle: THROTTLE, n: N, pool: POOL });

        // ---- the resumed run must be BIT-IDENTICAL to the uninterrupted one ----
        const rp = openRunReader(partial), rr = openRunReader(ref);
        try {
            assert.equal(rp.frontier(), K2, 'resumed run reached K2');
            assert.equal(rp.meta('done'), '1', 'resumed run is finished');
            const config = rr.runConfig().config;
            // final state identical
            assert.equal(hash(World.restore(config, rp.getKeyframe(K2).snapshot)), hash(World.restore(config, rr.getKeyframe(K2).snapshot)), 'resumed final state != uninterrupted');
            // no torn rows survived: one snapshot row per keyframe tick, none past K2
            assert.equal(rp.db.prepare('SELECT COUNT(*) c FROM snapshots').get().c, K2 / KEYF + 1, 'resumed run has exactly the right keyframes (no dups/torn rows)');
            assert.equal(rp.db.prepare('SELECT COUNT(*) c FROM snapshots WHERE tick > ?').get(K2).c, 0, 'no snapshot rows past K2');
        } finally { rp.close(); rr.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
