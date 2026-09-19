'use strict';
// Parameter-timeline MVP step 2: the persistence commit (commitParamEdit) + the schedule-builder (withKeyframe).
// The load-bearing proof is SCRUB-IDENTITY: a run generated straight-through with a schedule is byte-identical to a
// constant run that is edited at T and then resumed -- i.e. the "change parameters" commit + resume reproduces the
// timeline exactly. Plus withKeyframe invariants (I1 baseline / I7 replace-on-equal / I8 default) and the commit's
// truncation rules (I2 anchor incl. the T=0 case; I3/I5 config written + frontier/done).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const load = async () => ({
    ...(await import('../../engine/config.js')),
    ...(await import('../../tools/events/run-db.mjs')),
    ...(await import('../../tools/scrub/run-gen.mjs')),
    ...(await import('../../engine/pool-seed.mjs')),
});
const tmp = () => mkdtempSync(join(tmpdir(), 'gp-commit-'));

test('withKeyframe: I8 default, I1 baseline, T=0 collapse, I7 replace-on-equal + keep-later', async () => {
    const { withKeyframe } = await load();
    // absent spec -> uses default as the baseline (I8), keeps old value before T (I1)
    assert.deepEqual(withKeyframe(undefined, 2000, 16, 64), { schedule: [[0, 64], [2000, 16]] });
    // scalar spec -> baseline is the scalar
    assert.deepEqual(withKeyframe(64, 2000, 16, 64), { schedule: [[0, 64], [2000, 16]] });
    // tick 0 collapses to a single step (no double-seed)
    assert.deepEqual(withKeyframe(64, 0, 16, 64), { schedule: [[0, 16]] });
    // existing schedule: insert ordered, keep later steps
    assert.deepEqual(withKeyframe({ schedule: [[0, 64], [5000, 8]] }, 2000, 16, 64),
        { schedule: [[0, 64], [2000, 16], [5000, 8]] });
    // re-edit the same tick replaces (no duplicate)
    assert.deepEqual(withKeyframe({ schedule: [[0, 64], [2000, 16]] }, 2000, 32, 64),
        { schedule: [[0, 64], [2000, 32]] });
});

test('commitParamEdit: truncates at T, writes config, rewinds frontier (T>0 and T=0)', async () => {
    const { generateRun, commitParamEdit, openRunReader, poolConfig, withKeyframe } = await load();
    const dir = tmp(); const path = join(dir, 'seed-5.db');
    generateRun(path, 5, { ticks: 6000, keyframeInterval: 2000, settings: { evolvableMutationRate: true } });

    // edit mutationRateGeneScale at T=2500 (not on the keyframe grid)
    const base = poolConfig(3000, { evolvableMutationRate: true });
    const edited = { ...base, mutationRateGeneScale: withKeyframe(base.mutationRateGeneScale, 2500, 16, 64) };
    const { anchor } = commitParamEdit(path, { newRunConfig: { seed: 5, config: edited }, tick: 2500 });
    assert.equal(anchor, 2000, 'T=2500 -> newest surviving keyframe is 2000 (< T)');

    const r = openRunReader(path);
    const ticks = r.db.prepare('SELECT tick FROM snapshots ORDER BY tick').all().map((x) => x.tick);
    assert.ok(ticks.every((t) => t < 2500) && ticks.includes(2000) && ticks.includes(0), 'kept keyframes < 2500');
    assert.equal(r.frontier(), 2000, 'frontier rewound to the anchor');
    assert.equal(r.meta('done'), '0', 'done cleared');
    assert.deepEqual(r.runConfig().config.mutationRateGeneScale, { schedule: [[0, 64], [2500, 16]] }, 'runConfig updated');
    assert.equal(r.meta('config') && JSON.parse(r.meta('config')).mutationRateGeneScale.schedule.length, 2, 'plain config key synced');
    r.close();
});

test('commitParamEdit: T=0 deletes ALL keyframes (generator re-seeds on resume)', async () => {
    const { generateRun, commitParamEdit, openRunReader, poolConfig, withKeyframe } = await load();
    const dir = tmp(); const path = join(dir, 'seed-6.db');
    generateRun(path, 6, { ticks: 4000, keyframeInterval: 2000, settings: { evolvableMutationRate: true } });
    const base = poolConfig(3000, { evolvableMutationRate: true });
    const edited = { ...base, mutationRateGeneScale: withKeyframe(base.mutationRateGeneScale, 0, 16, 64) };
    const { anchor } = commitParamEdit(path, { newRunConfig: { seed: 6, config: edited }, tick: 0 });
    assert.equal(anchor, -1, 'T=0 anchor is pre-seed (-1)');
    const r = openRunReader(path);
    const ticks = r.db.prepare('SELECT tick FROM snapshots ORDER BY tick').all().map((x) => x.tick);
    assert.deepEqual(ticks, [], 'no keyframes remain -> the run re-seeds from the edited config on resume');
    assert.equal(r.frontier(), -1);
    r.close();
    // resume actually re-seeds a fresh keyframe-0 under the edited config
    generateRun(path, 6, { ticks: 2000, keyframeInterval: 2000, resume: true });
    const r2 = openRunReader(path);
    assert.ok(r2.getKeyframe(0), 'keyframe-0 re-seeded on resume');
    r2.close();
});

test('parameter keyframes survive: editing at T1 keeps an existing param-keyframe at T2 > T1', async () => {
    // Parameter keyframes live in the run's stored config (schedule steps), NOT in the snapshot table -- so the
    // snapshot deletion (commitParamEdit / thinning) never removes them, and withKeyframe keeps later steps.
    const { generateRun, commitParamEdit, openRunReader, poolConfig, withKeyframe } = await load();
    const dir = tmp(); const path = join(dir, 'seed-7.db');
    generateRun(path, 7, { ticks: 6000, keyframeInterval: 2000, settings: { evolvableMutationRate: true } });

    // edit #1 at T2=4000
    let stored = openRunReader(path).runConfig().config;
    let cfg = { ...stored, mutationRateGeneScale: withKeyframe(stored.mutationRateGeneScale, 4000, 16, 64) };
    commitParamEdit(path, { newRunConfig: { seed: 7, config: cfg }, tick: 4000 });
    // edit #2 at an EARLIER tick T1=2000
    stored = openRunReader(path).runConfig().config;
    cfg = { ...stored, mutationRateGeneScale: withKeyframe(stored.mutationRateGeneScale, 2000, 32, 64) };
    commitParamEdit(path, { newRunConfig: { seed: 7, config: cfg }, tick: 2000 });

    const r = openRunReader(path);
    assert.deepEqual(r.runConfig().config.mutationRateGeneScale,
        { schedule: [[0, 64], [2000, 32], [4000, 16]] },
        'the 4000 parameter keyframe survived the earlier 2000 edit (not deleted)');
    r.close();
});

test('SCRUB-IDENTITY: straight-through schedule == constant edited-at-T then resumed', async () => {
    const { generateRun, commitParamEdit, openRunReader, poolConfig, withKeyframe } = await load();
    const T = 2500, END = 6000, SEED = 3;
    const sched = { schedule: [[0, 64], [T, 16]] };

    // A: generated straight through WITH the schedule
    const dirA = tmp(); const pA = join(dirA, 'a.db');
    generateRun(pA, SEED, { ticks: END, keyframeInterval: 2000, settings: { evolvableMutationRate: true, mutationRateGeneScale: sched } });

    // B: generated constant (64), then edited at T, then RESUMED to END
    const dirB = tmp(); const pB = join(dirB, 'b.db');
    generateRun(pB, SEED, { ticks: END, keyframeInterval: 2000, settings: { evolvableMutationRate: true } });
    const base = poolConfig(3000, { evolvableMutationRate: true });
    const edited = { ...base, mutationRateGeneScale: withKeyframe(base.mutationRateGeneScale, T, 16, 64) };
    commitParamEdit(pB, { newRunConfig: { seed: SEED, config: edited }, tick: T });
    generateRun(pB, SEED, { ticks: END, keyframeInterval: 2000, resume: true }); // resume from the anchor under the new schedule

    const A = openRunReader(pA), B = openRunReader(pB);
    const snapA = A.getKeyframe(END).snapshot, snapB = B.getKeyframe(END).snapshot;
    A.close(); B.close();
    assert.equal(JSON.stringify(snapA), JSON.stringify(snapB),
        'edit+resume reproduces the straight-through scheduled run byte-for-byte at END');
});

test('FOUNDER RE-SEED: evolvable-on-from-start == off, then flipped on AT TICK 0, then resumed', async () => {
    const { generateRun, commitParamEdit, openRunReader, poolConfig, withKeyframe } = await load();
    const END = 6000, SEED = 3;

    // A: evolvable-mutation ON from founding (byte-255 randomized in founders)
    const dirA = tmp(); const pA = join(dirA, 'a.db');
    generateRun(pA, SEED, { ticks: END, keyframeInterval: 2000, settings: { evolvableMutationRate: true } });

    // B: OFF from founding (byte-255 zeroed), then edit evolvable-mutation -> ON at tick 0 (re-seeds), then resume
    const dirB = tmp(); const pB = join(dirB, 'b.db');
    generateRun(pB, SEED, { ticks: END, keyframeInterval: 2000, settings: {} });
    const base = poolConfig(3000, {});
    const edited = { ...base, evolvableMutationRate: withKeyframe(base.evolvableMutationRate, 0, true, false) };
    const { anchor } = commitParamEdit(pB, { newRunConfig: { seed: SEED, config: edited }, tick: 0 });
    assert.equal(anchor, -1, 'tick-0 edit rewinds to pre-seed');
    generateRun(pB, SEED, { ticks: END, keyframeInterval: 2000, resume: true });   // re-seeds founders under evolvable=on

    const A = openRunReader(pA), B = openRunReader(pB);
    // founders themselves match (the re-seed produced the diverse-random byte-255 founders), and so does END
    assert.equal(JSON.stringify(A.getKeyframe(0).snapshot), JSON.stringify(B.getKeyframe(0).snapshot), 'founders re-seeded identically');
    assert.equal(JSON.stringify(A.getKeyframe(END).snapshot), JSON.stringify(B.getKeyframe(END).snapshot), 'whole run reproduced');
    A.close(); B.close();
});

test('commitImport: imported state becomes keyframe-T, future invalidated, resume is deterministic + lockstep', async () => {
    // Import = "branch the run at the playhead". Proves: (1) keyframes >= T are dropped and the imported frame is stored
    // AS keyframe-T with clock forced to T; (2) keyframes < T survive; (3) config is adopted; (4) resuming forward is
    // deterministic AND matches restore-keyframe-T-then-tick (the lockstep the viewer relies on to scrub past the import).
    const { generateRun, commitImport, openRunReader, poolConfig, buildWorld } = {
        ...(await import('../../tools/scrub/run-gen.mjs')),
        ...(await import('../../tools/events/run-db.mjs')),
        ...(await import('../../engine/config.js')),
        ...(await import('../../engine/pool-seed.mjs')),
    };
    const { World } = await import('../../engine/world.js');
    const T = 4000, END = 8000, HOST = 5, GUEST = 12;

    const dir = tmp(); const path = join(dir, 'seed-5.db');
    generateRun(path, HOST, { ticks: 6000, keyframeInterval: 2000, settings: { evolvableMutationRate: true } });

    // an INDEPENDENT world (a different seed, ticked a bit) is the "imported pool"
    const guestCfg = poolConfig(3000, { evolvableMutationRate: true });
    const { world: guest } = (await import('../../engine/pool-seed.mjs')).makeStandardWorld(GUEST, { config: guestCfg });
    for (let i = 0; i < 1500; i++) guest.tick();
    const importedSnap = guest.serialize();

    const { anchor } = commitImport(path, { newRunConfig: { seed: HOST, config: guestCfg }, tick: T, snapshot: importedSnap });
    assert.equal(anchor, T, 'anchor is the import tick');

    let r = openRunReader(path);
    const kept = r.db.prepare('SELECT tick FROM snapshots ORDER BY tick').all().map((x) => x.tick);
    assert.ok(kept.includes(0) && kept.includes(2000) && kept.includes(T), 'keyframes <T survive; T inserted');
    assert.ok(kept.every((t) => t <= T), 'no keyframe past T');
    assert.equal(r.frontier(), T, 'frontier rewound to T');
    const kfT = r.getKeyframe(T).snapshot;
    assert.equal(kfT.clock, T, 'imported snapshot clock forced to T');
    assert.equal(JSON.stringify(kfT), JSON.stringify({ ...importedSnap, clock: T }), 'keyframe-T is the imported frame (clock=T)');
    assert.deepEqual(r.runConfig().config, guestCfg, 'imported config adopted');
    r.close();

    // resume-generate forward from the import, twice -> identical (deterministic branch)
    generateRun(path, HOST, { ticks: END, keyframeInterval: 2000, resume: true });
    r = openRunReader(path);
    const genEnd = r.getKeyframe(END).snapshot;
    r.close();

    // lockstep: restore keyframe-T and tick (END-T) forward under the adopted config -> byte-identical to the stored END
    const w = World.restore(guestCfg, { ...importedSnap, clock: T });
    for (let i = 0; i < END - T; i++) w.tick();
    assert.equal(JSON.stringify(w.serialize()), JSON.stringify(genEnd),
        'restore-keyframe-T-then-tick == generator END (viewer scrubs past the import in lockstep)');
});
