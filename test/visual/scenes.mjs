// Golden scenes: few + meaningful. Each is a pure function of (seed, ticks, frames, cam, opts) — deterministic.
// The canvas is fixed at 768×768 in the viewer (main micrograph only; the species list is a DOM panel beside it);
// goldens are recorded at that size. (Informational metadata only — the harness reads real dims from __golden.)
export const CANVAS = { w: 768, h: 768 };

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

  // Speciation has emerged (~10 reproductive clusters by 60k). Slow (~20s: 60k ticks); the test asserts >=3 species
  // (a speciation-behaviour guard). opts.mini ALSO captures the largest species' 256^2 mini-viewer -> the ONLY golden
  // coverage of the small-view render path (renderView@256/TILE_ZOOM/onlyBot) that the list expands into.
  { name: 'speciated', seed: 3, ticks: 60000, opts: { mini: true } },   // epoch pmath-1: seed 3 yields ~10 species at 60k (seed 1's new trajectory collapses to ~2)

  // ('empty' — wall+detritus only — deferred: the hook always seeds founders; needs a skip-founders override first.)
];

export const SCENE_BY_NAME = Object.fromEntries(SCENES.map(s => [s.name, s]));
