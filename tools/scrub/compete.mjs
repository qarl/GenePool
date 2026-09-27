'use strict';
// Pool-vs-pool COMPETITION -- headless, disk-free (saves only tiny champion .pool files).
//   node tools/scrub/compete.mjs champion <seed|all>          extract each seed's largest species (day 1) -> a .pool
//   node tools/scrub/compete.mjs match <A> <B> [--days 1] [--ticks N] [--natural] [--json]
//                                                            merge two champions into one arena, run, report who dominates
//
// A/B are seed numbers (use their saved champions) or explicit .pool paths. Teams are tracked ENTIRELY OUTSIDE the engine
// (a child inherits its parent's team via birth events) -> zero engine change, determinism/goldens untouched. See
// docs/PLAN-competition.md. Cross-platform: run via node (dev) or the app's electron-as-node (see compete.cmd on Windows).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { World } from '../../engine/world.js';
import { openRunReader } from '../events/run-db.mjs';
import { poolConfig, POOL_DEFAULTS, POOL_SETTINGS, mulberry32, diskPoint, makeStandardWorld } from '../../engine/pool-seed.mjs';
import { USED } from '../../engine/analysis/species.mjs';
import { jobsDir } from './gen-jobs.mjs';

const TICKS_PER_DAY = 5184000;
const NUM_GENES = 256;
const timelinesDir = () => join(jobsDir(), 'timelines');
const championsDir = () => { const d = join(jobsDir(), 'champions'); mkdirSync(d, { recursive: true }); return d; };
const seedDb = (n) => join(timelinesDir(), `seed-${n}.db`);
const championPath = (n) => join(championsDir(), `seed-${n}.pool`);

// junk-DNA similarity from two plain gene arrays (engine metric, junk region [USED,NUM_GENES)). >0.9 => interbreeds.
function junkSimGenes(a, b) { let d = 0, n = 0; for (let k = USED; k < NUM_GENES; k++) { d += Math.abs((a[k] | 0) - (b[k] | 0)); n++; } return 1 - (d / 256) / n; }
const meanGenes = (arr) => { const m = new Array(NUM_GENES).fill(0); for (const s of arr) for (let k = 0; k < NUM_GENES; k++) m[k] += (s.genes[k] | 0); return m.map((v) => v / Math.max(1, arr.length)); };

// ---- champion extraction: largest species at ~day 1 -> a .pool -----------------------------------------------------
async function extractChampion(seed) {
  const db = seedDb(seed);
  if (!existsSync(db)) throw new Error(`no seed db: ${db}`);
  const r = openRunReader(db);
  try {
    const frontier = r.frontier();
    const day1Tick = Math.min(TICKS_PER_DAY, frontier);
    // Pick the sampling tick: the keyframe nearest <= day 1 IF it's still populated; otherwise (the seed went
    // extinct by day 1) fall back to the PEAK-population keyframe -- its prime, not the flatline. (Karl.)
    const series = await r.getPopSeries(frontier);   // [{tick, pop, food}] per keyframe
    let atDay1 = null; for (const s of series) if (s.tick <= day1Tick) atDay1 = s;
    let targetTick, note = '';
    if (atDay1 && atDay1.pop > 0) { targetTick = atDay1.tick; }
    else { let peak = series[0] || { tick: 0, pop: 0 }; for (const s of series) if (s.pop > peak.pop) peak = s;
      targetTick = peak.tick; note = ` [extinct by day 1 -> champion from PEAK pop ${peak.pop} @ ${(peak.tick / TICKS_PER_DAY).toFixed(2)}d]`; }
    const kf = r.getKeyframe(targetTick);           // nearest keyframe <= targetTick
    if (!kf) throw new Error(`seed-${seed}: no keyframe (frontier ${frontier})`);
    const cfg = (r.runConfig() || {}).config || poolConfig(POOL_DEFAULTS.pool, POOL_SETTINGS);
    // The seed's WHOLE population at that tick (all species) -- the match samples 500 uniformly from it (Karl).
    const swimbots = (kf.snapshot.swimbots || []).filter((s) => s && s.alive !== false);
    if (!swimbots.length) throw new Error(`seed-${seed}: no living creatures at tick ${kf.tick}`);
    const out = { v: 1, kind: 'gpool-pool', seed, tick: kf.tick, config: cfg, data: { swimbots } };
    writeFileSync(championPath(seed), JSON.stringify(out));
    return { seed, tick: kf.tick, count: swimbots.length, note };
  } finally { r.close(); }
}

// ---- load a champion by seed number or explicit path ---------------------------------------------------------------
function loadChampion(ref) {
  const path = /^\d+$/.test(String(ref)) ? championPath(ref) : ref;
  if (!existsSync(path)) throw new Error(`no champion pool: ${path} (run: compete champion ${ref})`);
  const p = JSON.parse(readFileSync(path, 'utf8'));
  const swimbots = (p.data && p.data.swimbots) || [];
  if (!swimbots.length) throw new Error(`champion ${path} has no creatures`);
  return { ref, path, config: p.config, seed: p.seed, swimbots };
}

// Generate a candidate seed's champion ENTIRELY IN MEMORY (no timeline db written) -> disk-free hunting. Simulate the
// standard pool to day 1; use the day-1 population if still alive, else the peak-population snapshot (a boom-crash seed's
// prime), sampled every 50k ticks. Returns { seed, config, swimbots } like loadChampion.
function genChampionInMemory(seed) {
  const cfg = poolConfig(POOL_DEFAULTS.pool, POOL_SETTINGS);
  const { world } = makeStandardWorld(seed, { config: cfg });
  let best = { pop: world.getLivingSwimbotCount(), snap: null };
  for (let t = 1; t <= TICKS_PER_DAY; t++) {
    world.tick();
    if (t % 2000 === 0) { const pop = world.getLivingSwimbotCount(); if (pop === 0) break;
      if (t % 50000 === 0 && pop > best.pop) best = { pop, snap: world.serialize() }; }
  }
  const finalPop = world.getLivingSwimbotCount();
  const peaked = finalPop === 0;
  const snap = peaked ? (best.snap || world.serialize()) : world.serialize();
  const swimbots = (snap.swimbots || []).filter((s) => s && s.alive !== false);
  return { seed, config: cfg, swimbots, peak: peaked, tick: snap.clock != null ? snap.clock : TICKS_PER_DAY };
}
// Resolve a champion for a seed: an existing .pool if present, else generate it in memory (disk-free).
function resolveChampion(seed) { return existsSync(championPath(seed)) ? loadChampion(seed) : genChampionInMemory(seed); }
// Persist a champion object (from genChampionInMemory) to its .pool -- used to KEEP a killer we found. Disk-frugal:
// only ever called for a winner, so the hunt never litters candidate pools.
function saveChampionObj(ch) {
  if (!ch.swimbots || !ch.swimbots.length) return null;
  const out = { v: 1, kind: 'gpool-pool', seed: ch.seed, tick: ch.tick || TICKS_PER_DAY, config: ch.config, data: { swimbots: ch.swimbots } };
  writeFileSync(championPath(ch.seed), JSON.stringify(out));
  return championPath(ch.seed);
}

// ---- the match -----------------------------------------------------------------------------------------------------
const runMatch = (A, B, opts = {}) => runMatchCore(loadChampion(A), loadChampion(B), opts);
// chA/chB are champion objects { seed, config, swimbots } -- from a .pool (loadChampion) OR generated in memory.
function runMatchCore(chA, chB, { days = 1, ticks = null, natural = false, settings = {}, quiet = false } = {}) {
  const STATUS = () => join(jobsDir(), `compete-status-${chA.seed}v${chB.seed}.json`);   // per-matchup -> parallel matches don't clobber
  const total = ticks != null ? ticks : Math.round(days * TICKS_PER_DAY);
  const cfg = poolConfig(POOL_DEFAULTS.pool, { ...POOL_SETTINGS, ...settings });   // --settings can flip arena params (e.g. foodReseedWhenEmpty)
  const pool = cfg.pool.right - cfg.pool.left;
  const masterSeed = (((chA.seed >>> 0) * 73856093) ^ ((chB.seed >>> 0) * 19349663)) >>> 0;
  const rng = mulberry32(masterSeed);

  // fairness: sample 500 UNIFORMLY at random from each whole pool, capped to the smaller pool (both start equal).
  // --natural uses each pool at its true size. Seeded shuffle -> deterministic.
  const shuffle = (arr, rnd) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let aList = chA.swimbots, bList = chB.swimbots;
  let normN = null;
  if (!natural) { const shuf = mulberry32((masterSeed ^ 0x9e3779b9) >>> 0); normN = Math.min(500, aList.length, bList.length); aList = shuffle(aList, shuf).slice(0, normN); bList = shuffle(bList, shuf).slice(0, normN); }

  const world = new World(cfg, masterSeed);
  const teamOf = new Map();
  const place = (list, cx, team) => { for (const s of list) { const id = world.getNextSwimbotId(); const p = diskPoint(rng, cx, pool * 0.5, pool * 0.22);
    world.loadSwimbot(id, { age: s.age, x: p.x, y: p.y, angle: s.angle, energy: s.energy, genes: s.genes, numOffspring: s.numOffspring || 0, numFoodBitsEaten: s.numFoodBitsEaten || 0 }); teamOf.set(id, team); } };
  place(aList, pool * 0.25, 'A');                  // team A -> left sub-disk
  place(bList, pool * 0.75, 'B');                  // team B -> right sub-disk
  for (let i = 0; i < POOL_DEFAULTS.food; i++) { const p = diskPoint(rng, pool * 0.5, pool * 0.5, pool / 2.2); world.loadFood(world.getNextFoodId(), { x: p.x, y: p.y, type: 0, energy: cfg.foodBitEnergy }); }

  // team tracking via birth events -- attach AFTER the merge so founder/food_init events are ignored.
  let crossTeamBirths = 0;
  world._onEvent = (e) => {
    if (!e || e.type !== 'birth') return;
    const tP = teamOf.get(e.parentId), tM = teamOf.get(e.mateId);
    let t = tP ?? tM ?? 'H';
    if (tP && tM && tP !== tM) { crossTeamBirths++; t = 'H'; }   // hybrid -> neutral bucket, counts for neither side
    teamOf.set(e.id, t);
  };

  const junk = junkSimGenes(meanGenes(aList), meanGenes(bList));   // >0.9 => the two champions will interbreed (contest is suspect)
  const count = () => { let a = 0, b = 0, h = 0; for (const [id] of world._swimbots) { const t = teamOf.get(id); if (t === 'A') a++; else if (t === 'B') b++; else h++; } return { a, b, h, food: world._livingFoodCount ?? 0 }; };
  const curve = []; let extinctTick = null;
  const sampleEvery = 2000;
  const t0 = Date.now();
  const writeStatus = (c, t, doneReason = null) => { try { writeFileSync(STATUS(), JSON.stringify({
    a: { seed: chA.seed }, b: { seed: chB.seed }, tick: t, day: t / TICKS_PER_DAY, alive: c, crossTeamBirths, junkSim: junk,
    elapsedSec: Math.round((Date.now() - t0) / 1000), done: doneReason })); } catch { /* status is best-effort */ } };
  curve.push({ tick: 0, ...count() });
  writeStatus(curve[0], 0);
  for (let t = 1; t <= total; t++) {
    world.tick();
    if (t % sampleEvery === 0) {
      const c = count(); curve.push({ tick: t, ...c });
      // live progress: a tiny status file + a stdout ticker (disk-free; ~KB). Watch A vs B (and food) battle in real time.
      writeStatus(c, t);
      if (!quiet) process.stderr.write(`\r  day ${(t / TICKS_PER_DAY).toFixed(3)}  A ${String(c.a).padStart(4)}  B ${String(c.b).padStart(4)}  food ${String(c.food).padStart(4)}${c.h ? `  hybrid ${c.h}` : ''}   `);   // progress -> stderr so --json stdout stays pure
      if (c.a === 0 || c.b === 0) { extinctTick = t; break; }
    }
  }
  if (!quiet) process.stderr.write('\n');
  const fin = count();
  const winner = fin.a === 0 && fin.b === 0 ? 'tie' : fin.a === 0 ? 'B' : fin.b === 0 ? 'A' : fin.a > fin.b ? 'A' : fin.b > fin.a ? 'B' : 'tie';
  // downsample the curve to ~120 points
  const step = Math.max(1, Math.ceil(curve.length / 120));
  const thin = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  return { a: { ref: String(chA.ref != null ? chA.ref : chA.seed), seed: chA.seed, start: aList.length }, b: { ref: String(chB.ref != null ? chB.ref : chB.seed), seed: chB.seed, start: bList.length },
    normalized: !natural, normN, junkSim: junk, interbreeds: junk > 0.9, crossTeamBirths,
    ticks: extinctTick != null ? extinctTick : total, extinctTick, days: (extinctTick != null ? extinctTick : total) / TICKS_PER_DAY,
    final: fin, winner, curve: thin };
}

// ---- tournament: a points LEAGUE, matches run in PARALLEL across N cores -------------------------------------------
const SELF = fileURLToPath(import.meta.url);
const standingsPath = () => join(jobsDir(), 'tournament-standings.json');

// Circle-method round-robin: each seed plays `rounds` DISTINCT opponents (a bye pairing is dropped for odd counts).
function schedule(seeds, rounds) {
  const list = [...seeds]; if (list.length % 2) list.push(null);   // odd -> a phantom 'bye'
  const n = list.length; let arr = [...list]; const matches = [];
  for (let r = 0; r < rounds && r < n - 1; r++) {
    for (let i = 0; i < n / 2; i++) { const a = arr[i], b = arr[n - 1 - i]; if (a != null && b != null) matches.push([a, b]); }
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];   // rotate, keep arr[0] fixed
  }
  return matches;
}

// run one match as a child (clean JSON on stdout; progress on stderr, ignored).
function runMatchChild(A, B, { days, settings }) {
  return new Promise((resolve) => {
    const args = [SELF, 'match', String(A), String(B), '--days', String(days), '--json'];
    if (settings && Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } });
    let out = ''; child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    child.on('error', () => resolve(null));
  });
}

async function runTournament({ cores = 5, days = 1, matchesPer = 5, settings = {}, seeds = null }) {
  if (!seeds) seeds = readdirSync(timelinesDir()).map((f) => (f.match(/^seed-(\d+)\.db$/) || [])[1]).filter(Boolean).map(Number).sort((x, y) => x - y);
  // ensure every seed has a champion pool (extract missing).
  for (const s of seeds) if (!existsSync(championPath(s))) { try { const r = await extractChampion(s); console.log(`extracted champion seed-${s} (${r.count})${r.note || ''}`); } catch (e) { console.log(`champion seed-${s} FAILED: ${e.message}`); } }
  seeds = seeds.filter((s) => existsSync(championPath(s)));
  const matches = schedule(seeds, matchesPer);
  const P = new Map(seeds.map((s) => [s, { seed: s, pts: 0, w: 0, d: 0, l: 0, played: 0, forDiff: 0 }]));
  let done = 0; const t0 = Date.now();
  const writeStandings = (final = false) => {
    const table = [...P.values()].sort((a, b) => b.pts - a.pts || b.forDiff - a.forDiff || b.w - a.w);
    const secs = Math.round((Date.now() - t0) / 1000);
    try { writeFileSync(standingsPath(), JSON.stringify({ done, total: matches.length, cores, days, secs, final, table }, null, 2)); } catch { /* */ }
    return table;
  };
  const score = (res, A, B) => {
    const pa = P.get(A), pb = P.get(B); if (!pa || !pb) return;
    pa.played++; pb.played++;
    if (!res) { return; }                                  // a failed match: no points, still counted as played
    const a = res.final.a, b = res.final.b, close = Math.max(a, b) > 0 && Math.abs(a - b) / Math.max(a, b) < 0.05;
    pa.forDiff += a - b; pb.forDiff += b - a;
    if (close || res.winner === 'tie') { pa.pts += 1; pb.pts += 1; pa.d++; pb.d++; }
    else if (res.winner === 'A') { pa.pts += 3; pa.w++; pb.l++; }
    else { pb.pts += 3; pb.w++; pa.l++; }
  };
  console.log(`TOURNAMENT: ${seeds.length} seeds, ${matches.length} matches, ${matchesPer}/seed, ${days}-day each, ${cores} cores. Standings -> ${standingsPath()}`);
  let idx = 0;
  const worker = async () => {
    while (idx < matches.length) {
      const [A, B] = matches[idx++];
      const res = await runMatchChild(A, B, { days, settings });
      score(res, A, B); done++;
      const w = res ? (res.winner === 'tie' ? 'tie' : 'seed-' + (res.winner === 'A' ? res.a.seed : res.b.seed)) : 'ERR';
      console.log(`[${done}/${matches.length}] seed-${A} vs seed-${B} -> ${w}${res ? ` (${res.final.a}-${res.final.b}, ${res.days.toFixed(2)}d)` : ''}`);
      writeStandings();
    }
  };
  await Promise.all(Array.from({ length: cores }, worker));
  const table = writeStandings(true);
  console.log(`\n=== FINAL STANDINGS (${matches.length} matches in ${Math.round((Date.now() - t0) / 60000)} min) ===`);
  table.slice(0, 15).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. seed-${String(r.seed).padStart(2)}  ${r.pts} pts  (${r.w}W ${r.d}D ${r.l}L, net ${r.forDiff >= 0 ? '+' : ''}${r.forDiff})`));
}

// ---- bracket: single-elimination knockout tree (default: the tournament's top 8) -----------------------------------
const bracketPath = () => join(jobsDir(), 'bracket-results.json');
async function poolRun(items, cores, fn) {
  const results = new Array(items.length); let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cores, items.length)) }, worker));
  return results;
}
const winnerSeed = (res, A, B) => !res ? A : res.winner === 'A' ? A : res.winner === 'B' ? B : (res.final.a >= res.final.b ? A : B);

async function runBracket({ seeds, days = 1, settings = {}, cores = 4 }) {
  for (const s of seeds) if (!existsSync(championPath(s))) { try { const r = await extractChampion(s); console.log(`extracted champion seed-${s} (${r.count})${r.note || ''}`); } catch (e) { console.log(`champion seed-${s} FAILED: ${e.message}`); } }
  // standard 8-seed bracket so the two top seeds can only meet in the final (1v8, 4v5, 2v7, 3v6).
  const s = seeds;
  let round = s.length === 8 ? [[s[0], s[7]], [s[3], s[4]], [s[1], s[6]], [s[2], s[5]]]
    : (() => { const r = []; for (let i = 0; i < s.length; i += 2) r.push([s[i], s[i + 1]]); return r; })();
  const names = { 8: 'Quarterfinals', 4: 'Semifinals', 2: 'Final' };
  const log = [];
  console.log(`BRACKET: ${seeds.length} seeds [${seeds.map((x) => 'seed-' + x).join(', ')}], ${days}-day matches, ${cores} cores.`);
  while (true) {
    const label = names[round.length * 2] || `Round of ${round.length * 2}`;
    console.log(`\n=== ${label} ===`);
    const results = await poolRun(round, cores, ([A, B]) => runMatchChild(A, B, { days, settings }).then((res) => ({ A, B, res })));
    const winners = [];
    for (const { A, B, res } of results) {
      const w = winnerSeed(res, A, B); winners.push(w);
      console.log(`  seed-${A} vs seed-${B}  ->  seed-${w}${res ? ` (${res.final.a}-${res.final.b}, ${res.days.toFixed(2)}d)` : ' (ERR)'}`);
      log.push({ round: label, a: A, b: B, winner: w, final: res ? res.final : null });
    }
    try { writeFileSync(bracketPath(), JSON.stringify({ log, remaining: winners }, null, 2)); } catch { /* */ }
    if (winners.length === 1) { console.log(`\n🏆 BRACKET CHAMPION: seed-${winners[0]}`); break; }
    round = []; for (let i = 0; i < winners.length; i += 2) round.push([winners[i], winners[i + 1]]);
  }
}

// ---- hunt: find a challenger seed that DEFEATS a target seed, DISK-FREE ---------------------------------------------
// A "probe" pits one candidate against the target: candidate = A, target = B. An existing candidate loads its .pool;
// a NEW candidate (no .pool) is generated ENTIRELY IN MEMORY (genChampionInMemory) -> no timeline db is ever written.
// Only a killer's tiny champion .pool is persisted. The hunt runs probes in parallel across `cores` child processes.
const huntPath = () => join(jobsDir(), 'hunt-results.json');
// The COLLECTION of super-organisms: every seed that has ever defeated the litmus target, accumulated across hunt runs
// (deduped by seed, sorted strongest-first). Distinct from hunt-results.json (which is only the current run's scoreboard),
// so a fresh hunt never clobbers the growing collection. Each member's champion .pool is on disk (saved by --save-win).
const collectionPath = (target) => join(jobsDir(), `superorganisms-vs-seed${target}.json`);
function addToCollection(target, entry) {
  let coll = { target: Number(target), members: [] };
  try { const c = JSON.parse(readFileSync(collectionPath(target), 'utf8')); if (c && Array.isArray(c.members)) coll = c; } catch { /* fresh */ }
  if (!coll.members.some((m) => m.seed === entry.seed)) coll.members.push(entry);
  coll.members.sort((a, b) => b.margin - a.margin);
  coll.target = Number(target); coll.count = coll.members.length; coll.updated = new Date().toISOString();
  try { writeFileSync(collectionPath(target), JSON.stringify(coll, null, 2)); } catch { /* */ }
  return coll.members.length;
}

// run one probe as a child (clean JSON on stdout). --save-win makes the child persist the candidate's .pool iff it wins.
function probeChild(cand, target, { days, settings }) {
  return new Promise((resolve) => {
    const a = [SELF, 'probe', String(cand), String(target), '--days', String(days), '--json', '--save-win'];
    if (settings && Object.keys(settings).length) a.push('--settings', JSON.stringify(settings));
    const child = spawn(process.execPath, a, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } });
    let out = ''; child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    child.on('error', () => resolve(null));
  });
}

// A candidate DECISIVELY defeats the target when it is alive, the win isn't a <5% dead-heat, and it either drove the
// target extinct or simply out-populated it. margin = candidate - target at the end (higher = stronger challenge).
function verdictOf(res) {
  if (!res) return { margin: -Infinity, kill: false, note: 'ERR' };
  const a = res.final.a, b = res.final.b;
  const close = Math.max(a, b) > 0 && Math.abs(a - b) / Math.max(a, b) < 0.05;
  const kill = a > 0 && res.winner === 'A' && !close;      // candidate is A
  return { margin: a - b, kill, close, a, b, extinctTarget: b === 0 && a > 0, days: res.days, junkSim: res.junkSim };
}

async function runHunt({ target, cores = 5, days = 1, settings = {}, startNew = 51, maxNew = 1000, minutes = 0, newOnly = false }) {
  // ensure the target champion exists (extract from its timeline if needed).
  if (!existsSync(championPath(target))) { try { const r = await extractChampion(target); console.log(`extracted target champion seed-${target} (${r.count})${r.note || ''}`); } catch (e) { process.exit(usage(`target seed-${target}: ${e.message}`)); } }
  // Phase 1 candidates: every EXISTING champion (on disk) except the target -- fast, no re-gen, a definitive head-to-head.
  // --new-only skips Phase 1 (when the existing pool has already been swept and we only want fresh invented seeds).
  const existing = newOnly ? [] : readdirSync(championsDir()).map((f) => (f.match(/^seed-(\d+)\.pool$/) || [])[1]).filter(Boolean).map(Number)
    .filter((s) => s !== Number(target)).sort((x, y) => x - y);
  const t0 = Date.now();
  const deadline = minutes > 0 ? t0 + minutes * 60000 : Infinity;
  const state = { target: Number(target), days, cores, startedAt: new Date().toISOString(), tested: 0, killers: [], top: [], phase: 1 };
  const record = (cand, v, phase) => {
    state.tested++;
    const row = { seed: cand, phase, margin: v.margin, a: v.a, b: v.b, kill: v.kill, extinctTarget: v.extinctTarget, days: v.days, junkSim: v.junkSim };
    if (v.kill) { state.killers.push(row); const n = addToCollection(target, { seed: cand, a: v.a, b: v.b, margin: v.margin, extinctTarget: v.extinctTarget, days: v.days, junkSim: v.junkSim, foundAt: new Date().toISOString() }); console.log(`  🏆 KILLER #${n}: seed-${cand} DEFEATS seed-${target}  (${v.a}-${v.b}${v.extinctTarget ? ', target EXTINCT' : ''}, ${(v.days || 0).toFixed(2)}d) -> collection now ${n}`); }
    state.top.push(row); state.top.sort((p, q) => q.margin - p.margin); state.top = state.top.slice(0, 25);
    state.elapsedMin = Math.round((Date.now() - t0) / 60000);
    try { writeFileSync(huntPath(), JSON.stringify(state, null, 2)); } catch { /* */ }
  };

  console.log(`HUNT: find a seed that defeats seed-${target}. ${cores} cores, ${days}-day probes. Phase 1 = ${existing.length} existing champions; Phase 2 = new seeds from ${startNew} (disk-free, in-memory). Live -> ${huntPath()}. Collection -> ${collectionPath(target)}`);

  // shared candidate cursor: first drain Phase-1 existing seeds, then hand out fresh seed numbers for Phase 2.
  let p1 = 0, next = startNew, testedNew = 0, stop = false;
  const nextCand = () => {
    if (Date.now() >= deadline) { stop = true; return null; }
    if (p1 < existing.length) return { cand: existing[p1++], phase: 1 };
    if (testedNew >= maxNew) { stop = true; return null; }
    testedNew++; state.phase = 2; return { cand: next++, phase: 2 };
  };

  const worker = async () => {
    while (!stop) {
      const job = nextCand();
      if (!job) break;
      const res = await probeChild(job.cand, target, { days, settings });
      const v = verdictOf(res);
      console.log(`[${state.tested + 1}] (P${job.phase}) seed-${job.cand} vs seed-${target} -> ${v.kill ? 'WIN' : v.margin === -Infinity ? 'ERR' : v.margin >= 0 ? 'edge' : 'loss'} (${v.a}-${v.b}, ${(v.days || 0).toFixed(2)}d)`);
      record(job.cand, v, job.phase);
    }
  };
  await Promise.all(Array.from({ length: cores }, worker));

  state.final = true; state.elapsedMin = Math.round((Date.now() - t0) / 60000);
  try { writeFileSync(huntPath(), JSON.stringify(state, null, 2)); } catch { /* */ }
  console.log(`\n=== HUNT DONE: tested ${state.tested} in ${state.elapsedMin} min ===`);
  if (state.killers.length) {
    console.log(`${state.killers.length} seed(s) DEFEAT seed-${target}:`);
    state.killers.sort((p, q) => q.margin - p.margin).forEach((k) => console.log(`  seed-${k.seed} (${k.a}-${k.b}${k.extinctTarget ? ', target extinct' : ''}, margin +${k.margin}) -> champion saved`));
  } else {
    console.log(`NONE defeated seed-${target}. Closest challengers (candidate - target):`);
    state.top.slice(0, 5).forEach((k) => console.log(`  seed-${k.seed}: ${k.a}-${k.b}  (margin ${k.margin >= 0 ? '+' : ''}${k.margin})`));
  }
}

// ---- CLI -----------------------------------------------------------------------------------------------------------
function usage(msg) { if (msg) console.error('error: ' + msg); console.error('usage:\n  compete champion <seed|all>\n  compete match <A> <B> [--days 1] [--ticks N] [--natural] [--json] [--settings JSON]\n  compete probe <candidate> <target> [--days 1] [--json] [--save-win] [--settings JSON]\n  compete hunt <target> [--cores 5] [--days 1] [--start-new 51] [--max-new N] [--minutes N] [--new-only] [--settings JSON]\n  compete tournament [--cores 5] [--days 1] [--matches 5] [--seeds a,b,..] [--settings JSON]\n  compete bracket [--seeds s1,..,s8] [--days 1] [--cores 4] [--settings JSON]   (default seeds = tournament top 8)'); return 2; }
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (k) => args.includes('--' + k);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };

if (cmd === 'champion') {
  const which = args[1];
  if (!which) process.exit(usage('champion needs <seed|all>'));
  const seeds = which === 'all'
    ? readdirSync(timelinesDir()).map((f) => (f.match(/^seed-(\d+)\.db$/) || [])[1]).filter(Boolean).map(Number).sort((x, y) => x - y)
    : [Number(which)];
  for (const s of seeds) { try { const r = await extractChampion(s); console.log(`seed-${s}: pool = ${r.count} creatures (whole population) @ tick ${r.tick}${r.note || ''} -> ${championPath(s)}`); } catch (e) { console.log(`seed-${s}: ${e.message}`); } }
} else if (cmd === 'match') {
  const A = args[1], B = args[2];
  if (!A || !B) process.exit(usage('match needs <A> <B>'));
  const days = opt('days') != null ? Number(opt('days')) : 1;
  const ticks = opt('ticks') != null ? Number(opt('ticks')) : null;
  let settings = {}; if (opt('settings')) { try { settings = JSON.parse(opt('settings')); } catch { process.exit(usage('--settings must be JSON')); } }
  const t0 = Date.now();
  const res = runMatch(A, B, { days, ticks, natural: flag('natural'), settings });
  if (flag('json')) { console.log(JSON.stringify(res, null, 2)); }
  else {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\nMATCH  seed-${res.a.seed} (A) vs seed-${res.b.seed} (B)   [${res.normalized ? `equal start N=${res.normN}` : 'natural sizes'}]`);
    console.log(`start:  A ${res.a.start}   B ${res.b.start}   arena food ${POOL_DEFAULTS.food}`);
    console.log(`pool similarity (junkSim): ${(res.junkSim * 100).toFixed(1)}%  ${res.interbreeds ? '⚠ >90% -> they INTERBREED; teams blend, verdict is suspect' : '(<90% -> reproductively isolated, clean contest)'}`);
    console.log(`ran ${res.days.toFixed(2)} day(s)${res.extinctTick != null ? ' (stopped early: a side went extinct)' : ''} in ${secs}s`);
    console.log(`final:  A ${res.final.a}   B ${res.final.b}${res.final.h ? `   hybrids ${res.final.h}` : ''}   cross-team births ${res.crossTeamBirths}`);
    console.log(`WINNER: ${res.winner === 'tie' ? 'TIE' : 'seed-' + (res.winner === 'A' ? res.a.seed : res.b.seed) + ' (' + res.winner + ')'}\n`);
  }
} else if (cmd === 'probe') {
  const cand = args[1], target = args[2];
  if (!cand || !target) process.exit(usage('probe needs <candidate> <target>'));
  const days = opt('days') != null ? Number(opt('days')) : 1;
  let settings = {}; if (opt('settings')) { try { settings = JSON.parse(opt('settings')); } catch { process.exit(usage('--settings must be JSON')); } }
  const chCand = resolveChampion(Number(cand));            // gen-in-memory if the candidate has no .pool (disk-free)
  const chTarget = loadChampion(Number(target));
  const res = runMatchCore(chCand, chTarget, { days, settings, quiet: true });
  const v = verdictOf(res);
  if (flag('save-win') && v.kill && !existsSync(championPath(chCand.seed))) { try { saveChampionObj(chCand); } catch { /* */ } }
  if (flag('json')) console.log(JSON.stringify(res));
  else console.log(`seed-${cand} vs seed-${target}: ${v.kill ? 'DEFEATS it' : 'loses'} (${v.a}-${v.b}, ${(v.days || 0).toFixed(2)}d)`);
} else if (cmd === 'hunt') {
  const target = args[1];
  if (!target) process.exit(usage('hunt needs <target>'));
  const cores = opt('cores') != null ? Number(opt('cores')) : 5;
  const days = opt('days') != null ? Number(opt('days')) : 1;
  const startNew = opt('start-new') != null ? Number(opt('start-new')) : 51;
  const maxNew = opt('max-new') != null ? Number(opt('max-new')) : 1000;
  const minutes = opt('minutes') != null ? Number(opt('minutes')) : 0;
  let settings = { foodReseedWhenEmpty: true };            // default: food reseeds -> real contests, not starvation races
  if (opt('settings')) { try { settings = JSON.parse(opt('settings')); } catch { process.exit(usage('--settings must be JSON')); } }
  await runHunt({ target: Number(target), cores, days, settings, startNew, maxNew, minutes, newOnly: flag('new-only') });
} else if (cmd === 'tournament') {
  const cores = opt('cores') != null ? Number(opt('cores')) : 5;
  const days = opt('days') != null ? Number(opt('days')) : 1;
  const matchesPer = opt('matches') != null ? Number(opt('matches')) : 5;
  let settings = { foodReseedWhenEmpty: true };   // default: food reseeds -> real contests, not starvation races
  if (opt('settings')) { try { settings = JSON.parse(opt('settings')); } catch { process.exit(usage('--settings must be JSON')); } }
  const seeds = opt('seeds') ? opt('seeds').split(',').map(Number) : null;
  await runTournament({ cores, days, matchesPer, settings, seeds });
} else if (cmd === 'bracket') {
  const days = opt('days') != null ? Number(opt('days')) : 1;
  const cores = opt('cores') != null ? Number(opt('cores')) : 4;
  let settings = { foodReseedWhenEmpty: true };
  if (opt('settings')) { try { settings = JSON.parse(opt('settings')); } catch { process.exit(usage('--settings must be JSON')); } }
  let seeds = opt('seeds') ? opt('seeds').split(',').map(Number) : null;
  if (!seeds) { try { const st = JSON.parse(readFileSync(standingsPath(), 'utf8')); seeds = st.table.slice(0, 8).map((r) => r.seed); } catch { process.exit(usage('no --seeds and no tournament standings to read the top 8 from')); } }
  await runBracket({ seeds, days, cores, settings });
} else {
  process.exit(usage(cmd ? `unknown command: ${cmd}` : null));
}
