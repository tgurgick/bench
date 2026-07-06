// lib/engine.js — the bench execution engine.
//
// One place to benchmark models and run experiments, as a reactive notebook:
// marimo's model (cells form a dependency graph; running a cell re-runs its
// stale ancestors and marks descendants stale) with n8n's cells (each cell is
// a typed node — dataset, prompt, agent loop, metric, judge, golden set,
// eval grid, annotation). The engine executes cells (async, because model
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

const { parseNotebook, serializeNotebook, buildGraph, runPlan, downstream, slugId } = require('./notebook');
const { createProviders } = require('./providers');
const { safeRead, isDir, safePath } = require('./fsutil');

const EXPR_TIMEOUT_MS = 200;   // accident guard for expr metrics/judges/tools
const DEFAULT_MAX_TURNS = 4;   // agent loop ceiling unless the cell says otherwise
const EVAL_ROW_CAP = 200;      // hard cap on rows per eval run — explicit `limit` can only lower it

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

// options: { wsDir, providers?, now? }. `now` is injectable so runs are
// deterministic under test; `providers` accepts a registry from
// createProviders (tests inject transports through it).
function createBench(options = {}) {
  const wsDir = path.resolve(options.wsDir);
  const providers = options.providers || createProviders();
  const nowFn = options.now || (() => new Date());

  const benchDir = path.join(wsDir, '_bench');
  const metricsDir = path.join(wsDir, '_metrics');

  const iso = () => nowFn().toISOString();
  const stamp = () => iso().replace(/[-:.TZ]/g, '').slice(0, 14);

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
  // downstream immediately, not only after the edited cell re-runs). Note
  // cells are never stale — prose doesn't execute. Memoized per check; the
  // visiting set stops recursion if a cycle sneaks in (cycles are also
  // rejected before any run).
  function makeStaleCheck(name, cells, graph) {
    const byId = {};
    for (const c of cells) byId[c.id] = c;
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
      const record = await executeCell(name, cell, graph, byId);
      writeFile(cellRecordPath(name, id), JSON.stringify(record, null, 2) + '\n');
      ran.push(id);
    }
    return { ran, notebook: readNotebook(name) };
  }

  // Execute one cell and wrap its output in the persisted record shape. A
  // throwing executor produces an error record (the cell shows red, the file
  // says why) rather than crashing the run of everything else — except when
  // downstream cells need it, in which case the error propagates naturally
  // because ctx.resolve refuses error records.
  async function executeCell(name, cell, graph, byId) {
    const deps = {};
    for (const d of graph.deps[cell.id] || []) {
      const rec = readCellRecord(name, d);
      if (rec) deps[d] = rec.ran_at;
    }
    const base = {
      cell_id: cell.id, type: cell.type,
      config_hash: configHash(cell), ran_at: iso(), deps,
    };
    try {
      const output = EXECUTORS[cell.type]
        ? await EXECUTORS[cell.type](makeCtx(name, cell, byId), cell)
        : unsupported(cell);
      return { ...base, output, error: null };
    } catch (e) {
      return { ...base, output: null, error: String(e && e.message || e) };
    }
  }

  function unsupported(cell) {
    throw new Error(`no executor for cell type "${cell.type}"`);
  }

  // The per-execution context executors see: resolve upstream outputs, reach
  // providers, and write artifacts under this notebook's run dir.
  function makeCtx(name, cell, byId) {
    return {
      wsDir, benchDir, providers, iso, stamp,
      notebook: name,
      cell,
      resolve(refId, what) {
        if (!refId) throw new Error(`${cell.id}: missing ${what || 'reference'}`);
        const refCell = byId[refId];
        if (!refCell) throw new Error(`${cell.id}: references unknown cell "${refId}"`);
        const rec = readCellRecord(name, refId);
        if (!rec || rec.error) throw new Error(`${cell.id}: upstream "${refId}" has ${rec ? 'an error' : 'not run'} — run it first`);
        return { cell: refCell, output: rec.output };
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
    const columns = [];
    for (const r of rows) for (const k of Object.keys(r)) {
      if (!k.startsWith('_') && k !== 'status' && k !== 'origin' && !columns.includes(k)) columns.push(k);
    }
    return { rows, columns, count: rows.length, source };
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
      if (row) preview = renderTemplate(template, row);
    }
    return { template, system: cfg.system ? String(cfg.system) : null, vars, preview };
  }

  // agent — one agent-loop definition. Running the cell alone is a smoke test
  // on the sample input (config `input:` or the first row of its data ref);
  // eval grids call the same loop per row via runAgentLoop.
  async function execAgent(ctx, cell) {
    const cfg = cell.config || {};
    let row = null;
    if (cfg.input != null) row = typeof cfg.input === 'object' ? cfg.input : { input: cfg.input };
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
    if (!row) throw new Error(`${cell.id}: give the agent an input: or a data: cell to smoke-test on`);
    const result = await runAgentLoop(ctx, cell, row);
    return { sample_row: row, ...result };
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
  // proven before an eval leans on it.
  async function execJudge(ctx, cell) {
    const cfg = cell.config || {};
    const kind = String(cfg.kind || 'llm').toLowerCase();
    if (kind === 'code') {
      if (!String(cfg.expr || '').trim()) throw new Error(`${cell.id}: code judge needs expr:`);
      const sample = await runJudge(ctx, cell, { input: 'sample input', output: 'sample output', expected: 'sample output' });
      return { kind, dimensions: dimsOf(cfg), sample };
    }
    if (kind !== 'llm') throw new Error(`${cell.id}: judge kind must be llm or code`);
    const provider = requireProvider(cfg, 'fixture');
    const sample = await runJudge(ctx, cell, { input: 'sample input', output: 'sample output', expected: 'sample output' });
    return { kind, provider: provider.name, model: cfg.model || null, dimensions: dimsOf(cfg), sample };
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

    const runId = `run-${stamp()}`;
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
          const r = await runAgentLoop(ctx, candCell, row);
          item.output = r.output;
          item.turns = r.turns;
          item.usage = r.usage;
          item.provider = r.provider;
          item.model = r.model;
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

    const anns = annotations(ctx.notebook, cell.id);
    const byItem = {};
    for (const a of anns) byItem[a.item_id] = a; // last write wins
    const labeled = Object.keys(byItem).length;
    const tally = {};
    for (const a of Object.values(byItem)) tally[a.label] = (tally[a.label] || 0) + 1;

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

  // ---------- the agent loop (n8n's node, marimo's cell) ----------

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
    const messages = [{ role: 'user', content: renderTemplate(template, row) }];
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
        try { result = tool ? String(tool.run(call.args || {})) : `unknown tool "${call.name}"`; }
        catch (e) { result = `tool error: ${String(e && e.message || e)}`; }
        turns.push({ turn, kind: 'tool', tool: call.name, args: call.args, result: result.slice(0, 2000) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      if (turn === maxTurns) finalText = reply.text || '(max turns reached with tool calls pending)';
    }

    return {
      output: finalText, turns, usage,
      provider: provider.name, model: cfg.model || 'fixture-1',
    };
  }

  // Builtin tools an agent cell can request by name, plus inline expr tools
  // ({ name, description, expr } evaluated with `args` and `row` in scope).
  function resolveTools(spec, row, ctx) {
    const out = [];
    for (const t of listOfAny(spec)) {
      if (typeof t === 'string') {
        const b = BUILTIN_TOOLS[t];
        if (!b) throw new Error(`unknown builtin tool "${t}" (have: ${Object.keys(BUILTIN_TOOLS).join(', ')})`);
        out.push(b(row, ctx));
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
    let changed = 0;
    const ts = iso();
    for (const r of rows) {
      const want = byId[r._id];
      if (!want || (r.status || 'draft') === want) continue;
      r.status = want;
      r.decided = ts;
      r.decided_by = by;
      changed++;
      appendJsonl(annotationsPath('goldens', set), { ts, item_id: r._id, label: want, by });
    }
    if (changed) writeFile(goldenPath(set), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    return { set, changed, ...tallyGolden(rows) };
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
  };
}

module.exports = {
  createBench,
  renderTemplate,
  templateVars,
  runExpr,
  extractJsonArray,
  extractJsonObject,
};
