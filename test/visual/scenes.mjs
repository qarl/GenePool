// Golden scenes: few + meaningful. Each is a pure function of (seed, ticks, frames, cam, opts) — deterministic.
// The canvas is fixed at 900×760 in the viewer; the goldens are recorded at that size.
export const CANVAS = { w: 900, h: 760 };

export const SCENES = [
  // Fresh founder layout — seeding, junk-zeroing, initial poses; whole-field.
  { name: 'founders', seed: 1, ticks: 0 },

  // Grown, dispersed field at 1× — exercises the many-creature path: frustum culling, LOD, detritus, wall.
  { name: 'adults', seed: 1, ticks: 3000 },

  // Zoomed onto the biggest specimen — the body-detail path: ribbons, tip domes / branch-merge (the hard-won fix),
  // hairs, cytoplasm + grain (integer-hash noise). This is the frame Karl approved for the noise swap.
  { name: 'branchy', seed: 1, ticks: 800, cam: { zoom: 26, focus: 'biggest' } },

  // Interleaved tick→render so specimens die MID-capture -> the death-fade path (known/deathTick/fades) renders.
  // That bookkeeping is exactly what the species-viewers 2a refactor hoists, so this scene is the 2a gate's teeth.
  // Tuned (seed 3 / 900 ticks / every 30) to leave ~4 mid-fade ghosts in the final frame; asserted > 0 in the test.
  { name: 'dying', seed: 3, ticks: 900, opts: { interleave: 30 } },

  // Speciation has emerged (~10 reproductive clusters by 60k): exercises all THREE tiles at once (top-3 by head-count).
  // Slow (~20s: 60k ticks) but it's the only scene that covers the multi-tile path; the test asserts >=3 species.
  { name: 'speciated', seed: 1, ticks: 60000 },

  // ('empty' — wall+detritus only — deferred: the hook always seeds founders; needs a skip-founders override first.)
];

export const SCENE_BY_NAME = Object.fromEntries(SCENES.map(s => [s.name, s]));
