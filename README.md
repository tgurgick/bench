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
node bin/bench.js demo          # scaffold _bench/model-compare.bench.md in the cwd
node bin/bench.js run model-compare
node bin/bench.js serve --open  # the notebook UI → http://localhost:4460
```

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
| `agent` | One agent-loop definition | `provider`, `model`, `prompt:` (cell ref) or inline `template:`, `system:`, `tools:`, `max_turns`, `temperature`, `input:` (solo smoke test) |
| `metric` | A code metric — instant and free | `kind:` (see below), `name:`, `value:`/`pattern:`, `expr:` |
| `judge` | An LLM or code judge | `kind: llm\|code`, `provider`, `model`, `scale`, `dimensions:`, `rubric:`, `expr:` |
| `golden` | Synthetic golden-set generation (drafts only) | `set:`, `count:`, `seed_data:` (cell ref) or `seeds:`, `fields:`, `instructions:`, `provider`, `model` |
| `eval` | The experiment grid: rows × candidates × metrics × judges | `data:`, `candidates: [agent ids]`, `metrics: [...]`, `judges: [...]`, `limit:` |
| `annotate` | The HITL queue over eval results or golden drafts | `source: <eval id>` or `golden: <set>`, `labels: [...]` or `scale: N`, `instructions:` |

Every type also accepts `needs: [ids]` for explicit ordering without data flow.

### Agent loops

An `agent` cell runs: render the prompt for the row → call the model → execute
any tool calls → feed results back → repeat until the model answers in text or
`max_turns` is hit. Every step is recorded in `turns` — the observable trace.

Builtin tools: `calc` (guarded arithmetic), `today` (the engine clock),
`lookup` (a field on the current row). Custom tools are one expression:

```yaml
tools:
  - name: shout
    description: upper-case the input
    expr: String(args.input || "").toUpperCase()
```

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
| `openai` | `OPENAI_API_KEY` or `BENCH_OPENAI_BASE_URL` | Any OpenAI-compatible `chat/completions` endpoint — OpenAI, Ollama, vLLM, … |

Providers expose `{ name, available(), complete(req) }` and nothing else; a
new provider is one object, and tests inject a fake transport to assert the
exact wire request without network.

## Files

```
<your project>/
├── _bench/
│   ├── <name>.bench.md                    # the notebook (markdown IS the notebook)
│   ├── runs/<name>/cells/<id>.json        # last output per cell (the reactive state)
│   ├── runs/<name>/evals/<run>/           # results.jsonl + summary.json per eval run
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
