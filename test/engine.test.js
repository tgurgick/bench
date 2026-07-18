'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBench, renderTemplate, templateVars, extractJsonArray, extractJsonObject } = require('../lib/engine');
const { createProviders } = require('../lib/providers');
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

test('reactivity: dangling refs and missing dep stamps go stale', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('dangling', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "hello"\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: rows\n```',
  ].join('\n\n'));
  await bench.runAll('dangling');
  assert.equal(bench.readNotebook('dangling').state.bot.stale, false);

  const botPath = path.join(ws, '_bench', 'runs', 'dangling', 'cells', 'bot.json');
  const botRecord = JSON.parse(fs.readFileSync(botPath, 'utf8'));
  botRecord.deps.ghost = '20250101000000';
  fs.writeFileSync(botPath, JSON.stringify(botRecord, null, 2) + '\n');
  assert.equal(bench.readNotebook('dangling').state.bot.stale, true);

  bench.writeNotebookFile('dangling', [
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: rows\n```',
  ].join('\n\n'));
  const view = bench.readNotebook('dangling');
  assert.equal(view.state.bot.stale, true);

  const rerun = await bench.runAll('dangling');
  assert.deepEqual(rerun.ran, ['bot']);
  assert.match(rerun.notebook.state.bot.error, /unknown cell "rows"/);
});

test('run cancellation stops at cell boundaries and preserves completed records', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('cancel', [
    '```tl-cell\nid: first\ntype: data\nrows:\n  - input: "a"\n```',
    '```tl-cell\nid: second\ntype: data\nrows:\n  - input: "b"\n```',
  ].join('\n\n'));
  let checks = 0;
  await assert.rejects(
    () => bench.runAll('cancel', { cancelToken: { isCancelled: () => checks++ > 0 } }),
    e => {
      assert.equal(e.code, 'RUN_CANCELLED');
      assert.deepEqual(e.ran, ['first']);
      return true;
    },
  );
  assert.equal(bench.readCellRecord('cancel', 'first').error, null);
  assert.equal(bench.readCellRecord('cancel', 'second'), null);

  const resumed = await bench.runAll('cancel');
  assert.deepEqual(resumed.ran, ['second']);
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

test('agent chaining: draft → revise via input_from, missing path errors', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('chain', [
    '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\nmodel: fixture-small\ninput: "Where is my order?"\nmax_turns: 2\n```',
    '```tl-cell\nid: revise\ntype: agent\nprovider: fixture\nmodel: fixture-large\ninput_from: draft\ntemplate: "Improve: {{input}}"\nmax_turns: 2\n```',
  ].join('\n\n'));
  const r = await bench.runAll('chain');
  assert.equal(r.notebook.state.draft.error, null);
  assert.equal(r.notebook.state.revise.error, null);
  const handoff = r.notebook.state.revise.output.handoff;
  assert.equal(handoff.from, 'draft');
  assert.equal(handoff.path, 'output');
  assert.equal(handoff.value, r.notebook.state.draft.output.output);
  assert.ok(String(r.notebook.state.revise.output.sample_row.input).includes('fixture') ||
    String(r.notebook.state.revise.output.sample_row.input) === handoff.value);

  bench.writeNotebookFile('badpath', [
    '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\ninput: "hi"\n```',
    '```tl-cell\nid: revise\ntype: agent\nprovider: fixture\ninput_from: draft\ninput_path: no.such.field\ntemplate: "{{input}}"\n```',
  ].join('\n\n'));
  const bad = await bench.runAll('badpath');
  assert.match(bad.notebook.state.revise.error || '', /input_path "no.such.field" missing/);
});

test('judge-in-the-middle chain and eval candidate pipelines', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('jmid', [
    '```tl-cell\nid: seeds\ntype: data\nrows:\n  - input: "reset password"\n  - input: "where is order"\n```',
    '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\ndata: seeds\nmax_turns: 1\n```',
    '```tl-cell\nid: quality\ntype: judge\nkind: code\nexpr: output.length > 0 ? 1 : 0\ninput_from: draft\n```',
    '```tl-cell\nid: revise\ntype: agent\nprovider: fixture\ninput_from: quality\ninput_path: sample\ntemplate: "Score was {{input}} — reply briefly."\nmax_turns: 1\n```',
  ].join('\n\n'));
  const mid = await bench.runAll('jmid');
  assert.equal(mid.notebook.state.draft.error, null);
  assert.equal(mid.notebook.state.quality.error, null);
  assert.equal(mid.notebook.state.revise.error, null);
  assert.equal(mid.notebook.state.quality.output.handoff.from, 'draft');
  assert.ok(mid.notebook.state.revise.output.handoff);

  bench.writeNotebookFile('pipe-eval', [
    '```tl-cell\nid: seeds\ntype: data\nrows:\n  - input: "a"\n  - input: "b"\n```',
    '```tl-cell\nid: draft\ntype: agent\nprovider: fixture\ndata: seeds\n```',
    '```tl-cell\nid: revise\ntype: agent\nprovider: fixture\ninput_from: draft\ntemplate: "Revise: {{input}}"\n```',
    '```tl-cell\nid: compare\ntype: eval\ndata: seeds\ncandidates: [revise]\n```',
  ].join('\n\n'));
  const ev = await bench.runAll('pipe-eval');
  assert.equal(ev.notebook.state.compare.error, null);
  const results = ev.notebook.state.compare.output.results;
  assert.equal(results.length, 2);
  assert.ok(results.every(r => !r.error));
  assert.ok(results.every(r => r.handoff && r.handoff.from === 'draft'));
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

test('golden annotate progress counts golden row decisions', async () => {
  const ws = tmpWs();
  scaffoldDemo(ws);
  const bench = makeBench(ws);
  await bench.runAll(DEMO_NAME);

  const rows = bench.goldenRows('support-replies');
  bench.decideGolden('support-replies', [
    { id: rows[0]._id, status: 'approved' },
    { id: rows[1]._id, status: 'approved' },
    { id: rows[2]._id, status: 'approved' },
  ]);

  const r = await bench.runCell(DEMO_NAME, 'golden-review', { force: true });
  const out = r.notebook.state['golden-review'].output;
  assert.equal(out.kind, 'golden');
  assert.equal(out.total, 4);
  assert.equal(out.labeled, 3);
  assert.equal(out.remaining, 1);
  assert.deepEqual(out.tally, { approved: 3 });
});

test('golden decisions preserve rows appended during rewrite and last decision wins', () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  const set = 'race';
  const rows = [
    { _id: 'a', input: 'one', expected: '1', origin: 'synthetic', status: 'draft' },
    { _id: 'b', input: 'two', expected: '2', origin: 'synthetic', status: 'draft' },
  ];
  const appended = { _id: 'c', input: 'three', expected: '3', origin: 'synthetic', status: 'draft' };
  const file = path.join(ws, '_bench', 'goldens', `${set}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const readFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patchedReadFileSync(p, ...args) {
    const out = readFileSync.call(this, p, ...args);
    if (p === file && reads++ === 0) {
      fs.appendFileSync(file, JSON.stringify(appended) + '\n');
    }
    return out;
  };
  try {
    const res = bench.decideGolden(set, [
      { id: 'a', status: 'approved' },
      { id: 'b', status: 'approved' },
      { id: 'b', status: 'rejected' },
    ]);
    assert.equal(res.changed, 2);
    assert.equal(res.total, 3);
    assert.equal(res.approved, 1);
    assert.equal(res.rejected, 1);
    assert.equal(res.draft, 1);
  } finally {
    fs.readFileSync = readFileSync;
  }

  const finalRows = bench.goldenRows(set);
  assert.deepEqual(finalRows.map(r => r._id), ['a', 'b', 'c']);
  assert.equal(finalRows.find(r => r._id === 'a').status, 'approved');
  assert.equal(finalRows.find(r => r._id === 'b').status, 'rejected');
  assert.equal(finalRows.find(r => r._id === 'c').status, 'draft');
});

test('eval run ids are unique within the same second', async () => {
  const ws = tmpWs();
  const bench = createBench({ wsDir: ws, now: () => new Date('2025-06-15T15:06:40.000Z') });
  bench.writeNotebookFile('runs', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "hello"\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: rows\n```',
    '```tl-cell\nid: compare\ntype: eval\ndata: rows\ncandidates: [bot]\n```',
  ].join('\n\n'));

  const first = await bench.runCell('runs', 'compare');
  const firstRunId = first.notebook.state.compare.output.run_id;
  const second = await bench.runCell('runs', 'compare', { force: true });
  const secondRunId = second.notebook.state.compare.output.run_id;
  assert.notEqual(firstRunId, secondRunId);

  const log = fs.readFileSync(path.join(ws, '_metrics', 'bench-log.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map(row => row.run_id), [firstRunId, secondRunId]);
  assert.equal(new Set(log.map(row => row.run_id)).size, 2);
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

// ---------------------------------------------------------------------------
// control nodes — switch, map, retry, catch
// ---------------------------------------------------------------------------

// a registry that serves one extra provider on top of the real set — the seam
// tests use to make a call flaky without touching lib/providers.js
function withProvider(extra) {
  const base = createProviders();
  return { get: n => (n === extra.name ? extra : base.get(n)), status: () => base.status() };
}

test('switch selects a branch downstream consumes; edits re-route it', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  const cells = input => [
    '```tl-cell\nid: small\ntype: data\nrows:\n  - input: "tiny"\n```',
    '```tl-cell\nid: big\ntype: data\nrows:\n  - input: "one"\n  - input: "two"\n  - input: "three"\n```',
    `\`\`\`tl-cell\nid: route\ntype: switch\ninput: ${input}\ncases:\n  - when: count > 2\n    use: big\ndefault: small\n\`\`\``,
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: route\n```',
  ].join('\n\n');
  bench.writeNotebookFile('sw', cells('small'));
  const r = await bench.runAll('sw');
  assert.equal(r.notebook.state.route.error, null);
  const out = r.notebook.state.route.output;
  assert.equal(out.selected, 'small');           // count 1 → default branch
  assert.equal(out.case, 'default');
  assert.deepEqual(out.considered, [{ when: 'count > 2', matched: false }]);
  assert.equal(out.count, 1);                    // the branch's rows pass through
  assert.equal(r.notebook.state.bot.output.sample_row.input, 'tiny');

  // point the switch at the big input → it and its downstream go stale
  bench.writeNotebookFile('sw', cells('big'));
  const view = bench.readNotebook('sw');
  assert.equal(view.state.route.stale, true);
  assert.equal(view.state.bot.stale, true);
  assert.equal(view.state.small.stale, false);

  const r2 = await bench.runAll('sw');
  assert.equal(r2.notebook.state.route.output.selected, 'big');
  assert.equal(r2.notebook.state.route.output.case, 1);
  assert.equal(r2.notebook.state.bot.output.sample_row.input, 'one');
});

test('switch with no match and no default errors; unmatched refs stay visible', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('sw2', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "x"\n```',
    '```tl-cell\nid: route\ntype: switch\ninput: rows\ncases:\n  - when: count > 5\n    use: rows\n```',
  ].join('\n\n'));
  const r = await bench.runCell('sw2', 'route');
  assert.match(r.notebook.state.route.error, /no case matched and no default/);

  // a matched case pointing at a ghost cell errors loudly, not silently
  bench.writeNotebookFile('sw3', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "x"\n```',
    '```tl-cell\nid: route\ntype: switch\ninput: rows\ndefault: ghost\n```',
  ].join('\n\n'));
  const r2 = await bench.runCell('sw3', 'route');
  assert.match(r2.notebook.state.route.error, /unknown cell "ghost"/);
});

test('map transforms and filters rows; downstream consumes them; errors carry the row', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('mp', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "a"\n    n: 1\n  - input: "b"\n    n: 2\n  - input: "c"\n    n: 3\n```',
    '```tl-cell\nid: doubled\ntype: map\ninput: rows\nfilter: row.n > 1\nexpr: "({ ...row, double: row.n * 2 })"\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: doubled\n```',
  ].join('\n\n'));
  const r = await bench.runAll('mp');
  const out = r.notebook.state.doubled.output;
  assert.equal(out.error, undefined);
  assert.deepEqual(out.rows, [{ input: 'b', n: 2, double: 4 }, { input: 'c', n: 3, double: 6 }]);
  assert.equal(out.count, 2);
  assert.equal(out.dropped, 1);
  assert.deepEqual(out.columns, ['input', 'n', 'double']);
  assert.equal(out.source, 'map:rows');
  assert.equal(r.notebook.state.bot.output.sample_row.input, 'b');

  // scalar results wrap as { value }; a throwing expr names its row
  bench.writeNotebookFile('mp2', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - n: 5\n```',
    '```tl-cell\nid: vals\ntype: map\ninput: rows\nexpr: row.n * 10\n```',
    '```tl-cell\nid: boom\ntype: map\ninput: rows\nexpr: row.missing.x\n```',
  ].join('\n\n'));
  const r2 = await bench.runAll('mp2');
  assert.deepEqual(r2.notebook.state.vals.output.rows, [{ value: 50 }]);
  assert.match(r2.notebook.state.boom.error, /boom: row 0/);

  // editing the source dirties the map and its downstream, transitively
  bench.writeNotebookFile('mp', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "z"\n    n: 9\n```',
    '```tl-cell\nid: doubled\ntype: map\ninput: rows\nfilter: row.n > 1\nexpr: "({ ...row, double: row.n * 2 })"\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: doubled\n```',
  ].join('\n\n'));
  const view = bench.readNotebook('mp');
  assert.equal(view.state.rows.stale, true);
  assert.equal(view.state.doubled.stale, true);
  assert.equal(view.state.bot.stale, true);
});

test('retry reuses a clean target record without re-executing', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('rt', [
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "hello"\n```',
    '```tl-cell\nid: keep\ntype: retry\ntarget: bot\n```',
  ].join('\n\n'));
  const r = await bench.runCell('rt', 'keep');
  assert.deepEqual(r.ran, ['bot', 'keep']);
  const out = r.notebook.state.keep.output;
  assert.deepEqual(out.retry, { target: 'bot', attempts: 0, reused: true, log: [] });
  assert.ok(out.output.length > 0, 'agent output passes through');
});

test('retry re-runs a flaky target until success, recording every attempt', async () => {
  const ws = tmpWs();
  let calls = 0;
  const flaky = {
    name: 'flaky',
    available: () => ({ ok: true, reason: 'test' }),
    async complete() {
      if (++calls < 3) throw new Error('boom ' + calls);
      return { text: 'recovered', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 }, model: 'flaky-1', provider: 'flaky' };
    },
  };
  const bench = createBench({ wsDir: ws, providers: withProvider(flaky), now: () => new Date(1750000000000) });
  bench.writeNotebookFile('rt2', [
    '```tl-cell\nid: bot\ntype: agent\nprovider: flaky\ninput: "hello"\n```',
    '```tl-cell\nid: keep\ntype: retry\ntarget: bot\nattempts: 4\n```',
  ].join('\n\n'));
  const r = await bench.runCell('rt2', 'keep');
  // the target's own failure stays visible — nothing looks fresher than it is
  assert.match(r.notebook.state.bot.error, /boom 1/);
  const out = r.notebook.state.keep.output;
  assert.equal(r.notebook.state.keep.error, null);
  assert.equal(out.output, 'recovered');
  assert.equal(out.retry.attempts, 2);
  assert.equal(out.retry.reused, false);
  assert.deepEqual(out.retry.log.map(l => [l.attempt, l.ok]), [[0, false], [1, false], [2, true]]);
  assert.match(out.retry.log[1].error, /boom 2/);
});

test('retry is bounded: attempts cap at 5 and total failure lists every error', async () => {
  const ws = tmpWs();
  let calls = 0;
  const dead = {
    name: 'flaky',
    available: () => ({ ok: true, reason: 'test' }),
    async complete() { throw new Error('down ' + (++calls)); },
  };
  const bench = createBench({ wsDir: ws, providers: withProvider(dead), now: () => new Date(1750000000000) });
  bench.writeNotebookFile('rt3', [
    '```tl-cell\nid: bot\ntype: agent\nprovider: flaky\ninput: "hello"\n```',
    '```tl-cell\nid: keep\ntype: retry\ntarget: bot\nattempts: 50\n```',
  ].join('\n\n'));
  const r = await bench.runCell('rt3', 'keep');
  assert.match(r.notebook.state.keep.error, /failed after 5 attempts/);
  assert.match(r.notebook.state.keep.error, /#1: .*down/);
  assert.match(r.notebook.state.keep.error, /#5: .*down/);
  assert.equal(calls, 6); // 1 plan run of the target + 5 bounded retries
});

test('catch passes a clean upstream through and routes errors to the fallback', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  // error path: the agent's provider is unknown → catch supplies the fallback
  bench.writeNotebookFile('ct', [
    '```tl-cell\nid: bad\ntype: agent\nprovider: nope\ninput: "hello"\n```',
    '```tl-cell\nid: fb\ntype: data\nrows:\n  - input: "fallback"\n```',
    '```tl-cell\nid: safe\ntype: catch\ntry: bad\nfallback: fb\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: safe\n```',
  ].join('\n\n'));
  const r = await bench.runCell('ct', 'bot');
  assert.match(r.notebook.state.bad.error, /unknown provider/); // the failure stays explicit
  const out = r.notebook.state.safe.output;
  assert.equal(r.notebook.state.safe.error, null);
  assert.equal(out.caught, true);
  assert.match(out.error, /unknown provider/);
  assert.equal(out.from, 'bad');
  assert.deepEqual(out.rows, [{ input: 'fallback' }]);
  assert.equal(r.notebook.state.bot.output.sample_row.input, 'fallback');

  // clean path: passthrough with caught: false; inline rows fallback also works
  bench.writeNotebookFile('ct2', [
    '```tl-cell\nid: ok\ntype: data\nrows:\n  - input: "fine"\n```',
    '```tl-cell\nid: safe\ntype: catch\ntry: ok\n```',
    '```tl-cell\nid: bad\ntype: agent\nprovider: nope\ninput: "hello"\n```',
    '```tl-cell\nid: inline\ntype: catch\ntry: bad\nrows:\n  - input: "spare"\n```',
  ].join('\n\n'));
  const r2 = await bench.runAll('ct2');
  const clean = r2.notebook.state.safe.output;
  assert.equal(clean.caught, false);
  assert.equal(clean.error, null);
  assert.deepEqual(clean.rows, [{ input: 'fine' }]);
  const inline = r2.notebook.state.inline.output;
  assert.equal(inline.caught, true);
  assert.deepEqual(inline.rows, [{ input: 'spare' }]);
  assert.equal(inline.source, 'fallback:inline');
});

test('a failed upstream without a catch propagates as an error, never as success', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('prop', [
    '```tl-cell\nid: bad\ntype: agent\nprovider: nope\ninput: "hello"\n```',
    '```tl-cell\nid: keep\ntype: retry\ntarget: bad\nattempts: 2\n```',
    '```tl-cell\nid: after\ntype: map\ninput: keep\n```',
  ].join('\n\n'));
  const r = await bench.runCell('prop', 'after');
  assert.match(r.notebook.state.bad.error, /unknown provider/);
  assert.match(r.notebook.state.keep.error, /failed after 2 attempts/);
  assert.match(r.notebook.state.after.error, /upstream "keep" has an error/);
});

// ---------------------------------------------------------------------------
// tool nodes — reusable expr / http / file / transform tools
// ---------------------------------------------------------------------------

test('tool cells validate their definition and expose JSON-schema-like parameters', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('tv', [
    '```tl-cell\nid: shout\ntype: tool\nkind: expr\ndescription: upper-case the input\nexpr: String(args.input || "").toUpperCase()\nparams:\n  input:\n    type: string\n    description: text to shout\n    required: true\n```',
    '```tl-cell\nid: fetchy\ntype: tool\nkind: http\nurl: "https://api.test/orders/{{order_id}}"\nparams:\n  order_id:\n    type: string\n```',
    '```tl-cell\nid: plain\ntype: tool\nkind: transform\ntemplate: "Hello {{input}}!"\n```',
  ].join('\n\n'));
  const r = await bench.runAll('tv');
  const shout = r.notebook.state.shout.output;
  assert.equal(r.notebook.state.shout.error, null);
  assert.equal(shout.kind, 'expr');
  assert.equal(shout.name, 'shout'); // defaults to the cell id
  assert.deepEqual(shout.parameters, {
    type: 'object',
    properties: { input: { type: 'string', description: 'text to shout' } },
    required: ['input'],
  });
  assert.equal(r.notebook.state.fetchy.output.method, 'GET');
  assert.deepEqual(r.notebook.state.fetchy.output.parameters.properties, { order_id: { type: 'string' } });
  assert.deepEqual(r.notebook.state.plain.output.vars, ['input']);
  // no params at all falls back to the single string input inline tools use
  bench.writeNotebookFile('tv2', '```tl-cell\nid: t\ntype: tool\nexpr: 1 + 1\n```');
  const r2 = await bench.runAll('tv2');
  assert.equal(r2.notebook.state.t.output.kind, 'expr'); // inferred from expr:
  assert.deepEqual(r2.notebook.state.t.output.parameters, { type: 'object', properties: { input: { type: 'string' } } });
});

test('tool cell config errors are readable records, never crashes', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('te', [
    '```tl-cell\nid: nokind\ntype: tool\ndescription: no kind at all\n```',
    '```tl-cell\nid: badexpr\ntype: tool\nkind: expr\nexpr: "this is ((( not js"\n```',
    '```tl-cell\nid: badurl\ntype: tool\nkind: http\nurl: "ftp://example.com/x"\n```',
    '```tl-cell\nid: calc\ntype: tool\nkind: expr\nexpr: 1\n```',
  ].join('\n\n'));
  const r = await bench.runAll('te');
  assert.match(r.notebook.state.nokind.error, /tool kind must be one of expr, http, file, transform/);
  assert.match(r.notebook.state.badexpr.error, /expr does not compile/);
  assert.match(r.notebook.state.badurl.error, /url must be http\(s\)/);
  assert.match(r.notebook.state.calc.error, /builtin tool name/); // reserved ids
});

test('a reusable expr tool serves two agents; turns record the tool cell id', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  const cells = [
    '```tl-cell\nid: shout\ntype: tool\nkind: expr\ndescription: upper-case\nexpr: String(args.input || "").toUpperCase()\n```',
    '```tl-cell\nid: a1\ntype: agent\nprovider: fixture\ninput: "hello one"\ntools: [shout]\n```',
    '```tl-cell\nid: a2\ntype: agent\nprovider: fixture\ninput: "hello two"\ntools: [shout]\n```',
  ].join('\n\n');
  bench.writeNotebookFile('share', cells);
  const r = await bench.runAll('share');
  for (const id of ['a1', 'a2']) {
    assert.equal(r.notebook.state[id].error, null);
    const t = r.notebook.state[id].output.turns.find(x => x.kind === 'tool');
    assert.equal(t.tool, 'shout');
    assert.equal(t.tool_cell, 'shout'); // provenance: which cell served the call
    assert.match(t.result, /HELLO/);
  }

  // editing the tool dirties both agents (the diamond), not just one
  bench.writeNotebookFile('share', cells.replace('upper-case\nexpr', 'still upper-case\nexpr'));
  const view = bench.readNotebook('share');
  assert.equal(view.state.shout.stale, true);
  assert.equal(view.state.a1.stale, true);
  assert.equal(view.state.a2.stale, true);

  // renaming the tool cell leaves a dangling ref: agents stale, run errors readably
  bench.writeNotebookFile('share', cells.replace('id: shout\ntype: tool', 'id: yell\ntype: tool'));
  const renamed = bench.readNotebook('share');
  assert.equal(renamed.state.a1.stale, true);
  const r2 = await bench.runAll('share');
  assert.match(r2.notebook.state.a1.error, /unknown tool "shout"/);
  assert.match(r2.notebook.state.a1.error, /calc, today, lookup/);
});

test('builtin tool names never dangle: tools: [calc] stays fresh after running', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('bt', '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "2*3"\ntools: [calc]\n```');
  await bench.runAll('bt');
  assert.equal(bench.readNotebook('bt').state.bot.stale, false);
  assert.deepEqual((await bench.runAll('bt')).ran, []);
});

test('http tools call the injected transport with templated method/url/headers/body', async () => {
  const ws = tmpWs();
  const wires = [];
  const bench = createBench({
    wsDir: ws,
    now: () => new Date(1750000000000),
    httpTransport: async wire => { wires.push(wire); return { status: 200, body: '{"status":"shipped"}' }; },
  });
  bench.writeNotebookFile('ht', [
    '```tl-cell\nid: order-status\ntype: tool\nkind: http\ndescription: fetch order status\nmethod: POST\nurl: "https://api.test/orders/{{order_id}}"\nheaders:\n  accept: application/json\n  x-order: "{{order_id}}"\nbody: |\n  {"id": "{{order_id}}"}\nparams:\n  order_id:\n    type: string\n    required: true\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "order-42"\ntools: [order-status]\nmax_turns: 3\n```',
  ].join('\n\n'));
  const r = await bench.runCell('ht', 'bot');
  assert.equal(r.notebook.state.bot.error, null);
  // the fixture provider calls the first offered tool with args derived from
  // the prompt — here order_id: "order-42"
  assert.equal(wires.length, 1);
  assert.equal(wires[0].method, 'POST');
  assert.equal(wires[0].url, 'https://api.test/orders/order-42');
  assert.deepEqual(wires[0].headers, { accept: 'application/json', 'x-order': 'order-42' });
  assert.equal(wires[0].body, '{"id": "order-42"}');
  const t = r.notebook.state.bot.output.turns.find(x => x.kind === 'tool');
  assert.equal(t.tool_cell, 'order-status');
  assert.equal(t.result, '{"status":"shipped"}');
});

test('http tool errors are readable tool results, not crashed runs', async () => {
  const ws = tmpWs();
  const bench = createBench({
    wsDir: ws,
    now: () => new Date(1750000000000),
    httpTransport: async () => ({ status: 404, body: 'no such order' }),
  });
  bench.writeNotebookFile('he', [
    '```tl-cell\nid: fetchy\ntype: tool\nkind: http\nurl: "https://api.test/x"\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "find it"\ntools: [fetchy]\nmax_turns: 3\n```',
    '```tl-cell\nid: scheme\ntype: tool\nkind: http\nurl: "{{base}}/x"\nparams:\n  base:\n    type: string\n```',
    '```tl-cell\nid: bot2\ntype: agent\nprovider: fixture\ninput: "ftp://evil"\ntools: [scheme]\nmax_turns: 3\n```',
  ].join('\n\n'));
  const r = await bench.runAll('he');
  // non-2xx: status-prefixed result the model can react to
  assert.equal(r.notebook.state.bot.error, null);
  const t = r.notebook.state.bot.output.turns.find(x => x.kind === 'tool');
  assert.equal(t.result, 'HTTP 404: no such order');
  // a templated url rendering to a non-http scheme is refused at call time
  assert.equal(r.notebook.state.bot2.error, null);
  const t2 = r.notebook.state.bot2.output.turns.find(x => x.kind === 'tool');
  assert.match(t2.result, /tool error: http tool "scheme": url must be http\(s\)/);
});

test('file tools read workspace files through the traversal guard', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes', 'hello.txt'), 'contents of hello');
  bench.writeNotebookFile('ft', [
    '```tl-cell\nid: readme\ntype: tool\nkind: file\npath: notes/hello.txt\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "read the note"\ntools: [readme]\nmax_turns: 3\n```',
    '```tl-cell\nid: escape\ntype: tool\nkind: file\npath: ../../etc/passwd\n```',
    '```tl-cell\nid: bot2\ntype: agent\nprovider: fixture\ninput: "read it"\ntools: [escape]\nmax_turns: 3\n```',
    '```tl-cell\nid: ghost\ntype: tool\nkind: file\npath: no/such/file.txt\n```',
    '```tl-cell\nid: bot3\ntype: agent\nprovider: fixture\ninput: "read it"\ntools: [ghost]\nmax_turns: 3\n```',
  ].join('\n\n'));
  const r = await bench.runAll('ft');
  const t = r.notebook.state.bot.output.turns.find(x => x.kind === 'tool');
  assert.equal(t.result, 'contents of hello');
  const t2 = r.notebook.state.bot2.output.turns.find(x => x.kind === 'tool');
  assert.match(t2.result, /tool error: file tool "escape": path "\.\.\/\.\.\/etc\/passwd" escapes the workspace/);
  const t3 = r.notebook.state.bot3.output.turns.find(x => x.kind === 'tool');
  assert.match(t3.result, /tool error: file tool "ghost": cannot read/);
});

test('transform tools render their template from args over the row', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('tt', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "greet"\n    customer: "Sam"\n```',
    '```tl-cell\nid: greet\ntype: tool\nkind: transform\ndescription: greeting line\ntemplate: "Dear {{customer}}: {{input}}"\nparams:\n  input:\n    type: string\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: rows\ntools: [greet]\nmax_turns: 3\n```',
  ].join('\n\n'));
  const r = await bench.runAll('tt');
  assert.equal(r.notebook.state.bot.error, null);
  const t = r.notebook.state.bot.output.turns.find(x => x.kind === 'tool');
  // args.input comes from the fixture (prompt-derived); customer falls
  // through from the row because args did not override it
  assert.match(t.result, /^Dear Sam: /);
});

test('mixed builtin + tool-node + inline tools resolve together; bad refs error readably', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('mix', [
    '```tl-cell\nid: shout\ntype: tool\nkind: expr\nexpr: String(args.input || "").toUpperCase()\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "2*(3+4)"\ntools:\n  - calc\n  - shout\n  - name: echo\n    expr: String(args.input || "")\n```',
  ].join('\n\n'));
  const r = await bench.runAll('mix');
  assert.equal(r.notebook.state.bot.error, null);
  // the fixture calls the first offered tool — the builtin still leads the list
  const t = r.notebook.state.bot.output.turns.find(x => x.kind === 'tool');
  assert.equal(t.tool, 'calc');
  assert.equal(t.tool_cell, undefined); // builtins carry no cell provenance

  // a tools: string naming a non-tool cell is a readable error
  bench.writeNotebookFile('mix2', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "x"\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ninput: "hi"\ntools: [rows]\n```',
  ].join('\n\n'));
  const r2 = await bench.runAll('mix2');
  assert.match(r2.notebook.state.bot.error, /tool "rows" is a data cell, not a tool cell/);
});

test('eval candidates use tool nodes per row and record tool provenance', async () => {
  const ws = tmpWs();
  const bench = makeBench(ws);
  bench.writeNotebookFile('etool', [
    '```tl-cell\nid: rows\ntype: data\nrows:\n  - input: "alpha"\n  - input: "beta"\n```',
    '```tl-cell\nid: shout\ntype: tool\nkind: expr\nexpr: String(args.input || "").toUpperCase()\n```',
    '```tl-cell\nid: bot\ntype: agent\nprovider: fixture\ndata: rows\ntools: [shout]\nmax_turns: 3\n```',
    '```tl-cell\nid: compare\ntype: eval\ndata: rows\ncandidates: [bot]\n```',
  ].join('\n\n'));
  const r = await bench.runAll('etool');
  assert.equal(r.notebook.state.compare.error, null);
  const results = r.notebook.state.compare.output.results;
  assert.equal(results.length, 2);
  for (const item of results) {
    assert.equal(item.error, null);
    const t = item.turns.find(x => x.kind === 'tool');
    assert.equal(t.tool, 'shout');
    assert.equal(t.tool_cell, 'shout');
  }
});
