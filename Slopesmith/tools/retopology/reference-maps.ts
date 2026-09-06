/** Package scored retopology OBJ candidates as loadable SlopeSmith reference-map folders. */
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { migrateMountain } from '../../src/core/doc/mountain';
import { buildReferenceMesh, type RawPatch } from '../../src/core/reference/terrain';
import type { RetopologyConstraints } from '../../src/core/mesh/retopology/benchmark';
import { readObj } from '../../src/core/mesh/retopology/obj';
import {
  candidateReferencePatches, protectedReferencePatch, type RetopologyReferencePatch,
} from '../../src/core/mesh/retopology/reference-map';

interface PatchFile { Patches: RawPatch[] }
interface BenchmarkResult { id: string; file: string; score: unknown }
interface BenchmarkReport {
  generatedAt: string;
  source: string;
  options: unknown;
  targetFaces: number;
  results: BenchmarkResult[];
}

const args = process.argv.slice(2);
const value = (name: string, fallback?: string): string => {
  const at = args.indexOf(name), found = at >= 0 ? args[at + 1] : undefined;
  if (found !== undefined) return found;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}`);
};
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const writeJson = (file: string, payload: unknown): void =>
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
const mapSuffix = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

function main(): void {
  const sourceFile = resolve(value('--source'));
  const benchmarkDir = resolve(value('--benchmark'));
  const mapsRoot = resolve(value('--maps-root'));
  const sourceDir = dirname(sourceFile);
  const sourcePatchFile = resolve(value('--source-patches', join(sourceDir, 'Patches.json')));
  const reportFile = resolve(value('--report', join(benchmarkDir, 'report.json')));
  const constraintsFile = resolve(value('--constraints', join(benchmarkDir, 'constraints.json')));

  const document = migrateMountain(readJson<unknown>(sourceFile));
  const sourcePatches = readJson<PatchFile>(sourcePatchFile).Patches;
  const constraints = readJson<RetopologyConstraints>(constraintsFile);
  const report = readJson<BenchmarkReport>(reportFile);
  const prefix = value('--prefix', `${document.name}_RETOPO`);
  const requested = value('--only', '').split(',').map(item => item.trim()).filter(Boolean);
  const results = requested.length ? report.results.filter(result => requested.includes(result.id)) : report.results;

  if (sourcePatches.length !== document.quads.length) {
    throw new Error(`Source patch count ${sourcePatches.length} does not match document quad count ${document.quads.length}`);
  }
  if (!results.length) throw new Error('No benchmark candidates selected');

  const quadIndex = new Map(document.quadIds.map((id, index) => [id, index]));
  const protectedPatches: RetopologyReferencePatch[] = constraints.protectedQuadIds.map(id => {
    const index = quadIndex.get(id);
    if (index === undefined) throw new Error(`Protected patch ${id} is absent from the source document`);
    const source = sourcePatches[index];
    if (!source?.Points || source.Points.length !== 16) throw new Error(`Source patch ${id} has no bicubic control net`);
    return protectedReferencePatch(source, `Protected_${id.replace(/[^A-Za-z0-9_-]+/g, '_')}`);
  });

  mkdirSync(mapsRoot, { recursive: true });
  for (const result of results) {
    const candidateFile = resolve(result.file);
    if (!existsSync(candidateFile)) throw new Error(`Candidate OBJ is missing: ${candidateFile}`);
    const candidate = readObj(readFileSync(candidateFile, 'utf8'));
    const candidatePatches = candidateReferencePatches(candidate, mapSuffix(result.id));
    const name = `${prefix}_${mapSuffix(result.id)}`;
    const out = join(mapsRoot, name);

    // This tool owns the named output folder. Rebuilding it avoids stale candidate patches or textures.
    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const patches = [...protectedPatches, ...candidatePatches];
    // Patches are the large payload; keep it compact like a normal SlopeSmith export for faster reference loads.
    writeFileSync(join(out, 'Patches.json'), `${JSON.stringify({ Patches: patches })}\n`);
    copyFileSync(candidateFile, join(out, 'candidate.obj'));
    if (existsSync(join(sourceDir, 'Textures'))) cpSync(join(sourceDir, 'Textures'), join(out, 'Textures'), { recursive: true });
    for (const auxiliary of ['AIP.json', 'SOP.json', 'Lights.json']) {
      const source = join(sourceDir, auxiliary);
      if (existsSync(source)) copyFileSync(source, join(out, auxiliary));
    }
    writeJson(join(out, 'Retopology.json'), {
      kind: 'slopesmith-retopology-reference',
      version: 1,
      name,
      source: { document: basename(sourceFile), map: document.name },
      candidate: { id: result.id, obj: 'candidate.obj', vertices: candidate.vertices.length, faces: candidate.faces.length },
      protectedPatches: protectedPatches.length,
      totalPatches: protectedPatches.length + candidatePatches.length,
      benchmark: {
        generatedAt: report.generatedAt,
        options: report.options,
        targetFaces: report.targetFaces,
        score: result.score,
      },
      notes: [
        'The protected trail/collar uses the source map exact Bezier control points and paint.',
        'Candidate polygons are degree-elevated into planar bicubic patches without smoothing or fitting.',
        'The protected and candidate regions are intentionally not stitched; boundary errors remain visible.',
      ],
    });
    const reference = buildReferenceMesh(patches, undefined, 1);
    if (reference.patchCount !== patches.length
      || [...reference.min, ...reference.max].some(coordinate => !Number.isFinite(coordinate))) {
      throw new Error(`${name} failed SlopeSmith reference-mesh validation`);
    }
    console.log(`${name}: ${protectedPatches.length} protected + ${candidatePatches.length} candidate patches -> ${out}`);
  }
}

main();
