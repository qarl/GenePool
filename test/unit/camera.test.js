'use strict';
// Latent NaN guard + unit coverage for Camera (GenePool/simulation/Camera.js).
// setAspectRatio(a) stored `a` unguarded. GenePool computes it as _canvasWidth / _canvasHeight
// (GenePool.js:244), so a zero-height canvas yields Infinity (or 0/0 = NaN), which then poisons the
// camera frame (_right/_left = pos +/- scale*0.5*aspect) and getXDimension() with Infinity/NaN, and a
// bad camera position can persist. Fix: ignore a non-finite / non-positive aspect ratio.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim } = require('../helpers/boot');

const GP = loadSim();

test('Camera: a non-finite aspect ratio (zero-height canvas) does not poison the camera', () => {
    const c = new GP.Camera();
    c.setAspectRatio(Infinity); // = width / 0
    assert.ok(Number.isFinite(c.getXDimension()), `getXDimension must stay finite, got ${c.getXDimension()}`);
    assert.ok(Number.isFinite(c.getPosition().x) && Number.isFinite(c.getPosition().y),
        'camera position must stay finite');

    c.setAspectRatio(NaN); // = 0 / 0
    assert.ok(Number.isFinite(c.getXDimension()),
        `getXDimension must stay finite after a NaN aspect, got ${c.getXDimension()}`);
});

test('Camera: a valid aspect ratio is still applied', () => {
    const c = new GP.Camera();
    c.setAspectRatio(1.5);
    assert.equal(c.getXDimension(), c.getScale() * 1.5);
});
