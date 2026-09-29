// build-page.mjs -- write the browsable POOL ATLAS page (<jobsDir>/atlas/index.html) from atlas.json + faces/*.png.
// Static + self-contained (inline CSS/JS/data; images by relative path) -> just `open` it. Top: a map of every pool
// (body-shape axes), coloured by family, killers + seed-3 marked. Below: one section per family (dendrogram order),
// named from what makes its bodies distinctive, each pool a tile: its main species' micrograph + minor species strip.
//   node tools/atlas/build-page.mjs && open "<jobsDir>/atlas/index.html"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { jobsDir } from '../scrub/gen-jobs.mjs';

const dir = join(jobsDir(), 'atlas');
const A = JSON.parse(readFileSync(join(dir, 'atlas.json'), 'utf8'));
let radii = {}; try { radii = JSON.parse(readFileSync(join(dir, 'radii.json'), 'utf8')); } catch { /* */ }
const F = A.features;

// family descriptors: z-score each feature over all main faces, name a family by its 2-3 most extreme mean z's
const main = A.data.filter((p) => p.species.length);
const mu = {}, sd = {};
for (const k of F) { const v = main.map((p) => p.species[0].face.body[k]); mu[k] = v.reduce((a, b) => a + b, 0) / v.length; sd[k] = Math.sqrt(v.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / (v.length - 1)) || 1; }
const WORDS = { reach: ['short', 'long'], segs: ['few-segmented', 'many-segmented'], width: ['slender', 'stout'], widthSpread: ['even-bodied', 'knob-and-whip'],
  taper: ['tapering', 'club-tipped'], cap: ['blunt-tipped', 'round-tipped'], limbFrac: ['body-heavy', 'limby'], branches: ['unbranched', 'branched'],
  depth: ['shallow-limbed', 'deeply branched'], splay: ['tight-limbed', 'splayed'], symmetry: ['lopsided', 'paired-limbed'],
  green: ['', 'greenish'], blue: ['', 'bluish'], contrast: ['plain', 'banded'], hair: ['bald', 'hairy'],
  freq: ['slow-beating', 'fast-beating'], amp: ['gentle-stroke', 'big-stroke'], turn: ['steady', 'twisting'] };
const GROUP = { reach: 'size', segs: 'size', width: 'shape', widthSpread: 'shape', taper: 'shape', cap: 'shape', limbFrac: 'structure', branches: 'structure',
  depth: 'structure', splay: 'structure', symmetry: 'structure', green: 'colour', blue: 'colour', contrast: 'colour', hair: 'texture', freq: 'motion', amp: 'motion', turn: 'motion' };
const word = (k, v) => (WORDS[k] || ['', ''])[v > 0 ? 1 : 0];
const famName = (fi) => {
  const ps = main.filter((p) => p.family === fi);
  const z = F.map((k) => [k, ps.reduce((s, p) => s + (p.species[0].face.body[k] - mu[k]) / sd[k], 0) / ps.length])
    .filter(([k, v]) => word(k, v)).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const picked = [], seen = new Set();
  for (const [k, v] of z) { if (picked.length >= 3 || Math.abs(v) < 0.35) break; if (seen.has(GROUP[k])) continue; seen.add(GROUP[k]); picked.push(word(k, v)); }
  return picked.length ? picked.join(', ') : 'middle-of-the-road';
};
// map axis captions from the signed feature correlations: [low-end words, high-end words]
const axisEnds = (ax) => { const lo = [], hi = []; for (const [k, c] of A.mapAxes[ax].slice(0, 2)) { if (word(k, c)) hi.push(word(k, c)); if (word(k, -c)) lo.push(word(k, -c)); } return [lo.join(', '), hi.join(', ')]; };
const AX = [axisEnds(0), axisEnds(1)];
const fams = A.familySummary.map((f) => ({ ...f, name: famName(f.family) }));

// slim per-pool data for the page (no genomes)
const slim = A.data.filter((p) => p.species.length).map((p) => ({ seed: p.seed, family: p.family, order: p.order, map: p.map, day: p.day, peak: p.peak,
  living: p.living, killer: p.killer, vs3: p.vs3, league: p.league ? { rank: p.league.rank, pts: p.league.pts, w: p.league.w, d: p.league.d, l: p.league.l } : null,
  anim: existsSync(join(dir, 'anim', `seed-${p.seed}.mp4`)),
  sp: p.species.map((s, i) => ({ n: s.count, share: +s.share.toFixed(3), sig: s.sig, parts: s.face.body.parts, r: (radii[`${p.seed}-${i}`] || {}).radius || null })) }));
const nKill = slim.filter((p) => p.killer).length;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pool Atlas</title>
<style>
:root{--bg:#f4f3ef;--ink:#1f2328;--mute:#6b6f76;--line:#dcdad3;--card:#fff;--kill:#c2410c;--self:#1d4ed8;--starve:#7c3aed}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15171a;--ink:#e8e6e1;--mute:#9a9ea5;--line:#2c2f34;--card:#1d2024;--kill:#fb923c;--self:#93c5fd;--starve:#c4b5fd}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:28px 24px 8px;max-width:1400px;margin:auto}h1{margin:0 0 4px;font-size:26px;letter-spacing:-.01em}
.sub{color:var(--mute)}.wrap{max-width:1400px;margin:auto;padding:0 24px 60px}
#map{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:16px 0 8px;position:relative}
#map svg{width:100%;height:auto;display:block}.axis{fill:var(--mute);font-size:11px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 0 22px;color:var(--mute);font-size:12px}.legend span{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.sw{width:11px;height:11px;border-radius:50%;display:inline-block}
section{margin:30px 0 0}section h2{font-size:17px;margin:0 0 2px}section .meta{color:var(--mute);font-size:12.5px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;scroll-margin-top:20px}
.tile.flash{outline:3px solid var(--kill)}.tile .main{width:100%;aspect-ratio:1;display:block;background:#cfccc4;object-fit:cover}
.info{padding:7px 9px 9px}.row{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.seed{font-weight:650;font-size:15px}.plate{display:inline-flex;border-radius:3px;overflow:hidden}.plate i{display:inline-block;width:13px;height:17px;font:600 10.5px/17px ui-monospace,Menlo,monospace;text-align:center;font-style:normal;color:#111}.plate.mini{display:flex;margin:2px 0 1px}.plate.mini i{flex:1;width:auto;height:6px;font-size:0}.sig{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--mute)}
.badges{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0}.b{font-size:10.5px;padding:1px 6px;border-radius:9px;border:1px solid var(--line);color:var(--mute)}
.b.kill{background:var(--kill);border-color:var(--kill);color:#fff;font-weight:600}.b.self{border-color:var(--self);color:var(--self);font-weight:600}.b.starve{border-color:var(--starve);color:var(--starve)}
.stats{font-size:11.5px;color:var(--mute)}.minor{display:flex;gap:3px;margin-top:6px}.minor figure{margin:0;flex:0 0 calc((100% - 12px) / 5);min-width:0}
.minor img{width:100%;aspect-ratio:1;display:block;border-radius:4px;background:#cfccc4}.minor figcaption{font-size:9.5px;color:var(--mute);text-align:center}
.cmd{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--mute);margin-top:5px;user-select:all}
#tip{position:fixed;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px;display:none;font-size:12px;z-index:9;box-shadow:0 6px 18px #0003}
#tip img{width:120px;height:120px;display:block;border-radius:5px}
@media (max-width:600px){header,.wrap{padding-left:16px;padding-right:16px}.grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}
</style></head><body>
<header><h1>Pool Atlas</h1>
<div class="sub">${slim.length} pools, each one seed's population evolved for a day (or at its peak, if it starved first) · ${fams.length} body-plan families · ${nKill} seed-3 killers</div></header>
<div class="wrap">
<div id="map"></div>
<div class="legend" id="legend"></div>
<div class="sub" style="font-size:12.5px">The map lives in <b>plate space</b> — the same five frozen body coordinates that every species' plate is made from — so look-alikes land together and carry similar plates.
Horizontal tracks ${A.mapAxes[0].map((a) => a[0]).join(' / ')} (${Math.round(A.mapVariance[0] * 100)}%), vertical tracks ${A.mapAxes[1].map((a) => a[0]).join(' / ')} (${Math.round(A.mapVariance[1] * 100)}%).
Families are compact clusters in that body space (silhouette ≈ ${Math.max(...Object.values(A.silhouette || { x: 0 })).toFixed(2)}: real neighbourhoods, soft edges — body plans form a continuum). Click a dot to jump to its tile.</div>
<div id="fams"></div></div><div id="tip"></div>
<script>
const D=${JSON.stringify(slim)}, FAMS=${JSON.stringify(fams)}, AX=${JSON.stringify(AX)};
const PAL=['#2563eb','#16a34a','#d97706','#db2777','#0891b2','#7c3aed','#65a30d','#dc2626','#0d9488','#9333ea','#ca8a04','#475569'];
const col=f=>PAL[f%PAL.length];
const face=(s,i)=>'faces/seed-'+s+'-'+i+'.png';
// ---- map ----
(function(){const W=1000,H=440,pad=36,xs=D.map(p=>p.map[0]),ys=D.map(p=>p.map[1]);
const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
const X=v=>pad+(v-x0)/(x1-x0)*(W-2*pad),Y=v=>H-pad-(v-y0)/(y1-y0)*(H-2*pad);
let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="map of pools by body shape">';
s+='<text class="axis" x="'+(W/2)+'" y="'+(H-8)+'" text-anchor="middle">'+AX[0][0]+'  ←        →  '+AX[0][1]+'</text>';
s+='<text class="axis" transform="translate(12,'+(H/2)+') rotate(-90)" text-anchor="middle">'+AX[1][0]+'  ←        →  '+AX[1][1]+'</text>';
const sorted=[...D].sort((a,b)=>(a.killer||a.vs3&&a.vs3.self)-(b.killer||b.vs3&&b.vs3.self));
for(const p of sorted){const cx=X(p.map[0]),cy=Y(p.map[1]),self=p.vs3&&p.vs3.self;
 if(p.killer)s+='<circle cx="'+cx+'" cy="'+cy+'" r="10" fill="none" stroke="var(--kill)" stroke-width="2.5"/>';
 if(self)s+='<rect x="'+(cx-9)+'" y="'+(cy-9)+'" width="18" height="18" fill="none" stroke="var(--self)" stroke-width="2.5"/>';
 s+='<circle data-seed="'+p.seed+'" cx="'+cx+'" cy="'+cy+'" r="'+(p.killer||self?6:4.5)+'" fill="'+col(p.family)+'" fill-opacity=".85" stroke="var(--card)" stroke-width="1" style="cursor:pointer"/>';
 if(p.killer||self)s+='<text x="'+(cx+12)+'" y="'+(cy+4)+'" font-size="11" font-weight="600" fill="'+(self?'var(--self)':'var(--kill)')+'">'+p.seed+'</text>';}
document.getElementById('map').innerHTML=s+'</svg>';
const tip=document.getElementById('tip');
document.getElementById('map').addEventListener('mousemove',e=>{const t=e.target.closest('circle[data-seed]');if(!t){tip.style.display='none';return;}
 const p=D.find(q=>q.seed==t.dataset.seed);tip.innerHTML='<img src="'+face(p.seed,0)+'" alt=""><div><b>seed-'+p.seed+'</b> · '+FAMS[p.family].name+'</div>';
 tip.style.display='block';tip.style.left=Math.min(e.clientX+14,innerWidth-150)+'px';tip.style.top=(e.clientY+14)+'px';});
document.getElementById('map').addEventListener('mouseleave',()=>tip.style.display='none');
document.getElementById('map').addEventListener('click',e=>{const t=e.target.closest('circle[data-seed]');if(!t)return;const el=document.getElementById('seed-'+t.dataset.seed);
 el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),1600);});
document.getElementById('legend').innerHTML=FAMS.map(f=>'<span onclick="document.getElementById(\\'fam-'+f.family+'\\').scrollIntoView({behavior:\\'smooth\\'})"><i class="sw" style="background:'+col(f.family)+'"></i>'+(f.family+1)+'. '+f.name+' ('+f.size+')</span>').join('')
 +'<span><i class="sw" style="border:2.5px solid var(--kill)"></i>seed-3 killer</span><span><i class="sw" style="border:2.5px solid var(--self);border-radius:2px"></i>seed-3</span>';})();
// ---- families ----
const pct=v=>Math.round(v*100)+'%';
const ALPHA='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';   // same monotonic hue ramp as the app's plateHue (red 29 -> blue 264)
const plate=(sig,title,mini)=>!sig?'':'<span class="plate'+(mini?' mini':'')+'" title="'+(title||sig)+'">'+[...sig].map(c=>'<i style="background:oklch(0.78 0.13 '+(29+Math.max(0,ALPHA.indexOf(c))/35*235).toFixed(1)+')">'+(mini?'':c)+'</i>').join('')+'</span>';
document.getElementById('fams').innerHTML=FAMS.map(f=>{const ps=D.filter(p=>p.family===f.family).sort((a,b)=>a.order-b.order);
 return '<section id="fam-'+f.family+'"><h2><i class="sw" style="background:'+col(f.family)+'"></i> '+(f.family+1)+'. '+f.name+'</h2>'
 +'<div class="meta">'+ps.length+' pools'+(f.killers.length?' · killers: '+f.killers.map(s=>'seed-'+s).join(', '):'')+(ps.some(p=>p.vs3&&p.vs3.self)?' · includes seed-3':'')+'</div><div class="grid">'
 +ps.map(p=>{const m=p.sp[0],b=[];
  if(p.killer)b.push('<span class="b kill">beats seed-3 '+p.vs3.a+'–'+p.vs3.b+'</span>');
  else if(p.vs3&&p.vs3.self)b.push('<span class="b self">seed-3 (the litmus)</span>');
  else if(p.vs3)b.push('<span class="b">lost to seed-3 '+p.vs3.a+'–'+p.vs3.b+'</span>');
  if(p.peak)b.push('<span class="b starve">starves itself @'+p.day.toFixed(2)+'d</span>');
  if(p.league)b.push('<span class="b">league #'+p.league.rank+' · '+p.league.pts+'pts</span>');
  return '<div class="tile" id="seed-'+p.seed+'">'+(p.anim?'<video class="main" muted loop playsinline preload="none" poster="anim/seed-'+p.seed+'.jpg" data-src="anim/seed-'+p.seed+'.mp4" aria-label="seed-'+p.seed+' main species swimming"></video>':'<img class="main" loading="lazy" src="'+face(p.seed,0)+'" alt="seed-'+p.seed+' main species">')
  +'<div class="info"><div class="row"><span class="seed">seed-'+p.seed+'</span>'+plate(m.sig,'plate (same as the app species list)')+'</div>'
  +'<div class="badges">'+b.join('')+'</div>'
  +'<div class="stats">'+p.living+' alive · '+p.sp.length+(p.sp.length>=6?'+':'')+' species · main '+pct(m.share)+' · '+m.parts+' segments</div>'
  +(p.sp.length>1?'<div class="minor">'+p.sp.slice(1).map((s,i)=>'<figure><img loading="lazy" src="'+face(p.seed,i+1)+'" alt="" title="'+s.sig+' · '+s.n+' ('+pct(s.share)+')"><figcaption>'+plate(s.sig,'',true)+pct(s.share)+'</figcaption></figure>').join('')+'</div>':'')
  +'<div class="cmd" title="open this seed in the app">GP_SEED='+p.seed+'</div></div></div>';}).join('')+'</div></section>';}).join('');
// ---- animation: only tiles on screen load + play; off-screen ones pause (keeps decode load to ~a screenful) ----
const io=new IntersectionObserver(es=>{for(const e of es){const v=e.target;
 if(e.isIntersecting){if(!v.src)v.src=v.dataset.src;v.play().catch(()=>{});}else if(!v.paused)v.pause();}},{rootMargin:'120px 0px'});
document.querySelectorAll('video.main').forEach(v=>io.observe(v));
</script></body></html>`;
writeFileSync(join(dir, 'index.html'), html);
console.log(`atlas page -> ${join(dir, 'index.html')}  (${fams.length} families)`);
for (const f of fams) console.log(`  ${f.family + 1}. ${f.name} (${f.size})${f.killers.length ? '  killers: ' + f.killers.join(',') : ''}`);
