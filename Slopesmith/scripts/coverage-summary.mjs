import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const reportPath = resolve('coverage', 'coverage-summary.json');
const allowMissing = process.argv.includes('--allow-missing');

let markdown;
if (!existsSync(reportPath)) {
  markdown = '## Slopesmith coverage\n\nCoverage was not produced because the verification gate stopped earlier.';
  if (!allowMissing) {
    console.error(`Coverage summary not found: ${reportPath}`);
    process.exitCode = 1;
  }
} else {
  const summary = JSON.parse(readFileSync(reportPath, 'utf8'));
  const { total } = summary;
  const metrics = [
    ['Lines', total.lines],
    ['Statements', total.statements],
    ['Functions', total.functions],
    ['Branches', total.branches],
  ];
  const rows = metrics.map(([label, value]) =>
    `| ${label} | ${value.covered.toLocaleString('en-US')} | ${value.total.toLocaleString('en-US')} | ${value.pct}% |`);
  const areaRows = ['app', 'core', 'server'].map(area => {
    const lines = Object.entries(summary)
      .filter(([file]) => file !== 'total' && new RegExp(`[\\\\/]src[\\\\/]${area}[\\\\/]`).test(file))
      .reduce((sum, [, value]) => ({
        covered: sum.covered + value.lines.covered,
        total: sum.total + value.lines.total,
      }), { covered: 0, total: 0 });
    const pct = lines.total === 0 ? 100 : Math.floor(lines.covered / lines.total * 10_000) / 100;
    return `| ${area} | ${lines.covered.toLocaleString('en-US')} | ${lines.total.toLocaleString('en-US')} | ${pct}% |`;
  });
  markdown = [
    '## Slopesmith coverage',
    '',
    '| Metric | Covered | Total | Coverage |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
    '',
    '### Line coverage by area',
    '',
    '| Area | Covered | Total | Coverage |',
    '| --- | ---: | ---: | ---: |',
    ...areaRows,
    '',
    '_Scope: all hand-written `src/**/*.ts`; generated TypeScript is excluded. Unloaded files count as 0%._',
  ].join('\n');
}

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
