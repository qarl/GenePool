// SPIKE — a PARTITION: the real Swimbots owned by one worker (id range [idStart,idEnd)). The heavy state
// (phenotype/brain/vectors) lives here and never crosses threads; only the frozen slots do. The two phases map
// onto the barrier-synced tick: writeFrozen() then (after the barrier) step(). Ecology is intentionally disabled
// by the caller's config (no metabolism / huge lifespan) so population is fixed and the per-tick compute is a
// stable, repeatable PERF probe -- eats and births are out of scope for the spike (they are the serial-resolution
// hardening that comes AFTER the spike proves the parallel loop is worth it).

import { Swimbot } from '../../../engine/swimbot.js';
import { Genotype } from '../../../engine/genotype.js';
import { Embryology } from '../../../engine/embryology.js';
import { Obstacle } from '../../../engine/obstacle.js';
import { Vector2D } from '../../../engine/vector2d.js';
import { makeStream, draw, DOMAIN } from '../../../engine/rng.js';
import { computeMetricForCriterion } from '../../../engine/attraction.js';
import { SWIMBOT_VIEW_RADIUS, ONE_HALF } from '../../../engine/constants.js';
import { writeSlot } from './frozen-layout.mjs';
import { FD_STRIDE, FD_ALIVE, FD_ENERGY } from './food-layout.mjs';
import { writePostUpdate, PU_STRIDE, PU_ALIVE, PU_ENERGY, FLAG_ENERGY_SET, FLAG_TIMER_RESET, FLAG_CLEAR_EAT, FLAG_CLEAR_MATE } from './resolution-layout.mjs';
import { Perceiver } from './perceive.mjs';

export class Partition {
    // coopGrid (a CoopGrid or null): null -> JS-grid mode (writeFrozen+step, the single-thread reference);
    // set -> coop mode (the phased build below). w/W: this worker's index + total, for the cell-range zero.
    // foodGrid/foodF64/numFood: the prebuilt read-only food grid + food SoA (S1) for the perceiver's food scan.
    // res (or null): the cross-worker resolution buffers {wantsEat, resolvedEnergy, numFoodEatenDelta,
    // numOffspringDelta, flags} (typed-array views) + {foodF64, numFood, numBotIds} for worker 0's resolve.
    constructor(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, coopGrid = null, w = 0, W = 1, foodGrid = null, foodF64 = null, numFood = 0, puF64 = null, res = null) {
        this._f64 = f64;
        this._maxBots = maxBots;
        this._config = config;
        this._embryology = new Embryology();
        this._matePref = (l, c, t, i) => draw(masterSeed, DOMAIN.MATE_PREF, l, c, t, i);
        this._viewRadius = config.viewRadius ?? SWIMBOT_VIEW_RADIUS;
        this._obstacle = new Obstacle();
        this._obstacle.setEndpointPositions(obstacle[0], obstacle[1]);
        this._collisionForce = new Vector2D();
        this._coopGrid = coopGrid;
        this._w = w;
        this._W = W;
        this._puF64 = puF64; // post-update SoA (written after update(); read by worker 0's resolve)
        this._res = res;     // cross-worker resolution buffers (null in the ecology-off / JS-baseline paths)
        this._foodF64 = foodF64;
        this._numFood = numFood;
        this._bots = [];
        // `founders` is indexed for THIS range: founders[id - idStart] is bot `id` (so a worker is handed only
        // its own slice, not all N). The single-thread baseline passes the full array with idStart=0.
        for (let id = idStart; id < idEnd; id++) {
            const f = founders[id - idStart];
            const g = new Genotype(); g.setGenes(f.genes);
            const sb = new Swimbot({ life: makeStream(masterSeed, DOMAIN.SWIMBOT_LIFE, id), matePref: this._matePref, config, embryology: this._embryology });
            sb.create(id, f.age, { x: f.x, y: f.y }, f.angle, f.energy, g);
            this._bots.push(sb);
        }
        this._perceiver = new Perceiver(f64, maxBots, this._matePref, this._viewRadius, this._obstacle, coopGrid, config.numFoodTypes ?? 1, foodGrid, foodF64, numFood);
    }

    // Phase 1: publish my bots' tick-start frozen view into the shared buffer.
    writeFrozen() {
        const f64 = this._f64;
        for (const sb of this._bots) {
            const crit = sb.getAttractionCriterion();
            const gp = sb.getGenitalPosition();
            const pos = sb.getPosition();
            writeSlot(f64, sb.getIndex(), {
                alive: sb.getAlive(), age: sb.getAge(), energy: sb.getEnergy(),
                genitalX: gp.x, genitalY: gp.y, rootX: pos.x, rootY: pos.y,
                criterion: crit, metric: computeMetricForCriterion(sb, crit),
            });
        }
    }

    // Phase 2 (after the barrier): rebuild read structures from the shared buffer, then update+perceive my bots.
    step(tick) {
        this._perceiver.rebuild(this._maxBots);
        for (const sb of this._bots) {
            if (!sb.getAlive()) continue;
            sb.update();
            if (!sb.getAlive()) continue;
            if (sb.getIsLookingForSensoryInput()) this._perceiver.perceive(sb, tick);
            if (this._obstacle.getCollision(sb.getPosition(), sb.getBoundingRadius() * ONE_HALF)) {
                this._collisionForce.set(this._obstacle.getCurrentCollisionForce());
                this._collisionForce.scale(1.2);
                sb.addForce(this._collisionForce);
            }
        }
    }

    // --- COOP MODE phases (worker.mjs orchestrates these with barriers between them) ---

    // Phase 1a: apply last tick's resolution results to my bots (energy SET, count deltas, timer/eat/mate clears),
    // then clear the per-bot result slots for next tick. (Newborn construction + dead-drop land in S3/S4.)
    applyDeltas() {
        const res = this._res;
        if (!res) return;
        const { resolvedEnergy, numFoodEatenDelta, numOffspringDelta, flags } = res;
        for (const sb of this._bots) {
            const id = sb.getIndex();
            const fl = flags[id];
            if (fl === 0 && numFoodEatenDelta[id] === 0 && numOffspringDelta[id] === 0) continue; // untouched
            sb.applyResolution(
                (fl & FLAG_ENERGY_SET) !== 0, resolvedEnergy[id],
                numFoodEatenDelta[id], numOffspringDelta[id],
                (fl & FLAG_TIMER_RESET) !== 0, (fl & FLAG_CLEAR_EAT) !== 0, (fl & FLAG_CLEAR_MATE) !== 0,
            );
            flags[id] = 0; numFoodEatenDelta[id] = 0; numOffspringDelta[id] = 0; // clear for next tick
        }
    }

    // Phase 1b: zero this worker's cell-range slice of the shared count[]/cursor[].
    zeroGridCells() { this._coopGrid.zeroCellRange(this._w, this._W); }

    // Phase 2: publish each of my bots' frozen slot AND count it into its cell. Uses the tick-start genital
    // (update() has NOT run yet) -- the SAME position scatter() will use, so cursor can never exceed count.
    writeAndCount() {
        const f64 = this._f64, grid = this._coopGrid;
        for (const sb of this._bots) {
            const alive = sb.getAlive();
            const crit = sb.getAttractionCriterion();
            const gp = sb.getGenitalPosition();
            const pos = sb.getPosition();
            writeSlot(f64, sb.getIndex(), {
                alive, age: sb.getAge(), energy: sb.getEnergy(),
                genitalX: gp.x, genitalY: gp.y, rootX: pos.x, rootY: pos.y,
                criterion: crit, metric: computeMetricForCriterion(sb, crit),
            });
            if (alive) grid.countOne(gp.x, gp.y); // dead bots are not perceivable -> not in the grid
        }
    }

    // Phase 3 (worker 0 only, gated by the caller): exclusive prefix sum.
    prefix() { this._coopGrid.prefixSum(); }

    // Phase 4: scatter each of my bots into botIds[] at its cell. SAME genital as writeAndCount (no update yet).
    scatter() {
        const grid = this._coopGrid;
        for (const sb of this._bots) {
            if (!sb.getAlive()) continue; // must match writeAndCount's alive filter (cursor <= count)
            const gp = sb.getGenitalPosition();
            grid.scatterOne(sb.getIndex(), gp.x, gp.y);
        }
    }

    // Phase 5: update + perceive (query the shared coop grid) + obstacle collision for my bots, then PUBLISH each
    // bot's post-update state (alive/energy/genital) so worker 0's resolve can compute eat/birth deltas from it.
    updatePerceive(tick) {
        const pu = this._puF64, res = this._res;
        const wantsEat = res ? res.wantsEat : null;
        const wantsMate = res ? res.wantsMate : null;
        for (const sb of this._bots) {
            const id = sb.getIndex();
            if (!sb.getAlive()) { // died in a prior tick (not yet swept)
                if (pu) { const gp = sb.getGenitalPosition(); writePostUpdate(pu, id, false, sb.getEnergy(), gp.x, gp.y); }
                if (wantsEat) { wantsEat[id] = -1; wantsMate[id] = -1; }
                continue;
            }
            sb.update();
            if (sb.getAlive()) {
                if (sb.getIsLookingForSensoryInput()) this._perceiver.perceive(sb, tick);
                if (this._obstacle.getCollision(sb.getPosition(), sb.getBoundingRadius() * ONE_HALF)) {
                    this._collisionForce.set(this._obstacle.getCurrentCollisionForce());
                    this._collisionForce.scale(1.2);
                    sb.addForce(this._collisionForce);
                }
            }
            if (pu) { const gp = sb.getGenitalPosition(); writePostUpdate(pu, id, sb.getAlive(), sb.getEnergy(), gp.x, gp.y); }
            // STAGE this tick's intents (this-tick's chosenFood/chosenMate, set by perceive). -1 if not / dead.
            if (wantsEat) {
                const live = sb.getAlive();
                wantsEat[id] = (live && sb.getIsTryingToEat()) ? sb.getChosenFoodBitIndex() : -1;
                wantsMate[id] = (live && sb.getIsTryingToMate()) ? sb.getChosenMateIndex() : -1;
            }
        }
    }

    // Phase 6 (worker 0 ONLY): serial cross-worker resolution over the GLOBAL id set in ascending order (owner-
    // agnostic). S2b: EATS -- lowest-id-per-food wins via the food-alive guard (exactly eatChosenFoodBit's loser
    // semantics), producing per-bot resolved energy + counts + flags the owners apply next tick. (Births = S3.)
    resolve(tick, numBotIds) {
        const res = this._res;
        if (!res) return;
        const { wantsEat, resolvedEnergy, numFoodEatenDelta, flags } = res;
        const pu = this._puF64, food = this._foodF64;
        for (let id = 0; id < numBotIds; id++) {
            const foodId = wantsEat[id];
            if (foodId < 0) continue;
            if (pu[id * PU_STRIDE + PU_ALIVE] !== 1) continue; // died this tick -> no eat (world.js skips dead)
            const fo = foodId * FD_STRIDE;
            if (food[fo + FD_ALIVE] !== 1) continue; // already eaten by a lower id -> loser no-op (keeps trying)
            const gained = food[fo + FD_ENERGY]; // numFoodTypes==1 (2-type FOOD_TYPE_OFFSET is a later fixture)
            resolvedEnergy[id] = pu[id * PU_STRIDE + PU_ENERGY] + gained; // FINAL energy (SET; bit-identical)
            numFoodEatenDelta[id] += 1;
            flags[id] |= FLAG_ENERGY_SET | FLAG_TIMER_RESET | FLAG_CLEAR_EAT;
            food[fo + FD_ALIVE] = 0; // kill the food (SoA); the static grid still lists it, filtered by alive
        }
    }

    // For the correctness A/B: a canonical fingerprint of this partition's bots' state.
    fingerprint() {
        return this._bots.map(sb => {
            const p = sb.getPosition();
            return `${sb.getIndex()}:${p.x},${p.y},${sb.getAngle()},${sb.getEnergy()},${sb.getBrainState()},${sb.getChosenMateIndex()}`;
        });
    }
}
