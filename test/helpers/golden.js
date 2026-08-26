'use strict';
// Determinism baseline ("golden") signature. Boots a seed, steps N ticks, and reduces the resulting
// pool to (a) a sha256 of the canonical getPoolData MINUS the camera (which is wall-clock/render
// derived and nondeterministic) and (b) a few reduced integer scalars for a legible diff.
//
// SINGLE-ENGINE: the sim uses Math.sqrt/sin/cos, whose last-bit results can differ across platforms,
// and the sim is chaotic -- so this exact signature is only stable on one engine/Node build. The
// golden test that uses it is GATED behind GP_SLOW and records the Node version; regen it deliberately
// on the pinned environment (node test/tools/regen-golden.js). The PORTABLE regression layer is the
// structural invariants + self-relative determinism test, not this hash.

const path = require('node:path');
const crypto = require('node:crypto');
const { boot, step } = require('./boot');

function signature(seed, ticks) {
    const gp = boot(seed);
    step(gp, ticks);
    const pd = gp.getPoolData();
    const { cameraX, cameraY, cameraScale, ...rest } = pd; // strip the nondeterministic camera
    void cameraX; void cameraY; void cameraScale;
    // getPoolData emits a fixed key order with arrays in ascending slot order, so this is canonical.
    const hash = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    const scalars = {
        population: pd.swimbotArray.length,
        food: pd.foodBitArray.length,
        familyNodes: gp.getFamilyTree().getNumNodes(),
    };
    return { seed, ticks, node: process.version, hash, scalars };
}

const SEED = 42;
const TICKS = 2000;
const goldenPath = () => path.join(__dirname, '..', 'fixtures', 'golden', `seed${SEED}-t${TICKS}.json`);

module.exports = { signature, SEED, TICKS, goldenPath };
