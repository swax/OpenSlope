// Runs the Snowknife .NET suite and reports what it actually did.
//
// A skip-based tier fails silently: "33 skipped" renders exactly like "33 passed" in a scrolling log, so
// the disc-backed tests could stop existing and every run would stay green. This prints the skip count and
// the reason behind it every time, and puts both in the CI job summary alongside coverage.
//
// The required run explicitly filters out the disc-backed category so the gate means the same thing on every
// machine: detecting the assets instead would make one command take a second on a clean checkout and many
// minutes wherever the data exists. The full command is the deliberate, visible way to run both tiers.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const resultsDir = join(root, 'TestResults');
const trxPath = join(resultsDir, 'snowknife.trx');
const full = process.argv.includes('--full');
let coverageReportFailure = null;

// Each run reports on its own output, so start from an empty directory - otherwise "the newest coverage
// report" is whatever a previous run happened to leave behind.
if (existsSync(resultsDir)) rmSync(resultsDir, { recursive: true, force: true });

const result = spawnSync('dotnet', [
  'test', 'Snowknife/Snowknife.Tests/Snowknife.Tests.csproj',
  '-c', 'Debug',
  '-m:1',
  ...(!full ? ['--filter', 'Category!=EndToEnd'] : []),
  '--logger', 'console;verbosity=normal',
  '--logger', 'trx;LogFileName=snowknife.trx',
  '--collect:XPlat Code Coverage',
  '--results-directory', 'TestResults',
], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  timeout: full ? 30 * 60_000 : 5 * 60_000,
  windowsHide: true,
});

report();

if (result.error) {
  const scope = full ? 'full' : 'fast';
  console.error(`\nSnowknife ${scope} tests failed to complete: ${result.error.message}`);
  process.exit(1);
}
if (coverageReportFailure) {
  console.error(`\nSnowknife coverage reporting failed: ${coverageReportFailure}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

function report() {
  const markdown = [`## Snowknife tests${full ? '' : ' (fast tier)'}`, '', ...tally(), '', ...coverage()].join('\n');
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`, 'utf8');
}

/** Outcome counts and, when tests skipped, the reasons they gave. */
function tally() {
  if (!existsSync(trxPath))
    return ['The suite produced no test results - it failed before running (usually a build error).'];

  const trx = readFileSync(trxPath, 'utf8');
  const counters = /<Counters\b([^>]*)\/>/.exec(trx);
  if (!counters) return ['The test results file carries no summary counters.'];

  const number = name => Number(new RegExp(`${name}="(\\d+)"`).exec(counters[1])?.[1] ?? 0);
  const total = number('total');
  const passed = number('passed');
  const failed = number('failed');
  // VSTest reports skips as the gap between discovered and executed; its own `notExecuted` counter stays 0.
  const skipped = total - number('executed');

  const lines = [
    '| Outcome | Tests |',
    '| --- | ---: |',
    `| Passed | ${passed.toLocaleString('en-US')} |`,
    `| Failed | ${failed.toLocaleString('en-US')} |`,
    `| Skipped | ${skipped.toLocaleString('en-US')} |`,
    `| **Total** | **${total.toLocaleString('en-US')}** |`,
  ];
  if (skipped === 0) return lines;

  // A skipped theory counts once here however many cases it carries, so these are methods rather than cases.
  const reasons = new Map();
  for (const [, body] of trx.matchAll(/<UnitTestResult\b([\s\S]*?)<\/UnitTestResult>/g)) {
    if (!/outcome="NotExecuted"/.test(body)) continue;
    const why = /<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1].trim() ?? '(no reason given)';
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }

  return [
    ...lines,
    '',
    '### Why tests skipped',
    '',
    '| Reason | Tests |',
    '| --- | ---: |',
    ...[...reasons].sort((a, b) => b[1] - a[1]).map(([why, count]) => `| ${why} | ${count} |`),
    '',
    'These drive the real pipeline against a retail disc and an extracted `Maps/`, neither of which can live',
    'in the repository. Run them with `npm run verify:full` on a checkout that has both.',
  ];
}

/** Line coverage of snowknife's own code, by top-level folder. */
function coverage() {
  const report = newestCoberturaReport();
  if (!report) {
    if (!full) coverageReportFailure = 'the fast tier produced no Cobertura report';
    return ['_No coverage report was produced._'];
  }

  // Coverlet writes every line twice - once inside its method and once in the class roll-up - and a
  // filename can appear under several classes, so lines are deduplicated by (file, line number).
  const files = new Map();
  const xml = readFileSync(report, 'utf8');
  // Packages do not nest, so the first closing tag after the header is this package's own. The SSX-Library
  // package alongside it is the submodule's backlog and is not what this number is about.
  const snowknife = /<package name="snowknife"[\s\S]*?<\/package>/.exec(xml)?.[0];
  if (!snowknife) {
    if (!full) coverageReportFailure = 'the Cobertura report carries no `snowknife` package';
    return ['_The coverage report carries no `snowknife` package._'];
  }

  for (const [, filename, body] of snowknife.matchAll(/<class\b[^>]*filename="([^"]+)"([\s\S]*?)<\/class>/g)) {
    let seen = files.get(filename);
    if (!seen) files.set(filename, seen = new Map());
    for (const [, line, hits] of body.matchAll(/<line number="(\d+)" hits="(\d+)"/g))
      seen.set(Number(line), (seen.get(Number(line)) ?? false) || Number(hits) > 0);
  }

  const folders = new Map();
  let covered = 0;
  let total = 0;
  for (const [filename, lines] of files) {
    // Cobertura paths are repository-relative, so the project's own source root has to come off before the
    // first remaining segment is its folder: `Snowknife\Snowknife\Bundle\Foo.cs` -> Bundle. Dropping a fixed
    // number of segments instead would silently collapse the whole table into one row.
    const parts = filename.split(/[\\/]/).filter(Boolean);
    while (parts.length > 1 && parts[0] === 'Snowknife') parts.shift();
    const folder = parts.length > 1 ? parts[0] : '(root)';
    const bucket = folders.get(folder) ?? { covered: 0, total: 0 };
    for (const hit of lines.values()) {
      bucket.total++;
      total++;
      if (hit) { bucket.covered++; covered++; }
    }
    folders.set(folder, bucket);
  }

  const pct = ({ covered: c, total: t }) => (t === 0 ? '-' : `${(c / t * 100).toFixed(1)}%`);
  const rows = [...folders]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([folder, bucket]) =>
      `| ${folder} | ${bucket.covered.toLocaleString('en-US')} | ${bucket.total.toLocaleString('en-US')} | ${pct(bucket)} |`);

  return [
    `### Line coverage${full ? '' : ' — fast tier only'}`,
    '',
    '| Folder | Covered | Total | Coverage |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
    `| **Total** | **${covered.toLocaleString('en-US')}** | **${total.toLocaleString('en-US')}** | **${pct({ covered, total })}** |`,
    '',
    full
      ? '_Both tiers. Scope: the `snowknife` assembly; the SSX-Library submodule is measured separately and excluded here._'
      : '_This coverage is informational; CI does not enforce a minimum. The disc-backed category is explicitly '
        + 'filtered from this run. The full tier '
        + '(`npm run verify:full`) reaches considerably higher. Scope: the `snowknife` assembly; the '
        + 'SSX-Library submodule is measured separately and excluded here._',
  ];
}

function newestCoberturaReport() {
  if (!existsSync(resultsDir)) return null;
  return readdirSync(resultsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(resultsDir, entry.name, 'coverage.cobertura.xml'))
    .filter(existsSync)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}
