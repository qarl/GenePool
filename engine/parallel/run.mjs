// SPIKE — the parallel driver + correctness/perf A/B for the COOPERATIVE shared-grid version. Spawns W workers
// (each owning an id-range partition; they build ONE shared CSR neighbor grid cooperatively each tick), drives the
// barrier-synced tick loop, and verifies the result is BIT-IDENTICAL to (a) the single-thread JS-grid reference
// [grid impl correct] and (b) coop at W=1 [parallelization deterministic]. Then reports the speedup. Also runs a
// WALL-HUGGING fixture where coop MUST still match the JS grid (the only case that exercises the clamp/skip edges).
//
// Usage: node engine/parallel/run.mjs [N] [ticks] [workers] [pool]
// The engine itself is untouched; this lives entirely in tools/.

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeFrozenBuffer, STRIDE, F_GX, F_GY, F_AGE, F_ENERGY } from './frozen-layout.mjs';
import { setupFood, FD_STRIDE, FD_POSX, FD_POSY, FD_TYPE, FD_ENERGY } from './food-layout.mjs';
import { makePostUpdateBuffer, makeResolutionBuffers } from './resolution-layout.mjs';
import { allocCoopGrid } from './coop-grid.mjs';
import { growSwimbotBuffers, growFoodBuffers } from './grow-buffers.mjs';
import { resolveWorldConfig, SCHEDULABLE_FIELDS } from '../config.js';
import { NULL_INDEX } from '../constants.js';
import { World } from '../world.js';
import { requireFinite } from '../assert.js';

const NUM_GENES = 256; // engine genome length (constants.js NUM_GENES) -- for the shared genome SoA
import { CTL_TICKGEN, CTL_TICK, CTL_DONEGEN, CTL_SHUTDOWN, CTL_GROW, CTL_NEXTID, CTL_NEXTFOODID, CTL_SIZE } from './barrier.mjs';
import { makeEcologyConfig, makeFounders, makeFood, MASTER_SEED, OBSTACLE } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CELL_SIZE = 300; // == SWIMBOT_VIEW_RADIUS (config leaves viewRadius default)

export async function runParallel(N, ticks, W, poolSize, founders, config, food, warmup = 50, initialMaxBots = 0, forceGrowEvery = 0, initialMaxFood = 0, forceFoodGrowEvery = 0, seed = MASTER_SEED, obstacle = OBSTACLE, wantCheckpoint = false) {
    // Ids are never reused + monotonic, so the swimbot SABs are sized to a CAPACITY CEILING. That ceiling is no
    // longer a hard wall: worker 0 publishes nextId each tick and main GROWS the SABs (doubling) before nextId
    // reaches maxBots -- so a long run that mints > initialMaxBots lifetime ids keeps going, deterministically,
    // without ever hitting the resolve() minting clamp (which would stall births and diverge from world.js).
    // Slot==id is preserved across a grow (the review-rejected slot RECYCLING is NOT done), so G1/G2 hold.
    // `initialMaxBots` (0 -> default N*8) lets the grow gate start tiny to force grows.
    let maxBots = initialMaxBots || N * 8;
    let frozenSab = makeFrozenBuffer(maxBots);
    const gridSpec = allocCoopGrid(config.pool, CELL_SIZE, maxBots); // count/start/cursor are pool-sized (fixed); only botIds grows on a grow
    // Food SoA + food grid built ONCE; workers reconstruct read-only views. Food ids never reused; the SoA GROWS
    // on near-full (like the swimbots) so a run longer than any static headroom keeps regenerating -- else regen
    // would stop while world.js's unbounded food keeps spawning, diverging. `initialMaxFood` (0 -> sized for `ticks`)
    // lets the grow gate start tiny to force food-grows.
    let maxFood = initialMaxFood || (food.length + Math.ceil((ticks + 100) / (config.foodRegenerationPeriod || 20)) + 16);
    let { foodSab, foodGridSpec, numFood } = setupFood(food, config.pool, CELL_SIZE, maxFood);
    let puSab = makePostUpdateBuffer(maxBots); // post-update SoA (workers publish; worker 0 resolves from it)
    let resSabs = makeResolutionBuffers(maxBots, NUM_GENES);
    new Int32Array(resSabs.wantsEatSab).fill(-1);  // 0 is a valid foodId; -1 = "not eating"
    new Int32Array(resSabs.wantsMateSab).fill(-1);
    const ctrlSab = new SharedArrayBuffer(CTL_SIZE * Int32Array.BYTES_PER_ELEMENT);
    const ctrl = new Int32Array(ctrlSab);

    const chunk = Math.ceil(N / W);
    const workers = [];
    const fingerprints = new Map();
    const checkpoints = new Map(); // C2: per-worker full-state checkpoints (when wantCheckpoint)
    let readyCount = 0, onReady, onAllFingerprints;
    const ready = new Promise(r => { onReady = r; });
    const dumped = new Promise(r => { onAllFingerprints = r; });

    for (let w = 0; w < W; w++) {
        const idStart = w * chunk;
        const idEnd = Math.min(N, (w + 1) * chunk);
        const worker = new Worker(join(HERE, 'worker.mjs'), {
            workerData: {
                frozenSab, ctrlSab, gridSpec, maxBots, masterSeed: seed, config,
                founders: founders.slice(idStart, idEnd), idStart, idEnd, obstacle, W, workerIndex: w,
                foodGridSpec, foodSab, numFood, puSab, resSabs, numFounders: N, wantCheckpoint,
            },
        });
        worker.on('message', (m) => {
            if (m.type === 'ready') { if (++readyCount === W) onReady(); }
            else if (m.type === 'fingerprint') { fingerprints.set(m.idStart, m.fp); if (fingerprints.size === W) onAllFingerprints(); }
            else if (m.type === 'checkpoint') { checkpoints.set(m.idStart, m); if (checkpoints.size === W) onAllFingerprints(); }
        });
        worker.on('error', (e) => { console.error('worker error', e); process.exit(1); });
        workers.push(worker);
    }
    await ready;

    const releaseTick = (tick) => {
        Atomics.store(ctrl, CTL_TICK, tick);
        const doneGenBefore = Atomics.load(ctrl, CTL_DONEGEN);
        Atomics.add(ctrl, CTL_TICKGEN, 1);
        Atomics.notify(ctrl, CTL_TICKGEN);
        return doneGenBefore;
    };
    const awaitTickDone = async (doneGenBefore) => {
        while (Atomics.load(ctrl, CTL_DONEGEN) === doneGenBefore) {
            const r = Atomics.waitAsync(ctrl, CTL_DONEGEN, doneGenBefore);
            if (r.async) await r.value;
        }
    };

    // Grow-on-near-full: double the swimbot SABs before nextId reaches maxBots. The safe window is BETWEEN ticks --
    // all workers are parked on TICKGEN, so nobody is touching a SAB and the copy is a clean snapshot. Threshold
    // maxBots/2 is provably below any one tick's minting (births/tick <= living/2 <= nextId/2), so the resolve()
    // minting clamp is never reached (reaching it would stall births and diverge from world.js). Copy ONLY the two
    // cross-tick carriers (frozen _f64 + the resolution/genome buffers); everything else is per-tick scratch.
    let growCount = 0, foodGrowCount = 0;
    const FOOD_MARGIN = 2; // grow food this many ids early -- regen adds <=1 food/tick and maybeGrow runs every tick,
                           // so the SoA never fills before we grow (a full SoA would SKIP a regen -> diverge).
    // `force` (test hook forceGrowEvery) forces a SWIMBOT grow regardless of nextId, to exercise the multi-grow
    // chain fast -- always safe: a grow only ENLARGES the buffers, moving the mint clamp further away. Swimbot and
    // food have INDEPENDENT triggers but share ONE handshake: the message carries whichever grew; the worker rebinds
    // whichever is present.
    const maybeGrow = async (force = false, forceFood = false) => {
        const growBots = force || Atomics.load(ctrl, CTL_NEXTID) >= (maxBots >> 1);
        const growFood = forceFood || Atomics.load(ctrl, CTL_NEXTFOODID) >= maxFood - FOOD_MARGIN;
        if (!growBots && !growFood) return;
        const msg = { type: 'grow' };
        let botG, foodG;
        if (growBots) { botG = growSwimbotBuffers(frozenSab, resSabs, maxBots * 2); Object.assign(msg, botG); }
        if (growFood) { foodG = growFoodBuffers(foodSab, foodGridSpec.botIdsSab, maxFood * 2); Object.assign(msg, foodG); }
        for (const w of workers) w.postMessage(msg);
        const doneBefore = Atomics.load(ctrl, CTL_DONEGEN);
        Atomics.store(ctrl, CTL_GROW, 1);
        Atomics.add(ctrl, CTL_TICKGEN, 1);
        Atomics.notify(ctrl, CTL_TICKGEN);
        await awaitTickDone(doneBefore); // worker 0 acks (bumps DONEGEN) after the grow-barrier; CTL_GROW already cleared
        if (growBots) { maxBots = botG.maxBots; frozenSab = botG.frozenSab; puSab = botG.puSab; resSabs = botG.resSabs; growCount++; }        // adopt: copy sources for the next grow
        if (growFood) { maxFood = foodG.maxFood; foodSab = foodG.foodSab; foodGridSpec = { ...foodGridSpec, botIdsSab: foodG.foodBotIdsSab, N: foodG.maxFood }; foodGrowCount++; }
    };

    const forced = (tk) => forceGrowEvery > 0 && tk % forceGrowEvery === 0;         // test hook: force a swimbot grow on a schedule
    const forcedFood = (tk) => forceFoodGrowEvery > 0 && tk % forceFoodGrowEvery === 0; // ditto for food
    const warm = Math.min(warmup, ticks); // untimed warmup (perf runs); 0 for bit-identity comparisons vs world.js
    for (let t = 0; t < warm; t++) { await awaitTickDone(releaseTick(t + 1)); await maybeGrow(forced(t + 1), forcedFood(t + 1)); }
    const t0 = performance.now();
    for (let t = 0; t < ticks; t++) { await awaitTickDone(releaseTick(warm + t + 1)); await maybeGrow(forced(warm + t + 1), forcedFood(warm + t + 1)); }
    const ms = performance.now() - t0;

    Atomics.store(ctrl, CTL_SHUTDOWN, 1);
    Atomics.add(ctrl, CTL_TICKGEN, 1);
    Atomics.notify(ctrl, CTL_TICKGEN);
    await dumped;
    await Promise.all(workers.map(w => w.terminate()));

    if (wantCheckpoint) {
        // C2: assemble a World.serialize()-format (snapshot-mode) checkpoint from the per-worker partial checkpoints.
        // Living bots come from every worker's heap (their own serializeCheckpoint); the ecology (food + id high-water
        // + regen-stream position) from worker 0. GHOSTS -- a live bot's chosenMate/chosenFood swept/eaten by the
        // boundary -- are read straight from the shared SoAs (slot==id, never reused): the frozen genital from
        // frozenSab, the eaten-food position from foodSab (both `let`s hold the latest post-grow backing). This is
        // precisely the checkpoint World.restore consumes -> a resumable, snapshot-baseline World bit-identical to
        // a serial snapshot run (gated by run-tw.mjs).
        const F = new Float64Array(frozenSab), FF = new Float64Array(foodSab);
        const allBots = [];
        let eco = null;
        for (let w = 0; w < W; w++) {
            const c = checkpoints.get(w * chunk);
            for (const sb of c.swimbots) allBots.push(sb);
            if (c.food) eco = c; // worker 0 carries the ecology
        }
        allBots.sort((a, b) => a.index - b.index);
        const livingIds = new Set(allBots.map(b => b.index));
        const livingFoodIds = new Set(eco.food.map(f => f.id));
        const ghostViews = new Map(), ghostFood = new Map();
        for (const sb of allBots) {
            const cm = sb.chosenMateIndex;
            if (cm !== NULL_INDEX && !livingIds.has(cm) && !ghostViews.has(cm)) {
                const o = cm * STRIDE;
                ghostViews.set(cm, { index: cm, genital: [F[o + F_GX], F[o + F_GY]], age: F[o + F_AGE], energy: F[o + F_ENERGY] });
            }
            const cf = sb.chosenFoodBitIndex;
            if (cf !== NULL_INDEX && !livingFoodIds.has(cf) && !ghostFood.has(cf)) {
                const o = cf * FD_STRIDE;
                ghostFood.set(cf, { id: cf, x: FF[o + FD_POSX], y: FF[o + FD_POSY], type: FF[o + FD_TYPE], energy: FF[o + FD_ENERGY] });
            }
        }
        const data = {
            masterSeed: seed, clock: warm + ticks, perceptionMode: 'snapshot',
            nextSwimbotId: eco.nextSwimbotId, nextFoodId: eco.nextFoodId,
            numDeadSwimbots: eco.nextSwimbotId - allBots.length,
            livingSwimbotCount: allBots.length, livingFoodCount: eco.food.length,
            foodRegenPosition: eco.foodRegenPosition,
            obstacles: (config.obstacles && config.obstacles.length) ? config.obstacles : [],
            swimbots: allBots, food: eco.food,
            ghostSwimbots: [], ghostViews: [...ghostViews.values()], ghostFood: [...ghostFood.values()],
        };
        return { ms, tps: Math.round(ticks / (ms / 1000)), grows: growCount, foodGrows: foodGrowCount, totalBots: allBots.length, data };
    }

    const fp = [];
    for (let w = 0; w < W; w++) fp.push(...fingerprints.get(w * chunk));
    fp.sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]));
    const hash = createHash('sha256').update(fp.join('|')).digest('hex').slice(0, 16);
    return { ms, tps: Math.round(ticks / (ms / 1000)), hash, totalBots: fp.length, grows: growCount, finalMaxBots: maxBots, foodGrows: foodGrowCount, finalMaxFood: maxFood, fp };
}

// FIRST-CLASS PARALLEL RUNNER (wire-parallel option A, docs/PLAN-parallel-in-world.md): run ONE pool across
// `workers` cores to completion and return the result. A clean options-object API over runParallel that threads the
// SEED and the obstacle from the config (the positional runParallel bakes the gate's fixed seed/obstacle), and
// RESOLVES the config first (resolveWorldConfig) so the parallel path fills the same defaults as world.js -> a
// MINIMAL config yields a run BIT-IDENTICAL to single-thread world.js snapshot mode (gated by run-api.mjs).
// `founders` / `food` are the same records World.loadSwimbot / loadFood take.
// SCOPE (= world.js snapshot mode MINUS what the spike doesn't model). Rather than silently diverge, runPoolParallel
// REJECTS every world it can't reproduce bit-for-bit -- so a result you get back is guaranteed identical to the
// single-thread engine. Rejected (run these on world.js single-thread): torus topology; numFoodTypes > 1; and §10
// schedules. ACCEPTED: any pool size; a full §8 obstacle FIELD (any count, per-obstacle thickness + movement/vision
// masks -- honored via the engine ObstacleField, same as world.js); static ecology. Grows automatically (unbounded).
// Resolve the config to world.js's defaults and REJECT anything the parallel engine can't reproduce bit-for-bit.
// Returns the resolved cfg with the ObstacleField path forced (config.obstacles defined, even []); the single-obstacle
// param is the gates' back-compat fallback only. Shared by runPoolParallel (run-to-completion) and runPoolParallelToWorld.
function resolveAndGuard(who, { config, founders, food, ticks }) {
    if (!config || !Array.isArray(founders) || !Array.isArray(food) || !Number.isInteger(ticks)) {
        throw new Error(`${who}: requires { config, founders: [...], food: [...], ticks }`);
    }
    if (founders.length === 0) throw new Error(`${who}: an empty founder pool has nothing to simulate`); // else chunk=0 -> workers share idStart 0 -> the all-workers-reported barrier never completes (hang)
    // L4: the parallel path builds bots directly (bypassing World.loadSwimbot), so validate the same input FORM here
    // -- else a malformed founder (a negative age -> the growthScale invariant) crashes a WORKER thread mid-run,
    // which run.mjs turns into process.exit(1). Fail fast in the caller's thread with a clear, indexed error instead.
    for (let i = 0; i < founders.length; i++) {
        const s = founders[i];
        requireFinite(s.age, `${who}: founders[${i}].age`); if (s.age < 0) throw new Error(`${who}: founders[${i}].age must be >= 0 (got ${s.age})`);
        requireFinite(s.x, `${who}: founders[${i}].x`); requireFinite(s.y, `${who}: founders[${i}].y`);
        requireFinite(s.angle, `${who}: founders[${i}].angle`); requireFinite(s.energy, `${who}: founders[${i}].energy`);
    }
    for (let i = 0; i < food.length; i++) {
        const f = food[i];
        requireFinite(f.x, `${who}: food[${i}].x`); requireFinite(f.y, `${who}: food[${i}].y`); requireFinite(f.energy, `${who}: food[${i}].energy`);
        if (f.energy < 0) throw new Error(`${who}: food[${i}].energy must be >= 0 (got ${f.energy}); negative/"poison" food is not modeled`);
    }
    const resolved = resolveWorldConfig(config); // same defaults world.js applies -> bit-identical
    const reject = (why) => { throw new Error(`${who}: ${why} is not modeled by the parallel engine -- run it on world.js single-thread`); };
    for (const f of SCHEDULABLE_FIELDS) { // the parallel path reads config values raw, not per-tick -> reject §10 schedules (would be silent NaN)
        const v = resolved[f];
        if (v !== null && typeof v === 'object' && Array.isArray(v.schedule)) reject(`a §10 schedule on config.${f}`);
    }
    if (resolved.topology === 'torus') reject('torus topology (the coop grid + LoS are flat-only)');
    if ((resolved.numFoodTypes ?? 1) > 1) reject(`numFoodTypes=${resolved.numFoodTypes}`);
    return { ...resolved, obstacles: resolved.obstacles || [] };
}

export async function runPoolParallel({ config, seed = MASTER_SEED, founders, food, workers = 8, ticks }) {
    const cfg = resolveAndGuard('runPoolParallel', { config, founders, food, ticks });
    const poolSize = cfg.pool ? (cfg.pool.right - cfg.pool.left) : 8000;
    const r = await runParallel(founders.length, ticks, workers, poolSize, founders, cfg, food, 0, 0, 0, 0, 0, seed, [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
    return { hash: r.hash, totalBots: r.totalBots, grows: r.grows, foodGrows: r.foodGrows, tps: r.tps, ms: r.ms, fingerprint: r.fp };
}

// C (live-World acceleration, docs/PLAN-parallel-in-world.md): run a pool across `workers` cores AND return it as a
// live, tickable, resumable World -- so you can seed a world, fast-forward it across cores, then keep inspecting /
// ticking / checkpointing it single-thread. Same scope + rejections as runPoolParallel. The parallel engine runs the
// SNAPSHOT baseline (order-independent), so the returned World is in snapshot mode: ticking it on continues the SAME
// deterministic trajectory the fast-forward was on. Bit-identical to a serial snapshot World run `ticks` ticks then
// resumed (gated by run-tw.mjs, which also proves the reconstructed state == serial world.serialize() field-for-field).
export async function runPoolParallelToWorld({ config, seed = MASTER_SEED, founders, food, workers = 8, ticks }) {
    const cfg = resolveAndGuard('runPoolParallelToWorld', { config, founders, food, ticks });
    const poolSize = cfg.pool ? (cfg.pool.right - cfg.pool.left) : 8000;
    const r = await runParallel(founders.length, ticks, workers, poolSize, founders, cfg, food, 0, 0, 0, 0, 0, seed, [{ x: 0, y: 0 }, { x: 0, y: 0 }], true);
    const world = World.restore(cfg, r.data); // cfg carries perceptionMode via the checkpoint; snapshot-mode resume
    return { world, checkpoint: r.data, grows: r.grows, foodGrows: r.foodGrows, tps: r.tps, ms: r.ms, totalBots: r.totalBots };
}

// CLI: quick coop-1 vs coop-W determinism + speedup on a full-ecology pool. (The authoritative correctness gate
// is run-g1.mjs = bit-identical to world.js; run-ecology.mjs = determinism; run-pool.mjs = the user runner.)
if (import.meta.url === `file://${process.argv[1]}`) await (async () => {
    const N = Number(process.argv[2] || 4000);
    const ticks = Number(process.argv[3] || 400);
    const W = Number(process.argv[4] || 8);
    const pool = Number(process.argv[5] || 12000);
    const config = makeEcologyConfig(pool);
    const founders = makeFounders(N, pool);
    const food = makeFood(N * 4, pool);
    console.log(`\nGenePool parallel — coop grid  (N=${N}, ticks=${ticks}, pool=${pool}, full ecology)`);
    const coop1 = await runParallel(N, ticks, 1, pool, founders, config, food);
    console.log(`  coop grid (1 worker):   ${String(coop1.tps).padStart(6)} tps   hash=${coop1.hash}`);
    const coopW = await runParallel(N, ticks, W, pool, founders, config, food);
    console.log(`  coop grid (${W} workers):  ${String(coopW.tps).padStart(6)} tps   hash=${coopW.hash}   ${coopW.hash === coop1.hash ? 'DETERMINISTIC ✓' : 'NONDETERMINISTIC ✗'}`);
    console.log(`  speedup (W vs 1): ${(coop1.ms / coopW.ms).toFixed(2)}x`);
})();
