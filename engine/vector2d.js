// Vector2D — forked from JJ's Vector2D.js as an ES module (PLAN-restructure.md §15).
//
// Geometry methods are field-for-field faithful to the original arithmetic (the swimbot physics is
// bit-exact against JJ, so operator order and the normalize() degenerate-case matter). The rng-driven
// placement helpers (setToRandomLocationInDisk) take an INJECTED rng, never a global (§3), and are
// added with the construction path; the line-segment helpers are added with walls/obstacles.

export class Vector2D {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }
    set(p) { this.x = p.x; this.y = p.y; }
    copyFrom(v) { this.x = v.x; this.y = v.y; } // identical to set(); both exist in the original
    setXY(x, y) { this.x = x; this.y = y; }
    addXY(x, y) { this.x += x; this.y += y; }
    clear() { this.x = 0.0; this.y = 0.0; }
    copy() { return new Vector2D(this.x, this.y); }

    add(v) { this.x += v.x; this.y += v.y; }
    subtract(v) { this.x -= v.x; this.y -= v.y; }
    scale(s) { this.x *= s; this.y *= s; }
    addScaled(v, scale) { this.x += v.x * scale; this.y += v.y * scale; }
    subtractScaled(v, scale) { this.x -= v.x * scale; this.y -= v.y * scale; }

    setToDifference(v1, v2) { this.x = v1.x - v2.x; this.y = v1.y - v2.y; }

    normalize() {
        const m = Math.sqrt(this.x * this.x + this.y * this.y);
        if (m > 0) {
            this.x /= m;
            this.y /= m;
        } else {
            this.x = 1.0;
            this.y = 0.0;
        }
    }

    getMagnitude() { return Math.sqrt(this.x * this.x + this.y * this.y); }
    getMagnitudeSquared() { return this.x * this.x + this.y * this.y; }
    dotWith(v) { return this.x * v.x + this.y * v.y; }

    getDistanceSquaredTo(position) {
        const xx = this.x - position.x;
        const yy = this.y - position.y;
        return xx * xx + yy * yy;
    }

    getDistanceTo(position) {
        const xx = this.x - position.x;
        const yy = this.y - position.y;
        return Math.sqrt(xx * xx + yy * yy);
    }

    setToPerpendicular() {
        const px = this.y;
        const py = -this.x;
        this.x = px;
        this.y = py;
    }
}
