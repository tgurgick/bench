// test/cli.test.js — bin/bench.js command-line behavior (offline, no network)
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'bench.js');

describe('bench CLI', () => {
  it('demo scaffolds once, then fails with a one-line bench: error (exit 1, no stack)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cli-demo-'));
    try {
      const first = spawnSync(process.execPath, [BIN, 'demo', '--dir', dir], { encoding: 'utf8' });
      assert.equal(first.status, 0, first.stderr);
      assert.ok(fs.existsSync(path.join(dir, '_bench', 'model-compare.bench.md')));

      // second run: same clean guard as `scaffold` — a one-liner, never a trace
      const again = spawnSync(process.execPath, [BIN, 'demo', '--dir', dir], { encoding: 'utf8' });
      assert.equal(again.status, 1);
      assert.equal(again.stdout, '', 'error path must not print the success lines');
      assert.match(again.stderr, /^bench: notebook already exists: _bench\/model-compare\.bench\.md\n$/);
      assert.ok(!/\n\s+at /.test(again.stderr), 'stderr contains a stack trace');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
