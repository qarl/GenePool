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
import { Perceiver } from './perceive.mjs';

export class Partition {
    constructor(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle) {
        this._f64 = f64;
        this._maxBots = maxBots;
        this._config = config;
        this._embryology = new Embryology();
        this._matePref = (l, c, t, i) => draw(masterSeed, DOMAIN.MATE_PREF, l, c, t, i);
        this._viewRadius = config.viewRadius ?? SWIMBOT_VIEW_RADIUS;
        this._obstacle = new Obstacle();
        this._obstacle.setEndpointPositions(obstacle[0], obstacle[1]);
        this._collisionForce = new Vector2D();
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
        this._perceiver = new Perceiver(f64, maxBots, this._matePref, this._viewRadius, this._obstacle);
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

    // For the correctness A/B: a canonical fingerprint of this partition's bots' state.
    fingerprint() {
        return this._bots.map(sb => {
            const p = sb.getPosition();
            return `${sb.getIndex()}:${p.x},${p.y},${sb.getAngle()},${sb.getEnergy()},${sb.getBrainState()},${sb.getChosenMateIndex()}`;
        });
    }
}
