// Swimbot — forked from JJ's Swimbot.js as an ES module (PLAN-restructure.md §15). BEHAVIOR-FAITHFUL:
// the per-tick physics/brain/eat path is bit-exact against JJ (proven by the rung-1 in-process A/B in
// test/engine/swimbot-fidelity.test.js), so operator order, the faithful quirks, and draw order are all
// preserved. Two structural changes per the plan:
//   - randomness is INJECTED and ADDRESSED (§3, P1b-ii): own draws from ctx.life (a per-swimbot
//     SWIMBOT_LIFE counter stream); mate-pref draws from ctx.matePref (pairwise MATE_PREF, scan-order
//     independent). Draw SITES/COUNT are unchanged from the global-stream version: wanderFocus() draws 2
//     (or 4 on the first, zero-direction call); getAttractiveness draws 1 (2 for ATTRACTION_RANDOM).
//   - world params are INJECTED (ctx.config): maximumLifeSpan, numFoodTypes, childEnergyRatio, and pool
//     bounds -- JJ read these off globalTweakers / POOL_* globals (§11). Mechanism scalars stay constant.
// die() no longer touches a global dead-count or a FamilyTree; it flips _alive (idempotently) and calls
// an injected onDeath hook -- the pool owns death accounting / lineage (wired at P1b).
//
// COVERAGE STATUS (rung-by-rung, PLAN §19). A/B-validated bit-for-bit against JJ:
//   rung 1 (swimbot-fidelity.test.js) -- the autonomous per-tick path: create/processPhenotype,
//     updateBodyParts + physics, calculateFluidForces, energy efficiency, wall collisions, wanderFocus,
//     the Brain FSM, aging/growth, both death paths;
//   rung 1b -- eatChosenFoodBit + setEnvironmentalStimuli's food branch (incl. FOOD_TYPE_OFFSET);
//   rung 2 (swimbot-mating.test.js) -- the swimbot-side MATE path: setEnvironmentalStimuli's mate branch,
//     getAttractiveness + every attraction/similarity/color/body-metric helper, PURSUING_MATE steering,
//     trying-to-mate, and contributeToOffspring.
// The pool-level birth ORCHESTRATION (findLowestDeadSlot, the junk-DNA gate, setAsOffspring, child
// creation, the T+1 birth loop) is rung 3 -- it lives in the pool, not here.

import { Vector2D } from './vector2d.js';
import { Genotype } from './genotype.js';
import { Brain } from './brain.js';
import { assert } from './assert.js';
import {
    ZERO, ONE, ONE_HALF, ONE_THIRD, PI_OVER_180, MAX_PARTS,
    NULL_INDEX, NULL_PART, ROOT_PART, MOUTH_INDEX, GENITAL_INDEX,
    YOUNG_AGE_DURATION, OLD_AGE_DURATION, STARVING, STARVING_TIMER_DELTA, TIMER_DELTA_INCREASE_RATE,
    CONTINUAL_ENERGY_DRAIN, ENERGY_USED_UP_SWIMMING, WALL_BOUNCE, SWIMBOT_SELECT_RADIUS_SCALAR,
    ENERGY_EFFICIENCY_MEASUREMENT_PERIOD, SWIMBOT_MOUTH_LENGTH, SWIMBOT_GENITAL_LENGTH, FOOD_TYPE_OFFSET,
    DEFAULT_SWIMBOT_HUNGER_THRESHOLD, BRAIN_SENSORY_UPDATE_PERIOD,
    BRAIN_FOCUS_TARGET_SHIFT_STRENGTH, BRAIN_FOCUS_TARGET_SHIFT_THRESHOLD, BRAIN_WANDER_AMOUNT,
    TOO_UGLY_TO_CHOOSE,
    BRAIN_STATE_PURSUING_FOOD, BRAIN_STATE_PURSUING_MATE,
    BRAIN_STATE_LOOKING_FOR_FOOD, BRAIN_STATE_LOOKING_FOR_MATE,
    resolvePoolBounds,
    SWIMBOT_VIEW_RADIUS, GREATEST_POSSIBLE_SWIMBOT_MASS, GREATEST_POSSIBLE_SWIMBOT_LENGTH,
    ATTRACTION_COLORFUL, ATTRACTION_BIG, ATTRACTION_HYPER, ATTRACTION_LONG, ATTRACTION_STRAIGHT,
    ATTRACTION_NO_COLOR, ATTRACTION_SMALL, ATTRACTION_STILL, ATTRACTION_SHORT, ATTRACTION_CROOKED,
    ATTRACTION_SIMILAR_COLOR, ATTRACTION_SIMILAR_SIZE, ATTRACTION_SIMILAR_HYPER,
    ATTRACTION_SIMILAR_LENGTH, ATTRACTION_SIMILAR_STRAIGHT, ATTRACTION_CLOSEST, ATTRACTION_RANDOM,
} from './constants.js';

export class Swimbot {
    // ctx = { life: { next() -> [0,1) }, matePref: (lookerId, candidateId, tick, drawIdx) -> [0,1),
    //         config, embryology, onDeath?: (index) -> void }
    constructor(ctx) {
        // Addressed RNG (P1b-ii): a swimbot's OWN draws come from its per-life SWIMBOT_LIFE stream
        // (ctx.life, a counter stream keyed on its id); mate-preference draws are PAIRWISE addressed
        // (ctx.matePref(lookerId, candidateId, tick, drawIdx)) so mate choice can't couple to scan order.
        this._life = ctx.life;
        this._matePref = ctx.matePref;
        this._config = ctx.config;
        // Pool bounds for wall collisions -- from config.pool (P3), defaulting to JJ's 8000x8000 when absent
        // (so a swimbot built without bounds, e.g. the fidelity tests, behaves byte-identically to pre-P3).
        this._pool = resolvePoolBounds(ctx.config && ctx.config.pool);
        this._embryology = ctx.embryology;
        this._onDeath = ctx.onDeath || null;

        this._genotype = new Genotype();
        this._phenotype = null; // set by create() via the shared embryology
        this._brain = new Brain();

        this._position = new Vector2D();
        this._velocity = new Vector2D();
        this._acceleration = new Vector2D();
        this._heading = new Vector2D();
        this._directionToGoal = new Vector2D();
        this._focusDirection = new Vector2D();
        this._centerOfMass = new Vector2D();
        this._vectorUtility = new Vector2D();
        this._previousFocusDirection = new Vector2D(); // reused scratch (was allocated per tick in update())
        this._lastPositionForEfficiencyMeasurement = new Vector2D();

        this._chosenFoodBit = null;
        this._chosenMate = null;
        this._age = 0;
        this._numOffspring = 0;
        this._numFoodBitsEaten = 0;
        this._index = NULL_INDEX;
        this._chosenMateIndex = NULL_INDEX;
        this._chosenFoodBitIndex = NULL_INDEX;
        this._alive = false;
        this._tryingToMate = false;
        this._tryingToEat = false;
        this._growthScale = ZERO;
        this._torque = ZERO;
        this._angle = ZERO;
        this._spin = ZERO;
        this._energy = ZERO;
        this._timer = ZERO;
        this._timerDelta = ZERO;
        this._energyEfficiency = ZERO;
        this._selectRadius = ZERO;
        this._lastEnergyForEfficiencyMeasurement = ZERO;
        this._readyforSensoryInputToBrain = false;
    }

    setParent(onDeath) { this._onDeath = onDeath; }

    // add to velocity (JJ's addForce) -- used by the pool's obstacle-collision response.
    addForce(force) { this._velocity.add(force); }
    setVelocity(v) { this._velocity.set(v); }
    setEnergy(e) { this._energy = e; }
    setAngle(a) { this._angle = a; }

    clear() {
        this._lastPositionForEfficiencyMeasurement.clear();
        this._genotype.clear();
        this._position.clear();
        this._velocity.clear();
        this._acceleration.clear();
        this._heading.clear();
        this._directionToGoal.clear();
        this._focusDirection.clear();
        this._centerOfMass.clear();
        this._vectorUtility.clear();

        this._chosenFoodBit = null;
        this._chosenMate = null;
        this._age = 0;
        this._numOffspring = 0;
        this._numFoodBitsEaten = 0;
        this._index = NULL_INDEX;
        this._chosenMateIndex = NULL_INDEX;
        this._chosenFoodBitIndex = NULL_INDEX;
        this._alive = false;
        this._tryingToMate = false;
        this._tryingToEat = false;
        this._growthScale = ZERO;
        this._torque = ZERO;
        this._angle = ZERO;
        this._spin = ZERO;
        this._energy = ZERO;
        this._timer = ZERO;
        this._timerDelta = ZERO;
        this._energyEfficiency = ZERO;
        this._selectRadius = ZERO;
        this._lastEnergyForEfficiencyMeasurement = ZERO;
        this._readyforSensoryInputToBrain = false;
    }

    create(index, age, position, angle, energy, genotype) {
        this.clear();

        this._position.copyFrom(position);
        this._index = index;
        this._angle = angle;
        this._age = age;
        this._energy = energy;
        this._alive = true;
        this._growthScale = ONE;

        this._genotype.copyFromGenotype(genotype);
        this._phenotype = this._embryology.generatePhenotypeFromGenotype(this._genotype, this._config);

        this.processPhenotype();

        this._lastPositionForEfficiencyMeasurement.set(this._position);
        this._lastEnergyForEfficiencyMeasurement = this._energy;

        this._brain.initialize();
        this._brain.setHungerThreshold(DEFAULT_SWIMBOT_HUNGER_THRESHOLD);
        this._brain.setEnergyLevel(this._energy);
        this._brain.update();
    }

    processPhenotype() {
        this._phenotype.mass = ZERO;
        assert(this._phenotype.numParts > 0, '_phenotype.numParts > 0');
        this._phenotype.sumPartLengths = ZERO;

        for (let p = 1; p < this._phenotype.numParts; p++) {
            this._phenotype.sumPartLengths += this._phenotype.parts[p].length;
            assert(this._phenotype.parts[p].length > ZERO, 'parts[p].length > ZERO');
            assert(this._phenotype.parts[p].width > ZERO, 'parts[p].width > ZERO');
            this._phenotype.parts[p].mass = this._phenotype.parts[p].length * this._phenotype.parts[p].width;
            assert(this._phenotype.parts[p].mass > ZERO, 'parts[p].mass > ZERO');
            this._phenotype.mass += this._phenotype.parts[p].mass;
        }
        assert(this._phenotype.mass > ZERO, '_phenotype.mass > ZERO');

        this.computeMomentFactors();
        this.updateBodyParts();
        this._timerDelta = ZERO;
    }

    determinePartDecendents() {
        for (let p = 1; p < this._phenotype.numParts; p++) {
            this._phenotype.parts[p].numDecendents = 0;
            for (let potentialDecendent = 1; potentialDecendent < this._phenotype.numParts; potentialDecendent++) {
                let testing = true;
                let root = potentialDecendent;
                while (testing) {
                    root = this._phenotype.parts[root].parent; // trickle the root down the ancestral tree
                    if (root === p) {
                        this._phenotype.parts[p].numDecendents++;
                        this._phenotype.parts[p].decendent[this._phenotype.parts[p].numDecendents] = potentialDecendent;
                        testing = false;
                    }
                    if (root === ROOT_PART) {
                        testing = false;
                    }
                }
            }
        }
    }

    computeMomentFactors() {
        this.determinePartDecendents();
        const oneOverMass = ONE / this._phenotype.mass;
        for (let p = 2; p < this._phenotype.numParts; p++) {
            let moment = this._phenotype.parts[p].mass * oneOverMass;
            for (let d = 1; d <= this._phenotype.parts[p].numDecendents; d++) {
                const decendent = this._phenotype.parts[p].decendent[d];
                moment += this._phenotype.parts[decendent].mass * oneOverMass;
            }
            this._phenotype.parts[p].momentFactor = moment;
        }
    }

    getMomentAdjustment() {
        let momentAdjustment = ZERO;
        for (let p = 2; p < this._phenotype.numParts; p++) {
            momentAdjustment += this._phenotype.parts[p].bendingAngle * this._phenotype.parts[p].momentFactor;
        }
        return momentAdjustment;
    }

    getPartParentPosition(p) {
        if (this._phenotype.parts[p].parent === NULL_PART) {
            return this._position;
        }
        return this._phenotype.parts[this._phenotype.parts[p].parent].position;
    }

    calculateCenterOfMass() {
        this._centerOfMass.clear();
        for (let p = 1; p < this._phenotype.numParts; p++) {
            this._centerOfMass.addScaled(this._phenotype.parts[p].midPosition, this._phenotype.parts[p].mass);
        }
        this._centerOfMass.scale(ONE / this._phenotype.mass);
    }

    adjustToCenterOfMass() {
        const offsetX = this._position.x - this._centerOfMass.x;
        const offsetY = this._position.y - this._centerOfMass.y;
        for (let p = 0; p < this._phenotype.numParts; p++) {
            this._phenotype.parts[p].position.addXY(offsetX, offsetY);
            this._phenotype.parts[p].midPosition.addXY(offsetX, offsetY);
        }
    }

    updateBodyParts() {
        const oldAgeThreshold = this._config.maximumLifeSpan - OLD_AGE_DURATION;

        if (this._age < oldAgeThreshold) {
            if (this._age < YOUNG_AGE_DURATION) {
                this._growthScale = this._age / YOUNG_AGE_DURATION;
            } else {
                this._growthScale = ONE;
            }
            assert(this._growthScale >= 0.0, '_growthScale >= 0.0');
            assert(this._growthScale <= 1.0, '_growthScale <= 1.0');

            if (this._energy < STARVING) {
                this._timerDelta = this._energy / STARVING;
                if (this._timerDelta < STARVING_TIMER_DELTA) {
                    this._timerDelta = STARVING_TIMER_DELTA;
                }
            } else {
                this._timerDelta += TIMER_DELTA_INCREASE_RATE;
                if (this._timerDelta > ONE) {
                    this._timerDelta = ONE;
                }
            }
        } else {
            if (this._age > this._config.maximumLifeSpan) {
                this.die();
            } else {
                this._timerDelta = ONE - (this._age - oldAgeThreshold) / OLD_AGE_DURATION;
                assert(this._timerDelta >= 0.0, '_timerDelta >= 0.0');
                assert(this._timerDelta <= 1.0, '_timerDelta <= 1.0');
            }
        }

        this._timer += this._timerDelta;

        const radian = this._angle * PI_OVER_180;
        this._heading.x = Math.sin(radian);
        this._heading.y = Math.cos(radian);

        const perpX = this._heading.y;
        const perpY = -this._heading.x;

        const directionDot = this._focusDirection.x * perpX + this._focusDirection.y * perpY;

        // PERF: hoist the repeated `this._phenotype.parts[...]` / `.frequency` lookups (pure reference
        // aliasing -- `part`/`parentPart` are the same objects, so every read/write is identical; no float
        // arithmetic is reordered). Bit-for-bit unchanged.
        const parts = this._phenotype.parts;
        const numParts = this._phenotype.numParts;
        const frequency = this._phenotype.frequency;

        parts[ROOT_PART].position.set(this._position);
        parts[ROOT_PART].currentAngle = this._angle - this.getMomentAdjustment();

        for (let p = 1; p < numParts; p++) {
            const part = parts[p];
            const parentPart = parts[part.parent];
            part.position.set(this.getPartParentPosition(p));

            part.currentAngle = parentPart.currentAngle + part.angle;

            if (p > 1) { // part 1 has nothing to 'bend' off of
                const ampModulator = part.turnAmp * directionDot;
                const phaseModulator = part.turnPhase * directionDot;

                const bendRadian = this._timer * frequency + (part.phase + phaseModulator);
                part.bendingAngle = (part.amp + ampModulator) * Math.sin(bendRadian);

                part.currentAngle += part.bendingAngle;
            }

            const partRadian = part.currentAngle * PI_OVER_180;
            let length = part.length;

            if (this._age < YOUNG_AGE_DURATION) {
                length *= this._growthScale;
            }

            const x = length * Math.sin(partRadian);
            const y = length * Math.cos(partRadian);
            part.previousMid.setXY(part.midPosition.x, part.midPosition.y);
            part.midPosition.setXY(part.position.x, part.position.y);
            part.position.addXY(x, y);
            part.midPosition.addXY(x * ONE_HALF, y * ONE_HALF);

            part.axis.x = part.position.x - parentPart.position.x;
            part.axis.y = part.position.y - parentPart.position.y;

            part.perpendicular.setXY(part.axis.y / length, -part.axis.x / length);

            part.velocity.setToDifference(part.midPosition, part.previousMid);
        }

        // COM -> adjust (the only reader of _centerOfMass) -> [removed a dead 2nd calculateCenterOfMass():
        // its write to _centerOfMass was never read before line 343 recomputes it next tick]. Bit-for-bit.
        this.calculateCenterOfMass();
        this.adjustToCenterOfMass();

        if (this._age % 20 === 0) {
            for (let p = 1; p < this._phenotype.numParts; p++) {
                for (let o = 1; o < this._phenotype.numParts; o++) {
                    if (o !== p) {
                        let distance = this._phenotype.parts[p].position.getDistanceTo(this._phenotype.parts[o].position);
                        distance = SWIMBOT_SELECT_RADIUS_SCALAR * Math.sqrt(distance);
                        if (distance > this._selectRadius) {
                            this._selectRadius = distance;
                        }
                    }
                }
            }
        }
    }

    update() {
        this._age++;

        if (this._age % BRAIN_SENSORY_UPDATE_PERIOD === 0) {
            this._readyforSensoryInputToBrain = true;
        }

        this._brain.setEnergyLevel(this._energy);
        this._brain.update();

        if (this._brain.getState() === BRAIN_STATE_PURSUING_FOOD) {
            if ((this._chosenFoodBit !== null) && (this._chosenFoodBit.getAlive())) {
                const xx = this._chosenFoodBit.getPosition().x - this.getMouthPosition().x;
                const yy = this._chosenFoodBit.getPosition().y - this.getMouthPosition().y;
                const distance = Math.sqrt(xx * xx + yy * yy);
                if (distance < SWIMBOT_MOUTH_LENGTH) {
                    this._tryingToEat = true;
                }
            }
        } else if (this._brain.getState() === BRAIN_STATE_PURSUING_MATE) {
            if ((this._chosenMate !== null) && (this._chosenMate.getAlive())) {
                const xx = this._chosenMate.getGenitalPosition().x - this.getGenitalPosition().x;
                const yy = this._chosenMate.getGenitalPosition().y - this.getGenitalPosition().y;
                const distance = Math.sqrt(xx * xx + yy * yy);
                if (distance < SWIMBOT_GENITAL_LENGTH) {
                    this._tryingToMate = true;
                }
            }
        }

        if ((this._brain.getState() === BRAIN_STATE_LOOKING_FOR_FOOD)
            || (this._brain.getState() === BRAIN_STATE_LOOKING_FOR_MATE)) {
            this.wanderFocus();
        } else if (this._brain.getState() === BRAIN_STATE_PURSUING_MATE) {
            if (this._chosenMate !== null) {
                this._directionToGoal.set(this._chosenMate.getGenitalPosition());
                this._directionToGoal.subtract(this._phenotype.parts[GENITAL_INDEX].position);
                this._directionToGoal.normalize();
            }
        } else if (this._brain.getState() === BRAIN_STATE_PURSUING_FOOD) {
            if (this._chosenFoodBit !== null) {
                this._directionToGoal.set(this._chosenFoodBit.getPosition());
                this._directionToGoal.subtract(this._phenotype.parts[MOUTH_INDEX].position);
                this._directionToGoal.normalize();
            }
        }

        const previousFocusDirection = this._previousFocusDirection; // reused scratch; set fresh each call below
        previousFocusDirection.set(this._focusDirection);

        this._focusDirection.addScaled(this._directionToGoal, BRAIN_FOCUS_TARGET_SHIFT_STRENGTH);

        this._vectorUtility.setToDifference(this._focusDirection, previousFocusDirection);

        if (this._vectorUtility.getMagnitudeSquared() > BRAIN_FOCUS_TARGET_SHIFT_THRESHOLD * BRAIN_FOCUS_TARGET_SHIFT_THRESHOLD) {
            this._focusDirection.set(previousFocusDirection);
            this._focusDirection.addScaled(this._directionToGoal, BRAIN_FOCUS_TARGET_SHIFT_THRESHOLD);
        }

        this._focusDirection.normalize();

        this.updateBodyParts();
        this.updatePhysics();
    }

    wanderFocus() {
        let length = this._directionToGoal.getMagnitude();

        if (length === ZERO) {
            this._directionToGoal.x = -ONE_HALF + this._life.next();
            this._directionToGoal.y = -ONE_HALF + this._life.next();
            length = this._directionToGoal.getMagnitude();
        }

        this._directionToGoal.x += (-BRAIN_WANDER_AMOUNT * ONE_HALF + this._life.next() * BRAIN_WANDER_AMOUNT);
        this._directionToGoal.y += (-BRAIN_WANDER_AMOUNT * ONE_HALF + this._life.next() * BRAIN_WANDER_AMOUNT);

        this._directionToGoal.x /= length;
        this._directionToGoal.y /= length;
    }

    updatePhysics() {
        this.calculateFluidForces();

        if (this._age % ENERGY_EFFICIENCY_MEASUREMENT_PERIOD === 0) {
            this.calculateEnergyEfficiency();
        }

        this._energy -= CONTINUAL_ENERGY_DRAIN;

        if (this._energy <= ZERO) {
            this._energy = ZERO;
            this.die();
        }

        this.updateWallCollisions();
    }

    calculateFluidForces() {
        this._acceleration.clear();
        this._torque = ZERO;
        assert(this._phenotype.numParts > 0, '_phenotype.numParts > 0');

        // PERF: hoist the repeated phenotype/parts lookups (pure reference aliasing; no float reorder).
        const parts = this._phenotype.parts;
        const numParts = this._phenotype.numParts;
        const sumPartLengths = this._phenotype.sumPartLengths;

        for (let p = 1; p < numParts; p++) {
            const part = parts[p];
            const fractionOfWhole = part.length / sumPartLengths;

            // LOAD-BEARING: recompute velocity here -- adjustToCenterOfMass shifted midPosition (not
            // previousMid) after updateBodyParts, so this folds the COM shift into strokeAmplitude. Do NOT
            // remove (verified: removing it crashes the population).
            part.velocity.setToDifference(part.midPosition, part.previousMid);

            const strokeAmplitude = part.velocity.dotWith(part.perpendicular) * fractionOfWhole;

            const strokeForceX = part.perpendicular.x * strokeAmplitude;
            const strokeForceY = part.perpendicular.y * strokeAmplitude;

            this._energy -= Math.abs(strokeAmplitude) * ENERGY_USED_UP_SWIMMING;
            if (this._energy < ZERO) {
                this._energy = ZERO;
            }

            const partVectorFromCenterX = part.midPosition.x - this._position.x;
            const partVectorFromCenterY = part.midPosition.y - this._position.y;

            // Faithful quirk: JJ forms sqrt(dx^4 + dy^4) here (squares the components first -- NOT Euclidean
            // distance), but it feeds ONLY this guard (and a commented-out partDirectionFromCenter). PERF:
            // drop the dead sqrt and test the radicand directly -- sqrt(v) > 0 iff v > 0 for all v >= 0, so
            // the branch taken is bit-identical. Keep the sum-of-squares form (dx!==0||dy!==0 would differ
            // when dx^4 underflows to 0). Output unchanged.
            const xx = partVectorFromCenterX * partVectorFromCenterX;
            const yy = partVectorFromCenterY * partVectorFromCenterY;

            if (xx * xx + yy * yy > ZERO) {
                const partAccelerationX = -strokeForceX;
                const partAccelerationY = -strokeForceY;

                this._acceleration.x += partAccelerationX;
                this._acceleration.y += partAccelerationY;

                const partPerpendicularX = partVectorFromCenterY;
                const partPerpendicularY = -partVectorFromCenterX;

                const perpDot = (strokeForceX * partPerpendicularX + strokeForceY * partPerpendicularY) / sumPartLengths;

                this._torque -= perpDot;
            }
        }

        this._velocity.add(this._acceleration);
        this._spin += this._torque;

        this._position.add(this._velocity);
        this._angle += this._spin;
    }

    calculateEnergyEfficiency() {
        const distanceTraveled = this._position.getDistanceTo(this._lastPositionForEfficiencyMeasurement);
        const averageSpeed = distanceTraveled / ENERGY_EFFICIENCY_MEASUREMENT_PERIOD;
        let energyLost = this._lastEnergyForEfficiencyMeasurement - this._energy;

        if (energyLost < ZERO) {
            energyLost = ZERO;
        }

        this._energyEfficiency = averageSpeed / (ONE + energyLost);

        this._lastPositionForEfficiencyMeasurement.set(this._position);
        this._lastEnergyForEfficiencyMeasurement = this._energy;
    }

    updateWallCollisions() {
        const { left: POOL_LEFT, right: POOL_RIGHT, top: POOL_TOP, bottom: POOL_BOTTOM } = this._pool;
        if (this._position.x < POOL_LEFT + this._phenotype.sumPartLengths * ONE_HALF) {
            for (let p = 1; p < this._phenotype.numParts; p++) {
                const radius = this._phenotype.parts[p].length + this._phenotype.parts[p].width;
                const limit = POOL_LEFT + radius;
                if (this._phenotype.parts[p].position.x < limit) {
                    const penetration = limit - this._phenotype.parts[p].position.x;
                    this._position.x += penetration * WALL_BOUNCE;
                    this._velocity.x += penetration * WALL_BOUNCE;
                    this._directionToGoal.x += penetration * WALL_BOUNCE;
                    this._directionToGoal.normalize();
                }
            }
        } else if (this._position.x > POOL_RIGHT - this._phenotype.sumPartLengths * ONE_HALF) {
            for (let p = 1; p < this._phenotype.numParts; p++) {
                const radius = this._phenotype.parts[p].length + this._phenotype.parts[p].width;
                const limit = POOL_RIGHT - radius;
                if (this._phenotype.parts[p].position.x > limit) {
                    const penetration = limit - this._phenotype.parts[p].position.x;
                    this._position.x += penetration * WALL_BOUNCE;
                    this._velocity.x += penetration * WALL_BOUNCE;
                    this._directionToGoal.x += penetration * WALL_BOUNCE;
                    this._directionToGoal.normalize();
                }
            }
        }

        if (this._position.y < POOL_TOP + this._phenotype.sumPartLengths * ONE_HALF) {
            for (let p = 1; p < this._phenotype.numParts; p++) {
                const radius = this._phenotype.parts[p].length + this._phenotype.parts[p].width;
                const limit = POOL_TOP + radius;
                if (this._phenotype.parts[p].position.y < limit) {
                    const penetration = limit - this._phenotype.parts[p].position.y;
                    this._position.y += penetration * WALL_BOUNCE;
                    this._velocity.y += penetration * WALL_BOUNCE;
                    this._directionToGoal.y += penetration * WALL_BOUNCE;
                    this._directionToGoal.normalize();
                }
            }
        } else if (this._position.y > POOL_BOTTOM - this._phenotype.sumPartLengths * ONE_HALF) {
            for (let p = 1; p < this._phenotype.numParts; p++) {
                const radius = this._phenotype.parts[p].length + this._phenotype.parts[p].width;
                const limit = POOL_BOTTOM - radius;
                if (this._phenotype.parts[p].position.y > limit) {
                    const penetration = limit - this._phenotype.parts[p].position.y;
                    this._position.y += penetration * WALL_BOUNCE;
                    this._velocity.y += penetration * WALL_BOUNCE;
                    this._directionToGoal.y += penetration * WALL_BOUNCE;
                    this._directionToGoal.normalize();
                }
            }
        }
    }

    eatChosenFoodBit() {
        // JJ asserts _chosenFoodBit is non-null + alive here, but his assert() only alerts-then-CONTINUES
        // (browser), so it falls through to the guard below. This is a RECOVERABLE case, not a bug: a
        // swimbot can be _tryingToEat (set in update()) yet have its chosen food nulled by the perception
        // that runs between (food that moved behind the obstacle -> foundFoodBit=false -> _chosenFoodBit
        // null). Throwing here would abort the tick where JJ skips; the guard handles it faithfully.
        if ((this._chosenFoodBit !== null) && (this._chosenFoodBit.getAlive())) {
            let energyFromFoodBit = this._chosenFoodBit.getEnergy();

            if (this._config.numFoodTypes > 1) {
                if (this._chosenFoodBit.getType() !== this._phenotype.digestibleFoodType) {
                    energyFromFoodBit *= FOOD_TYPE_OFFSET;
                }
            }

            this._energy += energyFromFoodBit;
            this._numFoodBitsEaten++;

            assert(this._chosenFoodBit.getEnergy() >= ZERO, 'eatChosenFoodBit: food energy >= ZERO');

            this._tryingToEat = false;
            this._timerDelta = ZERO;

            assert(this._chosenFoodBitIndex !== NULL_INDEX, 'eatChosenFoodBit: _chosenFoodBitIndex != NULL_INDEX');

            this._chosenFoodBit.kill();
        }

        return this._chosenFoodBitIndex;
    }

    setEnvironmentalStimuli(numNearbySwimbots, nearbySwimbotArray, foodBitWasFound, theFoodBit, tick) {
        this._chosenFoodBit = null;
        this._chosenFoodBitIndex = NULL_INDEX;

        if ((this._brain.getState() === BRAIN_STATE_LOOKING_FOR_FOOD)
            || (this._brain.getState() === BRAIN_STATE_PURSUING_FOOD)) {
            this._brain.setFoundFoodBit(foodBitWasFound);
            if (foodBitWasFound) {
                assert(theFoodBit !== null, 'setEnvironmentalStimuli: theFoodBit != null');
                this._chosenFoodBit = theFoodBit;
                this._chosenFoodBitIndex = this._chosenFoodBit.getIndex();
            }
        }

        if (this._brain.getState() === BRAIN_STATE_LOOKING_FOR_MATE) {
            let mostAttractiveFound = null;
            let atLeastOneBabeIsVisible = false;
            // D-b argmax: (attractiveness DESC, distanceSquared ASC, stableID ASC). getAttractiveness is
            // still called once per candidate (draw structure preserved); the addressed MATE_PREF draw is
            // order-independent, so the winner is a deterministic function of the candidate set, not the
            // scan order. distance^2 and id break attractiveness ties.
            let bestFactor = -100.0;
            let bestDistSq = Infinity;
            let bestId = Infinity;

            for (let o = 0; o < numNearbySwimbots; o++) {
                const candidate = nearbySwimbotArray[o];
                const babeFactor = candidate.getAttractiveness(this, tick);
                if (!((babeFactor > TOO_UGLY_TO_CHOOSE)
                    && (candidate.getAge() > YOUNG_AGE_DURATION)
                    && (candidate.getEnergy() > STARVING))) continue;
                const dx = candidate.getGenitalPosition().x - this.getGenitalPosition().x;
                const dy = candidate.getGenitalPosition().y - this.getGenitalPosition().y;
                const distSq = dx * dx + dy * dy;
                const id = candidate.getIndex();
                const better = (babeFactor > bestFactor)
                    || (babeFactor === bestFactor && distSq < bestDistSq)
                    || (babeFactor === bestFactor && distSq === bestDistSq && id < bestId);
                if (better) {
                    bestFactor = babeFactor;
                    bestDistSq = distSq;
                    bestId = id;
                    mostAttractiveFound = candidate;
                    atLeastOneBabeIsVisible = true;
                }
            }

            if (atLeastOneBabeIsVisible) {
                this._chosenMate = mostAttractiveFound;
                this._chosenMateIndex = mostAttractiveFound.getIndex();
                assert(this._chosenMateIndex !== NULL_INDEX, '_chosenMateIndex != NULL_INDEX');
                this._brain.setFoundSwimbot(true);
            } else {
                this._brain.setFoundSwimbot(false);
            }
        } else if (this._brain.getState() === BRAIN_STATE_PURSUING_MATE) {
            let ICanStillSeeYou = false;
            for (let o = 0; o < numNearbySwimbots; o++) {
                const index = nearbySwimbotArray[o].getIndex();
                if (index === this._chosenMateIndex) {
                    ICanStillSeeYou = true;
                    this._chosenMate = nearbySwimbotArray[o];
                }
            }
            if (!ICanStillSeeYou) {
                this._brain.setFoundSwimbot(false);
                this._chosenMate = null;
                this._chosenMateIndex = NULL_INDEX;
            }
        }

        this._readyforSensoryInputToBrain = false;
    }

    contributeToOffspring() {
        const energyToContribute = this._energy * this._config.childEnergyRatio;
        this._energy -= energyToContribute;
        assert(this._energy >= ZERO, 'contributeToOffspring: _energy >= ZERO');
        this._numOffspring++;
        this._timerDelta = ZERO;
        this._tryingToMate = false;
        this._chosenMate = null;
        this._chosenMateIndex = NULL_INDEX;
        this._brain.setFoundSwimbot(false);
        return energyToContribute;
    }

    // --- mate attraction (rung 2). getAttractiveness draws gpRandom() ONCE at the top (the mate-scan
    // draw that MUST be preserved), then overwrites it per the brain's criterion (ATTRACTION_RANDOM draws
    // a second time). `judge` is the swimbot doing the judging (for the "similar-to-me" criteria). All
    // the metric helpers are RNG-free pure functions of the phenotype. ---
    setAttraction(attraction) {
        this._brain.setAttraction(attraction);
    }

    getAttractiveness(judge, tick) {
        // PAIRWISE addressed: the top draw is MATE_PREF(lookerId=judge, candidateId=this, tick, 0) --
        // a pure function of WHO is judging WHOM and WHEN, independent of perception/scan order.
        let attractiveness = this._matePref(judge.getIndex(), this._index, tick, 0);

        const attractionCriterion = this._brain.getAttractionCriterion();

        if (attractionCriterion === ATTRACTION_COLORFUL) { attractiveness = this.getColorSaturation(); }
        if (attractionCriterion === ATTRACTION_BIG) { attractiveness = this.getCurrentBodyBigness(); }
        if (attractionCriterion === ATTRACTION_HYPER) { attractiveness = this.getCurrentBodyHyperness(); }
        if (attractionCriterion === ATTRACTION_LONG) { attractiveness = this.getCurrentBodyLongness(); }
        if (attractionCriterion === ATTRACTION_STRAIGHT) { attractiveness = this.getCurrentBodyStraightness(); }

        if (attractionCriterion === ATTRACTION_NO_COLOR) { attractiveness = ONE - this.getColorSaturation(); }
        if (attractionCriterion === ATTRACTION_SMALL) { attractiveness = ONE - this.getCurrentBodyBigness(); }
        if (attractionCriterion === ATTRACTION_STILL) { attractiveness = ONE - this.getCurrentBodyHyperness(); }
        if (attractionCriterion === ATTRACTION_SHORT) { attractiveness = ONE - this.getCurrentBodyLongness(); }
        if (attractionCriterion === ATTRACTION_CROOKED) { attractiveness = ONE - this.getCurrentBodyStraightness(); }

        if (attractionCriterion === ATTRACTION_SIMILAR_COLOR) { attractiveness = this.getColorSimilarity(judge); }
        if (attractionCriterion === ATTRACTION_SIMILAR_SIZE) { attractiveness = this.getBignessSimilarity(judge); }
        if (attractionCriterion === ATTRACTION_SIMILAR_HYPER) { attractiveness = this.getHypernessSimilarity(judge); }
        if (attractionCriterion === ATTRACTION_SIMILAR_LENGTH) { attractiveness = this.getLengthSimilarity(judge); }
        if (attractionCriterion === ATTRACTION_SIMILAR_STRAIGHT) { attractiveness = this.getStraightessSimilarity(judge); }

        if (attractionCriterion === ATTRACTION_CLOSEST) { attractiveness = this.getCloseness(judge); }
        if (attractionCriterion === ATTRACTION_RANDOM) { attractiveness = this._matePref(judge.getIndex(), this._index, tick, 1); }

        return attractiveness;
    }

    getColorSaturation() {
        let saturation = ZERO;
        let accumulatedMass = ZERO;
        for (let p = 1; p < this._phenotype.numParts; p++) {
            accumulatedMass += this._phenotype.parts[p].mass;
            const rgDiff = Math.abs(this._phenotype.parts[p].red - this._phenotype.parts[p].green);
            const rbDiff = Math.abs(this._phenotype.parts[p].red - this._phenotype.parts[p].blue);
            const gbDiff = Math.abs(this._phenotype.parts[p].green - this._phenotype.parts[p].blue);
            let thisPartSaturation = (rgDiff + rbDiff + gbDiff) / 3;
            assert(thisPartSaturation <= ONE, 'thisPartSaturation <= ONE');
            thisPartSaturation *= this._phenotype.parts[p].mass;
            saturation += thisPartSaturation;
        }
        assert(accumulatedMass > ZERO, 'getColorSaturation: accumulatedMass > ZERO');
        saturation /= accumulatedMass;
        assert(saturation <= ONE, 'getColorSaturation: saturation <= ONE');
        return saturation;
    }

    getCloseness(judge) {
        let closest = SWIMBOT_VIEW_RADIUS;
        const distance = this._position.getDistanceTo(judge.getPosition());
        if (distance < closest) {
            closest = distance;
        }
        return ONE - (closest / SWIMBOT_VIEW_RADIUS);
    }

    getSimilarity(judge) {
        let amount = this.getColorSimilarity(judge)
            + this.getBignessSimilarity(judge)
            + this.getHypernessSimilarity(judge)
            + this.getLengthSimilarity(judge)
            + this.getStraightessSimilarity(judge);
        amount /= 5;
        return amount;
    }

    getColorSimilarity(judge) {
        const c1 = judge.getAverageColor();
        const c2 = this.getAverageColor();
        const rDiff = Math.abs(c2.red - c1.red);
        const gDiff = Math.abs(c2.green - c1.green);
        const bDiff = Math.abs(c2.blue - c1.blue);
        return ONE - ((rDiff + gDiff + bDiff) * ONE_THIRD);
    }

    getBignessSimilarity(judge) {
        const b1 = judge.getCurrentBodyBigness();
        const b2 = this.getCurrentBodyBigness();
        return ONE - Math.abs(b1 - b2);
    }

    getHypernessSimilarity(judge) {
        const b1 = judge.getCurrentBodyHyperness();
        const b2 = this.getCurrentBodyHyperness();
        return ONE - Math.abs(b1 - b2);
    }

    getLengthSimilarity(judge) {
        const b1 = judge.getCurrentBodyLongness();
        const b2 = this.getCurrentBodyLongness();
        return ONE - Math.abs(b1 - b2);
    }

    getStraightessSimilarity(judge) {
        const b1 = judge.getCurrentBodyStraightness();
        const b2 = this.getCurrentBodyStraightness();
        return ONE - Math.abs(b1 - b2);
    }

    getCurrentBodyBigness() {
        return this._phenotype.mass / GREATEST_POSSIBLE_SWIMBOT_MASS;
    }

    getCurrentBodyLongness() {
        let amount = ZERO;
        for (let p = 1; p < this._phenotype.numParts; p++) {
            for (let pp = 1; pp < this._phenotype.numParts; pp++) {
                if (pp !== p) {
                    const d = this._phenotype.parts[p].midPosition.getDistanceTo(this._phenotype.parts[pp].midPosition);
                    if (d > amount) {
                        amount = d;
                    }
                }
            }
        }
        amount /= GREATEST_POSSIBLE_SWIMBOT_LENGTH;
        return amount;
    }

    getCurrentBodyStraightness() {
        let amount = ZERO;
        const v = new Array();
        for (let p = 1; p < this._phenotype.numParts; p++) {
            v[p] = new Vector2D();
            v[p].setXY(this._phenotype.parts[p].axis.x / this._phenotype.parts[p].length, this._phenotype.parts[p].axis.y / this._phenotype.parts[p].length);
        }
        if (this._phenotype.numParts < 3) {
            amount = ONE;
        } else {
            let numTests = 0;
            for (let p = 1; p < this._phenotype.numParts; p++) {
                for (let pp = p + 1; pp < this._phenotype.numParts; pp++) {
                    numTests++;
                    assert(p !== pp, 'getCurrentBodyStraightness: p != pp');
                    amount += Math.abs(v[p].dotWith(v[pp]));
                }
            }
            amount /= numTests;
        }
        amount *= 0.7;
        amount += (this._phenotype.numParts / MAX_PARTS) * 0.3;
        if (amount > ONE) {
            amount = ONE;
        }
        return amount;
    }

    getCurrentBodyHyperness() {
        let amount = ZERO;
        for (let p = 1; p < this._phenotype.numParts; p++) {
            amount += this._phenotype.parts[p].velocity.getMagnitude();
        }
        const FugdeFactorToScaleHyperAttraction = 0.4;
        amount *= FugdeFactorToScaleHyperAttraction;
        if (amount > ONE) {
            amount = ONE;
        }
        return amount;
    }

    getAverageColor() {
        let r = ZERO;
        let g = ZERO;
        let b = ZERO;
        let accumulatedMass = ZERO;
        for (let p = 1; p < this._phenotype.numParts; p++) {
            accumulatedMass += this._phenotype.parts[p].mass;
            r += this._phenotype.parts[p].red * this._phenotype.parts[p].mass;
            g += this._phenotype.parts[p].green * this._phenotype.parts[p].mass;
            b += this._phenotype.parts[p].blue * this._phenotype.parts[p].mass;
        }
        assert(accumulatedMass > ZERO, 'getAverageColor: accumulatedMass > ZERO');
        r /= accumulatedMass;
        g /= accumulatedMass;
        b /= accumulatedMass;
        assert(r <= ONE, 'getAverageColor: r <= ONE');
        assert(g <= ONE, 'getAverageColor: g <= ONE');
        assert(b <= ONE, 'getAverageColor: b <= ONE');
        return { red: r, green: g, blue: b }; // JJ returns a Color; only red/green/blue are read
    }

    die() {
        // Idempotent: a swimbot can be told to die twice in a tick (old age AND starvation). The pool's
        // death accounting / lineage must not double-count. (No sim effect beyond flipping _alive.)
        if (!this._alive) { return; }
        this._alive = false;
        if (this._index !== NULL_INDEX && this._onDeath) {
            this._onDeath(this._index);
        }
    }

    // Getters (parallel to JJ's).
    getIsTryingToEat() { return this._tryingToEat; }
    getIsTryingToMate() { return this._tryingToMate; }
    getIndex() { return this._index; }
    getAge() { return this._age; }
    getAlive() { return this._alive; }
    getEnergy() { return this._energy; }
    getAngle() { return this._angle; }
    getEnergyEfficiency() { return this._energyEfficiency; }
    getPosition() { return this._position; }
    getBoundingRadius() { return this._phenotype.sumPartLengths; }
    getNumParts() { return this._phenotype.numParts; }
    getIsLookingForSensoryInput() { return this._readyforSensoryInputToBrain; }
    getGenitalPosition() { return this._phenotype.parts[GENITAL_INDEX].position; }
    getMouthPosition() { return this._phenotype.parts[MOUTH_INDEX].position; }
    getChosenMateIndex() { return this._chosenMateIndex; }
    getChosenFoodBitIndex() { return this._chosenFoodBitIndex; }
    getNumOffspring() { return this._numOffspring; }
    getNumFoodBitsEaten() { return this._numFoodBitsEaten; }
    setNumOffspring(n) { this._numOffspring = n; }
    setNumFoodBitsEaten(n) { this._numFoodBitsEaten = n; }
    getBrainState() { return this._brain.getState(); }
    getGenotype() { return this._genotype; }
    getSelectRadius() { return this._selectRadius; }
    getPreferredFoodType() { return this._phenotype.preferredFoodType; }
    getDigestibleFoodType() { return this._phenotype.digestibleFoodType; }
    getPhenotype() { return this._phenotype; }
    setHungerThreshold(t) { this._brain.setHungerThreshold(t); }
    getChosenMate() { return this._chosenMate; }             // the OBJECT ref (may be a swept/dead swimbot)
    getChosenFoodBit() { return this._chosenFoodBit; }       // the OBJECT ref (may be a swept/dead food bit)

    // --- checkpoint (H1): the FULL between-tick mutable state so a restore resumes bit-identically.
    // Captures the accumulated scalars/vectors (which create() would reset to fresh values), the brain FSM,
    // the per-life RNG stream position, and the per-part carried geometry (previousMid/midPosition drive next
    // tick's velocity). Chosen mate/food are stored as INDICES; the World relinks the objects on restore
    // (including "ghost" refs to swept-but-still-referenced entities -- the steering at update():404/411 uses
    // a dead ref's frozen position, so it must be preserved).
    serializeCheckpoint() {
        const parts = [];
        for (let p = 0; p < this._phenotype.numParts; p++) {
            const pt = this._phenotype.parts[p];
            parts.push([
                pt.position.x, pt.position.y, pt.midPosition.x, pt.midPosition.y,
                pt.previousMid.x, pt.previousMid.y, pt.velocity.x, pt.velocity.y,
                pt.axis.x, pt.axis.y, pt.perpendicular.x, pt.perpendicular.y,
                pt.currentAngle, pt.bendingAngle,
            ]);
        }
        return {
            index: this._index, age: this._age, energy: this._energy, angle: this._angle, alive: this._alive,
            genes: Array.from(this._genotype.getGenes()),
            pos: [this._position.x, this._position.y], vel: [this._velocity.x, this._velocity.y],
            spin: this._spin, timer: this._timer, timerDelta: this._timerDelta, growthScale: this._growthScale,
            torque: this._torque, energyEfficiency: this._energyEfficiency, selectRadius: this._selectRadius,
            focus: [this._focusDirection.x, this._focusDirection.y],
            goal: [this._directionToGoal.x, this._directionToGoal.y],
            lastPos: [this._lastPositionForEfficiencyMeasurement.x, this._lastPositionForEfficiencyMeasurement.y],
            lastEnergy: this._lastEnergyForEfficiencyMeasurement,
            numOffspring: this._numOffspring, numFoodBitsEaten: this._numFoodBitsEaten,
            chosenMateIndex: this._chosenMateIndex, chosenFoodBitIndex: this._chosenFoodBitIndex,
            tryingToMate: this._tryingToMate, tryingToEat: this._tryingToEat,
            readyForSensory: this._readyforSensoryInputToBrain,
            brain: this._brain.serializeCheckpoint(), lifePosition: this._life.position, parts,
        };
    }

    // Called AFTER create(index, age, pos, angle, energy, genotype) rebuilt the phenotype (from genes) -- this
    // overwrites the fresh state with the checkpointed accumulated state + carried part geometry.
    restoreCheckpointState(d) {
        this._age = d.age; this._energy = d.energy; this._angle = d.angle; this._alive = d.alive;
        this._position.setXY(d.pos[0], d.pos[1]); this._velocity.setXY(d.vel[0], d.vel[1]);
        this._spin = d.spin; this._timer = d.timer; this._timerDelta = d.timerDelta; this._growthScale = d.growthScale;
        this._torque = d.torque; this._energyEfficiency = d.energyEfficiency; this._selectRadius = d.selectRadius;
        this._focusDirection.setXY(d.focus[0], d.focus[1]); this._directionToGoal.setXY(d.goal[0], d.goal[1]);
        this._lastPositionForEfficiencyMeasurement.setXY(d.lastPos[0], d.lastPos[1]);
        this._lastEnergyForEfficiencyMeasurement = d.lastEnergy;
        this._numOffspring = d.numOffspring; this._numFoodBitsEaten = d.numFoodBitsEaten;
        this._chosenMateIndex = d.chosenMateIndex; this._chosenFoodBitIndex = d.chosenFoodBitIndex;
        this._tryingToMate = d.tryingToMate; this._tryingToEat = d.tryingToEat;
        this._readyforSensoryInputToBrain = d.readyForSensory;
        this._brain.restoreCheckpoint(d.brain);
        if (this._life && 'position' in this._life) this._life.position = d.lifePosition;
        for (let p = 0; p < this._phenotype.numParts; p++) {
            const pt = this._phenotype.parts[p], s = d.parts[p];
            pt.position.setXY(s[0], s[1]); pt.midPosition.setXY(s[2], s[3]); pt.previousMid.setXY(s[4], s[5]);
            pt.velocity.setXY(s[6], s[7]); pt.axis.setXY(s[8], s[9]); pt.perpendicular.setXY(s[10], s[11]);
            pt.currentAngle = s[12]; pt.bendingAngle = s[13];
        }
    }

    // Relink chosen mate/food OBJECT refs from the stored indices. resolve(id) returns the entity object
    // (live OR ghost) or undefined; a missing ref becomes null (matches a chosenIndex of NULL_INDEX).
    relinkChosen(resolveSwimbot, resolveFood) {
        this._chosenMate = this._chosenMateIndex === NULL_INDEX ? null : (resolveSwimbot(this._chosenMateIndex) || null);
        this._chosenFoodBit = this._chosenFoodBitIndex === NULL_INDEX ? null : (resolveFood(this._chosenFoodBitIndex) || null);
    }
}
