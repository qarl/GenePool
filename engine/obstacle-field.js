// ObstacleField (§8) — the pool's physical environment: a LIST of Obstacles (each a masked line segment). The
// engine imposes NO obstacle; the field is built from per-pool config, and an EMPTY field is legal. Movement
// collision ACCUMULATES the force of every movement-masked obstacle a body touches; vision/access is obstructed if
// ANY vision-masked obstacle blocks the segment. With a single obstacle both reduce exactly to the old
// single-Obstacle path, so a default (one-obstacle) world stays bit-identical (goldens + parallel G1 unchanged).

import { Vector2D } from './vector2d.js';
import { Obstacle } from './obstacle.js';
import { FLAT } from './topology.js';
import { resolvePoolBounds } from './constants.js';

export class ObstacleField {
    constructor() {
        this._obstacles = [];
        this._pool = resolvePoolBounds(undefined);
        this._topology = FLAT;
        this._collisionForce = new Vector2D();
    }

    setPoolBounds(pool) { this._pool = resolvePoolBounds(pool); for (const o of this._obstacles) o.setPoolBounds(pool); }
    setTopology(topology) { this._topology = topology; for (const o of this._obstacles) o.setTopology(topology); }

    // Build the field from a config list: [{ a:{x,y}, b:{x,y}, thickness?, mask? }]. Empty/absent -> no obstacles.
    // Pool bounds + topology are applied to each obstacle BEFORE its endpoints so the per-obstacle clamp / torus
    // logic (in _calculateStuff) sees them. Replaces any prior contents.
    setObstacles(list) {
        this._obstacles = [];
        for (const spec of (list || [])) {
            const o = new Obstacle(spec.thickness, spec.mask);
            o.setPoolBounds(this._pool);
            o.setTopology(this._topology);
            o.setEndpointPositions(spec.a, spec.b);
            this._obstacles.push(o);
        }
    }

    get length() { return this._obstacles.length; }
    getObstacles() { return this._obstacles; }

    // Checkpoint (H1): the current obstacle specs, so restore rebuilds an identical field. Endpoints are the
    // post-clamp values (setEndpointPositions re-clamps them idempotently -> exact round-trip).
    toSpecs() {
        return this._obstacles.map(o => {
            const [a, b] = o.getEndpoints();
            return { a, b, thickness: o.getThickness(), mask: { ...o.getMask() } };
        });
    }

    // Movement (§8 accumulate-force loop): sum the collision force of every MOVEMENT-masked obstacle the test
    // position touches, in list order (stable + preserved across toSpecs/setObstacles -> deterministic). Returns
    // true iff any collided; the summed force is in getCurrentCollisionForce(). The FIRST hit COPIES the obstacle's
    // force (rather than starting from (0,0) and adding) so a single-obstacle field is BYTE-identical to the old
    // single-Obstacle path -- including the sign of a zero component, which `0 + (-0) = +0` would otherwise flip.
    getCollision(testPosition, radius) {
        let hit = false;
        for (const o of this._obstacles) {
            if (!o.blocksMovement()) continue;
            if (o.getCollision(testPosition, radius)) {
                const f = o.getCurrentCollisionForce();
                if (!hit) { this._collisionForce.setXY(f.x, f.y); hit = true; } // first hit: exact copy
                else { this._collisionForce.x += f.x; this._collisionForce.y += f.y; } // accumulate
            }
        }
        return hit;
    }

    getCurrentCollisionForce() { return this._collisionForce; }

    // Vision / access: obstructed iff ANY vision-masked obstacle blocks the segment p1 -> p2.
    getObstruction(p1, p2) {
        for (const o of this._obstacles) {
            if (o.blocksVision() && o.getObstruction(p1, p2)) return true;
        }
        return false;
    }
}
