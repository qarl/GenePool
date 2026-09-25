'use strict';
// gen-ctl end-to-end: start a directory of timelines in parallel, list them (frontier/days), stop them all, and
// confirm a second start on a live run is a no-op. Runs the real CLI as a subprocess against a temp GENEPOOL_USERDATA
// so it never touches the real registry. See docs/PLAN-generator-cli.md (v4.2).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const CLI = join(__dirname, '..', '..', 'tools', 'scrub', 'gen-ctl.mjs');
const RUNDB = join(__dirname, '..', '..', 'tools', 'events', 'run-db.mjs');
const RUNGEN = join(__dirname, '..', '..', 'tools', 'scrub', 'run-gen.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gen(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('gen-ctl start(dir, parallel) -> list -> stop all; a 2nd start on a live run is a no-op', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'gp-genctl-'));
  const env = { GENEPOOL_USERDATA: userData };
  const tlDir = join(userData, 'timelines');
  const { isWriterLive, readWriterInfo, clearWriterClaim, collapseToSingleFile } = await import(RUNDB);
  const { generateRun } = await import(RUNGEN);
  const dbs = [join(tlDir, 'seed-1.db'), join(tlDir, 'seed-2.db')];

  try {
    // Two REAL runs AT REST: founders present (resuming keeps them alive, not instant-extinct), finite + finish -> unowned,
    // and collapsed to a single file so isWriterLive is false -> `start` actually spawns (a fresh -wal would read as live -> adopt/skip).
    const { mkdirSync } = require('node:fs');
    mkdirSync(tlDir, { recursive: true });
    for (let i = 0; i < dbs.length; i++) { generateRun(dbs[i], i + 1, { ticks: 2000, settings: { fixBranchCategoryGene: true, evolvableMutationRate: true } }); collapseToSingleFile(dbs[i]); }

    // START the whole dir in parallel.
    const s = gen(env, 'start', tlDir);
    assert.equal(s.code, 0, s.out);

    // Both become live writers (poll the heartbeat).
    let live = 0;
    for (let i = 0; i < 60 && live < 2; i++) { live = dbs.filter((d) => isWriterLive(d)).length; if (live < 2) await sleep(200); }   // arrow: Array.filter passes the INDEX as isWriterLive's staleMs otherwise
    assert.equal(live, 2, `both generators should be live; out=\n${s.out}`);

    // LIST --json reports both, running, with a numeric frontier + days.
    const l = gen(env, 'list', '--json');
    assert.equal(l.code, 0, l.out);
    const rows = JSON.parse(l.out.slice(l.out.indexOf('[')));
    assert.equal(rows.length, 2, 'two rows');
    for (const r of rows) { assert.equal(r.running, true); assert.equal(typeof r.frontier, 'number'); assert.equal(typeof r.days, 'number'); }

    // A 2nd start on an already-live dir is a no-op (adopt, never a 2nd writer).
    const s2 = gen(env, 'start', tlDir);
    assert.match(s2.out, /already running/, 'second start must report already-running');

    // STOP all -> not live, folded to a single file (no -wal left).
    const st = gen(env, 'stop', 'all');
    assert.equal(st.code, 0, st.out);
    for (const db of dbs) {
      assert.equal(isWriterLive(db), false, `${db} still live after stop`);
      assert.equal(existsSync(db + '-wal'), false, `${db}-wal should be collapsed`);
    }
  } finally {
    // Hard cleanup: kill any detached survivor and WAIT until none is live, so no generator outlives the test
    // (a leaked detached child makes node --test exit non-zero). clearWriterClaim also fences any straggler into exiting.
    for (let i = 0; i < 40; i++) {
      const alive = dbs.filter((d) => isWriterLive(d));
      if (!alive.length) break;
      for (const db of alive) { try { const { pid } = readWriterInfo(db); if (pid) process.kill(pid, 'SIGKILL'); } catch { /* */ } try { clearWriterClaim(db); } catch { /* */ } }
      await sleep(150);
    }
    rmSync(userData, { recursive: true, force: true });
  }
});
