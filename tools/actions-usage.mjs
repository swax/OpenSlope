import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const month = process.argv[2] ?? new Date().toISOString().slice(0, 7);

if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
  console.error('Usage: npm run actions:usage -- YYYY-MM');
  process.exit(2);
}

const [year, monthNumber] = month.split('-').map(Number);
const finalDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
const created = `${month}-01..${month}-${String(finalDay).padStart(2, '0')}`;
const repository = await ghJson(['repo', 'view', '--json', 'nameWithOwner']);
const runs = await workflowRuns(repository.nameWithOwner, created);

console.log(`Reading jobs for ${runs.length} Actions runs in ${repository.nameWithOwner} during ${month}...`);
const rows = await parallelMap(runs, 8, async workflowRun => {
  const response = await ghJson([
    'api',
    `repos/${repository.nameWithOwner}/actions/runs/${workflowRun.id}/jobs?per_page=100`,
  ]);
  const jobs = response.jobs ?? [];
  const usage = jobs.reduce((total, job) => {
    if (!job.started_at || !job.completed_at) return total;
    const seconds = Math.max(0, (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000);
    const multiplier = runnerMultiplier(job.labels ?? []);
    total.actualSeconds += seconds;
    if (multiplier > 0) {
      total.roundedHostedMinutes += Math.ceil(seconds / 60);
      total.estimatedIncludedMinutes += Math.ceil(seconds / 60) * multiplier;
    }
    return total;
  }, { actualSeconds: 0, roundedHostedMinutes: 0, estimatedIncludedMinutes: 0 });

  return {
    run_id: workflowRun.id,
    run_attempt: workflowRun.run_attempt,
    workflow: workflowRun.name,
    event: workflowRun.event,
    conclusion: workflowRun.conclusion,
    commit_sha: workflowRun.head_sha,
    commit: workflowRun.head_sha.slice(0, 8),
    title: workflowRun.display_title,
    branch: workflowRun.head_branch,
    actor: workflowRun.actor?.login ?? '',
    started_at: workflowRun.run_started_at,
    completed_at: workflowRun.updated_at,
    jobs: jobs.length,
    actual_job_minutes: minutes(usage.actualSeconds),
    rounded_hosted_minutes: usage.roundedHostedMinutes,
    estimated_included_minutes: usage.estimatedIncludedMinutes,
    url: workflowRun.html_url,
  };
});

rows.sort((left, right) => right.started_at.localeCompare(left.started_at));
const byCommit = aggregateCommits(rows);
const resultsDir = join(root, 'TestResults');
mkdirSync(resultsDir, { recursive: true });

const runsPath = join(resultsDir, `actions-usage-${month}.csv`);
const commitsPath = join(resultsDir, `actions-usage-${month}-by-commit.csv`);
writeCsv(runsPath, rows);
writeCsv(commitsPath, byCommit);

const actual = rows.reduce((sum, row) => sum + Number(row.actual_job_minutes), 0);
const included = rows.reduce((sum, row) => sum + row.estimated_included_minutes, 0);
console.log(`Wrote ${rows.length} runs to ${runsPath}`);
console.log(`Wrote ${byCommit.length} commits to ${commitsPath}`);
console.log(`Totals: ${actual.toFixed(1)} actual job minutes; about ${included} included-plan minutes.`);
console.log('Included-plan minutes are estimates: GitHub rounds each hosted job up, then applies the runner multiplier.');

async function workflowRuns(nameWithOwner, range) {
  const found = [];
  for (let page = 1; ; page++) {
    const response = await ghJson([
      'api', '-X', 'GET',
      `repos/${nameWithOwner}/actions/runs`,
      '-f', `created=${range}`,
      '-f', 'per_page=100',
      '-f', `page=${page}`,
    ]);
    found.push(...response.workflow_runs);
    if (response.workflow_runs.length < 100) return found;
  }
}

async function ghJson(args) {
  try {
    const { stdout } = await run('gh', args, {
      cwd: root,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`GitHub CLI failed: ${detail}`, { cause: error });
  }
}

function runnerMultiplier(labels) {
  const normalized = labels.map(label => String(label).toLowerCase());
  if (normalized.includes('self-hosted')) return 0;
  if (normalized.some(label => label.includes('macos'))) return 10;
  if (normalized.some(label => label.includes('windows'))) return 2;
  return 1;
}

function minutes(seconds) {
  return (seconds / 60).toFixed(2);
}

function aggregateCommits(runRows) {
  const commits = new Map();
  for (const row of runRows) {
    const commit = commits.get(row.commit_sha) ?? {
      commit_sha: row.commit_sha,
      commit: row.commit,
      title: row.title,
      branch: row.branch,
      actor: row.actor,
      first_started_at: row.started_at,
      last_completed_at: row.completed_at,
      runs: 0,
      jobs: 0,
      actual_job_minutes: 0,
      rounded_hosted_minutes: 0,
      estimated_included_minutes: 0,
      run_urls: [],
    };
    commit.first_started_at = commit.first_started_at < row.started_at ? commit.first_started_at : row.started_at;
    commit.last_completed_at = commit.last_completed_at > row.completed_at ? commit.last_completed_at : row.completed_at;
    commit.runs++;
    commit.jobs += row.jobs;
    commit.actual_job_minutes += Number(row.actual_job_minutes);
    commit.rounded_hosted_minutes += row.rounded_hosted_minutes;
    commit.estimated_included_minutes += row.estimated_included_minutes;
    commit.run_urls.push(row.url);
    commits.set(row.commit_sha, commit);
  }

  return [...commits.values()]
    .map(commit => ({
      ...commit,
      actual_job_minutes: commit.actual_job_minutes.toFixed(2),
      run_urls: commit.run_urls.join(' '),
    }))
    .sort((left, right) => right.first_started_at.localeCompare(left.first_started_at));
}

async function parallelMap(items, concurrency, callback) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await callback(items[index], index);
    }
  }));
  return output;
}

function writeCsv(path, records) {
  const columns = records.length > 0 ? Object.keys(records[0]) : [];
  const lines = [columns, ...records.map(record => columns.map(column => record[column]))]
    .map(values => values.map(csvCell).join(','));
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
