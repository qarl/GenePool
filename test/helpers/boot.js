'use strict';
// Boot a seeded, headless (rendering-off) Gene Pool and step it deterministically.
//
// Ordering matters (verified):
//  1. loadSim()  — the bundle's top-level `function gpRandom()` redefines the global,
//                  so we must seed AFTER load.
//  2. seed       — install a mulberry32 gpRandom (construction is RNG-free, so any
//                  time before the first initialize()/startSimulation draw is fine).
//  3. new GenePool()
//  4. initialize() — sets pool center / camera / view-tracking and seeds a RANDOM pool
//                    (its string-setTimeout loop kick is a no-op via the load-sim stub).
//  5. setRendering(false) — initialize()/startSimulation() set _rendering = true, and
//                    update() would then call render() → null canvas → crash. Off it goes.

const { loadSim } = require('./load-sim');
const { mulberry32 } = require('./prng');

function boot(seed = 1, startMode /* optional SimulationStartMode value */) {
    const GP = loadSim();
    globalThis.gpRandom = mulberry32(seed);
    const gp = new GP.GenePool();
    gp.initialize();
    if (startMode !== undefined) {
        // Re-seed so the chosen mode's RNG stream is deterministic from `seed`,
        // independent of what the RANDOM init above consumed.
        globalThis.gpRandom = mulberry32(seed);
        gp.startSimulation(startMode);
    }
    gp.setRendering(false);
    gp.setSimulationRunning(true);
    return gp;
}

function step(gp, n) {
    for (let i = 0; i < n; i++) gp.update();
}

// getPoolData() minus the three camera fields, which are wall-clock/render-derived
// and NOT deterministic — strip them before hashing or comparing runs.
function poolDataNoCamera(gp) {
    const pd = gp.getPoolData();
    const { cameraX, cameraY, cameraScale, ...rest } = pd;
    return rest;
}

module.exports = { boot, step, poolDataNoCamera, loadSim, mulberry32 };
