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
