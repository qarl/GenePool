// SPIKE — a PARTITION: the real Swimbots owned by one worker (id range [idStart,idEnd)). The heavy state
// (phenotype/brain/vectors) lives here and never crosses threads; only the frozen slots do. The two phases map
// onto the barrier-synced tick: writeFrozen() then (after the barrier) step(). Ecology is intentionally disabled
// by the caller's config (no metabolism / huge lifespan) so population is fixed and the per-tick compute is a
// stable, repeatable PERF probe -- eats and births are out of scope for the spike (they are the serial-resolution
// hardening that comes AFTER the spike proves the parallel loop is worth it).

import { Swimbot } from '../../../engine/swimbot.js';
import { Genotype } from '../../../engine/genotype.js';
import { Embryology } from '../../../engine/embryology.js';
import { ObstacleField } from '../../../engine/obstacle-field.js';
import { FoodBit } from '../../../engine/foodBit.js';
import { Vector2D } from '../../../engine/vector2d.js';
import { makeStream, draw, DOMAIN } from '../../../engine/rng.js';
import { computeMetricForCriterion } from '../../../engine/attraction.js';
import { SWIMBOT_VIEW_RADIUS, ONE_HALF, ONE, NUM_GENES, NUM_GENES_USED, BYTE_SIZE, NON_REPRODUCING_JUNK_DNA_LIMIT } from '../../../engine/constants.js';
import { writeSlot, F_ALIVE, F_GX, F_GY, STRIDE } from './frozen-layout.mjs';
import { FD_STRIDE, FD_ALIVE, FD_ENERGY, FD_POSX, FD_POSY, FD_TYPE, writeFood, buildFoodGridOnce } from './food-layout.mjs';
import { writePostUpdate, PU_STRIDE, PU_ALIVE, PU_ENERGY, PU_GX, PU_GY, FLAG_ENERGY_SET, FLAG_TIMER_RESET, FLAG_CLEAR_EAT, FLAG_CLEAR_MATE,
         NB_ID, NB_X, NB_Y, NB_ANGLE, NB_ENERGY, NB_STRIDE } from './resolution-layout.mjs';
import { R_X, R_Y, R_ANGLE, R_ENERGY, R_HUE, R_ALIVE, R_STRIDE, hueOfGenes } from './render-layout.mjs';
import { Perceiver } from './perceive.mjs';

export class Partition {
    // coopGrid (a CoopGrid or null): null -> JS-grid mode (writeFrozen+step, the single-thread reference);
    // set -> coop mode (the phased build below). w/W: this worker's index + total, for the cell-range zero.
    // foodGrid/foodF64/numFood: the prebuilt read-only food grid + food SoA (S1) for the perceiver's food scan.
    // res (or null): the cross-worker resolution buffers {wantsEat, resolvedEnergy, numFoodEatenDelta,
    // numOffspringDelta, flags} (typed-array views) + {foodF64, numFood, numBotIds} for worker 0's resolve.
    constructor(f64, maxBots, masterSeed, config, founders, idStart, idEnd, obstacle, coopGrid = null, w = 0, W = 1, foodGrid = null, foodF64 = null, numFood = 0, puF64 = null, res = null, nextIdStart = 0, renderF32 = null) {
        this._renderF32 = renderF32; // optional shared render buffer (viewer streaming)
        this._f64 = f64;
        this._maxBots = maxBots;
        this._masterSeed = masterSeed;
        this._config = config;
        this._embryology = new Embryology();
        this._matePref = (l, c, t, i) => draw(masterSeed, DOMAIN.MATE_PREF, l, c, t, i);
        this._viewRadius = config.viewRadius ?? SWIMBOT_VIEW_RADIUS;
        // §8 obstacle FIELD -- reuse the engine's ObstacleField so the parallel path supports MULTIPLE obstacles +
        // per-obstacle thickness/masks, bit-identical to world.js. FLAT only (torus is rejected by runPoolParallel).
        // Built from config.obstacles when present (runPoolParallel), else the single workerData obstacle (the gates).
        this._obstacleField = new ObstacleField();
        this._obstacleField.setPoolBounds(config.pool); // endpoint wall-clamp uses the config pool, not the 8000 default
        this._obstacleField.setObstacles(config.obstacles !== undefined ? config.obstacles : [{ a: obstacle[0], b: obstacle[1] }]);
        this._collisionForce = new Vector2D();
        this._coopGrid = coopGrid;
        this._w = w;
        this._W = W;
        this._puF64 = puF64; // post-update SoA (written after update(); read by worker 0's resolve)
        this._res = res;     // cross-worker resolution buffers (null in the ecology-off / JS-baseline paths)
        this._foodF64 = foodF64;
        this._numFood = numFood;
        this._foodGrid = foodGrid;
        // Worker 0 owns the AUTHORITATIVE food (real FoodBits) for bit-identical regen (world.js _updateFood):
        // real FoodBit.spawnFromParent/randomizeSpawnPosition + a POOL_FOOD_REGEN stream. Built from the food SoA.
        // Other workers only READ the food SoA/grid for perception, so they skip this.
        if (w === 0 && res) {
            this._foodBits = new Map();
            for (let id = 0; id < numFood; id++) {
                const fb = new FoodBit();
                fb.setIndex(id);
                fb.setPosition({ x: foodF64[id * FD_STRIDE + FD_POSX], y: foodF64[id * FD_STRIDE + FD_POSY] });
                fb.setType(foodF64[id * FD_STRIDE + FD_TYPE]);
                fb.setEnergy(foodF64[id * FD_STRIDE + FD_ENERGY]);
                fb.setMaxSpawnRadius(config.foodSpread);
                fb.setPoolBounds(config.pool);
                this._foodBits.set(id, fb);
            }
            this._nextFoodId = numFood;
            this._maxFood = foodF64.length / FD_STRIDE;          // SoA buffer capacity (food ids never reused)
            this._foodCeiling = config.maxFood ?? Infinity;      // JJ's MAX_FOODBITS: living-food ceiling (opt-in)
            this._foodRegenStream = makeStream(masterSeed, DOMAIN.POOL_FOOD_REGEN);
            this._foodRegenRng = () => this._foodRegenStream.next();
        }
        // Birth-resolution state (worker 0): the monotonic newborn-id counter, config rates, and scratch genotypes
        // + a shared genome view. Founders write their genomes into the shared SoA so worker 0 can read any
        // parent/mate genome for the junk-DNA gate + setAsOffspring. (All workers hold these; only w0 mints.)
        this._nextId = nextIdStart;
        this._childEnergyRatio = config.childEnergyRatio;
        this._crossoverRate = config.crossoverRate;
        this._mutationRate = config.mutationRate;
        this._maxPopulation = config.maxPopulation ?? Infinity;
        this._reproductiveIsolation = config.reproductiveIsolation ?? NON_REPRODUCING_JUNK_DNA_LIMIT; // §11: per-pool (default 0.9)
        this._genomeU8 = res ? res.genome : null;
        this._myGeno = new Genotype();
        this._mateGeno = new Genotype();
        this._childGeno = new Genotype();
        this._workEnergy = res ? new Float64Array(maxBots) : null;   // worker-0 scratch (working energy during resolve)
        this._workTrying = res ? new Uint8Array(maxBots) : null;     // worker-0 scratch (working tryingToMate)
        this._bots = [];
        // `founders` is indexed for THIS range: founders[id - idStart] is bot `id`. The single-thread baseline
        // passes the full array with idStart=0.
        for (let id = idStart; id < idEnd; id++) {
            const f = founders[id - idStart];
            this._bots.push(this._makeBot(id, f.age, f.x, f.y, f.angle, f.energy, f.genes));
            if (this._genomeU8) this._genomeU8.set(f.genes, id * NUM_GENES); // publish founder genome for worker 0
        }
        const foodCapacity = foodF64 ? (foodF64.length / FD_STRIDE) : 0; // views must cover regen-grown food ids
        this._perceiver = new Perceiver(f64, maxBots, this._matePref, this._viewRadius, this._obstacleField, coopGrid, config.numFoodTypes ?? 1, foodGrid, foodF64, foodCapacity);
    }

    // Grow-on-near-full (keep slot==id; ids still never reused). Main reallocated the SWIMBOT SABs bigger and
    // copied the two cross-tick-persistent ones (frozen _f64 + resolution _res / genome); everything else is
    // per-tick scratch, repopulated next tick. Rebind every view. Same values at the same indices -> G1/G2 hold.
    // Heavy Swimbot state (this._bots) lives in the worker heap and is untouched.
    rebindGrow(f64, maxBots, coopGrid, puF64, res, renderF32) {
        this._f64 = f64;
        this._maxBots = maxBots;
        this._coopGrid = coopGrid;
        this._puF64 = puF64;
        this._res = res;
        this._renderF32 = renderF32;
        this._genomeU8 = res ? res.genome : null;
        if (res) {
            this._workEnergy = new Float64Array(maxBots); // worker-0 scratch, cleared each resolve -> no copy
            this._workTrying = new Uint8Array(maxBots);
        }
        this._perceiver.rebindGrow(f64, maxBots, coopGrid);
    }

    // The next food id worker 0 will mint (== all food ids ever minted). Published to CTL_NEXTFOODID each tick so
    // main can grow the food SABs BEFORE this reaches _maxFood (which would SKIP a regen and diverge from world.js).
    getNextFoodId() { return this._nextFoodId; }

    // FREE-RUN grow trigger (worker 0 only): near-full on swimbots OR food. Same thresholds as run.mjs's maybeGrow
    // (the handshake path decides main-side from the published counters; free-run decides worker-side). _nextFoodId/
    // _maxFood are only set on worker 0 -> undefined elsewhere, but only worker 0 calls this.
    needsGrow() { return this._nextId >= (this._maxBots >> 1) || this._nextFoodId >= this._maxFood - 2; }

    // Food-grow (grow-on-near-full): main reallocated the food SoA + food grid bigger and copied the persistent
    // food SoA + the (static) food-grid scatter into them. Rebind every food view/grid; worker 0's authoritative
    // FoodBits Map + regen state live in its heap and are untouched. Same values at the same ids -> G1/G2 hold.
    rebindFoodGrow(foodF64, maxFood, foodGrid) {
        this._foodF64 = foodF64;
        this._foodGrid = foodGrid;
        this._maxFood = maxFood; // worker-0 SoA capacity (undefined/unused on other workers -> harmless)
        this._perceiver.rebindFoodGrow(foodF64, maxFood, foodGrid);
    }

    // The next id worker 0 will mint (== all ids ever minted so far). Published by worker 0 to CTL_NEXTID each
    // tick so main can grow the SABs BEFORE this reaches _maxBots (which would clamp minting and diverge from
    // world.js). Grow-on-near-full; keeps slot==id (ids still never reused).
    getNextId() { return this._nextId; }

    // Construct one real Swimbot (founder or newborn). Same ctx wiring as world.js#_makeSwimbot: a per-id
    // SWIMBOT_LIFE stream + the shared pairwise matePref.
    _makeBot(id, age, x, y, angle, energy, genes) {
        const g = new Genotype(); g.setGenes(genes);
        const sb = new Swimbot({ life: makeStream(this._masterSeed, DOMAIN.SWIMBOT_LIFE, id), matePref: this._matePref, config: this._config, embryology: this._embryology });
        sb.create(id, age, { x, y }, angle, energy, g);
        return sb;
    }

    // Junk-DNA similarity between two genomes in the shared SoA -- bit-identical to world.js#_getJunkDnaSimilarity
    // (same accumulation order over genes [NUM_GENES_USED, NUM_GENES), /BYTE_SIZE per gene, /num at the end).
    _junkDnaSimilarity(idA, idB) {
        const g = this._genomeU8;
        const baseA = idA * NUM_GENES, baseB = idB * NUM_GENES;
        let diff = 0, num = 0;
        for (let k = NUM_GENES_USED; k < NUM_GENES; k++) {
            diff += Math.abs(g[baseA + k] - g[baseB + k]) / BYTE_SIZE;
            num++;
        }
        return ONE - (diff / num);
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
            if (this._obstacleField.getCollision(sb.getPosition(), sb.getBoundingRadius() * ONE_HALF)) {
                this._collisionForce.set(this._obstacleField.getCurrentCollisionForce());
                this._collisionForce.scale(1.2);
                sb.addForce(this._collisionForce);
            }
        }
    }

    // --- COOP MODE phases (worker.mjs orchestrates these with barriers between them) ---

    // Phase 1: apply last tick's resolution results to my bots (energy SET, count deltas, timer/eat/mate clears),
    // clear the per-bot result slots, construct my newborns, and SWEEP dead bots so per-tick work stays O(living)
    // (else every corpse is re-iterated forever -> tick rate decays with run length).
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
        // Construct the newborns worker 0 minted last tick that are assigned to ME (round-robin newId % W). Genes
        // come from the shared genome SoA at newId. They first act + are first perceived THIS tick (T+1) -- exactly
        // world.js's T+1 birth semantics (_applyPendingBirths adds after the tick; newborn acts next tick).
        const count = res.newbornCount[0];
        if (count > 0) {
            const rec = res.newbornRec, genome = res.genome, W = this._W;
            for (let k = 0; k < count; k++) {
                const o = k * NB_STRIDE;
                const newId = rec[o + NB_ID];
                if (newId % W !== this._w) continue;
                this._bots.push(this._makeBot(newId, 0, rec[o + NB_X], rec[o + NB_Y], rec[o + NB_ANGLE], rec[o + NB_ENERGY],
                    genome.subarray(newId * NUM_GENES, newId * NUM_GENES + NUM_GENES)));
            }
        }
        // SWEEP (in-place, no alloc): drop a dead bot ONLY after its ghost (alive=0) has been published to the
        // frozen SoA -- i.e. keep it while alive OR while its frozen slot still reads alive=1 (died this tick, not
        // yet ghost-written). This reproduces world.js's one-tick ghost (a pursuer reads the dead mate's frozen
        // slot for one tick) and is bit-identity-safe: swept bots are inert (filtered from grid/perception/resolve
        // everywhere), so removing them changes no living-bot result -- it only bounds work to O(living).
        const f64 = this._f64, bots = this._bots;
        let keep = 0;
        for (let i = 0; i < bots.length; i++) {
            const sb = bots[i];
            if (sb.getAlive() || f64[sb.getIndex() * STRIDE + F_ALIVE] === 1) bots[keep++] = sb;
        }
        bots.length = keep;
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
                if (this._obstacleField.getCollision(sb.getPosition(), sb.getBoundingRadius() * ONE_HALF)) {
                    this._collisionForce.set(this._obstacleField.getCurrentCollisionForce());
                    this._collisionForce.scale(1.2);
                    sb.addForce(this._collisionForce);
                }
            }
            if (pu) { const gp = sb.getGenitalPosition(); writePostUpdate(pu, id, sb.getAlive(), sb.getEnergy(), gp.x, gp.y); }
            if (this._renderF32) { // display state for the viewer (current post-update position/angle/energy)
                const r = this._renderF32, ro = id * R_STRIDE, pos = sb.getPosition();
                r[ro + R_X] = pos.x; r[ro + R_Y] = pos.y; r[ro + R_ANGLE] = sb.getAngle();
                r[ro + R_ENERGY] = sb.getEnergy(); r[ro + R_HUE] = hueOfGenes(sb.getGenotype().getGenes());
                r[ro + R_ALIVE] = sb.getAlive() ? 1 : 0;
            }
            // STAGE this tick's intents (this-tick's chosenFood/chosenMate, set by perceive). -1 if not / dead.
            if (wantsEat) {
                const live = sb.getAlive();
                wantsEat[id] = (live && sb.getIsTryingToEat()) ? sb.getChosenFoodBitIndex() : -1;
                wantsMate[id] = (live && sb.getIsTryingToMate()) ? sb.getChosenMateIndex() : -1;
            }
        }
    }

    // Phase 6 (worker 0 ONLY): serial cross-worker resolution over the GLOBAL id set in ascending order (owner-
    // agnostic), mirroring world.js's snapshot tick: EATS first (_resolveStagedEats), then BIRTHS
    // (_resolveStagedBirths). Produces per-bot resolved energy + count deltas + flags + a newborn list the owners
    // apply/construct next tick.
    resolve(tick) {
        const res = this._res;
        if (!res) return;
        const numBotIds = this._nextId; // all ids ever minted (founders + births so far) -- grows with the pool
        const { wantsEat, wantsMate, resolvedEnergy, numFoodEatenDelta, numOffspringDelta, flags } = res;
        const pu = this._puF64, food = this._foodF64, frozen = this._f64, genome = this._genomeU8;

        // --- EATS: ascending id, lowest-id-per-food wins via the food-alive guard (eatChosenFoodBit semantics) ---
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
            this._foodBits.get(foodId).kill(); // keep worker 0's authoritative FoodBit in sync (for regen parent picks)
        }

        // --- BIRTHS: ascending PARENT id (_resolveStagedBirths / _handleBirth) with working energy + trying arrays.
        const workE = this._workEnergy, workT = this._workTrying;
        let living = 0; // post-update living swimbots -> the carrying-capacity gate (world.js _livingSwimbotCount)
        for (let id = 0; id < numBotIds; id++) {
            // start from post-EAT energy (eaters have FLAG_ENERGY_SET/resolvedEnergy; others from post-update)
            workE[id] = (flags[id] & FLAG_ENERGY_SET) ? resolvedEnergy[id] : pu[id * PU_STRIDE + PU_ENERGY];
            const alive = pu[id * PU_STRIDE + PU_ALIVE] === 1;
            if (alive) living++;
            workT[id] = (wantsMate[id] >= 0 && alive) ? 1 : 0; // parent must be post-update alive
        }
        res.newbornCount[0] = 0; // reset the per-tick newborn list (owners read last tick's before this reset)
        const rec = res.newbornRec;
        let born = 0; // newborns staged this tick (world.js's pendingBirths.length in the cap check)
        for (let pid = 0; pid < numBotIds; pid++) {
            if (!workT[pid]) continue; // not trying, or consumed as a mate (its trying was cleared below)
            if (living + born >= this._maxPopulation) continue; // JJ MAX_SWIMBOTS carrying capacity (opt-in)
            if (this._nextId >= this._maxBots) break; // capacity ceiling (never-reused-id overflow stopgap)
            const mateId = wantsMate[pid];
            if (frozen[mateId * STRIDE + F_ALIVE] !== 1) continue; // mate must be alive at TICK START (world.js snapshot gate)
            if (this._junkDnaSimilarity(pid, mateId) <= this._reproductiveIsolation) continue; // speciation gate (§11: per-pool config)
            const newBornId = this._nextId++;
            const genomeStream = makeStream(this._masterSeed, DOMAIN.OFFSPRING_GENOME, newBornId);
            const genomeRng = () => genomeStream.next();
            this._myGeno.setGenes(genome.subarray(pid * NUM_GENES, pid * NUM_GENES + NUM_GENES));   // canonicalize copies
            this._mateGeno.setGenes(genome.subarray(mateId * NUM_GENES, mateId * NUM_GENES + NUM_GENES));
            this._childGeno.setAsOffspring(this._myGeno, this._mateGeno, genomeRng, { crossoverRate: this._crossoverRate, mutationRate: this._mutationRate });
            genome.set(this._childGeno.getGenes(), newBornId * NUM_GENES); // publish child genome for its owner
            // contributeToOffspring (parent then mate) on the WORKING energy -> sequential, order-correct.
            const myContribution = workE[pid] * this._childEnergyRatio; workE[pid] -= myContribution;
            const mateContribution = workE[mateId] * this._childEnergyRatio; workE[mateId] -= mateContribution;
            const energyToOffspring = myContribution + mateContribution;
            resolvedEnergy[pid] = workE[pid]; flags[pid] |= FLAG_ENERGY_SET | FLAG_TIMER_RESET | FLAG_CLEAR_MATE; numOffspringDelta[pid] += 1;
            resolvedEnergy[mateId] = workE[mateId]; flags[mateId] |= FLAG_ENERGY_SET | FLAG_TIMER_RESET | FLAG_CLEAR_MATE; numOffspringDelta[mateId] += 1;
            workT[mateId] = 0; workT[pid] = 0; // contributeToOffspring clears both roles' tryingToMate
            // birthPos: parent POST-UPDATE genital + mate FROZEN (tick-start) genital -- matches _handleBirth (snapshot)
            const pgx = pu[pid * PU_STRIDE + PU_GX], pgy = pu[pid * PU_STRIDE + PU_GY];
            const mgx = frozen[mateId * STRIDE + F_GX], mgy = frozen[mateId * STRIDE + F_GY];
            const bx = pgx + (mgx - pgx) * ONE_HALF, by = pgy + (mgy - pgy) * ONE_HALF;
            const initialAngle = -180.0 + genomeRng() * 360.0; // same stream, AFTER the genome (world.js order)
            const no = (res.newbornCount[0]++) * NB_STRIDE;
            rec[no + NB_ID] = newBornId; rec[no + NB_X] = bx; rec[no + NB_Y] = by;
            rec[no + NB_ANGLE] = initialAngle; rec[no + NB_ENERGY] = energyToOffspring;
            born++; // count toward the carrying-capacity gate
        }

        // --- FOOD REGEN (world.js _updateFood, 1-type) on the authoritative FoodBits + POOL_FOOD_REGEN stream ---
        if (tick % this._config.foodRegenerationPeriod === 0) this._regenFood();
    }

    // Pick a random living food of a type (world.js _findRandomLivingFoodOfType): candidates sorted by id, one
    // POOL_FOOD_REGEN draw. Sorted -> the pick is independent of Map iteration order.
    _findRandomLivingFoodOfType(foodType) {
        const candidates = [];
        for (const f of this._foodBits.values()) if (f.getAlive() && f.getType() === foodType) candidates.push(f);
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.getIndex() - b.getIndex());
        return candidates[Math.floor(this._foodRegenRng() * candidates.length)];
    }

    // One regen event (1 food type) -- byte-for-byte the world.js _updateFood 1-type path (same draw order:
    // parent pick, spawnFromParent, the up-to-10 obstruction-rejection randomizeSpawnPosition loop), then publish
    // the new food to the SoA and rebuild the food grid so it is perceivable next tick.
    _regenFood() {
        if (this._nextFoodId >= this._maxFood) return; // SoA buffer full (food ids never reused)
        // JJ's food ceiling: if living food is at the cap, spawn nothing + draw no RNG (before the parent pick).
        // Counts getAlive() at regen time (eaten food already killed in the eat loop) -> matches world.js exactly.
        if (this._foodCeiling !== Infinity) {
            let living = 0;
            for (const f of this._foodBits.values()) if (f.getAlive()) living++;
            if (living >= this._foodCeiling) return;
        }
        const parent = this._findRandomLivingFoodOfType(0);
        if (!parent) return;
        const childId = this._nextFoodId++;
        const child = new FoodBit();
        child.setMaxSpawnRadius(this._config.foodSpread);
        child.setPoolBounds(this._config.pool);
        child.spawnFromParent(parent, childId, 0, this._foodRegenRng);
        let looking = true, num = 0;
        while (looking) {
            child.randomizeSpawnPosition(parent, this._foodRegenRng);
            if (!this._obstacleField.getObstruction(parent.getPosition(), child.getPosition())) looking = false;
            num++;
            if (num > 10) looking = false;
        }
        this._foodBits.set(childId, child);
        const cp = child.getPosition();
        writeFood(this._foodF64, childId, { x: cp.x, y: cp.y, type: 0, alive: true, energy: child.getEnergy() });
        buildFoodGridOnce(this._foodGrid, this._foodF64, this._nextFoodId); // re-index (new food perceivable next tick)
    }

    // Canonical fingerprint of this partition's LIVING bots' full state -- comparable field-for-field to
    // world.js dumpSwimbots (id, pos, angle, energy, age, numOffspring, numFoodBitsEaten, brainState), so the
    // parallel run can be checked BIT-IDENTICAL to the single-thread engine. Dead bots are excluded (world.js
    // sweeps them; the parallel leaves them inert -> both fingerprint living only).
    fingerprint() {
        const out = [];
        for (const sb of this._bots) {
            if (!sb.getAlive()) continue;
            const p = sb.getPosition();
            out.push(`${sb.getIndex()}:${p.x},${p.y},${sb.getAngle()},${sb.getEnergy()},${sb.getAge()},${sb.getNumOffspring()},${sb.getNumFoodBitsEaten()},${sb.getBrainState()}`);
        }
        return out;
    }
}
