'use strict';
// Keyframe thinning (Karl: budget 500): keyframes are restore anchors, so old ones can be dropped -- any tick is still
// reachable by restore-nearest + resim. This proves the "halve the oldest half over budget" scheme keeps the count
// bounded, preserves keyframe-0 + the newest (dense recent), and STILL reconstructs bit-for-bit from the thinned set.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { hashEntities } = require('../helpers/p1a-golden');
const { World } = require('../../engine/world.js');

const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

test('keyframe thinning: count stays <= budget, keyframe-0 + newest kept, reconstruction holds', async () => {
    const { generateRun, buildWorld } = await import('../../tools/scrub/run-gen.mjs');
    const { openRunReader } = await import('../../tools/events/run-db.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'gp-thin-'));
    const path = join(dir, 'run.db');
    const SEED = 7, N = 200, POOL = 3000, KEYF = 100, BUDGET = 20, TICKS = 6000;   // 60 keyframes -> thinning fires
    try {
        generateRun(path, SEED, { ticks: TICKS, keyframeInterval: KEYF, statsInterval: KEYF, tickThrottle: 100, keyframeBudget: BUDGET, n: N, pool: POOL });
        const r = openRunReader(path);
        try {
            const ticks = r.db.prepare('SELECT tick FROM snapshots ORDER BY tick').all().map(x => x.tick);
            const n = ticks.length;
            assert.ok(n <= BUDGET, `keyframe count ${n} must be <= budget ${BUDGET}`);
            assert.ok(n >= 5, `should retain a healthy count, got ${n}`);
            assert.equal(ticks[0], 0, 'keyframe-0 (the seed state) must survive thinning');
            assert.equal(ticks[n - 1], TICKS, 'the newest keyframe (frontier) must survive');
            // EVEN SPREAD over the WHOLE timeline (Karl): every era keeps keyframes -> no gap spans a big fraction of the
            // run (old closely-packed keyframes are thinned onto a uniform grid; early history is NOT deleted).
            const gaps = []; for (let i = 1; i < n; i++) gaps.push(ticks[i] - ticks[i - 1]);
            const maxGap = Math.max(...gaps);
            assert.ok(maxGap <= TICKS / 3, `no era should be missing: max keyframe gap ${maxGap} must be <= ${(TICKS / 3).toFixed(0)}`);
            assert.ok(ticks[1] <= TICKS / 3, `early history must be kept (2nd keyframe at ${ticks[1]})`);

            // reconstruction still bit-identical from the THINNED set: restore nearest kf + resim == continuous
            const contAt = (T) => { const { world } = buildWorld(SEED, { n: N, pool: POOL }); for (let i = 0; i < T; i++) world.tick(); return world; };
            for (const T of [0, 3050, TICKS]) {
                const kf = r.getKeyframe(T);
                assert.ok(kf && kf.tick <= T, `a keyframe <= ${T} must exist`);
                const C = World.restore(r.runConfig().config, kf.snapshot);
                for (let t = kf.tick; t < T; t++) C.tick();
                assert.equal(hash(C), hash(contAt(T)), `thinned reconstruction diverged at ${T} (from kf@${kf.tick})`);
            }
        } finally { r.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
