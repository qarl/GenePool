// PCA over the extracted species-rep genomes (expressed genes [0,83)). Dependency-free: covariance + power-iteration
// with deflation for the top-K components (top-K needs no full eigensolver; total variance = trace(C)). Writes basis.json
// and reports variance-explained.
//   node tools/pca/pca.mjs <dataDir> [K]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.argv[2] || '.', K = Number(process.argv[3] ?? 5);
const D = 83;   // expressed dimensions [0,83)

// gather one vector per species-rep across all seed files
const X = [];
let seeds = 0;
for (const f of readdirSync(dataDir)){
  if (!/^seed-\d+\.json$/.test(f)) continue; seeds++;
  const j = JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
  for (const s of j.species) if (s.exp?.length === D) X.push(Float64Array.from(s.exp));
}
const M = X.length;
if (M < D) console.warn(`WARNING: only ${M} samples for ${D} dims — components will be noisy (want M >> D).`);

// center
const mean = new Float64Array(D);
for (const v of X) for (let k=0;k<D;k++) mean[k]+=v[k];
for (let k=0;k<D;k++) mean[k]/=M;
const Xc = X.map(v => { const c=new Float64Array(D); for (let k=0;k<D;k++) c[k]=v[k]-mean[k]; return c; });

// covariance C = Xc^T Xc / (M-1)  (D x D, symmetric)
const C = Array.from({length:D}, () => new Float64Array(D));
for (const c of Xc) for (let i=0;i<D;i++){ const ci=c[i]; if (!ci) continue; const row=C[i]; for (let j=i;j<D;j++) row[j]+=ci*c[j]; }
for (let i=0;i<D;i++) for (let j=i;j<D;j++){ C[i][j]/=(M-1); C[j][i]=C[i][j]; }
let totalVar = 0; for (let i=0;i<D;i++) totalVar += C[i][i];   // trace = sum of all eigenvalues = total variance

// power iteration + deflation for the top-K eigenpairs of the (deflated) covariance
const rng = (s=>{let a=s>>>0;return()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};})(12345);
const matVec = (A,v) => { const r=new Float64Array(D); for (let i=0;i<D;i++){ let s=0; const Ai=A[i]; for (let j=0;j<D;j++) s+=Ai[j]*v[j]; r[i]=s; } return r; };
const dot = (a,b)=>{ let s=0; for (let i=0;i<D;i++) s+=a[i]*b[i]; return s; };
const A = C.map(r => Float64Array.from(r));   // deflate a copy
const comps = [];
for (let c=0;c<K;c++){
  let v = new Float64Array(D); for (let i=0;i<D;i++) v[i]=rng()-0.5; let n=Math.sqrt(dot(v,v)); for (let i=0;i<D;i++) v[i]/=n;
  let val=0;
  for (let it=0; it<2000; it++){
    const Av = matVec(A,v); const nn=Math.sqrt(dot(Av,Av)); if (nn<1e-14) break;
    for (let i=0;i<D;i++) Av[i]/=nn;
    const conv = Math.abs(dot(Av,v)); for (let i=0;i<D;i++) v[i]=Av[i];
    if (conv > 1-1e-12) break;
  }
  val = dot(v, matVec(A,v));                                 // Rayleigh quotient = eigenvalue
  // sign convention: largest-|component| element positive -> reproducible basis
  let mi=0; for (let i=1;i<D;i++) if (Math.abs(v[i])>Math.abs(v[mi])) mi=i;
  if (v[mi] < 0) for (let i=0;i<D;i++) v[i]=-v[i];
  comps.push({ value: val, vector: Array.from(v) });
  for (let i=0;i<D;i++) for (let j=0;j<D;j++) A[i][j] -= val*v[i]*v[j];   // deflate
}

const explained = comps.reduce((s,c)=>s+c.value,0)/totalVar;
const basis = {
  dims: D, samples: M, seeds, totalVariance: totalVar,
  varianceExplained: explained,
  perComponent: comps.map(c => ({ variance: c.value, fraction: c.value/totalVar, std: Math.sqrt(Math.max(0,c.value)) })),
  mean: Array.from(mean),
  components: comps.map(c => c.vector),
  scales: comps.map(c => Math.sqrt(Math.max(1e-9,c.value))),   // per-axis projection std -> use to quantize coeff -> symbol
};
writeFileSync(join(dataDir, 'basis.json'), JSON.stringify(basis, null, 1));
console.log(`PCA over ${M} species-reps from ${seeds} seeds (${D} expressed dims):`);
console.log(`  total variance ${totalVar.toFixed(1)}`);
comps.forEach((c,i)=>console.log(`  PC${i+1}: var ${c.value.toFixed(1)}  (${(100*c.value/totalVar).toFixed(1)}%)  std ${Math.sqrt(c.value).toFixed(1)}`));
console.log(`  TOP-${K} EXPLAIN ${(100*explained).toFixed(1)}% of total genome variance`);
console.log(`  -> ${join(dataDir,'basis.json')}`);
