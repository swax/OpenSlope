/**
 * Offline protected-region retopology benchmark.
 *
 *   npm run benchmark:retopology -- prepare --input <mountain.slope.json> --out <directory>
 *   npm run benchmark:retopology -- run --dir <directory> --config <runners.json>
 *   npm run benchmark:retopology -- score --dir <directory> --candidate name=<mesh.obj>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateMountain } from '../../src/core/doc/mountain';
import {
  prepareRetopologyBenchmark,
  type RetopologyConstraints,
} from '../../src/core/mesh/retopology/benchmark';
import { scoreRetopologyCandidate } from '../../src/core/mesh/retopology/metrics';
import { meanFaceEdgeLength, readObj, writeObj } from '../../src/core/mesh/retopology/obj';
import { quadWildSharp, quadWildTrailField } from '../../src/core/mesh/retopology/field';

interface RunnerCommand {
  executable: string;
  args: string[];
  cwd?: string;
}
interface CandidateRunner {
  id: string;
  commands: RunnerCommand[];
  /** Expected OBJ after all commands. May contain the same variables as command arguments. */
  output: string;
  timeoutMs?: number;
}
interface RunnerFile { candidates: CandidateRunner[] }

const args = process.argv.slice(2), command = args.shift();
const value = (name: string, fallback?: string): string => {
  const at = args.indexOf(name), found = at >= 0 ? args[at + 1] : undefined;
  if (found !== undefined) return found;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}`);
};
const numberValue = (name: string, fallback: number): number => {
  const parsed = Number(value(name, String(fallback)));
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
};
const allValues = (name: string): string[] => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : [])
  .filter((item): item is string => item !== undefined);
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const writeJson = (file: string, payload: unknown): void => writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);

function benchmarkFiles(directory: string) {
  return {
    input: join(directory, 'input.obj'),
    protected: join(directory, 'protected.obj'),
    constraints: join(directory, 'constraints.json'),
    report: join(directory, 'report.json'),
  };
}

function prepare(): void {
  const inputFile = resolve(value('--input')), out = resolve(value('--out'));
  const document = migrateMountain(readJson<unknown>(inputFile));
  const prepared = prepareRetopologyBenchmark(document, {
    collarRings: numberValue('--collar', 1),
    targetPatchSizeM: numberValue('--target-size', document.spacing),
    tessellationResolution: numberValue('--resolution', 8),
    wholeSurface: args.includes('--whole-surface'),
  });
  mkdirSync(out, { recursive: true });
  const files = benchmarkFiles(out);
  writeFileSync(files.input, writeObj(prepared.input, 'remeshable-source'));
  writeFileSync(files.protected, writeObj(prepared.protected, 'protected-region'));
  writeJson(files.constraints, prepared.constraints);
  if (args.includes('--trail-field')) {
    writeFileSync(join(out, 'trail-field.rosy'), quadWildTrailField(prepared.input, prepared.constraints.interface, {
      globalTrailWeight: numberValue('--trail-weight', 0.08),
      iterations: numberValue('--field-iterations', 400),
    }));
    writeFileSync(join(out, 'boundary.sharp'), quadWildSharp(prepared.input, prepared.constraints.interface));
  }
  console.log(`Prepared ${out}`);
  console.log(`  ${prepared.constraints.remeshQuadIds.length} source patches -> ${prepared.input.faces.length} triangles`);
  console.log(`  ${prepared.constraints.protectedQuadIds.length} protected patches, ${prepared.constraints.interface.length} ${prepared.constraints.options.wholeSurface ? 'internal trail guides' : 'interface curves'}`);
  console.log(`  target ${prepared.constraints.targetFaces} faces at ${prepared.constraints.options.targetPatchSizeM} m`);
  const meanInputEdge = meanFaceEdgeLength(prepared.input);
  console.log(`  mean input triangle edge ${meanInputEdge.toFixed(3)} m; initial QuadWild scale estimate ${(prepared.constraints.options.targetPatchSizeM / meanInputEdge).toFixed(3)}`);
  if (args.includes('--trail-field')) console.log('  wrote trail-field.rosy and boundary.sharp for direct QuadWild tracing');
  prepared.constraints.warnings.forEach(warning => console.warn(`  warning: ${warning}`));
}

function substitutions(directory: string, output: string, constraints: RetopologyConstraints): Record<string, string> {
  return {
    dir: directory,
    input: benchmarkFiles(directory).input,
    output,
    targetFaces: String(constraints.targetFaces),
    targetPatchSize: String(constraints.options.targetPatchSizeM),
  };
}

function substitute(source: string, variables: Record<string, string>): string {
  return source.replace(/\{([A-Za-z]+)\}/g, (_whole, name: string) => {
    if (variables[name] === undefined) throw new Error(`Unknown runner variable {${name}}`);
    return variables[name];
  });
}

function score(directory: string, candidates: { id: string; file: string }[]): void {
  const files = benchmarkFiles(directory), source = readObj(readFileSync(files.input, 'utf8'));
  const constraints = readJson<RetopologyConstraints>(files.constraints);
  if (constraints.version !== 1) throw new Error(`Unsupported retopology constraint version ${String(constraints.version)}`);
  const results = candidates.map(candidate => ({
    id: candidate.id,
    file: resolve(candidate.file),
    score: scoreRetopologyCandidate(source, readObj(readFileSync(candidate.file, 'utf8')), constraints),
  }));
  writeJson(files.report, {
    generatedAt: new Date().toISOString(),
    source: constraints.sourceName,
    options: constraints.options,
    targetFaces: constraints.targetFaces,
    results,
  });
  for (const result of results) {
    const score = result.score;
    console.log(`${result.id}: ${(score.faces.quadPercentage * 100).toFixed(1)}% quads, ${score.poles.total} poles, `
      + `surface max ${score.surfaceDeviation.symmetricMaxM?.toFixed(4) ?? 'n/a'} m, `
      + `boundary p95 ${score.protectedBoundary.referenceToCandidateM.p95?.toFixed(4) ?? 'n/a'} m`);
  }
  console.log(`Wrote ${files.report}`);
}

function run(): void {
  const directory = resolve(value('--dir')), configFile = resolve(value('--config'));
  const constraints = readJson<RetopologyConstraints>(benchmarkFiles(directory).constraints);
  const config = readJson<RunnerFile>(configFile), completed: { id: string; file: string }[] = [];
  if (constraints.version !== 1) throw new Error(`Unsupported retopology constraint version ${String(constraints.version)}`);
  const logs = join(directory, 'logs');
  mkdirSync(logs, { recursive: true });
  for (const runner of config.candidates) {
    if (!runner.id || !runner.commands?.length || !runner.output) throw new Error('Every candidate needs id, commands, and output');
    const initial = substitutions(directory, '', constraints);
    const rawOutput = substitute(runner.output, initial);
    const output = isAbsolute(rawOutput) ? rawOutput : resolve(directory, rawOutput);
    mkdirSync(dirname(output), { recursive: true });
    const variables = substitutions(directory, output, constraints);
    const log: string[] = [];
    console.log(`Running ${runner.id} ...`);
    for (const step of runner.commands) {
      const executable = substitute(step.executable, variables);
      const stepArgs = step.args.map(arg => substitute(arg, variables));
      const cwdValue = step.cwd ? substitute(step.cwd, variables) : directory;
      const cwd = isAbsolute(cwdValue) ? cwdValue : resolve(directory, cwdValue);
      log.push(`> ${JSON.stringify(executable)} ${stepArgs.map(arg => JSON.stringify(arg)).join(' ')}`);
      const result = spawnSync(executable, stepArgs, {
        cwd,
        encoding: 'utf8',
        timeout: runner.timeoutMs ?? 30 * 60_000,
        windowsHide: true,
      });
      log.push(result.stdout ?? '', result.stderr ?? '');
      if (result.error || result.status !== 0) {
        mkdirSync(dirname(join(logs, `${runner.id}.log`)), { recursive: true });
        writeFileSync(join(logs, `${runner.id}.log`), `${log.join('\n')}\n`);
        throw new Error(`${runner.id} failed (${result.error?.message ?? `exit ${result.status}`}); see logs/${runner.id}.log`);
      }
    }
    writeFileSync(join(logs, `${runner.id}.log`), `${log.join('\n')}\n`);
    if (!existsSync(output)) throw new Error(`${runner.id} did not create expected output ${output}`);
    completed.push({ id: runner.id, file: output });
  }
  score(directory, completed);
}

function scoreCommand(): void {
  const directory = resolve(value('--dir'));
  const candidates = allValues('--candidate').map(spec => {
    const at = spec.indexOf('=');
    if (at <= 0 || at === spec.length - 1) throw new Error('--candidate must be name=path.obj');
    const file = spec.slice(at + 1);
    return { id: spec.slice(0, at), file: isAbsolute(file) ? file : resolve(file) };
  });
  if (!candidates.length) throw new Error('At least one --candidate name=path.obj is required');
  score(directory, candidates);
}

try {
  if (command === 'prepare') prepare();
  else if (command === 'run') run();
  else if (command === 'score') scoreCommand();
  else throw new Error('Usage: tools/retopology/benchmark.ts <prepare|run|score> (run without arguments for examples in docs/045-retopology-benchmark.md)');
} catch (error) {
  console.error(`RETOPOLOGY BENCHMARK: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
