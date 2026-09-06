# Planning process (for big / risky / architectural changes)

**This is the NORM for larger changes** (Karl, 2026-09-06) — the default before building anything substantial, not an
optional extra. It's cheap relative to the feature and has repeatedly caught blocking bugs and surfaced real product
decisions *before* any code was written (species-list, scrub/playback, GPU-hair, …).

**When to use it:** any larger change — new subsystem, architectural/multi-phase work, a shader/pipeline rewrite,
anything risky or hard to reverse. **When to skip it:** small, reversible tweaks (a param, a CSS/UI nudge, a bounded
bug-fix) — those follow the normal bias-to-action loop. When unsure, lean toward running it.

## The five steps

1. **Write a plan** — a `docs/PLAN-<feature>.md`, grounded in the *actual* code (read it first; cite files/lines). State
   the problem, the proposed design, the mechanics, what must be preserved, risks/open questions, and a phased build
   order with go/no-go gates.

2. **One reviewer hardens it** — a single subagent reviews the plan end-to-end. This first pass clears the obvious
   structural rocks so the five-panel doesn't all re-find the same one. (Karl's "voodoo" — always do this single pass
   first; never skip straight to the panel.)

3. **Harden the plan** — fold the reviewer's findings back into the plan as *decisions*, tagged so provenance is clear.

4. **Five reviewers, distinct lenses** — five *new* subagents review the hardened plan in parallel, each with a
   different lens (e.g. for a render change: GPU/pipeline, shader math/numerics, performance, visual-fidelity/goldens,
   integration/lifecycle). Tell each to **hunt NEW issues AND adversarially challenge the already-accepted fixes** — the
   panel has caught wrong "accepted" fixes before. Diverse lenses so they don't all find the same thing.

5. **Incorporate all the ideas** — dedupe, rank, and fold the panel's findings into the plan as decisions. Surface
   product/direction calls to Karl; decide pure-engineering forks yourself and record what/why.

Then, and only then, **build** (in the plan's phased order, verifying each gate).

## How to run it

- Steps 2 and 4 use the `Agent` tool (general-purpose subagents), launched in parallel for step 4 (one message, five
  calls, focused lenses).
- Keep the plan as the single source of truth: every fold-in is a dated, tagged section so the decision trail is legible.
- The plan is the deliverable of this process; building is a separate, explicit go.

See `.claude/.../memory/big-change-planning-formula.md` for the running notes on why this exists.
