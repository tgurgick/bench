// lib/templates.js — starter notebook catalogue.
//
// `bench templates` lists these; `bench scaffold <id>` copies one into
// `_bench/`. Bodies are plain markdown notebooks (inspectable, no generators).
// Every template ships on `fixture` so it parses and runs green offline with
// zero keys. Live templates declare required_env and mark the provider flip
// with a `# live:` comment — going live is a deliberate one-word edit, and CI
// never touches the network.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEMO_NAME, DEMO_NOTEBOOK } = require('./demo');

function nb(name, title, body) {
  return `---
notebook: ${name}
title: "${title}"
---

${body.trim()}\n`;
}

const TOOL_AGENT = nb('tool-agent', 'Tool-using agent (offline)', `
# Tool-using agent

An agent with the built-in \`lookup\` tool against the same agent with none,
scored on whether the tool was actually used. Every model reply and tool call
lands in \`turns\` — the observable trace — and expression metrics can see it.
Runs entirely on \`fixture\`: no keys, no network.

\`\`\`tl-cell
id: seeds
type: data
rows:
  - input: "Look up the return window for order #42."
  - input: "What is the shipping status for order #99?"
\`\`\`

\`\`\`tl-cell
id: ask
type: prompt
data: seeds
system: You are a support agent. Use tools when you need facts.
template: |
  Customer: {{input}}
\`\`\`

\`\`\`tl-cell
id: agent
type: agent
provider: fixture
model: fixture-large
prompt: ask
tools: [lookup]
max_turns: 4
\`\`\`

\`\`\`tl-cell
id: no-tools
type: agent
provider: fixture
model: fixture-large
prompt: ask
max_turns: 2
\`\`\`

Expression metrics run over \`{output, expected, input, row, usage,
latency_ms, turns}\` — so tool behavior itself is scoreable:

\`\`\`tl-cell
id: used-tool
type: metric
kind: expr
name: used_tool
expr: turns.some(t => t.kind === "tool") ? 1 : 0
\`\`\`

\`\`\`tl-cell
id: tools-vs-none
type: eval
data: seeds
candidates: [agent, no-tools]
metrics: [used-tool]
\`\`\`

After running, open a result row and read the \`turns\` trace: the tool call,
its arguments, the result, and the final answer are all recorded. Custom tools
are one expression — see the README's agent-loops section.
`);

const AGENT_CHAIN = nb('agent-chain', 'Ordered multi-agent draft → revise (offline)', `
# Ordered multi-agent pass — draft then revise

Two agents on the same seeds; \`revise\` declares \`needs: [draft]\` so the
graph runs draft first. True field-level handoffs (\`input_from\`) land with
the agent-chaining feature — this template is the inspectable offline stand-in.

\`\`\`tl-cell
id: seeds
type: data
rows:
  - input: "Where is my order? It was supposed to arrive yesterday."
  - input: "How do I reset my password?"
\`\`\`

\`\`\`tl-cell
id: draft-prompt
type: prompt
data: seeds
system: Draft a short support reply. Prefer asking one clarifying question if unsure.
template: |
  Customer message:
  {{input}}
\`\`\`

\`\`\`tl-cell
id: draft
type: agent
provider: fixture
model: fixture-small
prompt: draft-prompt
max_turns: 2
\`\`\`

\`\`\`tl-cell
id: revise-prompt
type: prompt
data: seeds
system: Rewrite the support reply to be kinder and under 200 characters.
template: |
  Customer message:
  {{input}}

  Write an improved reply.
\`\`\`

\`\`\`tl-cell
id: revise
type: agent
provider: fixture
model: fixture-large
prompt: revise-prompt
needs: [draft]
max_turns: 2
\`\`\`

The eval grid benchmarks both stages side by side — same rows, one judge —
so "did the revise pass help" is a number, not a vibe:

\`\`\`tl-cell
id: quality
type: judge
kind: llm
provider: fixture
model: fixture-judge
scale: 5
dimensions: [kindness, brevity]
rubric: |
  A good reply is kind, specific to the message, and short. Reward replies
  that resolve the issue or ask exactly one clarifying question.
\`\`\`

\`\`\`tl-cell
id: draft-vs-revise
type: eval
data: seeds
candidates: [draft, revise]
judges: [quality]
\`\`\`
`);

const JUDGE_CAL = nb('judge-calibration', 'Judge calibration with HITL (offline)', `
# Judge calibration

Small eval + annotate pass so you can measure judge agreement before trusting
an unsupervised score. Fully offline on \`fixture\`.

\`\`\`tl-cell
id: seeds
type: data
rows:
  - input: "I was charged twice."
    expected: "billing"
  - input: "Can I change my address?"
    expected: "delivery"
\`\`\`

\`\`\`tl-cell
id: reply-prompt
type: prompt
data: seeds
system: You are a support agent. Be brief and accurate.
template: |
  Customer: {{input}}
\`\`\`

\`\`\`tl-cell
id: bot
type: agent
provider: fixture
model: fixture-small
prompt: reply-prompt
\`\`\`

\`\`\`tl-cell
id: quality
type: judge
kind: llm
provider: fixture
model: fixture-judge
scale: 5
dimensions: [helpfulness, accuracy]
rubric: |
  Score high only when the reply resolves the issue or asks exactly one
  clarifying question and stays specific to the message.
\`\`\`

\`\`\`tl-cell
id: compare
type: eval
data: seeds
candidates: [bot]
judges: [quality]
\`\`\`

\`\`\`tl-cell
id: review
type: annotate
source: compare
labels: [good, bad]
instructions: Mark good only if you would send the reply as-is.
\`\`\`
`);

const LIVE_COMPARE = nb('live-compare', 'Live providers — Anthropic vs OpenAI', `
# Live provider comparison

**LIVE template** — ships on the offline \`fixture\` provider so it runs green
with zero keys and stays out of CI's network path. Going live is a deliberate
one-word edit: flip the \`provider:\` line on the two agent cells (marked
\`# live:\`).

- \`claude\` → \`provider: anthropic\` — needs \`ANTHROPIC_API_KEY\`
- \`gpt\` → \`provider: openai\` — needs \`OPENAI_API_KEY\`, or
  \`BENCH_OPENAI_BASE_URL\` for a compatible endpoint (Ollama, vLLM, …)

The eval summary records tokens and cost per candidate; start with cheap
models and small row counts.

\`\`\`tl-cell
id: seeds
type: data
rows:
  - input: "Where is my order? It was supposed to arrive yesterday."
  - input: "How do I reset my password?"
\`\`\`

\`\`\`tl-cell
id: reply-prompt
type: prompt
data: seeds
system: You are a support agent. Be accurate, kind, and brief.
template: |
  Customer message:
  {{input}}

  Write a short reply that resolves the issue or asks the one missing question.
\`\`\`

\`\`\`tl-cell
id: claude
type: agent
provider: fixture   # live: anthropic (ANTHROPIC_API_KEY)
model: claude-haiku-4-5   # cheap and fast for a first live run
prompt: reply-prompt
max_turns: 2
\`\`\`

\`\`\`tl-cell
id: gpt
type: agent
provider: fixture   # live: openai (OPENAI_API_KEY or BENCH_OPENAI_BASE_URL)
model: gpt-4o-mini   # any model your endpoint serves
prompt: reply-prompt
max_turns: 2
\`\`\`

\`\`\`tl-cell
id: brevity
type: metric
kind: expr
expr: output.length < 240 ? 1 : 0
\`\`\`

\`\`\`tl-cell
id: compare
type: eval
data: seeds
candidates: [claude, gpt]
metrics: [brevity]
\`\`\`
`);

const BEDROCK_SMOKE = nb('bedrock-smoke', 'Bedrock Converse smoke test', `
# Bedrock provider smoke test

**LIVE template** — ships on \`fixture\` so it runs offline; flip \`provider:\`
on the \`bot\` cell to \`bedrock\` to verify region, credentials, SigV4
signing, and the model id in one call. Live verification is manual by design —
never part of CI.

Required env when live:
- \`AWS_REGION\` (or \`BEDROCK_REGION\`)
- \`AWS_ACCESS_KEY_ID\` / \`AWS_SECRET_ACCESS_KEY\`
- optional \`AWS_SESSION_TOKEN\` (temporary credentials) and \`BEDROCK_MODEL\`
  (fallback when the cell omits \`model:\`)

\`\`\`tl-cell
id: ask
type: data
rows:
  - input: "Say hello in one short sentence."
\`\`\`

\`\`\`tl-cell
id: bot
type: agent
provider: fixture   # live: bedrock (AWS_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
model: anthropic.claude-3-haiku-20240307-v1:0   # a cheap Bedrock model id
data: ask
max_turns: 1
\`\`\`

A clean run on \`provider: bedrock\` proves the whole path; the reply and
usage tokens land in the cell record under \`_bench/runs/\`.
`);

const GEMINI_SMOKE = nb('gemini-smoke', 'Gemini generateContent smoke test', `
# Gemini provider smoke test

**LIVE template** — ships on \`fixture\` so it runs offline; flip \`provider:\`
on the \`bot\` cell to \`gemini\` to verify the API key, model id, and the
generateContent wire path in one call. Live verification is manual by design —
never part of CI.

Required env when live:
- \`GEMINI_API_KEY\` (Google AI Studio key)
- optional \`GEMINI_MODEL\` (fallback when the cell omits \`model:\`)

\`\`\`tl-cell
id: ask
type: data
rows:
  - input: "Say hello in one short sentence."
\`\`\`

\`\`\`tl-cell
id: bot
type: agent
provider: fixture   # live: gemini (GEMINI_API_KEY)
model: gemini-2.5-flash   # a cheap Gemini model id
data: ask
max_turns: 1
\`\`\`

A clean run on \`provider: gemini\` proves the whole path; the reply and
usage tokens land in the cell record under \`_bench/runs/\`.
`);

const TEMPLATES = [
  {
    id: 'model-compare',
    title: 'Compare models on support replies',
    description: 'Full offline tour: agents, metrics, judge, eval, annotate, goldens.',
    live: false,
    required_env: [],
    default_name: DEMO_NAME,
    body: DEMO_NOTEBOOK,
  },
  {
    id: 'tool-agent',
    title: 'Tool-using agent (offline)',
    description: 'Tool agent vs no-tools baseline with a trace-aware metric, all on fixture.',
    live: false,
    required_env: [],
    default_name: 'tool-agent',
    body: TOOL_AGENT,
  },
  {
    id: 'agent-chain',
    title: 'Draft → revise agent chain (offline)',
    description: 'Draft then revise agents (needs-ordered) with a judged eval of both stages.',
    live: false,
    required_env: [],
    default_name: 'agent-chain',
    body: AGENT_CHAIN,
  },
  {
    id: 'judge-calibration',
    title: 'Judge calibration with HITL (offline)',
    description: 'Eval + annotate to measure judge agreement offline.',
    live: false,
    required_env: [],
    default_name: 'judge-calibration',
    body: JUDGE_CAL,
  },
  {
    id: 'live-compare',
    title: 'Live providers — Anthropic vs OpenAI',
    description: 'Ships offline on fixture; flip two provider: lines to go live. Keys required live; not for CI.',
    live: true,
    required_env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    default_name: 'live-compare',
    body: LIVE_COMPARE,
  },
  {
    id: 'bedrock-smoke',
    title: 'Bedrock Converse smoke test',
    description: 'One-call Bedrock credential check; ships offline, flip provider: to go live. Not for CI.',
    live: true,
    required_env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    default_name: 'bedrock-smoke',
    body: BEDROCK_SMOKE,
  },
  {
    id: 'gemini-smoke',
    title: 'Gemini generateContent smoke test',
    description: 'One-call Gemini key and wire-path check; ships offline, flip provider: to go live. Not for CI.',
    live: true,
    required_env: ['GEMINI_API_KEY'],
    default_name: 'gemini-smoke',
    body: GEMINI_SMOKE,
  },
];

function listTemplates() {
  return TEMPLATES.map(({ id, title, description, live, required_env, default_name }) => ({
    id, title, description, live, required_env, default_name,
  }));
}

function getTemplate(id) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) throw new Error(`unknown template "${id}"`);
  return t;
}

function withNotebookName(body, name, title) {
  let out = String(body);
  if (/^notebook:\s*.+$/m.test(out)) out = out.replace(/^notebook:\s*.+$/m, `notebook: ${name}`);
  if (title != null && /^title:\s*.+$/m.test(out)) {
    // no quote-swapping: the yaml parser round-trips interior double quotes
    out = out.replace(/^title:\s*.+$/m, `title: "${String(title)}"`);
  }
  return out;
}

function scaffoldTemplate(wsDir, templateId, options = {}) {
  const t = getTemplate(templateId);
  const name = options.name || t.default_name;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`notebook name must be a lowercase slug (got "${name}")`);
  }
  const file = path.join(wsDir, '_bench', `${name}.bench.md`);
  if (fs.existsSync(file)) throw new Error(`notebook already exists: _bench/${name}.bench.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const title = options.title || t.title;
  fs.writeFileSync(file, withNotebookName(t.body, name, title));
  return { name, file, template: t.id, live: t.live, required_env: t.required_env };
}

module.exports = {
  TEMPLATES,
  listTemplates,
  getTemplate,
  scaffoldTemplate,
  withNotebookName,
};
