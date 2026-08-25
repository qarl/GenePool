'use strict';
// Every SimulationStartMode must boot into a structurally valid pool, and (with one documented
// exception) stay valid over a short run. The default smoke test only covers RANDOM; this widens the
// net to all presets so a mode that boots or steps into a corrupt state can't slip in unnoticed, and
// it guards H-d directly (SPECIES fills to the full 2000 food). Uses checkInvariants (finite x/y/angle/
// energy/age, genes in range, unique ids, slot identity, no self-parent lineage). NB: the food-count
// invariant is tautologically balanced, so stray-food per preset (H-c) is guarded by its own
// dedicated test (test/bugs/hc-stray-food-presets.test.js), not here.
//
// SPECIES exception: with H-d filling SPECIES to the full 2000 food and each bit given a RANDOM type
// (0/1), one type lands slightly over MAX_FOODBITS_PER_TYPE (1000) -- see the {todo} pin below. During
// updateFood that trips JJ's per-type-cap assert; in the browser asserts only alert-and-continue (the
// S1 systemic issue) and regeneration rebalances, but our harness makes alert fatal. So SPECIES is
// boot-checked here and its stepping is covered once the per-type imbalance is fixed (the {todo}).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSim, boot, step } = require('../helpers/boot');
const { checkInvariants } = require('../helpers/invariants');

const GP = loadSim();
const SM = GP.SimulationStartMode;
const MAX_PER_TYPE = 1000; // Parameters.js MAX_FOODBITS_PER_TYPE

// FILE loads a pool from disk via the browser file UI; there's no file headless, so it's excluded.
const ALL = Object.entries(SM).filter(([name]) => name !== 'FILE');

for (const [name, mode] of ALL) {
    test(`start mode ${name}: boots into a structurally valid pool`, () => {
        const gp = boot(42, mode);
        checkInvariants(gp, GP);
        const pop = gp.getNumSwimbots();
        const food = gp.getPoolData().foodBitArray.length;
        assert.ok(pop >= 0 && pop <= GP.MAX_SWIMBOTS, `${name}: population ${pop} out of range`);
        assert.ok(food >= 0 && food <= GP.MAX_FOODBITS, `${name}: food ${food} out of range`);
    });
}

// Stepping: all modes except SPECIES (see header + {todo} pin).
for (const [name, mode] of ALL.filter(([n]) => n !== 'SPECIES')) {
    test(`start mode ${name}: stays valid over 100 ticks`, () => {
        const gp = boot(42, mode);
        for (let t = 0; t < 100; t++) {
            step(gp, 1);
            checkInvariants(gp, GP);
        }
    });
}

test('start modes: EMPTY has no swimbots; RANDOM/SPECIES are populated with full food', () => {
    assert.equal(boot(42, SM.EMPTY).getNumSwimbots(), 0, 'EMPTY should have no swimbots');
    assert.ok(boot(42, SM.RANDOM).getNumSwimbots() > 0, 'RANDOM should be populated');

    const species = boot(42, SM.SPECIES);
    assert.ok(species.getNumSwimbots() > 0, 'SPECIES should be populated');
    // H-d regression guard: SPECIES food fills to the full 2000, not the old ~1000 half-dead.
    assert.equal(species.getPoolData().foodBitArray.length, 2000, 'SPECIES should have 2000 food bits');
});

// KNOWN BUG (pinned): SPECIES assigns each of its 2000 food bits a random type, so one type lands
// ~1000+-22 -- over MAX_FOODBITS_PER_TYPE (1000). The regen loop caps at 1000 thereafter, so this is
// purely an initialization imbalance (setFoodToSpeciesConfiguration should assign types so neither
// exceeds the cap). getNumFoodBits() is the type-0 count and getNumFoodBits1() the type-1 count when
// numFoodTypes==2. Remove {todo} in the commit that balances the SPECIES food-type assignment.
test('SPECIES: neither food type exceeds MAX_FOODBITS_PER_TYPE at boot', { todo: true }, () => {
    const gp = boot(42, SM.SPECIES);
    const type0 = gp.getNumFoodBits();
    const type1 = gp.getNumFoodBits1();
    assert.ok(type0 <= MAX_PER_TYPE, `type-0 food ${type0} exceeds ${MAX_PER_TYPE}`);
    assert.ok(type1 <= MAX_PER_TYPE, `type-1 food ${type1} exceeds ${MAX_PER_TYPE}`);
});
