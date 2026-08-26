'use strict';
// ViewTracking's camera auto-follow selectors, exercised through the public API
// (gp.setViewMode(mode) -> gp.getSelectedSwimbotID()), mirroring the M-prolific test. Covers the
// three siblings of getMostProlificSwimbot: EFFICIENT (most efficient childless bot), VIRGIN (oldest
// childless bot), HUNGRY (biggest eater). All correctly init to NULL_INDEX; setViewMode/setMode keeps
// the CURRENT selection when a finder returns NULL, so "no candidate" resolves to NULL only when the
// prior selection was already NULL (true at a fresh boot). getPoolData exposes age / numOffspring /
// numFoodBitsEaten, so HUNGRY and VIRGIN are verified precisely; EFFICIENT can only be checked
// structurally (energyEfficiency isn't serialized) -- see its test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');

const GP = loadSim();
// ViewTrackingMode (ViewTracking.js enum): PROLIFIC=4, EFFICIENT=5, VIRGIN=6, HUNGRY=7
const EFFICIENT = 5, VIRGIN = 6, HUNGRY = 7;

// one lived-in pool, snapshotted once; setViewMode recomputes on the (frozen) live state each call.
const gp = boot(42);
step(gp, 1500);
const snap = gp.getPoolData();
const byId = new Map(snap.swimbotArray.map((s) => [s.id, s]));

test('HUNGRY: selects the biggest eater (max numFoodBitsEaten), or nothing if none ate', () => {
    const maxEaten = Math.max(...snap.swimbotArray.map((s) => s.numFoodBitsEaten));
    gp.setViewMode(HUNGRY);
    const sel = gp.getSelectedSwimbotID();
    if (maxEaten > 0) {
        assert.notEqual(sel, GP.NULL_INDEX, 'someone ate, so one must be selected');
        assert.ok(byId.has(sel), `selected ${sel} must be an alive swimbot`);
        assert.equal(byId.get(sel).numFoodBitsEaten, maxEaten, 'selected must be the biggest eater');
    } else {
        assert.equal(sel, GP.NULL_INDEX);
    }
});

test('VIRGIN: selects the oldest childless swimbot (max age among numOffspring==0)', () => {
    const virgins = snap.swimbotArray.filter((s) => s.numOffspring === 0);
    gp.setViewMode(VIRGIN);
    const sel = gp.getSelectedSwimbotID();
    if (virgins.length > 0) {
        const maxAge = Math.max(...virgins.map((s) => s.age));
        assert.notEqual(sel, GP.NULL_INDEX, 'virgins exist, so one must be selected');
        const d = byId.get(sel);
        assert.ok(d, `selected ${sel} must be an alive swimbot`);
        assert.equal(d.numOffspring, 0, 'selected must be childless');
        assert.equal(d.age, maxAge, 'selected must be the oldest virgin');
    } else {
        assert.equal(sel, GP.NULL_INDEX);
    }
});

// Structural check only: energyEfficiency isn't in getPoolData, so we can't confirm it picks the MAX
// efficient one -- we can confirm it selects a live, childless swimbot (or nothing), which catches a
// dead/out-of-range/offspring-bearing selection.
test('EFFICIENT: selects a valid alive childless swimbot, or nothing', () => {
    gp.setViewMode(EFFICIENT);
    const sel = gp.getSelectedSwimbotID();
    if (sel !== GP.NULL_INDEX) {
        const d = byId.get(sel);
        assert.ok(d, `selected ${sel} must be an alive swimbot`);
        assert.equal(d.numOffspring, 0, 'most-efficient is drawn from childless swimbots');
    }
});

test('selectors pick nothing at boot when no candidate qualifies (HUNGRY/EFFICIENT)', () => {
    const fresh = boot(7); // no stepping: nobody has eaten, nobody has efficiency history
    fresh.setViewMode(HUNGRY);
    assert.equal(fresh.getSelectedSwimbotID(), GP.NULL_INDEX, 'no eating yet -> no biggest eater');
    fresh.setViewMode(EFFICIENT);
    assert.equal(fresh.getSelectedSwimbotID(), GP.NULL_INDEX, 'no efficiency yet -> no most-efficient');
});
