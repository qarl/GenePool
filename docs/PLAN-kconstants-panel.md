# PLAN — live constants panel ("K" for kConstants) + 4 new visual params

Status: REVIEWED + hardened (1 pass), Karl chose Model B. Author: Jimmy-GenePool, 2026-09-07. Ready to build.

## 0. Review findings folded in (2026-09-07) — these OVERRIDE the sections below where they conflict

- **B1 (BLOCKER): `hidden` won't hide `#kpanel`.** An author `display:flex` beats the UA `[hidden]{display:none}`
  (there is no global `[hidden]` reset in this file). MUST add `#kpanel[hidden]{display:none}` (specificity wins).
  (`#fpsHud` toggles fine only because it sets no `display`; `#scrubbar` has the same latent bug but is shown via
  JS in desktop so it's masked.)
- **S1: DEFAULTS ordering is load-bearing.** Declare `const DEFAULTS = {...P}` IMMEDIATELY after the `P` literal
  (right after line ~195), BEFORE any localStorage merge. Apply `baseline`/saved only later in `boot()` (~1782).
  Add `Object.assign(P, DEFAULTS)` at the TOP of `__golden` (before its `build()` at ~1595) so captures ignore a
  dev's saved tweaks. If the snapshot is taken after the merge, every golden is silently poisoned.
- **S2: Reset (and load) must re-apply the DOM-side params, not just move sliders.** gain/gamma self-fix next
  frame (uniforms), but `plateBg` (CSS var) and `plateInk` (rasterized) persist until re-applied — so Reset must
  also `--plate-l ← P.plateBg` and RE-RUN `measurePlateGlyphs()` with `P.plateInk`.
- **S3: gain/gamma go BEFORE the `uRound` corner mask in POST_FS** (between the scene+bloom composite `c` and the
  mask multiply, ~lines 512→513): `if (uGain!=1.0||uGamma!=1.0) c = pow(max(c*uGain,0.0), vec3(1.0/uGamma));`.
  Confirmed: at (1,1) the branch is skipped → byte-identical to the current shader; `max(,0)` guards pow. Add
  `uGain`/`uGamma` to the `uPo` lookup loop (~752) and set them at the single postProg site (~1449-1454); every
  view (main ~1529, tiles ~1523, golden mini ~1636) flows through it → covers main + mini, after bloom.
- **S4: every SPEC entry needs an explicit `step`** (range/number default to step=1 → 0-1 params become 0/1
  toggles). gamma number input clamped `min ≥ 0.4` so `1/uGamma` never /0; gain min 0 is fine.
- **Correction — `junk` IS live** (reviewer verified): `seedJunk` always seeds MAX_JUNK; the draw uses
  `nJunk=floor(P.junk*MAX_JUNK)` per frame over the SAME pre-seeded pool (no reshuffle). So INCLUDE `junk` as a
  live slider. Still EXCLUDE `pool`/`n`/`food` (they change the sim → need a rebuild). Save must filter to the
  SPEC subset so pool/n/food are never persisted.
- **Confirmations:** all 32 render keys are genuinely per-frame (buildSegs/tessSegment run inside renderView each
  frame) — nothing needs a rebuild bucket. Keydown extension is clean (existing F handler already guards fields +
  modifiers; branch on `f`/`k`). plate params are DOM-only → can't touch canvas goldens. `micrographParams`
  localStorage key is free. `setProperty('--plate-l', String(P.plateBg))` needs a string. plateInk drives ONLY
  the plate glyph bitmaps (not `.dfill`/`.n`/`.tileLabel`) — intended. Give `#kpanel` a top offset (or accept the
  header overlap on the left).

---

Status: DRAFT (pre-review). Author: Jimmy-GenePool, 2026-09-07. For Karl.

## 1. Goal

Recreate the live visual-constant editor that used to exist (removed in `85855ee` "bake tuned defaults,
strip slider panel"): a **tall, thin, scrollable** panel of `[name] [slider] [number input]` rows, one per
visual constant in `P` (viewer-micrograph-gl.html). Editing a control updates `P` live and the render reflects
it next frame. Toggle the panel with the **K** key ("kConstants"). Two buttons **fixed to the bottom, outside
the scroll region**: **Reset to defaults** and **Save to defaults**. Add **4 new params** (gain, gamma, plate-bg
brightness, plate-ink brightness).

This is a contained UI subsystem + 4 small render/CSS hooks. Not a new "animation/UI system" — plain DOM + CSS
+ the existing per-frame uniform reads.

## 2. Reuse from history (the blueprint)

`85855ee^` had exactly this. Recover its shape (don't copy verbatim — improve per the new requirements):
- `const SPEC = [ { k:'field', label:'Field', min:0.4, max:1, step:0.02 }, ... ]` — one entry per editable key.
- `buildParamPanel()` — for each SPEC row, make a `<label>` + `<input type=range>`; `oninput` set `P[k]=+v`.
- Persistence: wrote `localStorage['micrographParams']` + POSTed a server file. **New version: localStorage only**
  (works in the Electron renderer AND the browser; no server, no new IPC).

New vs the old panel: (a) tall thin scroll column, not a header row; (b) each row also has a **number input**
kept in sync with the slider; (c) **K** toggle; (d) **Reset** + **Save** buttons pinned at the bottom; (e) 4
new params; (f) `measurePlateGlyphs` must be re-runnable (for the plate-ink param).

## 3. Panel UI

- `#kpanel`: `position:fixed; top:0; bottom:0; left:0; width:210px; z-index:60; display:flex; flex-direction:column;`
  dark translucent bg (match `#scrubbar`), hidden by default (`hidden` attr). On the **left** edge so it never
  covers the species list (right) or the scrub bar (bottom overlaps only the far-left corner — acceptable, or
  give the panel `bottom: <scrubbar height>` on desktop; verify).
- `#kpanelRows`: `flex:1; overflow-y:auto; scrollbar-gutter:stable;` — the scrolling region (the SPEC rows).
- `#kpanelBtns`: **outside** `#kpanelRows`, pinned at the bottom (normal flex child after the scroll region):
  two buttons, `Reset to defaults` and `Save to defaults`.
- Each row: `<div class="krow"><span class="klabel">Field</span><input type=range><input type=number></div>`,
  stacked/compact so ~36 rows fit a tall column. Slider and number **two-way synced**: either's `input` sets
  `P[k]` and mirrors the other; clamp the number to [min,max].
- **K toggle**: a `keydown` handler (same guard as the F-toggle: ignore when typing in a field, ignore
  meta/ctrl/alt) flips `#kpanel.hidden`. Reuse/extend the existing keydown listener.

## 4. Persistence + Reset/Save semantics  ← KARL CHOSE MODEL B (2026-09-07)

Model **B (last-saved baseline)** — Reset undoes unsaved live edits, back to the last Save:
- **DEFAULTS** = the baked `P` literal, snapshotted at load (frozen copy) BEFORE anything is applied. Used only
  as the baseline WHEN NOTHING HAS EVER BEEN SAVED.
- **BASELINE** = an in-memory object = the last-saved editable set (from `localStorage['micrographParams']`),
  else a copy of DEFAULTS. This is what "defaults" means to Reset/Save.
- On load: `baseline = savedFromLocalStorage ?? {...DEFAULTS}`, then `Object.assign(P, baseline)` → P starts at
  the baseline.
- **Save to defaults** = write the current editable subset of `P` to `localStorage['micrographParams']` AND set
  `baseline = {...that subset}`. (The current look becomes the new baseline + loads next launch.)
- **Reset to defaults** = `Object.assign(P, baseline)`; refresh every slider+number + the plate side-effects
  (`--plate-l`, re-raster). Does NOT touch localStorage (baseline unchanged) — it just discards unsaved tweaks.
  If nothing was ever saved, baseline == DEFAULTS, so Reset goes to the baked factory look.

## 5. The 4 new params (defaults chosen so nothing changes until you move them)

| key        | label      | range      | default | where it plugs in |
|------------|------------|------------|---------|-------------------|
| `gain`     | Gain       | 0 – 2      | **1.0** | POST_FS (final on-screen composite): `col *= uGain` |
| `gamma`    | Gamma      | 0.4 – 2.5  | **1.0** | POST_FS: `col = pow(col, vec3(1.0/uGamma))` |
| `plateBg`  | Plate BG   | 0 – 1      | **0.74**| plate cell CSS: `oklch(var(--plate-l) 0.15 hue)`; slider sets `--plate-l` |
| `plateInk` | Plate Ink  | 0 – 1      | **0.0** | `measurePlateGlyphs` fillStyle = gray(plateInk); re-raster on change |

- **Gain + Gamma apply to BOTH main and mini** because every view goes through `renderView` → `postProg`
  (the region-composite, line ~1449 — the LAST on-screen pass, so it also covers bloom). One uniform each,
  set from `P.gain`/`P.gamma` where `uPo.uStrength` is set (~line 1452). Add `uGain`,`uGamma` to POST_FS +
  `uPo` lookups.
- **Plate BG**: today each cell is `background:oklch(0.74 0.15 ${hue})` (fixed L=0.74, per-cell hue). Change to
  `oklch(var(--plate-l,0.74) 0.15 ${hue})` and set `document.documentElement.style.setProperty('--plate-l', P.plateBg)`.
  All existing plates (species rows + the labMain pop plate) update **instantly**, no rebuild. (Plates only
  rebuild on signature change — a CSS var sidesteps that.)
- **Plate Ink**: glyphs are pre-rasterised **black** bitmaps (`measurePlateGlyphs`, `fillStyle='#000'`, baked
  into a `<style>` as data-URL backgrounds). Make `fillStyle` = `rgb(v,v,v)` with `v=Math.round(P.plateInk*255)`
  and **re-run `measurePlateGlyphs` on change**. REQUIRED refactor: it currently `appendChild`s a NEW `<style>`
  each call → must keep a ref and REPLACE it (else styles accumulate). Re-raster of ~36 glyphs is a few ms; do it
  on `change`/`input` (throttle via rAF if a drag feels janky).

## 6. Live-apply mechanics (why editing `P` "just works")

Most render params are read from `P` **every frame** as uniforms (e.g. `gl.uniform1f(uR.uField, P.field)`,
resolve/dome/strip/final/post/wall passes), so mutating `P[k]` takes effect next frame with zero extra wiring.
Categorised:

- **Live via per-frame uniform (no extra work)**: field, density, opacity, lighten, desat, rim, subsurface,
  cyto, cells, cytoDrift, grain, grainScale, junkOpacity, junkSoft, hair, hairLen, hairSpace, hairWid, hairSway,
  hairBeat, hairWave, hairDrag, hairLenJit, hairAngJit, hairGrow, bloom, bloomThresh, deathBlur, deathFadeFloor,
  wallThick, wallDark, hairFade  → include all in SPEC.  (Verify each is actually read per-frame during build;
  any that's baked gets moved to the appropriate bucket.)
- **Live via CSS var**: plateBg.
- **Live via re-raster**: plateInk.
- **New uniforms**: gain, gamma (POST_FS).
- **EXCLUDE from the panel (structural / re-seed, not per-frame render)**: `pool`, `n`, `food` (change the
  simulation → require a world rebuild), and `junk` (detritus AMOUNT is seeded once by `seedJunk`; changing it
  needs a re-seed, which reshuffles positions — jarring mid-drag). If Karl wants junk-amount live, re-seed on
  `change` (release) only. Default: leave `junk` out; keep `junkOpacity`/`junkSoft` (those are live render).

## 7. Goldens safety (FIRST-CLASS — see the visual-goldens memory)

- The panel itself is a DOM overlay → **cannot** affect canvas goldens.
- gain/gamma default to **1.0 = identity**; plateBg/plateInk defaults = **current values**. So with defaults,
  the render is byte-identical → **no golden re-baseline**.
- ⚠ **Cross-arch risk**: `pow()` is transcendental; `pow(x,1.0)` is not guaranteed to compile to a no-op, which
  could perturb the maxΔ≤1 cross-arch goldens even at "identity". **Mitigation**: in POST_FS branch on the
  uniforms — `if (uGain != 1.0 || uGamma != 1.0) col = pow(max(col*uGain,0.0), vec3(1.0/uGamma));` — so at the
  default (1,1) the pow path is never taken and the output is **bit-identical** to today's POST_FS. Keeps every
  existing golden green with zero changes.
- ⚠ **`__golden` must ignore persisted params**: the headless golden capture must render at the **baked
  DEFAULTS**, NOT localStorage (a dev's saved tweak would otherwise poison captures). `__golden` already calls
  `build()`; add: it forces `Object.assign(P, DEFAULTS)` (and does not load localStorage) before capture. The
  headless env has empty localStorage anyway, but make it explicit + robust.

## 8. Build steps

1. HTML: add `#kpanel` (rows container + buttons) after the scrub footer; `hidden` by default.
2. CSS: panel layout (fixed, tall, thin, flex column; scroll region; pinned buttons), `.krow` compact styling.
3. JS: `SPEC` array (all editable keys incl. the 4 new, with ranges); snapshot `const DEFAULTS = {...P}`.
4. JS: `buildKPanel()` — build rows (slider+number synced), wire `oninput`→`P[k]` + side-effects (plateBg var,
   plateInk re-raster). A `refreshControls()` helper writes P values back into every slider+number (used by Reset).
5. JS: K keydown toggle (extend the existing keydown handler).
6. JS: `baseline` var (§4). Reset = `Object.assign(P, baseline)` + `refreshControls()` + plate side-effects (NO
   localStorage change). Save = write editable subset to localStorage + `baseline = {...subset}`.
7. JS: on load, `baseline = saved ?? {...DEFAULTS}`, `Object.assign(P, baseline)`, then `buildKPanel()`; set
   `--plate-l`; initial glyph raster uses P.plateInk.
8. Shaders: POST_FS gain/gamma (guarded branch); add `uGain`,`uGamma` to `uPo` + set per-view.
9. CSS/plate: `oklch(var(--plate-l,0.74) ...)`; `measurePlateGlyphs` gray fillStyle + replace-not-append style.
10. `__golden`: force DEFAULTS, skip localStorage.
11. Verify: goldens byte-identical at defaults (`test/visual`), cross-arch maxΔ≤1; panel opens/closes on K;
    every slider moves its param live; Reset/Save persist across relaunch; gain/gamma affect main AND mini;
    plate bg/ink live.

## 9. Risks / open questions

- **Reset semantics** (§4) — factory vs last-saved. Assumed factory; Karl to confirm.
- **Panel vs scrub bar overlap** at the bottom-left on desktop — give `#kpanel` a bottom offset = scrubbar
  height, or let the buttons sit above it. Verify visually.
- **plateInk re-raster jank** on drag — rAF-throttle if needed.
- **Any `P` key that's NOT read per-frame** (baked into a buffer at build) would not live-update — audit each
  during build; move to the right bucket or exclude.
- **localStorage in packaged desktop** persists per userData partition — confirm it survives relaunch (it does
  for the dev run; note for packaging later).
