'use strict';
// L4 -- input-boundary validation. The engine's internal assert()s encode true compute-invariants that hold for any
// VALID input (an audit + a 1000-genome soak confirmed valid genomes/state never trip them). But a caller could hand
// loadSwimbot/loadFood a MALFORMED value that would otherwise surface later as an obscure mid-tick assert abort
// (a negative age -> `_growthScale >= 0.0`) or silently corrupt the sim (NaN propagation). These check that such
// inputs fail FAST at the door with a clear, field-named error -- and that valid inputs are unaffected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../../engine/world.js');

const CONFIG = {
    maximumLifeSpan: 40000, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
    crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: 4000,
    foodBitEnergy: 50, attractionCriterion: 10,
};
const validGenes = () => { const a = new Array(256).fill(0); for (let i = 0; i < 112; i++) a[i] = (i * 7) % 256; return a; };
const goodBot = (over = {}) => ({ age: 1000, x: 1000, y: 1000, angle: 0, energy: 50, genes: validGenes(), ...over });
const goodFood = (over = {}) => ({ x: 1000, y: 1000, type: 0, energy: 50, ...over });

test('loadSwimbot rejects a negative age at the door (was an obscure mid-tick _growthScale assert)', () => {
    const w = new World({ ...CONFIG }, 1);
    assert.throws(() => w.loadSwimbot(0, goodBot({ age: -5000 })), /loadSwimbot\(0\)\.age must be >= 0 \(got -5000\)/);
});

test('loadSwimbot rejects non-finite numeric fields with a field-named error', () => {
    const w = new World({ ...CONFIG }, 1);
    for (const [field, val, re] of [
        ['age', NaN, /age must be a finite number/],
        ['x', NaN, /\.x must be a finite number/],
        ['y', Infinity, /\.y must be a finite number/],
        ['angle', NaN, /\.angle must be a finite number/],
        ['energy', Infinity, /\.energy must be a finite number/],
        ['age', undefined, /age must be a finite number \(got undefined\)/],
    ]) {
        assert.throws(() => w.loadSwimbot(0, goodBot({ [field]: val })), re, `${field}=${String(val)} should be rejected`);
    }
});

test('loadFood rejects non-finite fields and out-of-range type', () => {
    const w = new World({ ...CONFIG }, 1);
    assert.throws(() => w.loadFood(0, goodFood({ x: NaN })), /loadFood\(0\)\.x must be a finite number/);
    assert.throws(() => w.loadFood(0, goodFood({ energy: Infinity })), /\.energy must be a finite number/);
    assert.throws(() => w.loadFood(0, goodFood({ type: 1 })), /type must be an integer in \[0, 1\) \(got 1\)/);   // numFoodTypes=1 -> only type 0
    assert.throws(() => w.loadFood(0, goodFood({ type: -1 })), /type must be an integer/);
    assert.throws(() => w.loadFood(0, goodFood({ type: 0.5 })), /type must be an integer/);
});

test('negative food energy is rejected at the loadFood door (would trip the eat invariant mid-tick)', () => {
    // eatChosenFoodBit asserts food energy >= 0; a negative-energy food only crashes WHEN eaten (a rare, seed-
    // dependent mid-tick abort). loadFood is the real boundary -- regen inherits a parent's energy back to seed food.
    const w = new World({ ...CONFIG }, 1);
    assert.throws(() => w.loadFood(0, goodFood({ energy: -50 })), /energy must be >= 0 \(got -50\).*poison/);
    assert.doesNotThrow(() => w.loadFood(0, goodFood({ energy: 0 }))); // zero-energy food is allowed (just useless)
});

test('config values are validated by resolveWorldConfig (the path World uses, not just makeConfig)', () => {
    // childEnergyRatio > 1 drove a healthy parent to negative energy -> `contributeToOffspring: _energy >= ZERO`
    // mid-tick on every birth (a config-space assert the gene-only soak could not see). And a NaN in a scalar
    // numeric silently corrupts the sim / trips a downstream bound. Both must fail at the config boundary.
    assert.throws(() => new World({ ...CONFIG, childEnergyRatio: 1.5 }, 1), /childEnergyRatio must be a number in \[0,1\] \(got 1.5\)/);
    assert.throws(() => new World({ ...CONFIG, childEnergyRatio: -0.1 }, 1), /childEnergyRatio must be a number in \[0,1\]/);
    assert.throws(() => new World({ ...CONFIG, maximumLifeSpan: NaN }, 1), /maximumLifeSpan must not be NaN/);
    assert.throws(() => new World({ ...CONFIG, crossoverRate: 2 }, 1), /crossoverRate must be in \[0,1\]/);
    assert.throws(() => new World({ ...CONFIG, viewRadius: NaN }, 1), /viewRadius must not be NaN/);
    assert.throws(() => new World({ ...CONFIG, numFoodTypes: 0 }, 1), /numFoodTypes must be an integer >= 1/);
    // Infinity stays LEGAL where it means "no limit" (faithful north-star): immortal lifespan, global view, uncapped.
    assert.doesNotThrow(() => new World({ ...CONFIG, maximumLifeSpan: Infinity, viewRadius: Infinity, maxPopulation: Infinity, maxFood: Infinity }, 1));
    assert.doesNotThrow(() => new World({ ...CONFIG, childEnergyRatio: 0 }, 1));
    assert.doesNotThrow(() => new World({ ...CONFIG, childEnergyRatio: 1 }, 1));
});

test('foodSpread must be a finite spawn radius (Infinity/NaN would yield NaN food positions), incl. schedule steps', () => {
    // foodSpread is a spawn RADIUS, not a "no limit" field: foodBit spawn multiplies by it, so Infinity/NaN -> NaN
    // position -> corrupt grid/hashes. Caught as a scalar AND as any schedule step (rejectNaN-scalar missed steps).
    assert.throws(() => new World({ ...CONFIG, foodSpread: Infinity }, 1), /foodSpread must be a finite number >= 0/);
    assert.throws(() => new World({ ...CONFIG, foodSpread: NaN }, 1), /foodSpread must be a finite number >= 0/);
    assert.throws(() => new World({ ...CONFIG, foodSpread: { schedule: [[0, 1000], [500, Infinity]] } }, 1), /foodSpread must be a finite number >= 0/);
    assert.doesNotThrow(() => new World({ ...CONFIG, foodSpread: { schedule: [[0, 1000], [500, 200]] } }, 1)); // a valid finite schedule still works
    assert.doesNotThrow(() => new World({ ...CONFIG, foodSpread: 0 }, 1)); // 0 = spawn on the parent (clumped), valid
});

test('a non-schedulable field given a §10 schedule object is rejected (would be read raw -> mid-tick NaN)', () => {
    // maximumLifeSpan/viewRadius are read directly, NOT via _sched -- a user assuming they schedule like
    // foodRegenerationPeriod/maxFood would otherwise get a raw object -> NaN math -> a mid-tick assert.
    assert.throws(() => new World({ ...CONFIG, maximumLifeSpan: { schedule: [[0, 50]] } }, 1), /maximumLifeSpan must be a plain number -- it is not schedulable/);
    assert.throws(() => new World({ ...CONFIG, viewRadius: { schedule: [[0, 300]] } }, 1), /viewRadius must be a plain number -- it is not schedulable/);
    // a genuinely schedulable field still accepts a schedule object
    assert.doesNotThrow(() => new World({ ...CONFIG, foodRegenerationPeriod: { schedule: [[0, 20], [1000, 40]] } }, 1));
});

test('valid inputs are unaffected: a normal seed loads and ticks', () => {
    const w = new World({ ...CONFIG }, 1);
    for (let k = 0; k < 5; k++) w.loadSwimbot(k, goodBot({ x: 1000 + k * 30, age: 500 + k * 100 }));
    for (let f = 0; f < 20; f++) w.loadFood(f, goodFood({ x: 900 + f * 10 }));
    assert.doesNotThrow(() => { for (let t = 0; t < 50; t++) w.tick(); });
    assert.ok(w.getLivingSwimbotCount() > 0);
});

test('faithful inputs the engine handles WITHOUT rejecting: age==0, an over-lifespan age, negative energy', () => {
    // These are valid states the engine simulates faithfully (not malformed), so they must NOT be rejected.
    const w = new World({ ...CONFIG }, 1);
    assert.doesNotThrow(() => w.loadSwimbot(0, goodBot({ age: 0 })));
    assert.doesNotThrow(() => w.loadSwimbot(1, goodBot({ age: 999999 })));   // dies of old age, gracefully
    assert.doesNotThrow(() => w.loadSwimbot(2, goodBot({ energy: -10 })));   // starts effectively dead, faithful
    assert.doesNotThrow(() => { for (let t = 0; t < 30; t++) w.tick(); });
});

test('audit: extreme + random VALID genomes never trip an internal compute-invariant assert', () => {
    // Documents the L4 finding -- the internal asserts (mass>0, color<=1, saturation<=1, normalizedGenes in [0,1],
    // part dims>0) are true invariants for any canonicalized genome, so they are KEPT (they catch engine bugs, not
    // user input). A smaller mirror of the 1000-genome scratch soak, kept fast for CI.
    const mk = (fill) => { const a = new Array(256).fill(0); for (let i = 0; i < 112; i++) a[i] = fill(i); return a; };
    const patterns = [() => 255, () => 0, () => 128, (i) => (i % 2 ? 255 : 0)];
    assert.doesNotThrow(() => {
        for (let rep = 0; rep < 12; rep++) {
            for (const pat of patterns) {
                const w = new World({ ...CONFIG }, rep + 1);
                for (let k = 0; k < 6; k++) w.loadSwimbot(k, { age: 1000 + k * 100, x: 1000 + k * 30, y: 1000, angle: k * 40, energy: 60, genes: mk(pat) });
                for (let f = 0; f < 30; f++) w.loadFood(f, { x: 900 + f * 10, y: 1000, type: 0, energy: 50 });
                for (let t = 0; t < 60; t++) w.tick();
            }
        }
    });
});
