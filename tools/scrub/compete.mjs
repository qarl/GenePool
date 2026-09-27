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
import { poolConfig, POOL_DEFAULTS, POOL_SETTINGS, mulberry32, diskPoint } from '../../engine/pool-seed.mjs';
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

// ---- the match -----------------------------------------------------------------------------------------------------
function runMatch(A, B, { days = 1, ticks = null, natural = false, settings = {} } = {}) {
  const chA = loadChampion(A), chB = loadChampion(B);
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
      process.stderr.write(`\r  day ${(t / TICKS_PER_DAY).toFixed(3)}  A ${String(c.a).padStart(4)}  B ${String(c.b).padStart(4)}  food ${String(c.food).padStart(4)}${c.h ? `  hybrid ${c.h}` : ''}   `);   // progress -> stderr so --json stdout stays pure
      if (c.a === 0 || c.b === 0) { extinctTick = t; break; }
    }
  }
  process.stderr.write('\n');
  const fin = count();
  const winner = fin.a === 0 && fin.b === 0 ? 'tie' : fin.a === 0 ? 'B' : fin.b === 0 ? 'A' : fin.a > fin.b ? 'A' : fin.b > fin.a ? 'B' : 'tie';
  // downsample the curve to ~120 points
  const step = Math.max(1, Math.ceil(curve.length / 120));
  const thin = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  return { a: { ref: String(A), seed: chA.seed, start: aList.length }, b: { ref: String(B), seed: chB.seed, start: bList.length },
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

// ---- CLI -----------------------------------------------------------------------------------------------------------
function usage(msg) { if (msg) console.error('error: ' + msg); console.error('usage:\n  compete champion <seed|all>\n  compete match <A> <B> [--days 1] [--ticks N] [--natural] [--json] [--settings JSON]\n  compete tournament [--cores 5] [--days 1] [--matches 5] [--seeds a,b,..] [--settings JSON]\n  compete bracket [--seeds s1,..,s8] [--days 1] [--cores 4] [--settings JSON]   (default seeds = tournament top 8)'); return 2; }
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
