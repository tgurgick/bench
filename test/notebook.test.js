'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseNotebook, serializeNotebook, buildGraph, downstream, runPlan, cellRefs, slugId,
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
