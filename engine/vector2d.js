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

    // Does segment a (a0->a1) cross segment b (b0->b1)? A perpendicular-dot straddle test. Ignores
    // `this` (the original is a Vector2D method too, called as p1.getSegmentsCrossing(p1, p2, ...)).
    getSegmentsCrossing(a0, a1, b0, b1) {
        const aX = a1.x - a0.x;
        const aY = a1.y - a0.y;
        const bX = b1.x - b0.x;
        const bY = b1.y - b0.y;

        const aPerpX = -aY;
        const aPerpY = aX;
        const bPerpX = -bY;
        const bPerpY = bX;

        const a0b0x = b0.x - a0.x;
        const a0b0y = b0.y - a0.y;
        const a0b1x = b1.x - a0.x;
        const a0b1y = b1.y - a0.y;
        const b0a0x = a0.x - b0.x;
        const b0a0y = a0.y - b0.y;
        const b0a1x = a1.x - b0.x;
        const b0a1y = a1.y - b0.y;

        const a0Dotb0 = aPerpX * a0b0x + aPerpY * a0b0y;
        const a0Dotb1 = aPerpX * a0b1x + aPerpY * a0b1y;
        const b0Dota0 = bPerpX * b0a0x + bPerpY * b0a0y;
        const b0Dota1 = bPerpX * b0a1x + bPerpY * b0a1y;

        if ((((a0Dotb0 > 0) && (a0Dotb1 < 0)) || ((a0Dotb1 > 0) && (a0Dotb0 < 0)))
            && (((b0Dota0 > 0) && (b0Dota1 < 0)) || ((b0Dota1 > 0) && (b0Dota0 < 0)))) {
            return true;
        }
        return false;
    }
}
