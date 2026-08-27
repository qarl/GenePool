'use strict';
// Regenerates the E2 genetics-fidelity oracle fixture from JJ's CURRENT simulation/ code.
//   node test/tools/gen-e2-oracle.js
//
// The fixture is the FROZEN old-vs-new baseline (PLAN-restructure.md §12/§17): given the same parents,
// rates, and explicit draw sequence, the fresh engine's crossover+mutation must produce the identical
// child. Regenerate ONLY deliberately (never to paper over an engine divergence) -- it's a change to the
// science baseline and needs its own review.

const fs = require('fs');
const path = require('path');
const { buildAll } = require('../oracles/e2-corpus');

const OUT = path.resolve(__dirname, '..', 'fixtures', 'oracles', 'e2-genetics.json');

const fixture = {
    _comment: 'E2 genetics oracle: parents + rates + explicit draw sequence -> child bytes, frozen from ' +
        'JJ simulation/ code. PRNG-agnostic (records the consumed draw values, not a seed). The engine ' +
        'crossover+mutation must reproduce every child. Regenerate deliberately: node test/tools/gen-e2-oracle.js',
    node: process.version,
    entries: buildAll(),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
const totalMut = fixture.entries.reduce((s, e) => s + e.numMutations, 0);
console.log(`wrote ${fixture.entries.length} entries (${totalMut} total mutations) -> ${path.relative(process.cwd(), OUT)} (node ${fixture.node})`);
for (const e of fixture.entries) console.log(`  ${e.name}: ${e.draws.length} draws, ${e.numMutations} mutations`);
