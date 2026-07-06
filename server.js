#!/usr/bin/env node
// bench server — the notebook UI's backend. Zero dependencies (Node stdlib).
//
// GET serves the bench read-only; a small set of localhost POST actions run
// cells, save cell edits, record annotations, and decide golden rows. Trust
// model matches ui/server.js: binds 127.0.0.1 for a single local user, no
// auth; every caller-supplied path resolves through safePath so nothing
// escapes the workspace; the server executes only notebook cells via the
// engine — it never shells out and never spawns agents.
// Usage: node bench/server.js [--port 4460] [--root <repo root>] [--open]

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(arg('port', '4460'), 10);
const ROOT = path.resolve(arg('root', path.resolve(__dirname, '..')));

const { isDir, safeRead } = require('../lib/workspace');
const { createBench } = require('../lib/bench-engine');
const { createProviders } = require('../lib/bench-providers');
const { scaffoldDemo } = require('../lib/bench-demo');
const { parseNotebook, serializeNotebook, slugId, CELL_TYPES } = require('../lib/bench-notebook');

const providers = createProviders();

// ---------- workspaces (same convention as ui/server.js) ----------

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
      // one bootstrap read: workspaces, provider availability, cell templates
      json(res, 200, {
        workspaces: listWorkspaces().map(w => ({ name: w.name, example: w.example })),
        providers: providers.status(),
        cell_types: CELL_TYPES,
        templates: CELL_TEMPLATES,
      });
    } else if (u.pathname === '/api/notebooks') {
      const bench = benchFor(q('ws'));
      json(res, 200, { notebooks: bench.listNotebooks(), goldens: bench.listGoldenSets() });
    } else if (u.pathname === '/api/notebook') {
      json(res, 200, benchFor(q('ws')).readNotebook(q('nb')));
    } else if (u.pathname === '/api/goldens') {
      const bench = benchFor(q('ws'));
      const set = q('set');
      json(res, 200, set ? { set, rows: bench.goldenRows(set) } : { sets: bench.listGoldenSets() });
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

function handlePost(pathname, body, res) {
  const done = data => json(res, 200, data);
  const failWith = e => json(res, 422, { error: String(e && e.message || e) });
  try {
    switch (pathname) {
      // run one cell (reactive: stale ancestors first) or the whole notebook
      case '/api/run': {
        const bench = benchFor(body.ws);
        const p = body.cell
          ? bench.runCell(body.nb, body.cell, { force: Boolean(body.force) })
          : bench.runAll(body.nb, { force: Boolean(body.force) });
        return p.then(r => done({ ran: r.ran, notebook: r.notebook })).catch(failWith);
      }

      // create a notebook (empty skeleton or the demo)
      case '/api/notebook-create': {
        const bench = benchFor(body.ws);
        if (body.demo) {
          const r = scaffoldDemo(workspace(body.ws).dir);
          return done({ name: r.name });
        }
        const name = slugId(body.name);
        if (!name) return failWith(new Error('notebook name must be a lowercase slug'));
        if (fs.existsSync(bench.notebookPath(name))) return failWith(new Error(`notebook "${name}" already exists`));
        bench.writeNotebookFile(name, `---\nnotebook: ${name}\ntitle: "${(body.title || name).replace(/"/g, "'")}"\n---\n\nA new bench notebook. Add cells to get going.\n`);
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

server.listen(PORT, '127.0.0.1', () => {
  // report the actual bound port — `--port 0` asks the OS for an ephemeral one
  console.log(`tl bench → http://localhost:${server.address().port}`);
  if (args.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').spawn(cmd, [`http://localhost:${PORT}`], { stdio: 'ignore', detached: true }).unref();
  }
});

module.exports = { server };
