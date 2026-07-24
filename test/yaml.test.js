'use strict';

// Parser edge cases from the yaml-parser-followups thread: stripComment must
// not toggle quote state on an escaped \" (case 2), and inline arrays must
// respect quoted commas (case 3). Both compose with unescapeDouble — the
// symmetric-unescape fix from bug-yaml-quote-roundtrip.

const test = require('node:test');
const assert = require('node:assert');

const { stripComment, parseScalar, parseYaml } = require('../lib/yaml');

// ---------------------------------------------------------------------------
// Case 2 — escape-aware stripComment
// ---------------------------------------------------------------------------

test('stripComment: escaped \\" inside a double-quoted value does not end the quote', () => {
  // the thread repro: `say "one # two"` serialized → label: "say \"one # two\""
  // old behavior toggled quote-state on the \" and stripped the tail
  const line = 'label: "say \\"one # two\\""';
  assert.equal(stripComment(line), line);
});

test('stripComment: repro round-trips through parseYaml with the # intact', () => {
  const doc = 'label: "say \\"one # two\\""';
  assert.deepEqual(parseYaml(doc), { label: 'say "one # two"' });
});

test('stripComment: unquoted trailing comments still strip', () => {
  assert.equal(stripComment('key: value # note'), 'key: value');
  assert.equal(stripComment('# whole-line comment'), '');
});

test('stripComment: plain # inside quotes still survives (existing contract)', () => {
  assert.equal(stripComment('title: "a # b"'), 'title: "a # b"');
  assert.equal(stripComment("title: 'a # b'"), "title: 'a # b'");
});

test('stripComment: escaped backslash before the closing quote does not hide a real comment', () => {
  // value `path \` → "path \\" — the \\ is a complete escape, the quote closes,
  // and the trailing comment is genuinely outside the string
  assert.equal(stripComment('p: "path \\\\" # gone'), 'p: "path \\\\"');
});

// ---------------------------------------------------------------------------
// Case 3 — quoted commas in inline arrays
// ---------------------------------------------------------------------------

test('inline array: a quoted comma is content, not a separator', () => {
  // the thread repro: ["a, b"] must be one item
  assert.deepEqual(parseScalar('["a, b"]'), ['a, b']);
});

test('inline array: quoted and plain items mix', () => {
  assert.deepEqual(parseScalar('["a, b", "c"]'), ['a, b', 'c']);
  assert.deepEqual(parseScalar('[one, "two, three", four]'), ['one', 'two, three', 'four']);
  assert.deepEqual(parseScalar("['x, y', z]"), ['x, y', 'z']);
});

test('inline array: composes with unescaping — \\" inside an item neither splits nor ends it', () => {
  assert.deepEqual(parseScalar('["say \\"x, y\\"", plain]'), ['say "x, y"', 'plain']);
});

test('inline array: unquoted splitting and empty arrays unchanged', () => {
  assert.deepEqual(parseScalar('[a, b]'), ['a', 'b']);
  assert.deepEqual(parseScalar('[1, 2.5, true]'), [1, 2.5, true]);
  assert.deepEqual(parseScalar('[]'), []);
});

test('inline array + comment stripping work together on one line', () => {
  assert.deepEqual(parseYaml('tags: ["a # b", c] # tail'), { tags: ['a # b', 'c'] });
});

// ---------------------------------------------------------------------------
// Serializer counterpart (the yaml-quote lesson): values holding # or commas
// round-trip through the notebook serializer, which quotes them on the way out
// ---------------------------------------------------------------------------

test('serializer counterpart: # and quoted-comma values survive a full notebook round trip', () => {
  const { parseNotebook, serializeNotebook } = require('../lib/notebook');
  const values = ['one # two', 'say "one # two"', 'a, b'];
  for (const v of values) {
    const nb = {
      meta: { notebook: 't', goal: v },
      cells: [{ id: 'a', type: 'data', config: { rows: [], label: v } }],
    };
    const p = parseNotebook(serializeNotebook(nb));
    assert.equal(p.meta.goal, v, `meta: ${JSON.stringify(v)}`);
    assert.equal(p.cells.find(c => c.id === 'a').config.label, v, `config: ${JSON.stringify(v)}`);
  }
});
