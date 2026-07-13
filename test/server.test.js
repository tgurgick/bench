'use strict';

// server.js API smoke test: boot the real server on an ephemeral port
// against a temp repo root, drive the demo notebook through the HTTP surface
// (create → run → edit → annotate → golden decisions), and assert the same
// invariants the UI depends on.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bench-srv-'));
  fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });
  return root;
}

async function startServer(root) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // `--port 0` isn't supported (parseInt gives 0 → ephemeral); read the actual
  // port from the startup line.
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + buf)), 8000);
    child.stdout.on('data', d => {
      buf += d;
      const m = buf.match(/localhost:(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.stderr.on('data', d => { buf += d; });
    child.on('exit', () => reject(new Error('server exited early: ' + buf)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function get(base, p) {
  const r = await fetch(base + p);
  return r.json();
}
async function post(base, p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

test('bench server drives the whole loop over HTTP', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    // bootstrap
    const state = await get(base, '/api/state');
    assert.ok(state.workspaces.some(w => w.name === 'demo'));
    assert.equal(state.providers[0].name, 'fixture');
    assert.ok(state.cell_types.includes('eval'));

    // scaffold the demo through the API
    const created = await post(base, '/api/notebook-create', { ws: 'demo', demo: true });
    assert.equal(created.name, 'model-compare');
    const nbs = await get(base, '/api/notebooks?ws=demo');
    assert.equal(nbs.notebooks.length, 1);

    // run everything
    const run = await post(base, '/api/run', { ws: 'demo', nb: 'model-compare' });
    assert.ok(run.ran.length >= 10);
    for (const [id, st] of Object.entries(run.notebook.state)) {
      assert.equal(st.error, null, `${id}: ${st.error}`);
    }
    const evalOut = run.notebook.state.compare.output;
    assert.equal(evalOut.summary.candidates.length, 2);

    // save a cell edit → downstream goes stale
    const saved = await post(base, '/api/cell-save', {
      ws: 'demo', nb: 'model-compare', id: 'brevity',
      raw: 'id: brevity\ntype: metric\nkind: expr\nexpr: output.length < 999 ? 1 : 0',
    });
    assert.equal(saved.notebook.state.brevity.stale, true);
    assert.equal(saved.notebook.state.compare.stale, true);

    // annotate one eval item and re-read the snapshot
    await post(base, '/api/annotate', { ws: 'demo', nb: 'model-compare', cell: 'review', item_id: 'r0-concise', label: 'good' });
    const rerun = await post(base, '/api/run', { ws: 'demo', nb: 'model-compare', cell: 'review', force: true });
    assert.equal(rerun.notebook.state.review.output.labeled, 1);

    // golden decisions through the API
    const goldens = await get(base, '/api/goldens?ws=demo&set=support-replies');
    assert.equal(goldens.rows.length, 4);
    const decided = await post(base, '/api/golden-decide', {
      ws: 'demo', set: 'support-replies',
      decisions: [{ id: goldens.rows[0]._id, status: 'approved' }],
    });
    assert.equal(decided.approved, 1);

    // add/delete cells
    const added = await post(base, '/api/cell-add', { ws: 'demo', nb: 'model-compare', type: 'metric', id: 'extra', after: 'brevity' });
    assert.ok(added.notebook.cells.some(c => c.id === 'extra'));
    const deleted = await post(base, '/api/cell-delete', { ws: 'demo', nb: 'model-compare', id: 'extra' });
    assert.ok(!deleted.notebook.cells.some(c => c.id === 'extra'));

    // guardrails: unknown workspace and traversal-shaped names are refused
    const bad = await post(base, '/api/run', { ws: '../../etc', nb: 'x' });
    assert.ok(bad.error);
    const bad2 = await post(base, '/api/notebook-create', { ws: 'demo', name: '../escape' });
    assert.match(bad2.error, /slug/);
  } finally {
    child.kill();
  }
});

test('unknown /api/ paths and missing resources are JSON 404s', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    // unknown API path: JSON { error }, never the plain-text 404
    const r = await fetch(base + '/api/nope');
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const d = await r.json();
    assert.equal(typeof d.error, 'string');

    // missing resources on real endpoints: 404 with the same shape
    const missingNb = await fetch(base + '/api/notebook?ws=demo&nb=missing');
    assert.equal(missingNb.status, 404);
    assert.match((await missingNb.json()).error, /not found/);
    const missingWs = await fetch(base + '/api/notebooks?ws=nope');
    assert.equal(missingWs.status, 404);
    assert.match((await missingWs.json()).error, /unknown workspace/);

    // outside /api/ the plain 404 stays — browsers hit these, not api()
    const plain = await fetch(base + '/nope');
    assert.equal(plain.status, 404);
  } finally {
    child.kill();
  }
});

test('a failed run leaves resyncable truth: GET /api/notebook carries partial progress', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });

    // break a mid-plan cell: tooluser becomes a config-error cell (compare's
    // own `candidates:` still points at it), so running `compare` executes
    // `seeds` first — topological order — then throws at tooluser
    await post(base, '/api/cell-save', {
      ws: 'demo', nb: 'model-compare', id: 'tooluser',
      raw: 'id: tooluser\ntype: bogus',
    });
    const r = await fetch(base + '/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: 'demo', nb: 'model-compare', cell: 'compare', force: true }),
    });
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /config error/);

    // the client contract: after a failed run, a notebook re-read reflects
    // what actually executed — seeds ran and is fresh, compare never did.
    // This is the state the UI must apply on its error path (no stale dots).
    const nb = await get(base, '/api/notebook?ws=demo&nb=model-compare');
    assert.ok(nb.state.seeds.ran_at, 'seeds executed before the failure');
    assert.equal(nb.state.seeds.stale, false);
    assert.equal(nb.state.seeds.error, null);
    assert.equal(nb.state.compare.ran_at, null, 'compare never executed');
    assert.equal(nb.state.compare.stale, true);
  } finally {
    child.kill();
  }
});

test('standalone mode: a root without projects/ is itself the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bench-solo-'));
  const { child, base } = await startServer(root);
  try {
    const state = await get(base, '/api/state');
    assert.deepEqual(state.workspaces, [{ name: path.basename(root), example: false }]);

    const ws = path.basename(root);
    const created = await post(base, '/api/notebook-create', { ws, demo: true });
    assert.equal(created.name, 'model-compare');
    const run = await post(base, '/api/run', { ws, nb: 'model-compare', cell: 'seeds' });
    assert.deepEqual(run.ran, ['seeds']);
    // artifacts land under the root itself — no projects/ layer
    assert.ok(fs.existsSync(path.join(root, '_bench', 'runs', 'model-compare', 'cells', 'seeds.json')));
  } finally {
    child.kill();
  }
});

test('GET /api/journal catalogues runs from bench-log; /api/journal/run returns results', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    // empty journal before any eval
    const empty = await get(base, '/api/journal?ws=demo');
    assert.deepEqual(empty.runs, []);
    assert.deepEqual(empty.notebooks, []);
    assert.deepEqual(empty.models, []);

    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });
    const run = await post(base, '/api/run', { ws: 'demo', nb: 'model-compare' });
    assert.ok(run.ran.includes('compare'));

    const journal = await get(base, '/api/journal?ws=demo');
    assert.ok(journal.runs.length >= 1);
    const entry = journal.runs[0];
    assert.ok(entry.run_id.startsWith('run-'));
    assert.equal(entry.notebook, 'model-compare');
    assert.equal(entry.cell, 'compare');
    assert.ok(['passed', 'partial', 'failed'].includes(entry.status));
    assert.ok(entry.n > 0);
    assert.ok(Array.isArray(entry.models) && entry.models.length >= 1);
    assert.ok(journal.notebooks.includes('model-compare'));
    assert.ok(journal.models.length >= 1);
    // catalogue is newest-first by run_id stamp
    for (let i = 1; i < journal.runs.length; i++) {
      assert.ok(journal.runs[i - 1].run_id >= journal.runs[i].run_id);
    }

    const detail = await get(base, `/api/journal/run?ws=demo&nb=model-compare&run=${encodeURIComponent(entry.run_id)}`);
    assert.equal(detail.run_id, entry.run_id);
    assert.ok(detail.summary);
    assert.ok(Array.isArray(detail.results) && detail.results.length > 0);
    assert.match(detail.results_path, /results\.jsonl$/);

    const missing = await fetch(base + '/api/journal/run?ws=demo&nb=model-compare&run=run-00000000000000');
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /not found/);
  } finally {
    child.kill();
  }
});
