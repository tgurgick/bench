#!/usr/bin/env node
// bench — the standalone CLI. Zero dependencies, Node stdlib only.
//
// The bench operates on one directory (default: cwd): notebooks live in
// <dir>/_bench/, eval artifacts under <dir>/_bench/runs/, and summary rows in
// <dir>/_metrics/bench-log.jsonl. Inside a throughline checkout the tl CLI
// wraps these same verbs per workspace (`tl bench …`); here the directory is
// explicit via --dir.
//
//   bench demo                     scaffold the demo notebook (offline, fixture provider)
//   bench list                     notebooks + golden sets
//   bench run <notebook> [cell]    run stale cells (add --force to re-run fresh ones)
//   bench serve                    the notebook UI → http://localhost:4460
//
// Flags: --dir <d> (default cwd) · --force · --port <n> · --open

'use strict';

const path = require('path');
const { createBench } = require('../lib/engine');
const { scaffoldDemo, DEMO_NAME } = require('../lib/demo');
const { listTemplates, scaffoldTemplate } = require('../lib/templates');

function out(s) { process.stdout.write(s + '\n'); }
function fail(msg) { process.stderr.write('bench: ' + msg + '\n'); process.exit(1); }

// split flags from positionals; only the flags above exist
function parseArgs(argv) {
  const pos = [];
  const flags = { dir: process.cwd(), force: false, open: false, port: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') flags.dir = argv[++i] || flags.dir;
    else if (a === '--force') flags.force = true;
    else if (a === '--open') flags.open = true;
    else if (a === '--port') flags.port = argv[++i];
    else if (a === '--name') flags.name = argv[++i] || null;
    else if (a.startsWith('--')) fail(`unknown flag "${a}"`);
    else pos.push(a);
  }
  flags.dir = path.resolve(flags.dir);
  return { pos, flags };
}

function usage(stream) {
  const w = s => (stream || process.stdout).write(s + '\n');
  w('bench — benchmark models and run experiments in a reactive notebook');
  w('');
  w('Usage:');
  w('  bench demo      [--dir <d>]                    Scaffold the model-compare demo');
  w('  bench templates [--dir <d>]                    List starter notebook templates');
  w('  bench scaffold  <template> [--name <slug>] [--dir <d>]');
  w('                                                 Copy a template into _bench/');
  w('  bench list      [--dir <d>]                    List notebooks and golden sets');
  w('  bench run       <notebook> [cell] [--force] [--dir <d>]');
  w('                                                 Run stale cells headless');
  w('  bench serve     [--port <n>] [--open] [--dir <d>]');
  w('                                                 The notebook UI (default :4460)');
  w('');
  w('The working directory (or --dir) is the workspace: notebooks in _bench/,');
  w('logs in _metrics/. Offline templates use the fixture provider; live ones');
  w('need API keys / AWS creds and are marked in `bench templates`.');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);

  switch (cmd) {
    case 'demo': {
      // same clean one-line failure as `scaffold` — never a stack trace
      try {
        const r = scaffoldDemo(flags.dir);
        out(`notebook:  ${path.relative(flags.dir, r.file) || r.file}`);
        out(`run it:    bench run ${DEMO_NAME}`);
        out('open it:   bench serve --open');
      } catch (e) { fail(String(e && e.message || e)); }
      return;
    }

    case 'templates': {
      for (const t of listTemplates()) {
        const tag = t.live ? 'LIVE' : 'offline';
        const env = t.required_env.length ? ` · env: ${t.required_env.join(', ')}` : '';
        out(`- ${t.id} [${tag}] — ${t.title}${env}`);
        out(`    ${t.description}`);
      }
      out('\nscaffold:  bench scaffold <id> [--name <slug>]');
      return;
    }

    case 'scaffold': {
      const [templateId] = pos;
      if (!templateId) fail('Usage: bench scaffold <template> [--name <slug>]');
      try {
        const r = scaffoldTemplate(flags.dir, templateId, flags.name ? { name: flags.name } : {});
        out(`notebook:  ${path.relative(flags.dir, r.file) || r.file}`);
        out(`template:  ${r.template}${r.live ? ' (LIVE — ships offline on fixture; flip the # live: provider to go live)' : ''}`);
        if (r.required_env.length) out(`live env:  ${r.required_env.join(', ')}`);
        out(`run it:    bench run ${r.name}`);
        out('open it:   bench serve --open');
      } catch (e) { fail(String(e && e.message || e)); }
      return;
    }

    case 'list': {
      const bench = createBench({ wsDir: flags.dir });
      const notebooks = bench.listNotebooks();
      if (!notebooks.length) { out('no notebooks under _bench/ — start with: bench demo'); return; }
      for (const nb of notebooks) out(`- ${nb.name} — ${nb.title} (${nb.cells} cells)`);
      const sets = bench.listGoldenSets();
      if (sets.length) {
        out('\ngolden sets:');
        for (const s of sets) out(`- ${s.set}: ${s.approved} approved / ${s.draft} draft / ${s.rejected} rejected`);
      }
      return;
    }

    case 'run': {
      const [nbName, cellId] = pos;
      if (!nbName) fail('Usage: bench run <notebook> [cell] [--force]');
      const bench = createBench({ wsDir: flags.dir });
      const p = cellId
        ? bench.runCell(nbName, cellId, { force: flags.force })
        : bench.runAll(nbName, { force: flags.force });
      return p.then(r => {
        out(`ran: ${r.ran.length ? r.ran.join(', ') : '(nothing stale — use --force to re-run)'}`);
        for (const [id, st] of Object.entries(r.notebook.state)) {
          if (st.error) out(`! ${id}: ${st.error}`);
        }
        for (const cell of r.notebook.cells) {
          if (cell.type !== 'eval') continue;
          const o = (r.notebook.state[cell.id] || {}).output;
          if (!o || !o.summary) continue;
          out(`\neval ${cell.id} → ${o.run_id} (${o.results_path})`);
          for (const c of o.summary.candidates) {
            const win = o.summary.winner === c.candidate ? '  ← winner' : '';
            out(`  ${c.candidate} [${c.provider}/${c.model}] n=${c.n} judge=${c.judge ? c.judge.overall_mean : '-'} metrics=${JSON.stringify(c.metrics)}${win}`);
          }
        }
      }).catch(e => fail(String(e && e.message || e)));
    }

    case 'serve': {
      // hand off to the server with a normalized argv; it owns the listen loop
      process.argv = [process.argv[0], path.join(__dirname, '..', 'server.js'),
        '--root', flags.dir,
        ...(flags.port ? ['--port', String(flags.port)] : []),
        ...(flags.open ? ['--open'] : [])];
      require('../server.js');
      return;
    }

    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return usage();

    default:
      process.stderr.write(`bench: unknown command "${cmd}"\n\n`);
      usage(process.stderr);
      process.exit(2);
  }
}

main();
