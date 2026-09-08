# PLAN — swimmer selection + tracking, cross-viewer, and animation pass

Status: BUILT (2026-09-08) — 1-review + 5-panel folded in, Karl's §0.6 decisions applied. Awaiting Karl's visual sign-off; then commit. Deferred (noted): row insert/retire slide animation (births/deaths of ROWS still pop — Karl asked for position-change animation, which is done).

Status: HARDENED + 5-PANEL REVIEWED. Author: Jimmy-GenePool, 2026-09-08. For Karl. Awaiting decisions in §0.5, then build.

## 0.5 — 5-panel review, folded in (2026-09-08). OVERRIDES conflicting text below.

### Must-do technical (I'll implement these; they're engineering, decided)

- **CAM-1 (animation): split the camera into two phases** (not one exp-smoothing for both — it never crisply arrives and pan/zoom finish at different times). **Phase 1 "zoom-to":** one fixed-duration (~400ms) `easeInOut` tween on a single 0→1 clock lerping `x`, `y`, and **`log(zoom)`** together → pan+zoom arrive simultaneously, perceptually even zoom, crisp non-stalling finish, frame-rate-independent. **Phase 2 "track":** critically-damped follow (SmoothDamp, no overshoot) toward the moving bot, zoom held; frame-rate-independent `A = 1 - exp(-k·dt)` with `dt` clamped ~100ms (S4 is REQUIRED, not tune-only — 120Hz desktop vs 60Hz browser). Clean handoff phase1→phase2.
- **CAM-2 (correctness): torus-wrap guard.** A tracked bot wrapping pool→0 would fling the camera across the world. When `|target − cam| > pool/2` on an axis, offset-snap the camera by the pool span instead of smoothing. (World is a torus.)
- **CAM-3: run `updateCamera(dt)` AFTER the tick block, before `render()`, in BOTH loops** (loop 1792→1794, playbackLoop 2024→2027) — "top of loop" lags the moving target by a frame. Ungated by `running`/`playing` (so a paused/zoom-to still animates); no-op when not tracking and never reachable in `__golden` (loop-only).
- **DEATH (SF1, the sharpest missed defect): handle death of the selected bot in a LIVE world.** B1 only covers world *rebuilds*; a selected bot dying is neither, and at fade-out `known.delete` (1480) strands the mini (blank) + camera (eases to a corpse). Add a per-frame edge check at the death fold (advanceFrame ~1473/1477): `if (selectedSb && !selectedSb.getAlive()) deselect()`. Make this + empty-click the paths that null `selectedSb`, so `tracking` never desyncs.
- **STATE (SF3/SF4/SF5): one mutator owns expand state.** `setRowExpanded(id,open)` is the ONLY thing that touches `expanded` + `.exp`; open replicates the accordion (clear others, `expanded.clear()`, add id); the existing pointerdown handler (1405-1414) is refactored to CALL it. Close paths do `expanded.delete(id)` (never bare `classList.remove` — the per-frame toggle at 1433 would re-open it). Track `selectionOpenedId` provenance; deselect closes it ONLY if still `expanded.has(it)`; clear provenance when the accordion evicts it (selection ≠ mini-open, decoupled).
- **XVIEW (SF2): mini-click must guard the shown bot** — `speciesById.get(id)?.t.rep` can be `undefined` (count==0) or a just-died frozen rep. Only `select()` if `shown?.getAlive() && shown._phenotype?.numParts>1`, else ignore.
- **B3a (SF6/N-b): mini override** — compute `const selSpecies = selectedSb?.getAlive() ? speciesModel.speciesIdOf(selectedSb) : null` ONCE before the mini loop; apply `onlyBot=selectedSb` only at the LIVE loop (1756), NEVER the `__golden` mini block (1875).
- **FLIP-PERF (B-PERF-1 + anim §6): gate FLIP to one animation at a time + hysteresis.** The count×lifespan sort reshuffles the long tail almost every frame (`SPECIES_RECOMPUTE=1`), so naive FLIP = a forced sync reflow ~every frame AND constant nauseating row-sliding. Fix: (a) **sort hysteresis** — only commit a rank swap when the key margin is exceeded OR the new order persists N recomputes (debounce); (b) **don't re-measure/re-FLIP a row mid-transition** — cache First-rects at animation start, let the ~340ms transition finish (caps forced reflows to ~3/sec); (c) skip deltas < a few px, skip off-view rows; (d) in `updateSpeciesUI` do ALL layout reads before ALL writes (one flush/frame); (e) init `lastOrder` on first populate so the first paint doesn't animate a full slide.
- **INSERT/RETIRE snap (anim §7): a NEW row inserted mid-list (or a retired row removed) pushes neighbors with no animation** (not a reorder → FLIP misses it). Animate it: FLIP the displaced rows on insert/remove (measure tops before the DOM change), and/or animate the new row's height 0→auto and collapse-then-remove on retirement.
- **DOM-curve unity (anim §4): FLIP + mini-reveal share ONE curve+duration** (`cubic-bezier(.6,0,.9,.1)`, ~340ms — the "slow start / quick snap" you like); camera stays `easeInOut` (a camera shouldn't snap). Round FLIP `translateY` to integer px + `will-change:transform` during it (sub-pixel blurs the `.info` text).
- **PICK (S1): filter `getAlive() && _phenotype.numParts>1`** (known retains fading corpses). **N-c:** name the new click-vs-drag flag distinctly (module `dragging` already exists for pan). **N-d:** `deselect()` null-safe/idempotent (runs in `build()` on every rebuild incl. golden). **scrollIntoView** the auto-opened row if it's below the fold.
- **§7 wording fix:** the mini open/close animates `grid-template-rows` = a LAYOUT animation (not GPU-composited); only the FLIP `transform` is compositor-only. **Golden count:** 6 PNGs across 5 scenes (incl. `speciated.mini`).

### 0.6 Decisions — Karl, 2026-09-08
1. **Zoom while tracking KEEPS tracking** (wheel re-frames the zoom target; only a drag cancels tracking).
2. **NO selection highlight/marker.** (Nothing new paints on the main canvas → B3b is dropped; goldens even safer.)
3. **Hover→pointer cursor** over a hoverable swimmer (throttled bounding-circle test on mousemove, skipped while dragging).
4. **Empty-click deselects + Esc deselects; widen click/drag slop to ~6px.**
5. **Mini shows a "selected"/"typical" label** (selected individual vs species representative).

### Tests (goldens reviewer)
- Runnable headlessly (browser path, add to interaction.visual.mjs): click-on-bot→`selectedSb` set + species row `.exp`; click-empty→deselected + selection-mini closed; accordion regression (row-BODY click still toggles — guards B2); cross-viewer (dispatch on `canvas.mini`→ that row's rep selected).
- NOT headlessly deterministic → need a `window.__stepCamera(n,dt)` step-hook (add in build step 2) OR a real-GPU visual check: camera tracking over frames; scrub/seed/loadWorld clears selection (desktop-only). FLIP: assert only the synchronous invert-transform step.
- Confirmed: no existing test breaks (accordion test dispatches on the row element, not the canvas → B2 branch skipped). Cross-arch clean (no shader changes; camera tween is live-only JS).

## 0. Hardening-review findings folded in (2026-09-08) — these OVERRIDE the sections below on conflict

- **B1 (BLOCKER): deselect on EVERY world rebuild, not just scrub.** `world` is reassigned at 4 sites: init, `build()` (~823), `loadWorld()` (~851), `snapTo()` (~1972). The clean invariant is **call `deselect()` wherever `known.clear()` runs** → add it to `build()` (~825), `loadWorld()` (~855), and `resetOverlays()` (~1946, which `snapTo` calls before its render, so no stale frame; `selectSeed` is covered transitively). `selectedSb` + `deselect()` MUST be module-level (the scrub closures inside `startPlayback` must reach them). This also makes goldens safe for free (build() → selectedSb=null).
- **B2 (BLOCKER): mini-canvas click collides with the accordion.** The `#species` pointerdown (1405) collapses an already-expanded row on ANY pointerdown inside it — so clicking the selected species' mini would CLOSE it instead of selecting the bot. Fix: at the TOP of that handler, if `e.target` is the mini canvas (`e.target.closest('.miniwrap')` / `tagName==='CANVAS'`), **select the shown bot and `return`** (bypass the toggle). Shown bot = `selectedSb` for the already-selected row, else `speciesModel.speciesById.get(+row.dataset.id)?.t.rep`.
- **B3 (determinism guardrail): gate everything that runs inside `render()` on a live selection.** `__golden` calls `render()` directly with `loopStopped=true`, so `updateCamera()` (top of the loops) never runs during capture — good, keep the `loopStopped`/not-tracking guard anyway. But two in-`render()` paths need explicit gates: (a) the mini `onlyBot=selectedSb` override → `selectedSb && id === speciesIdOf(selectedSb)`; (b) ANY main-view selection marker (§9) → gated on `selectedSb != null`. `build()` (via B1) nulls the selection + resets `expanded`, so captures stay byte-identical. Confirm 5/5 pixel goldens unchanged.
- **S1: `pick()` must filter dead bots.** `known` retains dead-but-fading ghosts (advanceFrame keeps them till fade→0). Hit-test only `sb.getAlive() && sb._phenotype.numParts>1` (matches the render gate ~1511), else clicks land on invisible corpses.
- **S2: new-row reflow lives in `updateSpeciesUI`, not `setRowExpanded`.** Rows are created (1431) and get `.exp` one line later (1433) in the SAME synchronous pass → the 0fr→1fr transition has no start value and snaps. The deferral (append without `.exp`, read `offsetHeight`, add `.exp` next microtask/frame) must be applied in the create branch at 1431-1433. (`SPECIES_RECOMPUTE=1` → updateSpeciesUI runs every frame, so this path hits immediately.)
- **S3: `speciesIdOf(sb)` may be `undefined`** (1-part bots are excluded from `assigned`; they can still be picked). `select()` must still track in the main view and just **skip the mini-open** when there's no species row.
- **S4: make smoothing frame-rate-independent** (desktop ~120 Hz vs browser ~60 Hz): `A = 1 - exp(-k*dt)` with a real `dt`, or drop the dt param and accept a per-frame constant (tune-only, not blocking).
- **N1: zoom-to-fit** — `wr` can be 0 (degenerate/1-part); compute defensively + keep the [0.5,60] clamp. **N2: FLIP vs IntersectionObserver** — a row mid-`translateY` may transiently flip `_miniVisible` (one frozen mini frame); cosmetic, accept.
- **Confirmed sound by the review:** `screenToWorld` (W/H hold the resting main size at handler time; replicate the wheel handler's DPR-robust rect mapping); a live `selectedSb` renders in the mini (it's in `known`); `assigned` genuinely needs exposing (`speciesIdOf` getter); FLIP transform (.srow) composes with the grid transition (.srow>.miniwrap) and its deltas cancel scroll; FLIP order-gating is essential (updateSpeciesUI is per-frame); manual override (tracking=false in wheel/drag) halts the tween cleanly; cam/W/H save-restore around renderView makes per-frame cam mutation safe.

---

Status: DRAFT (pre-review). Author: Jimmy-GenePool, 2026-09-08. For Karl. Big change → 1 review + 5-panel before build.

## 1. Goal (Karl's request, verbatim intent)

1. **Click a swimmer in the main viewer → select it.** On select:
   - a) The camera **smoothly animates** (not a snap) to zoom to and then **continuously tracks** the swimmer as it moves.
   - b) The **mini-viewer for that swimmer's species opens**, and that mini shows **the selected swimmer itself** (not the species representative) — so the same swimmer is seen two ways: main viewer + mini.
2. **Click a swimmer shown in a mini-viewer → the main viewer starts tracking it** (same select behavior).
3. **Mini-viewer open/close is animated in ALL ways it can happen** (today only the pointerdown-accordion path animates; the new selection-driven path must animate too, and nothing must snap).
4. **Species rows animate their position changes** in the right-hand list when the sort reorders them.

"Lots of animation." Karl floated building an animation system — see §7 (we use the right tool per surface: a small JS camera tween + CSS for the DOM bits; not a heavy generic engine).

## 2. Current code (verified line refs, viewer-micrograph-gl.html)

- Camera: `let cam = {x,y,zoom}` (246); `sc()=fitZoom()*cam.zoom` (248); `toScreen(wx,wy)=[(wx-cam.x)*s+W/2,(wy-cam.y)*s+H/2]` (250). No screen→world helper yet.
- Input: mousedown sets `dragging` + lastX/Y (1817); mousemove pans while dragging (1819); mouseup clears (1818); wheel = zoom-to-cursor (1808-1815). **No click-picking, no click/drag disambiguation.**
- Render loops: desktop `playbackLoop()` (2020) and browser `loop()` (1790), both `render()` then rAF. `render()` (1734) calls `advanceFrame()` (1449) once/frame, renders expanded minis into a scratch corner + blits to each row's `_miniCtx` (1747-1761), then the main view (1762).
- Mini render: `renderView(viewCam, vw, vh, set, rx, ry, drawWall, roundPx, onlyBot)` (1490); `if (onlyBot && sb !== onlyBot) continue` (1509) renders ONLY that bot. Mini centers on `rep.getPosition()` at `TILE_ZOOM` with `onlyBot=rep` (1756). Bounding radius per bot = `sqrt(max part dist²)+slack` (1517-1519) — reuse for picking.
- Species list: `updateSpeciesUI()` (1416) sorts `tracked` by count×lifespan (1425), toggles `.exp` per row every frame (1433), reorders via `insertBefore` (1440-1443). Open/close = CSS `#species .srow>.miniwrap { transition: grid-template-rows 340ms cubic-bezier(.6,0,.9,.1) }` driven by `.exp` (from earlier work).
- Accordion open: `speciesPanel` pointerdown (1405-1414) — one open at a time.
- Species model (engine/analysis/species.mjs): `tracked` (id→{…,rep,idset,count,sig,…}); `assigned` Map sb→lineageId (71) — **currently NOT in the returned facade** (return at 161); `speciesById` getter (165); `rep` is a live Swimbot. `known` (viewer) maps id→sb for rendering.

## 3. Selection + picking

- **State:** `let selectedSb = null;` (a live Swimbot ref) + `let camAnim = { tracking:false };`.
- **Click vs drag:** on mousedown store `{sx,sy}` + `moved=false`; mousemove sets `moved=true` once `|Δ|>4px` (CSS px). On mouseup: if `!moved` it's a **click** → pick; else it was a pan (no select). (Keeps drag-to-pan intact.)
- **Screen→world:** add `screenToWorld(px,py)` = inverse of `toScreen` using the click's canvas-relative backing coords (same rect mapping as the wheel handler, robust to CSS/DPR scaling).
- **Pick:** iterate `known` (id→sb) for living bots; for each compute center + bounding radius `wr` (reuse the cull formula); hit-test the world point inside the bounding circle; choose the **nearest center** among hits (tie-break). Cheap — runs once per click, not per frame. Miss (no hit) = empty click.
- **On hit → `select(sb)`:** set `selectedSb=sb`; start the camera animation + tracking (§4); open the mini for its species (§5). **On miss → `deselect()`:** `selectedSb=null`, stop tracking, close the selection-opened mini (§5).

## 4. Camera animation + tracking  (the JS tween)

- **Model:** exponential smoothing toward a target each frame (naturally eases in AND follows a moving target — one mechanism for both "zoom to" and "track"). New `updateCamera(dt)` called at the top of `playbackLoop`/`loop` (before `render()`), guarded to a no-op during `__golden` (which sets `cam` explicitly).
- **Targets:** when `camAnim.tracking && selectedSb?.getAlive()`: `tx,ty = selectedSb.getPosition()`; `tzoom = clamp(fit-the-swimmer zoom)` where fit-zoom frames the bot's bounding radius to ~1/3 of `min(W,H)` (like the `focus:'biggest'` framing at 1849). Then `cam.x += (tx-cam.x)*A; cam.y += (ty-cam.y)*A; cam.zoom += (tzoom-cam.zoom)*A;` with `A≈0.12` (per-frame smoothing; ~0.15s feel). Snap-to-target + clear the "zooming" phase once within an epsilon (keep tracking position, hold zoom).
- **Two phases:** (i) initial "zoom-to" eases position+zoom to the swimmer; (ii) steady "track" keeps easing position toward the (moving) swimmer, zoom held. Same code — the target just keeps updating.
- **Manual override:** a user pan (drag) or wheel-zoom **stops tracking** (frees the camera) but KEEPS the selection + mini (re-click to re-track). Set `camAnim.tracking=false` in the drag/wheel handlers when a selection is active.
- **Death/scrub:** if `selectedSb` dies (`!getAlive()`) or the world is replaced (scrub `snapTo`/`selectSeed` rebuild `world` → the ref is stale), **deselect** (stop tracking, revert mini). Hook deselect into snapTo/selectSeed and check aliveness each frame.

## 5. Mini shows the selected swimmer + auto-open its species

- **Find the species row:** expose a lookup on the species model — add `speciesIdOf(sb)` (returns `assigned.get(sb)`), or expose `assigned`. Map `selectedSb → lineageId → the row in rowMap`.
- **Auto-open (animated):** route ALL opens through a single `setRowExpanded(id, open)` (§6) so the selection-open animates identically to the accordion. Opening the selected species' row obeys the one-open-at-a-time accordion (close others).
- **Render the selected bot in the mini:** in the mini render loop (1751-1758), for the row whose species == `speciesIdOf(selectedSb)`, render with `onlyBot=selectedSb` and center on `selectedSb.getPosition()` (instead of `rep`). Other rows keep `rep`. So the selected swimmer appears in BOTH the main view (tracked) and its species mini.
- **Selected bot dies:** fall back to the species `rep` (or close the row if it was selection-opened).

## 6. Mini open/close animated "in all ways"

- **Root cause of "only one method":** today the only opener is the pointerdown accordion; the new selection path is a second opener, and the FLIP reorder (§8) moves rows in the DOM which can interrupt an in-flight grid transition.
- **Unify:** one `setRowExpanded(id, open)` used by the accordion AND selection. It toggles `.exp` on the **existing, painted** row (never recreates it), so the CSS `grid-template-rows` transition always fires. `updateSpeciesUI`'s per-frame `classList.toggle('exp', …)` stays consistent with `expanded` (idempotent — no re-trigger when unchanged).
- **New-row case:** if a row is created and opened in the same frame, force a reflow (read `offsetHeight`) after append with `.exp` absent, then add `.exp` next microtask so the 0fr→1fr transition has a start value (else it snaps).
- **FLIP-safe:** the reorder animates via `transform: translateY` (compositor) which composes with the miniwrap's `grid-template-rows` transition (different property, different element) — they don't fight. Verify a row mid open/close that also reorders still animates both.

## 7. "Animation system" — scope

Three surfaces, right tool each:
- **Camera** → a tiny JS exponential-smoothing tween in the render loop (§4). ~30 lines. Reusable shape (`approach(cur,target,a)`).
- **Mini open/close** → CSS `grid-template-rows` transition (exists), unified trigger (§6).
- **List reorder** → CSS `transform` FLIP (§8).

No heavy generic engine — it would add surface without benefit; the DOM bits belong in CSS (GPU-composited, interruptible) and only the camera needs per-frame JS. (If a later feature needs arbitrary tweens, factor `approach()` into a small helper then.)

## 8. Species-list reorder animation (FLIP)

- In `updateSpeciesUI`, only when the **sorted order actually changes** (compare new id-order to a stored `lastOrder`):
  1. **First:** record each current row's `getBoundingClientRect().top`.
  2. Reorder via the existing `insertBefore` loop (**Last**).
  3. **Invert:** for each moved row set `transform: translateY(firstTop-lastTop)` with `transition:none`.
  4. **Play:** next frame (rAF) clear the transform under `transition: transform 300ms ease`.
- **Perf guard:** the `getBoundingClientRect` batch (forced reflow) runs ONLY on an order change, not every frame; order changes are occasional (the sort is "wobbly" but not every-frame once populations settle). Cap: if many rows move at once it's still one reflow. Respect `scrollbar-gutter` and the panel scroll offset (FLIP uses deltas so scroll cancels out).
- **Interaction with open rows:** an expanded row is tall; when it moves, FLIP translateY animates its whole box — fine. Ensure the transform is on `.srow` and the grid transition is on the inner `.miniwrap` (separate elements) so both run.

## 9. Deselection / edge cases (decisions flagged for Karl)

- **Empty-space click** → deselect + close the selection-opened mini. (Manually-opened minis: track whether a row was opened by selection vs pointerdown; only auto-close the selection-opened one.)
- **Manual pan/zoom while selected** → stop auto-tracking, keep selection + mini (re-click to re-track). *(Alt: keep tracking and treat pan as an offset — heavier. Proposing stop-tracking.)*
- **Selected bot highlight in the main view?** Karl didn't ask, but a faint ring/marker on the tracked bot helps identify it among neighbors. *Proposing a subtle marker; easy to drop.* — Karl to confirm.
- **Scrub/seed change** clears selection (the world + all bot refs are rebuilt).

## 10. Goldens / tests

- **Canvas goldens unaffected:** selection/tracking/FLIP are interactive + DOM; `__golden` sets `cam` explicitly and takes no clicks. Guard `updateCamera()` to a no-op when `loopStopped` (golden) or when not tracking. The mini `onlyBot=selectedSb` override only triggers with a live selection (never during capture). Confirm 5/5 pixel goldens stay byte-identical.
- **New interaction tests** (`interaction.visual.mjs`, browser path): (a) synthesize a click on a known bot → `selectedSb` set + its species row `.exp`; (b) click empty → deselected; (c) reorder triggers a FLIP transform on a moved row; (d) camera target moves toward the bot over frames. Use the live-loop/browser path (window.pool absent) with a populated world (crank speed) — clicks map through `screenToWorld`.
- Keep the accordion + K-panel tests green.

## 11. Build order

1. `screenToWorld` + click/drag disambiguation + `pick()` + `select()/deselect()` state (no camera yet — verify selection sets state + logs).
2. `updateCamera()` exp-smoothing + tracking + zoom-to-fit; hook in both loops; manual-override cancels tracking; golden guard.
3. Species-model `speciesIdOf(sb)`; `setRowExpanded()` unify; selection auto-opens the species row (animated); mini renders `onlyBot=selectedSb` for that row.
4. Cross-viewer: mini-canvas click → select the shown bot → track in main.
5. FLIP reorder in `updateSpeciesUI` (order-change-gated).
6. New-row reflow fix so every open animates; verify all open/close paths animate.
7. Deselect/death/scrub edge cases; optional selection marker.
8. Tests + goldens; real-GPU feel check (relaunch); perf check at pop ~1000 (picking + FLIP must not cost per-frame).

## 12. Risks

- **Stale bot refs across scrub** — must clear selection on world rebuild (§4).
- **FLIP forced reflow** — gate to order changes; watch perf at high pop.
- **Transition interruption** when a row both reorders (FLIP transform) and opens (grid rows) — verify they compose (different props/elements).
- **Picking accuracy** — bounding-circle hit-test may over-select overlapping bots; nearest-center tie-break; acceptable (can refine to part-distance later).
- **Zoom-to-fit for tiny bots** — clamp target zoom to the existing [0.5,60] range; don't over-zoom a 1-part bot.
- **Tracking jitter** — a fast-moving bot with heavy smoothing could lag; tune `A`; hold zoom once framed to avoid pulsing.
