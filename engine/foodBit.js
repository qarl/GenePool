// FoodBit — forked from JJ's FoodBit.js as an ES module (PLAN-restructure.md §15).
//
// A food bit is a position + energy + type + identity. getAlive() is "has a valid index" (JJ's
// convention). update() is RNG-free and render-only (opacity), so the engine omits it -- opacity is not
// simulation state. Placement (randomizeSpawnPosition) takes an INJECTED rng, never a global (§3), and
// draws EXACTLY 6 (rng()*rng() for x, same for y, then a sign draw each; SPAWN_FOOD_RANDOMLY_IN_POOL is
// false). Color is render-only and dropped. Faithful arithmetic (the pool tick is bit-exact against JJ).

import {
    NULL_INDEX, ZERO, ONE, ONE_HALF,
    resolvePoolBounds, DEFAULT_FOOD_BIT_MAX_SPAWN_RADIUS,
} from './constants.js';
import { Vector2D } from './vector2d.js';

export class FoodBit {
    constructor() {
        this._position = new Vector2D();
        this._energy = ZERO;
        this._type = 0;
        this._index = NULL_INDEX;
        this._maxSpawnRadius = DEFAULT_FOOD_BIT_MAX_SPAWN_RADIUS;
        // Pool bounds for spawn clamping -- default JJ 8000x8000; World overrides via setPoolBounds (P3).
        this._pool = resolvePoolBounds(undefined);
    }

    setPosition(p) { this._position.set(p); }
    setEnergy(e) { this._energy = e; }
    setType(n) { this._type = n; }
    setIndex(i) { this._index = i; }
    setMaxSpawnRadius(r) { this._maxSpawnRadius = r; }
    setPoolBounds(pool) { this._pool = resolvePoolBounds(pool); }
    kill() { this._index = NULL_INDEX; }

    getPosition() { return this._position; }
    getEnergy() { return this._energy; }
    getType() { return this._type; }
    getIndex() { return this._index; }
    getMaxSpawnRadius() { return this._maxSpawnRadius; }
    getAlive() { return this._index !== NULL_INDEX; }

    // Spawn this (dead) bit as a child of `parentFoodBit`: inherit energy, take the given index/type,
    // then place it near the parent. rng is injected (consumed by randomizeSpawnPosition).
    spawnFromParent(parentFoodBit, childIndex, childType, rng) {
        this._index = childIndex;
        this._energy = parentFoodBit.getEnergy();
        this._type = childType;
        this._position.set(parentFoodBit.getPosition());
        this.randomizeSpawnPosition(parentFoodBit, rng);
    }

    // Position near the parent within _maxSpawnRadius, reflected off the boundary margin. Draws exactly
    // 6 from rng (xx=rng*rng, yy=rng*rng, sign xx, sign yy), left-to-right -- the frozen order.
    randomizeSpawnPosition(parentFoodBit, rng) {
        this._position.set(parentFoodBit.getPosition());

        let xx = rng() * rng();
        let yy = rng() * rng();

        if (rng() < ONE_HALF) { xx *= -ONE; }
        if (rng() < ONE_HALF) { yy *= -ONE; }

        this._position.x += xx * this._maxSpawnRadius;
        this._position.y += yy * this._maxSpawnRadius;

        const pb = this._pool.top + this._pool.margin;
        const pt = this._pool.bottom - this._pool.margin;
        const pl = this._pool.left + this._pool.margin;
        const pr = this._pool.right - this._pool.margin;

        if (this._position.y < pb) { this._position.y += ((pb - this._position.y) * 2); } else if (this._position.y > pt) { this._position.y += ((pt - this._position.y) * 2); }
        if (this._position.x > pr) { this._position.x += ((pr - this._position.x) * 2); } else if (this._position.x < pl) { this._position.x += ((pl - this._position.x) * 2); }
    }
}
