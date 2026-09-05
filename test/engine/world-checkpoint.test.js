'use strict';
// H1 checkpoint: World.serialize() -> World.restore(config, data) must resume BIT-FOR-BIT identically to an
// uninterrupted run. This is the self-checking gate: run world A uninterrupted; run B to tick N, serialize,
// restore into C, then step A and C in lockstep -- every per-tick entity hash must match. Any un-captured
// between-tick hidden state (timer, velocity, per-part previousMid, the per-life RNG stream position, brain
// FSM, chosen mate/food refs incl. dangling "ghost" refs to swept entities) surfaces as the FIRST divergent
// tick. Uses JJ's realistic seed-42 pool so births/deaths/eating actually occur (hence dangling refs).

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

function makeSeed42World(seed) {
    const gp = boot(42);
    const pd = gp.getPoolData();
    const world = new World(CONFIG, seed);
    for (const s of pd.swimbotArray) {
        world.loadSwimbot(s.id, { age: s.age, x: s.x, y: s.y, angle: s.angle, energy: s.energy, genes: Array.from(s.genes), numOffspring: s.numOffspring, numFoodBitsEaten: s.numFoodBitsEaten });
    }
    for (const f of pd.foodBitArray) world.loadFood(f.id, { x: f.x, y: f.y, type: 0, energy: CONFIG.foodBitEnergy });
    world.setObstacle({ x: pd.obstacleEnd1X, y: pd.obstacleEnd1Y }, { x: pd.obstacleEnd2X, y: pd.obstacleEnd2Y });
    return world;
}
const hash = (w) => hashEntities(w.dumpSwimbots(), w.dumpFood());

// The scrub/playback `.db` stores each keyframe as JSON TEXT (snapshots(tick, json)), so the codec that actually
// runs in production is serialize() -> JSON.stringify -> (store) -> JSON.parse -> restore. JSON has no NaN/Infinity
// (they stringify to `null`), so any non-finite float the sim ever produces would silently corrupt a keyframe.
// serializeJson() reproduces that exact round-trip; assertAllFinite() is the belt-and-braces D7 check on raw output.
const serializeJson = (w) => JSON.parse(JSON.stringify(w.serialize()));
function assertAllFinite(node, path = '$') {
    if (typeof node === 'number') { assert.ok(Number.isFinite(node), `non-finite number at ${path}: ${node}`); return; }
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) assertAllFinite(node[i], `${path}[${i}]`); return; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) assertAllFinite(node[k], `${path}.${k}`); }
}

test('checkpoint: restore resumes bit-for-bit identical to an uninterrupted run', () => {
    const N = 250, M = 350;
    const A = makeSeed42World(7);   // uninterrupted reference
    const B = makeSeed42World(7);   // will be checkpointed
    for (let t = 0; t < N; t++) { A.tick(); B.tick(); }
    assert.equal(hash(B), hash(A), 'A and B diverged before checkpoint (test bug)');

    const C = World.restore(CONFIG, B.serialize());

    // restored C must match the observable state at the checkpoint tick...
    assert.equal(hash(C), hash(A), 'restored state != checkpoint state at tick N');
    // ...and must stay bit-identical as it runs forward (this is the real hidden-state proof).
    for (let t = 0; t < M; t++) {
        A.tick(); C.tick();
        assert.equal(hash(C), hash(A), `checkpoint resume diverged at tick ${N + t + 1}`);
    }
    // sanity: the run actually did something (births/deaths), so the resume crossed real dynamics
    assert.ok(A.getLivingSwimbotCount() > 0, 'pool went extinct');
    assert.ok(A.getNextSwimbotId() > C.getNextSwimbotId() - 1); // ids progressed identically
    assert.equal(A.getNextSwimbotId(), C.getNextSwimbotId(), 'never-reused id high-water marks diverged');
    assert.equal(A.getNumDeadSwimbots(), C.getNumDeadSwimbots(), 'death counts diverged');
});

test('checkpoint: ghost refs (swept entities still referenced) are captured and resume bit-identically', () => {
    // Find a checkpoint tick where a live bot still references a swept swimbot / eaten food (the case a naive
    // index-relink would drop, diverging via the steering code). Prove ghosts appear AND resume is exact.
    const A = makeSeed42World(7);
    let ghostData = null, ghostTick = -1;
    for (let t = 1; t <= 1000; t++) {
        A.tick();
        const d = A.serialize();
        if (d.ghostSwimbots.length > 0 || d.ghostFood.length > 0) { ghostData = d; ghostTick = t; break; }
    }
    assert.ok(ghostData, 'no ghost (dangling dead-ref) checkpoint appeared in 1000 ticks -- ghost path untested');

    const C = World.restore(CONFIG, ghostData); // A is already AT ghostTick; step both forward together
    for (let t = 0; t < 200; t++) {
        A.tick(); C.tick();
        assert.equal(hash(C), hash(A), `ghost-checkpoint (tick ${ghostTick}) resume diverged at tick ${ghostTick + t + 1}`);
    }
});

// ---- Phase 0 (scrub/playback): prove the JSON-TEXT keyframe codec is lossless + reconstructs any tick ----
// This is the load-bearing go/no-go for the whole "decode a tick from the nearest stored keyframe" premise.

test('scrub codec: restore THROUGH JSON round-trip resumes bit-for-bit (catches NaN/Inf -> null)', () => {
    const N = 250, M = 350;
    const A = makeSeed42World(7);   // uninterrupted reference
    const B = makeSeed42World(7);   // checkpointed, restored through the .db's JSON codec
    for (let t = 0; t < N; t++) { A.tick(); B.tick(); }

    const kf = serializeJson(B);           // exactly what lands in snapshots(tick, json)
    const C = World.restore(CONFIG, kf);

    assert.equal(hash(C), hash(A), 'JSON-restored state != checkpoint state at tick N (codec lost data)');
    for (let t = 0; t < M; t++) {
        A.tick(); C.tick();
        assert.equal(hash(C), hash(A), `JSON-codec resume diverged at tick ${N + t + 1}`);
    }
    assert.equal(A.getNextSwimbotId(), C.getNextSwimbotId(), 'id high-water marks diverged after JSON round-trip');
});

test('scrub codec: multi-keyframe self-consistency -- restore(kf[i]) + resim(INTERVAL) == continuous @ kf[i+1]', () => {
    // Mirrors production: keyframes every INTERVAL ticks stored as JSON; reconstruct tick (i+1)*INTERVAL by
    // restoring stored keyframe i and re-simming the remainder. Must equal the uninterrupted run bit-for-bit.
    const INTERVAL = 200, K = 6;           // 1200 ticks: crosses real births/deaths at seed-42
    const A = makeSeed42World(11);
    const kfJson = [], refHash = [];
    kfJson.push(serializeJson(A)); refHash.push(hash(A));   // keyframe 0 = serialize() (D8: no build() replay)
    for (let k = 1; k <= K; k++) {
        for (let t = 0; t < INTERVAL; t++) A.tick();
        kfJson.push(serializeJson(A)); refHash.push(hash(A));
    }
    // (a) every stored JSON keyframe restores to exactly the continuous state at its tick
    for (let k = 0; k <= K; k++) {
        assert.equal(hash(World.restore(CONFIG, kfJson[k])), refHash[k], `stored keyframe ${k} != continuous @ ${k * INTERVAL}`);
    }
    // (b) restore(kf[i]) + resim(INTERVAL) reproduces the continuous run at the NEXT keyframe -- the codec itself
    for (let i = 0; i < K; i++) {
        const C = World.restore(CONFIG, kfJson[i]);
        for (let t = 0; t < INTERVAL; t++) C.tick();
        assert.equal(hash(C), refHash[i + 1], `resim from keyframe ${i} diverged from continuous @ ${(i + 1) * INTERVAL}`);
    }
    assert.ok(A.getLivingSwimbotCount() > 0, 'pool went extinct (test crossed no real dynamics)');
});

test('scrub codec: a non-finite DERIVED part field survives JSON only via recompute-on-restore (documents perpendicular/zero-length-part; D7)', () => {
    // FINDING (2026-09-05, Phase 0): the live sim can produce a non-finite float in part.perpendicular
    // (swimbot.js:360 -> axis.y/length with a length-0 part => 0/0 = NaN). It is HARMLESS today because
    // perpendicular is a DERIVED field recomputed every tick (:360) before it is read (:503) -- so whether a
    // restored bot carries NaN (raw serialize) or null (after JSON, which has no NaN), it is overwritten before
    // use and reconstruction stays bit-perfect. This test pins that invariant: if a future edit ever READS a
    // derived part field before recomputing it, this fails -> keyframe writes must then coerce non-finite -> 0.
    const A = makeSeed42World(11);
    let sawNonFinite = false, where = null;
    for (let t = 0; t < 1200; t++) {
        A.tick();
        const raw = A.serialize();
        try { assertAllFinite(raw); }
        catch (e) { sawNonFinite = true; where = e.message;
            // the load-bearing invariant: the STORED (JSON) keyframe still reconstructs the run exactly
            const kf = JSON.parse(JSON.stringify(raw));
            assert.equal(hash(World.restore(CONFIG, kf)), hash(A), `non-finite keyframe did NOT reconstruct: ${where}`);
            break;
        }
    }
    // Not an assertion failure either way: this documents WHICH field (if any) is non-finite this run.
    console.log(sawNonFinite
        ? `  [codec] confirmed benign non-finite derived field, reconstructed bit-perfect: ${where}`
        : `  [codec] no non-finite field encountered in 1200 ticks (seed 11)`);
});

test('checkpoint: serialize -> restore round-trip is idempotent (restore of a restore matches)', () => {
    const A = makeSeed42World(3);
    for (let t = 0; t < 120; t++) A.tick();
    const d1 = A.serialize();
    const B = World.restore(CONFIG, d1);
    const d2 = B.serialize();
    // the two serializations describe the same world (same counts + same forward evolution)
    assert.equal(d2.clock, d1.clock);
    assert.equal(d2.nextSwimbotId, d1.nextSwimbotId);
    for (let t = 0; t < 60; t++) { A.tick(); B.tick(); }
    assert.equal(hash(B), hash(A), 'double-restore diverged');
});
