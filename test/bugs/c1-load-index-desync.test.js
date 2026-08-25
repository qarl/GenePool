'use strict';
// Bug C1 (docs/BUGS-original-genepool.md): getPoolData() packs living swimbots but records
// each one's ORIGINAL slot as .id; setPoolData() then places the swimbot at slot `id` while
// passing the compact loop counter `s` as its internal index. So after loading any pool with
// dead-slot GAPS, getSwimbotIndex(id) !== id — which corrupts mate resolution (mates are
// looked up by that index) and death-time attribution in the family tree.
//
// Subtlety: a naturally-saved pool is often near-contiguous (the sim backfills the lowest dead
// slot on every birth), so it may not reliably reproduce C1 from run to run. We deliberately
// build a GAPPED pool — keeping only the odd-id swimbots of a real snapshot, so the saved ids
// are non-contiguous — making the reproduction deterministic regardless of run timing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, step } = require('../helpers/boot');

test('C1: loading a gapped pool preserves slot/index identity', () => {
    // 1. a real, fully-formed snapshot (carries every field setPoolData needs), detached.
    const src = boot(42);
    step(src, 1500);
    const pd = JSON.parse(JSON.stringify(src.getPoolData()));

    // 2. make it GAPPED: keep only odd-id swimbots -> saved ids skip -> non-contiguous.
    const kept = pd.swimbotArray.filter((s) => s.id % 2 === 1);
    assert.ok(kept.length > 0, 'need a non-empty living population to build the fixture');
    const maxId = kept.reduce((m, s) => Math.max(m, s.id), 0);
    assert.ok(maxId > kept.length - 1, 'fixture must actually be gapped (max id > count-1)');
    const gapped = { ...pd, swimbotArray: kept, numSwimbots: kept.length };

    // 3. load into a fresh pool; every alive slot's internal index must equal its slot.
    const gp = boot(42);
    gp.setPoolData(gapped);
    for (const s of gapped.swimbotArray) {
        assert.equal(gp.getSwimbotIndex(s.id), s.id, `slot ${s.id}: getSwimbotIndex(${s.id}) != ${s.id}`);
    }
});
