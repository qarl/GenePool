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
import { SpatialGrid } from './spatialGrid.js';
import {
    ZERO, ONE, ONE_HALF, NULL_INDEX, NUM_GENES, NUM_GENES_USED, BYTE_SIZE,
    MAX_FOODBITS_PER_TYPE, NON_REPRODUCING_JUNK_DNA_LIMIT,
    BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS, SWIMBOT_VIEW_RADIUS, resolvePoolBounds,
} from './constants.js';

export class World {
    // masterSeed is a non-negative safe integer; every draw is addressed off it (§3). No global stream.
    // options.useSpatialGrid (default true) picks the P2 spatial-grid perception; false = the brute-force
    // O(n^2) reference path (kept for the bit-for-bit A/B, and as a fallback).
    constructor(config, masterSeed, options = {}) {
        this._config = config;
        this._masterSeed = masterSeed;
        this._embryology = new Embryology();
        this._clock = 0;
        this._numDeadSwimbots = 0;

        // PERF: targeted sweep + O(1) live counts (was: scan the whole Map every tick to delete ~0). Deaths
        // are captured as they happen -- swimbots via the onDeath hook, food via the eat return in
        // _updateSwimbots -- so _sweepDead touches only what died. Living counts are maintained incrementally.
        this._deadSwimbotIds = [];        // swimbot ids that died this tick (from onDeath)
        this._eatenFoodIds = new Set();   // food ids eaten this tick (Set dedups two-bots-one-food)
        this._livingSwimbotCount = 0;
        this._livingFoodCount = 0;

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

        // P3: arbitrary world bounds. config.pool = {left,top,right,bottom} (any missing edge -> JJ default);
        // omit it entirely for the faithful 8000x8000 pool. Swimbots read config.pool for wall bounce (via
        // their ctx.config, which IS this._config); food + obstacle are given the bounds explicitly below.
        // MAX_FOODBITS_PER_TYPE (a per-type 2-food regen BALANCE hint, not a hard cap) is also config now.
        this._pool = resolvePoolBounds(config.pool);
        this._maxFoodBitsPerType = config.maxFoodBitsPerType ?? MAX_FOODBITS_PER_TYPE;
        this._obstacle = new Obstacle();
        this._obstacle.setPoolBounds(config.pool);

        // P2 spatial grid: a BEHAVIOR-PRESERVING acceleration of the O(n^2) perception scans. cellSize ==
        // the view radius, so the 3x3 neighborhood of any query point covers the whole view circle -- the
        // grid then returns EXACTLY the brute-force in-radius set (proven in test/engine/spatial-grid.test.js
        // and A/B'd tick-for-tick against the brute-force path in world-p2.test.js). Swimbots are indexed by
        // GENITAL position (the swimbot scan's metric), food by its own position (the food scan's target);
        // the query points are the looker's genital / mouth position respectively. Default ON.
        // INVARIANT: cellSize MUST be >= every perception query radius, or the grid silently misses in-range
        // entities (test/engine/spatial-grid.test.js documents that failure). Both perception scans use the
        // view radius, so cellSize == viewRadius satisfies it. viewRadius is now config-driven (default
        // SWIMBOT_VIEW_RADIUS); the swimbot closeness normalizer reads the same config.viewRadius, so the
        // perception filter and the normalizer stay consistent.
        this._viewRadius = config.viewRadius ?? SWIMBOT_VIEW_RADIUS;
        this._useSpatialGrid = options.useSpatialGrid !== false;
        this._swimbotGrid = new SpatialGrid(this._viewRadius);
        this._foodGrid = new SpatialGrid(this._viewRadius);

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
            onDeath: (deadId) => { this._numDeadSwimbots++; this._deadSwimbotIds.push(deadId); this._livingSwimbotCount--; },
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
        this._livingSwimbotCount++;
        if (this._useSpatialGrid) { const gp = sb.getGenitalPosition(); this._swimbotGrid.insert(sb, gp.x, gp.y); }
        if (id >= this._nextSwimbotId) this._nextSwimbotId = id + 1;
    }

    loadFood(id, { x, y, type, energy }) {
        const f = new FoodBit();
        f.setIndex(id);
        f.setPosition({ x, y });
        f.setType(type);
        f.setEnergy(energy);
        f.setMaxSpawnRadius(this._config.foodSpread);
        f.setPoolBounds(this._config.pool);
        this._foodBits.set(id, f);
        this._livingFoodCount++;
        if (this._useSpatialGrid) { const p = f.getPosition(); this._foodGrid.insert(f, p.x, p.y); }
        if (id >= this._nextFoodId) this._nextFoodId = id + 1;
    }

    setObstacle(e1, e2) { this._obstacle.setEndpointPositions(e1, e2); }

    getClock() { return this._clock; }
    getPoolBounds() { return this._pool; } // {left,top,right,bottom,width,height,margin} (P3)
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

    // The grids are maintained INCREMENTALLY (insert on load/birth/regen, move on update, remove on sweep) --
    // NOT rebuilt each tick, which cost as much as the perception it accelerated. This resync helper rebuilds
    // from scratch; it is for test setup and future load/restore, not the hot path. No-op when the grid is
    // off, so a brute-force World never grows grids it will not read (matters for the P5 load/restore path).
    _rebuildGrids() {
        if (!this._useSpatialGrid) return;
        this._swimbotGrid.clear();
        for (const bot of this._swimbots.values()) {
            const gp = bot.getGenitalPosition();
            this._swimbotGrid.insert(bot, gp.x, gp.y);
        }
        this._foodGrid.clear();
        for (const food of this._foodBits.values()) {
            const p = food.getPosition();
            this._foodGrid.insert(food, p.x, p.y);
        }
    }

    _updateSwimbots() {
        // Iterate a snapshot of the current live swimbots (staged births are NOT in it -> they act next
        // tick). Structural mutation (staging/sweeping) happens outside this loop.
        for (const bot of this._swimbots.values()) {
            if (!bot.getAlive()) continue;
            bot.update();
            if (!bot.getAlive()) continue; // H-a: update() can kill it (old age / starvation)

            // MIXED-LIVE perception (matches P1): update() moved this bot, so reinsert it at its new genital
            // position BEFORE later bots perceive. When bot #k perceives, the grid holds bots <k at their new
            // positions and bots >k at last tick's -- exactly what the brute-force scan of the live Map saw.
            if (this._useSpatialGrid) {
                const gp = bot.getGenitalPosition();
                this._swimbotGrid.move(bot, gp.x, gp.y);
            }

            if (bot.getIsLookingForSensoryInput()) {
                this._giveSwimbotNearbyEnvironmentalStimuli(bot);
            }

            if (this._obstacle.getCollision(bot.getPosition(), bot.getBoundingRadius() * ONE_HALF)) {
                this._collisionForce.set(this._obstacle.getCurrentCollisionForce());
                this._collisionForce.scale(1.2);
                bot.addForce(this._collisionForce);
            }

            if (bot.getIsTryingToEat()) {
                const eatenId = bot.eatChosenFoodBit(); // returns the chosen food's index (NULL_INDEX if none)
                if (eatenId !== NULL_INDEX) this._eatenFoodIds.add(eatenId); // dedups two-bots-one-food; swept below
            }

            if (bot.getIsTryingToMate()) {
                this._handleBirth(bot);
            }
        }
    }

    // Min-heap sift-down over the candidate array in [0, n), ordered by (d2 asc, id asc) -- the SAME strict
    // total order as the old `.sort((a,b)=>(a.d2-b.d2)||(a.id-b.id))`, so heap-pop order == sort order.
    _siftDownCandidates(heap, i, n) {
        for (;;) {
            let smallest = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            let s = heap[smallest];
            if (l < n) { const c = heap[l]; if (c.d2 < s.d2 || (c.d2 === s.d2 && c.id < s.id)) { smallest = l; s = c; } }
            if (r < n) { const c = heap[r]; if (c.d2 < s.d2 || (c.d2 === s.d2 && c.id < s.id)) { smallest = r; s = c; } }
            if (smallest === i) return;
            heap[smallest] = heap[i]; heap[i] = s;
            i = smallest;
        }
    }

    _giveSwimbotNearbyEnvironmentalStimuli(bot) {
        // nearby visible swimbots -- the CLOSEST-20 (D-b), replacing JJ's first-20-in-array-order (the last
        // slot/id-order artifact). Collect all in-view, non-obstructed candidates, rank by genital
        // distance^2 (tiebreak by stableID for determinism), take the closest BRAIN_MAX_PERCEIVED. Fully
        // order-independent now that the mate-pref rng is addressed (P1b-ii).
        this._nearbyCandidates.length = 0;
        const gpos = bot.getGenitalPosition(); // stable per-instance vector (a body part), not shared scratch
        const considerSwimbot = (other) => {
            if (other === bot || !other.getAlive()) return;
            const distanceSquared = gpos.getDistanceSquaredTo(other.getGenitalPosition());
            if (distanceSquared < this._viewRadius * this._viewRadius) {
                // NOTE: obstruction is checked LAZILY during selection (below), not here.
                this._nearbyCandidates.push({ other, d2: distanceSquared, id: other.getIndex() });
            }
        };
        if (this._useSpatialGrid) {
            this._swimbotGrid.forEachNear(gpos.x, gpos.y, considerSwimbot); // 3x3 superset; filtered above
        } else {
            for (const other of this._swimbots.values()) considerSwimbot(other);
        }
        // CLOSEST-20 via min-heap PARTIAL SELECT + LAZY obstruction: (d2,id) is a strict total order (ids
        // unique), so popping the heap yields candidates in exactly the old full-sort order; applying the
        // obstruction test only to popped candidates and taking the first BRAIN_MAX_PERCEIVED that pass gives
        // the identical selected set AND order as the old "filter-obstruction -> sort -> take 20", for
        // O(m + 20 log m) instead of O(m log m) + m obstruction calls (getObstruction is pure). Bit-identical.
        const cands = this._nearbyCandidates;
        let heapSize = cands.length;
        for (let i = (heapSize >> 1) - 1; i >= 0; i--) this._siftDownCandidates(cands, i, heapSize); // Floyd heapify
        this._numNearby = 0;
        while (heapSize > 0 && this._numNearby < BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS) {
            const top = cands[0];                         // current minimum (d2, id)
            heapSize--;
            if (heapSize > 0) { cands[0] = cands[heapSize]; this._siftDownCandidates(cands, 0, heapSize); }
            if (!this._obstacle.getObstruction(gpos, top.other.getGenitalPosition())) {
                this._nearbyArray[this._numNearby++] = top.other;
            }
        }

        // closest visible food (of the preferred type, when 2 food types). GRID-SAFE: an id tiebreak on
        // exactly-equal distance makes the choice independent of iteration order (P2 grid buckets).
        let foundFoodBit = false;
        let chosenFoodBit = null;
        let smallestDistance = Number.MAX_SAFE_INTEGER;
        let chosenFoodId = Infinity;
        const mpos = bot.getMouthPosition(); // stable per-instance vector (a body part), not shared scratch
        const considerFood = (food) => {
            if (!food.getAlive()) return;
            if (this._config.numFoodTypes === 2 && food.getType() !== bot.getPreferredFoodType()) return;
            const viewDistance = mpos.getDistanceTo(food.getPosition());
            if (viewDistance < this._viewRadius) {
                const distance = viewDistance / this._viewRadius;
                const id = food.getIndex();
                if ((distance < smallestDistance) || (distance === smallestDistance && id < chosenFoodId)) {
                    if (!this._obstacle.getObstruction(mpos, food.getPosition())) {
                        smallestDistance = distance;
                        chosenFoodId = id;
                        chosenFoodBit = food;
                        foundFoodBit = true;
                    }
                }
            }
        };
        if (this._useSpatialGrid) {
            this._foodGrid.forEachNear(mpos.x, mpos.y, considerFood); // 3x3 superset; filtered above
        } else {
            for (const food of this._foodBits.values()) considerFood(food);
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
                if (numType0 >= this._maxFoodBitsPerType) newFoodType = 1; else if (numType1 >= this._maxFoodBitsPerType) newFoodType = 0;
                parent = this._findRandomLivingFoodOfType(newFoodType);
                if (numType0 === 0) { newFoodType = 0; parent = this._findRandomLivingFoodOfType(1); }
                if (numType1 === 0) { newFoodType = 1; parent = this._findRandomLivingFoodOfType(0); }
            }

            if (parent) {
                const childId = this._nextFoodId++;
                const child = new FoodBit();
                child.setMaxSpawnRadius(this._config.foodSpread);
                child.setPoolBounds(this._config.pool); // before spawnFromParent -> randomizeSpawnPosition clamps to bounds
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
                this._livingFoodCount++;
                // Regen runs AFTER perception, so this food is first perceivable next tick (same as brute
                // force, which also scans _foodBits only during _updateSwimbots). Add it to the grid now.
                if (this._useSpatialGrid) { const p = child.getPosition(); this._foodGrid.insert(child, p.x, p.y); }
            }
        }
    }

    _applyPendingBirths() {
        for (const child of this._pendingBirths) {
            this._swimbots.set(child.getIndex(), child);
            this._livingSwimbotCount++;
            // Newborn joins the grid at its birth position; it first acts (and is first perceived) next tick.
            if (this._useSpatialGrid) { const gp = child.getGenitalPosition(); this._swimbotGrid.insert(child, gp.x, gp.y); }
        }
        this._pendingBirths.length = 0;
    }

    // Remove dead entities so the collection stays bounded. Their ids are NEVER reused (nextId is
    // monotonic), so a lingering chosenMate/chosenFood reference to a swept entity can only ever resolve
    // to that same (now-gone) individual -- never a new one. PERF: sweep only what died this tick (the
    // captured id lists), not the whole collection. Same SET removed as the old full scan (only dead
    // swimbots reach _deadSwimbotIds via die(); only eaten food reaches _eatenFoodIds), same ascending-id
    // survivor order (Map deletion doesn't reorder), same end-of-tick timing. Guards (has + !getAlive) make
    // it robust to duplicate/NULL ids so the live-food count decrements exactly once per removal.
    _sweepDead() {
        for (const id of this._deadSwimbotIds) {
            const bot = this._swimbots.get(id);
            if (bot !== undefined && !bot.getAlive()) {
                this._swimbots.delete(id);
                if (this._useSpatialGrid) this._swimbotGrid.remove(bot);
                // (living count already decremented in the onDeath hook, once per death)
            }
        }
        this._deadSwimbotIds.length = 0;

        for (const id of this._eatenFoodIds) {
            const food = this._foodBits.get(id);
            if (food !== undefined && !food.getAlive()) {
                this._foodBits.delete(id);
                if (this._useSpatialGrid) this._foodGrid.remove(food);
                this._livingFoodCount--;
            }
        }
        this._eatenFoodIds.clear();
    }

    // --- snapshot for tests (living entities; content + hidden chosenMate/brainState) ---
    // O(1): maintained incrementally (loadSwimbot/birth ++, onDeath --; loadFood/regen ++, eaten-sweep --).
    getLivingSwimbotCount() { return this._livingSwimbotCount; }
    getLivingFoodCount() { return this._livingFoodCount; }

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

    // --- checkpoint (H1): serialize the FULL world so World.restore(config, data) resumes bit-identically.
    // Serialize BETWEEN ticks (pendingBirths is empty then). Beyond the live entities + clock + never-reused
    // id high-water marks + stream counters, we also capture "GHOST" entities: swept/eaten entities still
    // referenced as some live bot's chosenMate/chosenFood, because the steering code (swimbot.update)
    // dereferences a dead ref's frozen position (only the eat/mate test guards on getAlive). Dropping them
    // would diverge. (config is NOT serialized -- the caller re-supplies the same config to restore.)
    serialize() {
        const swimbots = [];
        const ghostSwimbots = new Map(); // id -> serialized dead swimbot referenced as a chosenMate
        const ghostFood = new Map();     // id -> {id,x,y,type,energy} of an eaten food referenced as chosenFood
        for (const bot of this._swimbots.values()) {
            swimbots.push(bot.serializeCheckpoint());
            const cm = bot.getChosenMate(); // dead swimbots keep their _index (die() doesn't clear it)
            if (cm && !this._swimbots.has(cm.getIndex()) && !ghostSwimbots.has(cm.getIndex())) {
                ghostSwimbots.set(cm.getIndex(), cm.serializeCheckpoint());
            }
            const cfIdx = bot.getChosenFoodBitIndex(); // eaten food's kill() clears its index -> use the stored id
            if (cfIdx !== NULL_INDEX && !this._foodBits.has(cfIdx) && !ghostFood.has(cfIdx)) {
                const cf = bot.getChosenFoodBit();
                if (cf) ghostFood.set(cfIdx, { id: cfIdx, x: cf.getPosition().x, y: cf.getPosition().y, type: cf.getType(), energy: cf.getEnergy() });
            }
        }
        const food = [];
        for (const f of this._foodBits.values()) {
            food.push({ id: f.getIndex(), x: f.getPosition().x, y: f.getPosition().y, type: f.getType(), energy: f.getEnergy() });
        }
        return {
            masterSeed: this._masterSeed, clock: this._clock,
            nextSwimbotId: this._nextSwimbotId, nextFoodId: this._nextFoodId,
            numDeadSwimbots: this._numDeadSwimbots,
            livingSwimbotCount: this._livingSwimbotCount, livingFoodCount: this._livingFoodCount,
            foodRegenPosition: this._foodRegenStream.position,
            obstacle: this._obstacle.getEndpoints(),
            swimbots, food,
            ghostSwimbots: [...ghostSwimbots.values()],
            ghostFood: [...ghostFood.values()],
        };
    }

    static restore(config, data) {
        const world = new World(config, data.masterSeed);
        world._clock = data.clock;
        world._nextSwimbotId = data.nextSwimbotId;
        world._nextFoodId = data.nextFoodId;
        world._numDeadSwimbots = data.numDeadSwimbots;
        world._foodRegenStream.position = data.foodRegenPosition;
        world.setObstacle(data.obstacle[0], data.obstacle[1]);

        const makeFood = (fd, alive) => {
            const f = new FoodBit();
            if (alive) f.setIndex(fd.id); // dead ghost food keeps NULL_INDEX (getAlive false); keyed by id in the side map
            f.setPosition({ x: fd.x, y: fd.y }); f.setType(fd.type); f.setEnergy(fd.energy);
            f.setMaxSpawnRadius(config.foodSpread); f.setPoolBounds(config.pool);
            return f;
        };
        for (const fd of data.food) {
            const f = makeFood(fd, true);
            world._foodBits.set(fd.id, f);
            if (world._useSpatialGrid) world._foodGrid.insert(f, fd.x, fd.y);
        }
        const ghostFood = new Map();
        for (const fd of data.ghostFood) ghostFood.set(fd.id, makeFood(fd, false));

        const makeBot = (sd) => {
            const sb = world._makeSwimbot(sd.index);
            const g = new Genotype(); g.setGenes(sd.genes);
            sb.create(sd.index, sd.age, { x: sd.pos[0], y: sd.pos[1] }, sd.angle, sd.energy, g); // RNG-free rebuild
            sb.restoreCheckpointState(sd); // overwrite fresh state with the checkpointed accumulated state
            return sb;
        };
        for (const sd of data.swimbots) {
            const sb = makeBot(sd);
            world._swimbots.set(sd.index, sb);
            if (world._useSpatialGrid) { const gp = sb.getGenitalPosition(); world._swimbotGrid.insert(sb, gp.x, gp.y); }
        }
        const ghostSwimbots = new Map();
        for (const sd of data.ghostSwimbots) ghostSwimbots.set(sd.index, makeBot(sd)); // dead; not in _swimbots, not ticked

        const resolveSwimbot = (id) => world._swimbots.get(id) || ghostSwimbots.get(id);
        const resolveFood = (id) => world._foodBits.get(id) || ghostFood.get(id);
        for (const sb of world._swimbots.values()) sb.relinkChosen(resolveSwimbot, resolveFood);

        world._livingSwimbotCount = data.livingSwimbotCount;
        world._livingFoodCount = data.livingFoodCount;
        return world;
    }
}
