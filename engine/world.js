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
import { ObstacleField } from './obstacle-field.js';
import { Genotype } from './genotype.js';
import { bytesToBase64 } from './genome.js';
import { Embryology } from './embryology.js';
import { Vector2D } from './vector2d.js';
import { draw, makeStream, DOMAIN } from './rng.js';
import { SpatialGrid } from './spatialGrid.js';
import { FrozenSwimbot } from './snapshotView.js';
import { Perception } from './perception.js';
import { makeTopology } from './topology.js';
import {
    ZERO, ONE, ONE_HALF, NULL_INDEX, NUM_GENES, NUM_GENES_USED, BYTE_SIZE,
    MAX_FOODBITS_PER_TYPE, NON_REPRODUCING_JUNK_DNA_LIMIT,
    SWIMBOT_VIEW_RADIUS, resolvePoolBounds,
} from './constants.js';

// Pack a NUM_GENES-length 0/1 mask into a hex string (LSB-first within each byte): bit g -> byte floor(g/8),
// bit position g%8. NUM_GENES/8 bytes -> 2 hex chars each. Used for the per-birth gene-inheritance masks.
// Assumes NUM_GENES is a multiple of 8 (256 today); a non-multiple would drop the partial tail byte.
export function packMaskHex(mask) {
    const nBytes = NUM_GENES >> 3;
    let hex = '';
    for (let byte = 0; byte < nBytes; byte++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) if (mask[(byte << 3) + bit]) b |= (1 << bit);
        hex += b.toString(16).padStart(2, '0');
    }
    return hex;
}

export class World {
    // masterSeed is a non-negative safe integer; every draw is addressed off it (§3). No global stream.
    // options.useSpatialGrid (default true) picks the P2 spatial-grid perception; false = the brute-force
    // O(n^2) reference path (kept for the bit-for-bit A/B, and as a fallback).
    constructor(config, masterSeed, options = {}) {
        this._config = config;
        this._masterSeed = masterSeed;
        this._topology = makeTopology(config); // §7 seam: walls -> FLAT (bit-identical); torus is P4

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
        // OPT-IN total living-food ceiling (JJ's MAX_FOODBITS: regen spawns only when living food < cap, and
        // draws no RNG when full). Default Infinity -> no cap -> byte-identical to pre-cap (the north star: bounds
        // are user config, not engine defaults). The viewer sets it to reproduce JJ's standing food level.
        this._maxFood = config.maxFood ?? Infinity;
        // §8: the physical environment is a FIELD of obstacles (a list; empty is legal). Built from per-pool config
        // (`config.obstacles`: [{a,b,thickness?,mask?}]); the engine imposes none. Pool bounds + topology first, so
        // each obstacle's clamp / torus line-of-sight (P4d) is set up before its endpoints. setObstacle(e1,e2)
        // remains as a single-obstacle convenience -- a one-obstacle field is bit-identical to the old path.
        this._obstacleField = new ObstacleField();
        this._obstacleField.setPoolBounds(config.pool);
        this._obstacleField.setTopology(this._topology);
        if (config.obstacles) this._obstacleField.setObstacles(config.obstacles);

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
        // L5 carrying-capacity knob (D-f): OPT-IN population bound for long/hosted runs. Default = no cap
        // (Infinity) -> births are never suppressed -> byte-identical to pre-cap (North Star: bounds are user
        // config, NOT an engine default -- unlike JJ's always-on 2000-slot cap we removed at P1b).
        this._maxPopulation = config.maxPopulation ?? Infinity;
        // Optional event sink (observability foundation for P5 events->DB). When set, the engine calls it with
        // {type, tick, ...} for births/deaths/eats + a per-tick summary. Default null -> zero overhead, and the
        // sink is a pure OBSERVER (must not mutate the world), so an event-instrumented run is byte-identical
        // to a plain one. Guarded at each call site so nothing is allocated when off.
        this._onEvent = options.onEvent || null;
        this._useSpatialGrid = options.useSpatialGrid !== false;
        this._swimbotGrid = new SpatialGrid(this._viewRadius, this._topology);
        this._foodGrid = new SpatialGrid(this._viewRadius, this._topology);
        // TORUS (P4c): the grid finds cross-seam neighbors by querying wrapped opposite-edge images; those image
        // cell-sets stay disjoint from the base only when each axis spans >= 3 cells (cellSize == viewRadius), else
        // an entity is double-visited. Guard it -- but ONLY for the GRID path; brute-force images distances (not
        // cells) and is correct on any size, so it needs no lower bound (faithful-mechanism: no gratuitous limit).
        if (this._useSpatialGrid && this._topology.isToroidal() && (this._topology.getWidth() < 3 * this._viewRadius || this._topology.getHeight() < 3 * this._viewRadius)) {
            throw new Error(`torus pool with the spatial grid must be >= 3*viewRadius (${3 * this._viewRadius}) per axis; got ${this._topology.getWidth()}x${this._topology.getHeight()}`);
        }

        // PERCEPTION MODE (Parallelism Step 1). 'mixed-live' (default) is the order-DEPENDENT, bit-for-bit-
        // faithful path: a bot reinserted into the grid mid-loop is perceived at its new position by later bots.
        // 'snapshot' instead freezes a tick-start view of every bot, so every bot perceives the SAME frozen set
        // regardless of processing order -> the tick is order-INDEPENDENT (the prerequisite for intra-tick
        // parallelism). It is a different but deterministic trajectory ("consistent, not identical"), NOT
        // bit-for-bit -- it has its own baseline. Everything below is gated by _snapshotMode; default false ->
        // ZERO behavior change (the whole golden suite stays green). _snapshotViews persists across ticks with
        // ONE FrozenSwimbot per id, refreshed in place (stable identity is safe: ids are never reused -> no ABA).
        this._perceptionMode = config.perceptionMode || 'mixed-live';
        this._snapshotMode = this._perceptionMode === 'snapshot';
        this._snapshotViews = new Map(); // id -> FrozenSwimbot (persistent)
        // Snapshot mode gets its OWN spatial grid, REBUILT from the frozen tick-start positions each
        // _buildSnapshot -- NOT the live _swimbotGrid (which is moved mid-loop -> order-dependent). cellSize ==
        // viewRadius (the P2 invariant: the 3x3 neighborhood covers the whole view circle, so the grid returns
        // EXACTLY the brute-force in-radius set). Built once, never moved mid-loop -> order-independent, and turns
        // the swimbot nearby-scan from O(n) brute force into O(neighbors). Only allocated when snapshot+grid are
        // both on; useSpatialGrid:false keeps the brute-force scan (kept for the grid-vs-brute-force A/B).
        this._snapshotGrid = (this._snapshotMode && this._useSpatialGrid) ? new SpatialGrid(this._viewRadius, this._topology) : null;
        // Opt-in per-phase wall-clock profiling (parallelism ceiling analysis). options.profile = an object;
        // the tick accumulates ms into .build / .loop / .resolve on it. null -> a couple of per-TICK branch
        // checks, no per-bot cost. The loop is the parallelizable phase; build+resolve are the serial Amdahl tax.
        this._profile = options.profile || null;

        // scratch genotypes / vectors (mirroring JJ's shared scratch in GenePool)
        this._myGenotype = new Genotype();
        this._childGenotype = new Genotype();
        this._birthPos = new Vector2D();
        this._birthDiff = new Vector2D(); // scratch for the §7 displacement in _handleBirth's birthPos midpoint
        this._collisionForce = new Vector2D();
        // Shared perception selection (closest-20 + food scan + setEnvironmentalStimuli). Holds its own scratch;
        // the same class backs the worker-parallel path so both produce identical selections.
        this._perception = new Perception();
    }

    // Each swimbot gets its OWN per-life SWIMBOT_LIFE stream keyed on its never-reused id, plus the shared
    // pairwise matePref. (create() is RNG-free, so the stream is unused until the first tick.)
    _makeSwimbot(id) {
        return new Swimbot({
            life: makeStream(this._masterSeed, DOMAIN.SWIMBOT_LIFE, id),
            matePref: this._matePref,
            config: this._config, embryology: this._embryology, topology: this._topology,
            onDeath: (deadId) => {
                this._numDeadSwimbots++; this._deadSwimbotIds.push(deadId); this._livingSwimbotCount--;
                if (this._onEvent) this._onEvent({ type: 'death', tick: this._clock, id: deadId });
            },
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
        // Snapshot mode scans the frozen views, never the swimbot grid, so don't build it there.
        if (this._useSpatialGrid && !this._snapshotMode) { const gp = sb.getGenitalPosition(); this._swimbotGrid.insert(sb, gp.x, gp.y); }
        if (id >= this._nextSwimbotId) this._nextSwimbotId = id + 1;
        // Run-file: a founder is a DAG root -- record its FULL initial state (§14 rebuildability). Genes as an
        // immutable base64 string. Observer-only, RNG-free -> bit-identical. (NOTE: loadSwimbot is also the future
        // checkpoint-restore path; when P6 lands, gate this on "initial seeding" so restored bodies aren't relabeled.)
        if (this._onEvent) this._onEvent({ type: 'founder', tick: this._clock, id, genes: bytesToBase64(g.getGenes()), x, y, angle, age, energy });
    }

    loadFood(id, { x, y, type, energy }) {
        const f = new FoodBit();
        f.setIndex(id);
        f.setPosition({ x, y });
        f.setType(type);
        f.setEnergy(energy);
        f.setMaxSpawnRadius(this._config.foodSpread);
        f.setPoolBounds(this._config.pool);
        f.setTopology(this._topology);
        this._foodBits.set(id, f);
        this._livingFoodCount++;
        if (this._useSpatialGrid) { const p = f.getPosition(); this._foodGrid.insert(f, p.x, p.y); }
        if (id >= this._nextFoodId) this._nextFoodId = id + 1;
        // Run-file: initial food placement (§14 rebuildability). Observer-only.
        if (this._onEvent) this._onEvent({ type: 'food_init', tick: this._clock, id, x, y, foodType: type, energy });
    }

    // Convenience: set the field to a SINGLE default-thickness obstacle (back-compat for tests/tools/restore).
    // For multiple or masked obstacles, supply `config.obstacles` at construction.
    setObstacle(e1, e2) { this._obstacleField.setObstacles([{ a: e1, b: e2 }]); }

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
        if (this._onEvent) this._onEvent({ type: 'tick', tick: this._clock, pop: this._livingSwimbotCount, food: this._livingFoodCount });
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
        const prof = this._profile;
        let t0;
        // SNAPSHOT: capture the frozen tick-start view of every bot ONCE, before the loop, so all bots perceive
        // the same set regardless of processing order (order-independence). Mixed-live builds nothing.
        if (this._snapshotMode) {
            if (prof) t0 = performance.now();
            this._buildSnapshot();
            if (prof) prof.build += performance.now() - t0;
        }

        if (prof) t0 = performance.now();
        // Iterate a snapshot of the current live swimbots (staged births are NOT in it -> they act next
        // tick). Structural mutation (staging/sweeping) happens outside this loop. THIS is the parallelizable
        // phase: each bot reads the frozen snapshot and writes only its OWN state (eats/births deferred below).
        for (const bot of this._swimbots.values()) {
            if (!bot.getAlive()) continue;
            bot.update();
            if (!bot.getAlive()) continue; // H-a: update() can kill it (old age / starvation)

            // MIXED-LIVE perception (matches P1): update() moved this bot, so reinsert it at its new genital
            // position BEFORE later bots perceive. When bot #k perceives, the grid holds bots <k at their new
            // positions and bots >k at last tick's -- exactly what the brute-force scan of the live Map saw.
            // SNAPSHOT never reads the live swimbot grid (it scans the frozen views), so skip the move.
            if (this._useSpatialGrid && !this._snapshotMode) {
                const gp = bot.getGenitalPosition();
                this._swimbotGrid.move(bot, gp.x, gp.y);
            }

            if (bot.getIsLookingForSensoryInput()) {
                this._giveSwimbotNearbyEnvironmentalStimuli(bot);
            }

            if (this._obstacleField.getCollision(bot.getPosition(), bot.getBoundingRadius() * ONE_HALF)) {
                this._collisionForce.set(this._obstacleField.getCurrentCollisionForce());
                this._collisionForce.scale(1.2);
                bot.addForce(this._collisionForce);
            }

            // SNAPSHOT defers eating + birth to deterministic post-loop, id-ordered passes so that NO food is
            // killed and NO mate energy is spent DURING the loop -> the loop performs no cross-bot writes ->
            // order-independent. Mixed-live resolves both inline here (its faithful order-dependent behavior).
            if (!this._snapshotMode) {
                if (bot.getIsTryingToEat()) {
                    const eatenBefore = this._onEvent ? bot.getNumFoodBitsEaten() : 0;
                    const eatenId = bot.eatChosenFoodBit(); // returns the chosen food's index (NULL_INDEX if none)
                    if (eatenId !== NULL_INDEX) this._eatenFoodIds.add(eatenId); // dedups two-bots-one-food; swept below
                    if (this._onEvent && bot.getNumFoodBitsEaten() > eatenBefore) { // an actual eat (not a guard-skip)
                        this._onEvent({ type: 'eat', tick: this._clock, id: bot.getIndex(), foodId: eatenId });
                    }
                }

                if (bot.getIsTryingToMate()) {
                    this._handleBirth(bot);
                }
            }
        }
        if (prof) prof.loop += performance.now() - t0;

        if (this._snapshotMode) {
            if (prof) t0 = performance.now();
            this._resolveStagedEats();
            this._resolveStagedBirths();
            if (prof) prof.resolve += performance.now() - t0;
        }
    }

    // SNAPSHOT: build the tick-start frozen view of every bot. ONE FrozenSwimbot per id, refreshed IN PLACE
    // (stable identity across ticks). A view not refreshed this build (its bot died + was swept) becomes a
    // one-tick GHOST (alive=false, last position kept) so a lingering chosenMate ref reads a stable dead marker
    // this tick; a view that was ALREADY a ghost last tick is pruned. REQUIRED: reset _seen on every view before
    // the refresh sweep, or markDead() never fires and dead bots stay phantom-alive in the snapshot.
    _buildSnapshot() {
        const views = this._snapshotViews;
        for (const v of views.values()) v._seen = false;
        for (const sb of this._swimbots.values()) {
            if (!sb.getAlive()) continue;
            let v = views.get(sb.getIndex());
            if (v === undefined) { v = new FrozenSwimbot(this._matePref, this._viewRadius, this._topology); views.set(sb.getIndex(), v); }
            v.refresh(sb); // sets _seen = true
        }
        for (const [id, v] of views) {
            if (v._seen) continue;
            if (v._alive) v.markDead(); // just died -> one-tick ghost
            else views.delete(id);      // already a ghost last tick -> prune
        }
        // Rebuild the snapshot grid from the LIVE frozen views (tick-start positions). Ghosts are not
        // perceivable, so they are not inserted. Built here, before the loop -> never mutated mid-loop.
        if (this._snapshotGrid) {
            const grid = this._snapshotGrid;
            grid.clear();
            for (const v of views.values()) {
                if (!v.getAlive()) continue;
                const g = v.getGenitalPosition();
                grid.insert(v, g.x, g.y);
            }
        }
    }

    // SNAPSHOT eat resolution: eats were deferred, so the perception loop killed no food. Resolve them in
    // ASCENDING BOT-ID order -- NOT Map/insertion order, which is not guaranteed ascending (loadSwimbot can be
    // called with descending ids). Two bots that chose the SAME food (the same live object, from the same frozen
    // scan): the lowest id eats it (kill()); higher ids find it dead via eatChosenFoodBit's getAlive() guard and
    // no-op -- exactly the faithful loser behavior, no custom award/energy logic. Bookkeeping mirrors mixed-live.
    _resolveStagedEats() {
        const ids = [...this._swimbots.keys()].sort((a, b) => a - b);
        for (const id of ids) {
            const bot = this._swimbots.get(id);
            if (!bot.getAlive() || !bot.getIsTryingToEat()) continue;
            const eatenBefore = this._onEvent ? bot.getNumFoodBitsEaten() : 0;
            const eatenId = bot.eatChosenFoodBit();
            if (eatenId !== NULL_INDEX) this._eatenFoodIds.add(eatenId); // Set dedups; _sweepDead guards !getAlive()
            if (this._onEvent && bot.getNumFoodBitsEaten() > eatenBefore) {
                this._onEvent({ type: 'eat', tick: this._clock, id: bot.getIndex(), foodId: eatenId });
            }
        }
    }

    // SNAPSHOT birth resolution: births were deferred, so no mate energy was spent during the loop. Resolve in
    // ASCENDING PARENT-ID order (again: sorted keys, not insertion order). Two consequences make this the
    // fixed-key resolution the parallelism plan needs: (1) newborn ids are minted in a deterministic order, so
    // OFFSPRING_GENOME (addressed by newborn id) is order-independent; (2) contributeToOffspring clearing a
    // consumed mate's _tryingToMate suppresses that bot's own mating -- mirroring mixed-live, which also resolves
    // inline in ascending order. _handleBirth resolves the mate's genital from its FROZEN view in snapshot mode.
    _resolveStagedBirths() {
        const ids = [...this._swimbots.keys()].sort((a, b) => a - b);
        for (const id of ids) {
            const parent = this._swimbots.get(id);
            if (!parent.getAlive() || !parent.getIsTryingToMate()) continue;
            this._handleBirth(parent);
        }
    }

    // Perception (closest-20 swimbots + closest food) is done by the SHARED Perception selector; World only
    // supplies HOW to enumerate candidates near a point (which differs by mode: snapshot frozen views/grid, the
    // live swimbot grid, or a brute-force Map scan; food via its grid or a Map scan). The selection + the
    // setEnvironmentalStimuli call live in engine/perception.js, shared bit-for-bit with the worker-parallel path.
    _giveSwimbotNearbyEnvironmentalStimuli(bot) {
        const enumerateSwimbots = (gpos, consider) => {
            if (this._snapshotMode) {
                // SNAPSHOT: candidates are the FROZEN views (tick-start). The grid (cellSize==viewRadius, torus-
                // aware) returns exactly the brute-force in-radius set (P2 invariant); useSpatialGrid:false = brute.
                if (this._snapshotGrid) this._snapshotGrid.forEachNear(gpos.x, gpos.y, consider);
                else for (const view of this._snapshotViews.values()) consider(view);
            } else if (this._useSpatialGrid) {
                this._swimbotGrid.forEachNear(gpos.x, gpos.y, consider);
            } else {
                for (const other of this._swimbots.values()) consider(other);
            }
        };
        const enumerateFood = (mpos, consider) => {
            if (this._useSpatialGrid) this._foodGrid.forEachNear(mpos.x, mpos.y, consider);
            else for (const food of this._foodBits.values()) consider(food);
        };
        this._perception.perceive(bot, this._clock, this._viewRadius, this._obstacleField, this._config.numFoodTypes, enumerateSwimbots, enumerateFood, this._topology);
    }

    _handleBirth(parent) {
        // L5 carrying capacity (opt-in): suppress births once the projected population reaches the cap.
        // Default Infinity -> never true. Consumes no id/RNG for a suppressed birth (checked before minting).
        if (this._livingSwimbotCount + this._pendingBirths.length >= this._maxPopulation) return;
        const mateId = parent.getChosenMateIndex();
        if (mateId === NULL_INDEX) return;
        const mate = this._swimbots.get(mateId);
        // NEVER-REUSED ids: `mate` is either the exact chosen individual (alive/dead) or gone -- it can
        // never be a DIFFERENT swimbot that reused the id. This is where the ABA used to live. The LIVE mate
        // object is still needed for its genotype (static) and contributeToOffspring, even in snapshot mode.
        if (!mate) return;

        // MIXED-LIVE reads the mate's genital + aliveness LIVE (as it is when the parent processes -> order-
        // dependent, faithful). SNAPSHOT reads the mate's FROZEN tick-start view so birthPos + the gate are
        // order-independent. Baseline note: in snapshot a mate alive at tick-start but dead by resolution can
        // still parent (contributeToOffspring is energy-clamp-safe -> no assert, no negative energy).
        let mateGenX, mateGenY;
        if (this._snapshotMode) {
            const mv = this._snapshotViews.get(mateId);
            if (!mv || !mv.getAlive()) return;
            const mg = mv.getGenitalPosition();
            mateGenX = mg.x; mateGenY = mg.y;
        } else {
            if (!mate.getAlive()) return;
            const mg = mate.getGenitalPosition();
            mateGenX = mg.x; mateGenY = mg.y;
        }

        this._myGenotype.copyFromGenotype(parent.getGenotype());
        const mateGenotype = mate.getGenotype();
        if (this._getJunkDnaSimilarity(this._myGenotype, mateGenotype) <= NON_REPRODUCING_JUNK_DNA_LIMIT) return;

        const newBornId = this._nextSwimbotId++;

        // The newborn's birth-time randomness (genome crossover+mutation, then the initial angle) comes
        // from its OWN addressed OFFSPRING_GENOME stream -- a pure function of its id, independent of when
        // in the tick the birth happens.
        const genomeStream = makeStream(this._masterSeed, DOMAIN.OFFSPRING_GENOME, newBornId);
        const genomeRng = () => genomeStream.next();
        // Capture gene-inheritance (which parent each gene came from + mutations) ONLY when a listener is
        // attached -- reuse one pair of buffers so births allocate nothing (§13). parentOf bit 0 => the gene
        // came from parentId, 1 => from mateId (parent0 = this parent's genotype, parent1 = the mate's).
        let provenance = null;
        if (this._onEvent) {
            if (!this._provenance) this._provenance = { parentOf: new Uint8Array(NUM_GENES), mutated: new Uint8Array(NUM_GENES) };
            provenance = this._provenance;
        }
        this._childGenotype.setAsOffspring(this._myGenotype, mateGenotype, genomeRng, {
            crossoverRate: this._config.crossoverRate, mutationRate: this._config.mutationRate,
        }, provenance);

        const myEnergyContribution = parent.contributeToOffspring();
        const mateEnergyContribution = mate.contributeToOffspring();
        const energyToOffspring = myEnergyContribution + mateEnergyContribution;

        // birthPos: parent genital (live -- its own end-of-tick position, both modes) midpoint-to the mate
        // genital (live in mixed-live, frozen tick-start in snapshot). Via the §7 seam: displacement gives
        // parent->mate (flat: mate - parent, the identical arithmetic -> mixed-live stays bit-for-bit), then
        // wrap keeps the midpoint in-frame (flat: identity). On a torus this is the one birth site that needs
        // BOTH -- the shortest wrapped vector, and a midpoint that could land across the seam.
        const parentGenX = parent.getGenitalPosition().x;
        const parentGenY = parent.getGenitalPosition().y;
        this._topology.displacement(parentGenX, parentGenY, mateGenX, mateGenY, this._birthDiff);
        this._birthPos.x = parentGenX + this._birthDiff.x * ONE_HALF;
        this._birthPos.y = parentGenY + this._birthDiff.y * ONE_HALF;
        this._topology.wrap(this._birthPos.x, this._birthPos.y, this._birthPos);

        const initialAngle = -180.0 + genomeRng() * 360.0; // from the same stream, AFTER the genome

        const child = this._makeSwimbot(newBornId);
        child.create(newBornId, 0, this._birthPos, initialAngle, energyToOffspring, this._childGenotype);
        // T+1: stage the newborn; it joins the collection AFTER this tick and first acts next tick.
        this._pendingBirths.push(child);
        if (this._onEvent) this._onEvent({ type: 'birth', tick: this._clock, id: newBornId, parentId: parent.getIndex(), mateId: mate.getIndex(), x: this._birthPos.x, y: this._birthPos.y, genes: bytesToBase64(this._childGenotype.getGenes()), parentMask: packMaskHex(provenance.parentOf), mutationMask: packMaskHex(provenance.mutated) });
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
            // JJ's food ceiling: if living food is at the cap, spawn nothing this tick AND draw no RNG (JJ's
            // findLowestDeadFoodBit returns NULL when the array is full, before any draw). Default Infinity -> never.
            if (this._maxFood !== Infinity) {
                let living = 0;
                for (const food of this._foodBits.values()) if (food.getAlive()) living++;
                if (living >= this._maxFood) return;
            }
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
                child.setTopology(this._topology); // torus: spawn wraps instead of reflecting (P4d)
                child.spawnFromParent(parent, childId, newFoodType, this._foodRegenRng);

                let looking = true;
                let num = 0;
                while (looking) {
                    child.randomizeSpawnPosition(parent, this._foodRegenRng);
                    if (!this._obstacleField.getObstruction(parent.getPosition(), child.getPosition())) looking = false;
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
            // Snapshot mode never reads the swimbot grid (it will appear in next tick's frozen view via _swimbots).
            if (this._useSpatialGrid && !this._snapshotMode) { const gp = child.getGenitalPosition(); this._swimbotGrid.insert(child, gp.x, gp.y); }
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
                if (this._useSpatialGrid && !this._snapshotMode) this._swimbotGrid.remove(bot);
                // (living count already decremented in the onDeath hook, once per death)
                // (snapshot mode: the frozen view is ghosted/pruned by _buildSnapshot, not the grid)
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
        // H1 checkpoint does not yet support snapshot mode: a bot's _chosenMate is a FrozenSwimbot (no
        // serializeCheckpoint), and the frozen-view/ghost state would need its own persistence contract. Fail
        // loudly rather than crash cryptically. (Checkpoint a mixed-live world; snapshot checkpointing is future work.)
        if (this._snapshotMode) throw new Error('World.serialize(): checkpoint is not supported in snapshot perception mode yet.');
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
            obstacles: this._obstacleField.toSpecs(), // §8: the full obstacle list (was a single `obstacle` pair)
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
        if (data.obstacles) world._obstacleField.setObstacles(data.obstacles);      // §8 checkpoints
        else if (data.obstacle) world.setObstacle(data.obstacle[0], data.obstacle[1]); // legacy single-obstacle checkpoints

        const makeFood = (fd, alive) => {
            const f = new FoodBit();
            if (alive) f.setIndex(fd.id); // dead ghost food keeps NULL_INDEX (getAlive false); keyed by id in the side map
            f.setPosition({ x: fd.x, y: fd.y }); f.setType(fd.type); f.setEnergy(fd.energy);
            f.setMaxSpawnRadius(config.foodSpread); f.setPoolBounds(config.pool); f.setTopology(world._topology);
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
