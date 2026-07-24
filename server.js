#!/usr/bin/env node
// bench server — the notebook UI's backend. Zero dependencies (Node stdlib).
//
// GET serves the bench read-only; a small set of localhost POST actions run
// cells, save cell edits, record annotations, and decide golden rows. Trust
// model: binds 127.0.0.1 for a single local user, no auth; every
// caller-supplied path resolves through safePath so nothing escapes the
// workspace; the server executes only notebook cells via the engine — it
// never shells out and never spawns agents.
//
// Usage: node server.js [--port 4460] [--root <dir>] [--open]
//
// The root (default: cwd) decides the workspace model. Standalone, the root
// itself is one workspace and notebooks live in <root>/_bench/. Inside a
// throughline checkout — a root with a projects/ folder — each projects/<name>
// is a workspace, same convention as tl's cockpit UI.

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(arg('port', '4460'), 10);
const ROOT = path.resolve(arg('root', process.cwd()));

const { isDir, safeRead, safePath } = require('./lib/fsutil');
const { createBench } = require('./lib/engine');
const { createProviders } = require('./lib/providers');
const { scaffoldDemo } = require('./lib/demo');
const { listTemplates, scaffoldTemplate } = require('./lib/templates');
const { propose } = require('./lib/authoring');
const { parseNotebook, serializeNotebook, slugId, CELL_TYPES, REF_FIELDS } = require('./lib/notebook');

// ---------- journal (read-only run history from _metrics + eval artifacts) ----------

function readJsonlFile(file) {
  const out = [];
  for (const line of (safeRead(file) || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

function readJsonFile(file) {
  const t = safeRead(file);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function appendJsonlFile(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function runEventsFile(wsDir) {
  return path.join(wsDir, '_bench', 'run-events.jsonl');
}

// ---------- assisted authoring (proposal engine + corrections log) ----------

function authoringLogFile(wsDir) {
  return path.join(wsDir, '_bench', 'authoring-log.jsonl');
}

// keep only the fields the digest reads — proposed/kept rows are the
// training signal, not a dumping ground for arbitrary client JSON
function authoringChoices(v) {
  const src = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const k of ['goal', 'posture', 'template', 'name']) {
    if (src[k] != null && String(src[k]).trim() !== '') out[k] = String(src[k]).slice(0, 120);
  }
  return out;
}

// One append-only JSONL row per proposal-backed creation: what the engine
// proposed, what the human kept, and the provider that proposed it. The
// bench's own override-log (tl lineage): divergences are the training data
// the next proposal's digest learns from. Only creations that had a proposal
// log — a hand-built experiment has no proposed-vs-kept diff to learn from.
function recordAuthoring(wsDir, authoring, kept) {
  if (!authoring || typeof authoring !== 'object' || !authoring.proposed) return;
  appendJsonlFile(authoringLogFile(wsDir), {
    at: new Date().toISOString(),
    notes: String(authoring.notes || '').slice(0, 4000),
    proposed: authoringChoices(authoring.proposed),
    kept: authoringChoices(kept),
    provider: String(authoring.provider || 'offline').slice(0, 40),
  });
}

function recordRunEvent(wsDir, row) {
  appendJsonlFile(runEventsFile(wsDir), {
    at: new Date().toISOString(),
    ...row,
  });
}

// Group bench-log rows (one per candidate) into newest-first run cards.
function journalRuns(wsDir) {
  const rows = readJsonlFile(path.join(wsDir, '_metrics', 'bench-log.jsonl'));
  const events = readJsonlFile(runEventsFile(wsDir))
    .filter(e => e && e.run_id)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const byRun = new Map();
  for (const row of rows) {
    const id = row && row.run_id;
    if (!id) continue;
    if (!byRun.has(id)) byRun.set(id, []);
    byRun.get(id).push(row);
  }
  const runs = [];
  for (const [run_id, cands] of byRun) {
    const head = cands[0];
    const n = Math.max(...cands.map(c => Number(c.n) || 0), 0);
    const errors = cands.reduce((s, c) => s + (Number(c.errors) || 0), 0);
    const totalSlots = cands.reduce((s, c) => s + (Number(c.n) || 0), 0);
    let status = 'passed';
    if (totalSlots > 0 && errors >= totalSlots) status = 'failed';
    else if (errors > 0) status = 'partial';
    const winner = cands.find(c => c.winner) || cands[0];
    const score = winner && winner.judge_overall_mean != null
      ? winner.judge_overall_mean
      : firstMetric(winner && winner.metrics);
    const models = [...new Set(cands.map(c => modelLabel(c)).filter(Boolean))];
    runs.push({
      run_id,
      notebook: head.notebook,
      cell: head.cell,
      date: head.date || null,
      status,
      n,
      errors,
      score,
      models,
      candidates: cands.map(c => ({
        candidate: c.candidate,
        provider: c.provider,
        model: c.model,
        n: c.n,
        errors: c.errors,
        judge_overall_mean: c.judge_overall_mean,
        latency_ms_mean: typeof c.latency_ms_mean === 'number' ? c.latency_ms_mean : null,
        metrics: c.metrics,
        winner: Boolean(c.winner),
      })),
      results_path: `_bench/runs/${slugId(head.notebook)}/evals/${slugId(run_id)}/results.jsonl`,
    });
  }
  // newest-first: run id stamp is chronological; fall back to date string
  runs.sort((a, b) => String(b.run_id).localeCompare(String(a.run_id)));
  const notebookSet = new Set();
  const modelSet = new Set();
  for (const r of runs) {
    if (r.notebook) notebookSet.add(r.notebook);
    for (const m of r.models) modelSet.add(m);
  }
  return {
    runs,
    events,
    notebooks: [...notebookSet].sort(),
    models: [...modelSet].sort(),
  };
}

function modelLabel(c) {
  if (!c) return '';
  if (c.provider || c.model) return [c.provider, c.model].filter(Boolean).join('/');
  return c.candidate || '';
}

function firstMetric(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  for (const k of Object.keys(metrics)) {
    if (typeof metrics[k] === 'number') return metrics[k];
  }
  return null;
}

function journalRunDetail(wsDir, nb, runId) {
  const nbSlug = slugId(nb);
  const runSlug = slugId(runId);
  if (!nbSlug || !runSlug) throw new Error('invalid notebook or run id');
  const runDir = safePath(path.join(wsDir, '_bench', 'runs', nbSlug, 'evals'), runSlug);
  if (!runDir || !isDir(runDir)) throw new Error(`run not found: ${runId}`);
  const summary = readJsonFile(path.join(runDir, 'summary.json'));
  const results = readJsonlFile(path.join(runDir, 'results.jsonl'));
  return {
    run_id: runId,
    notebook: nb,
    cell: summary && summary.cell,
    created: summary && summary.created,
    data: summary && summary.data,
    rows: summary && summary.rows,
    candidates: summary && summary.candidates,
    metrics: (summary && summary.metrics) || [],
    judges: (summary && summary.judges) || [],
    summary: summary && summary.summary,
    results,
    results_path: `_bench/runs/${nbSlug}/evals/${runSlug}/results.jsonl`,
    summary_path: `_bench/runs/${nbSlug}/evals/${runSlug}/summary.json`,
  };
}

// Flow-canvas node positions — the only layout write, under _bench/layout/.
function layoutFile(wsDir, nb) {
  const nbSlug = slugId(nb);
  if (!nbSlug) throw new Error('invalid notebook name');
  const dir = path.join(wsDir, '_bench', 'layout');
  const file = safePath(dir, `${nbSlug}.json`);
  if (!file) throw new Error('invalid layout path');
  return file;
}

function readLayout(wsDir, nb) {
  const file = layoutFile(wsDir, nb);
  const data = readJsonFile(file);
  if (!data || !data.positions || typeof data.positions !== 'object') return { layout: null };
  return {
    layout: {
      positions: data.positions,
      updated_at: data.updated_at || null,
    },
  };
}

function writeLayout(wsDir, nb, layout) {
  const file = layoutFile(wsDir, nb);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = (layout && layout.positions) || {};
  const clean = {};
  if (raw && typeof raw === 'object') {
    for (const [id, pos] of Object.entries(raw)) {
      const cid = slugId(id);
      if (!cid || !pos || typeof pos !== 'object') continue;
      const x = Number(pos.x), y = Number(pos.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      clean[cid] = { x: Math.round(x), y: Math.round(y) };
    }
  }
  const updated_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ positions: clean, updated_at }, null, 2) + '\n');
  return { layout: { positions: clean, updated_at } };
}

function resetLayout(wsDir, nb) {
  const file = layoutFile(wsDir, nb);
  try { fs.unlinkSync(file); } catch { /* already absent */ }
  return { layout: null };
}

const providers = createProviders();
const activeRuns = new Map();
let runSeq = 0;

function nextRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  return `run-${stamp}-${++runSeq}`;
}

function requestRunId(v) {
  const id = slugId(v) || nextRunId();
  return id.startsWith('run-') ? id : `run-${id}`;
}

// ---------- workspaces ----------

function listWorkspaces() {
  const out = [];
  const projects = path.join(ROOT, 'projects');
  if (isDir(projects)) {
    for (const name of fs.readdirSync(projects).sort()) {
      if (isDir(path.join(projects, name))) out.push({ name, dir: path.join(projects, name), example: false });
    }
  }
  const sample = path.join(ROOT, 'examples', 'sample-project');
  if (isDir(sample)) out.push({ name: 'sample-project', dir: sample, example: true });
  // standalone mode: no projects/ layout → the root itself is the workspace
  if (!out.length) out.push({ name: path.basename(ROOT) || 'bench', dir: ROOT, example: false });
  return out;
}

function workspace(name) {
  const ws = listWorkspaces().find(w => w.name === name);
  if (!ws) throw new Error(`unknown workspace "${name}"`);
  return ws;
}

function benchFor(name) {
  return createBench({ wsDir: workspace(name).dir, providers });
}

// ---------- cell editing (file surgery through the parser, never string hacks) ----------

// Replace/insert/delete one cell in a notebook file. Edits go through
// parse → mutate the cell list → serialize, so a malformed edit can't corrupt
// neighboring cells; the worst case is one cell carrying an error marker.
function editNotebook(bench, nbName, fn) {
  const nb = bench.readNotebookFile(nbName);
  fn(nb);
  bench.writeNotebookFile(nbName, serializeNotebook(nb));
  return bench.readNotebook(nbName);
}

// a fresh cell's starter YAML, per type — enough structure to edit, not a wall
const CELL_TEMPLATES = {
  data: 'rows:\n  - input: "example input"\n    expected: "expected answer"',
  prompt: 'template: |\n  {{input}}',
  agent: 'provider: fixture\nmodel: fixture-1\ntemplate: |\n  {{input}}\nmax_turns: 4',
  metric: 'kind: exact_match',
  judge: 'kind: llm\nprovider: fixture\nscale: 5\ndimensions: [quality]\nrubric: |\n  Describe what a good output looks like.',
  golden: 'set: my-golden-set\ncount: 4\nprovider: fixture\nseeds:\n  - input: "example input"\n    expected: "expected answer"\ninstructions: Generate more examples like the seeds.',
  eval: 'data: my-data-cell\ncandidates: [my-agent-cell]\nmetrics: []\njudges: []',
  annotate: 'source: my-eval-cell\nlabels: [good, bad]',
  switch: '# input: my-data-cell\n# cases:\n#   - when: count > 0\n#     use: my-branch-cell\n# default: my-fallback-cell',
  map: '# input: my-data-cell\n# expr: "({ ...row })"',
  retry: '# target: my-agent-cell\n# attempts: 3',
  catch: '# try: my-agent-cell\n# fallback: my-fallback-cell',
  gate: '# input: my-agent-cell\n# expr: judgment.overall >= 3.5\n# loop:\n#   back_to: my-draft-cell\n#   max: 3',
  tool: 'kind: expr\ndescription: echo the input\nexpr: String(args.input || "")',
  note: 'New note.',
};

// ---------- http ----------

const INDEX = path.join(__dirname, 'index.html');

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = k => u.searchParams.get(k) || '';
  try {
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      readBody(req)
        .then(body => handlePost(u.pathname, body, res))
        .catch(e => json(res, 400, { error: String(e && e.message || e) }));
      return;
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(safeRead(INDEX) || 'index.html missing');
    } else if (u.pathname === '/favicon.ico') {
      res.writeHead(204); res.end();
    } else if (u.pathname === '/api/state') {
      // one bootstrap read: workspaces, provider availability, cell types.
      // (Cell templates stay server-side — only cell-add reads them.)
      json(res, 200, {
        workspaces: listWorkspaces().map(w => ({ name: w.name, example: w.example })),
        providers: providers.status(),
        cell_types: CELL_TYPES,
        notebook_templates: listTemplates(),
      });
    } else if (u.pathname === '/api/templates') {
      json(res, 200, { templates: listTemplates() });
    } else if (u.pathname === '/api/notebooks') {
      const bench = benchFor(q('ws'));
      json(res, 200, { notebooks: bench.listNotebooks(), goldens: bench.listGoldenSets() });
    } else if (u.pathname === '/api/notebook') {
      json(res, 200, benchFor(q('ws')).readNotebook(q('nb')));
    } else if (u.pathname === '/api/goldens') {
      const bench = benchFor(q('ws'));
      const set = q('set');
      json(res, 200, set ? { set, rows: bench.goldenRows(set) } : { sets: bench.listGoldenSets() });
    } else if (u.pathname === '/api/journal') {
      // catalog of eval runs from _metrics/bench-log.jsonl (read-only)
      json(res, 200, journalRuns(workspace(q('ws')).dir));
    } else if (u.pathname === '/api/journal/run') {
      // one run's summary + per-row results.jsonl
      json(res, 200, journalRunDetail(workspace(q('ws')).dir, q('nb'), q('run')));
    } else if (u.pathname === '/api/layout') {
      // flow-canvas node positions for one notebook (missing file → empty)
      json(res, 200, readLayout(workspace(q('ws')).dir, q('nb')));
    } else if (u.pathname.startsWith('/api/')) {
      // the API namespace always speaks JSON — the client parses every response
      json(res, 404, { error: `not found: ${u.pathname}` });
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    // missing resources (unknown workspace, absent notebook) are 404s, not 500s
    json(res, /unknown workspace|not found/.test(msg) ? 404 : 500, { error: msg });
  }
});

function handlePost(pathname, body, res) {
  const done = data => json(res, 200, data);
  const failWith = e => json(res, 422, { error: String(e && e.message || e) });
  try {
    switch (pathname) {
      // run one cell (reactive: stale ancestors first) or the whole notebook
      case '/api/run': {
        const ws = workspace(body.ws);
        const bench = createBench({ wsDir: ws.dir, providers });
        const runId = requestRunId(body.run_id);
        const token = { cancelled: false, started_at: new Date().toISOString() };
        activeRuns.set(runId, token);
        const p = body.cell
          ? bench.runCell(body.nb, body.cell, { force: Boolean(body.force), cancelToken: token })
          : bench.runAll(body.nb, { force: Boolean(body.force), cancelToken: token });
        return p.then(r => {
            recordRunEvent(ws.dir, { run_id: runId, notebook: body.nb, cell: body.cell || null, status: 'passed', ran: r.ran });
            return done({ run_id: runId, status: 'passed', ran: r.ran, notebook: r.notebook });
          })
          .catch(e => {
            if (e && e.code === 'RUN_CANCELLED') {
              recordRunEvent(ws.dir, { run_id: runId, notebook: body.nb, cell: body.cell || null, status: 'cancelled', ran: e.ran || [] });
              return done({
                run_id: runId,
                status: 'cancelled',
                ran: e.ran || [],
                notebook: bench.readNotebook(body.nb),
              });
            }
            recordRunEvent(ws.dir, { run_id: runId, notebook: body.nb, cell: body.cell || null, status: 'error', error: String(e && e.message || e) });
            return failWith(e);
          })
          .finally(() => activeRuns.delete(runId));
      }

      case '/api/run-cancel': {
        const runId = String(body.run_id || '');
        const token = activeRuns.get(runId);
        if (!token) return failWith(new Error(`run not active: ${runId || '(missing)'}`));
        token.cancelled = true;
        token.cancelled_at = new Date().toISOString();
        return done({ run_id: runId, status: 'cancelling' });
      }

      // notes + corrections log → a structured setup proposal. First available
      // live provider answers; otherwise (or on provider error / malformed
      // output) the deterministic recommender does, labeled "offline
      // suggestion". propose() never throws for provider trouble — the
      // fallback rides the same 200 with a readable note.
      case '/api/authoring-propose': {
        const ws = workspace(body.ws);
        const rows = readJsonlFile(authoringLogFile(ws.dir));
        return propose({ notes: String(body.notes || '').slice(0, 4000), rows, providers })
          .then(done)
          .catch(failWith);
      }

      // create a notebook (empty skeleton, demo, or catalogue template)
      case '/api/notebook-create': {
        const bench = benchFor(body.ws);
        if (body.demo) {
          const r = scaffoldDemo(workspace(body.ws).dir);
          return done({ name: r.name });
        }
        if (body.template) {
          const r = scaffoldTemplate(workspace(body.ws).dir, String(body.template), {
            name: body.name ? slugId(body.name) : undefined,
            title: body.title,
          });
          if (body.notes != null && String(body.notes).trim()) {
            editNotebook(bench, r.name, nb => { nb.meta.notes = String(body.notes).trim(); });
          }
          recordAuthoring(workspace(body.ws).dir, body.authoring, {
            ...(body.authoring && body.authoring.kept),
            template: r.template,
            name: r.name,
          });
          return done({ name: r.name, template: r.template, live: r.live });
        }
        const name = slugId(body.name);
        if (!name) return failWith(new Error('notebook name must be a lowercase slug'));
        if (fs.existsSync(bench.notebookPath(name))) return failWith(new Error(`notebook "${name}" already exists`));
        if (body.copy_from) {
          const source = slugId(body.copy_from);
          if (!source) return failWith(new Error('source notebook must be a lowercase slug'));
          const nb2 = bench.readNotebookFile(source);
          nb2.meta = { ...(nb2.meta || {}), notebook: name, title: String(body.title || name) };
          if (body.notes != null && String(body.notes).trim()) nb2.meta.notes = String(body.notes).trim();
          else delete nb2.meta.notes;
          bench.writeNotebookFile(name, serializeNotebook(nb2));
          recordAuthoring(workspace(body.ws).dir, body.authoring, {
            ...(body.authoring && body.authoring.kept),
            name,
          });
          return done({ name, copied_from: source });
        }
        const notes = body.notes != null && String(body.notes).trim()
          ? `notes: ${JSON.stringify(String(body.notes).trim())}\n` : '';
        bench.writeNotebookFile(name, `---\nnotebook: ${name}\ntitle: ${JSON.stringify(String(body.title || name))}\n${notes}---\n\nA new bench notebook. Add cells to get going.\n`);
        recordAuthoring(workspace(body.ws).dir, body.authoring, {
          ...(body.authoring && body.authoring.kept),
          name,
        });
        return done({ name });
      }

      // save one cell's raw YAML (or a note's text); add/delete cells
      case '/api/cell-save': {
        const bench = benchFor(body.ws);
        const nb2 = editNotebook(bench, body.nb, nb => {
          const i = nb.cells.findIndex(c => c.id === body.id);
          if (i < 0) throw new Error(`no cell "${body.id}"`);
          if (nb.cells[i].type === 'note' && body.text != null) {
            nb.cells[i] = { ...nb.cells[i], text: String(body.text) };
          } else {
            const parsed = parseNotebook('```tl-cell\n' + String(body.raw || '') + '\n```').cells[0];
            if (!parsed) throw new Error('empty cell');
            nb.cells[i] = parsed;
          }
        });
        return done({ notebook: nb2 });
      }
      case '/api/cell-add': {
        const bench = benchFor(body.ws);
        const type = String(body.type || 'note');
        if (!CELL_TYPES.includes(type)) return failWith(new Error(`unknown cell type "${type}"`));
        const nb2 = editNotebook(bench, body.nb, nb => {
          const id = slugId(body.id) || nextCellId(nb.cells, type);
          if (type !== 'note' && nb.cells.some(c => c.id === id)) throw new Error(`cell "${id}" already exists`);
          const cell = type === 'note'
            ? { id: `note-new-${Date.now() % 1e6}`, type: 'note', text: CELL_TEMPLATES.note }
            : { id, type, raw: `id: ${id}\ntype: ${type}\n${CELL_TEMPLATES[type] || ''}` };
          const at = body.after ? nb.cells.findIndex(c => c.id === body.after) + 1 : nb.cells.length;
          nb.cells.splice(at > 0 ? at : nb.cells.length, 0, cell);
        });
        return done({ notebook: nb2 });
      }
      case '/api/cell-delete': {
        const bench = benchFor(body.ws);
        const nb2 = editNotebook(bench, body.nb, nb => {
          const i = nb.cells.findIndex(c => c.id === body.id);
          if (i < 0) throw new Error(`no cell "${body.id}"`);
          nb.cells.splice(i, 1);
        });
        return done({ notebook: nb2 });
      }
      case '/api/cell-config': {
        const bench = benchFor(body.ws);
        const nb2 = editNotebook(bench, body.nb, nb => {
          const cell = nb.cells.find(c => c.id === body.id);
          if (!cell) throw new Error(`no cell "${body.id}"`);
          if (cell.type === 'note') throw new Error('note cells use text editing');
          const updates = body.updates && typeof body.updates === 'object' ? body.updates : {};
          const next = { ...(cell.config || {}) };
          for (const [key, value] of Object.entries(updates)) {
            if (value === '' || value == null) delete next[key];
            else next[key] = normalizeConfigValue(cell.type, key, value);
          }
          cell.config = next;
          delete cell.raw;
        });
        return done({ notebook: nb2 });
      }
      case '/api/cell-duplicate': {
        const bench = benchFor(body.ws);
        let newId = '';
        const nb2 = editNotebook(bench, body.nb, nb => {
          const i = nb.cells.findIndex(c => c.id === body.id);
          if (i < 0) throw new Error(`no cell "${body.id}"`);
          const src = nb.cells[i];
          if (src.type === 'note') {
            const copy = { id: `note-new-${Date.now() % 1e6}`, type: 'note', text: src.text || '' };
            nb.cells.splice(i + 1, 0, copy);
            newId = copy.id;
            return;
          }
          newId = slugId(body.new_id) || nextCellId(nb.cells, src.type);
          const copy = {
            id: newId,
            type: src.type,
            config: JSON.parse(JSON.stringify(src.config || {})),
          };
          nb.cells.splice(i + 1, 0, copy);
        });
        return done({ notebook: nb2, id: newId });
      }
      case '/api/cell-connect': {
        const bench = benchFor(body.ws);
        const nb2 = editNotebook(bench, body.nb, nb => {
          const from = nb.cells.find(c => c.id === body.from);
          const to = nb.cells.find(c => c.id === body.to);
          if (!from) throw new Error(`no source cell "${body.from}"`);
          if (!to) throw new Error(`no target cell "${body.to}"`);
          if (to.type === 'note') throw new Error('cannot connect into a note');
          if (body.loop) {
            // the loop-back variant: the canvas dropped a gate's connector on
            // an EARLIER node — the loop lives on the gate (`from`), pointing
            // back_to the drop target; the engine validates span/ancestry at
            // run time with readable errors
            if (from.type !== 'gate') throw new Error(`only a gate cell can carry a loop-back (got ${from.type} "${from.id}")`);
            const max = Number(body.max == null ? 3 : body.max);
            if (!Number.isInteger(max) || max < 1 || max > 5) throw new Error('loop max must be an integer between 1 and 5');
            from.config = { ...(from.config || {}), loop: { back_to: to.id, max } };
            delete from.raw;
            return;
          }
          connectCells(from, to, body.field);
        });
        return done({ notebook: nb2 });
      }

      // update notebook frontmatter — allowlisted keys only (title, goal, notes).
      // Same parse → mutate meta → serialize path as every cell edit; the
      // notebook name is slug-guarded inside editNotebook via notebookPath.
      case '/api/notebook-meta': {
        const bench = benchFor(body.ws);
        const updates = body.updates && typeof body.updates === 'object' ? body.updates : {};
        const allowed = ['title', 'goal', 'notes'];
        for (const key of Object.keys(updates)) {
          if (!allowed.includes(key)) return failWith(new Error(`meta key "${key}" is not editable (allowed: ${allowed.join(', ')})`));
        }
        const nb2 = editNotebook(bench, body.nb, nb => {
          nb.meta = nb.meta || {};
          for (const key of allowed) {
            if (!(key in updates)) continue;
            const value = updates[key];
            if (value == null || String(value).trim() === '') delete nb.meta[key];
            else nb.meta[key] = String(value).trim();
          }
        });
        return done({ notebook: nb2 });
      }

      // record one human label for one item (append-only)
      case '/api/annotate': {
        const bench = benchFor(body.ws);
        const row = bench.annotate(body.nb, body.cell, {
          item_id: body.item_id, label: body.label, note: body.note,
        });
        return done({ annotation: row });
      }

      // approve / reject golden rows — the HITL gate for synthetic data
      case '/api/golden-decide': {
        const bench = benchFor(body.ws);
        return done(bench.decideGolden(body.set, body.decisions || []));
      }
      // hand-add one golden row (born approved: a human wrote it)
      case '/api/golden-add': {
        const bench = benchFor(body.ws);
        if (!body.set || !body.fields || typeof body.fields !== 'object') return failWith(new Error('golden-add needs set and fields'));
        return done({ row: bench.addGoldenRow(body.set, body.fields) });
      }

      // persist / clear flow-canvas node positions under _bench/layout/
      case '/api/layout': {
        const wsDir = workspace(body.ws).dir;
        if (body.reset) return done(resetLayout(wsDir, body.nb));
        const layout = body.layout || { positions: body.positions || {} };
        return done(writeLayout(wsDir, body.nb, layout));
      }

      default:
        return json(res, 404, { error: 'unknown action' });
    }
  } catch (e) {
    return failWith(e);
  }
}

// data-2, agent-3, … — first free numbered id for a new cell of this type
function nextCellId(cells, type) {
  const used = new Set(cells.map(c => c.id));
  for (let i = 1; ; i++) {
    const id = i === 1 ? type : `${type}-${i}`;
    if (!used.has(id)) return id;
  }
}

function normalizeConfigValue(type, key, value) {
  if (['candidates', 'metrics', 'judges', 'labels', 'dimensions', 'needs'].includes(key)) {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : splitList(value);
  }
  if (['count', 'limit', 'max_turns', 'attempts', 'scale', 'threshold'].includes(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'switch' && key === 'cases') return Array.isArray(value) ? value : [];
  return value;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function connectCells(from, to, requestedField) {
  const field = requestedField && allowedRefField(to.type, requestedField)
    ? requestedField
    : defaultRefField(from, to);
  if (!field) throw new Error(`no connectable ref field for ${from.type} -> ${to.type}`);
  const cfg = { ...(to.config || {}) };
  if (['candidates', 'metrics', 'judges', 'needs'].includes(field)) {
    const list = Array.isArray(cfg[field]) ? cfg[field].map(String) : splitList(cfg[field]);
    if (!list.includes(from.id)) list.push(from.id);
    cfg[field] = list;
  } else {
    cfg[field] = from.id;
  }
  to.config = cfg;
  delete to.raw;
}

function allowedRefField(type, field) {
  return (REF_FIELDS[type] || []).some(f => f === field && !f.includes('.'));
}

function defaultRefField(from, to) {
  if (to.type === 'prompt' && from.type === 'data') return 'data';
  if (to.type === 'agent') {
    if (from.type === 'prompt') return 'prompt';
    if (from.type === 'data' || ['map', 'switch', 'catch', 'retry'].includes(from.type)) return 'data';
    return 'needs';
  }
  if (to.type === 'golden' && from.type === 'data') return 'seed_data';
  if (to.type === 'eval') {
    if (from.type === 'data' || ['map', 'switch', 'catch', 'retry'].includes(from.type)) return 'data';
    if (from.type === 'agent') return 'candidates';
    if (from.type === 'metric') return 'metrics';
    if (from.type === 'judge') return 'judges';
    return 'needs';
  }
  if (to.type === 'annotate') {
    if (from.type === 'golden') return 'golden';
    if (from.type === 'eval') return 'source';
    return 'needs';
  }
  if (to.type === 'switch') return 'input';
  if (to.type === 'map') return 'input';
  if (to.type === 'gate') return to.config && to.config.input ? 'needs' : 'input';
  if (to.type === 'retry') return 'target';
  if (to.type === 'catch') return to.config && to.config.try ? 'fallback' : 'try';
  return allowedRefField(to.type, 'needs') ? 'needs' : '';
}

server.listen(PORT, '127.0.0.1', () => {
  // report the actual bound port — `--port 0` asks the OS for an ephemeral one
  console.log(`bench → http://localhost:${server.address().port}`);
  if (args.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').spawn(cmd, [`http://localhost:${PORT}`], { stdio: 'ignore', detached: true }).unref();
  }
});

module.exports = { server };
