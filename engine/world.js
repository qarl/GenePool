// World — the pool tick (PLAN-restructure.md §19). P1b: the death-node bug is GONE.
//
// The P1a World reproduced JJ bit-for-bit incl. the ABA (frozen at git 0cd88a8, proof retired). P1b is
// the deliberate REBASELINE that deletes the slot-artifact cluster:
//   - a DYNAMIC COLLECTION keyed by NEVER-REUSED ids (a monotonic nextId; dead entities are swept out and
//     their id is never handed to a newborn). A swimbot's chosenMate/chosenFood is an object reference;
//     because no object/id is ever reused, that reference simply reads getAlive()===false once the
//     referent dies and is dropped -- it can never silently follow a rebirth/respawn (THE ABA fix). The
//     fix lives entirely here; the swimbot/food/genotype code is unchanged.
//   - T+1 STAGED BIRTHS (D-a): the live collection governs the tick; newborns are staged during the tick
//     and added AFTER, so they first act next tick -- killing the "acts-this-tick-if-slot-is-high" accident.
//
// DELIBERATE REBASELINE ITEM -- NO ENGINE POPULATION CAP. JJ capped population at a hardcoded 2000 (the
// fixed-array size): findLowestDead* returned NULL_INDEX when full, suppressing births/food-regen. The
// dynamic collection mints without a ceiling -- per the North Star, world-scale bounds are USER CONFIG,
// not engine defaults (an arbitrary 2000 limit is exactly what the restructure removes). Population is
// currently held by the energy budget, not a cap. A config carrying-capacity is an OPTIONAL future knob
// (decision D-f); MAX_SWIMBOTS/MAX_FOODBITS are retired as engine limits.
//
// This is P1b-i: the STRUCTURE. The global seeded RNG is kept (its draw structure is unchanged except the
// food-regen parent pick, which the fixed slot array no longer supports); P1b-ii swaps it for the
// addressed per-entity RNG (§3). Validated by determinism + invariants + review, NOT an old-engine A/B
// (it rebaselines by design). Death accounting/lineage stays out (the genome-DAG replaces it at P5).

import { Swimbot } from './swimbot.js';
import { FoodBit } from './foodBit.js';
import { Obstacle } from './obstacle.js';
import { Genotype } from './genotype.js';
import { Embryology } from './embryology.js';
import { Vector2D } from './vector2d.js';
import { draw, makeStream, DOMAIN } from './rng.js';
import {
    ZERO, ONE, ONE_HALF, NULL_INDEX, NUM_GENES, NUM_GENES_USED, BYTE_SIZE,
    MAX_FOODBITS_PER_TYPE, NON_REPRODUCING_JUNK_DNA_LIMIT,
    BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS, SWIMBOT_VIEW_RADIUS,
} from './constants.js';

export class World {
    // masterSeed is a non-negative safe integer; every draw is addressed off it (§3). No global stream.
    constructor(config, masterSeed) {
        this._config = config;
        this._masterSeed = masterSeed;
        this._embryology = new Embryology();
        this._clock = 0;
        this._numDeadSwimbots = 0;

        // Pool-level addressed streams. A swimbot gets its own SWIMBOT_LIFE stream (per id); mate-pref is
        // a pairwise MATE_PREF draw shared by all swimbots; food regen has one POOL_FOOD_REGEN stream.
        this._foodRegenStream = makeStream(masterSeed, DOMAIN.POOL_FOOD_REGEN);
        this._foodRegenRng = () => this._foodRegenStream.next();
        this._matePref = (lookerId, candidateId, tick, drawIdx) =>
            draw(masterSeed, DOMAIN.MATE_PREF, lookerId, candidateId, tick, drawIdx);

        // Dynamic collections keyed by NEVER-REUSED id (Map preserves insertion = ascending-id order).
        this._swimbots = new Map();
        this._foodBits = new Map();
        this._nextSwimbotId = 0;
        this._nextFoodId = 0;
        this._pendingBirths = []; // T+1: newborns created this tick, added after it
        this._obstacle = new Obstacle();

        // scratch genotypes / vectors (mirroring JJ's shared scratch in GenePool)
        this._myGenotype = new Genotype();
        this._childGenotype = new Genotype();
        this._birthPos = new Vector2D();
        this._collisionForce = new Vector2D();
        this._nearbyArray = new Array(BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS);
        this._nearbyCandidates = []; // scratch: all in-view candidates {other, d2, id}, ranked for closest-20
        this._numNearby = 0;
    }

    // Each swimbot gets its OWN per-life SWIMBOT_LIFE stream keyed on its never-reused id, plus the shared
    // pairwise matePref. (create() is RNG-free, so the stream is unused until the first tick.)
    _makeSwimbot(id) {
        return new Swimbot({
            life: makeStream(this._masterSeed, DOMAIN.SWIMBOT_LIFE, id),
            matePref: this._matePref,
            config: this._config, embryology: this._embryology,
            onDeath: () => { this._numDeadSwimbots++; },
        });
    }

    // --- loading (Option B: inject a constructed state; create() reconstructs hidden state, RNG-free).
    //
    // THIS IS A FRESH-SCENARIO SEEDER, NOT A CHECKPOINT/RESUME. It derives the never-reused floor from the
    // highest LOADED id -- correct only when nothing has died yet. A mid-run checkpoint must persist AND
    // restore _nextSwimbotId/_nextFoodId, _clock, and every live entity's stream counter, reconstructing
    // nextId from the HIGH-WATER MARK (not the surviving id set) -- otherwise births re-mint ids that dead
    // swimbots already used, resurrecting the ABA + an RNG-ABA (a reborn id replays the dead one's stream).
    // That persistence contract is a P5 deliverable (§13); until it exists, do not treat load* as resume. ---
    loadSwimbot(id, { age, x, y, angle, energy, genes, numOffspring = 0, numFoodBitsEaten = 0 }) {
        const g = new Genotype(); g.setGenes(genes);
        const sb = this._makeSwimbot(id);
        sb.create(id, age, { x, y }, angle, energy, g);
        sb.setNumOffspring(numOffspring);
        sb.setNumFoodBitsEaten(numFoodBitsEaten);
        this._swimbots.set(id, sb);
        if (id >= this._nextSwimbotId) this._nextSwimbotId = id + 1;
    }

    loadFood(id, { x, y, type, energy }) {
        const f = new FoodBit();
        f.setIndex(id);
        f.setPosition({ x, y });
        f.setType(type);
        f.setEnergy(energy);
        f.setMaxSpawnRadius(this._config.foodSpread);
        this._foodBits.set(id, f);
        if (id >= this._nextFoodId) this._nextFoodId = id + 1;
    }

    setObstacle(e1, e2) { this._obstacle.setEndpointPositions(e1, e2); }

    getClock() { return this._clock; }
    getNextSwimbotId() { return this._nextSwimbotId; }
    getNextFoodId() { return this._nextFoodId; }
    getNumDeadSwimbots() { return this._numDeadSwimbots; }

    _getJunkDnaSimilarity(genotype1, genotype2) {
        let diff = ZERO;
        let num = 0;
        for (let g = NUM_GENES_USED; g < NUM_GENES; g++) {
            diff += Math.abs(genotype1.getGeneValue(g) - genotype2.getGeneValue(g)) / BYTE_SIZE;
            num++;
        }
        return ONE - (diff / num);
    }

    // --- the tick. The live collection governs it; deaths take effect immediately (dead entities are
    // skipped for the rest of the tick); births are staged and applied after (T+1); dead entities are then
    // swept out so their ids are never reused. ---
    tick() {
        this._clock++;
        this._updateSwimbots();
        this._updateFood();
        this._applyPendingBirths();
        this._sweepDead();
    }

    _updateSwimbots() {
        // Iterate a snapshot of the current live swimbots (staged births are NOT in it -> they act next
        // tick). Structural mutation (staging/sweeping) happens outside this loop.
        for (const bot of this._swimbots.values()) {
            if (!bot.getAlive()) continue;
            bot.update();
            if (!bot.getAlive()) continue; // H-a: update() can kill it (old age / starvation)

            if (bot.getIsLookingForSensoryInput()) {
                this._giveSwimbotNearbyEnvironmentalStimuli(bot);
            }

            if (this._obstacle.getCollision(bot.getPosition(), bot.getBoundingRadius() * ONE_HALF)) {
                this._collisionForce.set(this._obstacle.getCurrentCollisionForce());
                this._collisionForce.scale(1.2);
                bot.addForce(this._collisionForce);
            }

            if (bot.getIsTryingToEat()) {
                bot.eatChosenFoodBit();
            }

            if (bot.getIsTryingToMate()) {
                this._handleBirth(bot);
            }
        }
    }

    _giveSwimbotNearbyEnvironmentalStimuli(bot) {
        // nearby visible swimbots -- the CLOSEST-20 (D-b), replacing JJ's first-20-in-array-order (the last
        // slot/id-order artifact). Collect all in-view, non-obstructed candidates, rank by genital
        // distance^2 (tiebreak by stableID for determinism), take the closest BRAIN_MAX_PERCEIVED. Fully
        // order-independent now that the mate-pref rng is addressed (P1b-ii).
        this._nearbyCandidates.length = 0;
        for (const other of this._swimbots.values()) {
            if (other === bot || !other.getAlive()) continue;
            const distanceSquared = bot.getGenitalPosition().getDistanceSquaredTo(other.getGenitalPosition());
            if (distanceSquared < SWIMBOT_VIEW_RADIUS * SWIMBOT_VIEW_RADIUS) {
                if (!this._obstacle.getObstruction(bot.getGenitalPosition(), other.getGenitalPosition())) {
                    this._nearbyCandidates.push({ other, d2: distanceSquared, id: other.getIndex() });
                }
            }
        }
        this._nearbyCandidates.sort((a, b) => (a.d2 - b.d2) || (a.id - b.id));
        this._numNearby = Math.min(this._nearbyCandidates.length, BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS);
        for (let i = 0; i < this._numNearby; i++) this._nearbyArray[i] = this._nearbyCandidates[i].other;

        // closest visible food (of the preferred type, when 2 food types). GRID-SAFE: an id tiebreak on
        // exactly-equal distance makes the choice independent of iteration order (P2 grid buckets).
        let foundFoodBit = false;
        let chosenFoodBit = null;
        let smallestDistance = Number.MAX_SAFE_INTEGER;
        let chosenFoodId = Infinity;
        for (const food of this._foodBits.values()) {
            if (!food.getAlive()) continue;
            if (this._config.numFoodTypes === 2 && food.getType() !== bot.getPreferredFoodType()) continue;
            const viewDistance = bot.getMouthPosition().getDistanceTo(food.getPosition());
            if (viewDistance < SWIMBOT_VIEW_RADIUS) {
                const distance = viewDistance / SWIMBOT_VIEW_RADIUS;
                const id = food.getIndex();
                if ((distance < smallestDistance) || (distance === smallestDistance && id < chosenFoodId)) {
                    if (!this._obstacle.getObstruction(bot.getMouthPosition(), food.getPosition())) {
                        smallestDistance = distance;
                        chosenFoodId = id;
                        chosenFoodBit = food;
                        foundFoodBit = true;
                    }
                }
            }
        }

        // The tick is threaded to the mate scan so getAttractiveness can address MATE_PREF(looker,
        // candidate, tick) -- decoupling the mate-pref draw from the scan order.
        bot.setEnvironmentalStimuli(this._numNearby, this._nearbyArray, foundFoodBit, chosenFoodBit, this._clock);
    }

    _handleBirth(parent) {
        if (parent.getChosenMateIndex() === NULL_INDEX) return;
        const mate = this._swimbots.get(parent.getChosenMateIndex());
        // NEVER-REUSED ids: `mate` is either the exact chosen individual (alive/dead) or gone -- it can
        // never be a DIFFERENT swimbot that reused the id. This is where the ABA used to live.
        if (!mate || !mate.getAlive()) return;

        this._myGenotype.copyFromGenotype(parent.getGenotype());
        const mateGenotype = mate.getGenotype();
        if (this._getJunkDnaSimilarity(this._myGenotype, mateGenotype) <= NON_REPRODUCING_JUNK_DNA_LIMIT) return;

        const newBornId = this._nextSwimbotId++;

        // The newborn's birth-time randomness (genome crossover+mutation, then the initial angle) comes
        // from its OWN addressed OFFSPRING_GENOME stream -- a pure function of its id, independent of when
        // in the tick the birth happens.
        const genomeStream = makeStream(this._masterSeed, DOMAIN.OFFSPRING_GENOME, newBornId);
        const genomeRng = () => genomeStream.next();
        this._childGenotype.setAsOffspring(this._myGenotype, mateGenotype, genomeRng, {
            crossoverRate: this._config.crossoverRate, mutationRate: this._config.mutationRate,
        });

        const myEnergyContribution = parent.contributeToOffspring();
        const mateEnergyContribution = mate.contributeToOffspring();
        const energyToOffspring = myEnergyContribution + mateEnergyContribution;

        const diffX = mate.getGenitalPosition().x - parent.getGenitalPosition().x;
        const diffY = mate.getGenitalPosition().y - parent.getGenitalPosition().y;
        this._birthPos.x = parent.getGenitalPosition().x + diffX * ONE_HALF;
        this._birthPos.y = parent.getGenitalPosition().y + diffY * ONE_HALF;

        const initialAngle = -180.0 + genomeRng() * 360.0; // from the same stream, AFTER the genome

        const child = this._makeSwimbot(newBornId);
        child.create(newBornId, 0, this._birthPos, initialAngle, energyToOffspring, this._childGenotype);
        // T+1: stage the newborn; it joins the collection AFTER this tick and first acts next tick.
        this._pendingBirths.push(child);
    }

    // Pick a random LIVING food of the given type (JJ's slot-index rejection sampling doesn't survive the
    // never-reused-id collection; this draws one index into the living-of-type list -- a rebaseline).
    // GRID-SAFE: sort the candidate list by id so the indexed draw hits the SAME food regardless of the
    // collection's iteration order (a P2 spatial grid may iterate food in bucket order, not id order).
    _findRandomLivingFoodOfType(foodType) {
        const candidates = [];
        for (const food of this._foodBits.values()) {
            if (food.getAlive() && food.getType() === foodType) candidates.push(food);
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.getIndex() - b.getIndex());
        return candidates[Math.floor(this._foodRegenRng() * candidates.length)];
    }

    _updateFood() {
        let numType0 = 0;
        let numType1 = 0;
        if (this._config.numFoodTypes === 2) {
            for (const food of this._foodBits.values()) {
                if (!food.getAlive()) continue;
                if (food.getType() === 0) numType0++; else if (food.getType() === 1) numType1++;
            }
        }

        if (this._clock % this._config.foodRegenerationPeriod === 0) {
            let newFoodType = 0;
            let parent;

            if (this._config.numFoodTypes !== 2) {
                parent = this._findRandomLivingFoodOfType(0); // single type: one parent pick, one draw
            } else {
                newFoodType = Math.floor(this._foodRegenRng() * 2);
                // >= (JJ used ==, which was safe under the hard total cap; without it, use >= so the
                // per-type balance can't be skipped past). MAX_FOODBITS_PER_TYPE stays a per-type balance
                // hint, not a hard ceiling.
                if (numType0 >= MAX_FOODBITS_PER_TYPE) newFoodType = 1; else if (numType1 >= MAX_FOODBITS_PER_TYPE) newFoodType = 0;
                parent = this._findRandomLivingFoodOfType(newFoodType);
                if (numType0 === 0) { newFoodType = 0; parent = this._findRandomLivingFoodOfType(1); }
                if (numType1 === 0) { newFoodType = 1; parent = this._findRandomLivingFoodOfType(0); }
            }

            if (parent) {
                const childId = this._nextFoodId++;
                const child = new FoodBit();
                child.setMaxSpawnRadius(this._config.foodSpread);
                child.spawnFromParent(parent, childId, newFoodType, this._foodRegenRng);

                let looking = true;
                let num = 0;
                while (looking) {
                    child.randomizeSpawnPosition(parent, this._foodRegenRng);
                    if (!this._obstacle.getObstruction(parent.getPosition(), child.getPosition())) looking = false;
                    num++;
                    if (num > 10) looking = false;
                }
                this._foodBits.set(childId, child);
            }
        }
    }

    _applyPendingBirths() {
        for (const child of this._pendingBirths) {
            this._swimbots.set(child.getIndex(), child);
        }
        this._pendingBirths.length = 0;
    }

    // Remove dead entities so the collection stays bounded. Their ids are NEVER reused (nextId is
    // monotonic), so a lingering chosenMate/chosenFood reference to a swept entity can only ever resolve
    // to that same (now-gone) individual -- never a new one.
    _sweepDead() {
        for (const [id, bot] of this._swimbots) if (!bot.getAlive()) this._swimbots.delete(id);
        for (const [id, food] of this._foodBits) if (!food.getAlive()) this._foodBits.delete(id);
    }

    // --- snapshot for tests (living entities; content + hidden chosenMate/brainState) ---
    getLivingSwimbotCount() { let n = 0; for (const s of this._swimbots.values()) if (s.getAlive()) n++; return n; }
    getLivingFoodCount() { let n = 0; for (const f of this._foodBits.values()) if (f.getAlive()) n++; return n; }

    dumpSwimbots() {
        const out = [];
        for (const s of this._swimbots.values()) {
            if (!s.getAlive()) continue;
            out.push({
                id: s.getIndex(), x: s.getPosition().x, y: s.getPosition().y, angle: s.getAngle(), energy: s.getEnergy(),
                age: s.getAge(), genes: s.getGenotype().getGenes(), numOffspring: s.getNumOffspring(),
                numFoodBitsEaten: s.getNumFoodBitsEaten(), chosenMate: s.getChosenMateIndex(), brainState: s.getBrainState(),
            });
        }
        return out;
    }

    dumpFood() {
        const out = [];
        for (const f of this._foodBits.values()) {
            if (!f.getAlive()) continue;
            out.push({ id: f.getIndex(), x: f.getPosition().x, y: f.getPosition().y, type: f.getType() });
        }
        return out;
    }
}
