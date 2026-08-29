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
import { writePostUpdate } from './resolution-layout.mjs';
import { Perceiver } from './perceive.mjs';

export class Partition {
    // coopGrid (a CoopGrid or null): null -> JS-grid mode (writeFrozen+step, the single-thread reference);
    // set -> coop mode (the phased build below). w/W: this worker's index + total, for the cell-range zero.
    // foodGrid/foodF64/numFood: the prebuilt read-only food grid + food SoA (S1) for the perceiver's food scan.
    constructor(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, coopGrid = null, w = 0, W = 1, foodGrid = null, foodF64 = null, numFood = 0, puF64 = null) {
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

    // Phase 1a: apply last tick's resolution deltas to my bots (energy/numOffspring/timer resets), construct my
    // assigned newborns, drop my dead. NO-OP in S2a (deltas land in S2b/S3); the hook exists so the tick shape +
    // barrier restructure are validated now.
    applyDeltas() { /* S2a: no-op */ }

    // Phase 1b: zero this worker's cell-range slice of the shared count[]/cursor[].
    zeroGridCells() { this._coopGrid.zeroCellRange(this._w, this._W); }

    // Phase 2: publish each of my bots' frozen slot AND count it into its cell. Uses the tick-start genital
    // (update() has NOT run yet) -- the SAME position scatter() will use, so cursor can never exceed count.
    writeAndCount() {
        const f64 = this._f64, grid = this._coopGrid;
        for (const sb of this._bots) {
            const crit = sb.getAttractionCriterion();
            const gp = sb.getGenitalPosition();
            const pos = sb.getPosition();
            writeSlot(f64, sb.getIndex(), {
                alive: sb.getAlive(), age: sb.getAge(), energy: sb.getEnergy(),
                genitalX: gp.x, genitalY: gp.y, rootX: pos.x, rootY: pos.y,
                criterion: crit, metric: computeMetricForCriterion(sb, crit),
            });
            grid.countOne(gp.x, gp.y);
        }
    }

    // Phase 3 (worker 0 only, gated by the caller): exclusive prefix sum.
    prefix() { this._coopGrid.prefixSum(); }

    // Phase 4: scatter each of my bots into botIds[] at its cell. SAME genital as writeAndCount (no update yet).
    scatter() {
        const grid = this._coopGrid;
        for (const sb of this._bots) {
            const gp = sb.getGenitalPosition();
            grid.scatterOne(sb.getIndex(), gp.x, gp.y);
        }
    }

    // Phase 5: update + perceive (query the shared coop grid) + obstacle collision for my bots, then PUBLISH each
    // bot's post-update state (alive/energy/genital) so worker 0's resolve can compute eat/birth deltas from it.
    updatePerceive(tick) {
        const pu = this._puF64;
        for (const sb of this._bots) {
            if (!sb.getAlive()) { // dead before this tick (S2a: none, since ecology is off)
                if (pu) { const gp = sb.getGenitalPosition(); writePostUpdate(pu, sb.getIndex(), false, sb.getEnergy(), gp.x, gp.y); }
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
            if (pu) { const gp = sb.getGenitalPosition(); writePostUpdate(pu, sb.getIndex(), sb.getAlive(), sb.getEnergy(), gp.x, gp.y); }
        }
    }

    // Phase 6 (worker 0 only): serial cross-worker resolution -> deltas. NO-OP in S2a; S2b (eat)/S3 (birth) fill it.
    resolve(tick) { /* S2a: no-op */ }

    // For the correctness A/B: a canonical fingerprint of this partition's bots' state.
    fingerprint() {
        return this._bots.map(sb => {
            const p = sb.getPosition();
            return `${sb.getIndex()}:${p.x},${p.y},${sb.getAngle()},${sb.getEnergy()},${sb.getBrainState()},${sb.getChosenMateIndex()}`;
        });
    }
}
