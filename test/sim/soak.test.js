'use strict';
// Long-run soak: a 5000-tick simulation with every structural invariant checked every tick, to catch
// slow-emerging corruption (drift, rare re-entrancy, accumulating state) that a 1500-tick smoke run
// might miss. It's the expensive tier, so it's GATED behind GP_SLOW=1 -- the default `node --test`
// run stays fast; `GP_SLOW=1 node --test 'test/**/*.test.js'` (or CI nightly) runs it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');
const { checkInvariants } = require('../helpers/invariants');

const GP = loadSim();
const SLOW = !!process.env.GP_SLOW;

test('soak: 5000-tick run holds every invariant and the population survives',
    { skip: SLOW ? false : 'set GP_SLOW=1 to run the long soak' }, () => {
        const gp = boot(42);
        for (let t = 0; t < 5000; t++) {
            step(gp, 1);
            checkInvariants(gp, GP);
        }
        assert.ok(gp.getNumSwimbots() > 0, 'population should survive 5000 ticks');
    });
