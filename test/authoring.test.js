'use strict';

// lib/authoring.js — the proposal engine. All offline: the provider call is
// transport-injected through the existing registry seam (the providers.test.js
// pattern); no keys, no network. The learning tests are the differentiator:
// a seeded corrections log must shift BOTH proposal paths — the deterministic
// recommender directly, and the LLM path through the prompt digest.

const test = require('node:test');
const assert = require('node:assert');

const {
  GOALS,
  POSTURES,
  OFFLINE_LABEL,
  recommendTemplateId,
  isRecursiveRequest,
  correctionsDigest,
  buildProposalPrompt,
  validateProposal,
  deterministicProposal,
  propose,
} = require('../lib/authoring');
const { createProviders } = require('../lib/providers');

// a seeded log row: the human kept something other than what was proposed
function row(notes, proposedPosture, keptPosture, extra = {}) {
  return {
    at: '2026-07-18T00:00:00Z',
    notes,
    proposed: { goal: 'compare', posture: proposedPosture, template: 'model-compare', name: 'x' },
    kept: { goal: 'compare', posture: keptPosture, template: 'model-compare', name: 'x' },
    provider: 'offline',
    ...extra,
  };
}

test('correctionsDigest aggregates proposed-vs-kept divergences, capped and malformed-safe', () => {
  const rows = [
    null, 'garbage', { notes: 'no proposed/kept' },              // skipped, never fatal
    row('compare claude and gpt live on support replies', 'fixture', 'live'),
    row('compare claude vs gpt on live support answers', 'fixture', 'live'),
    row('live compare of claude and gpt support replies', 'fixture', 'live'),
    row('same posture kept', 'fixture', 'fixture'),              // agreement → not a correction
  ];
  const d = correctionsDigest(rows);
  assert.equal(d.rows_seen, 4); // rows with proposed+kept
  assert.equal(d.corrections.length, 1);
  const c = d.corrections[0];
  assert.deepEqual(
    { field: c.field, from: c.from, to: c.to, count: c.count },
    { field: 'posture', from: 'fixture', to: 'live', count: 3 }
  );
  assert.ok(c.tokens.includes('claude'), 'shared note vocabulary is kept');
  assert.match(d.text, /posture: proposed "fixture" but the human kept "live" \(3x/);

  // cap: only the last N rows count
  const many = Array.from({ length: 30 }, (_, i) =>
    row('old notes', 'fixture', i < 25 ? 'live' : 'bedrock'));
  const capped = correctionsDigest(many, 5);
  assert.equal(capped.rows_seen, 5);
  assert.equal(capped.corrections[0].to, 'bedrock');
});

test('buildProposalPrompt demands the strict JSON shape and folds the digest in', () => {
  const digest = correctionsDigest([
    row('compare claude and gpt live', 'fixture', 'live'),
    row('compare claude and gpt live again', 'fixture', 'live'),
  ]);
  const req = buildProposalPrompt('does my support agent use its lookup tool?', digest);
  assert.match(req.system, /ONLY one JSON object/);
  for (const g of GOALS) assert.ok(req.system.includes(g));
  for (const p of POSTURES) assert.ok(req.system.includes(p));
  assert.match(req.system, /"template"/);
  assert.equal(req.temperature, 0);
  const user = req.messages[0].content;
  assert.match(user, /lookup tool/);
  assert.match(user, /Recent human corrections/);
  assert.match(user, /kept "live"/);

  // no corrections → no corrections section
  const bare = buildProposalPrompt('notes', correctionsDigest([]));
  assert.ok(!bare.messages[0].content.includes('Recent human corrections'));
});

test('validateProposal: strict shape in, readable failures out', () => {
  const good = validateProposal(JSON.stringify({
    goal: 'tool-agent', posture: 'fixture', template: 'tool-agent',
    name: 'Lookup Agent!', metric_notes: 'm', judge_notes: 'j', rationale: 'r',
  }));
  assert.equal(good.ok, true);
  assert.equal(good.proposal.goal, 'tool-agent');
  assert.match(good.proposal.name, /^[a-z0-9][a-z0-9_-]*$/, 'a non-slug name suggestion is coerced to a slug');

  // fenced / prose-wrapped JSON still parses
  const fenced = validateProposal('Here you go:\n```json\n{"goal":"judge","posture":"fixture","template":"judge-calibration","name":"jc","metric_notes":"","judge_notes":"","rationale":""}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.proposal.template, 'judge-calibration');

  assert.equal(validateProposal('total garbage').ok, false);
  assert.match(validateProposal('total garbage').reason, /no JSON/);
  assert.equal(validateProposal('{not json}').ok, false);
  assert.equal(validateProposal('{"goal":"world-peace","posture":"fixture","template":"model-compare","name":"x"}').ok, false);
  assert.match(validateProposal('{"goal":"world-peace","posture":"fixture","template":"model-compare","name":"x"}').reason, /goal/);
  assert.equal(validateProposal('{"goal":"compare","posture":"fixture","template":"nope","name":"x"}').ok, false);
});

test('deterministicProposal infers goal/posture/template from note keywords, labeled offline', () => {
  const none = correctionsDigest([]);
  const tool = deterministicProposal('does the agent actually use its lookup tool?', none);
  assert.equal(tool.goal, 'tool-agent');
  assert.equal(tool.template, 'tool-agent');
  const bed = deterministicProposal('smoke test our AWS bedrock credentials', none);
  assert.equal(bed.posture, 'bedrock');
  assert.equal(bed.template, 'bedrock-smoke');
  const live = deterministicProposal('compare claude and gpt on real support replies', none);
  assert.equal(live.goal, 'compare');
  assert.equal(live.posture, 'live');
  assert.equal(live.template, 'live-compare');
  assert.match(live.rationale, /Offline suggestion/);
  assert.ok(live.metric_notes && live.judge_notes && live.name);
  assert.match(live.name, /^[a-z0-9][a-z0-9_-]*$/);
  // recommendTemplateId mirrors the wizard's mapping
  assert.equal(recommendTemplateId('chain', 'fixture'), 'agent-chain');
  assert.equal(recommendTemplateId('compare', 'live'), 'live-compare');
  const recursive = deterministicProposal('Make a recursive agent that iterates until the answer is good.', none);
  assert.equal(recursive.goal, 'chain');
  assert.equal(recursive.template, 'self-refine');
  assert.match(recursive.rationale, /guarded back-edge.*capped at 3 passes/);
  assert.equal(isRecursiveRequest('refine until good'), true);
});

// THE learning test, deterministic path: the human repeatedly corrected
// posture fixture → live for similar notes; the next offline proposal for
// similar notes must prefer live — and must NOT flip for unrelated notes.
test('learning: seeded corrections shift the deterministic proposal for similar notes', () => {
  const seeded = [
    row('compare support reply quality across models', 'fixture', 'live'),
    row('compare models on support replies', 'fixture', 'live'),
    row('which model writes better support replies', 'fixture', 'live'),
  ];
  const digest = correctionsDigest(seeded);

  const similar = deterministicProposal('compare models on customer support replies', digest);
  assert.equal(similar.posture, 'live', 'repeated fixture→live correction is learned');
  assert.equal(similar.template, 'live-compare', 'template follows the learned posture');
  assert.match(similar.rationale, /corrections/);

  const unrelated = deterministicProposal('calibrate a judge for haiku scoring rubrics', digest);
  assert.equal(unrelated.posture, 'fixture', 'no note overlap → no flip');

  // a one-off correction is noise, not signal
  const once = correctionsDigest([row('compare support replies', 'fixture', 'live')]);
  const p = deterministicProposal('compare models on support replies', once);
  assert.equal(p.posture, 'fixture');
});

// a stub registry in the providers.get() shape
function stubRegistry(provider) {
  return { get(name) { return provider && provider.name === name ? provider : null; } };
}

test('propose: no live provider → deterministic fallback labeled "offline suggestion"', async () => {
  const r = await propose({ notes: 'compare models on support replies', rows: [], providers: stubRegistry(null) });
  assert.equal(r.provider, 'offline');
  assert.equal(r.label, OFFLINE_LABEL);
  assert.match(r.note, /no live provider/);
  assert.equal(r.proposal.goal, 'compare');
});

test('propose: first available live provider answers; strict JSON populates the proposal', async () => {
  let seen;
  const provider = {
    name: 'anthropic',
    available() { return { ok: true, reason: 'test' }; },
    async complete(req) {
      seen = req;
      return { text: JSON.stringify({ goal: 'chain', posture: 'fixture', template: 'agent-chain', name: 'draft-revise', metric_notes: 'm', judge_notes: 'j', rationale: 'because' }), model: 'test-model' };
    },
  };
  const r = await propose({ notes: 'draft then revise pipeline', rows: [], providers: stubRegistry(provider) });
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.label, 'AI proposal · anthropic');
  assert.equal(r.proposal.template, 'agent-chain');
  assert.ok(seen.model, 'a default model was set');
  assert.match(seen.messages[0].content, /draft then revise pipeline/);
});

test('propose: recursive notes expose self-refine to a transport-backed proposal', async () => {
  let seen;
  const provider = {
    name: 'anthropic',
    available() { return { ok: true, reason: 'test' }; },
    async complete(req) {
      seen = req;
      return { text: JSON.stringify({ goal: 'chain', posture: 'fixture', template: 'self-refine', name: 'iterative-replies', metric_notes: 'm', judge_notes: 'j', rationale: 'Loops run as a guarded back-edge, capped at 3 passes.' }) };
    },
  };
  const r = await propose({ notes: 'iteratively refine support replies until good', rows: [], providers: stubRegistry(provider) });
  assert.equal(r.proposal.template, 'self-refine');
  assert.match(r.proposal.rationale, /guarded back-edge/);
  assert.match(seen.system, /self-refine/);
});

test('propose: malformed model output degrades to the labeled fallback with a readable note', async () => {
  const provider = {
    name: 'openai',
    available() { return { ok: true, reason: 'test' }; },
    async complete() { return { text: 'sure! I would suggest comparing some models :)' }; },
  };
  const r = await propose({ notes: 'compare models', rows: [], providers: stubRegistry(provider) });
  assert.equal(r.provider, 'offline');
  assert.equal(r.label, OFFLINE_LABEL);
  assert.match(r.note, /openai returned an unusable proposal/);
  assert.equal(r.attempted, 'openai');
  assert.ok(r.proposal.goal, 'fallback proposal still lands');
});

test('propose: provider throw degrades to the labeled fallback, never a crash', async () => {
  const provider = {
    name: 'gemini',
    available() { return { ok: true, reason: 'test' }; },
    async complete() { throw new Error('socket hangup'); },
  };
  const r = await propose({ notes: 'compare models', rows: [], providers: stubRegistry(provider) });
  assert.equal(r.provider, 'offline');
  assert.match(r.note, /gemini failed \(socket hangup\)/);
});

// learning on the LLM path: the digest must ride the prompt
test('learning: the corrections digest is folded into the live-provider prompt', async () => {
  let seen;
  const provider = {
    name: 'anthropic',
    available() { return { ok: true, reason: 'test' }; },
    async complete(req) {
      seen = req;
      return { text: JSON.stringify({ goal: 'compare', posture: 'live', template: 'live-compare', name: 'n', metric_notes: '', judge_notes: '', rationale: '' }) };
    },
  };
  const seeded = [
    row('compare support replies', 'fixture', 'live'),
    row('compare support replies again', 'fixture', 'live'),
  ];
  await propose({ notes: 'compare models on support replies', rows: seeded, providers: stubRegistry(provider) });
  assert.match(seen.messages[0].content, /Recent human corrections/);
  assert.match(seen.messages[0].content, /posture: proposed "fixture" but the human kept "live" \(2x/);
});

// the whole seam end to end: the REAL registry with an injected transport —
// the proposal call rides the same wire-building code as every agent cell.
test('propose rides the real provider registry via an injected transport (keyless)', async () => {
  let wire;
  const transport = async w => {
    wire = w;
    return {
      content: [{ type: 'text', text: JSON.stringify({ goal: 'judge', posture: 'fixture', template: 'judge-calibration', name: 'judge-cal', metric_notes: 'm', judge_notes: 'j', rationale: 'r' }) }],
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 10, output_tokens: 20 },
    };
  };
  const providers = createProviders({ env: { ANTHROPIC_API_KEY: 'test-key' }, transport });
  const seeded = [
    row('calibrate the judge with labels', 'fixture', 'live'),
    row('calibrate the judge with labels', 'fixture', 'live'),
  ];
  const r = await propose({ notes: 'calibrate a judge against my labels', rows: seeded, providers, env: {} });
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.label, 'AI proposal · anthropic');
  assert.equal(r.proposal.template, 'judge-calibration');
  // the exact wire request is assertable — and carries the learning digest
  assert.equal(wire.headers['x-api-key'], 'test-key');
  assert.match(JSON.stringify(wire.body.messages), /Recent human corrections/);
  assert.match(JSON.stringify(wire.body.messages), /kept \\"live\\"/);
});
