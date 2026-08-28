// Obstacle — forked from JJ's Obstacle.js as an ES module (PLAN-restructure.md §15). A single line
// segment (two endpoints) that blocks swimbot movement (getCollision) and line-of-sight / access
// (getObstruction). RNG-free. The UI-only bits (hover/move/render) are dropped; the sim reads only
// endpoints, collision, and obstruction. Faithful arithmetic (the pool tick is bit-exact against JJ).

import { ZERO, ONE, ONE_HALF, POOL_LEFT, POOL_RIGHT, POOL_TOP, POOL_BOTTOM } from './constants.js';
import { Vector2D } from './vector2d.js';

const END_RADIUS = 20;

export class Obstacle {
    constructor() {
        this._end1 = new Vector2D();      // endpoint positions (the UI ObstacleEndpoint is collapsed to a point)
        this._end2 = new Vector2D();
        this._mid = new Vector2D();
        this._axis = new Vector2D();
        this._direction = new Vector2D();
        this._perp = new Vector2D();
        this._testVector = new Vector2D();
        this._collisionForce = new Vector2D();
        this._length = ZERO;
    }

    setEndpointPositions(e1, e2) {
        this._end1.set(e1);
        this._end2.set(e2);
        this._calculateStuff();
    }

    _calculateStuff() {
        this._axis.x = this._end2.x - this._end1.x;
        this._axis.y = this._end2.y - this._end1.y;

        this._mid.x = this._end1.x + this._axis.x * ONE_HALF;
        this._mid.y = this._end1.y + this._axis.y * ONE_HALF;

        this._length = Math.sqrt(this._axis.x * this._axis.x + this._axis.y * this._axis.y);

        // Guarded normalize: degenerate (coincident) endpoints fall back to a unit direction so the
        // separation block below still pushes them apart cleanly instead of poisoning _perp with NaN.
        if (this._length > ZERO) {
            this._direction.x = this._axis.x / this._length;
            this._direction.y = this._axis.y / this._length;
        } else {
            this._direction.x = ONE;
            this._direction.y = ZERO;
        }

        this._perp.x = this._direction.y;
        this._perp.y = -this._direction.x;

        // handle endpoints bumping into each other (shift AFTER mid/length/perp are computed, matching JJ)
        const minLength = END_RADIUS * 2;
        if (this._length < minLength) {
            const penetration = ONE - (this._length / minLength);
            const xShift = END_RADIUS * this._direction.x * penetration;
            const yShift = END_RADIUS * this._direction.y * penetration;
            this._end1.x -= xShift;
            this._end1.y -= yShift;
            this._end2.x += xShift;
            this._end2.y += yShift;
        }

        // clamp endpoints to the pool walls (again, without recomputing mid/length -- faithful to JJ)
        const left = POOL_LEFT + END_RADIUS;
        const right = POOL_RIGHT - END_RADIUS;
        const bottom = POOL_BOTTOM - END_RADIUS;
        const top = POOL_TOP + END_RADIUS;

        if (this._end1.x > right) { this._end1.x = right; } else if (this._end1.x < left) { this._end1.x = left; }
        if (this._end1.y > bottom) { this._end1.y = bottom; } else if (this._end1.y < top) { this._end1.y = top; }

        if (this._end2.x > right) { this._end2.x = right; } else if (this._end2.x < left) { this._end2.x = left; }
        if (this._end2.y > bottom) { this._end2.y = bottom; } else if (this._end2.y < top) { this._end2.y = top; }
    }

    getCollision(testPosition, radius) {
        if (radius < END_RADIUS) {
            radius = END_RADIUS;
        }
        const xx = testPosition.x - this._mid.x;
        const yy = testPosition.y - this._mid.y;
        const distanceSquared = xx * xx + yy * yy;
        const ll = this._length * ONE_HALF + END_RADIUS + radius;

        if (distanceSquared < ll * ll) {
            this._testVector.x = testPosition.x - this._end1.x;
            this._testVector.y = testPosition.y - this._end1.y;
            const dot = this._testVector.dotWith(this._perp);
            if (Math.abs(dot) < radius) {
                let penetration = (ONE - (dot / radius));
                if (dot < ZERO) {
                    penetration *= -ONE;
                }
                this._collisionForce.setXY(this._perp.x * penetration, this._perp.y * penetration);
                return true;
            }
        }
        return false;
    }

    getCurrentCollisionForce() { return this._collisionForce; }

    getObstruction(p1, p2) {
        return p1.getSegmentsCrossing(p1, p2, this._end1, this._end2);
    }

    getEnd1Position() { return this._end1; }
    getEnd2Position() { return this._end2; }
}
