// lib/demo.js — the deterministic demo notebook.
//
// `bench demo` (or `tl bench demo <workspace>` inside a throughline checkout)
// scaffolds this notebook into the root's _bench/ folder. It exercises the
// whole bench offline — dataset → prompt → two agent-loop candidates (one
// with a tool) → metrics → an LLM judge → an eval grid → HITL annotation →
// synthetic golden generation with its human approval gate — all on the
// fixture provider, so it proves the loop with zero keys and zero network.
// Swap `provider: fixture` for `anthropic` or `openai` and the same notebook
// benchmarks real models.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEMO_NAME = 'model-compare';

const DEMO_NOTEBOOK = `---
notebook: ${DEMO_NAME}
title: "Compare models on support replies"
---

# Compare models on support replies

A working tour of the bench: a small dataset, two agent candidates, metrics,
an LLM judge, an eval grid, human annotation, and a synthetic golden set with
its approval gate. Everything below runs offline on the \`fixture\` provider —
change \`provider\` / \`model\` on the agent and judge cells to benchmark real
models (\`anthropic\` needs ANTHROPIC_API_KEY; \`openai\` covers any
OpenAI-compatible endpoint, including a local one via BENCH_OPENAI_BASE_URL).

\`\`\`tl-cell
id: seeds
type: data
rows:
  - input: "Where is my order? It was supposed to arrive yesterday."
    expected: "order"
  - input: "How do I reset my password?"
    expected: "password"
  - input: "I was charged twice for the same subscription."
    expected: "subscription"
  - input: "Can I change my delivery address after checkout?"
    expected: "delivery address"
\`\`\`

The prompt is shared by every candidate, so the comparison is controlled:
same task text, same rows — only the agent (provider/model/tools) varies.

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
id: concise
type: agent
provider: fixture
model: fixture-small
prompt: reply-prompt
max_turns: 2
\`\`\`

\`\`\`tl-cell
id: tooluser
type: agent
provider: fixture
model: fixture-large
prompt: reply-prompt
tools: [lookup]
max_turns: 4
\`\`\`

Metrics are code — instant and free. \`expr\` metrics are one JavaScript
expression over \`{output, expected, input, row, usage, latency_ms, turns}\`.

\`\`\`tl-cell
id: mentions-topic
type: metric
kind: contains
\`\`\`

\`\`\`tl-cell
id: brevity
type: metric
kind: expr
expr: output.length < 240 ? 1 : 0
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
  A good reply resolves the customer's issue or asks exactly one clarifying
  question. It is specific to the message (not boilerplate), correct, and
  under a short paragraph.
\`\`\`

\`\`\`tl-cell
id: compare
type: eval
data: seeds
candidates: [concise, tooluser]
metrics: [mentions-topic, brevity]
judges: [quality]
\`\`\`

Annotate the eval results — the human-in-the-loop pass. The first label is
the "positive" one; agreement between your labels and the judge's verdicts is
computed automatically, which is how you calibrate a judge before trusting it.

\`\`\`tl-cell
id: review
type: annotate
source: compare
labels: [good, bad]
instructions: Mark a reply good only if it would actually resolve the ticket.
\`\`\`

Grow the dataset synthetically: the generator writes *draft* rows into the
golden set; nothing becomes benchmark data until a human approves it below.

\`\`\`tl-cell
id: golden-gen
type: golden
set: support-replies
seed_data: seeds
count: 4
provider: fixture
instructions: Generate realistic customer support messages with the expected resolution topic.
\`\`\`

\`\`\`tl-cell
id: golden-review
type: annotate
golden: support-replies
needs: [golden-gen]
labels: [approve, reject]
instructions: Approve rows that read like real customer messages with a correct expected topic.
\`\`\`

Once rows are approved, point a data cell at the set and eval against it:

\`\`\`tl-cell
id: goldens
type: data
golden: support-replies
include: approved
needs: [golden-review]
\`\`\`
`;

// Write the demo notebook into a workspace. Refuses to overwrite an existing
// notebook of the same name — the demo is a starting point, not a reset.
function scaffoldDemo(wsDir, options = {}) {
  const name = options.name || DEMO_NAME;
  const file = path.join(wsDir, '_bench', `${name}.bench.md`);
  if (fs.existsSync(file)) throw new Error(`notebook already exists: _bench/${name}.bench.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DEMO_NOTEBOOK);
  return { name, file };
}

module.exports = { DEMO_NAME, DEMO_NOTEBOOK, scaffoldDemo };
