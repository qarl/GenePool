// PCA dataset extractor: build the viewer's EXACT world for one seed, run `ticks`, then emit the most-representative
// individual (member closest to its EXPRESSED-gene centroid) of EVERY species with count >= MIN_SPECIES. One JSON file
// per seed. Uses the single-thread reference engine; the batch runner spreads seeds across cores (embarrassingly parallel).
//   node tools/pca/extract-seed.mjs <seed> <ticks> <outDir>
import { World } from '../../engine/world.js';
import { Genotype } from '../../engine/genotype.js';
import { writeFileSync } from 'node:fs';

const NUM_GENES = 256, USED = 112, EXPRESSED = 83, YOUNG_AGE = 1000, MAX_LIFESPAN = 40000, SPECIES_ISO = 0.9, SPECIES_K = 50;
const MIN_SPECIES = 5;   // ignore transient tiny clusters (noise) when sampling reps
const seed = Number(process.argv[2] ?? 1), TICKS = Number(process.argv[3] ?? 200000), outDir = process.argv[4] || '.';
const mulberry32 = s => { let a=s>>>0; return () => { a|=0; a=(a+0x6D2B79F5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; };
const diskPoint = (rng,cx,cy,r) => { const rad=2*Math.PI*rng(), mag=r*Math.sqrt(rng()); return { x:cx+Math.cos(rad)*mag, y:cy+Math.sin(rad)*mag }; };

const POOL = 3000;
const config = { maximumLifeSpan: MAX_LIFESPAN, numFoodTypes: 1, childEnergyRatio: 0.5, hungerThreshold: 50,
  crossoverRate: 0.2, mutationRate: 0.01, foodRegenerationPeriod: 20, foodSpread: POOL/2, foodBitEnergy: 50,
  attractionCriterion: 10, maxPopulation: 2000, maxFood: 2000, viewRadius: 300, reproductiveIsolation: SPECIES_ISO,
  pool: { left:0, top:0, right:POOL, bottom:POOL } };
const world = new World(config, seed, {});
const rng = mulberry32((seed>>>0) ^ 0x5eed1234);
for (let i=0;i<220;i++){
  const g = new Genotype(); g.randomize(rng);
  const genes = g.getGenes().slice(); for (let k=USED;k<NUM_GENES;k++) genes[k]=0;   // junk-zeroed (JJ's rule) -> one species at t0
  const p = diskPoint(rng, POOL/2, POOL/2, POOL/2.4);
  const age = YOUNG_AGE + Math.floor((MAX_LIFESPAN-YOUNG_AGE)*rng());
  world.loadSwimbot(i, { age, x:p.x, y:p.y, angle: rng()*360-180, energy: 50, genes });
}
for (let i=0;i<700;i++){ const p = diskPoint(rng, POOL/2, POOL/2, POOL/2.2); world.loadFood(i, { x:p.x, y:p.y, type:0, energy:50 }); }

for (let t=0;t<TICKS;t++) world.tick();

// cluster living grown bots by junk similarity (the engine gate); then per species emit the individual closest to the
// species' EXPRESSED-gene centroid (the most typical BODY of that species).
const NJ = NUM_GENES - USED;
const junkOf = sb => { const g = sb.getGenotype(); const a = new Float64Array(NJ); for (let k=0;k<NJ;k++) a[k]=g.getGeneValue(USED+k); return a; };
const junkSim = (a,b) => { let d=0; for (let k=0;k<NJ;k++) d+=Math.abs(a[k]-b[k]); return 1-(d/256)/NJ; };
const expOf = sb => { const g = sb.getGenotype(); const a = new Float64Array(EXPRESSED); for (let k=0;k<EXPRESSED;k++) a[k]=g.getGeneValue(k); return a; };
const reps = [];
let living = 0;
for (const [id, sb] of world._swimbots){
  if (!sb.getAlive()) continue; living++; const ph = sb._phenotype; if (!ph || ph.numParts <= 1) continue;
  const jg = junkOf(sb); let best=null, bestS=SPECIES_ISO;
  for (const r of reps){ const s=junkSim(jg,r.seed); if (s>bestS){ bestS=s; best=r; } }
  if (best) best.members.push({ sb, jg });
  else if (reps.length<SPECIES_K) reps.push({ seed: jg, members: [{ sb, jg }] });
  else { let nb=reps[0], ns=-1; for (const r of reps){ const s=junkSim(jg,r.seed); if (s>ns){ ns=s; nb=r; } } nb.members.push({ sb, jg }); }
}
const species = [];
for (const r of reps){
  if (r.members.length < MIN_SPECIES) continue;
  const c = new Float64Array(EXPRESSED); const exps = r.members.map(m => expOf(m.sb));
  for (const e of exps) for (let k=0;k<EXPRESSED;k++) c[k]+=e[k]; for (let k=0;k<EXPRESSED;k++) c[k]/=exps.length;
  let bi=0, bd=Infinity; for (let i=0;i<exps.length;i++){ let d=0; for (let k=0;k<EXPRESSED;k++){ const x=exps[i][k]-c[k]; d+=x*x; } if (d<bd){ bd=d; bi=i; } }
  species.push({ count: r.members.length, exp: Array.from(exps[bi]) });
}
species.sort((a,b)=>b.count-a.count);
writeFileSync(`${outDir}/seed-${seed}.json`, JSON.stringify({ seed, ticks: TICKS, living, species }));
process.stdout.write(`seed ${seed}: living=${living} species>=${MIN_SPECIES}: ${species.length} (largest ${species[0]?.count ?? 0})\n`);
