'use strict';
// D2: the shared species/plate/lifespan analyzer (engine/analysis/species.mjs) -- the compute the generator runs at a
// fixed cadence to fill each `stats` row, and (after the viewer rewire) the same compute the viewer runs live. Proves
// it is deterministic, produces a coherent panel, folds age-at-death (D9), and yields a JSON-serializable stats row.

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('species analyzer: deterministic, coherent panel, event-driven lifespan, serializable stats row', async () => {
    const { createSpeciesAnalyzer, signatureOf, PCA_MEAN } = await import('../../engine/analysis/species.mjs');
    const { buildWorld } = await import('../../tools/scrub/run-gen.mjs');

    // sanity: the mean evolved genome projects to the neutral signature (basis coherent / spliced correctly)
    assert.equal(signatureOf(PCA_MEAN), '00000', 'mean genome -> 00000');

    const A = createSpeciesAnalyzer(), B = createSpeciesAnalyzer();
    const { world } = buildWorld(7, { n: 600, pool: 8000 });
    let deaths = 0;
    world._onEvent = (e) => {
        if (e.type === 'death') { deaths++; const sb = world._swimbots.get(e.id); A.foldDeath(sb, e.age); B.foldDeath(sb, e.age); }
    };
    const CADENCE = 100, TICKS = 1200;
    for (let t = 1; t <= TICKS; t++) {
        world.tick();
        if (t % CADENCE === 0) { A.recompute(world._swimbots.values()); B.recompute(world._swimbots.values()); }
    }

    const sa = A.statsRow(), sb = B.statsRow();
    // determinism: two analyzers fed the identical tick sequence must agree exactly (the fixed-cadence contract)
    assert.deepEqual(sa, sb, 'two analyzers on the same sequence diverged');

    // coherent panel
    assert.match(sa.popSig, /^[0-9A-Z]{5}$/, 'popSig is 5 base36 symbols');
    assert.ok(sa.popDivEMA > 0, 'population diversity computed');
    assert.ok(sa.lineages.length > 0, 'at least one tracked lineage');
    for (const l of sa.lineages) {
        assert.ok(Number.isInteger(l.id) && l.id > 0, 'lineage has a stable positive id');
        assert.match(l.sig, /^[0-9A-Z]{5}$/, 'lineage sig is 5 symbols');
        assert.ok(l.count > 0, 'lineage has members');
        assert.ok(l.divEMA >= 0, 'lineage diversity >= 0');
    }
    assert.ok(sa.lineages.every((l, i) => i === 0 || l.count <= sa.lineages[i - 1].count), 'lineages sorted by count desc');

    // event-driven lifespan (D9): if any deaths occurred, popLifeEMA is a sane age
    assert.ok(sa.popLifeEMA === null || sa.popLifeEMA >= 0, 'popLifeEMA null or non-negative');
    if (deaths > 0) assert.ok(sa.popLifeEMA > 0, `deaths occurred (${deaths}) so popLifeEMA should be set`);

    // the stats row is JSON-serializable (it goes into stats(tick, json))
    assert.deepEqual(JSON.parse(JSON.stringify(sa)), sa, 'stats row must round-trip through JSON');
});
