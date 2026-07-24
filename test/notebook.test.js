'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseNotebook, serializeNotebook, buildGraph, downstream, runPlan, cellRefs, slugId,
  refStrings, CELL_TYPES, BUILTIN_TOOL_NAMES,
} = require('../lib/notebook');

const SAMPLE = `---
notebook: t
title: "A test notebook"
---

Some prose before any cell.

\`\`\`tl-cell
id: rows
type: data
rows:
  - input: "a"
    expected: "b"
\`\`\`

\`\`\`tl-cell
id: p
type: prompt
data: rows
template: |
  Question:
  {{input}}

  Answer briefly.
\`\`\`

\`\`\`tl-cell
id: bot
type: agent
provider: fixture
prompt: p
\`\`\`
`;

test('parseNotebook splits prose and typed cells', () => {
  const nb = parseNotebook(SAMPLE);
  assert.equal(nb.meta.notebook, 't');
  assert.deepEqual(nb.cells.map(c => c.type), ['note', 'data', 'prompt', 'agent']);
  assert.deepEqual(nb.cells.map(c => c.id), ['note-1', 'rows', 'p', 'bot']);
  assert.equal(nb.errors.length, 0);
});

test('block scalars carry multi-line templates through parse', () => {
  const nb = parseNotebook(SAMPLE);
  const p = nb.cells.find(c => c.id === 'p');
  assert.equal(p.config.template, 'Question:\n{{input}}\n\nAnswer briefly.');
  assert.equal(p.config.data, 'rows');
});

test('serialize → parse round-trips ids, types, and configs', () => {
  const nb = parseNotebook(SAMPLE);
  const text2 = serializeNotebook(nb);
  const nb2 = parseNotebook(text2);
  assert.deepEqual(
    nb2.cells.map(c => [c.id, c.type, c.config]),
    nb.cells.map(c => [c.id, c.type, c.config]),
  );
  assert.deepEqual(nb2.meta, nb.meta);
});

test('regenerated cell yaml (no raw) round-trips block scalars', () => {
  const nb = parseNotebook(SAMPLE);
  for (const c of nb.cells) delete c.raw; // force cellYaml regeneration
  const nb2 = parseNotebook(serializeNotebook(nb));
  const p = nb2.cells.find(c => c.id === 'p');
  assert.equal(p.config.template, 'Question:\n{{input}}\n\nAnswer briefly.');
});

test('quoted scalars survive two parse → serialize cycles byte-identical (meta + cell config)', () => {
  // yamlScalar escapes \" and \\ on the way out; parseScalar must invert it,
  // or every save cycle grows backslashes (the goal editor saves meta on each
  // edit). Values chosen to hit the nasty orderings: quote runs, a lone
  // backslash, and a literal backslash immediately before a quote (\\" must
  // read as escaped-backslash + closing context, never as \ + ").
  const values = [
    'say "hi" twice',
    'path "C:\\tmp"',
    'trailing backslash \\',
    'backslash before quote \\" here',
  ];
  for (const v of values) {
    const nb = {
      meta: { notebook: 't', goal: v },
      cells: [{ id: 'a', type: 'data', config: { rows: [], label: v } }],
    };
    const text1 = serializeNotebook(nb);
    const p1 = parseNotebook(text1);
    assert.equal(p1.meta.goal, v, `cycle 1 meta: ${JSON.stringify(v)}`);
    assert.equal(p1.cells.find(c => c.id === 'a').config.label, v, `cycle 1 config: ${JSON.stringify(v)}`);
    // cycle 2: drop raw so the cell re-serializes through yamlScalar again
    for (const c of p1.cells) delete c.raw;
    const text2 = serializeNotebook(p1);
    assert.equal(text2, text1, `serialize stable after 1 cycle: ${JSON.stringify(v)}`);
    const p2 = parseNotebook(text2);
    assert.equal(p2.meta.goal, v, `cycle 2 meta: ${JSON.stringify(v)}`);
    assert.equal(p2.cells.find(c => c.id === 'a').config.label, v, `cycle 2 config: ${JSON.stringify(v)}`);
    for (const c of p2.cells) delete c.raw;
    assert.equal(serializeNotebook(p2), text1, `serialize stable after 2 cycles: ${JSON.stringify(v)}`);
  }
  // a newline-holding meta value rides yamlScalar's \n escape and comes back real
  const nb = { meta: { notebook: 't', goal: 'two\nlines' }, cells: [] };
  const p = parseNotebook(serializeNotebook(nb));
  assert.equal(p.meta.goal, 'two\nlines');
});

test('demo notebook: parse → serialize → parse preserves every cell, note text byte-identical', () => {
  // Regression guard for bug-note-prose-roundtrip (reported 2026-07-17,
  // verified non-repro 2026-07-18): the demo's six interleaved prose notes
  // must survive the parse → serialize round trip every server-side edit
  // rides — losing authored prose would break the file-is-truth contract.
  const { DEMO_NOTEBOOK } = require('../lib/demo');
  const first = parseNotebook(DEMO_NOTEBOOK);
  assert.equal(first.errors.length, 0);
  const notes = first.cells.filter(c => c.type === 'note');
  assert.equal(notes.length, 6, 'the demo carries six interleaved prose notes');

  const again = parseNotebook(serializeNotebook(first));
  assert.deepEqual(
    again.cells.map(c => [c.id, c.type]),
    first.cells.map(c => [c.id, c.type]),
    'cell sequence (ids, types, order) survives the round trip',
  );
  assert.deepEqual(
    again.cells.filter(c => c.type === 'note').map(c => c.text),
    notes.map(c => c.text),
    'every note survives with byte-identical text',
  );
  // and the cycle is stable: serializing the re-parse changes nothing
  assert.equal(serializeNotebook(again), serializeNotebook(first));
});

test('a tl-cell fence quoted inside an outer code block stays prose', () => {
  const text = [
    'Docs for the format:',
    '',
    '````markdown',
    '```tl-cell',
    'id: fake',
    'type: data',
    '```',
    '````',
    '',
    'More prose.',
    '',
    '```tl-cell',
    'id: real',
    'type: data',
    'rows: []',
    '```',
    '',
  ].join('\n');
  const nb = parseNotebook(text);
  assert.deepEqual(nb.cells.map(c => [c.id, c.type]), [['note-1', 'note'], ['real', 'data']]);
  assert.equal(nb.errors.length, 0);
  assert.ok(nb.cells[0].text.includes('```tl-cell'));
  // round-trip identity: the quoted fence survives parse → serialize → parse
  const nb2 = parseNotebook(serializeNotebook(nb));
  assert.deepEqual(
    nb2.cells.map(c => [c.id, c.type, c.text || null]),
    nb.cells.map(c => [c.id, c.type, c.text || null]),
  );
});

test('tilde and plain-backtick outer fences also shield quoted tl-cell fences', () => {
  const nb = parseNotebook([
    '~~~\n```tl-cell\nid: a\n```\n~~~',
    '```js\n// not closed by ```tl-cell below\n```tl-cell\nid: b\n```',
  ].join('\n\n'));
  assert.deepEqual(nb.cells.map(c => c.type), ['note']);
  assert.equal(nb.errors.length, 0);
});

test('a bare top-level tl-cell fence is always a genuine cell opener', () => {
  // the FEEDBACK repro — indistinguishable from the format, so it parses as a
  // (malformed) cell; quoting the syntax requires an outer fence
  const nb = parseNotebook('See:\n\n```tl-cell\nid: fake\n```\n\nMore\n');
  assert.deepEqual(nb.cells.map(c => c.type), ['note', 'unknown', 'note']);
});

test('fence-length discipline: a four-backtick cell shields a bare ``` line in its body', () => {
  // the fence-inside-cell-body thread repro: a bare ``` line inside a tl-cell
  // body used to end the cell early. Opening with a longer run (````tl-cell)
  // is the escape hatch — the cell closes only on an equal-or-longer bare run.
  const text = [
    '````tl-cell',
    'id: p',
    'type: prompt',
    'template: |',
    '  Fences look like:',
    '```',
    'data: x',
    '````',
    '',
  ].join('\n');
  const nb = parseNotebook(text);
  assert.equal(nb.errors.length, 0);
  assert.deepEqual(nb.cells.map(c => [c.id, c.type]), [['p', 'prompt']]);
  assert.equal(nb.cells[0].config.data, 'x');
  assert.ok(nb.cells[0].raw.split('\n').includes('```'), 'the bare ``` line stays in the body');
});

test('fence-length discipline: an equal-or-longer bare run closes the cell', () => {
  // five backticks close a four-backtick cell (CommonMark rule, mirrored from prose)
  const nb = parseNotebook('````tl-cell\nid: a\ntype: data\nrows: []\n`````\n');
  assert.equal(nb.errors.length, 0);
  assert.deepEqual(nb.cells.map(c => [c.id, c.type]), [['a', 'data']]);
});

test('default three-backtick cells parse exactly as before', () => {
  const nb = parseNotebook(SAMPLE);
  assert.deepEqual(nb.cells.map(c => c.id), ['note-1', 'rows', 'p', 'bot']);
  assert.equal(nb.errors.length, 0);
});

test('a quoted ````tl-cell inside a longer outer prose fence stays prose', () => {
  const nb = parseNotebook('`````\n````tl-cell\nid: fake\n````\n`````\n');
  assert.deepEqual(nb.cells.map(c => c.type), ['note']);
  assert.equal(nb.errors.length, 0);
});

test('serializer emits a longer opening fence when the body holds a bare ``` line', () => {
  const text = [
    '````tl-cell',
    'id: p',
    'type: prompt',
    'template: |',
    '  Fences look like:',
    '```',
    'data: x',
    '````',
    '',
  ].join('\n');
  const nb = parseNotebook(text);
  const text2 = serializeNotebook(nb);
  assert.match(text2, /^````tl-cell$/m, 'opening fence outruns the bare ``` in the body');
  const nb2 = parseNotebook(text2);
  assert.equal(nb2.errors.length, 0);
  assert.deepEqual(
    nb2.cells.map(c => [c.id, c.type, c.config]),
    nb.cells.map(c => [c.id, c.type, c.config]),
  );
  // stable: a second cycle changes nothing
  assert.equal(serializeNotebook(nb2), text2);
});

test('serializer fence outruns even a four-backtick bare run in the body', () => {
  const raw = 'id: a\ntype: data\nrows: []\n````';
  const nb = { meta: {}, cells: [{ id: 'a', type: 'data', config: { rows: [] }, raw }] };
  const text = serializeNotebook(nb);
  assert.match(text, /^`````tl-cell$/m);
  const nb2 = parseNotebook(text);
  assert.equal(nb2.errors.length, 0);
  assert.deepEqual(nb2.cells.map(c => [c.id, c.type]), [['a', 'data']]);
});

test('block scalars indented with a single space do not truncate', () => {
  const nb = parseNotebook([
    '```tl-cell',
    'id: p',
    'type: prompt',
    'template: |',
    ' Question:',
    ' {{input}}',
    '',
    ' Answer briefly.',
    '```',
    '',
  ].join('\n'));
  assert.equal(nb.errors.length, 0);
  assert.equal(nb.cells[0].config.template, 'Question:\n{{input}}\n\nAnswer briefly.');
});

test('block scalar indent follows the first body line', () => {
  const nb = parseNotebook([
    '```tl-cell',
    'id: p',
    'type: prompt',
    'template: |',
    '    deep:',
    '      deeper',
    'data: x',
    '```',
    '',
  ].join('\n'));
  const c = nb.cells[0];
  assert.equal(c.config.template, 'deep:\n  deeper');
  assert.equal(c.config.data, 'x');
});

test('malformed cells degrade to error cells, never throw', () => {
  const nb = parseNotebook('```tl-cell\ntype: data\n```\n\n```tl-cell\nid: x\ntype: nope\n```\n');
  assert.equal(nb.errors.length, 2);
  assert.match(nb.errors[0].error, /missing a valid id/);
  assert.match(nb.errors[1].error, /unknown cell type/);
});

test('duplicate ids are flagged', () => {
  const nb = parseNotebook('```tl-cell\nid: a\ntype: data\nrows: []\n```\n\n```tl-cell\nid: a\ntype: data\nrows: []\n```\n');
  assert.ok(nb.errors.some(e => /duplicate/.test(e.error)));
});

test('graph edges come from typed ref fields only', () => {
  const nb = parseNotebook(SAMPLE);
  const g = buildGraph(nb.cells);
  assert.deepEqual(g.deps.bot, ['p']);
  assert.deepEqual(g.deps.p, ['rows']);
  assert.deepEqual(g.cycle, []);
  // order respects dependencies
  assert.ok(g.order.indexOf('rows') < g.order.indexOf('p'));
  assert.ok(g.order.indexOf('p') < g.order.indexOf('bot'));
});

test('input_from forms agent and judge graph edges', () => {
  const nb = parseNotebook([
    '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\ninput: "hi"\n```',
    '```tl-cell\nid: quality\ntype: judge\nkind: code\nexpr: 1\ninput_from: draft\n```',
    '```tl-cell\nid: revise\ntype: agent\nprovider: fixture\ninput_from: quality\ninput_path: sample\ntemplate: "{{input}}"\n```',
  ].join('\n\n'));
  const g = buildGraph(nb.cells);
  assert.deepEqual(g.deps.quality, ['draft']);
  assert.deepEqual(g.deps.revise, ['quality']);
  assert.ok(g.order.indexOf('draft') < g.order.indexOf('quality'));
  assert.ok(g.order.indexOf('quality') < g.order.indexOf('revise'));
});

test('cycles are detected', () => {
  const nb = parseNotebook([
    '```tl-cell\nid: a\ntype: eval\ndata: b\ncandidates: []\n```',
    '```tl-cell\nid: b\ntype: data\nrows: []\nneeds: [a]\n```',
  ].join('\n\n'));
  const g = buildGraph(nb.cells);
  assert.deepEqual(g.cycle.sort(), ['a', 'b']);
});

test('downstream walks the full descendant set', () => {
  const nb = parseNotebook(SAMPLE);
  const g = buildGraph(nb.cells);
  assert.deepEqual([...downstream(g, 'rows')].sort(), ['bot', 'p']);
  assert.deepEqual([...downstream(g, 'bot')], []);
});

test('runPlan includes stale ancestors and propagates through fresh cells', () => {
  const nb = parseNotebook(SAMPLE);
  const g = buildGraph(nb.cells);
  // rows is stale, p is fresh: running bot must re-run rows, then p (its input
  // is about to change), then bot.
  const plan = runPlan(g, 'bot', id => id === 'rows');
  assert.deepEqual(plan, ['rows', 'p', 'bot']);
  // nothing stale: only the target runs
  assert.deepEqual(runPlan(g, 'bot', () => false), ['bot']);
});

test('cellRefs ignores strings that name no cell', () => {
  const nb = parseNotebook('```tl-cell\nid: e\ntype: eval\ndata: ghost\ncandidates: [also-ghost]\n```');
  const ids = new Set(nb.cells.map(c => c.id));
  assert.deepEqual(cellRefs(nb.cells[0], ids), []);
});

test('slugId accepts slugs and rejects everything else', () => {
  assert.equal(slugId('My-Cell'), 'my-cell');
  assert.equal(slugId('../evil'), '');
  assert.equal(slugId(''), '');
});

// A diamond through control nodes: rows feeds two map branches, a switch
// picks one, a retry guards an agent, a catch guards the retry's target.
const CONTROL = [
  '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "a"\n```',
  '```tl-cell\nid: m1\ntype: map\ninput: rows\nexpr: "({ ...row, branch: 1 })"\n```',
  '```tl-cell\nid: m2\ntype: map\ninput: rows\nexpr: "({ ...row, branch: 2 })"\n```',
  '```tl-cell\nid: sw\ntype: switch\ninput: rows\ncases:\n  - when: count > 1\n    use: m1\ndefault: m2\n```',
  '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: sw\n```',
  '```tl-cell\nid: keep\ntype: retry\ntarget: bot\n```',
  '```tl-cell\nid: safe\ntype: catch\ntry: bot\nfallback: m2\n```',
].join('\n\n');

test('control node refs form graph edges, including refs inside switch cases', () => {
  const nb = parseNotebook(CONTROL);
  assert.equal(nb.errors.length, 0);
  const g = buildGraph(nb.cells);
  assert.deepEqual(g.deps.m1, ['rows']);
  assert.deepEqual(g.deps.sw.sort(), ['m1', 'm2', 'rows']);
  assert.deepEqual(g.deps.keep, ['bot']);
  assert.deepEqual(g.deps.safe.sort(), ['bot', 'm2']);
  assert.deepEqual(g.cycle, []);
});

test('runPlan diamond: a stale root re-runs both branches before the switch', () => {
  const nb = parseNotebook(CONTROL);
  const g = buildGraph(nb.cells);
  const plan = runPlan(g, 'sw', id => id === 'rows');
  assert.deepEqual([...plan].sort(), ['m1', 'm2', 'rows', 'sw']);
  assert.ok(plan.indexOf('rows') < plan.indexOf('m1'));
  assert.ok(plan.indexOf('m1') < plan.indexOf('sw'));
  assert.ok(plan.indexOf('m2') < plan.indexOf('sw'));
  // nothing stale: only the target runs
  assert.deepEqual(runPlan(g, 'sw', () => false), ['sw']);
});

test('downstream from the root reaches every control node', () => {
  const nb = parseNotebook(CONTROL);
  const g = buildGraph(nb.cells);
  assert.deepEqual([...downstream(g, 'rows')].sort(), ['bot', 'keep', 'm1', 'm2', 'safe', 'sw']);
  assert.deepEqual([...downstream(g, 'bot')].sort(), ['keep', 'safe']);
});

test('regenerated switch/map/retry/catch yaml round-trips configs', () => {
  const nb = parseNotebook(CONTROL);
  for (const c of nb.cells) delete c.raw; // force cellYaml regeneration
  const nb2 = parseNotebook(serializeNotebook(nb));
  assert.equal(nb2.errors.length, 0);
  const sw = nb2.cells.find(c => c.id === 'sw');
  assert.deepEqual(sw.config.cases, [{ when: 'count > 1', use: 'm1' }]);
  assert.equal(sw.config.default, 'm2');
  assert.equal(nb2.cells.find(c => c.id === 'm1').config.expr, '({ ...row, branch: 1 })');
  assert.equal(nb2.cells.find(c => c.id === 'keep').config.target, 'bot');
  assert.equal(nb2.cells.find(c => c.id === 'safe').config.try, 'bot');
  // the regenerated graph is identical
  const g = buildGraph(nb2.cells);
  assert.deepEqual(g.deps.sw.sort(), ['m1', 'm2', 'rows']);
});

test('optional threshold on metric/judge cells round-trips', () => {
  const text = [
    '```tl-cell',
    'id: brevity',
    'type: metric',
    'kind: expr',
    'expr: output.length < 240 ? 1 : 0',
    'threshold: 0.75',
    '```',
    '',
    '```tl-cell',
    'id: quality',
    'type: judge',
    'kind: llm',
    'provider: fixture',
    'scale: 5',
    'threshold: 3.5',
    'dimensions: [helpfulness]',
    '```',
  ].join('\n');
  const nb = parseNotebook(text);
  const m = nb.cells.find(c => c.id === 'brevity');
  const j = nb.cells.find(c => c.id === 'quality');
  assert.equal(m.config.threshold, 0.75);
  assert.equal(j.config.threshold, 3.5);
  // regenerated yaml (no raw) must keep threshold
  for (const c of nb.cells) delete c.raw;
  const nb2 = parseNotebook(serializeNotebook(nb));
  assert.equal(nb2.cells.find(c => c.id === 'brevity').config.threshold, 0.75);
  assert.equal(nb2.cells.find(c => c.id === 'quality').config.threshold, 3.5);
  // notebooks without threshold stay valid
  const plain = parseNotebook(SAMPLE);
  assert.equal(plain.cells.find(c => c.id === 'bot').config.threshold, undefined);
});

// ---------------------------------------------------------------------------
// tool nodes — refs, graph, staleness surface, round-trip
// ---------------------------------------------------------------------------

// One tool cell feeding two agents (a diamond onto an eval), with a builtin
// mixed into the same tools: list.
const TOOLS = [
  '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "a"\n```',
  '```tl-cell\nid: shout\ntype: tool\nkind: expr\ndescription: upper-case\nexpr: String(args.input || "").toUpperCase()\nparams:\n  input:\n    type: string\n    description: text to shout\n    required: true\n```',
  '```tl-cell\nid: a1\ntype: agent\nprovider: fixture\ndata: rows\ntools: [calc, shout]\n```',
  '```tl-cell\nid: a2\ntype: agent\nprovider: fixture\ndata: rows\ntools: [shout]\n```',
  '```tl-cell\nid: compare\ntype: eval\ndata: rows\ncandidates: [a1, a2]\n```',
].join('\n\n');

test('tool cells parse; tool refs form graph edges, builtin names do not', () => {
  assert.ok(CELL_TYPES.includes('tool'));
  assert.deepEqual(BUILTIN_TOOL_NAMES.slice().sort(), ['calc', 'lookup', 'today']);
  const nb = parseNotebook(TOOLS);
  assert.equal(nb.errors.length, 0);
  const g = buildGraph(nb.cells);
  // graph and staleness share refStrings, so builtin names must be absent
  // from both — otherwise `tools: [calc]` would dangle forever
  assert.deepEqual(refStrings(nb.cells.find(c => c.id === 'a1')).sort(), ['rows', 'shout']);
  assert.deepEqual(g.deps.a1.sort(), ['rows', 'shout']);
  assert.deepEqual(g.deps.a2.sort(), ['rows', 'shout']);
  assert.deepEqual(g.deps.shout, []);
  assert.deepEqual(g.cycle, []);
  assert.ok(g.order.indexOf('shout') < g.order.indexOf('a1'));
});

test('tool diamond: a stale tool re-runs before both agents and dirties them', () => {
  const nb = parseNotebook(TOOLS);
  const g = buildGraph(nb.cells);
  assert.deepEqual([...downstream(g, 'shout')].sort(), ['a1', 'a2', 'compare']);
  const plan = runPlan(g, 'compare', id => id === 'shout');
  assert.deepEqual([...plan].sort(), ['a1', 'a2', 'compare', 'shout']);
  assert.ok(plan.indexOf('shout') < plan.indexOf('a1'));
  assert.ok(plan.indexOf('shout') < plan.indexOf('a2'));
  assert.ok(plan.indexOf('a2') < plan.indexOf('compare'));
});

test('renaming a tool cell leaves a dangling tools: ref, visible to refStrings', () => {
  const renamed = TOOLS.replace('id: shout\ntype: tool', 'id: yell\ntype: tool');
  const nb = parseNotebook(renamed);
  const g = buildGraph(nb.cells);
  // the edge is gone, but the string is still a ref candidate — exactly what
  // the engine's dangling-ref staleness check consumes
  assert.deepEqual(g.deps.a1, ['rows']);
  assert.deepEqual(refStrings(nb.cells.find(c => c.id === 'a1')).sort(), ['rows', 'shout']);
});

test('tool cell yaml round-trips nested params schemas and inline tools stay non-refs', () => {
  const nb = parseNotebook(TOOLS);
  for (const c of nb.cells) delete c.raw; // force cellYaml regeneration
  const nb2 = parseNotebook(serializeNotebook(nb));
  assert.equal(nb2.errors.length, 0);
  const tool = nb2.cells.find(c => c.id === 'shout');
  assert.equal(tool.type, 'tool');
  assert.equal(tool.config.kind, 'expr');
  assert.deepEqual(tool.config.params, { input: { type: 'string', description: 'text to shout', required: true } });
  assert.deepEqual(buildGraph(nb2.cells).deps.a1.sort(), ['rows', 'shout']);

  // inline tool objects in tools: contribute no ref strings
  const inline = parseNotebook('```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: hi\ntools:\n  - name: up\n    expr: String(args.input).toUpperCase()\n```');
  assert.deepEqual(refStrings(inline.cells[0]), []);
});

// ---------------------------------------------------------------------------
// gate cells — refs, diamond, rename, round-trip
// ---------------------------------------------------------------------------

// A diamond onto a gate: rows feeds an agent and a judge; the gate evaluates
// the judge's record; a downstream agent consumes the gate (pass-through).
const GATED = [
  '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "a"\n```',
  '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\ndata: rows\n```',
  '```tl-cell\nid: quality\ntype: judge\nprovider: fixture\ninput_from: draft\nscale: 5\n```',
  '```tl-cell\nid: good\ntype: gate\ninput: quality\nexpr: judgment.overall >= 3\nscore: judgment.overall\n```',
  '```tl-cell\nid: publish\ntype: agent\nprovider: fixture\ninput_from: good\n```',
].join('\n\n');

test('gate cells parse; input forms a graph edge and the diamond orders correctly', () => {
  assert.ok(CELL_TYPES.includes('gate'));
  const nb = parseNotebook(GATED);
  assert.equal(nb.errors.length, 0);
  const g = buildGraph(nb.cells);
  assert.deepEqual(refStrings(nb.cells.find(c => c.id === 'good')), ['quality']);
  assert.deepEqual(g.deps.good, ['quality']);
  assert.deepEqual(g.deps.publish, ['good']);
  assert.deepEqual(g.cycle, []);
  // stale root re-runs the whole diamond before the gate, gate before publish
  const plan = runPlan(g, 'publish', id => id === 'rows');
  assert.deepEqual([...plan].sort(), ['draft', 'good', 'publish', 'quality', 'rows']);
  assert.ok(plan.indexOf('rows') < plan.indexOf('draft'));
  assert.ok(plan.indexOf('draft') < plan.indexOf('quality'));
  assert.ok(plan.indexOf('quality') < plan.indexOf('good'));
  assert.ok(plan.indexOf('good') < plan.indexOf('publish'));
  // editing the gate's input dirties the gate and everything past it
  assert.deepEqual([...downstream(g, 'quality')].sort(), ['good', 'publish']);
  assert.deepEqual([...downstream(g, 'rows')].sort(), ['draft', 'good', 'publish', 'quality']);
});

test('renaming a gate input leaves a dangling ref visible to refStrings', () => {
  const renamed = GATED.replace('id: quality\ntype: judge', 'id: verdict\ntype: judge');
  const nb = parseNotebook(renamed);
  const g = buildGraph(nb.cells);
  // the edge is gone, but the string stays a ref candidate — exactly what the
  // engine's dangling-ref staleness check consumes (graph/staleness lockstep)
  assert.deepEqual(g.deps.good, []);
  assert.deepEqual(refStrings(nb.cells.find(c => c.id === 'good')), ['quality']);
});

test('regenerated gate yaml round-trips expr and inline-judge configs', () => {
  const both = GATED + '\n\n' + [
    '```tl-cell',
    'id: strict',
    'type: gate',
    'input: draft',
    'provider: fixture',
    'scale: 5',
    'threshold: 3.5',
    'dimensions: [helpfulness]',
    'rubric: |',
    '  Reward brevity.',
    '```',
  ].join('\n');
  const nb = parseNotebook(both);
  assert.equal(nb.errors.length, 0);
  for (const c of nb.cells) delete c.raw; // force cellYaml regeneration
  const nb2 = parseNotebook(serializeNotebook(nb));
  assert.equal(nb2.errors.length, 0);
  const expr = nb2.cells.find(c => c.id === 'good');
  assert.equal(expr.config.expr, 'judgment.overall >= 3');
  assert.equal(expr.config.score, 'judgment.overall');
  const strict = nb2.cells.find(c => c.id === 'strict');
  assert.equal(strict.config.threshold, 3.5);
  assert.equal(strict.config.rubric, 'Reward brevity.');
  assert.deepEqual(strict.config.dimensions, ['helpfulness']);
  // the regenerated graph is identical
  const g = buildGraph(nb2.cells);
  assert.deepEqual(g.deps.good, ['quality']);
  assert.deepEqual(g.deps.strict, ['draft']);
});

// ---------------------------------------------------------------------------
// loop-back edges (gate `loop: {back_to, max}` — metadata, not dependencies)
// ---------------------------------------------------------------------------

const LOOPED = [
  '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "a"\n```',
  '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\ndata: rows\n```',
  '```tl-cell\nid: revise\ntype: agent\nprovider: fixture\ninput_from: draft\n```',
  '```tl-cell\nid: check\ntype: gate\ninput: revise\nexpr: feedback != null\nloop:\n  back_to: draft\n  max: 3\n```',
  '```tl-cell\nid: publish\ntype: agent\nprovider: fixture\ninput_from: check\n```',
].join('\n\n');

test('loop-back is metadata: in refStrings, never a graph edge, never a cycle', () => {
  const nb = parseNotebook(LOOPED);
  assert.equal(nb.errors.length, 0);
  const gate = nb.cells.find(c => c.id === 'check');
  // refStrings carries back_to (rename → stale + readable error)…
  assert.deepEqual(refStrings(gate), ['revise', 'draft']);
  // …but the graph edge set does not — the back-edge is excluded from the
  // cycle check because iteration lives inside the gate's execution
  const g = buildGraph(nb.cells);
  assert.deepEqual(cellRefs(gate, new Set(nb.cells.map(c => c.id))), ['revise']);
  assert.deepEqual(g.deps.check, ['revise']);
  assert.deepEqual(g.cycle, []);
  // even a nonsensical back_to pointing DOWNSTREAM cannot manufacture a cycle
  // (the engine refuses it readably as not-an-ancestor instead)
  const misdrawn = LOOPED.replace('back_to: draft', 'back_to: publish');
  const g2 = buildGraph(parseNotebook(misdrawn).cells);
  assert.deepEqual(g2.cycle, []);
  assert.deepEqual(g2.deps.check, ['revise']);
});

test('back_to that is also the input stays a single edge and a single ref', () => {
  const tight = [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "a"\n```',
    '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\ndata: rows\n```',
    '```tl-cell\nid: check\ntype: gate\ninput: draft\nexpr: feedback != null\nloop:\n  back_to: draft\n  max: 2\n```',
  ].join('\n\n');
  const nb = parseNotebook(tight);
  assert.equal(nb.errors.length, 0);
  const gate = nb.cells.find(c => c.id === 'check');
  assert.deepEqual(refStrings(gate), ['draft']);
  const g = buildGraph(nb.cells);
  assert.deepEqual(g.deps.check, ['draft']);   // the input edge survives
  assert.deepEqual(g.cycle, []);
});

test('renaming the back_to target leaves a dangling ref visible to refStrings', () => {
  const renamed = LOOPED.replace('id: draft\ntype: agent', 'id: sketch\ntype: agent');
  const nb = parseNotebook(renamed);
  const gate = nb.cells.find(c => c.id === 'check');
  // draft is gone: input_from on revise dangles AND the gate's back_to dangles
  assert.ok(refStrings(gate).includes('draft'));
  assert.deepEqual(buildGraph(nb.cells).deps.check, ['revise']);
});

test('loop config round-trips through regenerated yaml', () => {
  const nb = parseNotebook(LOOPED);
  for (const c of nb.cells) delete c.raw; // force cellYaml regeneration
  const nb2 = parseNotebook(serializeNotebook(nb));
  assert.equal(nb2.errors.length, 0);
  const gate = nb2.cells.find(c => c.id === 'check');
  assert.deepEqual(gate.config.loop, { back_to: 'draft', max: 3 });
  assert.equal(gate.config.expr, 'feedback != null');
  const g = buildGraph(nb2.cells);
  assert.deepEqual(g.deps.check, ['revise']);
  assert.deepEqual(g.cycle, []);
});

test('loop: on a non-gate cell is a readable parse error', () => {
  const bad = '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "hi"\nloop:\n  back_to: bot\n  max: 2\n```';
  const nb = parseNotebook(bad);
  assert.equal(nb.errors.length, 1);
  assert.match(nb.cells[0].error, /loop: is only valid on a gate cell/);
  assert.match(nb.cells[0].error, /agent cell cannot carry a loop-back/);
});
