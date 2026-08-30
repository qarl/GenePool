// FrozenSwimbot -- a frozen, order-independent view of a swimbot as OTHER bots perceive it during
// snapshot-perception mode (Parallelism Step 1b). In mixed-live perception, bot k+1 sees bot k already moved
// this tick, so the tick is order-DEPENDENT (faithful, but unparallelizable). Snapshot mode instead lets every
// bot read a tick-start-FROZEN view of all others -> order-INDEPENDENT (parallelism prerequisite), a different
// but deterministic trajectory (Karl's "consistent, not identical"). Mixed-live is untouched (still the default).
//
// STABLE IDENTITY, MUTATED IN PLACE: the World keeps one FrozenSwimbot per swimbot id, persistent across ticks,
// refresh()ed at each tick's snapshot. Ids are NEVER reused (no ABA), so a given view object always denotes the
// same individual. That is what makes a chosenMate object-ref (set during last tick's perception) transparently
// read THIS tick's frozen state when update()'s steering dereferences it BEFORE this tick's perception re-runs.
//
// Duck-types exactly the subset of Swimbot the perception / mate-selection / steering path calls on OTHER bots:
// getIndex, getAlive, getAge, getEnergy, getGenitalPosition ({x,y} -- only ever read for .x/.y as the 2nd arg of
// a distance/obstruction test), getGenotype (genes are static within a tick), and getAttractiveness. The JUDGE
// (looker) stays LIVE -- its own metrics are order-independent; only the CANDIDATE is frozen.

import { computeMetricForCriterion, CRITERIA_NEEDING_JUDGE_METRIC, attractivenessOf } from './attraction.js';
import { FLAT } from './topology.js';

const NO_METRIC = {}; // shared empty judge-metrics for criteria that read no judge metric (no per-call alloc)

export class FrozenSwimbot {
    constructor(matePref, viewRadius, topology = FLAT) {
        this._matePref = matePref;     // pairwise addressed MATE_PREF (stateless -> order-independent already)
        this._viewRadius = viewRadius; // for the CLOSEST criterion's closeness normalizer
        this._topology = topology;     // §7 seam for the CLOSEST criterion's inter-entity distance
        this._index = -1;
        this._alive = false;
        this._age = 0;
        this._energy = 0;
        this._genital = { x: 0, y: 0 };
        this._metrics = null;   // {colorSaturation, avgColor, bigness, hyperness, longness, straightness, rootX, rootY}
        this._criterion = 0;    // the candidate's OWN attraction criterion (getAttractiveness reads it off the candidate)
        this._genotype = null;  // live ref; genes are static within a tick (used only by the birth junk-DNA gate)
        this._seen = false;     // snapshot-build sweep marker, managed by World._buildSnapshot
    }

    // Capture the swimbot's tick-start state. Called once per live swimbot at the start of each snapshot tick.
    // Only the metric this bot's OWN criterion needs is computed (a bot always advertises on its own criterion),
    // not the full six-field struct -- that is the snapshot's hot cost. Read the criterion FIRST.
    refresh(sb) {
        this._index = sb.getIndex();
        this._alive = true;
        this._age = sb.getAge();
        this._energy = sb.getEnergy();
        const gp = sb.getGenitalPosition();
        this._genital.x = gp.x; this._genital.y = gp.y;
        this._criterion = sb.getAttractionCriterion();
        this._metrics = computeMetricForCriterion(sb, this._criterion);
        this._genotype = sb.getGenotype();
        this._seen = true;
    }

    // Become a one-tick ghost: the referent died since the last snapshot. Keep the last-known frozen fields so a
    // lingering chosenMate ref still reads a stable position, but report not-alive so steering / the mate rescan
    // drop it (which clears the stale _chosenMateIndex within the tick -- mirrors mixed-live's ghost handling).
    markDead() { this._alive = false; }

    getIndex() { return this._index; }
    getAlive() { return this._alive; }
    getAge() { return this._age; }
    getEnergy() { return this._energy; }
    getGenitalPosition() { return this._genital; }
    getGenotype() { return this._genotype; }

    // Bit-for-bit the same score as Swimbot.getAttractiveness (proven in snapshot-view.test.js), computed from
    // the FROZEN candidate metric + the LIVE judge's metric. Only the ONE metric this criterion reads is computed
    // on each side (the judge's only for the similar-to-me/closest family; skipped otherwise) -- attractivenessOf
    // touches no other field for this criterion, so the result is identical to passing full metrics structs.
    getAttractiveness(judge, tick) {
        const judgeMetric = CRITERIA_NEEDING_JUDGE_METRIC.has(this._criterion)
            ? computeMetricForCriterion(judge, this._criterion) : NO_METRIC;
        return attractivenessOf(this._metrics, judgeMetric, this._criterion, tick,
            this._matePref, this._index, judge.getIndex(), this._viewRadius, this._topology);
    }
}
