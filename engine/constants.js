// Shared math / genome-format constants for the engine.
//
// Forked from JJ's MathConstants.js + SwimbotTypes.js (values verified identical), consolidated into one
// explicit ES-module source so the reused science files import them instead of relying on a shared global
// scope (PLAN-restructure.md §15). These are the genome FORMAT and math identities -- legitimately
// engine-fixed (PLAN §11), not world-config.

export const ZERO = 0.0;
export const ONE = 1.0;
export const ONE_HALF = 0.5;
export const ONE_THIRD = ONE / 3.0;
export const PI2 = Math.PI * 2.0;
export const NULL_INDEX = -1;

// Genome format
export const BYTE_SIZE = 256;      // a gene is an integer in [0, BYTE_SIZE)
export const NUM_GENES = 256;      // genes per genome
// Single source of truth for the coding/junk boundary (JJ had this dual-sourced: Embryology's dynamic
// count vs a hardcoded NUM_GENES_USED=112 -- PLAN §12). The decode fills exactly this many; genes
// [NUM_GENES_USED, NUM_GENES) are junk DNA (reproductive-isolation markers).
export const NUM_GENES_USED = 112;

// Body/morphology format
export const NULL_PART = -1;
export const ROOT_PART = 0;
export const MIN_PARTS = 2;
export const MAX_PARTS = 16;
export const MOUTH_INDEX = 0;   // part index treated as the mouth (eating proximity)
export const GENITAL_INDEX = 1; // part index treated as the genital (mating proximity)

// Math
export const PI_OVER_180 = Math.PI / 180.0;

// Swimbot life-cycle / physics MECHANISM (faithful to JJ; these are how a swimbot works, PLAN §11 --
// world-scale limits like maximumLifeSpan / pool bounds are config, but these mechanism scalars are
// engine-fixed). Values verified against Parameters.js / SwimbotTypes.js / Brain.js.
export const YOUNG_AGE_DURATION = 1000;              // growth ramp; also the reproduction age gate
export const OLD_AGE_DURATION = 1000;                // slow-down window before maximumLifeSpan
export const STARVING = 4.0;                          // energy below which motion slows
export const STARVING_TIMER_DELTA = 0.05;             // floor on the starving slow-down
export const TIMER_DELTA_INCREASE_RATE = 0.02;        // per-tick ramp of the body-motion timer
export const CONTINUAL_ENERGY_DRAIN = 0.0001;         // baseline metabolic drain per tick
export const ENERGY_USED_UP_SWIMMING = 0.01;          // energy per unit stroke amplitude
export const WALL_BOUNCE = 0.1;                       // wall penetration restitution
export const SWIMBOT_SELECT_RADIUS_SCALAR = 7.0;
export const ENERGY_EFFICIENCY_MEASUREMENT_PERIOD = 200;
export const SWIMBOT_MOUTH_LENGTH = 10.0;             // eat when mouth is within this of chosen food
export const SWIMBOT_GENITAL_LENGTH = 10.0;           // mate when genital is within this of chosen mate
export const FOOD_TYPE_OFFSET = 0.2;                  // energy multiplier when food type != digestible
export const DEFAULT_SWIMBOT_HUNGER_THRESHOLD = 50;   // brain's hunger threshold at create()
export const DEFAULT_MAXIMUM_AGE = 40000;             // GlobalTweakers default (config override)
export const DEFAULT_CHILD_ENERGY_RATIO = 0.5;        // GlobalTweakers default (config override)
export const TOO_UGLY_TO_CHOOSE = 0;                  // attractiveness floor for mate choice

// Brain FSM
export const BRAIN_SENSORY_UPDATE_PERIOD = 50;        // ticks between sensory refreshes
export const BRAIN_MAX_PERCEIVED_NEARBY_SWIMBOTS = 20;
export const BRAIN_FOCUS_TARGET_SHIFT_STRENGTH = 0.1;
export const BRAIN_FOCUS_TARGET_SHIFT_THRESHOLD = 0.07;
export const BRAIN_WANDER_AMOUNT = 0.2;

// Brain states (Brain.js)
export const BRAIN_STATE_NULL = -1;
export const BRAIN_STATE_RESTING = 0;
export const BRAIN_STATE_LOOKING_FOR_MATE = 1;
export const BRAIN_STATE_PURSUING_MATE = 2;
export const BRAIN_STATE_LOOKING_FOR_FOOD = 3;
export const BRAIN_STATE_PURSUING_FOOD = 4;
export const NUM_BRAIN_STATES = 8;

// Default world bounds (JJ's fixed pool; P3 makes these arbitrary via config).
export const POOL_LEFT = 0.0;
export const POOL_RIGHT = 8000.0;
export const POOL_TOP = 0.0;
export const POOL_BOTTOM = 8000.0;
export const POOL_WIDTH = POOL_RIGHT - POOL_LEFT;
export const POOL_HEIGHT = POOL_BOTTOM - POOL_TOP;

// Food ecology. FOOD_BIT_BOUNDARY_MARGIN keeps spawned food off the walls (JJ: POOL_WIDTH*0.01).
// The spawn radius / energy defaults are GlobalTweakers defaults, overridable via config (foodSpread /
// foodBitEnergy). SPAWN_FOOD_RANDOMLY_IN_POOL is false in JJ, so randomizeSpawnPosition draws exactly 6.
export const FOOD_BIT_BOUNDARY_MARGIN = POOL_WIDTH * 0.01;
export const DEFAULT_FOOD_BIT_MAX_SPAWN_RADIUS = 4000.0;
export const DEFAULT_FOOD_BIT_ENERGY = 50.0;

// RETIRED as engine limits at P1b: JJ's fixed slot counts were a hardcoded population CAP (births
// suppressed when the arrays filled). The dynamic collection has no engine-imposed ceiling -- world-scale
// bounds are user config, not engine defaults (North Star; a config carrying-capacity is the optional
// knob, D-f). Kept only to record JJ's original values; nothing in the engine references them now.
export const MAX_SWIMBOTS = 2000;
export const MAX_FOODBITS = 2000;
// MAX_FOODBITS_PER_TYPE is still used: a per-type BALANCE hint for 2-type food regen (not a hard cap).
export const MAX_FOODBITS_PER_TYPE = 1000;
export const NON_REPRODUCING_JUNK_DNA_LIMIT = 0.9; // junk-DNA similarity gate for reproduction

// Mate attraction (getAttractiveness dispatch). Values match SwimbotTypes.js exactly.
export const ATTRACTION_NULL = -1;
export const ATTRACTION_COLORFUL = 0;
export const ATTRACTION_BIG = 1;
export const ATTRACTION_HYPER = 2;
export const ATTRACTION_LONG = 3;
export const ATTRACTION_STRAIGHT = 4;
export const ATTRACTION_NO_COLOR = 5;
export const ATTRACTION_SMALL = 6;
export const ATTRACTION_STILL = 7;
export const ATTRACTION_SHORT = 8;
export const ATTRACTION_CROOKED = 9;
export const ATTRACTION_SIMILAR_COLOR = 10;   // GlobalTweakers / Brain default
export const ATTRACTION_SIMILAR_SIZE = 11;
export const ATTRACTION_SIMILAR_HYPER = 12;
export const ATTRACTION_SIMILAR_LENGTH = 13;
export const ATTRACTION_SIMILAR_STRAIGHT = 14;
export const ATTRACTION_CLOSEST = 15;
export const ATTRACTION_RANDOM = 16;
export const NUM_ATTRACTIONS = 17;

export const SWIMBOT_VIEW_RADIUS = 300.0;             // closeness attraction normalizer
// Body-metric normalizers. MAX_LENGTH=27, MAX_WIDTH=7 are Embryology's morphology bounds (kept in sync
// there); GREATEST = MAX_PARTS * those, as JJ's Embryology.js derives them.
export const GREATEST_POSSIBLE_SWIMBOT_MASS = MAX_PARTS * 27.0 * 7.0;
export const GREATEST_POSSIBLE_SWIMBOT_LENGTH = MAX_PARTS * 27.0;
