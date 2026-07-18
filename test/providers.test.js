'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createFixtureProvider, createAnthropicProvider, createBedrockProvider, createGeminiProvider, createOpenAiProvider, createProviders,
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

test('anthropic coalesces consecutive tool results into one user message', () => {
  const p = createAnthropicProvider({ env: { ANTHROPIC_API_KEY: 'test-key' } });
  const wire = p.buildRequest({
    model: 'claude-x',
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 't1', name: 'calc', args: { expression: '1+1' } },
          { id: 't2', name: 'calc', args: { expression: '2+2' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: '2' },
      { role: 'tool', tool_call_id: 't2', content: '4' },
    ],
  });
  const roles = wire.body.messages.map(m => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user']);
  const toolMsg = wire.body.messages[2];
  assert.equal(toolMsg.content.length, 2);
  assert.deepEqual(
    toolMsg.content.map(b => ({ type: b.type, tool_use_id: b.tool_use_id, content: b.content })),
    [
      { type: 'tool_result', tool_use_id: 't1', content: '2' },
      { type: 'tool_result', tool_use_id: 't2', content: '4' },
    ],
  );
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

test('bedrock builds a Converse request with tools, tool results, and SigV4 auth', async () => {
  let wire = null;
  const p = createBedrockProvider({
    env: {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'SECRET',
      AWS_SESSION_TOKEN: 'token',
    },
    now: () => new Date('2026-07-17T12:34:56.000Z'),
    transport: async w => {
      wire = w;
      return {
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Need a tool.' },
              { toolUse: { toolUseId: 'b1', name: 'calc', input: { expression: '1+1' } } },
            ],
          },
        },
        usage: { inputTokens: 11, outputTokens: 7 },
      };
    },
  });
  assert.equal(p.available().ok, true);
  const reply = await p.complete({
    model: 'anthropic.claude-3-haiku-20240307-v1:0',
    system: 'sys',
    max_tokens: 64,
    temperature: 0.2,
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'calc', args: { expression: '1+1' } }] },
      { role: 'tool', tool_call_id: 't1', content: '2' },
    ],
    tools: [{ name: 'calc', description: 'd', parameters: { type: 'object', properties: { expression: { type: 'string' } } } }],
  });
  assert.match(wire.url, /^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/anthropic\.claude-3-haiku-20240307-v1%3A0\/converse$/);
  assert.equal(wire.headers.host, 'bedrock-runtime.us-east-1.amazonaws.com');
  assert.equal(wire.headers['x-amz-date'], '20260717T123456Z');
  assert.equal(wire.headers['x-amz-security-token'], 'token');
  assert.match(wire.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260717\/us-east-1\/bedrock\/aws4_request/);
  assert.deepEqual(wire.body.system, [{ text: 'sys' }]);
  assert.deepEqual(wire.body.inferenceConfig, { maxTokens: 64, temperature: 0.2 });
  assert.equal(wire.body.toolConfig.tools[0].toolSpec.name, 'calc');
  assert.deepEqual(wire.body.toolConfig.tools[0].toolSpec.inputSchema.json.properties.expression.type, 'string');
  assert.equal(wire.body.messages[1].content[0].toolUse.toolUseId, 't1');
  assert.equal(wire.body.messages[2].content[0].toolResult.toolUseId, 't1');
  assert.equal(reply.text, 'Need a tool.');
  assert.deepEqual(reply.tool_calls, [{ id: 'b1', name: 'calc', args: { expression: '1+1' } }]);
  assert.equal(reply.provider, 'bedrock');
  assert.equal(reply.usage.input_tokens, 11);
  assert.equal(reply.usage.output_tokens, 7);
});

test('bedrock reports missing configuration clearly', () => {
  assert.equal(createBedrockProvider({ env: {} }).available().ok, false);
  assert.match(createBedrockProvider({ env: {} }).available().reason, /AWS_REGION|BEDROCK_REGION/);
  const p = createBedrockProvider({ env: { AWS_REGION: 'us-west-2' } });
  assert.equal(p.available().ok, false);
  assert.match(p.available().reason, /AWS_ACCESS_KEY_ID/);
  assert.throws(() => p.buildRequest({ model: 'm', messages: [] }), /AWS_ACCESS_KEY_ID/);
});

test('bedrock provider errors surface as thrown errors', async () => {
  const p = createBedrockProvider({
    env: { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' },
    transport: async () => ({ message: 'The security token included in the request is invalid.' }),
  });
  await assert.rejects(() => p.complete({ model: 'm', messages: [] }), /security token/);
});

test('gemini builds a generateContent request with tools and parses function calls', async () => {
  let wire = null;
  const p = createGeminiProvider({
    env: { GEMINI_API_KEY: 'g-key' },
    transport: async w => {
      wire = w;
      return {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: 'Let me check.' },
              { functionCall: { name: 'calc', args: { expression: '1+1' } } },
            ],
          },
        }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
        modelVersion: 'gemini-2.5-flash',
      };
    },
  });
  assert.equal(p.available().ok, true);
  const reply = await p.complete({
    model: 'gemini-2.5-flash', system: 'sys', max_tokens: 64, temperature: 0.2,
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ name: 'calc', description: 'd', parameters: { type: 'object', properties: { expression: { type: 'string' } } } }],
  });
  assert.equal(wire.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(wire.headers['x-goog-api-key'], 'g-key');
  // system prompt is a top-level field, never a conversation turn
  assert.deepEqual(wire.body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(wire.body.contents, [{ role: 'user', parts: [{ text: 'q' }] }]);
  assert.equal(wire.body.tools[0].functionDeclarations[0].name, 'calc');
  assert.equal(wire.body.tools[0].functionDeclarations[0].parameters.properties.expression.type, 'string');
  assert.deepEqual(wire.body.generationConfig, { maxOutputTokens: 64, temperature: 0.2 });
  assert.equal(reply.text, 'Let me check.');
  assert.deepEqual(reply.tool_calls, [{ id: 'calc-1', name: 'calc', args: { expression: '1+1' } }]);
  assert.equal(reply.provider, 'gemini');
  assert.equal(reply.usage.input_tokens, 9);
  assert.equal(reply.usage.output_tokens, 4);
});

test('gemini maps roles to user/model and merges a multi-tool turn without breaking alternation', () => {
  const p = createGeminiProvider({ env: { GEMINI_API_KEY: 'g-key' } });
  const wire = p.buildRequest({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'two calls',
        tool_calls: [
          { id: 't1', name: 'calc', args: { expression: '1+1' } },
          { id: 't2', name: 'lookup', args: { term: 'x' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: '2' },
      { role: 'tool', tool_call_id: 't2', content: 'found' },
      { role: 'assistant', content: 'done' },
    ],
  });
  const roles = wire.body.contents.map(c => c.role);
  // strict user/model alternation: both tool results share one user turn
  assert.deepEqual(roles, ['user', 'model', 'user', 'model']);
  const modelTurn = wire.body.contents[1];
  assert.deepEqual(modelTurn.parts, [
    { text: 'two calls' },
    { functionCall: { name: 'calc', args: { expression: '1+1' } } },
    { functionCall: { name: 'lookup', args: { term: 'x' } } },
  ]);
  const toolTurn = wire.body.contents[2];
  // functionResponse is keyed by function name, recovered from the call ids
  assert.deepEqual(toolTurn.parts, [
    { functionResponse: { name: 'calc', response: { output: '2' } } },
    { functionResponse: { name: 'lookup', response: { output: 'found' } } },
  ]);
  assert.deepEqual(wire.body.contents[3], { role: 'model', parts: [{ text: 'done' }] });
});

test('gemini without a key reports unavailable with the exact env var to set', () => {
  const p = createGeminiProvider({ env: {} });
  assert.equal(p.available().ok, false);
  assert.match(p.available().reason, /GEMINI_API_KEY/);
  assert.equal(createGeminiProvider({ env: { GEMINI_API_KEY: 'x' } }).available().ok, true);
});

test('gemini provider errors (bad key, quota) surface as thrown errors', async () => {
  const bad = createGeminiProvider({
    env: { GEMINI_API_KEY: 'nope' },
    transport: async () => ({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }),
  });
  await assert.rejects(() => bad.complete({ model: 'gemini-2.5-flash', messages: [] }), /gemini: API key not valid/);
  const quota = createGeminiProvider({
    env: { GEMINI_API_KEY: 'x' },
    transport: async () => ({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }),
  });
  await assert.rejects(() => quota.complete({ model: 'gemini-2.5-flash', messages: [] }), /gemini: Resource has been exhausted/);
  assert.throws(() => createGeminiProvider({ env: { GEMINI_API_KEY: 'x' } }).buildRequest({ messages: [] }), /GEMINI_MODEL/);
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
  assert.deepEqual(status.map(s => s.name), ['fixture', 'anthropic', 'bedrock', 'gemini', 'openai']);
  assert.equal(status[0].ok, true);
});
