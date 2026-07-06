'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createFixtureProvider, createAnthropicProvider, createOpenAiProvider, createProviders,
} = require('../lib/providers');

test('fixture is deterministic: same request, same reply', async () => {
  const p = createFixtureProvider();
  const req = { model: 'fixture-1', messages: [{ role: 'user', content: 'What is 2+2?' }] };
  const a = await p.complete(req);
  const b = await p.complete(req);
  assert.equal(a.text, b.text);
  assert.deepEqual(a.usage, b.usage);
  assert.equal(a.provider, 'fixture');
  assert.equal(a.usage.cost_usd, 0);
});

test('fixture calls the first offered tool once, then answers with the result', async () => {
  const p = createFixtureProvider();
  const tools = [{ name: 'calc', description: 'math', parameters: { type: 'object', properties: { expression: { type: 'string' } } } }];
  const first = await p.complete({ messages: [{ role: 'user', content: 'compute' }], tools });
  assert.equal(first.tool_calls.length, 1);
  assert.equal(first.tool_calls[0].name, 'calc');
  const second = await p.complete({
    messages: [
      { role: 'user', content: 'compute' },
      { role: 'assistant', content: '', tool_calls: first.tool_calls },
      { role: 'tool', tool_call_id: first.tool_calls[0].id, content: '42' },
    ],
    tools,
  });
  assert.equal(second.tool_calls.length, 0);
  assert.match(second.text, /42/);
});

test('fixture generate mode returns count rows shaped like the seeds', async () => {
  const p = createFixtureProvider();
  const reply = await p.complete({
    mode: 'generate', count: 3,
    seed_rows: [{ input: 'q', expected: 'a' }],
    messages: [{ role: 'user', content: 'gen' }],
  });
  const rows = JSON.parse(reply.text);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]), ['input', 'expected']);
});

test('fixture judge mode returns stable scores for the given dimensions', async () => {
  const p = createFixtureProvider();
  const req = { mode: 'judge', dimensions: ['helpfulness', 'accuracy'], messages: [{ role: 'user', content: 'judge this' }] };
  const a = JSON.parse((await p.complete(req)).text);
  const b = JSON.parse((await p.complete(req)).text);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a.scores), ['helpfulness', 'accuracy']);
  assert.ok(a.overall >= 1 && a.overall <= 5);
  assert.ok(a.verdict === 'pass' || a.verdict === 'fail');
});

test('anthropic builds a Messages API request with tools and tool results', async () => {
  let wire = null;
  const p = createAnthropicProvider({
    env: { ANTHROPIC_API_KEY: 'test-key' },
    transport: async w => {
      wire = w;
      return { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 1 }, model: 'claude-x' };
    },
  });
  assert.equal(p.available().ok, true);
  const reply = await p.complete({
    model: 'claude-x', system: 'sys', max_tokens: 64,
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 't1', name: 'calc', args: { expression: '1+1' } }] },
      { role: 'tool', tool_call_id: 't1', content: '2' },
    ],
    tools: [{ name: 'calc', description: 'd', parameters: { type: 'object', properties: {} } }],
  });
  assert.equal(wire.headers['x-api-key'], 'test-key');
  assert.equal(wire.body.system, 'sys');
  assert.equal(wire.body.tools[0].name, 'calc');
  assert.ok('input_schema' in wire.body.tools[0]);
  const asst = wire.body.messages[1];
  assert.equal(asst.content[1].type, 'tool_use');
  const toolMsg = wire.body.messages[2];
  assert.equal(toolMsg.content[0].type, 'tool_result');
  assert.equal(toolMsg.content[0].tool_use_id, 't1');
  assert.equal(reply.text, 'hi');
  assert.equal(reply.usage.input_tokens, 3);
});

test('anthropic without a key reports unavailable', () => {
  const p = createAnthropicProvider({ env: {} });
  assert.equal(p.available().ok, false);
});

test('openai builds chat/completions with function tools and parses tool calls', async () => {
  let wire = null;
  const p = createOpenAiProvider({
    env: { OPENAI_API_KEY: 'ok' },
    transport: async w => {
      wire = w;
      return {
        model: 'gpt-t',
        choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'calc', arguments: '{"expression":"1+1"}' } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      };
    },
  });
  const reply = await p.complete({
    model: 'gpt-t', system: 'sys',
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ name: 'calc', description: 'd', parameters: { type: 'object', properties: {} } }],
  });
  assert.equal(wire.headers.authorization, 'Bearer ok');
  assert.equal(wire.body.messages[0].role, 'system');
  assert.equal(wire.body.tools[0].type, 'function');
  assert.deepEqual(reply.tool_calls, [{ id: 'c1', name: 'calc', args: { expression: '1+1' } }]);
  assert.equal(reply.usage.input_tokens, 5);
});

test('openai availability: key, custom base url, or nothing', () => {
  assert.equal(createOpenAiProvider({ env: {} }).available().ok, false);
  assert.equal(createOpenAiProvider({ env: { OPENAI_API_KEY: 'x' } }).available().ok, true);
  assert.equal(createOpenAiProvider({ env: { BENCH_OPENAI_BASE_URL: 'http://localhost:11434/v1' } }).available().ok, true);
});

test('provider errors surface as thrown errors', async () => {
  const p = createOpenAiProvider({ env: { OPENAI_API_KEY: 'x' }, transport: async () => ({ error: { message: 'quota' } }) });
  await assert.rejects(() => p.complete({ model: 'm', messages: [] }), /quota/);
});

test('registry resolves by name and reports status', () => {
  const reg = createProviders({ env: {} });
  assert.equal(reg.get('fixture').name, 'fixture');
  assert.equal(reg.get('nope'), null);
  const status = reg.status();
  assert.deepEqual(status.map(s => s.name), ['fixture', 'anthropic', 'openai']);
  assert.equal(status[0].ok, true);
});
