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
const { spawn, spawnSync } = require('node:child_process');

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
    assert.ok(run.run_id.startsWith('run-'));
    assert.equal(run.status, 'passed');
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

test('run cancel endpoint reports inactive runs clearly', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    const r = await fetch(base + '/api/run-cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-not-active' }),
    });
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /not active/);
  } finally {
    child.kill();
  }
});

test('flow authoring endpoints update markdown cells and graph refs', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });

    const configured = await post(base, '/api/cell-config', {
      ws: 'demo',
      nb: 'model-compare',
      id: 'reply-prompt',
      updates: { data: 'seeds', template: 'Rewrite: {{input}}', needs: '' },
    });
    const brief = configured.notebook.cells.find(c => c.id === 'reply-prompt');
    assert.equal(brief.config.data, 'seeds');
    assert.equal(brief.config.template, 'Rewrite: {{input}}');
    assert.ok(!('needs' in brief.config));

    const dup = await post(base, '/api/cell-duplicate', {
      ws: 'demo',
      nb: 'model-compare',
      id: 'concise',
      new_id: 'concise-copy',
    });
    assert.equal(dup.id, 'concise-copy');
    assert.ok(dup.notebook.cells.some(c => c.id === 'concise-copy'));

    const connected = await post(base, '/api/cell-connect', {
      ws: 'demo',
      nb: 'model-compare',
      from: 'concise-copy',
      to: 'compare',
    });
    assert.ok(connected.notebook.graph.deps.compare.includes('concise-copy'));
    const compare = connected.notebook.cells.find(c => c.id === 'compare');
    assert.ok(compare.config.candidates.includes('concise-copy'));

    const text = fs.readFileSync(path.join(root, 'projects', 'demo', '_bench', 'model-compare.bench.md'), 'utf8');
    assert.match(text, /id: concise-copy/);
    assert.match(text, /candidates:/);
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
    assert.deepEqual(empty.events, []);
    assert.deepEqual(empty.notebooks, []);
    assert.deepEqual(empty.models, []);

    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });
    const run = await post(base, '/api/run', { ws: 'demo', nb: 'model-compare' });
    assert.ok(run.ran.includes('compare'));

    const journal = await get(base, '/api/journal?ws=demo');
    assert.ok(journal.runs.length >= 1);
    assert.ok(journal.events.some(e => e.run_id === run.run_id && e.status === 'passed'));
    const entry = journal.runs[0];
    assert.ok(entry.run_id.startsWith('run-'));
    assert.equal(entry.notebook, 'model-compare');
    assert.equal(entry.cell, 'compare');
    assert.ok(['passed', 'partial', 'failed'].includes(entry.status));
    assert.ok(entry.n > 0);
    assert.ok(Array.isArray(entry.models) && entry.models.length >= 1);
    // latency passes through to candidates (fixture records 0; the field
    // must exist as number-or-null so the results view's card can read it)
    for (const c of entry.candidates) {
      assert.ok('latency_ms_mean' in c, 'candidate carries latency_ms_mean');
      assert.ok(c.latency_ms_mean === null || typeof c.latency_ms_mean === 'number');
    }
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

test('first-run onboarding: empty workspace offers the gallery; UI create matches the CLI scaffold', async () => {
  // standalone mode with a fresh dir → a genuinely empty workspace
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bench-onboard-'));
  const { child, base } = await startServer(root);
  try {
    const ws = path.basename(root);

    // empty-project behavior: no notebooks yet, but the bootstrap read already
    // carries the template gallery the onboarding wizard renders from
    const state = await get(base, '/api/state');
    assert.ok(Array.isArray(state.notebook_templates) && state.notebook_templates.length >= 6);
    for (const t of state.notebook_templates) {
      for (const k of ['id', 'title', 'description', 'default_name']) {
        assert.equal(typeof t[k], 'string', `template missing ${k}`);
      }
      assert.equal(typeof t.live, 'boolean');
      assert.ok(Array.isArray(t.required_env));
    }
    const nbs = await get(base, `/api/notebooks?ws=${encodeURIComponent(ws)}`);
    assert.deepEqual(nbs.notebooks, []);

    // the served page carries the onboarding entry points (goal, posture, create)
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /What are you testing\?/);
    assert.match(page, /ONBOARD_POSTURES/);
    assert.match(page, /createFromOnboarding/);

    // template-backed creation with a deterministic name — no network involved
    const created = await post(base, '/api/notebook-create', { ws, template: 'tool-agent', name: 'tool-agent' });
    assert.equal(created.name, 'tool-agent');
    const nb = await get(base, `/api/notebook?ws=${encodeURIComponent(ws)}&nb=tool-agent`);
    assert.ok(nb.cells.every(c => !c.error), 'every generated cell parses');
    assert.ok(nb.cells.some(c => c.type === 'note' && /tool/i.test(c.text || '')),
      'starter explains the workflow in notebook prose');
    assert.ok(nb.cells.some(c => c.type === 'agent'), 'starter uses ordinary bench cells');

    // UI path ≡ CLI path: same template + name → byte-identical notebooks
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bench-onboard-cli-'));
    try {
      const sc = spawnSync(process.execPath,
        [path.join(ROOT, 'bin', 'bench.js'), 'scaffold', 'tool-agent', '--name', 'tool-agent', '--dir', cliDir],
        { encoding: 'utf8' });
      assert.equal(sc.status, 0, sc.stderr);
      const viaUi = fs.readFileSync(path.join(root, '_bench', 'tool-agent.bench.md'), 'utf8');
      const viaCli = fs.readFileSync(path.join(cliDir, '_bench', 'tool-agent.bench.md'), 'utf8');
      assert.equal(viaUi, viaCli);
    } finally {
      fs.rmSync(cliDir, { recursive: true, force: true });
    }
  } finally {
    child.kill();
  }
});

test('notebook creation persists notes and duplicates without changing the source', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    await post(base, '/api/notebook-create', { ws: 'demo', template: 'tool-agent', name: 'source', notes: 'Check tool reliability.' });
    const sourcePath = path.join(root, 'projects', 'demo', '_bench', 'source.bench.md');
    const sourceBefore = fs.readFileSync(sourcePath, 'utf8');
    const copied = await post(base, '/api/notebook-create', {
      ws: 'demo', name: 'copy', copy_from: 'source', notes: 'Compare the copied workflow.',
    });
    assert.equal(copied.name, 'copy');
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBefore, 'source stays untouched');
    const copy = await get(base, '/api/notebook?ws=demo&nb=copy');
    assert.equal(copy.meta.notebook, 'copy');
    assert.equal(copy.meta.title, 'copy');
    assert.equal(copy.meta.notes, 'Compare the copied workflow.');
    assert.deepEqual(copy.cells.map(c => c.type), (await get(base, '/api/notebook?ws=demo&nb=source')).cells.map(c => c.type));
  } finally {
    child.kill();
  }
});

test('notebook-meta endpoint: title/goal save + round-trip; other keys refused', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });

    // save both allowlisted keys in one shot
    const saved = await post(base, '/api/notebook-meta', {
      ws: 'demo', nb: 'model-compare',
      updates: { title: 'Support replies', goal: 'Pick the model that answers refunds best' },
    });
    assert.equal(saved.notebook.meta.title, 'Support replies');
    assert.equal(saved.notebook.meta.goal, 'Pick the model that answers refunds best');

    // the write went through parse → mutate meta → serialize: frontmatter on
    // disk carries goal:, and a fresh read parses it back (generic meta map)
    const file = path.join(root, 'projects', 'demo', '_bench', 'model-compare.bench.md');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^goal: Pick the model that answers refunds best$/m);
    assert.match(text, /^title: Support replies$/m);
    const reread = await get(base, '/api/notebook?ws=demo&nb=model-compare');
    assert.equal(reread.meta.goal, 'Pick the model that answers refunds best');
    // cells untouched by a meta write
    assert.ok(reread.cells.some(c => c.id === 'compare'));

    // clearing a key removes it from the frontmatter entirely
    const cleared = await post(base, '/api/notebook-meta', { ws: 'demo', nb: 'model-compare', updates: { goal: '' } });
    assert.ok(!('goal' in cleared.notebook.meta));
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^goal:/m);

    // non-allowlisted keys are refused (422) and write nothing
    const r = await fetch(base + '/api/notebook-meta', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ws: 'demo', nb: 'model-compare', updates: { notebook: 'hijack' } }),
    });
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /not editable/);
    assert.match(fs.readFileSync(file, 'utf8'), /^notebook: model-compare$/m);

    // slug guard: traversal-shaped notebook names never reach the filesystem
    const bad = await post(base, '/api/notebook-meta', { ws: 'demo', nb: '../escape', updates: { goal: 'x' } });
    assert.match(bad.error, /invalid notebook name/);
    assert.equal(fs.existsSync(path.join(root, 'projects', 'escape.bench.md')), false);
  } finally {
    child.kill();
  }
});

test('notebook-meta: a quoted goal survives repeated saves without backslash growth', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });
    const goal = 'say "hi" twice on path "C:\\tmp"';
    const file = path.join(root, 'projects', 'demo', '_bench', 'model-compare.bench.md');

    // two identical saves ride two full parse → serialize cycles; the second
    // must be a byte-level no-op or backslashes are accumulating on disk
    const first = await post(base, '/api/notebook-meta', { ws: 'demo', nb: 'model-compare', updates: { goal } });
    assert.equal(first.notebook.meta.goal, goal);
    const afterFirst = fs.readFileSync(file, 'utf8');
    const second = await post(base, '/api/notebook-meta', { ws: 'demo', nb: 'model-compare', updates: { goal } });
    assert.equal(second.notebook.meta.goal, goal);
    assert.equal(fs.readFileSync(file, 'utf8'), afterFirst);

    // and a fresh parse hands the exact value back to the UI
    const reread = await get(base, '/api/notebook?ws=demo&nb=model-compare');
    assert.equal(reread.meta.goal, goal);
  } finally {
    child.kill();
  }
});

test('server-side rewrites keep every interleaved prose note intact on disk', async () => {
  // Regression guard for bug-note-prose-roundtrip: the report said the demo's
  // six prose notes vanished from the .bench.md after any server rewrite
  // (verified non-repro 2026-07-18 — this pins it). Every edit endpoint rides
  // editNotebook's parse → mutate → serialize; notes must come out untouched.
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });
    const file = path.join(root, 'projects', 'demo', '_bench', 'model-compare.bench.md');
    const { parseNotebook } = require(path.join(ROOT, 'lib', 'notebook'));
    const notesOnDisk = () =>
      parseNotebook(fs.readFileSync(file, 'utf8')).cells.filter(c => c.type === 'note').map(c => c.text);

    const before = notesOnDisk();
    assert.equal(before.length, 6, 'the scaffolded demo has six prose notes');

    // one of each rewrite; after every write the notes on disk are byte-identical
    await post(base, '/api/cell-save', {
      ws: 'demo', nb: 'model-compare', id: 'brevity',
      raw: 'id: brevity\ntype: metric\nkind: expr\nexpr: output.length < 999 ? 1 : 0',
    });
    assert.deepEqual(notesOnDisk(), before, 'notes intact after cell-save');

    await post(base, '/api/cell-add', { ws: 'demo', nb: 'model-compare', type: 'metric', id: 'extra', after: 'brevity' });
    assert.deepEqual(notesOnDisk(), before, 'notes intact after cell-add');

    await post(base, '/api/cell-connect', { ws: 'demo', nb: 'model-compare', from: 'extra', to: 'compare' });
    assert.deepEqual(notesOnDisk(), before, 'notes intact after cell-connect');

    await post(base, '/api/notebook-meta', { ws: 'demo', nb: 'model-compare', updates: { title: 'Renamed', goal: 'Keep the prose' } });
    assert.deepEqual(notesOnDisk(), before, 'notes intact after notebook-meta');
  } finally {
    child.kill();
  }
});

test('layout endpoint round-trips notebook positions and refuses traversal-shaped names', async () => {
  const root = tmpRoot();
  const { child, base } = await startServer(root);
  try {
    await post(base, '/api/notebook-create', { ws: 'demo', demo: true });

    const empty = await get(base, '/api/layout?ws=demo&nb=model-compare');
    assert.equal(empty.layout, null);

    const saved = await post(base, '/api/layout', {
      ws: 'demo',
      nb: 'model-compare',
      layout: { positions: { seeds: { x: 96.2, y: 120.7 }, compare: { x: 456, y: 176 } } },
    });
    assert.deepEqual(saved.layout.positions.seeds, { x: 96, y: 121 });
    assert.ok(saved.layout.updated_at);

    const reread = await get(base, '/api/layout?ws=demo&nb=model-compare');
    assert.deepEqual(reread.layout.positions.compare, { x: 456, y: 176 });
    assert.ok(fs.existsSync(path.join(root, 'projects', 'demo', '_bench', 'layout', 'model-compare.json')));

    const reset = await post(base, '/api/layout', { ws: 'demo', nb: 'model-compare', reset: true });
    assert.equal(reset.layout, null);
    assert.ok(!fs.existsSync(path.join(root, 'projects', 'demo', '_bench', 'layout', 'model-compare.json')));

    // re-save so path-safety checks still have a layout dir context
    await post(base, '/api/layout', {
      ws: 'demo', nb: 'model-compare',
      layout: { positions: { seeds: { x: 8, y: 8 } } },
    });

    const bad = await fetch(base + '/api/layout?ws=demo&nb=../escape');
    assert.equal(bad.status, 500);
    assert.match((await bad.json()).error, /notebook name/);

    const badPost = await post(base, '/api/layout', {
      ws: 'demo',
      nb: '../escape',
      layout: { positions: { seeds: { x: 1, y: 2 } } },
    });
    assert.match(badPost.error, /notebook name/);
    assert.equal(fs.existsSync(path.join(root, 'projects', 'demo', '_bench', 'escape.json')), false);
  } finally {
    child.kill();
  }
});
