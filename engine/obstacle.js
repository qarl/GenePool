// Obstacle — forked from JJ's Obstacle.js as an ES module (PLAN-restructure.md §15). A single line
// segment (two endpoints) that blocks swimbot movement (getCollision) and line-of-sight / access
// (getObstruction). RNG-free. The UI-only bits (hover/move/render) are dropped; the sim reads only
// endpoints, collision, and obstruction. Faithful arithmetic (the pool tick is bit-exact against JJ).

import { ZERO, ONE, ONE_HALF, resolvePoolBounds } from './constants.js';
import { Vector2D } from './vector2d.js';
import { FLAT } from './topology.js';

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
        // Pool bounds for endpoint clamping -- default JJ 8000x8000; World overrides via setPoolBounds (P3).
        this._pool = resolvePoolBounds(undefined);
        // §7 seam (P4d): on a torus, line-of-sight follows the SHORTEST wrapped path. Default FLAT = walls.
        this._topology = FLAT;
        this._losA = { x: 0, y: 0 };   // scratch: canonicalized p1 (wrapped into the base cell)
        this._losB = { x: 0, y: 0 };   // scratch: near-image target
        this._e1s = { x: 0, y: 0 };    // scratch: shifted obstacle image endpoints
        this._e2s = { x: 0, y: 0 };
    }

    setPoolBounds(pool) { this._pool = resolvePoolBounds(pool); }
    setTopology(topology) { this._topology = topology; }

    // Current (post-clamp) endpoints, for checkpointing. Restoring them via setEndpointPositions re-clamps
    // idempotently (they are already in-bounds), so a round-trip is exact.
    getEndpoints() { return [{ x: this._end1.x, y: this._end1.y }, { x: this._end2.x, y: this._end2.y }]; }

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
        const left = this._pool.left + END_RADIUS;
        const right = this._pool.right - END_RADIUS;
        const bottom = this._pool.bottom - END_RADIUS;
        const top = this._pool.top + END_RADIUS;

        if (this._end1.x > right) { this._end1.x = right; } else if (this._end1.x < left) { this._end1.x = left; }
        if (this._end1.y > bottom) { this._end1.y = bottom; } else if (this._end1.y < top) { this._end1.y = top; }

        if (this._end2.x > right) { this._end2.x = right; } else if (this._end2.x < left) { this._end2.x = left; }
        if (this._end2.y > bottom) { this._end2.y = bottom; } else if (this._end2.y < top) { this._end2.y = top; }
    }

    getCollision(testPosition, radius) {
        if (this._length <= ZERO) return false; // empty/degenerate obstacle -> no collision (empty is legal, §8)
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
        if (!this._topology.isToroidal()) {
            return p1.getSegmentsCrossing(p1, p2, this._end1, this._end2);
        }
        // TORUS (P4d): test the SHORTEST wrapped path against the obstacle AND its images toward any seam that
        // short segment crosses. FIRST canonicalize p1 into the base cell -- perception passes RAW body-part
        // positions (genital/mouth) that overhang a seam when a body straddles it (only _position is wrapped),
        // and the image-selection below is valid only when the segment STARTS in the base cell. Wrapping p1
        // shifts the whole segment by a torus period (the obstacle images absorb that); displacement is
        // wrap-invariant, so b then lands within one cell of base and the single-shift-per-axis logic holds.
        const t = this._topology, W = t.getWidth(), H = t.getHeight(), L = t.getLeft(), T = t.getTop();
        const a = this._losA;
        t.wrap(p1.x, p1.y, a); // canonical segment start
        const b = this._losB;
        t.displacement(a.x, a.y, p2.x, p2.y, b);
        b.x += a.x; b.y += a.y; // near-image of p2 relative to canonical a
        if (p1.getSegmentsCrossing(a, b, this._end1, this._end2)) return true;
        const sx = b.x < L ? -W : (b.x > L + W ? W : 0); // seam the short segment exits (0 = none)
        const sy = b.y < T ? -H : (b.y > T + H ? H : 0);
        const e1 = this._e1s, e2 = this._e2s;
        if (sx !== 0) {
            e1.x = this._end1.x + sx; e1.y = this._end1.y; e2.x = this._end2.x + sx; e2.y = this._end2.y;
            if (p1.getSegmentsCrossing(a, b, e1, e2)) return true;
        }
        if (sy !== 0) {
            e1.x = this._end1.x; e1.y = this._end1.y + sy; e2.x = this._end2.x; e2.y = this._end2.y + sy;
            if (p1.getSegmentsCrossing(a, b, e1, e2)) return true;
        }
        if (sx !== 0 && sy !== 0) {
            e1.x = this._end1.x + sx; e1.y = this._end1.y + sy; e2.x = this._end2.x + sx; e2.y = this._end2.y + sy;
            if (p1.getSegmentsCrossing(a, b, e1, e2)) return true;
        }
        return false;
    }

    getEnd1Position() { return this._end1; }
    getEnd2Position() { return this._end2; }
}
