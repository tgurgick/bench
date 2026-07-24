// lib/notebook.js — the .bench.md notebook format + the reactive graph.
//
// A bench notebook is one markdown file: frontmatter, then a sequence of cells.
// Typed cells are fenced ```tl-cell blocks whose body is the YAML config the
// engine executes; any prose between fences is a note cell. The file is the
// notebook — diffable, portable, no hidden state: markdown is the database.
//
//     ---
//     notebook: model-compare
//     title: "Compare models on support replies"
//     ---
//
//     Prose here becomes a note cell.
//
//     ```tl-cell
//     id: replies
//     type: data
//     rows:
//       - input: "Where is my order?"
//         expected: "status link"
//     ```
//
// Reactivity is marimo's idea on n8n's cells: cells reference each other by id
// (`data: replies`), those references form a DAG, and running a cell marks its
// descendants stale. The graph is derived from the configs — there is no
// separate wiring file to drift out of sync. Node stdlib only; zero deps.

'use strict';

const { parseYaml, parseFrontmatter } = require('./yaml');

// The cell types the engine knows how to execute. `note` is prose (never
// executed); everything else has an executor in lib/engine.js. switch/map/
// retry/catch are the control nodes — branch, transform, bounded retry, and
// the explicit error path. `gate` evaluates an input cell and records a
// pass/fail verdict while passing the input through. `tool` is a reusable
// tool definition agent cells reference by id from `tools:`.
const CELL_TYPES = ['note', 'data', 'prompt', 'agent', 'metric', 'judge', 'golden', 'eval', 'annotate', 'switch', 'map', 'retry', 'catch', 'gate', 'tool'];

// The builtin tool names agents can list in `tools:` without any cell backing
// them (their executors live in lib/engine.js). Canonical here because the
// graph needs the list too: a `tools:` string that names a builtin is not a
// cell reference, so refStrings must skip it — otherwise `tools: [calc]`
// would read as a dangling ref and keep the agent permanently stale. Builtins
// shadow tool cells: these names are reserved.
const BUILTIN_TOOL_NAMES = ['calc', 'today', 'lookup'];

// Where cell references live, per type. The graph walks exactly these config
// fields — a string (or array of strings) whose value is another cell's id is
// an edge. A dotted entry (`cases.use`) reaches one key on each object of a
// config list, for the types whose refs live inside structured items (switch
// cases). Explicit and boring beats clever: you can always see why an edge
// exists by looking at the named field. `needs` is the generic escape hatch
// every type supports for ordering without data flow.
const REF_FIELDS = {
  data: ['needs'],
  prompt: ['data', 'needs'],
  agent: ['prompt', 'data', 'input_from', 'tools', 'needs'],
  metric: ['needs'],
  judge: ['input_from', 'needs'],
  golden: ['seed_data', 'needs'],
  eval: ['data', 'candidates', 'metrics', 'judges', 'needs'],
  annotate: ['source', 'needs'],
  switch: ['input', 'cases.use', 'default', 'needs'],
  map: ['input', 'needs'],
  retry: ['target', 'needs'],
  catch: ['try', 'fallback', 'needs'],
  gate: ['input', 'needs'],
  tool: ['needs'],
};

// Cell fences carry the same length discipline as prose fences (CommonMark's
// rule): a cell may open with three or more backticks, and closes only on a
// bare run at least as long as the opener. Three stays the default; opening
// with four (````tl-cell) is the escape hatch for a body that must contain a
// bare ``` line — the serializer picks the length automatically.
const FENCE_OPEN = /^(`{3,})tl-cell\s*$/;
const FENCE_CLOSE = /^(`{3,})\s*$/;
// A generic fenced code block opening in prose (``` or ~~~, longer runs, any
// info string). While one is open, a quoted ```tl-cell line is content — the
// standard way docs show the format — not a cell boundary. Only a truly bare,
// top-level ```tl-cell fence opens a cell.
const PROSE_FENCE = /^(`{3,}|~{3,})/;

// ---------------------------------------------------------------------------
// Parse / serialize — a strict round trip
// ---------------------------------------------------------------------------

// Parse one .bench.md text into { meta, cells, errors }. Never throws: a
// malformed cell block becomes a cell with an `error` field so the UI can show
// it in place instead of dropping it.
function parseNotebook(text) {
  const { meta, body } = parseFrontmatter(String(text || ''));
  const lines = body.split('\n');
  const cells = [];
  const errors = [];
  let prose = [];
  let noteSeq = 0;

  const flushProse = () => {
    const t = prose.join('\n').trim();
    prose = [];
    if (t) cells.push({ id: `note-${++noteSeq}`, type: 'note', text: t });
  };

  // Tracks an open generic fence in prose ({ ch, len }) so a ```tl-cell line
  // quoted inside it stays prose. Closed by a bare run of the same character,
  // at least as long as the opener (CommonMark's rule; a close fence carries
  // no info string, which is why ```tl-cell can never close an outer block).
  let proseFence = null;

  for (let i = 0; i < lines.length; i++) {
    if (proseFence) {
      prose.push(lines[i]);
      const m = lines[i].match(/^(`{3,}|~{3,})\s*$/);
      if (m && m[1][0] === proseFence.ch && m[1].length >= proseFence.len) proseFence = null;
      continue;
    }
    const open = lines[i].match(FENCE_OPEN);
    if (!open) {
      prose.push(lines[i]);
      const m = lines[i].match(PROSE_FENCE);
      if (m) proseFence = { ch: m[1][0], len: m[1].length };
      continue;
    }
    flushProse();
    const openLen = open[1].length;
    const block = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      const cm = lines[i].match(FENCE_CLOSE);
      if (cm && cm[1].length >= openLen) { closed = true; break; }
      block.push(lines[i]);
    }
    const raw = block.join('\n');
    const cell = parseCellBlock(raw);
    if (!closed) cell.error = 'unclosed tl-cell fence';
    cells.push(cell);
    if (cell.error) errors.push({ id: cell.id, error: cell.error });
  }
  flushProse();

  // duplicate ids break the graph — flag every later occurrence
  const seen = new Set();
  for (const c of cells) {
    if (seen.has(c.id)) {
      c.error = c.error || `duplicate cell id "${c.id}"`;
      errors.push({ id: c.id, error: c.error });
    }
    seen.add(c.id);
  }

  return { meta: meta || {}, cells, errors };
}

// Block scalars (`key: |`) hold the multi-line strings bench configs need —
// prompt templates, rubrics, generation instructions. The shared YAML-subset
// parser (lib/parse.js) doesn't know them (it strips blank lines and `#`
// comments, which would mangle prose), so they are lifted out here, at the
// cell-block layer, before the rest of the YAML is parsed. Top-level keys
// only — templates and rubrics are always top-level in a cell config. The
// body's indent is whatever the first non-empty line uses (YAML's rule, ≥1
// space); a line indented less than that ends the block.
function extractBlockScalars(raw) {
  const lines = String(raw).split('\n');
  const rest = [];
  const extras = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w][\w.-]*):\s*\|\s*$/);
    if (!m) { rest.push(lines[i]); continue; }
    const block = [];
    let indent = 0;
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() === '') { block.push(''); continue; }
      const ind = lines[i].match(/^ */)[0].length;
      if (!indent) {
        if (ind < 1) { i--; break; }
        indent = ind;
      }
      if (ind < indent) { i--; break; }
      block.push(lines[i].slice(indent));
    }
    while (block.length && block[block.length - 1] === '') block.pop();
    extras[m[1]] = block.join('\n');
  }
  return { rest: rest.join('\n'), extras };
}

// One fenced block's YAML → a cell { id, type, config } (config = everything
// but id/type). Degrades to an error cell rather than throwing.
function parseCellBlock(raw) {
  const { rest, extras } = extractBlockScalars(raw);
  let cfg = null;
  try { cfg = parseYaml(rest); } catch { cfg = null; }
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) Object.assign(cfg, extras);
  else if (Object.keys(extras).length) cfg = Object.assign({}, extras);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { id: 'invalid', type: 'note', text: raw, error: 'cell block is not a YAML map' };
  }
  const id = slugId(cfg.id);
  const type = String(cfg.type || '').toLowerCase();
  const config = {};
  for (const k of Object.keys(cfg)) if (k !== 'id' && k !== 'type') config[k] = cfg[k];
  const cell = { id: id || 'unnamed', type: CELL_TYPES.includes(type) ? type : type || 'unknown', config, raw };
  if (!id) cell.error = 'cell is missing a valid id (lowercase slug)';
  else if (!CELL_TYPES.includes(type)) cell.error = `unknown cell type "${type}"`;
  // loop-back edges live on gates only (v1) — anywhere else the key is a
  // config mistake, flagged at parse so the canvas shows it in place
  else if (config.loop != null && type !== 'gate') {
    cell.error = `loop: is only valid on a gate cell (a ${type} cell cannot carry a loop-back)`;
  }
  return cell;
}

// The loop-back a gate declares, if any: { back_to, max }. The back-edge is
// metadata, not a dependency: refStrings includes back_to (so a renamed
// target goes stale with a readable error) but cellRefs excludes it, so
// buildGraph stays acyclic and the cycle check never sees the backward edge —
// iteration lives inside the gate's execution (the retry/ctx.exec precedent).
function loopBackOf(cell) {
  if (!cell || cell.type !== 'gate') return null;
  const l = cell.config && cell.config.loop;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  return { back_to: typeof l.back_to === 'string' ? l.back_to : '', max: l.max };
}

function slugId(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]*$/.test(s) ? s : '';
}

// Serialize { meta, cells } back to .bench.md text. Note cells emit their prose
// bare; typed cells emit their raw YAML when untouched (preserving the author's
// formatting) or a regenerated block when the config object was edited.
function serializeNotebook(nb) {
  const out = [];
  const meta = nb.meta || {};
  const metaKeys = Object.keys(meta);
  if (metaKeys.length) {
    out.push('---');
    for (const k of metaKeys) out.push(`${k}: ${yamlScalar(meta[k])}`);
    out.push('---', '');
  }
  for (const cell of nb.cells || []) {
    if (cell.type === 'note') { out.push(cell.text || '', ''); continue; }
    const body = (cell.raw != null ? cell.raw : cellYaml(cell)).replace(/\n+$/, '');
    const fence = cellFence(body);
    out.push(fence + 'tl-cell');
    out.push(body);
    out.push(fence, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

// The opening fence for a cell body: three backticks unless the body holds a
// bare backtick-run line, in which case the fence must outrun the longest such
// run — otherwise re-parsing would close the cell early. The serializer half
// of the fence-length discipline: parse honors longer fences, serialize emits
// them exactly when the body needs one, so the round trip holds.
function cellFence(body) {
  let max = 2;
  for (const line of body.split('\n')) {
    const m = line.match(FENCE_CLOSE);
    if (m && m[1].length > max) max = m[1].length;
  }
  return '`'.repeat(Math.max(3, max + 1));
}

// Render a cell's id/type/config as the YAML subset lib/parse.js reads back.
// Only the shapes bench configs use: scalars, string arrays, row lists, and
// one level of nested maps. Multi-line strings fall back to quoted scalars.
function cellYaml(cell) {
  const lines = [`id: ${cell.id}`, `type: ${cell.type}`];
  const cfg = cell.config || {};
  for (const k of Object.keys(cfg)) lines.push(...yamlEntry(k, cfg[k], 0));
  return lines.join('\n');
}

function yamlEntry(key, v, indent) {
  const pad = ' '.repeat(indent);
  // multi-line strings serialize as the block scalars parseCellBlock lifts
  // back out — the round-trip pair of extractBlockScalars (top level only)
  if (typeof v === 'string' && v.includes('\n') && indent === 0) {
    return [`${key}: |`, ...v.split('\n').map(l => (l ? '  ' + l : ''))];
  }
  if (Array.isArray(v)) {
    if (!v.length) return [`${pad}${key}: []`];
    const lines = [`${pad}${key}:`];
    for (const item of v) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item);
        if (!keys.length) { lines.push(`${pad}  -`); continue; }
        lines.push(`${pad}  - ${keys[0]}: ${yamlScalar(item[keys[0]])}`);
        for (const k of keys.slice(1)) lines.push(`${pad}    ${k}: ${yamlScalar(item[k])}`);
      } else lines.push(`${pad}  - ${yamlScalar(item)}`);
    }
    return lines;
  }
  if (v && typeof v === 'object') {
    const lines = [`${pad}${key}:`];
    for (const k of Object.keys(v)) lines.push(...yamlEntry(k, v[k], indent + 2));
    return lines;
  }
  return [`${pad}${key}: ${yamlScalar(v)}`];
}

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // quote anything YAML could misread; escape for double quotes
  if (/^[a-zA-Z0-9][a-zA-Z0-9 _./-]*$/.test(s) && !/^(true|false|null|~)$/i.test(s) && !/^-?\d/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

// ---------------------------------------------------------------------------
// The graph — references → edges → topo order → staleness
// ---------------------------------------------------------------------------

// Every string sitting in one of the cell type's ref positions, whether or
// not it names a live cell. REF_FIELDS entries are a config key or `list.key`
// — a key on each object of a config list (switch cases). Shared by the graph
// (edges = strings that name cells) and the engine's staleness check
// (dangling = strings that don't), so the two can never disagree. The `tools`
// field mixes reference kinds: builtin names are not refs (skipped via
// BUILTIN_TOOL_NAMES) and inline tool objects fall out naturally (only
// strings are collected) — leaving exactly the tool-cell ids.
function refStrings(cell) {
  const out = edgeRefStrings(cell);
  // a gate's loop back_to is a reference (rename → stale, readable error) but
  // never a graph edge — edgeRefStrings keeps the two roles separate
  const loop = loopBackOf(cell);
  if (loop && loop.back_to && !out.includes(loop.back_to)) out.push(loop.back_to);
  return out;
}

// The strings that become graph edges — refStrings minus loop-back metadata.
function edgeRefStrings(cell) {
  const out = [];
  const cfg = cell.config || {};
  for (const f of REF_FIELDS[cell.type] || []) {
    const [key, sub] = f.split('.');
    const v = cfg[key];
    const list = Array.isArray(v) ? v : v == null ? [] : [v];
    for (const item of list) {
      const s = sub
        ? (item && typeof item === 'object' && !Array.isArray(item) ? item[sub] : undefined)
        : item;
      if (typeof s !== 'string' || !s) continue;
      if (key === 'tools' && BUILTIN_TOOL_NAMES.includes(s)) continue;
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

// The upstream cell ids a cell references, from its type's REF_FIELDS only.
// A value that names no cell is not an error here (the engine reports missing
// refs at run time with context); the graph simply has no edge for it. The
// loop back_to is deliberately absent: a back-edge is metadata, and adding it
// as an edge would turn a misdrawn loop into an opaque "dependency cycle"
// instead of the gate's readable not-an-ancestor error.
function cellRefs(cell, idSet) {
  return edgeRefStrings(cell).filter(id => idSet.has(id));
}

// Build the dependency graph for a cell list: per-cell upstream refs, a
// topological order, and any cycles (as the set of cell ids left unordered).
// Note cells participate as isolated nodes so document order is preserved.
function buildGraph(cells) {
  const idSet = new Set(cells.map(c => c.id));
  const deps = {};    // id -> upstream ids
  const rdeps = {};   // id -> downstream ids
  for (const c of cells) { deps[c.id] = []; rdeps[c.id] = rdeps[c.id] || []; }
  for (const c of cells) {
    for (const ref of cellRefs(c, idSet)) {
      deps[c.id].push(ref);
      (rdeps[ref] = rdeps[ref] || []).push(c.id);
    }
  }

  // Kahn's algorithm, seeded in document order so ties keep the author's layout.
  const indeg = {};
  for (const c of cells) indeg[c.id] = deps[c.id].length;
  const queue = cells.filter(c => indeg[c.id] === 0).map(c => c.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const d of rdeps[id] || []) {
      if (--indeg[d] === 0) queue.push(d);
    }
  }
  const cycle = cells.map(c => c.id).filter(id => !order.includes(id));
  return { deps, rdeps, order, cycle };
}

// Every cell downstream of `changedId` (excluding it) — the set that goes
// stale when a cell's config changes or it re-runs with a new output.
function downstream(graph, changedId) {
  const out = new Set();
  const walk = id => {
    for (const d of graph.rdeps[id] || []) {
      if (out.has(d)) continue;
      out.add(d);
      walk(d);
    }
  };
  walk(changedId);
  return out;
}

// The execution plan for "run cell X": X plus every ancestor that must
// re-run first, in topological order. An ancestor re-runs when `isStale(id)`
// reports it dirty (config changed / never ran) — and staleness propagates:
// a fresh cell whose own upstream is in the plan re-runs too, because its
// input is about to change. `isStale` is supplied by the engine (it compares
// config hashes and output stamps); the graph only knows shape.
function runPlan(graph, targetId, isStale) {
  const ancestors = new Set();
  const up = id => {
    for (const d of graph.deps[id] || []) {
      if (ancestors.has(d)) continue;
      ancestors.add(d);
      up(d);
    }
  };
  up(targetId);

  const need = new Set([targetId]);
  for (const id of graph.order) {
    if (!ancestors.has(id)) continue;
    if (isStale(id) || (graph.deps[id] || []).some(d => need.has(d))) need.add(id);
  }
  return graph.order.filter(id => need.has(id));
}

module.exports = {
  CELL_TYPES,
  REF_FIELDS,
  BUILTIN_TOOL_NAMES,
  parseNotebook,
  serializeNotebook,
  cellYaml,
  cellRefs,
  refStrings,
  loopBackOf,
  buildGraph,
  downstream,
  runPlan,
  slugId,
};
