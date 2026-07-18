// lib/providers.js — the model provider seam for the bench.
//
// The bench never talks to a vendor SDK. Every model call goes through one
// tiny interface, so a deterministic fixture, the Anthropic API, Amazon
// Bedrock, and any OpenAI-compatible endpoint (including a local Ollama) are
// interchangeable — one seam for all model I/O:
//
//   provider.name                        'fixture' | 'anthropic' | 'bedrock' | 'gemini' | 'openai'
//   provider.available()              -> { ok, reason }   (key present, etc.)
//   provider.complete(req)            -> Promise<reply>
//
//   req:   { model, system, messages:[{role,content}], tools:[{name,description,
//            parameters}], max_tokens, temperature, mode }
//          `mode` is a bench hint ('chat' | 'generate' | 'judge') — real
//          providers ignore it; the fixture branches on it to stay useful
//          offline.
//   reply: { text, tool_calls:[{id,name,args}], usage:{input_tokens,
//            output_tokens,cost_usd}, model, provider, raw? }
//
// Network providers use global fetch (Node 18+) and accept an injectable
// `transport` so tests can assert the exact request without any network.
// Node stdlib only; zero dependencies.

'use strict';

const crypto = require('node:crypto');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// crude but stable: ~4 chars per token, floor 1 — used for fixture usage rows
// and as a fallback when a provider response omits usage.
function approxTokens(s) {
  return Math.max(1, Math.ceil(String(s || '').length / 4));
}

function lastUserContent(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}

// ---------------------------------------------------------------------------
// fixture — the deterministic offline provider
// ---------------------------------------------------------------------------
//
// Everything in the bench must be provable with zero keys and zero network
// (the same rule the experiment fixture set). The fixture provider is that
// proof: same request in, same reply out, forever. It is not trying to be
// smart — it is trying to be *stable*, so tests, demos, and golden pipelines
// exercise the full loop.
//
// Behavior by mode:
//   'generate' — returns a JSON array of `req.count` rows, each derived from
//                the seed rows in the prompt (deterministic mutation of text).
//   'judge'    — returns a JSON scores object, dimensions scored from a hash
//                of the judged output (stable per output).
//   'chat'     — if tools are offered and none has been used yet in the
//                conversation, calls the first tool with deterministic args;
//                otherwise answers with a stable digest-stamped sentence that
//                includes any tool results (so loops observably converge).

function createFixtureProvider() {
  return {
    name: 'fixture',
    available() { return { ok: true, reason: 'deterministic, offline' }; },

    async complete(req = {}) {
      const model = req.model || 'fixture-1';
      const prompt = lastUserContent(req.messages);
      const digest = sha256((req.system || '') + '\n' + prompt).slice(0, 8);
      let text = '';
      let tool_calls = [];

      if (req.mode === 'generate') {
        text = JSON.stringify(fixtureRows(req, prompt), null, 2);
      } else if (req.mode === 'judge') {
        text = JSON.stringify(fixtureJudgment(req, prompt), null, 2);
      } else {
        const toolResults = (req.messages || []).filter(m => m.role === 'tool');
        const offered = Array.isArray(req.tools) ? req.tools : [];
        if (offered.length && !toolResults.length) {
          const tool = offered[0];
          tool_calls = [{ id: 'call-' + digest, name: tool.name, args: fixtureToolArgs(tool, prompt) }];
          text = '';
        } else if (toolResults.length) {
          const last = toolResults[toolResults.length - 1];
          text = `fixture(${model})#${digest}: using tool result "${String(last.content).slice(0, 120)}" — ${summarizeAsk(prompt)}`;
        } else {
          text = `fixture(${model})#${digest}: ${summarizeAsk(prompt)}`;
        }
      }

      const inTok = approxTokens((req.system || '') + JSON.stringify(req.messages || []));
      const outTok = approxTokens(text) + tool_calls.length * 8;
      return {
        text, tool_calls, model, provider: 'fixture',
        usage: { input_tokens: inTok, output_tokens: outTok, cost_usd: 0 },
      };
    },
  };
}

// a stable one-line "answer": the ask flattened and echoed back, so simple
// content metrics (contains/regex) have something real to match against.
function summarizeAsk(prompt) {
  const flat = String(prompt).split('\n').map(s => s.trim()).filter(Boolean).join(' ') || 'no input';
  const head = flat.length > 200 ? flat.slice(0, 197) + '…' : flat;
  return `re: ${head}`;
}

// deterministic synthetic rows for golden generation. Seeds come through on
// the request (the engine passes them structured — no prompt scraping); each
// generated row is a stable textual variation of a seed.
function fixtureRows(req, prompt) {
  const seeds = Array.isArray(req.seed_rows) && req.seed_rows.length
    ? req.seed_rows
    : [{ input: 'seed', expected: 'seed' }];
  const count = Math.max(1, Number(req.count) || 3);
  const out = [];
  for (let i = 0; i < count; i++) {
    const seed = seeds[i % seeds.length];
    const h = sha256(prompt + '|' + i).slice(0, 6);
    const row = {};
    for (const k of Object.keys(seed)) {
      row[k] = typeof seed[k] === 'string' ? `${seed[k]} (variant ${h})` : seed[k];
    }
    out.push(row);
  }
  return out;
}

// deterministic judge scores: each dimension gets a stable 1..5 from a hash of
// (dimension, judged output). Not meaningful — *repeatable*, which is what a
// fixture judge is for.
function fixtureJudgment(req, prompt) {
  const dims = Array.isArray(req.dimensions) && req.dimensions.length
    ? req.dimensions : ['quality'];
  const scores = {};
  let total = 0;
  for (const d of dims) {
    const s = 1 + (parseInt(sha256(d + '|' + prompt).slice(0, 8), 16) % 5);
    scores[d] = s;
    total += s;
  }
  return {
    scores,
    overall: Math.round((total / dims.length) * 10) / 10,
    verdict: total / dims.length >= 3 ? 'pass' : 'fail',
    rationale: `fixture judge: deterministic scores from output digest ${sha256(prompt).slice(0, 8)}.`,
  };
}

// deterministic args for a fixture tool call: fill each declared parameter
// with a stable value derived from the prompt.
function fixtureToolArgs(tool, prompt) {
  const props = (tool.parameters && tool.parameters.properties) || {};
  const args = {};
  for (const k of Object.keys(props)) {
    args[k] = props[k].type === 'number'
      ? parseInt(sha256(prompt + k).slice(0, 4), 16) % 100
      : String(prompt).slice(0, 60);
  }
  return args;
}

// ---------------------------------------------------------------------------
// anthropic — POST /v1/messages
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function createAnthropicProvider(opts = {}) {
  const env = opts.env || process.env;
  const transport = opts.transport || defaultTransport;

  return {
    name: 'anthropic',
    available() {
      return env.ANTHROPIC_API_KEY
        ? { ok: true, reason: 'ANTHROPIC_API_KEY set' }
        : { ok: false, reason: 'set ANTHROPIC_API_KEY to enable' };
    },

    // Build the exact wire request — exported behavior so tests can assert the
    // shape without network. Tool results ride as user-role tool_result blocks,
    // assistant tool calls as tool_use blocks, per the Messages API.
    buildRequest(req = {}) {
      const messages = [];
      for (const m of req.messages || []) {
        if (m.role === 'tool') {
          // Consecutive tool results must share one user message — the Messages
          // API rejects back-to-back user roles.
          const block = {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: String(m.content || ''),
          };
          const prev = messages[messages.length - 1];
          if (
            prev &&
            prev.role === 'user' &&
            Array.isArray(prev.content) &&
            prev.content.length &&
            prev.content.every(b => b.type === 'tool_result')
          ) {
            prev.content.push(block);
          } else {
            messages.push({ role: 'user', content: [block] });
          }
        } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const content = [];
          if (m.content) content.push({ type: 'text', text: String(m.content) });
          for (const c of m.tool_calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
          messages.push({ role: 'assistant', content });
        } else {
          messages.push({ role: m.role, content: String(m.content || '') });
        }
      }
      const body = {
        model: req.model,
        max_tokens: req.max_tokens || 1024,
        messages,
      };
      if (req.system) body.system = String(req.system);
      if (typeof req.temperature === 'number') body.temperature = req.temperature;
      if (Array.isArray(req.tools) && req.tools.length) {
        body.tools = req.tools.map(t => ({
          name: t.name,
          description: t.description || '',
          input_schema: t.parameters || { type: 'object', properties: {} },
        }));
      }
      return {
        url: opts.baseUrl || ANTHROPIC_URL,
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY || '',
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body,
      };
    },

    async complete(req = {}) {
      const wire = this.buildRequest(req);
      const data = await transport(wire);
      if (data && data.error) throw new Error(`anthropic: ${data.error.message || JSON.stringify(data.error)}`);
      let text = '';
      const tool_calls = [];
      for (const block of (data && data.content) || []) {
        if (block.type === 'text') text += block.text || '';
        else if (block.type === 'tool_use') tool_calls.push({ id: block.id, name: block.name, args: block.input || {} });
      }
      const u = (data && data.usage) || {};
      return {
        text, tool_calls,
        model: (data && data.model) || req.model,
        provider: 'anthropic',
        usage: {
          input_tokens: u.input_tokens != null ? u.input_tokens : approxTokens(JSON.stringify(wire.body.messages)),
          output_tokens: u.output_tokens != null ? u.output_tokens : approxTokens(text),
          cost_usd: null, // pricing is model-dependent; recorded as tokens, priced downstream if ever needed
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// openai — POST {base}/chat/completions (covers OpenAI, Ollama, vLLM, …)
// ---------------------------------------------------------------------------

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function createOpenAiProvider(opts = {}) {
  const env = opts.env || process.env;
  const transport = opts.transport || defaultTransport;
  const baseUrl = () => opts.baseUrl || env.BENCH_OPENAI_BASE_URL || OPENAI_URL;

  return {
    name: 'openai',
    available() {
      // a custom base URL (local Ollama/vLLM) usually needs no key
      if (env.OPENAI_API_KEY) return { ok: true, reason: 'OPENAI_API_KEY set' };
      if (env.BENCH_OPENAI_BASE_URL) return { ok: true, reason: `custom endpoint ${env.BENCH_OPENAI_BASE_URL}` };
      return { ok: false, reason: 'set OPENAI_API_KEY (or BENCH_OPENAI_BASE_URL for a local endpoint)' };
    },

    buildRequest(req = {}) {
      const messages = [];
      if (req.system) messages.push({ role: 'system', content: String(req.system) });
      for (const m of req.messages || []) {
        if (m.role === 'tool') {
          messages.push({ role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content || '') });
        } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          messages.push({
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.tool_calls.map(c => ({
              id: c.id, type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
            })),
          });
        } else {
          messages.push({ role: m.role, content: String(m.content || '') });
        }
      }
      const body = { model: req.model, messages };
      if (req.max_tokens) body.max_tokens = req.max_tokens;
      if (typeof req.temperature === 'number') body.temperature = req.temperature;
      if (Array.isArray(req.tools) && req.tools.length) {
        body.tools = req.tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
        }));
      }
      const headers = { 'content-type': 'application/json' };
      if (env.OPENAI_API_KEY) headers.authorization = `Bearer ${env.OPENAI_API_KEY}`;
      return { url: baseUrl(), headers, body };
    },

    async complete(req = {}) {
      const wire = this.buildRequest(req);
      const data = await transport(wire);
      if (data && data.error) throw new Error(`openai: ${data.error.message || JSON.stringify(data.error)}`);
      const choice = (data && data.choices && data.choices[0]) || {};
      const msg = choice.message || {};
      const tool_calls = [];
      for (const c of msg.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = { _raw: c.function.arguments }; }
        tool_calls.push({ id: c.id, name: c.function.name, args });
      }
      const u = (data && data.usage) || {};
      return {
        text: msg.content || '',
        tool_calls,
        model: (data && data.model) || req.model,
        provider: 'openai',
        usage: {
          input_tokens: u.prompt_tokens != null ? u.prompt_tokens : approxTokens(JSON.stringify(wire.body.messages)),
          output_tokens: u.completion_tokens != null ? u.completion_tokens : approxTokens(msg.content || ''),
          cost_usd: null,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// bedrock — POST /model/{modelId}/converse (AWS SigV4, no SDK)
// ---------------------------------------------------------------------------

const BEDROCK_SERVICE = 'bedrock';

function createBedrockProvider(opts = {}) {
  const env = opts.env || process.env;
  const transport = opts.transport || defaultTransport;
  const now = opts.now || (() => new Date());

  function region() {
    return env.BEDROCK_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || '';
  }

  function credentials() {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY || '',
      sessionToken: env.AWS_SESSION_TOKEN || '',
    };
  }

  return {
    name: 'bedrock',
    available() {
      const r = region();
      const c = credentials();
      if (!r) return { ok: false, reason: 'set AWS_REGION or BEDROCK_REGION to enable' };
      if (!c.accessKeyId || !c.secretAccessKey) {
        return { ok: false, reason: 'set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to enable' };
      }
      return { ok: true, reason: `AWS credentials set for ${r}` };
    },

    buildRequest(req = {}) {
      const r = region();
      const c = credentials();
      const model = req.model || env.BEDROCK_MODEL;
      if (!model) throw new Error('bedrock: set model on the cell or BEDROCK_MODEL');
      if (!r) throw new Error('bedrock: set AWS_REGION or BEDROCK_REGION');
      if (!c.accessKeyId || !c.secretAccessKey) {
        throw new Error('bedrock: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
      }

      const path = `/model/${encodeURIComponent(model)}/converse`;
      const host = opts.host || `bedrock-runtime.${r}.amazonaws.com`;
      const url = opts.baseUrl || `https://${host}${path}`;
      const body = buildBedrockBody(req);
      const bodyText = JSON.stringify(body);
      const headers = signAwsRequest({
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        sessionToken: c.sessionToken,
        region: r,
        service: BEDROCK_SERVICE,
        method: 'POST',
        host,
        path,
        bodyText,
        now: now(),
      });
      return { url, method: 'POST', headers, body, bodyText };
    },

    async complete(req = {}) {
      const wire = this.buildRequest(req);
      const data = await transport(wire);
      if (data && data.error) throw new Error(`bedrock: ${data.error.message || JSON.stringify(data.error)}`);
      if (data && data.message && !data.output) throw new Error(`bedrock: ${data.message}`);
      const msg = data && data.output && data.output.message ? data.output.message : {};
      let text = '';
      const tool_calls = [];
      for (const block of msg.content || []) {
        if (block.text) text += block.text;
        if (block.toolUse) {
          tool_calls.push({
            id: block.toolUse.toolUseId,
            name: block.toolUse.name,
            args: block.toolUse.input || {},
          });
        }
      }
      const u = (data && data.usage) || {};
      return {
        text,
        tool_calls,
        model: req.model || env.BEDROCK_MODEL,
        provider: 'bedrock',
        usage: {
          input_tokens: u.inputTokens != null ? u.inputTokens : approxTokens(JSON.stringify(wire.body.messages || [])),
          output_tokens: u.outputTokens != null ? u.outputTokens : approxTokens(text),
          cost_usd: null,
        },
        raw: data,
      };
    },
  };
}

function buildBedrockBody(req = {}) {
  const body = {
    messages: bedrockMessages(req.messages || []),
  };
  if (req.system) body.system = [{ text: String(req.system) }];
  const inferenceConfig = {};
  if (req.max_tokens) inferenceConfig.maxTokens = req.max_tokens;
  if (typeof req.temperature === 'number') inferenceConfig.temperature = req.temperature;
  if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig;
  if (Array.isArray(req.tools) && req.tools.length) {
    body.toolConfig = {
      tools: req.tools.map(t => ({
        toolSpec: {
          name: t.name,
          description: t.description || '',
          inputSchema: { json: t.parameters || { type: 'object', properties: {} } },
        },
      })),
    };
  }
  return body;
}

function bedrockMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        toolResult: {
          toolUseId: m.tool_call_id,
          content: [{ text: String(m.content || '') }],
        },
      };
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.role === 'user' &&
        Array.isArray(prev.content) &&
        prev.content.length &&
        prev.content.every(b => b.toolResult)
      ) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = [];
      if (m.content) content.push({ text: String(m.content) });
      for (const c of m.tool_calls) {
        content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.args || {} } });
      }
      out.push({ role: 'assistant', content });
    } else {
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ text: String(m.content || '') }] });
    }
  }
  return out;
}

function hmac(key, value, enc) {
  return crypto.createHmac('sha256', key).update(value).digest(enc);
}

function awsDateParts(d) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signAwsRequest({ accessKeyId, secretAccessKey, sessionToken, region, service, method, host, path, bodyText, now }) {
  const { amzDate, dateStamp } = awsDateParts(now);
  const payloadHash = sha256(bodyText);
  const headers = {
    'content-type': 'application/json',
    host,
    'x-amz-date': amzDate,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = signedHeaders.map(k => `${k}:${String(headers[k]).trim()}\n`).join('');
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------------
// gemini — POST /v1beta/models/{model}:generateContent (Google AI Studio)
// ---------------------------------------------------------------------------

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function createGeminiProvider(opts = {}) {
  const env = opts.env || process.env;
  const transport = opts.transport || defaultTransport;

  return {
    name: 'gemini',
    available() {
      return env.GEMINI_API_KEY
        ? { ok: true, reason: 'GEMINI_API_KEY set' }
        : { ok: false, reason: 'set GEMINI_API_KEY to enable' };
    },

    buildRequest(req = {}) {
      const model = req.model || env.GEMINI_MODEL;
      if (!model) throw new Error('gemini: set model on the cell or GEMINI_MODEL');
      const base = opts.baseUrl || GEMINI_BASE_URL;
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
      const body = { contents: geminiContents(req.messages || []) };
      // system prompt is a top-level field, not a conversation turn
      if (req.system) body.systemInstruction = { parts: [{ text: String(req.system) }] };
      if (Array.isArray(req.tools) && req.tools.length) {
        body.tools = [{
          functionDeclarations: req.tools.map(t => ({
            name: t.name,
            description: t.description || '',
            parameters: t.parameters || { type: 'object', properties: {} },
          })),
        }];
      }
      const generationConfig = {};
      if (req.max_tokens) generationConfig.maxOutputTokens = req.max_tokens;
      if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature;
      if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
      return {
        url,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY || '',
        },
        body,
      };
    },

    async complete(req = {}) {
      const wire = this.buildRequest(req);
      const data = await transport(wire);
      if (data && data.error) throw new Error(`gemini: ${data.error.message || JSON.stringify(data.error)}`);
      const candidate = (data && data.candidates && data.candidates[0]) || {};
      const parts = (candidate.content && candidate.content.parts) || [];
      let text = '';
      const tool_calls = [];
      for (const part of parts) {
        if (typeof part.text === 'string') text += part.text;
        if (part.functionCall) {
          const fc = part.functionCall;
          // v1beta functionCall ids are optional — synthesize a stable one so
          // the engine can pair tool results with calls.
          tool_calls.push({
            id: fc.id || `${fc.name}-${tool_calls.length + 1}`,
            name: fc.name,
            args: fc.args || {},
          });
        }
      }
      const u = (data && data.usageMetadata) || {};
      return {
        text, tool_calls,
        model: (data && data.modelVersion) || req.model || env.GEMINI_MODEL,
        provider: 'gemini',
        usage: {
          input_tokens: u.promptTokenCount != null ? u.promptTokenCount : approxTokens(JSON.stringify(wire.body.contents)),
          output_tokens: u.candidatesTokenCount != null ? u.candidatesTokenCount : approxTokens(text),
          cost_usd: null,
        },
        raw: data,
      };
    },
  };
}

// Gemini roles are user/model (never assistant/tool). Tool results ride as
// user-role functionResponse parts and are keyed by *function name*, not call
// id — recover the name from the model turn that issued the call. Consecutive
// same-role contents merge into one turn (the Anthropic tool-result lesson:
// a multi-tool turn must not break user/model alternation).
function geminiContents(messages) {
  const out = [];
  const callName = {}; // tool_call_id -> function name
  const push = (role, parts) => {
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      push('user', [{
        functionResponse: {
          name: callName[m.tool_call_id] || String(m.tool_call_id || ''),
          response: { output: String(m.content || '') },
        },
      }]);
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const c of m.tool_calls) {
        callName[c.id] = c.name;
        parts.push({ functionCall: { name: c.name, args: c.args || {} } });
      }
      push('model', parts);
    } else {
      push(m.role === 'assistant' ? 'model' : 'user', [{ text: String(m.content || '') }]);
    }
  }
  return out;
}

// the real network path — kept tiny so tests never need it
async function defaultTransport(wire) {
  const res = await fetch(wire.url, {
    method: wire.method || 'POST',
    headers: wire.headers,
    body: wire.bodyText || JSON.stringify(wire.body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new Error(`provider returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

// Build the provider registry once per process. `opts` (env/transport) is for
// tests; production callers take the defaults.
function createProviders(opts = {}) {
  const list = [
    createFixtureProvider(),
    createAnthropicProvider(opts),
    createBedrockProvider(opts),
    createGeminiProvider(opts),
    createOpenAiProvider(opts),
  ];
  const byName = {};
  for (const p of list) byName[p.name] = p;
  return {
    get(name) { return byName[String(name || '').toLowerCase()] || null; },
    // availability snapshot for the UI's provider strip
    status() {
      return list.map(p => {
        const a = p.available();
        return { name: p.name, ok: a.ok, reason: a.reason };
      });
    },
  };
}

module.exports = {
  createFixtureProvider,
  createAnthropicProvider,
  createBedrockProvider,
  createGeminiProvider,
  createOpenAiProvider,
  createProviders,
  approxTokens,
};
