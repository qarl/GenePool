// World — the P1a pool tick, forked from JJ's GenePool.js orchestration (PLAN-restructure.md §19).
//
// P1a is the BEHAVIOR-PRESERVING slot-kill: the fixed Array(2000)+backfill becomes a dynamic collection,
// but IDs stay == slot order, the global seeded RNG and its draw order are preserved, perception is
// first-N-in-slot-order, and birth still lands in the LOWEST dead slot (the ABA the rewrite ultimately
// removes at P1b). This World reproduces JJ's tick bit-for-bit; the frozen 500-bot golden is the target.
//
// The RNG is INJECTED (one () -> [0,1) global stream, drawn in JJ's exact order). Death accounting /
// lineage that JJ kept in globals + FamilyTree is dropped (the genome-DAG replaces the tree at P5); the
// swimbot's onDeath hook just bumps a dead counter. Touch ripples (_pool.endTouch) are render-only and
// omitted, as are camera / view-tracking / rendering.

import { Swimbot } from './swimbot.js';
import { FoodBit } from './foodBit.js';
import { Obstacle } from './obstacle.js';
import { Genotype } from './genotype.js';
import { Embryology } from './embryology.js';
import { Vector2D } from './vector2d.js';
import {
    ZERO, ONE, ONE_HALF, NULL_INDEX, NUM_GENES, NUM_GENES_USED, BYTE_SIZE,
    MAX_SWIMBOTS, MAX_FOODBITS, MAX_FOODBITS_PER_TYPE, NON_REPRODUCING_JUNK_DNA_LIMIT,
    BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS, SWIMBOT_VIEW_RADIUS,
    BRAIN_STATE_LOOKING_FOR_FOOD, BRAIN_STATE_PURSUING_FOOD, BRAIN_STATE_LOOKING_FOR_MATE, BRAIN_STATE_PURSUING_MATE,
} from './constants.js';

export class World {
    constructor(config, rng) {
        this._config = config;
        this._rng = rng;
        this._embryology = new Embryology();
        this._clock = 0;
        this._numDeadSwimbots = 0;

        this._swimbots = new Array(MAX_SWIMBOTS).fill(null);
        this._foodBits = new Array(MAX_FOODBITS).fill(null);
        this._obstacle = new Obstacle();

        // scratch genotypes / vectors (mirroring JJ's shared scratch in GenePool)
        this._myGenotype = new Genotype();
        this._childGenotype = new Genotype();
        this._birthPos = new Vector2D();
        this._collisionForce = new Vector2D();
        this._nearbyArray = new Array(BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS);
        this._numNearby = 0;
    }

    // --- loading (Option B: inject the OLD engine's constructed state; create() reconstructs the hidden
    // per-swimbot state deterministically from age/pos/angle/energy/genes -- create is RNG-free) ---
    _makeSwimbot() {
        return new Swimbot({
            rng: this._rng, config: this._config, embryology: this._embryology,
            onDeath: () => { this._numDeadSwimbots++; },
        });
    }

    loadSwimbot(id, { age, x, y, angle, energy, genes, numOffspring = 0, numFoodBitsEaten = 0 }) {
        const g = new Genotype(); g.setGenes(genes);
        const sb = this._makeSwimbot();
        sb.create(id, age, { x, y }, angle, energy, g);
        sb.setNumOffspring(numOffspring);
        sb.setNumFoodBitsEaten(numFoodBitsEaten);
        this._swimbots[id] = sb;
    }

    loadFood(id, { x, y, type, energy }) {
        const f = new FoodBit();
        f.setIndex(id);
        f.setPosition({ x, y });
        f.setType(type);
        f.setEnergy(energy);
        f.setMaxSpawnRadius(this._config.foodSpread);
        this._foodBits[id] = f;
    }

    setObstacle(e1, e2) { this._obstacle.setEndpointPositions(e1, e2); }

    getClock() { return this._clock; }

    // --- collection helpers (null slot == dead, matching JJ's dead-Swimbot slots) ---
    _swimbotAlive(i) { const s = this._swimbots[i]; return s !== null && s.getAlive(); }
    _foodAlive(i) { const f = this._foodBits[i]; return f !== null && f.getAlive(); }

    _findLowestDeadSwimbotSlot() {
        for (let t = 0; t < MAX_SWIMBOTS; t++) {
            if (!this._swimbotAlive(t)) return t;
        }
        return NULL_INDEX;
    }

    _findLowestDeadFoodSlot() {
        for (let t = 0; t < MAX_FOODBITS; t++) {
            if (!this._foodAlive(t)) return t;
        }
        return NULL_INDEX;
    }

    // JJ's version: up to 200 tries, each drawing floor(rng()*(MAX_FOODBITS-1)); returns the first random
    // slot that is alive AND of the requested type, else NULL_INDEX. Draw count is data-dependent.
    _findRandomLivingFoodBit(foodType) {
        let f = NULL_INDEX;
        const numTimesLooking = 200;
        let i = 0;
        let looking = true;
        while (looking) {
            const testIndex = Math.floor(this._rng() * (MAX_FOODBITS - 1));
            if (this._foodAlive(testIndex)) {
                if (this._foodBits[testIndex].getType() === foodType) {
                    f = testIndex;
                    looking = false;
                }
            }
            i++;
            if (i > numTimesLooking) { looking = false; }
        }
        return f;
    }

    _getJunkDnaSimilarity(genotype1, genotype2) {
        let diff = ZERO;
        let num = 0;
        for (let g = NUM_GENES_USED; g < NUM_GENES; g++) {
            diff += Math.abs(genotype1.getGeneValue(g) - genotype2.getGeneValue(g)) / BYTE_SIZE;
            num++;
        }
        return ONE - (diff / num);
    }

    _getRandomAngleInDegrees() { return -180.0 + this._rng() * 360.0; }

    // --- the tick (JJ's update() sim branch: clock++, updateSwimbots, updateFood) ---
    tick() {
        this._clock++;
        this._updateSwimbots();
        this._updateFood();
    }

    _updateSwimbots() {
        for (let s = 0; s < MAX_SWIMBOTS; s++) {
            if (this._swimbotAlive(s)) {
                const bot = this._swimbots[s];
                bot.update();

                // H-a: update() can kill it (old age / starvation). A dead bot must not then sense/eat/mate.
                if (!bot.getAlive()) { continue; }

                if (bot.getIsLookingForSensoryInput()) {
                    this._giveSwimbotNearbyEnvironmentalStimuli(s);
                }

                // obstacle collision -> bounce force
                if (this._obstacle.getCollision(bot.getPosition(), bot.getBoundingRadius() * ONE_HALF)) {
                    this._collisionForce.set(this._obstacle.getCurrentCollisionForce());
                    this._collisionForce.scale(1.2);
                    bot.addForce(this._collisionForce);
                }

                if (bot.getIsTryingToEat()) {
                    bot.eatChosenFoodBit();
                }

                if (bot.getIsTryingToMate()) {
                    this._handleBirth(s);
                }
            }
        }
    }

    _giveSwimbotNearbyEnvironmentalStimuli(s) {
        const bot = this._swimbots[s];

        // nearby visible swimbots (first-N in slot order, within view radius, not obstructed)
        this._numNearby = 0;
        for (let o = 0; o < MAX_SWIMBOTS; o++) {
            if ((s !== o) && this._swimbotAlive(o) && (this._numNearby < BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS)) {
                const distanceSquared = bot.getGenitalPosition().getDistanceSquaredTo(this._swimbots[o].getGenitalPosition());
                if (distanceSquared < SWIMBOT_VIEW_RADIUS * SWIMBOT_VIEW_RADIUS) {
                    if (!this._obstacle.getObstruction(bot.getGenitalPosition(), this._swimbots[o].getGenitalPosition())) {
                        this._nearbyArray[this._numNearby] = this._swimbots[o];
                        this._numNearby++;
                    }
                }
            }
        }

        // closest visible food (of the preferred type, when 2 food types)
        let foundFoodBit = false;
        let chosenFoodBit = null;
        let smallestDistance = Number.MAX_SAFE_INTEGER;
        for (let f = 0; f < MAX_FOODBITS; f++) {
            let okay = true;
            if (this._config.numFoodTypes === 2) {
                if (this._foodBits[f] === null || this._foodBits[f].getType() !== bot.getPreferredFoodType()) {
                    okay = false;
                }
            }
            if (okay) {
                if (this._foodAlive(f)) {
                    const viewDistance = bot.getMouthPosition().getDistanceTo(this._foodBits[f].getPosition());
                    if (viewDistance < SWIMBOT_VIEW_RADIUS) {
                        const distance = viewDistance / SWIMBOT_VIEW_RADIUS;
                        if (distance < smallestDistance) {
                            if (!this._obstacle.getObstruction(bot.getMouthPosition(), this._foodBits[f].getPosition())) {
                                smallestDistance = distance;
                                chosenFoodBit = this._foodBits[f];
                                foundFoodBit = true;
                            }
                        }
                    }
                }
            }
        }

        bot.setEnvironmentalStimuli(this._numNearby, this._nearbyArray, foundFoodBit, chosenFoodBit);
    }

    _handleBirth(s) {
        const parent = this._swimbots[s];
        const newBornSlot = this._findLowestDeadSwimbotSlot();

        if ((newBornSlot !== NULL_INDEX) && (parent.getChosenMateIndex() !== NULL_INDEX)) {
            const chosenMateIndex = parent.getChosenMateIndex();
            const mate = this._swimbots[chosenMateIndex];

            if (mate !== null && mate.getAlive()) {
                // Copy this parent's genes into scratch (JJ avoids aliasing a live genotype); the mate's
                // genotype is read directly.
                this._myGenotype.copyFromGenotype(parent.getGenotype());
                const mateGenotype = mate.getGenotype();

                if (this._getJunkDnaSimilarity(this._myGenotype, mateGenotype) > NON_REPRODUCING_JUNK_DNA_LIMIT) {
                    this._childGenotype.setAsOffspring(this._myGenotype, mateGenotype, this._rng, {
                        crossoverRate: this._config.crossoverRate, mutationRate: this._config.mutationRate,
                    });

                    const myEnergyContribution = parent.contributeToOffspring();
                    const mateEnergyContribution = mate.contributeToOffspring();
                    const energyToOffspring = myEnergyContribution + mateEnergyContribution;

                    const diffX = mate.getGenitalPosition().x - parent.getGenitalPosition().x;
                    const diffY = mate.getGenitalPosition().y - parent.getGenitalPosition().y;
                    this._birthPos.x = parent.getGenitalPosition().x + diffX * ONE_HALF;
                    this._birthPos.y = parent.getGenitalPosition().y + diffY * ONE_HALF;

                    const initialAngle = this._getRandomAngleInDegrees(); // 1 draw, AFTER setAsOffspring

                    // REUSE the slot's (dead) swimbot object if one exists, exactly as JJ does -- a
                    // pursuer's chosenMate reference points at the slot object, and reusing it makes that
                    // reference follow the rebirth (this IS the ABA P1b removes). Only a never-used slot
                    // (null) gets a fresh object.
                    let child = this._swimbots[newBornSlot];
                    if (child === null) {
                        child = this._makeSwimbot();
                        this._swimbots[newBornSlot] = child;
                    }
                    child.create(newBornSlot, 0, this._birthPos, initialAngle, energyToOffspring, this._childGenotype);
                }
            }
        }
    }

    _updateFood() {
        let numType0FoodBits = 0;
        let numType1FoodBits = 0;

        for (let f = 0; f < MAX_FOODBITS; f++) {
            if (this._foodAlive(f)) {
                // FoodBit.update() is render-only (opacity) -- omitted.
                if (this._config.numFoodTypes === 2) {
                    if (this._foodBits[f].getType() === 0) { numType0FoodBits++; } else if (this._foodBits[f].getType() === 1) { numType1FoodBits++; }
                }
            }
        }

        if (this._clock % this._config.foodRegenerationPeriod === 0) {
            const childFoodBitIndex = this._findLowestDeadFoodSlot();
            if (childFoodBitIndex !== NULL_INDEX) {
                let newFoodType = 0;
                let parentFoodBitIndex = this._findRandomLivingFoodBit(newFoodType);

                if (this._config.numFoodTypes === 2) {
                    newFoodType = Math.floor(this._rng() * 2);
                    if (numType0FoodBits === MAX_FOODBITS_PER_TYPE) { newFoodType = 1; } else if (numType1FoodBits === MAX_FOODBITS_PER_TYPE) { newFoodType = 0; }
                    parentFoodBitIndex = this._findRandomLivingFoodBit(newFoodType);
                    if (numType0FoodBits === 0) { newFoodType = 0; parentFoodBitIndex = this._findRandomLivingFoodBit(1); }
                    if (numType1FoodBits === 0) { newFoodType = 1; parentFoodBitIndex = this._findRandomLivingFoodBit(0); }
                }

                if (parentFoodBitIndex !== NULL_INDEX) {
                    const parentFood = this._foodBits[parentFoodBitIndex];
                    // REUSE the slot's (dead) food object if one exists -- a swimbot's chosenFoodBit
                    // reference points at the slot object, and JJ reuses it so the reference follows the
                    // respawn to the new food. Only a never-used slot (null) gets a fresh object.
                    let child = this._foodBits[childFoodBitIndex];
                    if (child === null) {
                        child = new FoodBit();
                        this._foodBits[childFoodBitIndex] = child;
                    }
                    child.setMaxSpawnRadius(this._config.foodSpread);
                    child.spawnFromParent(parentFood, childFoodBitIndex, newFoodType, this._rng);

                    let looking = true;
                    let num = 0;
                    while (looking) {
                        child.randomizeSpawnPosition(parentFood, this._rng);
                        if (!this._obstacle.getObstruction(parentFood.getPosition(), child.getPosition())) {
                            looking = false;
                        }
                        num++;
                        if (num > 10) { looking = false; }
                    }
                    this._foodBits[childFoodBitIndex] = child;
                }
            }
        }
    }

    // --- snapshot for the A/B (mirrors getPoolData's living-entity view + the hidden fields the golden
    // signature carries: chosenMate, brainState) ---
    dumpSwimbots() {
        const out = [];
        for (let i = 0; i < MAX_SWIMBOTS; i++) {
            if (this._swimbotAlive(i)) {
                const s = this._swimbots[i];
                const genes = s.getGenotype().getGenes();
                out.push({
                    id: i, x: s.getPosition().x, y: s.getPosition().y, angle: s.getAngle(), energy: s.getEnergy(),
                    age: s.getAge(), genes, numOffspring: s.getNumOffspring(), numFoodBitsEaten: s.getNumFoodBitsEaten(),
                    chosenMate: s.getChosenMateIndex(), brainState: s.getBrainState(),
                });
            }
        }
        return out;
    }

    dumpFood() {
        const out = [];
        for (let i = 0; i < MAX_FOODBITS; i++) {
            if (this._foodAlive(i)) {
                const f = this._foodBits[i];
                out.push({ id: i, x: f.getPosition().x, y: f.getPosition().y, type: f.getType() });
            }
        }
        return out;
    }
}
