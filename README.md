# bench

**Benchmark models and run experiments in one clean, reactive notebook.**
Zero dependencies — Node stdlib only, no build step, markdown is the database.

The bench combines the two open-source ideas that make this kind of tooling
pleasant — **marimo**'s reactive notebook (cells form a dependency graph;
running a cell re-runs its stale ancestors and dirties its descendants) and
**n8n**'s typed nodes (each cell is a small, configurable unit of work) — in
one markdown notebook per project.

What you can do in it:

1. **Build agent loops** — `agent` cells run a model ↔ tool loop per input with
   an observable trace.
2. **Run experiments** — `eval` cells fan a dataset across candidate agents and
   score every result.
3. **Design evals** — `data` + `prompt` + `metric` + `judge` cells compose into
   controlled comparisons.
4. **Generate synthetic golden sets** — `golden` cells draft rows from seeds;
   drafts are quarantined until a human approves them.
5. **Annotate results (HITL)** — `annotate` cells queue items for human labels
   and compute judge agreement.
6. **Configure new metrics and judges** — builtin metric kinds, one-expression
   custom metrics, LLM judges with rubrics, code judges.

> Built with [throughline](https://github.com/tgurgick/tl)'s file discipline
> (markdown is the database, JSONL is the learning surface, human gates are
> real); developed against a TL workspace, usable entirely on its own.

## Quick start

```
node bin/bench.js demo              # scaffold _bench/model-compare.bench.md
node bin/bench.js templates         # list starter notebooks
node bin/bench.js scaffold tool-agent
node bin/bench.js run model-compare
node bin/bench.js serve --open      # UI → http://localhost:4460
```

`bench demo` is the full offline tour (fixture provider). `bench templates`
lists the gallery — offline templates run without keys; **LIVE** ones declare
required env vars and are not exercised in CI. The UI's **+ new project**
wizard scaffolds the same catalogue (or use `bench scaffold <id>`).

**First run?** Start from the thing being tested. `bench serve --open` in an
empty directory lands on the **+ new project** wizard: pick a testing goal
and a model posture, and it scaffolds the matching starter notebook — the
same catalogue `bench scaffold <id> [--name <slug>]` copies from the CLI, so
both paths write identical markdown notebooks (the wizard shows the CLI
equivalent as you go). Every starter runs green offline on the fixture
provider; hit **▶ run all** and read the results before touching a key.

The demo runs entirely on the deterministic `fixture` provider — no keys, no
network — and exercises every cell type. Swap `provider:` / `model:` on the
agent and judge cells to benchmark real models.

## The notebook file

A notebook is one markdown file: `_bench/<name>.bench.md` under your working
directory. Typed cells are fenced ` ```tl-cell ` blocks whose body is YAML;
prose between fences renders as note cells. Diffable, portable, no hidden
state.

````markdown
---
notebook: model-compare
title: "Compare models on support replies"
---

Prose becomes a note cell.

```tl-cell
id: seeds
type: data
rows:
  - input: "Where is my order?"
    expected: "order"
```
````

A bare ` ```tl-cell ` line at the top level of the file **always** opens a
cell — it is indistinguishable from the format itself. To quote the syntax in
a note (as this README does above), nest it inside an outer fenced code block
(```` ```` ````, ` ~~~ `, or a longer backtick run); the parser tracks the
outer fence and keeps everything inside it as prose.

Cells reference each other **by id** (`data: seeds`, `candidates: [concise]`);
those references are the dependency graph. There is no separate wiring file —
the edges are visible in the configs. Multi-line strings (templates, rubrics,
instructions) use `key: |` block scalars at the top level of a cell.

Reactivity is marimo's: a cell is **stale** when it never ran, its config
changed, or anything upstream changed — transitively. Running a cell first
re-runs its stale ancestors in graph order; descendants show as stale until
asked (calm over cascade). `bench run <nb>` runs everything stale; `--force`
re-runs regardless.

## Cell types

| Type | What it does | Key config |
|------|--------------|-----------|
| `note` | Prose between fences — rendered, never executed | — |
| `data` | Rows for evals | `rows:` inline, `file:` (JSON/JSONL under the root), or `golden: <set>` (+ `include: approved\|draft\|all`, default approved); `limit:` |
| `prompt` | A `{{var}}` template shared across candidates | `template:`, `system:`, `data:` (for the preview) |
| `agent` | One agent-loop definition | `provider`, `model`, `prompt:` / `template:`, `tools:`, `max_turns`, `input:` / `data:`, or `input_from:` (+ optional `input_path:`) for handoffs |
| `metric` | A code metric — instant and free | `kind:` (see below), `name:`, `value:`/`pattern:`, `expr:` |
| `judge` | An LLM or code judge | `kind: llm\|code`, `provider`, `model`, `scale`, `dimensions:`, `rubric:`, `expr:`; optional `input_from:` / `input_path:` to score an upstream cell |
| `golden` | Synthetic golden-set generation (drafts only) | `set:`, `count:`, `seed_data:` (cell ref) or `seeds:`, `fields:`, `instructions:`, `provider`, `model` |
| `eval` | The experiment grid: rows × candidates × metrics × judges | `data:`, `candidates: [agent ids]`, `metrics: [...]`, `judges: [...]`, `limit:` |
| `annotate` | The HITL queue over eval results or golden drafts | `source: <eval id>` or `golden: <set>`, `labels: [...]` or `scale: N`, `instructions:` |
| `switch` | Choose one upstream branch; its output passes through | `input:`, `cases: [{when, use}]`, `default:` |
| `map` | Transform/filter an upstream cell's rows | `input:`, `expr:`, `filter:`, `limit:` |
| `retry` | Ensure a target's output, re-running it on failure (bounded) | `target:`, `attempts:` (≤ 5) |
| `catch` | The explicit error path: pass through or fall back | `try:`, `fallback: <cell>` or `rows:` inline |
| `tool` | A reusable tool definition agents reference by id in `tools:` | `kind: expr\|http\|file\|transform`, `params:`, plus `expr:` / `url:` / `path:` / `template:` per kind |

Every type also accepts `needs: [ids]` for explicit ordering without data flow.

### Flow authoring

The flow view is an authoring surface over the same markdown notebook, not a
second graph document. Add, edit, duplicate, delete, and connect actions call
the local cell mutation APIs and rewrite the relevant `.bench.md` cells;
layout positions remain the only separate UI artifact under `_bench/layout/`.
Connections write ordinary ref fields such as `data:`, `prompt:`,
`candidates:`, `metrics:`, `judges:`, `source:`, `target:`, `try:`, and
`needs:` so the graph still comes from `buildGraph`.

### Agent loops

An `agent` cell runs: render the prompt for the row → call the model → execute
any tool calls → feed results back → repeat until the model answers in text or
`max_turns` is hit. Every step lands in `turns` on the cell record.

**Chaining.** Point `input_from:` at another agent, judge, or control cell to
feed its output into this agent (default field `output`; override with
`input_path:`, e.g. `sample.overall`). The handoff is recorded on the cell /
eval result. Eval candidates that use `input_from:` run the upstream agent
pipeline per row automatically. Flow draws `input_from` edges as dashed
accent strokes.

```yaml
id: revise
type: agent
provider: fixture
input_from: draft
input_path: output
template: |
  Improve this draft (keep it under 200 chars):
  {{input}}
```

Builtin tools: `calc` (guarded arithmetic), `today` (the engine clock),
`lookup` (a field on the current row). Custom tools are one expression:

```yaml
tools:
  - name: shout
    description: upper-case the input
    expr: String(args.input || "").toUpperCase()
```

For tools worth sharing across agents, define a `tool` cell once and list its
id in `tools:` alongside builtins and inline tools — see
[Tool nodes](#tool-nodes) below.

### Metrics

Builtin kinds: `exact_match`, `contains`, `regex`, `json_valid`, `length`,
`latency`, `tokens`, `cost` — plus `expr`, one JavaScript expression over
`{output, expected, input, row, usage, latency_ms, turns}` returning a number
or boolean. Expressions run in a `node:vm` context with a timeout — an
accident guard, not a sandbox: the notebook is your own local file, the same
trust as any script you run.

### Judges

`kind: llm` sends the rubric, dimensions, and sample to the provider and
parses a JSON judgment `{scores, overall, verdict, rationale}` (tolerantly —
models wrap JSON in prose). `kind: code` runs an expression returning a number
or that same object shape. Judgments normalize onto the cell's `scale` and a
pass/fail verdict, so judge output is always comparable.

### Eval grids

An `eval` cell runs every data row through every candidate agent, scores each
result with every metric and judge, and writes:

- `_bench/runs/<nb>/evals/<run>/results.jsonl` — one row per (row × candidate)
- `_bench/runs/<nb>/evals/<run>/summary.json` — per-candidate means, tokens,
  cost, latency, and the winner
- `_metrics/bench-log.jsonl` — one summary row per candidate, the learning
  surface

The winner rule is deterministic and visible: judge overall mean, then the
first metric, then fewer output tokens. No learned ranking.

### Run controls

Every server run gets a `run_id`. The UI's Stop button calls
`/api/run-cancel` for that active id; the engine observes cancellation at
clean cell boundaries, so a provider call already in flight is allowed to
finish and completed cell records stay durable. A cancelled run returns
`status: cancelled` with the cells that finished, and running again resumes
from stale or unfinished cells. The server also appends success, error, and
cancelled statuses to `_bench/run-events.jsonl`, which `/api/journal` exposes
alongside eval-result runs.

### Control nodes

Four composable primitives cover branching, transforming, retrying, and error
handling — each is an ordinary cell in the graph (staleness, run plans, and
records work exactly like every other type), and each *passes its result
through*, so downstream cells consume a control node the same way they consume
a data or agent cell. No hidden state: the selection, the attempt log, and the
caught error are all in the cell's record on disk.

**`switch`** picks one upstream branch. Cases are checked in order against the
`input:` cell's output (`output`, `rows`, `count`, `first` are in scope); the
first truthy `when:` (or a case with no `when:`) wins, else `default:`, else
the cell errors. The chosen cell's output passes through with `selected` and
`case` added:

```yaml
id: route
type: switch
input: seeds
cases:
  - when: count > 100
    use: sampled
default: seeds
```

**`map`** transforms an upstream cell's rows with one expression per row
(scope: `row`, `index`, `rows`). `filter:` keeps rows where it is truthy;
`expr:` returns the new row — an object replaces the row, `null` drops it,
a scalar wraps as `{ value }`. A throwing expression fails the cell and names
the row:

```yaml
id: doubled
type: map
input: seeds
filter: row.n > 1
expr: "({ ...row, double: row.n * 2 })"
```

**`retry`** guards a flaky cell. If the `target:` ran clean, its output passes
through untouched (`retry.attempts: 0`); if it errored, the target's executor
re-runs up to `attempts:` times (default 3, hard cap 5). Every attempt lands
in `retry.log`; total failure produces an error record listing each attempt's
error. The target's own record is never overwritten — a failing cell stays
visibly red even when its retry recovers.

```yaml
id: keep
type: retry
target: flaky-agent
attempts: 4
```

**`catch`** is the explicit error path. A clean `try:` upstream passes through
(`caught: false`); an errored one yields `{caught: true, error}` plus a
fallback — another cell's output via `fallback:` or inline `rows:` — so
downstream keeps a well-defined input instead of inheriting a buried failure.
Without a catch, an errored upstream propagates as an error (`resolve` refuses
error records); it never silently looks successful.

```yaml
id: safe
type: catch
try: flaky-agent
rows:
  - input: "fallback question"
```

### Tool nodes

A `tool` cell is a reusable tool definition — the n8n-style small workflow
unit, defined once and referenced by id from any agent's `tools:` list, next
to builtins and inline expr tools. Each entry in `tools:` resolves in order:
a builtin name (`calc`, `today`, `lookup` — reserved, builtins shadow cells),
then a `tool` cell id, then an inline `{name, expr}` object; anything else is
a readable error naming what was tried. The reference is an ordinary graph
edge, so editing a tool cell dirties every agent that uses it, and a renamed
tool cell leaves the agents stale with an "unknown tool" error instead of
silently running without it.

`params:` declares the JSON-schema-like input surface providers see — a map
of name → `{type, description, required}` (or `parameters:` to pass a full
JSON schema through). Without params a tool takes the single string `input`,
same as inline tools. Every call lands in the agent's `turns` with the tool
name, the originating `tool_cell` id, the args, and the clipped result.

Four kinds:

**`expr`** — one JavaScript expression over `{args, row}` (`kind: expr` is
implied when only `expr:` is given). Runs in `node:vm` with a timeout — an
accident guard, not a sandbox: the notebook is your own local file, the same
trust as any script you run.

```yaml
id: shout
type: tool
kind: expr
description: upper-case the input
expr: String(args.input || "").toUpperCase()
params:
  input:
    type: string
    required: true
```

**`transform`** — a `{{var}}` template rendered from the call's args over the
current row (args win on collisions):

```yaml
id: greet
type: tool
kind: transform
template: "Dear {{customer}}: {{input}}"
```

**`http`** — `method:` / `url:` / `headers:` / `body:`, each value a
`{{var}}` template over args + row; http(s) URLs only. The request goes
through an injectable transport (`createBench({ httpTransport })`), so tests
assert the exact wire request offline. Non-2xx responses come back as a
readable `HTTP <status>: <body>` result; transport failures become
`tool error: …` results the model sees — never crashed runs. Responses are
clipped before re-entering the loop. HTTP tools are local-user trusted: the
notebook is your own file, calling endpoints you chose.

```yaml
id: order-status
type: tool
kind: http
description: fetch order status by id
url: "https://api.example.com/orders/{{order_id}}"
headers:
  accept: application/json
params:
  order_id:
    type: string
    required: true
```

**`file`** — read a workspace file; `path:` is a template over args + row and
resolves through the same traversal guard as every other caller-supplied
path, so `../` can never escape the workspace root. Missing files and escaped
paths are readable tool errors.

```yaml
id: read-notes
type: tool
kind: file
path: notes/{{topic}}.md
```

Executing a tool cell itself only validates the definition and materializes
its parameter schema — nothing external runs until an agent's model actually
calls the tool mid-loop.

### Golden sets and the human gate

A `golden` cell asks a provider for `count` new rows in the shape of its seeds
and appends them to `_bench/goldens/<set>.jsonl` with `origin: synthetic,
status: draft`. **Drafts are not data.** A `data` cell reading `golden: <set>`
sees only `approved` rows by default. Approval happens through an `annotate`
cell (`golden: <set>`) or the UI's approve/reject buttons; each decision
rewrites the row's status in place and appends an audit row to the annotations
log. Hand-added rows are born `approved` — a person wrote them.

### Annotation (HITL)

An `annotate` cell builds a queue from an eval run (or a golden set's drafts)
and shows one item at a time in the UI — input, output, the judge's verdict —
with label buttons and number-key shortcuts. Labels append to
`_bench/annotations/<nb>--<cell>.jsonl` (last write per item wins). When both
human labels and judge verdicts exist, the cell reports **judge agreement** —
the calibration number that tells you whether the judge can be trusted to run
unsupervised. The first label in `labels:` is the positive one by convention.

## Providers

The provider seam (`lib/providers.js`) is the bench's only model I/O:

| Provider | Needs | Notes |
|----------|-------|-------|
| `fixture` | nothing | Deterministic, offline. Same request → same reply, forever. Handles chat, tool calls, generation, and judging so the whole loop is provable with zero keys. |
| `anthropic` | `ANTHROPIC_API_KEY` | The Messages API via fetch; tools map to `tool_use`/`tool_result`. |
| `bedrock` | `AWS_REGION` or `BEDROCK_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Amazon Bedrock Runtime Converse API via fetch with stdlib SigV4 signing; optional `AWS_SESSION_TOKEN` and `BEDROCK_MODEL`. |
| `gemini` | `GEMINI_API_KEY` | Google `v1beta` `generateContent` via fetch; roles map to `user`/`model`, tools to `functionDeclarations`/`functionResponse`; optional `GEMINI_MODEL` fallback. |
| `openai` | `OPENAI_API_KEY` or `BENCH_OPENAI_BASE_URL` | Any OpenAI-compatible `chat/completions` endpoint — OpenAI, Ollama, vLLM, … |

Providers expose `{ name, available(), complete(req) }` and nothing else; a
new provider is one object, and tests inject a fake transport to assert the
exact wire request without network.

Minimal Bedrock example:

```yaml
provider: bedrock
model: anthropic.claude-3-haiku-20240307-v1:0
```

Live verification is manual, not part of CI. Use a tiny notebook and cheap
model, then run:

```
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
node bin/bench.js run <notebook>
```

If you use temporary AWS credentials, also set `AWS_SESSION_TOKEN`.

Same recipe for Gemini:

```
GEMINI_API_KEY=... node bin/bench.js run <notebook>
```

## Files

```
<your project>/
├── _bench/
│   ├── <name>.bench.md                    # the notebook (markdown IS the notebook)
│   ├── runs/<name>/cells/<id>.json        # last output per cell (the reactive state)
│   ├── runs/<name>/evals/<run>/           # results.jsonl + summary.json per eval run
│   ├── run-events.jsonl                   # success/error/cancelled run status events
│   ├── goldens/<set>.jsonl                # golden rows with origin + status
│   └── annotations/<nb>--<cell>.jsonl     # human labels, append-only
└── _metrics/bench-log.jsonl               # one row per eval-run candidate
```

## Server trust model

`node server.js` (or `bench serve`) binds 127.0.0.1 for a single local user —
no auth. Every caller-supplied path resolves through a traversal guard; the
server executes only notebook cells via the engine — it never shells out and
never spawns agents. Inside a throughline checkout it discovers workspaces
under `projects/`; anywhere else the root directory itself is the workspace.

## Tests

```
npm test    # node --test — all offline, fixture provider only
```

## Template gallery

Starter notebooks for the common workflow patterns — list them with
`bench templates`, copy one with `bench scaffold <id> [--name <slug>]`, or use
the UI's **+ new project** wizard. Each is a plain markdown notebook: copy it,
open it, edit it.

| Template | What it demonstrates |
|----------|----------------------|
| `model-compare` | The full tour: dataset → two candidates → metrics → LLM judge → eval grid → annotation → gated golden set (the demo notebook) |
| `tool-agent` | A tool-using agent vs a no-tools baseline, with a trace-aware `expr` metric scoring whether the tool was used |
| `agent-chain` | A draft → revise multi-agent pass ordered with `needs:`, judged side by side in one eval |
| `judge-calibration` | An eval plus the `annotate` queue that computes judge agreement — the number to check before trusting a judge unsupervised |
| `live-compare` | Anthropic vs any OpenAI-compatible endpoint, head to head *(live)* |
| `bedrock-smoke` | A one-call Amazon Bedrock credential and SigV4 check *(live)* |
| `gemini-smoke` | A one-call Gemini key and generateContent wire-path check *(live)* |

Every template ships on the `fixture` provider, so all of them scaffold and
run green offline — including the live ones. Live templates mark the swap with
a `# live:` comment on the `provider:` line and document their env vars in the
notebook prose (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` /
`BENCH_OPENAI_BASE_URL`, `GEMINI_API_KEY`, and the AWS credentials for
Bedrock); going live is a deliberate one-word edit, and CI never touches the
network.
