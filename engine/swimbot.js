// Swimbot — forked from JJ's Swimbot.js as an ES module (PLAN-restructure.md §15). BEHAVIOR-FAITHFUL:
// the per-tick physics/brain/eat path is bit-exact against JJ (proven by the rung-1 in-process A/B in
// test/engine/swimbot-fidelity.test.js), so operator order, the faithful quirks, and draw order are all
// preserved. Two structural changes per the plan:
//   - randomness is INJECTED (ctx.rng = () -> [0,1)), never a global gpRandom (§3). Draw SITES/ORDER are
//     unchanged: wanderFocus() draws 2 (or 4 on the first, zero-direction call); getAttractiveness draws.
//   - world params are INJECTED (ctx.config): maximumLifeSpan, numFoodTypes, childEnergyRatio, and pool
//     bounds -- JJ read these off globalTweakers / POOL_* globals (§11). Mechanism scalars stay constant.
// die() no longer touches a global dead-count or a FamilyTree; it flips _alive (idempotently) and calls
// an injected onDeath hook -- the pool owns death accounting / lineage (wired at P1b).
//
// COVERAGE STATUS (rung-by-rung, PLAN §19). Rung 1 (swimbot-fidelity.test.js) A/B-validates the
// AUTONOMOUS per-tick path bit-for-bit: create/processPhenotype, updateBodyParts + all physics
// helpers, calculateFluidForces, calculateEnergyEfficiency, updateWallCollisions, wanderFocus, the Brain
// FSM, aging/growth, and both death paths. NOT yet exercised (ported faithfully, validated in later
// rungs): eatChosenFoodBit + setEnvironmentalStimuli's food branch (rung 1b), and the MATE path
// (rung 2) -- contributeToOffspring, the PURSUING_MATE branches, and getAttractiveness + the
// attraction/similarity helpers, which are NOT PORTED YET. setEnvironmentalStimuli's mate branch
// therefore throws until rung 2 wires those in (it is unreachable until a real pool feeds nearby mates).

import { Vector2D } from './vector2d.js';
import { Genotype } from './genotype.js';
import { Brain } from './brain.js';
import { assert } from './assert.js';
import {
    ZERO, ONE, ONE_HALF, PI_OVER_180,
    NULL_INDEX, NULL_PART, ROOT_PART, MOUTH_INDEX, GENITAL_INDEX,
    YOUNG_AGE_DURATION, OLD_AGE_DURATION, STARVING, STARVING_TIMER_DELTA, TIMER_DELTA_INCREASE_RATE,
    CONTINUAL_ENERGY_DRAIN, ENERGY_USED_UP_SWIMMING, WALL_BOUNCE, SWIMBOT_SELECT_RADIUS_SCALAR,
    ENERGY_EFFICIENCY_MEASUREMENT_PERIOD, SWIMBOT_MOUTH_LENGTH, SWIMBOT_GENITAL_LENGTH, FOOD_TYPE_OFFSET,
    DEFAULT_SWIMBOT_HUNGER_THRESHOLD, BRAIN_SENSORY_UPDATE_PERIOD,
    BRAIN_FOCUS_TARGET_SHIFT_STRENGTH, BRAIN_FOCUS_TARGET_SHIFT_THRESHOLD, BRAIN_WANDER_AMOUNT,
    TOO_UGLY_TO_CHOOSE,
    BRAIN_STATE_PURSUING_FOOD, BRAIN_STATE_PURSUING_MATE,
    BRAIN_STATE_LOOKING_FOR_FOOD, BRAIN_STATE_LOOKING_FOR_MATE,
    POOL_LEFT, POOL_RIGHT, POOL_TOP, POOL_BOTTOM,
} from './constants.js';

export class Swimbot {
    // ctx = { rng: () -> [0,1), config, embryology, onDeath?: (index) -> void }
    constructor(ctx) {
        this._rng = ctx.rng;
        this._config = ctx.config;
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

        this._phenotype.parts[ROOT_PART].position.set(this._position);
        this._phenotype.parts[ROOT_PART].currentAngle = this._angle - this.getMomentAdjustment();

        for (let p = 1; p < this._phenotype.numParts; p++) {
            this._phenotype.parts[p].position.set(this.getPartParentPosition(p));

            this._phenotype.parts[p].currentAngle =
                this._phenotype.parts[this._phenotype.parts[p].parent].currentAngle +
                this._phenotype.parts[p].angle;

            if (p > 1) { // part 1 has nothing to 'bend' off of
                const ampModulator = this._phenotype.parts[p].turnAmp * directionDot;
                const phaseModulator = this._phenotype.parts[p].turnPhase * directionDot;

                const bendRadian = this._timer * this._phenotype.frequency + (this._phenotype.parts[p].phase + phaseModulator);
                this._phenotype.parts[p].bendingAngle = (this._phenotype.parts[p].amp + ampModulator) * Math.sin(bendRadian);

                this._phenotype.parts[p].currentAngle += this._phenotype.parts[p].bendingAngle;
            }

            const partRadian = this._phenotype.parts[p].currentAngle * PI_OVER_180;
            let length = this._phenotype.parts[p].length;

            if (this._age < YOUNG_AGE_DURATION) {
                length *= this._growthScale;
            }

            const x = length * Math.sin(partRadian);
            const y = length * Math.cos(partRadian);
            this._phenotype.parts[p].previousMid.setXY(this._phenotype.parts[p].midPosition.x, this._phenotype.parts[p].midPosition.y);
            this._phenotype.parts[p].midPosition.setXY(this._phenotype.parts[p].position.x, this._phenotype.parts[p].position.y);
            this._phenotype.parts[p].position.addXY(x, y);
            this._phenotype.parts[p].midPosition.addXY(x * ONE_HALF, y * ONE_HALF);

            this._phenotype.parts[p].axis.x = this._phenotype.parts[p].position.x - this._phenotype.parts[this._phenotype.parts[p].parent].position.x;
            this._phenotype.parts[p].axis.y = this._phenotype.parts[p].position.y - this._phenotype.parts[this._phenotype.parts[p].parent].position.y;

            this._phenotype.parts[p].perpendicular.setXY(this._phenotype.parts[p].axis.y / length, -this._phenotype.parts[p].axis.x / length);

            this._phenotype.parts[p].velocity.setToDifference(this._phenotype.parts[p].midPosition, this._phenotype.parts[p].previousMid);
        }

        this.calculateCenterOfMass();
        this.adjustToCenterOfMass();
        this.calculateCenterOfMass();

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

        const previousFocusDirection = new Vector2D();
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
            this._directionToGoal.x = -ONE_HALF + this._rng();
            this._directionToGoal.y = -ONE_HALF + this._rng();
            length = this._directionToGoal.getMagnitude();
        }

        this._directionToGoal.x += (-BRAIN_WANDER_AMOUNT * ONE_HALF + this._rng() * BRAIN_WANDER_AMOUNT);
        this._directionToGoal.y += (-BRAIN_WANDER_AMOUNT * ONE_HALF + this._rng() * BRAIN_WANDER_AMOUNT);

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

        for (let p = 1; p < this._phenotype.numParts; p++) {
            const fractionOfWhole = this._phenotype.parts[p].length / this._phenotype.sumPartLengths;

            this._phenotype.parts[p].velocity.setToDifference(this._phenotype.parts[p].midPosition, this._phenotype.parts[p].previousMid);

            const strokeAmplitude = this._phenotype.parts[p].velocity.dotWith(this._phenotype.parts[p].perpendicular) * fractionOfWhole;

            const strokeForceX = this._phenotype.parts[p].perpendicular.x * strokeAmplitude;
            const strokeForceY = this._phenotype.parts[p].perpendicular.y * strokeAmplitude;

            this._energy -= Math.abs(strokeAmplitude) * ENERGY_USED_UP_SWIMMING;
            if (this._energy < ZERO) {
                this._energy = ZERO;
            }

            const partVectorFromCenterX = this._phenotype.parts[p].midPosition.x - this._position.x;
            const partVectorFromCenterY = this._phenotype.parts[p].midPosition.y - this._position.y;

            // Faithful quirk: JJ squares the components first, so this "distance" is sqrt(dx^4 + dy^4),
            // NOT the Euclidean distance. It only feeds the (dead) partDirectionFromCenter below and the
            // distance>0 guard (equivalent to dx!=0||dy!=0), so it does not affect the output -- but it is
            // ported verbatim to keep this a line-for-line translation.
            const xx = partVectorFromCenterX * partVectorFromCenterX;
            const yy = partVectorFromCenterY * partVectorFromCenterY;
            const distance = Math.sqrt(xx * xx + yy * yy);

            if (distance > ZERO) {
                // partDirectionFromCenter is computed by JJ but only used in a commented-out branch; kept
                // for faithfulness (unused).
                // const partDirectionFromCenterX = partVectorFromCenterX / distance;
                // const partDirectionFromCenterY = partVectorFromCenterY / distance;

                const partAccelerationX = -strokeForceX;
                const partAccelerationY = -strokeForceY;

                this._acceleration.x += partAccelerationX;
                this._acceleration.y += partAccelerationY;

                const partPerpendicularX = partVectorFromCenterY;
                const partPerpendicularY = -partVectorFromCenterX;

                const perpDot = (strokeForceX * partPerpendicularX + strokeForceY * partPerpendicularY) / this._phenotype.sumPartLengths;

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
        assert(this._chosenFoodBit !== null, 'eatChosenFoodBit: _chosenFoodBit != null');
        assert(this._chosenFoodBit.getAlive(), 'eatChosenFoodBit: _chosenFoodBit.getAlive()');

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

    setEnvironmentalStimuli(numNearbySwimbots, nearbySwimbotArray, foodBitWasFound, theFoodBit) {
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
            let highestBabeFactor = -100.0;

            for (let o = 0; o < numNearbySwimbots; o++) {
                // rung 2: getAttractiveness + the attraction/similarity helpers are not ported yet, so this
                // throws if a pool feeds nearby mates before then. Fail loudly with the reason, not a bare
                // TypeError, if that happens.
                if (typeof nearbySwimbotArray[o].getAttractiveness !== 'function') {
                    throw new Error('Swimbot.setEnvironmentalStimuli: mate path not wired until rung 2 (getAttractiveness unported)');
                }
                const babeFactor = nearbySwimbotArray[o].getAttractiveness(this);
                if ((babeFactor > highestBabeFactor)
                    && (babeFactor > TOO_UGLY_TO_CHOOSE)
                    && (nearbySwimbotArray[o].getAge() > YOUNG_AGE_DURATION)
                    && (nearbySwimbotArray[o].getEnergy() > STARVING)) {
                    highestBabeFactor = babeFactor;
                    mostAttractiveFound = nearbySwimbotArray[o];
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
}
