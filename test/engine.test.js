'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBench, renderTemplate, templateVars, extractJsonArray, extractJsonObject } = require('../lib/engine');
const { scaffoldDemo, DEMO_NAME } = require('../lib/demo');

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bench-'));
}

// a deterministic clock so run ids and stamps are stable per engine
function makeBench(ws) {
  let t = 0;
  return createBench({ wsDir: ws, now: () => new Date(1750000000000 + (t++ * 1000)) });
}

test('template rendering and vars', () => {
  assert.equal(renderTemplate('Hi {{name}}, re {{topic}}!', { name: 'Sam', topic: 'x' }), 'Hi Sam, re x!');
  assert.equal(renderTemplate('{{missing}}', {}), '');
  assert.deepEqual(templateVars('{{a}} {{b}} {{a}}'), ['a', 'b']);
});

test('tolerant JSON extraction', () => {
  assert.deepEqual(extractJsonArray('here you go:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('no json'), []);
  assert.deepEqual(extractJsonObject('Sure! {"scores":{"q":4}} done'), { scores: { q: 4 } });
});

test('demo notebook runs end-to-end offline and is reproducible', async () => {
  const ws = tmpWs();
  scaffoldDemo(ws);
  const bench = makeBench(ws);
  const r = await bench.runAll(DEMO_NAME);
  assert.ok(r.ran.length >= 10, 'all typed cells ran');
  for (const [id, st] of Object.entries(r.notebook.state)) {
    assert.equal(st.error, null, `${id} should not error: ${st.error}`);
  }
  // eval artifacts exist
  const evalOut = bench.readCellRecord(DEMO_NAME, 'compare').output;
  assert.ok(fs.existsSync(path.join(ws, evalOut.results_path)));
  assert.ok(fs.existsSync(path.join(ws, evalOut.summary_path)));
  assert.equal(evalOut.summary.candidates.length, 2);
  assert.ok(evalOut.summary.winner);
  // bench log rows: one per candidate
  const log = fs.readFileSync(path.join(ws, '_metrics', 'bench-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 2);
  assert.equal(log.filter(row => row.winner).length, 1);

  // a second identical workspace produces identical summaries (fixture
  // determinism) — modulo latency, which is measured wall-clock
  const ws2 = tmpWs();
  scaffoldDemo(ws2);
  const bench2 = makeBench(ws2);
  await bench2.runAll(DEMO_NAME);
  const out2 = bench2.readCellRecord(DEMO_NAME, 'compare').output;
  const noLatency = s => ({ ...s, candidates: s.candidates.map(c => ({ ...c, latency_ms_mean: null })) });
  assert.deepEqual(noLatency(out2.summary), noLatency(evalOut.summary));
});

test('reactivity: nothing re-runs when fresh; edits dirty the whole downstream', async () => {
  const ws = tmpWs();
  scaffoldDemo(ws);
  const bench = makeBench(ws);
  await bench.runAll(DEMO_NAME);
  const again = await bench.runAll(DEMO_NAME);
  assert.deepEqual(again.ran, []);

  // edit the brevity metric → brevity, compare, review are stale (transitively)
  const nb = bench.readNotebookFile(DEMO_NAME);
  const cell = nb.cells.find(c => c.id === 'brevity');
  cell.raw = 'id: brevity\ntype: metric\nkind: expr\nexpr: output.length < 500 ? 1 : 0';
  const { serializeNotebook } = require('../lib/notebook');
  bench.writeNotebookFile(DEMO_NAME, serializeNotebook(nb));

  const view = bench.readNotebook(DEMO_NAME);
  const stale = Object.entries(view.state).filter(([, s]) => s.stale).map(([id]) => id).sort();
  assert.deepEqual(stale, ['brevity', 'compare', 'review']);

  // running the eval re-runs the stale metric first, and leaves review stale
  const r = await bench.runCell(DEMO_NAME, 'compare');
  assert.deepEqual(r.ran, ['brevity', 'compare']);
  assert.equal(r.notebook.state.review.stale, true);
  assert.equal(r.notebook.state.compare.stale, false);
});

test('agent loops execute tools and record the trace', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('loops', [
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "compute 6*7 please"\ntools: [calc]\nmax_turns: 3\n```',
  ].join('\n'));
  const r = await bench.runCell('loops', 'bot');
  const out = r.notebook.state.bot.output;
  assert.equal(r.notebook.state.bot.error, null);
  const toolTurns = out.turns.filter(t => t.kind === 'tool');
  assert.equal(toolTurns.length, 1);
  assert.equal(toolTurns[0].tool, 'calc');
  assert.ok(out.output.length > 0, 'loop converged to a text answer');
  assert.ok(out.usage.input_tokens > 0);
});

test('custom expr tools and expr metrics run in the vm sandbox', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('x', [
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "hello"\ntools:\n  - name: shout\n    description: upper-case\n    expr: String(args.input || "").toUpperCase()\n```',
    '```tl-cell\nid: m\ntype: metric\nkind: expr\nexpr: output.includes("re:") ? 1 : 0\n```',
  ].join('\n\n'));
  const r = await bench.runAll('x');
  assert.equal(r.notebook.state.bot.error, null);
  assert.equal(r.notebook.state.m.output.sample_value, 0); // dry-run sample has no "re:"
  const toolTurn = r.notebook.state.bot.output.turns.find(t => t.kind === 'tool');
  assert.equal(toolTurn.tool, 'shout');
  assert.match(toolTurn.result, /^[A-Z ]+/);
});

test('golden generation drafts, human approval gate, approved-only data cells', async () => {
  const ws = tmpWs();
  scaffoldDemo(ws);
  const bench = makeBench(ws);
  await bench.runAll(DEMO_NAME);

  let sets = bench.listGoldenSets();
  assert.deepEqual(sets, [{ set: 'support-replies', total: 4, draft: 4, approved: 0, rejected: 0 }]);

  // approved-only data cell sees nothing yet
  assert.equal(bench.readCellRecord(DEMO_NAME, 'goldens').output.count, 0);

  // approve 2, reject 1
  const rows = bench.goldenRows('support-replies');
  const res = bench.decideGolden('support-replies', [
    { id: rows[0]._id, status: 'approved' },
    { id: rows[1]._id, status: 'approved' },
    { id: rows[2]._id, status: 'rejected' },
  ]);
  assert.equal(res.changed, 3);
  assert.equal(res.approved, 2);

  const r = await bench.runCell(DEMO_NAME, 'goldens', { force: true });
  assert.equal(r.notebook.state.goldens.output.count, 2);

  // rows carry provenance; human-added rows are born approved
  const all = bench.goldenRows('support-replies');
  assert.ok(all.every(x => x.origin === 'synthetic'));
  const added = bench.addGoldenRow('support-replies', { input: 'hand-written', expected: 'topic' });
  assert.equal(added.origin, 'human');
  assert.equal(added.status, 'approved');
  assert.equal(bench.listGoldenSets()[0].approved, 3);
});

test('annotation flow: labels append, last write wins, judge agreement computes', async () => {
  const ws = tmpWs();
  scaffoldDemo(ws);
  const bench = makeBench(ws);
  await bench.runAll(DEMO_NAME);

  bench.annotate(DEMO_NAME, 'review', { item_id: 'r0-concise', label: 'good' });
  bench.annotate(DEMO_NAME, 'review', { item_id: 'r0-concise', label: 'bad' }); // overrides
  bench.annotate(DEMO_NAME, 'review', { item_id: 'r1-concise', label: 'good', note: 'solid' });

  const r = await bench.runCell(DEMO_NAME, 'review', { force: true });
  const out = r.notebook.state.review.output;
  assert.equal(out.labeled, 2);
  assert.equal(out.total, 8);
  assert.deepEqual(out.tally, { bad: 1, good: 1 });
  assert.ok(out.judge_agreement && out.judge_agreement.n === 2);
  const labeled = out.items.find(i => i.item_id === 'r0-concise');
  assert.equal(labeled.annotation.label, 'bad');
  // the log is append-only: 3 rows on disk even though 2 items are labeled
  assert.equal(bench.annotations(DEMO_NAME, 'review').length, 3);
});

test('errors: unknown refs, cycles, bad providers, path escapes', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('bad', [
    '```tl-cell\nid: e\ntype: eval\ndata: ghost\ncandidates: [ghost2]\n```',
  ].join('\n'));
  const r = await bench.runCell('bad', 'e');
  assert.match(r.notebook.state.e.error, /missing data|unknown cell/);

  bench.writeNotebookFile('cyc', [
    '```tl-cell\nid: a\ntype: data\nrows: []\nneeds: [b]\n```',
    '```tl-cell\nid: b\ntype: data\nrows: []\nneeds: [a]\n```',
  ].join('\n\n'));
  await assert.rejects(() => bench.runCell('cyc', 'a'), /cycle/);

  bench.writeNotebookFile('prov', '```tl-cell\nid: g\ntype: agent\nprovider: nope\ninput: hi\n```');
  const r2 = await bench.runCell('prov', 'g');
  assert.match(r2.notebook.state.g.error, /unknown provider/);

  assert.throws(() => bench.notebookPath('../escape'), /invalid notebook name/);
  bench.writeNotebookFile('esc', '```tl-cell\nid: d\ntype: data\nfile: ../../etc/passwd\n```');
  const r3 = await bench.runCell('esc', 'd');
  assert.match(r3.notebook.state.d.error, /escapes the workspace/);
});

test('metric kinds compute over samples', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  const mk = (id, cfg) => ({ id, type: 'metric', config: cfg });
  const s = {
    output: 'The answer is 42.', expected: 'answer', input: 'q',
    row: {}, usage: { output_tokens: 7, cost_usd: 0.01 }, latency_ms: 12, turns: [],
  };
  assert.equal(bench.computeMetric(mk('m', { kind: 'contains' }), s), 1);
  assert.equal(bench.computeMetric(mk('m', { kind: 'exact_match' }), s), 0);
  assert.equal(bench.computeMetric(mk('m', { kind: 'regex', pattern: '\\b42\\b' }), s), 1);
  assert.equal(bench.computeMetric(mk('m', { kind: 'json_valid' }), s), 0);
  assert.equal(bench.computeMetric(mk('m', { kind: 'length' }), s), 17);
  assert.equal(bench.computeMetric(mk('m', { kind: 'latency' }), s), 12);
  assert.equal(bench.computeMetric(mk('m', { kind: 'tokens' }), s), 7);
  assert.equal(bench.computeMetric(mk('m', { kind: 'cost' }), s), 0.01);
  assert.equal(bench.computeMetric(mk('m', { kind: 'expr', expr: 'output.length > 5 && latency_ms < 100' }), s), 1);
});
