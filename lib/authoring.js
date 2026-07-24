// lib/authoring.js — the assisted-authoring proposal engine.
//
// The user's notes drive the proposal: a provider-backed call (through the
// existing registry — no new SDKs) reads them and returns a structured
// proposal for the wizard's "Proposed setup" area. Offline honesty is
// non-negotiable: with no live provider the deterministic recommender
// answers instead, *labeled* "offline suggestion" — never a fake AI reply.
//
// The learning half is the bench's own override-log pattern (tl lineage:
// human corrections are the training signal). Every creation where the
// human diverged from the proposal lands in _bench/authoring-log.jsonl;
// correctionsDigest() folds the recent divergences into a compact summary
// that shapes BOTH proposal paths — it rides the LLM prompt verbatim, and
// the deterministic recommender applies repeated corrections directly.

'use strict';

const { slugId } = require('./notebook');
const { listTemplates } = require('./templates');

// The wizard's vocabulary. Mirrors index.html's ONBOARD_GOALS/POSTURES —
// the UI and the engine must agree on ids so a proposal maps 1:1 onto the
// choice cards.
const GOALS = ['compare', 'tool-agent', 'chain', 'judge'];
const POSTURES = ['fixture', 'live', 'bedrock'];

// Cheap-and-fast default per provider for the single proposal call; the
// same models the LIVE templates suggest for a first live run.
const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  bedrock: 'anthropic.claude-3-haiku-20240307-v1:0',
  gemini: 'gemini-2.5-flash',
};

// proposal-eligible live providers, in registry order — fixture is never
// consulted here: the offline path is the deterministic recommender.
const LIVE_PROVIDERS = ['anthropic', 'bedrock', 'gemini', 'openai'];

function templateIds() {
  return listTemplates().map(t => t.id);
}

// same mapping as the wizard's recommendTemplateId — goal + posture onto the
// starter catalogue.
function recommendTemplateId(goal, posture) {
  if (posture === 'bedrock') return 'bedrock-smoke';
  if (posture === 'live' && goal === 'compare') return 'live-compare';
  return ({ compare: 'model-compare', 'tool-agent': 'tool-agent', chain: 'agent-chain', judge: 'judge-calibration' })[goal] || 'model-compare';
}

function isRecursiveRequest(notes) {
  return /\b(iterat(?:e|es|ed|ion|ive|ively)?|recursive|recursion|self[- ]?refine|refin(?:e|ement)|until[- ]?(?:good|pass|better))\b/i.test(String(notes || ''));
}

// ---------------------------------------------------------------------------
// corrections digest — compact, deterministic summary of recent divergences
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'want', 'need', 'test', 'testing', 'then',
  'them', 'they', 'have', 'what', 'when', 'where', 'which', 'will', 'would',
  'should', 'could', 'about', 'against', 'between', 'into', 'over', 'same',
  'some', 'more', 'most', 'other', 'each', 'both', 'because', 'does', 'doing',
  'using', 'also', 'just', 'like', 'make', 'model', 'models', 'experiment',
]);

// informative tokens from free-form notes: lowercase words, length >= 4,
// minus stopwords, most-frequent first, capped.
function noteTokens(notes, cap = 12) {
  const counts = new Map();
  for (const w of String(notes || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, cap)
    .map(([w]) => w);
}

const DIGEST_FIELDS = ['goal', 'posture', 'template'];

// Summarize the last `cap` log rows into per-field correction counts:
// which proposed value the human repeatedly replaced, with what, and the
// note vocabulary those corrections shared. Deterministic to assemble;
// malformed rows are skipped, never fatal.
function correctionsDigest(rows, cap = 20) {
  const recent = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object' && r.proposed && r.kept)
    .slice(-cap);
  const byKey = new Map();
  for (const row of recent) {
    for (const field of DIGEST_FIELDS) {
      const from = row.proposed[field];
      const to = row.kept[field];
      if (!from || !to || from === to) continue;
      const key = `${field}|${from}|${to}`;
      if (!byKey.has(key)) byKey.set(key, { field, from: String(from), to: String(to), count: 0, tokens: new Map() });
      const c = byKey.get(key);
      c.count++;
      for (const t of noteTokens(row.notes)) c.tokens.set(t, (c.tokens.get(t) || 0) + 1);
    }
  }
  const corrections = [...byKey.values()]
    .sort((a, b) => b.count - a.count || (a.field < b.field ? -1 : 1))
    .slice(0, 6)
    .map(c => ({
      field: c.field,
      from: c.from,
      to: c.to,
      count: c.count,
      tokens: [...c.tokens.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map(([w]) => w),
    }));
  const text = corrections.map(c =>
    `- ${c.field}: proposed "${c.from}" but the human kept "${c.to}" (${c.count}x${c.tokens.length ? `; notes mentioned: ${c.tokens.slice(0, 5).join(', ')}` : ''})`
  ).join('\n');
  return { rows_seen: recent.length, corrections, text };
}

// ---------------------------------------------------------------------------
// prompt + validation — strict JSON out of the model, or we degrade
// ---------------------------------------------------------------------------

function buildProposalPrompt(notes, digest) {
  const ids = templateIds();
  const system = [
    'You configure evaluation experiments for the bench, a model-benchmarking notebook.',
    'From the user\'s notes, propose the experiment setup.',
    'Respond with ONLY one JSON object — no prose, no markdown fences — in exactly this shape:',
    '{',
    `  "goal": <one of ${JSON.stringify(GOALS)}>,`,
    `  "posture": <one of ${JSON.stringify(POSTURES)}>,`,
    `  "template": <one of ${JSON.stringify(ids)}>,`,
    '  "name": <a short lowercase-slug name for the experiment, e.g. "support-reply-compare">,',
    '  "metric_notes": <one or two short sentences: which metrics to start with and why>,',
    '  "judge_notes": <one or two short sentences: whether/how to use an LLM judge>,',
    '  "rationale": <one line: why this setup fits the notes>',
    '}',
    'Field meanings: goal is what the experiment tests (compare = answer quality across models,',
    'tool-agent = does an agent use its tools, chain = multi-stage agent pipeline, judge = calibrate',
    'an LLM judge against human labels). posture is where models run (fixture = offline deterministic,',
    'live = a real API provider, bedrock = AWS Bedrock). template is the starter notebook to scaffold.',
  ].join('\n');
  let user = `The user's notes describing what they want to test:\n"""\n${String(notes || '').trim()}\n"""`;
  if (digest && digest.corrections && digest.corrections.length) {
    user += '\n\nRecent human corrections to earlier proposals (proposed vs kept). These show this'
      + ' user\'s actual preferences — weight them heavily when the notes are similar:\n'
      + digest.text;
  }
  return {
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: 500,
    temperature: 0,
    mode: 'chat',
  };
}

// Parse + validate model output against the strict shape. Tolerates fenced or
// prose-wrapped JSON (first { … last }); anything else is a readable failure
// the caller turns into the deterministic fallback — never a crash.
function validateProposal(text) {
  const raw = String(text == null ? '' : text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'no JSON object in the reply' };
  let data;
  try { data = JSON.parse(raw.slice(start, end + 1)); }
  catch { return { ok: false, reason: 'reply was not valid JSON' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'reply JSON was not an object' };
  }
  if (!GOALS.includes(data.goal)) return { ok: false, reason: `goal "${data.goal}" is not one of ${GOALS.join('/')}` };
  if (!POSTURES.includes(data.posture)) return { ok: false, reason: `posture "${data.posture}" is not one of ${POSTURES.join('/')}` };
  const ids = templateIds();
  if (!ids.includes(data.template)) return { ok: false, reason: `template "${data.template}" is not in the catalogue` };
  const name = slugId(data.name) || recommendName(String(data.name || ''), data.template);
  return {
    ok: true,
    proposal: {
      goal: data.goal,
      posture: data.posture,
      template: data.template,
      name,
      metric_notes: String(data.metric_notes || '').trim(),
      judge_notes: String(data.judge_notes || '').trim(),
      rationale: String(data.rationale || '').trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// deterministic fallback — the "offline suggestion"
// ---------------------------------------------------------------------------

function inferGoal(notes) {
  const s = String(notes || '').toLowerCase();
  if (isRecursiveRequest(s)) return 'chain';
  if (/\btools?\b|tool[- ]?using|function call|lookup/.test(s)) return 'tool-agent';
  if (/chain|draft.*revise|revise.*draft|multi[- ]?agent|pipeline|two[- ]?stage|stages/.test(s)) return 'chain';
  if (/judge|calibrat|label|annotat|agreement|rubric/.test(s)) return 'judge';
  return 'compare';
}

function inferPosture(notes) {
  const s = String(notes || '').toLowerCase();
  if (/bedrock|\baws\b|converse api|sigv4/.test(s)) return 'bedrock';
  if (/\blive\b|anthropic|openai|claude|\bgpt\b|gemini|api key|real (model|provider)|production model/.test(s)) return 'live';
  return 'fixture';
}

const GOAL_METRIC_NOTES = {
  compare: 'Start with a cheap expression metric (brevity or exact match) so runs are comparable before any judge.',
  'tool-agent': 'Score tool behavior from the turns trace — a used_tool expression metric proves the agent actually reached for its tools.',
  chain: 'Benchmark both stages side by side in one eval grid so "did the revise pass help" is a number.',
  judge: 'Keep metrics minimal — the point is measuring judge agreement against your hand labels.',
};
const GOAL_JUDGE_NOTES = {
  compare: 'Add an LLM judge once replies stabilize; start with 1-2 dimensions on a 5-point scale.',
  'tool-agent': 'A judge is optional here — the trace metric is the primary signal.',
  chain: 'One judge across both stages keeps the comparison honest.',
  judge: 'The judge IS the experiment: label outputs by hand via annotate, then compare.',
};

// deterministic name suggestion: informative note tokens, else the
// template's default slug.
function recommendName(notes, templateId) {
  const tokens = noteTokens(notes, 3).sort();
  const fromNotes = slugId(tokens.join('-'));
  if (fromNotes) return fromNotes;
  const t = listTemplates().find(x => x.id === templateId);
  return (t && t.default_name) || 'starter';
}

// Apply repeated corrections (count >= 2) whose note vocabulary overlaps the
// current notes: if the human keeps replacing our value X with Y for similar
// notes, propose Y. When either side has no tokens, similarity can't be
// judged — repetition alone carries the correction.
function correctionApplies(correction, currentTokens) {
  if (correction.count < 2) return false;
  if (!correction.tokens.length || !currentTokens.length) return true;
  return correction.tokens.some(t => currentTokens.includes(t));
}

// The labeled offline path: keyword inference from the notes, then the recent
// corrections reshape it — the digest influences this path too, by design.
function deterministicProposal(notes, digest) {
  const currentTokens = noteTokens(notes);
  const applied = [];
  let goal = inferGoal(notes);
  let posture = inferPosture(notes);
  const d = (digest && Array.isArray(digest.corrections)) ? digest.corrections : [];
  for (const c of d) {
    if (c.field === 'goal' && c.from === goal && GOALS.includes(c.to) && correctionApplies(c, currentTokens)) {
      goal = c.to; applied.push(`goal ${c.from}->${c.to}`);
    }
    if (c.field === 'posture' && c.from === posture && POSTURES.includes(c.to) && correctionApplies(c, currentTokens)) {
      posture = c.to; applied.push(`posture ${c.from}->${c.to}`);
    }
  }
  let template = isRecursiveRequest(notes) ? 'self-refine' : recommendTemplateId(goal, posture);
  for (const c of d) {
    if (c.field === 'template' && c.from === template && templateIds().includes(c.to) && correctionApplies(c, currentTokens)) {
      template = c.to; applied.push(`template ${c.from}->${c.to}`);
    }
  }
  const translation = template === 'self-refine'
    ? 'recognized a recursive refinement request: a guarded back-edge feeds gate feedback into each revision, capped at 3 passes'
    : 'inferred from keywords in your notes';
  const rationale = 'Offline suggestion: ' + translation
    + (applied.length ? `; adjusted from your recent corrections (${applied.join(', ')})` : '')
    + ' — no live provider was used.';
  return {
    goal,
    posture,
    template,
    name: recommendName(notes, template),
    metric_notes: GOAL_METRIC_NOTES[goal],
    judge_notes: GOAL_JUDGE_NOTES[goal],
    rationale,
  };
}

// ---------------------------------------------------------------------------
// propose — the orchestration the server endpoint calls
// ---------------------------------------------------------------------------

const OFFLINE_LABEL = 'offline suggestion';

// notes + recent log rows + the provider registry → { proposal, provider,
// label, note? }. First available live provider answers; the deterministic
// recommender covers no-provider, provider-error, and malformed-output — with
// a readable note, never a throw.
async function propose({ notes, rows, providers, env = process.env } = {}) {
  const digest = correctionsDigest(rows || []);
  let chosen = null;
  for (const name of LIVE_PROVIDERS) {
    const p = providers && providers.get ? providers.get(name) : null;
    if (p && p.available().ok) { chosen = p; break; }
  }
  if (!chosen) {
    return {
      proposal: deterministicProposal(notes, digest),
      provider: 'offline',
      label: OFFLINE_LABEL,
      note: 'no live provider available — deterministic recommendation from your notes',
      digest_rows: digest.rows_seen,
    };
  }
  const model = (chosen.name === 'bedrock' && env.BEDROCK_MODEL)
    || (chosen.name === 'gemini' && env.GEMINI_MODEL)
    || DEFAULT_MODELS[chosen.name];
  let note;
  try {
    const reply = await chosen.complete({ model, ...buildProposalPrompt(notes, digest) });
    const v = validateProposal(reply && reply.text);
    if (v.ok) {
      return {
        proposal: v.proposal,
        provider: chosen.name,
        label: `AI proposal · ${chosen.name}`,
        model: (reply && reply.model) || model,
        digest_rows: digest.rows_seen,
      };
    }
    note = `${chosen.name} returned an unusable proposal (${v.reason}) — showing the offline suggestion instead`;
  } catch (e) {
    note = `${chosen.name} failed (${String(e && e.message || e)}) — showing the offline suggestion instead`;
  }
  return {
    proposal: deterministicProposal(notes, digest),
    provider: 'offline',
    label: OFFLINE_LABEL,
    note,
    attempted: chosen.name,
    digest_rows: digest.rows_seen,
  };
}

module.exports = {
  GOALS,
  POSTURES,
  DEFAULT_MODELS,
  OFFLINE_LABEL,
  recommendTemplateId,
  isRecursiveRequest,
  noteTokens,
  correctionsDigest,
  buildProposalPrompt,
  validateProposal,
  deterministicProposal,
  propose,
};
