// test/templates.test.js — catalogue listing, scaffold, parse, fixture run
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { listTemplates, getTemplate, scaffoldTemplate } = require('../lib/templates');
const { parseNotebook } = require('../lib/notebook');
const { createBench } = require('../lib/engine');
const { createProviders } = require('../lib/providers');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'bench.js');

describe('template gallery', () => {
  it('lists at least six starters with live/offline flags', () => {
    const list = listTemplates();
    assert.ok(list.length >= 6);
    const ids = list.map(t => t.id);
    for (const id of [
      'model-compare', 'tool-agent', 'agent-chain',
      'judge-calibration', 'live-compare', 'bedrock-smoke', 'gemini-smoke',
    ]) assert.ok(ids.includes(id), `missing ${id}`);
    assert.equal(list.find(t => t.id === 'model-compare').live, false);
    assert.equal(list.find(t => t.id === 'live-compare').live, true);
    assert.ok(list.find(t => t.id === 'bedrock-smoke').required_env.length);
  });

  it('scaffolds parseable notebooks and refuses overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tpl-'));
    try {
      const r = scaffoldTemplate(dir, 'tool-agent');
      assert.equal(r.name, 'tool-agent');
      assert.ok(fs.existsSync(r.file));
      const nb = parseNotebook(fs.readFileSync(r.file, 'utf8'));
      assert.ok(nb.cells.some(c => c.type === 'agent'));
      assert.throws(() => scaffoldTemplate(dir, 'tool-agent'), /already exists/);
      const renamed = scaffoldTemplate(dir, 'tool-agent', { name: 'tool-agent-2' });
      assert.equal(renamed.name, 'tool-agent-2');
      const text = fs.readFileSync(renamed.file, 'utf8');
      assert.match(text, /^notebook: tool-agent-2$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI lists templates and scaffolds without network', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tpl-cli-'));
    try {
      const listed = spawnSync(process.execPath, [BIN, 'templates', '--dir', dir], { encoding: 'utf8' });
      assert.equal(listed.status, 0, listed.stderr);
      assert.match(listed.stdout, /model-compare/);
      assert.match(listed.stdout, /LIVE/);
      const sc = spawnSync(process.execPath, [BIN, 'scaffold', 'judge-calibration', '--dir', dir], { encoding: 'utf8' });
      assert.equal(sc.status, 0, sc.stderr);
      assert.ok(fs.existsSync(path.join(dir, '_bench', 'judge-calibration.bench.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('live templates ship offline on fixture with # live: flip markers', () => {
    for (const id of ['live-compare', 'bedrock-smoke', 'gemini-smoke']) {
      const t = getTemplate(id);
      assert.equal(t.live, true);
      assert.ok(t.required_env.length, `${id} declares no required_env`);
      // no cell may activate a network provider as shipped — CI stays offline
      assert.ok(!/^provider:\s*(anthropic|openai|bedrock|gemini)\b/m.test(t.body),
        `${id} ships with a live provider active`);
      assert.match(t.body, /# live:/, `${id} is missing the # live: flip marker`);
    }
  });

  it('every template runs end-to-end on the fixture provider', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tpl-run-'));
    try {
      for (const id of [
        'model-compare', 'tool-agent', 'agent-chain',
        'judge-calibration', 'live-compare', 'bedrock-smoke', 'gemini-smoke',
      ]) {
        const r = scaffoldTemplate(dir, id, { name: id + '-run' });
        const bench = createBench({ wsDir: dir, providers: createProviders() });
        const out = await bench.runAll(r.name, { force: true });
        assert.ok(out.ran.length, `${id} ran nothing`);
        for (const cell of out.notebook.cells) {
          if (cell.type === 'note') continue;
          const st = out.notebook.state[cell.id];
          assert.ok(st, `${id}/${cell.id} missing state`);
          assert.ok(!st.error, `${id}/${cell.id}: ${st && st.error}`);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getTemplate rejects unknown ids', () => {
    assert.throws(() => getTemplate('nope'), /unknown template/);
  });

  it('titles with double quotes survive scaffold verbatim — no quote swapping', () => {
    // the old "→' swap predates the yaml quote fix; the parser now round-trips
    // interior double quotes, so titles come back exactly as given
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tpl-quote-'));
    try {
      const title = 'Compare "concise" vs "kind" replies';
      const r = scaffoldTemplate(dir, 'judge-calibration', { name: 'quoted', title });
      const nb = parseNotebook(fs.readFileSync(r.file, 'utf8'));
      assert.equal(nb.meta.title, title);
      assert.ok(!String(nb.meta.title).includes("'"), 'title was quote-swapped');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
