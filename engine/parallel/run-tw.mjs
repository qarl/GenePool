// C2 (to-World) — the live-World bridge gate. runPoolParallelToWorld() runs a pool across W cores and returns a
// LIVE, tickable World reconstructed from the parallel run's final state. This gate proves that reconstructed World
// is BIT-IDENTICAL to a single-thread world.js SNAPSHOT run of the same length -- in THREE independent ways:
//   (1) STATE @ tick N: the reconstructed dump (swimbots + food) == the serial snapshot World's dump.
//   (2) CHECKPOINT FIELDS: the assembled checkpoint's world-level scalars + the GHOST sets (swept referenced mates /
//       eaten referenced food) == the serial world.serialize() -- so the cross-SoA ghost extraction is exact.
//   (3) RESUME: ticking the reconstructed World forward M ticks stays bit-identical to the serial World, tick for
//       tick -- the real proof that ALL hidden state (brain FSM, timers, velocities, per-part geometry, chosen refs,
//       ghosts, RNG stream positions, id high-water marks) crossed the core boundary intact.
// Two scenarios, each at W=1 (parallelization-neutral) AND W=8 (the real multicore path): a realistic long run, and
// a short-lifespan run tuned to FORCE the swept-mate ghost-VIEW path (a live bot pursuing a mate that dies at the
// boundary -> its frozen genital must be read from the shared frozen SoA). If all pass, "fast-forward a live world
// across cores, then keep ticking it" is faithful.
//
// Usage: node engine/parallel/run-tw.mjs [N] [M] [pool] [W]

import { createHash } from 'node:crypto';
import { World } from '../world.js';
import { runPoolParallelToWorld } from './run.mjs';
import { makeEcologyConfig, makeFounders, makeFood, MASTER_SEED, OBSTACLE } from './common.mjs';

const argN = Number(process.argv[2] || 1500);
const M = Number(process.argv[3] || 200);
const pool = Number(process.argv[4] || 8000);
const W = Number(process.argv[5] || 8);

const dumpHash = (world) => {
    const s = world.dumpSwimbots().sort((a, b) => a.id - b.id)
        .map(s => `${s.id}:${s.x},${s.y},${s.angle},${s.energy},${s.age},${s.numOffspring},${s.numFoodBitsEaten},${s.brainState}`);
    const f = world.dumpFood().sort((a, b) => a.id - b.id).map(f => `${f.id}:${f.x},${f.y},${f.type},${f.energy}`);
    return createHash('sha256').update(s.join('|') + '#' + f.join('|')).digest('hex').slice(0, 16);
};
const keyGhostViews = (g) => [...g].sort((a, b) => a.index - b.index).map(v => `${v.index}:${v.genital[0]},${v.genital[1]}`).join('|');
const keyGhostFood = (g) => [...g].sort((a, b) => a.id - b.id).map(f => `${f.id}:${f.x},${f.y},${f.type},${f.energy}`).join('|');

function makeSerialSnapshot(config, founders, food, N) {
    const w = new World({ ...config, perceptionMode: 'snapshot' }, MASTER_SEED);
    for (let i = 0; i < N; i++) { const f = founders[i]; w.loadSwimbot(i, { age: f.age, x: f.x, y: f.y, angle: f.angle, energy: f.energy, genes: f.genes }); }
    for (let i = 0; i < food.length; i++) w.loadFood(i, { x: food[i].x, y: food[i].y, type: food[i].type, energy: food[i].energy });
    return w;
}

async function scenario(label, config, N, foodMult, requireGhostViews) {
    const founders = makeFounders(N, pool), food = makeFood(N * foodMult, pool);

    // one serial reference run to snapshot the checkpoint fields (its resume partner is re-run fresh per W below)
    const ref = makeSerialSnapshot(config, founders, food, N);
    for (let t = 0; t < N; t++) ref.tick();
    const refData = ref.serialize();
    const refHashN = dumpHash(ref);

    let pass = true, sawGhostViews = 0;
    for (const workers of [1, W]) {
        const serial = makeSerialSnapshot(config, founders, food, N); // fresh lockstep partner for the resume
        for (let t = 0; t < N; t++) serial.tick();

        const { world: par, checkpoint } = await runPoolParallelToWorld({ config, seed: MASTER_SEED, founders, food, workers, ticks: N });
        sawGhostViews = checkpoint.ghostViews.length;

        const stateOK = dumpHash(par) === refHashN;
        const scalars = ['clock', 'perceptionMode', 'nextSwimbotId', 'nextFoodId', 'numDeadSwimbots', 'livingSwimbotCount', 'livingFoodCount', 'foodRegenPosition'];
        const badFields = scalars.filter(k => checkpoint[k] !== refData[k]);
        const gvOK = keyGhostViews(checkpoint.ghostViews) === keyGhostViews(refData.ghostViews);
        const gfOK = keyGhostFood(checkpoint.ghostFood) === keyGhostFood(refData.ghostFood);
        const fieldsOK = badFields.length === 0 && gvOK && gfOK;

        let resumeOK = true, divergeTick = -1;
        for (let t = 0; t < M; t++) {
            serial.tick(); par.tick();
            if (dumpHash(par) !== dumpHash(serial)) { resumeOK = false; divergeTick = N + t + 1; break; }
        }

        const ok = stateOK && fieldsOK && resumeOK;
        pass = pass && ok;
        console.log(`    W=${String(workers).padStart(2)}: state@N ${stateOK ? '✓' : '✗'}  fields ${fieldsOK ? '✓' : `✗(${badFields.join(',')}${gvOK ? '' : ' +views'}${gfOK ? '' : ' +food'})`}  ` +
            `ghosts[views=${checkpoint.ghostViews.length},food=${checkpoint.ghostFood.length}]  resume ${resumeOK ? `✓(+${M})` : `✗@${divergeTick}`}  => ${ok ? 'BIT-IDENTICAL ✓' : 'DIVERGED ✗'}`);
    }
    if (requireGhostViews && sawGhostViews === 0) { console.log(`    ✗ coverage: expected the swept-mate ghost-VIEW path to fire, but ghostViews=0`); pass = false; }
    console.log(`  ${label}: ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
    return pass;
}

console.log(`\nC2 to-World bridge: runPoolParallelToWorld vs world.js snapshot  (resume M=${M}, pool=${pool})`);
const base = { ...makeEcologyConfig(pool), obstacles: [{ a: OBSTACLE[0], b: OBSTACLE[1] }] };
let allPass = true;
console.log(`\n  [realistic] N=${argN}, food x4, full ecology`);
allPass = await scenario('realistic', base, argN, 4, false) && allPass;
// SPARSE food (x1) at N=2500 starves pursued mates at the boundary -> exercises the swept-mate ghost-VIEW path (a
// live bot's chosenMate dies, so its frozen genital must be read from the shared frozen SoA). This large-N run used
// to expose a parallel-engine divergence; that was root-caused + fixed (the dead-ghost frozen-slot overwrite, see
// docs/BUGS-parallel-fidelity.md), so it is now bit-identical and provides real end-to-end ghost-view coverage.
console.log(`\n  [ghost-view coverage] N=2500, food x1 (sparse -> mates starve under pursuit -> frozen-SoA ghost read)`);
allPass = await scenario('ghost-view coverage', base, 2500, 1, true) && allPass;

console.log(`\n  C2: ${allPass ? 'runPoolParallelToWorld is BIT-IDENTICAL to world.js snapshot AND resumes exactly ✓✓' : 'FAILED ✗'}`);
process.exit(allPass ? 0 : 1);
