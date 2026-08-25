'use strict';
// Bug M-die (docs/BUGS-original-genepool.md): Swimbot.die() is not idempotent. It unconditionally
// does `_numDeadSwimbots++` and notifies the family tree, with no `if (_alive)` guard. So:
//   (1) killing an already-dead swimbot double-counts the global death tally (and re-notifies the
//       family tree) -- e.g. a swimbot that dies of old-age AND starvation on the same tick; and
//   (2) setPoolData() calls die() on ALL MAX_SWIMBOTS slots on every load to clear the pool -- most
//       of which are already dead -- inflating _numDeadSwimbots by ~MAX_SWIMBOTS per load.
// _numDeadSwimbots is module-level (shared across instances) and never reset; it is read only by
// getNumDeadSwimbots() and feeds no sim/RNG logic. Guarding die() with `if (_alive)` is therefore
// behaviour-preserving for the simulation and only corrects the death statistic.
//
// NOTE: _numDeadSwimbots accumulates across every test in this process, so both tests below measure
// the DELTA their own action causes rather than any absolute value.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');

test('M-die: die() is idempotent -- killing an already-dead swimbot must not re-count the death', () => {
    const gp = boot(42);
    step(gp, 200);

    const id = gp.getPoolData().swimbotArray[0].id; // an alive swimbot
    const before = gp.getNumDeadSwimbots();

    gp.killSwimbot(id);                              // a real death: exactly +1
    const afterFirst = gp.getNumDeadSwimbots();
    assert.equal(afterFirst - before, 1, 'first kill should count exactly one death');

    gp.killSwimbot(id);                             // already dead: must be a no-op
    const afterSecond = gp.getNumDeadSwimbots();
    assert.equal(afterSecond - afterFirst, 0, 'killing an already-dead swimbot must not increment the death count');
});

test('M-die: setPoolData clears the pool without inflating the death count by MAX_SWIMBOTS', () => {
    const GP = loadSim();
    const gp = boot(42);
    step(gp, 200);

    const aliveBefore = gp.getNumSwimbots();        // true count of alive slots
    const snap = JSON.parse(JSON.stringify(gp.getPoolData()));
    const before = gp.getNumDeadSwimbots();

    gp.setPoolData(snap);                            // die()s all MAX_SWIMBOTS slots, then rebuilds

    const delta = gp.getNumDeadSwimbots() - before;
    // Only the slots that were actually alive should register as newly dead -- not all 2000.
    assert.equal(delta, aliveBefore,
        `setPoolData should count only the ${aliveBefore} live slots as newly dead, not ~${GP.MAX_SWIMBOTS}`);
});
