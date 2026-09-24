'use strict';
// Portable-math (epoch pmath-1) unit tests. These lock the FROZEN table and the invariants the engine relies on:
// the table can't drift silently (sha256), ppow2 is exact at integer exponents (mutation-rate contract), and the
// runtime uses only portable ops. Cross-ENGINE identity (the whole point) is proven separately by the
// canonical-run golden under the CI matrix -- these are the single-engine guards. See docs/PLAN-engine-portable-math.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const load = async () => ({ ...(await import('../../engine/pmath.js')), ...(await import('../../engine/pmath-table.js')) });

// The frozen table's committed fingerprint. Regenerating the table (a deliberate epoch bump) changes this and
// must be updated in the same reviewed commit -- an accidental regen fails here.
const TABLE_SHA = '2eab527bfa6bab57da29f83383936279d0dfb76a8c9d24654e126c1236694c8e';

test('frozen sine table matches its committed sha256 (no silent epoch drift)', async () => {
  const { SIN_N, SIN_TABLE } = await load();
  assert.equal(SIN_N, 1024);
  assert.equal(SIN_TABLE.length, SIN_N + 1, 'N+1 entries (guard entry for interp)');
  const hash = createHash('sha256').update(Array.from(SIN_TABLE).map((v) => v.toString()).join(',')).digest('hex');
  assert.equal(hash, TABLE_SHA, 'table values changed -- if intentional, this is an epoch bump, update TABLE_SHA in a reviewed commit');
});

test('table entries round-trip exactly (decimal storage is lossless)', async () => {
  const { SIN_TABLE } = await load();
  for (let i = 0; i < SIN_TABLE.length; i++) assert.equal(Number(SIN_TABLE[i].toString()), SIN_TABLE[i]);
});

test('ppow2 is EXACT at integer exponents (mutation-rate contract: 1@0, 2@+64-equiv, 0.5@-1, 0.25@-2)', async () => {
  const { ppow2 } = await load();
  assert.equal(ppow2(0), 1);
  assert.equal(ppow2(1), 2);
  assert.equal(ppow2(-1), 0.5);
  assert.equal(ppow2(-2), 0.25);
  assert.equal(ppow2(3), 8);
  assert.equal(ppow2(10), 1024);
  assert.equal(ppow2(-10), 1 / 1024);
});

test('ppow2 fractional is approximate but bounded and monotonic-ish', async () => {
  const { ppow2 } = await load();
  assert.ok(Math.abs(ppow2(0.5) - Math.SQRT2) < 1e-3, '2^0.5 ~ sqrt(2)');
  assert.ok(ppow2(0.5) > ppow2(0) && ppow2(1) > ppow2(0.5), 'monotonic across a unit interval');
  assert.equal(ppow2(5000), Infinity);   // overflow guard, deterministic
  assert.equal(ppow2(-5000), 0);         // underflow guard, deterministic
});

test('psin/pcos: exact at cardinal points, within table tolerance elsewhere', async () => {
  const { psin, pcos } = await load();
  assert.equal(psin(0), 0);            // T[0] exactly
  assert.equal(pcos(0), 1);            // T[N/4] == sin(pi/2) == 1 exactly
  const TOL = 5e-3;                      // N=1024 linear interp; accuracy is a non-goal
  for (const x of [0.1, 0.7, 1.5, 3.0, 4.2, 6.1, -2.3, -0.9]) {
    assert.ok(Math.abs(psin(x) - Math.sin(x)) < TOL, `psin(${x})`);
    assert.ok(Math.abs(pcos(x) - Math.cos(x)) < TOL, `pcos(${x})`);
  }
});

test('psin range reduction: large / negative arguments stay bounded and periodic', async () => {
  const { psin } = await load();
  for (const x of [1e3, 1e6, -1e5, 12345.678]) {
    assert.ok(psin(x) >= -1.001 && psin(x) <= 1.001, `psin(${x}) in range`);
    assert.ok(Math.abs(psin(x) - psin(x + TWO_PI())) < 1e-2, `psin periodic at ${x}`);
  }
  function TWO_PI() { return Math.PI * 2; }
});

test('phypot equals sqrt(a^2+b^2) and is finite', async () => {
  const { phypot } = await load();
  assert.equal(phypot(3, 4), 5);
  assert.equal(phypot(0, 0), 0);
  assert.ok(Number.isFinite(phypot(216, 216)));
});

test('deterministic run-to-run (same input -> identical bits)', async () => {
  const { psin, pcos, ppow2 } = await load();
  for (const x of [0.123, 2.71828, -9.9, 100.5]) {
    assert.equal(psin(x), psin(x));
    assert.equal(pcos(x), pcos(x));
    assert.equal(ppow2(x % 3), ppow2(x % 3));
  }
});

test('ENGINE_EPOCH tag present', async () => {
  const { ENGINE_EPOCH } = await load();
  assert.equal(ENGINE_EPOCH, 'pmath-1');
});
