'use strict';
// Bug M-prolific (docs/BUGS-original-genepool.md): getMostProlificSwimbot() (ViewTracking.js:416)
// initialises its result to 0 instead of NULL_INDEX, and only updates it when a swimbot has
// numOffspring > 0. So BEFORE any births -- when nobody has offspring -- it returns slot 0, and
// setViewMode(PROLIFIC) then selects/tracks swimbot 0 (an arbitrary swimbot that isn't actually
// "most prolific", and could even be a slot that later dies) instead of correctly selecting nothing.
// Its three sibling selectors -- getMostEfficientSwimbot (:442), getOldestVirgin (:468),
// getBiggestEater (:494) -- all correctly init to NULL_INDEX. Fix: make prolific match them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');

const PROLIFIC = 4; // ViewTrackingMode.PROLIFIC (ViewTracking.js enum)

test('M-prolific: with no births yet, "view most prolific" selects nothing (not swimbot 0)', () => {
    const GP = loadSim();
    const gp = boot(42); // fresh pool: founders have 0 offspring, nothing selected
    assert.equal(gp.getSelectedSwimbotID(), GP.NULL_INDEX, 'sanity: nothing selected at boot');

    gp.setViewMode(PROLIFIC);

    assert.equal(gp.getSelectedSwimbotID(), GP.NULL_INDEX,
        'no swimbot has offspring yet, so most-prolific must be NULL_INDEX, not slot 0');
});

test('M-prolific: once there are births, "view most prolific" selects an actual top breeder', () => {
    const GP = loadSim();
    const gp = boot(42);
    step(gp, 1500); // reproductions happen

    const snap = gp.getPoolData(); // numOffspring per swimbot (added by the M-scores fix)
    const maxOffspring = Math.max(...snap.swimbotArray.map((s) => s.numOffspring));
    assert.ok(maxOffspring > 0, 'precondition: some swimbot has offspring after 1500 ticks');

    gp.setViewMode(PROLIFIC); // no stepping since the snapshot, so live state == snap
    const sel = gp.getSelectedSwimbotID();

    assert.notEqual(sel, GP.NULL_INDEX, 'a top breeder exists, so one must be selected');
    const selData = snap.swimbotArray.find((s) => s.id === sel);
    assert.ok(selData, `selected swimbot ${sel} should be alive/in the pool`);
    assert.equal(selData.numOffspring, maxOffspring, 'the selected swimbot must be the most prolific');
});
