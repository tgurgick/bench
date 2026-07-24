// lib/engine.js — the bench execution engine.
//
// One place to benchmark models and run experiments, as a reactive notebook:
// marimo's model (cells form a dependency graph; running a cell re-runs its
// stale ancestors and marks descendants stale) with n8n's cells (each cell is
// a typed node — dataset, prompt, agent loop, metric, judge, golden set,
// eval grid, annotation, plus the control nodes: switch, map, retry, catch).
// The engine executes cells (async, because model
// providers are); lib/notebook.js owns the file format and the graph;
// lib/providers.js owns model I/O.
//
// Everything is files, one rule per artifact:
//   _bench/<name>.bench.md                  the notebook (markdown IS the notebook)
//   _bench/runs/<name>/cells/<id>.json      last output per cell (the reactive state)
//   _bench/runs/<name>/evals/<run>/         eval grid artifacts (results.jsonl, summary.json)
//   _bench/goldens/<set>.jsonl              golden rows (origin + draft/approved status)
//   _bench/annotations/<name>--<cell>.jsonl human labels, append-only
//   _metrics/bench-log.jsonl                one row per eval-run candidate (learning surface)
//
// Trust model: a notebook is the local user's own file, executed on their own
// machine — the same trust as running `node`. Expression metrics/judges/tools
// run in a `node:vm` context with a timeout as an accident guard, not a
// security boundary. Node stdlib only; zero dependencies.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const { parseNotebook, serializeNotebook, buildGraph, runPlan, downstream, slugId, refStrings, loopBackOf, BUILTIN_TOOL_NAMES } = require('./notebook');
const { createProviders } = require('./providers');
const { safeRead, isDir, safePath } = require('./fsutil');

const EXPR_TIMEOUT_MS = 200;   // accident guard for expr metrics/judges/tools
const DEFAULT_MAX_TURNS = 4;   // agent loop ceiling unless the cell says otherwise
const EVAL_ROW_CAP = 200;      // hard cap on rows per eval run — explicit `limit` can only lower it
const MAX_RETRY_ATTEMPTS = 5;  // hard ceiling on retry cells — `attempts:` can only lower it
const MAX_LOOP_PASSES = 5;     // hard ceiling on a gate's loop-back passes — non-overridable v1
const TOOL_RESULT_CAP = 4000;  // http/file tool results clip here before re-entering the loop

// The kinds a `tool` cell can be. expr/transform are local computation; http
// and file reach outward (network via the injectable transport, filesystem
// through the traversal guard).
const TOOL_KINDS = ['expr', 'http', 'file', 'transform'];

class RunCancelledError extends Error {
  constructor(ran) {
    super('run cancelled');
    this.name = 'RunCancelledError';
    this.code = 'RUN_CANCELLED';
    this.ran = ran.slice();
  }
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeFile(p, content) { mkdirp(path.dirname(p)); fs.writeFileSync(p, content); }
function appendJsonl(file, row) { mkdirp(path.dirname(file)); fs.appendFileSync(file, JSON.stringify(row) + '\n'); }

function readJsonl(file) {
  const out = [];
  for (const line of (safeRead(file) || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

function readJson(file) {
  const t = safeRead(file);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// ---------------------------------------------------------------------------
// createBench — one engine per workspace
// ---------------------------------------------------------------------------

// options: { wsDir, providers?, now?, httpTransport? }. `now` is injectable so
// runs are deterministic under test; `providers` accepts a registry from
// createProviders (tests inject transports through it); `httpTransport` is the
// http tool's network seam — async ({ method, url, headers, body }) →
// { status, body } — so tool tests assert the exact request with zero network.
function createBench(options = {}) {
  const wsDir = path.resolve(options.wsDir);
  const providers = options.providers || createProviders();
  const nowFn = options.now || (() => new Date());
  const httpTransport = options.httpTransport || defaultHttpTransport;

  const benchDir = path.join(wsDir, '_bench');
  const metricsDir = path.join(wsDir, '_metrics');

  const iso = () => nowFn().toISOString();
  // ms precision so two evals in the same second get distinct stamps; runSeq
  // still suffixes run_id when `now` is frozen to the same millisecond.
  const stamp = () => iso().replace(/[-:.TZ]/g, '').slice(0, 17);
  let runSeq = 0;

  // ---------- notebook files ----------

  function notebookPath(name) {
    const slug = slugId(name);
    if (!slug) throw new Error(`invalid notebook name "${name}"`);
    const p = safePath(benchDir, slug + '.bench.md');
    if (!p) throw new Error(`notebook path escapes workspace: "${name}"`);
    return p;
  }

  function listNotebooks() {
    if (!isDir(benchDir)) return [];
    const out = [];
    for (const f of fs.readdirSync(benchDir).sort()) {
      if (!f.endsWith('.bench.md')) continue;
      const name = f.replace(/\.bench\.md$/, '');
      const { meta, cells } = parseNotebook(safeRead(path.join(benchDir, f)) || '');
      out.push({
        name,
        title: meta.title || name,
        cells: cells.filter(c => c.type !== 'note').length,
        mtime: fs.statSync(path.join(benchDir, f)).mtimeMs,
      });
    }
    return out;
  }

  function readNotebookFile(name) {
    const text = safeRead(notebookPath(name));
    if (text == null) throw new Error(`notebook not found: ${name}`);
    return parseNotebook(text);
  }

  function writeNotebookFile(name, nb) {
    writeFile(notebookPath(name), typeof nb === 'string' ? nb : serializeNotebook(nb));
  }

  // ---------- reactive state (persisted per-cell outputs) ----------

  function cellRecordPath(name, cellId) {
    const p = safePath(path.join(benchDir, 'runs', slugId(name), 'cells'), slugId(cellId) + '.json');
    if (!p) throw new Error(`cell path escapes workspace: "${cellId}"`);
    return p;
  }

  function readCellRecord(name, cellId) {
    return readJson(cellRecordPath(name, cellId));
  }

  function configHash(cell) {
    return sha256(JSON.stringify({ t: cell.type, c: cell.config || {} }));
  }

  // A cell is stale when it never ran, its config changed, any upstream ran
  // more recently than what this cell last consumed — or any upstream is
  // itself stale (marimo semantics: editing a cell dirties its whole
  // downstream immediately, not only after the edited cell re-runs). Also
  // stale when a config ref names a missing/renamed cell (graph.deps drops
  // those edges) or a deps stamp names a cell that no longer exists. Note
  // cells are never stale — prose doesn't execute. Memoized per check; the
  // visiting set stops recursion if a cycle sneaks in (cycles are also
  // rejected before any run).
  function makeStaleCheck(name, cells, graph) {
    const byId = {};
    for (const c of cells) byId[c.id] = c;
    const idSet = new Set(cells.map(c => c.id));
    const memo = new Map();
    const visiting = new Set();
    return function isStale(id) {
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) return false; // cycle guard — cycles are rejected before running anyway
      visiting.add(id);
      let out = false;
      const cell = byId[id];
      if (cell && cell.type !== 'note') {
        const rec = readCellRecord(name, id);
        if (!rec || rec.config_hash !== configHash(cell)) out = true;
        else if (hasDanglingConfigRef(cell, idSet)) out = true;
        else if (Object.keys(rec.deps || {}).some(dep => !byId[dep])) out = true;
        else {
          for (const dep of graph.deps[id] || []) {
            if (byId[dep] && byId[dep].type === 'note') continue;
            if (isStale(dep)) { out = true; break; }
            const depRec = readCellRecord(name, dep);
            if (!depRec || (rec.deps || {})[dep] !== depRec.ran_at) { out = true; break; }
          }
        }
      }
      visiting.delete(id);
      memo.set(id, out);
      return out;
    };
  }

  // Config strings in ref positions that name no live cell — buildGraph/
  // cellRefs drop those edges, so the dep loop alone would leave the cell
  // falsely fresh. refStrings walks the exact same fields the graph does.
  function hasDanglingConfigRef(cell, idSet) {
    return refStrings(cell).some(s => !idSet.has(s));
  }

  // The notebook plus everything the UI needs in one read: graph, per-cell
  // staleness, and a small summary of each cell's last output.
  function readNotebook(name) {
    const nb = readNotebookFile(name);
    const graph = buildGraph(nb.cells);
    const isStale = makeStaleCheck(name, nb.cells, graph);
    const state = {};
    for (const c of nb.cells) {
      if (c.type === 'note') continue;
      const rec = readCellRecord(name, c.id);
      state[c.id] = {
        stale: isStale(c.id),
        ran_at: rec ? rec.ran_at : null,
        error: rec ? rec.error || null : null,
        output: rec ? rec.output : null,
      };
    }
    return { name, meta: nb.meta, cells: nb.cells, errors: nb.errors, graph, state };
  }

  // ---------- run ----------

  // Run one cell reactively: stale ancestors first, then the cell, in graph
  // order. Fresh ancestors resolve from their persisted records. Descendants
  // are not auto-run — they show as stale until asked (calm over cascade);
  // `runAll` is the run-everything button. Async because providers are.
  async function runCell(name, cellId, opts = {}) {
    const nb = readNotebookFile(name);
    const graph = buildGraph(nb.cells);
    const byId = {};
    for (const c of nb.cells) byId[c.id] = c;
    const target = byId[cellId];
    if (!target) throw new Error(`no cell "${cellId}" in notebook ${name}`);
    if (target.type === 'note') return { ran: [], state: {} };
    if (graph.cycle.length) throw new Error(`dependency cycle: ${graph.cycle.join(', ')}`);
    if (target.error) throw new Error(`cell "${cellId}" has a config error: ${target.error}`);

    const baseStale = makeStaleCheck(name, nb.cells, graph);
    const isStale = opts.force ? id => id === cellId || baseStale(id) : baseStale;
    const plan = runPlan(graph, cellId, isStale)
      .filter(id => byId[id].type !== 'note');

    const ran = [];
    for (const id of plan) {
      checkCancelled(opts.cancelToken, ran);
      const cell = byId[id];
      if (cell.error) throw new Error(`upstream cell "${id}" has a config error: ${cell.error}`);
      const record = await executeCell(name, cell, graph, byId);
      writeFile(cellRecordPath(name, id), JSON.stringify(record, null, 2) + '\n');
      ran.push(id);
    }
    return { ran, notebook: readNotebook(name) };
  }

  async function runAll(name, opts = {}) {
    const nb = readNotebookFile(name);
    const graph = buildGraph(nb.cells);
    if (graph.cycle.length) throw new Error(`dependency cycle: ${graph.cycle.join(', ')}`);
    const byId = {};
    for (const c of nb.cells) byId[c.id] = c;
    const isStale = makeStaleCheck(name, nb.cells, graph);
    const ran = [];
    for (const id of graph.order) {
      const cell = byId[id];
      if (!cell || cell.type === 'note') continue;
      if (cell.error) throw new Error(`cell "${id}" has a config error: ${cell.error}`);
      const mustRun = opts.force || isStale(id)
        || (graph.deps[id] || []).some(d => ran.includes(d));
      if (!mustRun) continue;
      checkCancelled(opts.cancelToken, ran);
      const record = await executeCell(name, cell, graph, byId);
      writeFile(cellRecordPath(name, id), JSON.stringify(record, null, 2) + '\n');
      ran.push(id);
    }
    return { ran, notebook: readNotebook(name) };
  }

  function checkCancelled(token, ran) {
    if (!token) return;
    const cancelled = typeof token.isCancelled === 'function'
      ? token.isCancelled()
      : Boolean(token.cancelled);
    if (cancelled) throw new RunCancelledError(ran);
  }

  // Execute one cell and wrap its output in the persisted record shape. A
  // throwing executor produces an error record (the cell shows red, the file
  // says why) rather than crashing the run of everything else — except when
  // downstream cells need it, in which case the error propagates naturally
  // because ctx.resolve refuses error records.
  async function executeCell(name, cell, graph, byId) {
    let output = null;
    let error = null;
    try {
      output = EXECUTORS[cell.type]
        ? await EXECUTORS[cell.type](makeCtx(name, cell, byId, graph), cell)
        : unsupported(cell);
    } catch (e) {
      error = String(e && e.message || e);
    }
    // dep stamps are read AFTER execution: a loop-back gate rewrites its span
    // cells' records mid-execution, and the gate's own stamps must match what
    // is on disk when its record lands (otherwise it would be born stale)
    const deps = {};
    for (const d of graph.deps[cell.id] || []) {
      const rec = readCellRecord(name, d);
      if (rec) deps[d] = rec.ran_at;
    }
    return {
      cell_id: cell.id, type: cell.type,
      config_hash: configHash(cell), ran_at: iso(), deps,
      output, error,
    };
  }

  function unsupported(cell) {
    throw new Error(`no executor for cell type "${cell.type}"`);
  }

  // The per-execution context executors see: resolve upstream outputs, reach
  // providers, and write artifacts under this notebook's run dir. `loopEnv`
  // is the loop-back seam: { overlay, bindings } — overlay records shadow the
  // persisted ones (a span cell re-executing in pass k must consume pass-k
  // outputs, not disk), and bindings are the {{feedback.*}}/{{previous.*}}
  // template variables injected into span renders.
  function makeCtx(name, cell, byId, graph, loopEnv) {
    const readRec = refId => (loopEnv && loopEnv.overlay && loopEnv.overlay[refId]) || readCellRecord(name, refId);
    return {
      wsDir, benchDir, providers, iso, stamp,
      notebook: name,
      cell,
      graph: graph || { deps: {}, rdeps: {}, order: [], cycle: [] },
      bindings: (loopEnv && loopEnv.bindings) || null,
      cells() { return Object.values(byId); },
      resolve(refId, what) {
        if (!refId) throw new Error(`${cell.id}: missing ${what || 'reference'}`);
        const refCell = byId[refId];
        if (!refCell) throw new Error(`${cell.id}: references unknown cell "${refId}"`);
        const rec = readRec(refId);
        if (!rec || rec.error) throw new Error(`${cell.id}: upstream "${refId}" has ${rec ? 'an error' : 'not run'} — run it first`);
        return { cell: refCell, output: rec.output };
      },
      // like resolve, but hands back the raw record even when it errored —
      // the seam catch/retry cells need to see failure instead of inheriting it
      resolveAny(refId, what) {
        if (!refId) throw new Error(`${cell.id}: missing ${what || 'reference'}`);
        const refCell = byId[refId];
        if (!refCell) throw new Error(`${cell.id}: references unknown cell "${refId}"`);
        return { cell: refCell, record: readRec(refId) };
      },
      // re-execute another cell's executor in its own context, without
      // persisting a record — retry cells use this for fresh attempts
      exec(refId) {
        return this.execWith(refId, loopEnv);
      },
      // exec with an explicit loop environment — the gate's loop driver
      // executes span cells against the current pass's overlay and bindings
      execWith(refId, env) {
        const refCell = byId[refId];
        if (!refCell) throw new Error(`${cell.id}: references unknown cell "${refId}"`);
        if (refCell.error) throw new Error(`${cell.id}: target "${refId}" has a config error: ${refCell.error}`);
        if (!EXECUTORS[refCell.type]) throw new Error(`${cell.id}: target "${refId}" is not an executable cell`);
        return EXECUTORS[refCell.type](makeCtx(name, refCell, byId, graph, env), refCell);
      },
      refCell(refId) { return byId[refId] || null; },
    };
  }

  // ---------- executors ----------

  const EXECUTORS = {
    data: execData,
    prompt: execPrompt,
    agent: execAgent,
    metric: execMetric,
    judge: execJudge,
    golden: execGolden,
    eval: execEval,
    annotate: execAnnotate,
    switch: execSwitch,
    map: execMap,
    retry: execRetry,
    catch: execCatch,
    gate: execGate,
    tool: execTool,
  };

  // data — rows from inline config, a workspace file, or a golden set.
  function execData(ctx, cell) {
    const cfg = cell.config || {};
    let rows = [];
    let source = 'inline';
    if (Array.isArray(cfg.rows)) {
      rows = cfg.rows.filter(r => r && typeof r === 'object');
    } else if (cfg.golden) {
      source = `golden:${cfg.golden}`;
      const include = String(cfg.include || 'approved').toLowerCase();
      rows = goldenRows(cfg.golden).filter(r =>
        include === 'all' ? true : (r.status || 'draft') === include);
    } else if (cfg.file) {
      source = String(cfg.file);
      const p = safePath(wsDir, String(cfg.file));
      if (!p) throw new Error(`${cell.id}: file path escapes the workspace`);
      if (String(cfg.file).endsWith('.jsonl')) rows = readJsonl(p);
      else {
        const data = readJson(p);
        if (!Array.isArray(data)) throw new Error(`${cell.id}: ${cfg.file} is not a JSON array or JSONL file`);
        rows = data;
      }
    } else {
      throw new Error(`${cell.id}: a data cell needs rows:, file:, or golden:`);
    }
    if (cfg.limit) rows = rows.slice(0, Math.max(0, Number(cfg.limit) || 0));
    return { rows, columns: rowColumns(rows), count: rows.length, source };
  }

  // prompt — a {{var}} template; preview renders against the first bound row.
  function execPrompt(ctx, cell) {
    const cfg = cell.config || {};
    const template = String(cfg.template || '');
    if (!template.trim()) throw new Error(`${cell.id}: prompt cell needs a template`);
    const vars = templateVars(template);
    let preview = null;
    if (cfg.data) {
      const { output } = ctx.resolve(cfg.data, 'data');
      const row = (output.rows || [])[0];
      if (row) preview = renderTemplate(template, withLoopBindings(ctx, row));
    }
    return { template, system: cfg.system ? String(cfg.system) : null, vars, preview };
  }

  // agent — one agent-loop definition. Running the cell alone is a smoke test
  // on the sample input (config `input:` or the first row of its data ref);
  // eval grids call the same loop per row via runAgentPipeline.
  // `input_from:` (+ optional `input_path:`) pulls another cell's output into
  // the row — the explicit handoff for multi-agent pipelines.
  async function execAgent(ctx, cell) {
    const cfg = cell.config || {};
    let row = null;
    let handoff = null;
    if (cfg.input_from) {
      const { output } = ctx.resolve(cfg.input_from, 'input_from');
      const built = buildHandoffRow(cell, output);
      row = built.row;
      handoff = built.meta;
    } else if (cfg.input != null) row = typeof cfg.input === 'object' ? cfg.input : { input: cfg.input };
    else if (cfg.data) {
      const { output } = ctx.resolve(cfg.data, 'data');
      row = (output.rows || [])[0] || null;
    } else if (cfg.prompt) {
      // no input of its own — smoke-test on the first row of the data cell the
      // referenced prompt previews against, so `prompt: x` alone is runnable
      const promptCell = ctx.refCell(cfg.prompt);
      const dataRef = promptCell && promptCell.config && promptCell.config.data;
      if (dataRef) {
        const { output } = ctx.resolve(dataRef, 'data');
        row = (output.rows || [])[0] || null;
      }
    }
    if (!row) throw new Error(`${cell.id}: give the agent an input:, data:, or input_from: cell to smoke-test on`);
    const result = await runAgentLoop(ctx, cell, row);
    return { sample_row: row, ...result, ...(handoff ? { handoff } : {}) };
  }

  // metric — validate the definition; dry-run against a tiny sample so a bad
  // expression fails at the cell, not mid-eval.
  function execMetric(ctx, cell) {
    const cfg = cell.config || {};
    const kind = String(cfg.kind || 'exact_match').toLowerCase();
    if (!METRIC_KINDS.includes(kind)) throw new Error(`${cell.id}: unknown metric kind "${kind}" (have: ${METRIC_KINDS.join(', ')})`);
    if (kind === 'expr' && !String(cfg.expr || '').trim()) throw new Error(`${cell.id}: expr metric needs expr:`);
    const sample = computeMetric(cell, {
      output: 'sample output', expected: 'sample output', input: 'sample input',
      row: { input: 'sample input', expected: 'sample output' },
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0 }, latency_ms: 1, turns: [],
    });
    return { kind, name: cfg.name || cell.id, sample_value: sample };
  }

  // judge — validate + one sample judgment so the rubric/provider wiring is
  // proven before an eval leans on it. Optional `input_from:` scores an
  // upstream agent/control output instead of the fixed dry-run strings.
  async function execJudge(ctx, cell) {
    const cfg = cell.config || {};
    const kind = String(cfg.kind || 'llm').toLowerCase();
    let sampleIn = { input: 'sample input', output: 'sample output', expected: 'sample output' };
    let handoff = null;
    if (cfg.input_from) {
      const { output } = ctx.resolve(cfg.input_from, 'input_from');
      const path = cfg.input_path != null && String(cfg.input_path) !== '' ? String(cfg.input_path) : 'output';
      const value = getByPath(output, path);
      if (value === undefined) {
        throw new Error(`${cell.id}: input_path "${path}" missing on "${cfg.input_from}"`);
      }
      const base = output.sample_row && typeof output.sample_row === 'object' ? output.sample_row : {};
      sampleIn = {
        input: rowInput(base) || String(base.input || ''),
        output: typeof value === 'string' || typeof value === 'number' ? String(value)
          : (value && value.output != null ? String(value.output) : JSON.stringify(value)),
        expected: rowExpected(base) || '',
      };
      handoff = { from: cfg.input_from, path, value: typeof value === 'string' ? value.slice(0, 500) : value };
    }
    if (kind === 'code') {
      if (!String(cfg.expr || '').trim()) throw new Error(`${cell.id}: code judge needs expr:`);
      const sample = await runJudge(ctx, cell, sampleIn);
      return { kind, dimensions: dimsOf(cfg), sample, ...(handoff ? { handoff } : {}) };
    }
    if (kind !== 'llm') throw new Error(`${cell.id}: judge kind must be llm or code`);
    const provider = requireProvider(cfg, 'fixture');
    const sample = await runJudge(ctx, cell, sampleIn);
    return { kind, provider: provider.name, model: cfg.model || null, dimensions: dimsOf(cfg), sample, ...(handoff ? { handoff } : {}) };
  }

  // golden — generate synthetic rows into a golden set as drafts. Nothing a
  // model generates is trusted until a human approves it: rows land with
  // status "draft" and only flip to "approved" through the annotation flow.
  async function execGolden(ctx, cell) {
    const cfg = cell.config || {};
    const set = slugId(cfg.set || cell.id);
    if (!set) throw new Error(`${cell.id}: golden cell needs a set: name`);
    let seeds = [];
    if (cfg.seed_data) {
      const { output } = ctx.resolve(cfg.seed_data, 'seed_data');
      seeds = output.rows || [];
    } else if (Array.isArray(cfg.seeds)) seeds = cfg.seeds;
    if (!seeds.length) throw new Error(`${cell.id}: golden cell needs seed rows (seeds: or seed_data:)`);

    const count = Math.min(50, Math.max(1, Number(cfg.count) || 5));
    const fields = Array.isArray(cfg.fields) && cfg.fields.length
      ? cfg.fields.map(String)
      : Object.keys(seeds[0]).filter(k => !k.startsWith('_') && k !== 'status' && k !== 'origin');
    const provider = requireProvider(cfg, 'fixture');
    const promptText = [
      String(cfg.instructions || 'Generate new examples in the style of the seeds.'),
      '',
      'Seed examples (JSON):',
      JSON.stringify(seeds.slice(0, 10), null, 2),
      '',
      `Return ONLY a JSON array of ${count} new objects with exactly these fields: ${fields.join(', ')}.`,
      'Vary the content meaningfully; do not repeat the seeds.',
    ].join('\n');

    const reply = await provider.complete({
      model: cfg.model || 'fixture-1',
      system: 'You generate high-quality synthetic evaluation data. Output JSON only.',
      messages: [{ role: 'user', content: promptText }],
      max_tokens: cfg.max_tokens || 2048,
      mode: 'generate',
      seed_rows: seeds.slice(0, 10),
      count,
    });

    const rows = extractJsonArray(reply.text);
    if (!rows.length) throw new Error(`${cell.id}: generator returned no parseable JSON array`);
    const created = iso();
    const added = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const clean = {};
      for (const f of fields) clean[f] = r[f] != null ? r[f] : '';
      const row = {
        _id: sha256(set + JSON.stringify(clean) + created).slice(0, 12),
        ...clean,
        origin: 'synthetic', status: 'draft', created,
        generator: { provider: provider.name, model: reply.model },
      };
      appendJsonl(goldenPath(set), row);
      added.push(row);
    }
    const all = goldenRows(set);
    return {
      set, generated: added.length,
      draft: all.filter(r => (r.status || 'draft') === 'draft').length,
      approved: all.filter(r => r.status === 'approved').length,
      rejected: all.filter(r => r.status === 'rejected').length,
      total: all.length,
      preview: added.slice(0, 5),
      usage: reply.usage,
    };
  }

  // eval — the experiment grid: every data row × every candidate agent, each
  // result scored by every metric and judge. Artifacts land under
  // runs/<nb>/evals/<run>/ and one summary row per candidate goes to
  // _metrics/bench-log.jsonl — markdown/JSON for humans, JSONL for learning,
  // same split as the experiments harness.
  async function execEval(ctx, cell) {
    const cfg = cell.config || {};
    const { output: dataOut } = ctx.resolve(cfg.data, 'data');
    const rows = (dataOut.rows || []).slice(0, Math.min(EVAL_ROW_CAP, Number(cfg.limit) || EVAL_ROW_CAP));
    if (!rows.length) throw new Error(`${cell.id}: data cell "${cfg.data}" has no rows`);

    const candidateIds = listOf(cfg.candidates);
    if (!candidateIds.length) throw new Error(`${cell.id}: eval needs candidates: [agent cell ids]`);
    const metricCells = listOf(cfg.metrics).map(id => ctx.refCell(id) || missing(cell.id, id));
    const judgeCells = listOf(cfg.judges).map(id => ctx.refCell(id) || missing(cell.id, id));

    const runId = `run-${stamp()}-${++runSeq}`;
    const runDir = path.join(benchDir, 'runs', slugId(ctx.notebook), 'evals', runId);
    const resultsFile = path.join(runDir, 'results.jsonl');
    const results = [];

    for (const candId of candidateIds) {
      const candCell = ctx.refCell(candId);
      if (!candCell || candCell.type !== 'agent') throw new Error(`${cell.id}: candidate "${candId}" is not an agent cell`);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const item = {
          item_id: `r${i}-${candId}`,
          row_index: i, candidate: candId, row,
          output: null, error: null, turns: [], usage: null, latency_ms: null,
          metrics: {}, judgments: {},
        };
        const t0 = Date.now();
        try {
          const r = await runAgentPipeline(ctx, candCell, row);
          item.output = r.output;
          item.turns = r.turns;
          item.usage = r.usage;
          item.provider = r.provider;
          item.model = r.model;
          if (r.handoff) item.handoff = r.handoff;
          if (r.handoffs) item.handoffs = r.handoffs;
        } catch (e) {
          item.error = String(e && e.message || e);
        }
        item.latency_ms = Date.now() - t0;

        const sample = {
          output: item.output || '', expected: rowExpected(row), input: rowInput(row),
          row, usage: item.usage || {}, latency_ms: item.latency_ms, turns: item.turns, error: item.error,
        };
        for (const mc of metricCells) {
          try { item.metrics[metricName(mc)] = item.error ? null : computeMetric(mc, sample); }
          catch (e) { item.metrics[metricName(mc)] = null; item.metric_error = String(e && e.message || e); }
        }
        for (const jc of judgeCells) {
          try { item.judgments[jc.id] = item.error ? null : await runJudge(ctx, jc, sample); }
          catch (e) { item.judgments[jc.id] = { error: String(e && e.message || e) }; }
        }
        appendJsonl(resultsFile, item);
        results.push(item);
      }
    }

    const summary = summarizeEval(results, candidateIds, metricCells, judgeCells);
    const payload = {
      run_id: runId, notebook: ctx.notebook, cell: cell.id, created: iso(),
      data: cfg.data, rows: rows.length, candidates: candidateIds,
      metrics: metricCells.map(metricName), judges: judgeCells.map(j => j.id),
      summary,
    };
    writeFile(path.join(runDir, 'summary.json'), JSON.stringify(payload, null, 2) + '\n');

    for (const cand of summary.candidates) {
      appendJsonl(path.join(metricsDir, 'bench-log.jsonl'), {
        date: iso().slice(0, 10),
        notebook: ctx.notebook, cell: cell.id, run_id: runId,
        candidate: cand.candidate, provider: cand.provider, model: cand.model,
        n: cand.n, errors: cand.errors,
        judge_overall_mean: cand.judge ? cand.judge.overall_mean : null,
        metrics: cand.metrics,
        input_tokens: cand.tokens.input, output_tokens: cand.tokens.output,
        cost_usd: cand.cost_usd, latency_ms_mean: cand.latency_ms_mean,
        winner: summary.winner === cand.candidate,
      });
    }

    return {
      run_id: runId,
      results_path: rel(resultsFile),
      summary_path: rel(path.join(runDir, 'summary.json')),
      rows: rows.length, ...payloadLite(payload),
      results: results.map(liteResult),
    };
  }

  // annotate — the HITL surface. Executing the cell computes the queue and
  // progress snapshot; the actual labels arrive through annotate()/decideGolden()
  // (the server's POST handlers), append-only.
  function execAnnotate(ctx, cell) {
    const cfg = cell.config || {};
    const labels = listOf(cfg.labels);
    const scale = Number(cfg.scale) || null;
    if (!labels.length && !scale) throw new Error(`${cell.id}: annotate needs labels: [..] or scale: N`);

    let items = [];
    let kind = null;
    if (cfg.golden) {
      kind = 'golden';
      items = goldenRows(cfg.golden).map(r => ({
        item_id: r._id, row: publicRow(r), status: r.status || 'draft', origin: r.origin || '',
      }));
    } else if (cfg.source) {
      kind = 'eval';
      const { output } = ctx.resolve(cfg.source, 'source');
      items = (output.results || []).map(r => ({
        item_id: r.item_id, candidate: r.candidate, row: r.row,
        output: r.output, error: r.error, judgments: r.judgments || {},
      }));
    } else {
      throw new Error(`${cell.id}: annotate needs source: <eval cell> or golden: <set>`);
    }

    // Golden decisions live on the goldens JSONL (status), not the annotations
    // file — counting annotations left golden-kind cells stuck at "0 of N".
    let labeled = 0;
    const tally = {};
    const byItem = {};
    if (kind === 'golden') {
      for (const it of items) {
        const status = it.status || 'draft';
        if (status === 'draft') continue;
        labeled++;
        tally[status] = (tally[status] || 0) + 1;
      }
    } else {
      const anns = annotations(ctx.notebook, cell.id);
      for (const a of anns) byItem[a.item_id] = a; // last write wins
      labeled = Object.keys(byItem).length;
      for (const a of Object.values(byItem)) tally[a.label] = (tally[a.label] || 0) + 1;
    }

    // agreement with the judge, when both a human label and a judge verdict exist
    let agree = null;
    if (kind === 'eval') {
      let both = 0, same = 0;
      for (const it of items) {
        const a = byItem[it.item_id];
        const j = firstJudgeVerdict(it.judgments);
        if (!a || !j) continue;
        both++;
        const humanPass = scale ? Number(a.label) >= Math.ceil(scale / 2) + 0.5 : positiveLabel(a.label, labels);
        if (humanPass === (j === 'pass')) same++;
      }
      if (both) agree = { n: both, rate: Math.round((same / both) * 100) / 100 };
    }

    return {
      kind, labels: labels.length ? labels : null, scale,
      instructions: cfg.instructions || null,
      total: items.length, labeled, remaining: items.length - labeled,
      tally, judge_agreement: agree,
      items: items.map(it => ({ ...it, annotation: byItem[it.item_id] || null })),
      annotations_path: rel(annotationsPath(ctx.notebook, cell.id)),
    };
  }

  // ---------- control nodes (branch, transform, retry, error path) ----------

  // switch — choose one upstream branch and pass its output through. Cases
  // are checked in order against the input cell's output ({output, rows,
  // count, first} in the expression scope); the first case whose `when:` is
  // truthy (or that has no when:) wins, else `default:`, else the cell errs.
  // Evaluation stops at the first match. The selection is materialized in the
  // record — downstream cells consume the chosen branch's rows/output with no
  // UI-only state.
  function execSwitch(ctx, cell) {
    const cfg = cell.config || {};
    const cases = listOfAny(cfg.cases).filter(c => c && typeof c === 'object' && !Array.isArray(c));
    if (!cases.length && !cfg.default) throw new Error(`${cell.id}: switch needs cases: [{when, use}] or default:`);
    let scope = { output: null, rows: [], count: 0, first: null };
    if (cfg.input) {
      const { output } = ctx.resolve(cfg.input, 'input');
      const rows = output && Array.isArray(output.rows) ? output.rows : [];
      scope = { output, rows, count: rows.length, first: rows[0] || null };
    }
    let selected = null;
    let matched = -1;
    const considered = [];
    for (let i = 0; i < cases.length; i++) {
      let hit;
      try { hit = cases[i].when == null || !!runExpr(String(cases[i].when), scope); }
      catch (e) { throw new Error(`${cell.id}: case ${i + 1} when: failed — ${String(e && e.message || e)}`); }
      considered.push({ when: cases[i].when != null ? String(cases[i].when) : null, matched: hit });
      if (hit) {
        if (!cases[i].use) throw new Error(`${cell.id}: case ${i + 1} matched but has no use:`);
        selected = String(cases[i].use);
        matched = i;
        break;
      }
    }
    if (matched < 0) {
      if (!cfg.default) throw new Error(`${cell.id}: no case matched and no default:`);
      selected = String(cfg.default);
    }
    const { output } = ctx.resolve(selected, 'selected branch');
    return {
      ...(output && typeof output === 'object' && !Array.isArray(output) ? output : { value: output }),
      selected, case: matched < 0 ? 'default' : matched + 1, considered,
    };
  }

  // map — transform an upstream cell's rows, one expression per row. Scope is
  // {row, index, rows}. `filter:` keeps rows where it is truthy; `expr:`
  // returns the new row — an object replaces it, null/undefined drops it, any
  // other value wraps as { value }. Both optional (bare map is a pass-through
  // / limit). A throwing expression fails the cell with the row index, so a
  // bad transform points at its data.
  function execMap(ctx, cell) {
    const cfg = cell.config || {};
    if (!cfg.input) throw new Error(`${cell.id}: map needs input: <cell with rows>`);
    const { output } = ctx.resolve(cfg.input, 'input');
    const rows = output && Array.isArray(output.rows) ? output.rows : null;
    if (!rows) throw new Error(`${cell.id}: input "${cfg.input}" has no rows to map`);
    const out = [];
    let dropped = 0;
    for (let i = 0; i < rows.length; i++) {
      const scope = { row: rows[i], index: i, rows };
      try {
        if (cfg.filter != null && !runExpr(String(cfg.filter), scope)) { dropped++; continue; }
        let v = cfg.expr != null ? runExpr(String(cfg.expr), scope) : rows[i];
        if (v == null) { dropped++; continue; }
        if (typeof v !== 'object' || Array.isArray(v)) v = { value: v };
        out.push(v);
      } catch (e) {
        throw new Error(`${cell.id}: row ${i} — ${String(e && e.message || e)}`);
      }
    }
    const limited = cfg.limit ? out.slice(0, Math.max(0, Number(cfg.limit) || 0)) : out;
    return { rows: limited, columns: rowColumns(limited), count: limited.length, dropped, source: `map:${cfg.input}` };
  }

  // retry — ensure a target cell's output, re-executing it on failure. A
  // clean target record passes through untouched (attempts: 0, reused); an
  // error record triggers up to `attempts:` (≤ MAX_RETRY_ATTEMPTS) fresh
  // executions of the target's executor, none persisted to the target — its
  // own record stays honestly red. Every attempt lands in the log; total
  // failure throws with the full log in the message, so the error record
  // says exactly what happened and when.
  async function execRetry(ctx, cell) {
    const cfg = cell.config || {};
    if (!cfg.target) throw new Error(`${cell.id}: retry needs target: <cell id>`);
    const attempts = Math.min(MAX_RETRY_ATTEMPTS, Math.max(1, Number(cfg.attempts) || 3));
    const { record } = ctx.resolveAny(cfg.target, 'target');
    if (record && !record.error) {
      return {
        ...(record.output && typeof record.output === 'object' ? record.output : { value: record.output }),
        retry: { target: cfg.target, attempts: 0, reused: true, log: [] },
      };
    }
    const log = record ? [{ attempt: 0, ok: false, error: record.error, from: 'record' }] : [];
    for (let n = 1; n <= attempts; n++) {
      try {
        const output = await ctx.exec(cfg.target);
        log.push({ attempt: n, ok: true });
        return {
          ...(output && typeof output === 'object' && !Array.isArray(output) ? output : { value: output }),
          retry: { target: cfg.target, attempts: n, reused: false, log },
        };
      } catch (e) {
        log.push({ attempt: n, ok: false, error: String(e && e.message || e) });
      }
    }
    const detail = log.filter(l => !l.ok && l.attempt > 0).map(l => `#${l.attempt}: ${l.error}`).join('; ');
    throw new Error(`${cell.id}: target "${cfg.target}" failed after ${attempts} attempts — ${detail}`);
  }

  // catch — the explicit error path. A clean upstream passes through
  // (caught: false); when the upstream's record errored, the cell emits
  // {caught: true, error} plus a fallback — another cell's output
  // (`fallback:`) or inline `rows:` — so downstream keeps a well-defined
  // input instead of inheriting a buried failure. The failing cell's own
  // record stays red; nothing ever looks fresher than it is.
  function execCatch(ctx, cell) {
    const cfg = cell.config || {};
    if (!cfg.try) throw new Error(`${cell.id}: catch needs try: <cell id>`);
    const { record } = ctx.resolveAny(cfg.try, 'try');
    if (!record) throw new Error(`${cell.id}: upstream "${cfg.try}" has not run — run it first`);
    if (!record.error) {
      return {
        ...(record.output && typeof record.output === 'object' && !Array.isArray(record.output) ? record.output : { value: record.output }),
        caught: false, error: null, from: cfg.try,
      };
    }
    let fb = null;
    if (cfg.fallback) fb = ctx.resolve(cfg.fallback, 'fallback').output;
    else if (Array.isArray(cfg.rows)) {
      const rows = cfg.rows.filter(r => r && typeof r === 'object');
      fb = { rows, columns: rowColumns(rows), count: rows.length, source: 'fallback:inline' };
    }
    return {
      ...(fb && typeof fb === 'object' && !Array.isArray(fb) ? fb : {}),
      caught: true, error: record.error, from: cfg.try,
    };
  }

  // gate — evaluate an input cell, decide, and record the verdict:
  // {pass, score, rationale, input_ref}, spread over the input's output so a
  // gate can sit mid-chain without breaking data flow (switch's pass-through
  // discipline). Two kinds:
  //   expr:  one expression over {output, judgment, metrics, score} of the
  //          input's record → boolean pass; optional `score:` expression.
  //          Loop-aware extras in scope: `pass` (the current pass number) and
  //          `feedback` (the previous pass's verdict, null on pass 1) — which
  //          also make deterministic loop fixtures trivial (`feedback != null`
  //          fails pass 1 and passes pass 2, no live model needed).
  //   judge: inline judge fields (provider/model/scale/rubric/dimensions)
  //          plus `threshold:` — runs the judge, pass = overall >= threshold
  // A gate may carry one loop-back — `loop: {back_to: <cell>, max: N}` — the
  // guarded backward flow of the recursive-flows intent. The iteration runs
  // INSIDE this executor (the retry/ctx.exec precedent, so buildGraph stays
  // acyclic): while the verdict fails and passes < max (hard cap 5), the span
  // from back_to to the gate re-executes with the previous verdict injected
  // into template scope as {{feedback.score}}/{{feedback.rationale}} and the
  // span tail's previous output as {{previous.output}}. Every pass lands on
  // the gate's record (`loop.passes`); the final pass persists per-cell so
  // downstream consumes it like any other run. Human-approval gates ("loop
  // until I approve") are deferred by design — see README.
  async function execGate(ctx, cell) {
    const cfg = cell.config || {};
    if (!cfg.input) throw new Error(`${cell.id}: gate needs input: <cell id>`);
    const loop = loopBackOf(cell);
    // a broken loop config refuses readably even when pass 1 would pass —
    // a loop that could never run should never look configured
    const plan = loop ? validateGateLoop(ctx, cell, loop) : null;

    let { output } = ctx.resolve(cfg.input, 'input');
    let verdict = await gateVerdict(ctx, cell, output, { pass: 1, feedback: null });
    if (!plan) return gateResult(output, verdict, cfg, null);

    const passes = [gatePassEntry(1, verdict, output)];
    let finalOverlay = null;
    while (!verdict.pass && passes.length < plan.max) {
      const prev = verdict;
      const n = passes.length + 1;
      const env = {
        overlay: {},
        bindings: {
          'feedback.score': prev.score,
          'feedback.rationale': prev.rationale,
          'previous.output': gateTailText(output),
        },
      };
      for (const id of plan.span) {
        let out;
        try { out = await ctx.execWith(id, env); }
        catch (e) {
          throw new Error(`${cell.id}: loop pass ${n} — re-running "${id}" failed: ${String(e && e.message || e)}`);
        }
        env.overlay[id] = { cell_id: id, output: out, error: null, ran_at: iso() };
      }
      finalOverlay = env.overlay;
      if (env.overlay[cfg.input]) output = env.overlay[cfg.input].output;
      verdict = await gateVerdict(ctx, cell, output, {
        pass: n,
        feedback: { pass: prev.pass, score: prev.score, rationale: prev.rationale },
      });
      passes.push(gatePassEntry(n, verdict, output));
    }

    // the final pass persists per-cell normally — same record shape the plan
    // loop writes, in topo order so span-internal dep stamps stay coherent
    // (and the gate's own stamps, read after this executor returns, match)
    if (finalOverlay) {
      for (const id of plan.span) {
        const spanCell = ctx.refCell(id);
        const deps = {};
        for (const d of ctx.graph.deps[id] || []) {
          const rec = readCellRecord(ctx.notebook, d);
          if (rec) deps[d] = rec.ran_at;
        }
        writeFile(cellRecordPath(ctx.notebook, id), JSON.stringify({
          cell_id: id, type: spanCell.type, config_hash: configHash(spanCell),
          ran_at: finalOverlay[id].ran_at, deps,
          output: finalOverlay[id].output, error: null,
        }, null, 2) + '\n');
      }
    }

    return gateResult(output, verdict, cfg, {
      back_to: plan.back_to, max: plan.max, span: plan.span, passes,
    });
  }

  // One gate verdict for one input output: { pass, score, rationale, detail }.
  // `extras` is the loop seam — { pass: n, feedback: previous verdict | null }.
  async function gateVerdict(ctx, cell, output, extras) {
    const cfg = cell.config || {};
    const kind = cfg.expr != null ? 'expr' : 'judge';

    if (kind === 'expr') {
      // the scope mirrors what an upstream record can carry: the full output,
      // the first judgment on it (judge cell sample / a judgment field), its
      // metrics map, and the judgment's overall as `score`
      const judgment = gateJudgmentOf(output);
      const metrics = output && typeof output === 'object' && output.metrics && typeof output.metrics === 'object'
        ? output.metrics : null;
      const upScore = judgment && typeof judgment.overall === 'number' ? judgment.overall
        : output && typeof output === 'object' && typeof output.score === 'number' ? output.score : null;
      const scope = { output, judgment, metrics, score: upScore, pass: extras.pass, feedback: extras.feedback };
      let v;
      try { v = runExpr(String(cfg.expr), scope); }
      catch (e) { throw new Error(`${cell.id}: gate expr failed — ${String(e && e.message || e)}`); }
      const pass = !!v;
      let score;
      if (cfg.score != null) {
        let sv;
        try { sv = runExpr(String(cfg.score), scope); }
        catch (e) { throw new Error(`${cell.id}: gate score expr failed — ${String(e && e.message || e)}`); }
        score = typeof sv === 'boolean' ? (sv ? 1 : 0) : (typeof sv === 'number' && isFinite(sv) ? sv : null);
      } else score = upScore;
      return {
        pass, score,
        rationale: `expr gate: ${String(cfg.expr).trim()} → ${pass ? 'pass' : 'fail'}`,
        detail: { kind, expr: String(cfg.expr) },
      };
    }

    // a stray kind: on a gate used to fall through to runJudge's code branch
    // with a misdirected "code judge needs expr:" — name the real rule instead
    // (gate-cell followup #2)
    if (cfg.kind != null && String(cfg.kind).toLowerCase() !== 'llm') {
      throw new Error(`${cell.id}: a gate takes no kind: "${cfg.kind}" — use expr: for an expression gate, or inline judge fields (provider/model/scale/rubric/dimensions) with threshold:`);
    }
    const hasJudgeFields = ['provider', 'model', 'scale', 'rubric', 'dimensions'].some(k => cfg[k] != null);
    if (!hasJudgeFields) {
      throw new Error(`${cell.id}: gate needs expr: or inline judge fields (provider/model/scale/rubric/dimensions) with threshold:`);
    }
    const threshold = Number(cfg.threshold);
    if (cfg.threshold == null || !isFinite(threshold)) {
      throw new Error(`${cell.id}: inline-judge gate needs a numeric threshold:`);
    }
    // judge the input's output text — same handoff shape execJudge uses for
    // input_from, default path `output`, whole-output JSON as the fallback
    const src = output && typeof output === 'object' && !Array.isArray(output) ? output : { value: output };
    const value = getByPath(output, 'output');
    const base = src.sample_row && typeof src.sample_row === 'object' ? src.sample_row : {};
    const sampleIn = {
      input: rowInput(base) || String(base.input || ''),
      output: typeof value === 'string' || typeof value === 'number' ? String(value)
        : value == null ? JSON.stringify(output)
        : (value.output != null ? String(value.output) : JSON.stringify(value)),
      expected: rowExpected(base) || '',
    };
    let judgment;
    try { judgment = await runJudge(ctx, cell, sampleIn); }
    catch (e) { throw new Error(`${cell.id}: gate judge failed — ${String(e && e.message || e)}`); }
    const score = typeof judgment.overall === 'number' ? judgment.overall : null;
    const pass = score != null && score >= threshold;
    return {
      pass, score,
      rationale: judgment.rationale
        || `judge gate: overall ${score == null ? 'missing' : score} vs threshold ${threshold}`,
      detail: { kind, threshold, judgment },
    };
  }

  // The gate's record shape: verdict spread over the input's pass-through.
  function gateResult(output, verdict, cfg, loopInfo) {
    const passThrough = output && typeof output === 'object' && !Array.isArray(output)
      ? output : { value: output };
    return {
      ...passThrough,
      pass: verdict.pass, score: verdict.score, rationale: verdict.rationale,
      input_ref: cfg.input, gate: verdict.detail,
      ...(loopInfo ? { loop: loopInfo } : {}),
    };
  }

  function gatePassEntry(n, verdict, output) {
    return {
      n, pass: verdict.pass, score: verdict.score,
      rationale: verdict.rationale == null ? null : String(verdict.rationale).slice(0, 500),
      output: gateTailText(output).slice(0, 2000),
    };
  }

  // The textual tail of an output — what {{previous.output}} binds to and
  // what a pass entry records.
  function gateTailText(output) {
    if (output == null) return '';
    if (typeof output !== 'object' || Array.isArray(output)) return String(output);
    if (typeof output.output === 'string' || typeof output.output === 'number') return String(output.output);
    return JSON.stringify(output);
  }

  // Validate a gate's loop-back and compute the span — every refusal is a
  // readable error naming the gate and the rule. v1 rules: max is an integer
  // 1..5 (hard cap, non-overridable), back_to must be a live ancestor of the
  // gate, one loop-back per notebook, and the span may not contain another
  // gate — verdict keys shadow on pass-through (gate-cell followup #1), so a
  // gate inside the span would make which critique feeds the loop ambiguous.
  function validateGateLoop(ctx, cell, loop) {
    const max = Number(loop.max);
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`${cell.id}: loop max must be an integer ≥ 1 (got ${loop.max == null ? 'nothing' : JSON.stringify(loop.max)})`);
    }
    if (max > MAX_LOOP_PASSES) {
      throw new Error(`${cell.id}: loop max ${max} exceeds the hard cap of ${MAX_LOOP_PASSES} passes (the cap is not overridable)`);
    }
    const bt = loop.back_to;
    if (!bt) throw new Error(`${cell.id}: loop needs back_to: <cell id>`);
    const target = ctx.refCell(bt);
    if (!target) throw new Error(`${cell.id}: loop back_to references unknown cell "${bt}"`);
    if (target.type === 'note') throw new Error(`${cell.id}: loop back_to "${bt}" is a note — loop back to an executable cell`);
    const rival = ctx.cells().find(c => c.id !== cell.id && loopBackOf(c) && loopBackOf(c).back_to);
    if (rival) {
      throw new Error(`${cell.id}: only one loop-back per notebook (v1) — "${rival.id}" already declares one`);
    }
    const ancestors = new Set();
    const walkUp = id => {
      for (const d of ctx.graph.deps[id] || []) {
        if (!ancestors.has(d)) { ancestors.add(d); walkUp(d); }
      }
    };
    walkUp(cell.id);
    if (!ancestors.has(bt)) {
      throw new Error(`${cell.id}: loop back_to "${bt}" is not an ancestor of this gate — the span must flow forward from back_to into the gate`);
    }
    // span = every cell on a path from back_to to the gate: the gate's
    // ancestors intersected with back_to's descendants, plus back_to itself
    // (diamond-safe: parallel branches between the two are all included)
    const below = new Set([bt]);
    const walkDown = id => {
      for (const d of ctx.graph.rdeps[id] || []) {
        if (!below.has(d)) { below.add(d); walkDown(d); }
      }
    };
    walkDown(bt);
    const span = ctx.graph.order.filter(id => {
      if (id === cell.id || !ancestors.has(id) || !below.has(id)) return false;
      const c = ctx.refCell(id);
      return c && c.type !== 'note';
    });
    const gateInSpan = span.find(id => (ctx.refCell(id) || {}).type === 'gate');
    if (gateInSpan) {
      throw new Error(`${cell.id}: loop span contains gate "${gateInSpan}" — gates inside a loop span are not supported (v1); keep the span a straight refine chain into this gate`);
    }
    return { back_to: bt, max, span };
  }

  // The judgment an upstream output carries, if any: a judge cell's `sample`,
  // or a `judgment` field — anything shaped like {scores, overall, ...}.
  function gateJudgmentOf(output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
    for (const v of [output.sample, output.judgment]) {
      if (v && typeof v === 'object' && !Array.isArray(v) && (v.overall != null || v.scores)) return v;
    }
    return null;
  }

  // ---------- tool nodes (reusable expr / http / file / transform) ----------

  // tool — a reusable tool definition other agent cells reference by id from
  // `tools:`. Executing the cell validates the definition and materializes
  // the JSON-schema-like parameter surface providers will see; nothing
  // external runs here — http and file tools execute only inside an agent
  // loop, when the model actually calls them. Expression surfaces run in
  // node:vm with a timeout — an accident guard, not a sandbox: the notebook
  // is the user's own local file, the same trust as any script they run.
  function execTool(ctx, cell) {
    const cfg = cell.config || {};
    if (BUILTIN_TOOL_NAMES.includes(cell.id)) {
      throw new Error(`${cell.id}: "${cell.id}" is a builtin tool name — builtins shadow tool cells, pick another id`);
    }
    const kind = toolKind(cfg);
    if (!TOOL_KINDS.includes(kind)) {
      throw new Error(`${cell.id}: tool kind must be one of ${TOOL_KINDS.join(', ')}`);
    }
    const out = {
      kind,
      name: slugId(cfg.name) || cell.id,
      description: String(cfg.description || ''),
      parameters: toolParameters(cfg),
    };
    if (kind === 'expr') {
      const expr = String(cfg.expr || '').trim();
      if (!expr) throw new Error(`${cell.id}: expr tool needs expr:`);
      try { new vm.Script(expr); } catch (e) {
        throw new Error(`${cell.id}: expr does not compile — ${String(e && e.message || e)}`);
      }
      out.expr = expr;
    } else if (kind === 'transform') {
      if (!String(cfg.template || '').trim()) throw new Error(`${cell.id}: transform tool needs template:`);
      out.template = String(cfg.template);
      out.vars = templateVars(cfg.template);
    } else if (kind === 'http') {
      const url = String(cfg.url || '').trim();
      if (!url) throw new Error(`${cell.id}: http tool needs url:`);
      // a literal url must be http(s) up front; templated urls ({{base}}/…)
      // get the same check at call time, on the rendered value
      if (!url.startsWith('{{') && !/^https?:\/\//i.test(url)) {
        throw new Error(`${cell.id}: http tool url must be http(s), got "${url.slice(0, 80)}"`);
      }
      out.method = String(cfg.method || 'GET').toUpperCase();
      out.url = url;
    } else if (kind === 'file') {
      if (!String(cfg.path || '').trim()) throw new Error(`${cell.id}: file tool needs path:`);
      out.path = String(cfg.path);
    }
    return out;
  }

  // A tool cell's kind — explicit `kind:`, or inferred `expr` when only an
  // expression is given (the same shorthand inline tools use).
  function toolKind(cfg) {
    return String(cfg.kind || (cfg.expr ? 'expr' : '')).toLowerCase();
  }

  // The JSON-schema-like parameter surface a tool exposes to providers.
  // `params:` is the friendly form — a map of name → { type, description,
  // required } (or name → type shorthand); `parameters:` passes a full JSON
  // schema through untouched. No params at all falls back to the single
  // string `input` inline tools use.
  function toolParameters(cfg) {
    if (cfg.parameters && typeof cfg.parameters === 'object' && !Array.isArray(cfg.parameters)) return cfg.parameters;
    const params = cfg.params && typeof cfg.params === 'object' && !Array.isArray(cfg.params) ? cfg.params : null;
    if (!params) return { type: 'object', properties: { input: { type: 'string' } } };
    const properties = {};
    const required = [];
    for (const k of Object.keys(params)) {
      const p = params[k] && typeof params[k] === 'object' && !Array.isArray(params[k])
        ? params[k]
        : { type: String(params[k] || 'string') };
      properties[k] = { type: String(p.type || 'string') };
      if (p.description) properties[k].description = String(p.description);
      if (Array.isArray(p.enum)) properties[k].enum = p.enum;
      if (p.required) required.push(k);
    }
    const schema = { type: 'object', properties };
    if (required.length) schema.required = required;
    return schema;
  }

  // Compile a tool cell into the runnable shape the agent loop uses —
  // { name, description, parameters, cell, run }. Template fields (url,
  // headers, body, path, transform template) render {{var}} against the
  // call's args over the current row (args win). http goes through the
  // injected transport; file resolves through the traversal guard. Tool
  // failures throw readable errors the loop feeds back as tool results —
  // they never crash the run.
  function makeCellTool(toolCell, row) {
    const cfg = toolCell.config || {};
    const kind = toolKind(cfg);
    if (!TOOL_KINDS.includes(kind)) {
      throw new Error(`tool cell "${toolCell.id}" has no valid kind (${TOOL_KINDS.join(', ')})`);
    }
    const name = slugId(cfg.name) || toolCell.id;
    const base = {
      name,
      description: String(cfg.description || `${kind} tool ${toolCell.id}`),
      parameters: toolParameters(cfg),
      cell: toolCell.id,
    };
    const scopeOf = args => ({
      ...(row && typeof row === 'object' ? row : {}),
      ...(args && typeof args === 'object' ? args : {}),
    });
    switch (kind) {
      case 'expr':
        return { ...base, run: args => runExpr(String(cfg.expr || ''), { args: args || {}, row }) };
      case 'transform':
        return { ...base, run: args => renderTemplate(String(cfg.template || ''), scopeOf(args)) };
      case 'file':
        return {
          ...base,
          run(args) {
            const relPath = renderTemplate(String(cfg.path || ''), scopeOf(args)).trim();
            if (!relPath) throw new Error(`file tool "${name}" needs a path`);
            const p = safePath(wsDir, relPath);
            if (!p) throw new Error(`file tool "${name}": path "${relPath}" escapes the workspace`);
            const text = safeRead(p);
            if (text == null) throw new Error(`file tool "${name}": cannot read "${relPath}"`);
            return clipToolResult(text);
          },
        };
      case 'http':
        return {
          ...base,
          async run(args) {
            const scope = scopeOf(args);
            const url = renderTemplate(String(cfg.url || ''), scope).trim();
            if (!/^https?:\/\//i.test(url)) {
              throw new Error(`http tool "${name}": url must be http(s), got "${url.slice(0, 80)}"`);
            }
            const method = String(cfg.method || 'GET').toUpperCase();
            const headers = {};
            if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
              for (const k of Object.keys(cfg.headers)) headers[k] = renderTemplate(String(cfg.headers[k]), scope);
            }
            const body = cfg.body != null ? renderTemplate(String(cfg.body), scope) : undefined;
            const res = await httpTransport({ method, url, headers, body });
            const status = res && res.status != null ? Number(res.status) : 0;
            const text = clipToolResult(res && res.body != null ? String(res.body) : '');
            // non-2xx is a readable result, not a crash — the model can react
            return status >= 200 && status < 300 ? text : `HTTP ${status}: ${text}`;
          },
        };
      default:
        throw new Error(`tool cell "${toolCell.id}": unsupported kind "${kind}"`);
    }
  }

  // ---------- the agent loop (n8n's node, marimo's cell) ----------

  // Walk a dotted path (`output`, `sample.overall`, `rows.0.input`) on a cell
  // output. Missing segments yield undefined so callers can name the path.
  function getByPath(obj, path) {
    if (path == null || path === '' || path === '.') return obj;
    const parts = String(path).split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null || (typeof cur !== 'object' && !Array.isArray(cur))) return undefined;
      cur = /^\d+$/.test(p) ? cur[Number(p)] : cur[p];
    }
    return cur;
  }

  // Turn an upstream cell output into the row the next agent loop sees.
  // Default path is `output` (agent text). Objects merge onto sample_row;
  // scalars become `input`.
  function buildHandoffRow(cell, upstreamOutput) {
    const cfg = cell.config || {};
    const from = cfg.input_from;
    const path = cfg.input_path != null && String(cfg.input_path) !== '' ? String(cfg.input_path) : 'output';
    const value = getByPath(upstreamOutput, path);
    if (value === undefined) {
      throw new Error(`${cell.id}: input_path "${path}" missing on "${from}"`);
    }
    const base = (upstreamOutput && upstreamOutput.sample_row && typeof upstreamOutput.sample_row === 'object')
      ? { ...upstreamOutput.sample_row } : {};
    let row;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      row = { ...base, ...value };
      if (row.input == null && value.output != null) row.input = value.output;
      if (row.input == null) row.input = typeof value.overall !== 'undefined' ? value.overall : JSON.stringify(value);
    } else {
      row = { ...base, input: value };
    }
    return {
      row,
      meta: {
        from,
        path,
        value: typeof value === 'string' ? value.slice(0, 2000) : value,
      },
    };
  }

  // Run an agent for one data row, recursively executing upstream `input_from`
  // agents on the same row so an eval candidate can be a whole pipeline.
  async function runAgentPipeline(ctx, agentCell, row, stack = []) {
    if (stack.includes(agentCell.id)) {
      throw new Error(`input_from cycle: ${stack.concat(agentCell.id).join(' → ')}`);
    }
    const cfg = agentCell.config || {};
    const handoffs = [];
    let useRow = row;
    if (cfg.input_from) {
      const up = ctx.refCell(cfg.input_from);
      if (!up) throw new Error(`${agentCell.id}: input_from "${cfg.input_from}" not found`);
      let upOut;
      if (up.type === 'agent') {
        const nested = await runAgentPipeline(ctx, up, row, stack.concat(agentCell.id));
        upOut = { sample_row: row, ...nested };
        if (nested.handoffs) handoffs.push(...nested.handoffs);
        else if (nested.handoff) handoffs.push(nested.handoff);
      } else {
        const resolved = ctx.resolve(cfg.input_from, 'input_from');
        upOut = resolved.output;
      }
      const built = buildHandoffRow(agentCell, upOut);
      useRow = built.row;
      handoffs.push(built.meta);
    }
    const result = await runAgentLoop(ctx, agentCell, useRow);
    if (handoffs.length === 1) result.handoff = handoffs[0];
    if (handoffs.length) result.handoffs = handoffs;
    return result;
  }

  // Run one agent loop for one row: render the prompt, then alternate model
  // call ↔ tool execution until the model answers in text or max_turns is
  // hit. Every step lands in `turns` — the observable trace, same philosophy
  // as TRACE.jsonl in the experiments harness.
  async function runAgentLoop(ctx, agentCell, row) {
    const cfg = agentCell.config || {};
    const provider = requireProvider(cfg, 'fixture');
    let template = cfg.template ? String(cfg.template) : null;
    let system = cfg.system ? String(cfg.system) : null;
    if (cfg.prompt) {
      const { output } = ctx.resolve(cfg.prompt, 'prompt');
      template = template || output.template;
      system = system || output.system;
    }
    if (!template) template = '{{input}}';

    const tools = resolveTools(cfg.tools, row, ctx);
    const maxTurns = Math.min(12, Math.max(1, Number(cfg.max_turns) || DEFAULT_MAX_TURNS));
    // loop-back passes ≥ 2 render with {{feedback.*}}/{{previous.*}} in scope;
    // outside a loop the bindings are null and the row renders as always
    const messages = [{ role: 'user', content: renderTemplate(template, withLoopBindings(ctx, row)) }];
    const turns = [];
    const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    let finalText = '';

    for (let turn = 1; turn <= maxTurns; turn++) {
      const reply = await provider.complete({
        model: cfg.model || 'fixture-1',
        system, messages,
        tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
        max_tokens: cfg.max_tokens || 1024,
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
        mode: 'chat',
      });
      usage.input_tokens += (reply.usage && reply.usage.input_tokens) || 0;
      usage.output_tokens += (reply.usage && reply.usage.output_tokens) || 0;
      usage.cost_usd += (reply.usage && reply.usage.cost_usd) || 0;
      turns.push({
        turn, kind: 'model',
        text: reply.text || null,
        tool_calls: (reply.tool_calls || []).map(c => ({ name: c.name, args: c.args })),
      });

      if (!reply.tool_calls || !reply.tool_calls.length) { finalText = reply.text || ''; break; }

      messages.push({ role: 'assistant', content: reply.text || '', tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        const tool = tools.find(t => t.name === call.name);
        let result;
        // await because tool-cell runs can be async (http); errors become
        // readable tool results the model sees, never crashed runs
        try { result = tool ? String(await tool.run(call.args || {})) : `unknown tool "${call.name}"`; }
        catch (e) { result = `tool error: ${String(e && e.message || e)}`; }
        turns.push({
          turn, kind: 'tool', tool: call.name,
          ...(tool && tool.cell ? { tool_cell: tool.cell } : {}),
          args: call.args, result: result.slice(0, 2000),
        });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      if (turn === maxTurns) finalText = reply.text || '(max turns reached with tool calls pending)';
    }

    return {
      output: finalText, turns, usage,
      provider: provider.name, model: cfg.model || 'fixture-1',
    };
  }

  // The tools an agent cell can list in `tools:` — three kinds, resolved in
  // order for each entry:
  //   1. a builtin name (calc, today, lookup) — builtins shadow cells, the
  //      names are reserved
  //   2. the id of a `tool` cell in this notebook — the reusable tool nodes
  //   3. an inline expr tool ({ name, description, expr } evaluated with
  //      `args` and `row` in scope)
  // Anything else errors readably, naming what was tried.
  function resolveTools(spec, row, ctx) {
    const out = [];
    for (const t of listOfAny(spec)) {
      if (typeof t === 'string') {
        const b = BUILTIN_TOOLS[t];
        if (b) { out.push(b(row, ctx)); continue; }
        const refCell = ctx.refCell(t);
        if (refCell && refCell.type === 'tool') { out.push(makeCellTool(refCell, row)); continue; }
        if (refCell) throw new Error(`tool "${t}" is a ${refCell.type} cell, not a tool cell`);
        throw new Error(`unknown tool "${t}" — not a builtin (${BUILTIN_TOOL_NAMES.join(', ')}) and no tool cell with that id`);
      } else if (t && typeof t === 'object' && t.name && t.expr) {
        out.push({
          name: slugId(t.name) || 'tool',
          description: String(t.description || 'custom tool'),
          parameters: { type: 'object', properties: { input: { type: 'string' } } },
          run: args => runExpr(String(t.expr), { args, row }),
        });
      }
    }
    return out;
  }

  const BUILTIN_TOOLS = {
    // arithmetic on a guarded expression — the classic tool-use smoke test
    calc: () => ({
      name: 'calc',
      description: 'Evaluate an arithmetic expression, e.g. "2*(3+4)".',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } },
      run(args) {
        const expr = String(args.expression || args.input || '');
        if (!/^[\d\s+\-*/().%]+$/.test(expr)) throw new Error('calc accepts digits and + - * / ( ) . % only');
        return String(vm.runInNewContext(expr, {}, { timeout: EXPR_TIMEOUT_MS }));
      },
    }),
    // the current date, from the engine clock (deterministic under test)
    today: (row, ctx) => ({
      name: 'today',
      description: 'The current date (ISO).',
      parameters: { type: 'object', properties: {} },
      run: () => ctx.iso().slice(0, 10),
    }),
    // look a field up on the row under evaluation
    lookup: row => ({
      name: 'lookup',
      description: 'Look up a field on the current data row, e.g. {"key": "customer"}.',
      parameters: { type: 'object', properties: { key: { type: 'string' } } },
      run(args) {
        const v = row && row[String(args.key || '')];
        return v == null ? '(not found)' : String(v);
      },
    }),
  };

  // ---------- metrics ----------

  const METRIC_KINDS = ['exact_match', 'contains', 'regex', 'json_valid', 'length', 'latency', 'tokens', 'cost', 'expr'];

  function metricName(cell) { return (cell.config && cell.config.name) || cell.id; }

  // One metric value for one sample. Numbers throughout: booleans coerce to
  // 1/0 so means are always computable.
  function computeMetric(cell, s) {
    const cfg = cell.config || {};
    const kind = String(cfg.kind || 'exact_match').toLowerCase();
    const norm = v => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
    switch (kind) {
      case 'exact_match': return norm(s.output) === norm(cfg.value != null ? cfg.value : s.expected) ? 1 : 0;
      case 'contains': return norm(s.output).includes(norm(cfg.value != null ? cfg.value : s.expected)) ? 1 : 0;
      case 'regex': {
        if (!cfg.pattern) throw new Error(`${cell.id}: regex metric needs pattern:`);
        return new RegExp(String(cfg.pattern), String(cfg.flags || 'i')).test(String(s.output || '')) ? 1 : 0;
      }
      case 'json_valid': try { JSON.parse(String(s.output || '')); return 1; } catch { return 0; }
      case 'length': return String(s.output || '').length;
      case 'latency': return s.latency_ms != null ? s.latency_ms : null;
      case 'tokens': return s.usage && s.usage.output_tokens != null ? s.usage.output_tokens : null;
      case 'cost': return s.usage && s.usage.cost_usd != null ? s.usage.cost_usd : null;
      case 'expr': {
        const v = runExpr(String(cfg.expr || ''), {
          output: s.output, expected: s.expected, input: s.input,
          row: s.row, usage: s.usage, latency_ms: s.latency_ms, turns: s.turns,
        });
        return typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'number' && isFinite(v) ? v : null);
      }
      default: throw new Error(`${cell.id}: unknown metric kind "${kind}"`);
    }
  }

  // ---------- judges ----------

  function dimsOf(cfg) {
    const d = listOf(cfg.dimensions);
    return d.length ? d : ['quality'];
  }

  // One judgment for one sample: { scores, overall, verdict, rationale }.
  // LLM judges ask the provider for JSON against the rubric; code judges run
  // an expression that returns a number (scored against scale) or the object
  // shape directly.
  async function runJudge(ctx, cell, s) {
    const cfg = cell.config || {};
    const kind = String(cfg.kind || 'llm').toLowerCase();
    const scale = Math.max(2, Number(cfg.scale) || 5);
    const dims = dimsOf(cfg);

    if (kind === 'code') {
      const v = runExpr(String(cfg.expr || ''), {
        output: s.output, expected: s.expected, input: s.input, row: s.row, scale,
      });
      if (v && typeof v === 'object') return normalizeJudgment(v, dims, scale);
      const n = typeof v === 'boolean' ? (v ? scale : 1) : Number(v);
      return normalizeJudgment({ scores: { [dims[0]]: n }, overall: n }, dims, scale);
    }

    const provider = requireProvider(cfg, 'fixture');
    const promptText = [
      'Judge the candidate output against the rubric. Be strict and consistent.',
      '',
      cfg.rubric ? `Rubric:\n${cfg.rubric}\n` : '',
      `Score each dimension from 1 (worst) to ${scale} (best): ${dims.join(', ')}.`,
      '',
      `Input:\n${s.input || '(none)'}`,
      s.expected ? `\nExpected / reference:\n${s.expected}` : '',
      `\nCandidate output:\n${s.output || '(empty)'}`,
      '',
      `Return ONLY JSON: {"scores": {${dims.map(d => `"${d}": n`).join(', ')}}, "overall": n, "verdict": "pass"|"fail", "rationale": "one sentence"}`,
    ].join('\n');

    const reply = await provider.complete({
      model: cfg.model || 'fixture-1',
      system: 'You are a careful, consistent evaluator. Output JSON only.',
      messages: [{ role: 'user', content: promptText }],
      max_tokens: cfg.max_tokens || 512,
      temperature: 0,
      mode: 'judge',
      dimensions: dims,
    });
    const parsed = extractJsonObject(reply.text) || {};
    const j = normalizeJudgment(parsed, dims, scale);
    j.usage = reply.usage;
    j.model = reply.model;
    return j;
  }

  function normalizeJudgment(v, dims, scale) {
    const scores = {};
    let total = 0, n = 0;
    for (const d of dims) {
      const raw = v.scores && v.scores[d] != null ? Number(v.scores[d]) : NaN;
      const sc = isFinite(raw) ? Math.min(scale, Math.max(1, raw)) : null;
      scores[d] = sc;
      if (sc != null) { total += sc; n++; }
    }
    const overall = v.overall != null && isFinite(Number(v.overall))
      ? Math.min(scale, Math.max(1, Number(v.overall)))
      : (n ? Math.round((total / n) * 10) / 10 : null);
    const verdict = v.verdict === 'pass' || v.verdict === 'fail'
      ? v.verdict
      : (overall != null ? (overall >= (scale + 1) / 2 ? 'pass' : 'fail') : null);
    return { scores, overall, verdict, scale, rationale: v.rationale ? String(v.rationale).slice(0, 500) : null };
  }

  // ---------- eval summary ----------

  function summarizeEval(results, candidateIds, metricCells, judgeCells) {
    const candidates = [];
    for (const cand of candidateIds) {
      const rs = results.filter(r => r.candidate === cand);
      const ok = rs.filter(r => !r.error);
      const metricsOut = {};
      for (const mc of metricCells) {
        const name = metricName(mc);
        const vals = ok.map(r => r.metrics[name]).filter(v => typeof v === 'number');
        metricsOut[name] = vals.length ? round(mean(vals)) : null;
      }
      let judge = null;
      if (judgeCells.length) {
        const overalls = [], passes = [];
        for (const r of ok) for (const jid of Object.keys(r.judgments || {})) {
          const j = r.judgments[jid];
          if (j && typeof j.overall === 'number') overalls.push(j.overall);
          if (j && j.verdict) passes.push(j.verdict === 'pass' ? 1 : 0);
        }
        judge = {
          overall_mean: overalls.length ? round(mean(overalls)) : null,
          pass_rate: passes.length ? round(mean(passes)) : null,
        };
      }
      const first = ok[0] || rs[0] || {};
      candidates.push({
        candidate: cand,
        provider: first.provider || null, model: first.model || null,
        n: rs.length, errors: rs.length - ok.length,
        metrics: metricsOut, judge,
        tokens: {
          input: sum(ok.map(r => (r.usage && r.usage.input_tokens) || 0)),
          output: sum(ok.map(r => (r.usage && r.usage.output_tokens) || 0)),
        },
        cost_usd: round(sum(ok.map(r => (r.usage && r.usage.cost_usd) || 0)), 6),
        latency_ms_mean: ok.length ? Math.round(mean(ok.map(r => r.latency_ms || 0))) : null,
      });
    }

    // winner: judge overall first, then first metric, then fewer output tokens.
    // Deterministic and visible — the ranking rule is right here, not learned.
    const firstMetric = metricCells.length ? metricName(metricCells[0]) : null;
    const ranked = candidates.slice().sort((a, b) =>
      num(b.judge && b.judge.overall_mean) - num(a.judge && a.judge.overall_mean)
      || num(firstMetric && b.metrics[firstMetric]) - num(firstMetric && a.metrics[firstMetric])
      || a.tokens.output - b.tokens.output);
    return { candidates, winner: ranked.length > 1 || judgeCells.length || metricCells.length ? (ranked[0] && ranked[0].candidate) : null };
  }

  // ---------- goldens ----------

  function goldenPath(set) {
    const p = safePath(path.join(benchDir, 'goldens'), slugId(set) + '.jsonl');
    if (!p) throw new Error(`golden set escapes workspace: "${set}"`);
    return p;
  }

  function goldenRows(set) { return readJsonl(goldenPath(set)); }

  function listGoldenSets() {
    const dir = path.join(benchDir, 'goldens');
    if (!isDir(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().map(f => {
      const set = f.replace(/\.jsonl$/, '');
      const rows = goldenRows(set);
      return {
        set, total: rows.length,
        draft: rows.filter(r => (r.status || 'draft') === 'draft').length,
        approved: rows.filter(r => r.status === 'approved').length,
        rejected: rows.filter(r => r.status === 'rejected').length,
      };
    });
  }

  // The HITL gate for synthetic data: flip draft rows to approved/rejected.
  // The goldens file is rewritten in place (one row per golden, status is a
  // field); every decision is also appended to the set's annotations log so
  // the audit trail is append-only even though the working file is not.
  function decideGolden(set, decisions, by = 'human') {
    const rows = goldenRows(set);
    const byId = {};
    for (const d of Array.isArray(decisions) ? decisions : []) {
      if (d && d.id && (d.status === 'approved' || d.status === 'rejected' || d.status === 'draft')) byId[d.id] = d.status;
    }
    const ts = iso();
    let result = applyGoldenDecisions(rows, byId, ts, by);
    if (result.changed) {
      result = applyGoldenDecisions(goldenRows(set), byId, ts, by);
      for (const a of result.annotations) appendJsonl(annotationsPath('goldens', set), a);
      writeFile(goldenPath(set), result.rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    return { set, changed: result.changed, ...tallyGolden(result.rows) };
  }

  function applyGoldenDecisions(rows, byId, ts, by) {
    let changed = 0;
    const annotations = [];
    const out = rows.map(row => {
      const want = byId[row._id];
      if (!want || (row.status || 'draft') === want) return row;
      changed++;
      const decided = { ...row, status: want, decided: ts, decided_by: by };
      annotations.push({ ts, item_id: row._id, label: want, by });
      return decided;
    });
    return { rows: out, changed, annotations };
  }

  // Hand-add one golden row (human-origin rows are born approved — a person
  // wrote them, the HITL gate is for synthetic rows).
  function addGoldenRow(set, fields, by = 'human') {
    const created = iso();
    const row = {
      _id: sha256(set + JSON.stringify(fields) + created).slice(0, 12),
      ...fields,
      origin: 'human', status: 'approved', created, decided_by: by,
    };
    appendJsonl(goldenPath(set), row);
    return row;
  }

  function tallyGolden(rows) {
    return {
      total: rows.length,
      draft: rows.filter(r => (r.status || 'draft') === 'draft').length,
      approved: rows.filter(r => r.status === 'approved').length,
      rejected: rows.filter(r => r.status === 'rejected').length,
    };
  }

  // ---------- annotations ----------

  function annotationsPath(nb, cellId) {
    const p = safePath(path.join(benchDir, 'annotations'), `${slugId(nb)}--${slugId(cellId)}.jsonl`);
    if (!p) throw new Error('annotation path escapes workspace');
    return p;
  }

  function annotations(nb, cellId) { return readJsonl(annotationsPath(nb, cellId)); }

  // Record one human label for one item. Append-only; the newest row for an
  // item_id wins when reading.
  function annotate(nb, cellId, { item_id, label, note, by } = {}) {
    if (!item_id || label == null || label === '') throw new Error('annotate needs item_id and label');
    const row = {
      ts: iso(), item_id: String(item_id), label: String(label),
      note: note ? String(note).slice(0, 1000) : null,
      by: by || 'human',
    };
    appendJsonl(annotationsPath(nb, cellId), row);
    return row;
  }

  // ---------- small helpers ----------

  function requireProvider(cfg, dflt) {
    const name = String((cfg && cfg.provider) || dflt).toLowerCase();
    const p = providers.get(name);
    if (!p) throw new Error(`unknown provider "${name}"`);
    const a = p.available();
    if (!a.ok) throw new Error(`provider "${name}" unavailable: ${a.reason}`);
    return p;
  }

  function rel(p) { return path.relative(wsDir, p); }

  return {
    wsDir, benchDir, providers,
    listNotebooks, readNotebook, readNotebookFile, writeNotebookFile, notebookPath,
    runCell, runAll, readCellRecord,
    computeMetric,
    goldenRows, listGoldenSets, decideGolden, addGoldenRow,
    annotations, annotate,
  };
}

// ---------------------------------------------------------------------------
// module-level helpers (pure, provider-free)
// ---------------------------------------------------------------------------

// {{var}} substitution — dotted paths supported ({{row.field}} unnecessary;
// vars resolve on the row itself). Unknown vars render as empty string.
function renderTemplate(template, row) {
  return String(template).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const v = row && row[key];
    return v == null ? '' : String(v);
  });
}

// Merge a loop pass's feedback bindings over the row for template rendering.
// The binding keys are dotted ({{feedback.rationale}}, {{previous.output}}) —
// renderTemplate looks vars up as literal keys, so a flat merge is exact and
// a row field can never be shadowed (rows don't carry dotted keys).
function withLoopBindings(ctx, row) {
  if (!ctx || !ctx.bindings) return row;
  const base = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  return { ...base, ...ctx.bindings };
}

function templateVars(template) {
  const out = [];
  for (const m of String(template).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// Run a user expression with a timeout. This is an accident guard (infinite
// loops, typos), not a sandbox — the notebook is the user's own local file,
// the same trust as any script they run. Kept module-level so metrics can be
// unit-tested without an engine.
function runExpr(expr, scope) {
  if (!String(expr || '').trim()) throw new Error('empty expression');
  return vm.runInNewContext(String(expr), Object.assign({}, scope), { timeout: EXPR_TIMEOUT_MS });
}

// Bound what an http/file tool feeds back into the loop — big payloads get a
// visible clip marker instead of silently ballooning the conversation.
function clipToolResult(s) {
  const text = String(s);
  return text.length > TOOL_RESULT_CAP
    ? text.slice(0, TOOL_RESULT_CAP) + `\n…(clipped at ${TOOL_RESULT_CAP} chars)`
    : text;
}

// The http tool's real network path — kept tiny so tests never need it
// (createBench accepts an httpTransport override). Node 18+ global fetch.
async function defaultHttpTransport({ method, url, headers, body }) {
  const res = await fetch(url, { method, headers, body });
  return { status: res.status, body: await res.text() };
}

// Visible columns of a row list — bookkeeping fields stay out of the table.
function rowColumns(rows) {
  const columns = [];
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) {
      if (!k.startsWith('_') && k !== 'status' && k !== 'origin' && !columns.includes(k)) columns.push(k);
    }
  }
  return columns;
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sum = a => a.reduce((x, y) => x + y, 0);
const num = v => (typeof v === 'number' && isFinite(v) ? v : -Infinity);

function listOf(v) {
  return (Array.isArray(v) ? v : v == null ? [] : [v]).filter(x => typeof x === 'string' && x);
}
function listOfAny(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
function missing(cellId, id) { throw new Error(`${cellId}: references unknown cell "${id}"`); }

function rowInput(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.input != null ? row.input : row.question != null ? row.question : JSON.stringify(row));
}
function rowExpected(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.expected != null ? row.expected : row.answer != null ? row.answer : '');
}

function publicRow(r) {
  const out = {};
  for (const k of Object.keys(r)) if (!k.startsWith('_') && !['status', 'origin', 'created', 'decided', 'decided_by', 'generator'].includes(k)) out[k] = r[k];
  return out;
}

function firstJudgeVerdict(judgments) {
  for (const k of Object.keys(judgments || {})) {
    const j = judgments[k];
    if (j && (j.verdict === 'pass' || j.verdict === 'fail')) return j.verdict;
  }
  return null;
}

// is a label "positive"? first label in the configured list = positive by
// convention (documented in the annotate cell reference)
function positiveLabel(label, labels) {
  if (!labels || !labels.length) return null;
  return String(label) === String(labels[0]);
}

// tolerant JSON extraction — models wrap JSON in prose/code fences
function extractJsonArray(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  if (start < 0) return [];
  for (let end = s.lastIndexOf(']'); end > start; end = s.lastIndexOf(']', end - 1)) {
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      if (Array.isArray(v)) return v;
    } catch { /* keep shrinking */ }
  }
  return [];
}

function extractJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  for (let end = s.lastIndexOf('}'); end > start; end = s.lastIndexOf('}', end - 1)) {
    try {
      const v = JSON.parse(s.slice(start, end + 1));
      if (v && typeof v === 'object') return v;
    } catch { /* keep shrinking */ }
  }
  return null;
}

function payloadLite(payload) {
  const { summary, candidates, metrics, judges, data } = payload;
  return { data, candidates, metrics, judges, summary };
}

function liteResult(r) {
  return {
    item_id: r.item_id, row_index: r.row_index, candidate: r.candidate,
    row: r.row, output: r.output, error: r.error,
    metrics: r.metrics, judgments: r.judgments,
    usage: r.usage, latency_ms: r.latency_ms,
    turns: (r.turns || []).slice(0, 20),
    provider: r.provider, model: r.model,
    ...(r.handoff ? { handoff: r.handoff } : {}),
    ...(r.handoffs ? { handoffs: r.handoffs } : {}),
  };
}

module.exports = {
  createBench,
  RunCancelledError,
  renderTemplate,
  templateVars,
  runExpr,
  extractJsonArray,
  extractJsonObject,
};
