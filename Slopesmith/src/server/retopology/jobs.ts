import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { migrateMountain } from '../../core/doc/mountain';
import type { QuadMeshDoc } from '../../core/doc/types';
import {
  DEFAULT_RETOPOLOGY_OPTIONS,
  type RetopologyCapabilities,
  type RetopologyJobOptions,
  type RetopologyJobResult,
  type RetopologyJobStatus,
  type RetopologyResultSummary,
  type RetopologyStrategyCapability,
} from '../../core/mesh/retopology/job-contract';
import { buildContourCandidate, CONTOUR_RIM_STRIP_CELLS } from '../../core/mesh/retopology/contour';
import type { PolygonMesh } from '../../core/mesh/retopology/obj';
import {
  prepareRetopologyBenchmark, prepareSelectedRetopology, protectedQuadSet, tessellateQuads,
  type RetopologyConstraints,
} from '../../core/mesh/retopology/benchmark';
import { quadWildSharp } from '../../core/mesh/retopology/field';
import {
  buildExactTrailBuffer, conformCandidateOuterBoundary, cutCandidateByLockedFootprint, fitBezierSurfaceHeight,
  generatedProtectedFootprintPenetration, integrateRetopologyCandidate, nudgeCrossingVerticesOffLockedFootprint,
  nudgeLeaningFacesOffLockedFootprint, refineCoarseCandidateInterface, removeCandidateFacesAndRepairBoundary,
  splitCandidateFacesToWedges,
} from '../../core/mesh/retopology/integrate';
import { scoreSurfaceDeviation } from '../../core/mesh/retopology/metrics';
import { readObj, writeObj } from '../../core/mesh/retopology/obj';
import {
  applyVertexMovesToObj, boundaryLoops, formatFixedSubsides, lockedRimLoops, parseCornersFile,
  prescribeNearbyHoleSubsides, prescribeRimSubsides,
} from '../../core/mesh/retopology/prescribe';
import { findTJunctions, normalizeTJunctions } from '../../core/mesh/t-junctions';
import { APP_ROOT, workspaceConfig } from '../workspace-config';

const RETENTION_MS = 30 * 60_000;
const LOG_LIMIT = 2 * 1024 * 1024;
// QuadWild's Organic preparation normalizes every input to roughly 10k triangles, so a fixed scaleFact makes
// a small regional solve produce tiny quads. This is the measured resolution-1 area behind the validated
// MOUNTAIN01_2 25 m / 1.6 calibration; inverse-sqrt area scaling keeps that calibration in physical metres.
const QUADWILD_CALIBRATION_AREA_M2 = 869650.6928037439;

interface NativeConfig {
  root: string;
  prepareExecutable: string;
  quadrangulateExecutable: string;
  prepareConfig: string;
  quadrangulateConfig: string;
}

interface JobRecord {
  status: RetopologyJobStatus;
  source: QuadMeshDoc;
  options: RetopologyJobOptions;
  selectedQuadIds: string[];
  result?: RetopologyJobResult;
  directory?: string;
  directories: string[];
  child?: ChildProcess;
  cancelled: boolean;
  expires?: ReturnType<typeof setTimeout>;
}

/** The internal-guide candidate cannot be repaired locally without changing which topological hole represents
 * the trail. Retry the native solve with the locked feature as a real boundary instead of deleting more faces. */
class BoundaryConstrainedRetry extends Error {}

const nativeConfig = (): NativeConfig => {
  const durableRoot = join(APP_ROOT, '..', 'quadwild-bimdf');
  const legacyRoot = join(APP_ROOT, '..', 'temp', 'retopo', 'quadwild-bimdf');
  // Native dependencies should survive ordinary temp cleanup. Preserve the former temp/ lookup only for
  // existing developer checkouts; a fresh setup and a missing-install diagnostic both point at repo root.
  const root = resolve(process.env.SLOPESMITH_QUADWILD_ROOT?.trim()
    || (existsSync(durableRoot) || !existsSync(legacyRoot) ? durableRoot : legacyRoot));
  const releaseBin = join(root, 'build-release', 'Build', 'bin', 'Release');
  const configuredBin = process.env.SLOPESMITH_QUADWILD_BIN?.trim();
  const bin = configuredBin ? resolve(configuredBin) : releaseBin;
  return {
    root,
    prepareExecutable: join(bin, process.platform === 'win32' ? 'quadwild.exe' : 'quadwild'),
    quadrangulateExecutable: join(bin, process.platform === 'win32' ? 'quad_from_patches.exe' : 'quad_from_patches'),
    prepareConfig: join(root, 'config', 'prep_config', 'basic_setup_Organic.txt'),
    quadrangulateConfig: join(root, 'config', 'main_config', 'flow_noalign_lemon.txt'),
  };
};

function unavailableReason(config = nativeConfig()): string | undefined {
  const missing = [config.prepareExecutable, config.quadrangulateExecutable,
    config.prepareConfig, config.quadrangulateConfig].filter(file => !existsSync(file));
  return missing.length ? `QuadWild is not installed on this server (${missing[0]} is missing).` : undefined;
}

const concurrency = (): number => {
  const parsed = Number(process.env.SLOPESMITH_RETOPOLOGY_CONCURRENCY ?? 1);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(4, parsed)) : 1;
};

export function retopologyCapabilities(): RetopologyCapabilities {
  const reason = unavailableReason();
  const strategies: RetopologyStrategyCapability[] = [
    { id: 'quadwild', available: !reason, ...(reason ? { reason } : {}), scopes: ['whole-unlocked', 'selected-region'] },
    // the contour-flow sweep is pure TypeScript and needs no native install; it rebuilds around the
    // whole mountain's locks only
    { id: 'contour-flow', available: true, scopes: ['whole-unlocked'] },
  ];
  return {
    available: strategies.some(strategy => strategy.available),
    ...(reason ? { reason } : {}),
    scopes: ['whole-unlocked', 'selected-region'],
    strategies,
    defaults: { ...DEFAULT_RETOPOLOGY_OPTIONS },
    engine: 'quadwild-bimdf',
    concurrency: concurrency(),
  };
}

function normalizeOptions(input: Partial<RetopologyJobOptions> = {}): RetopologyJobOptions {
  if (input.scope !== undefined && input.scope !== 'whole-unlocked' && input.scope !== 'selected-region') {
    throw new Error('Unknown retopology scope');
  }
  if (input.strategy !== undefined && input.strategy !== 'quadwild' && input.strategy !== 'contour-flow') {
    throw new Error('Unknown retopology strategy');
  }
  const finite = (value: unknown, fallback: number, low: number, high: number): number => {
    const parsed = typeof value === 'number' ? value : fallback;
    return Number.isFinite(parsed) ? Math.max(low, Math.min(high, parsed)) : fallback;
  };
  return {
    scope: input.scope ?? DEFAULT_RETOPOLOGY_OPTIONS.scope,
    strategy: input.strategy ?? DEFAULT_RETOPOLOGY_OPTIONS.strategy,
    influenceRings: Math.floor(finite(input.influenceRings, DEFAULT_RETOPOLOGY_OPTIONS.influenceRings, 0, 5)),
    targetPatchSizeM: finite(input.targetPatchSizeM, DEFAULT_RETOPOLOGY_OPTIONS.targetPatchSizeM, 2, 100),
    quadWildScale: finite(input.quadWildScale, DEFAULT_RETOPOLOGY_OPTIONS.quadWildScale, .25, 8),
    maximumSurfaceDeviationM: finite(input.maximumSurfaceDeviationM,
      DEFAULT_RETOPOLOGY_OPTIONS.maximumSurfaceDeviationM, .1, 500),
    qualityResolution: Math.floor(finite(input.qualityResolution, DEFAULT_RETOPOLOGY_OPTIONS.qualityResolution, 2, 8)),
    preserveSurfacePaint: input.preserveSurfacePaint !== false,
  };
}

function lockedRegionCount(source: QuadMeshDoc): number {
  const locked = protectedQuadSet(source, 0), remaining = new Set(locked);
  if (!remaining.size) return 0;
  const edgeQuads = new Map<string, number[]>();
  const key = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;
  for (const quad of locked) {
    const [A, B, C, D] = source.quads[quad];
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
      const found = edgeQuads.get(key(a, b));
      if (found) found.push(quad); else edgeQuads.set(key(a, b), [quad]);
    }
  }
  const neighbors = new Map<number, Set<number>>();
  for (const quads of edgeQuads.values()) if (quads.length > 1) for (const quad of quads) {
    const set = neighbors.get(quad) ?? new Set<number>();
    for (const other of quads) if (other !== quad) set.add(other);
    neighbors.set(quad, set);
  }
  let regions = 0;
  while (remaining.size) {
    regions++;
    const queue = [remaining.values().next().value as number];
    remaining.delete(queue[0]);
    while (queue.length) for (const neighbor of neighbors.get(queue.pop()!) ?? []) {
      if (remaining.delete(neighbor)) queue.push(neighbor);
    }
  }
  return regions;
}

function appendLog(current: string, chunk: unknown): string {
  const next = current + String(chunk ?? '');
  return next.length <= LOG_LIMIT ? next : next.slice(next.length - LOG_LIMIT);
}

async function runNative(job: JobRecord, executable: string, args: string[], cwd: string): Promise<string> {
  if (job.cancelled) throw new Error('Retopology cancelled');
  return await new Promise((resolveRun, reject) => {
    let output = '';
    const child = spawn(executable, args, { cwd, windowsHide: true });
    job.child = child;
    child.stdout?.on('data', chunk => { output = appendLog(output, chunk); });
    child.stderr?.on('data', chunk => { output = appendLog(output, chunk); });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (job.child === child) job.child = undefined;
      if (job.cancelled) reject(new Error('Retopology cancelled'));
      else if (code === 0) resolveRun(output);
      else reject(new Error(`${executable.split(/[\\/]/).at(-1)} failed (${signal ?? `exit ${code}`})${output.trim() ? `: ${output.trim().slice(-1200)}` : ''}`));
    });
  });
}

function update(job: JobRecord, phase: RetopologyJobStatus['phase'], progress: number, detail: string): void {
  job.status = { ...job.status, phase, progress, detail };
}

async function executeAttempt(
  job: JobRecord,
  forceBoundaryConstraint = false,
  retryReason?: string,
): Promise<RetopologyJobResult> {
  const contour = job.options.strategy === 'contour-flow';
  const config = nativeConfig(), unavailable = unavailableReason(config);
  if (unavailable && !contour) throw new Error(unavailable);
  if (contour && job.options.scope !== 'whole-unlocked') {
    throw new Error('The contour-flow strategy rebuilds the whole unlocked mountain; use QuadWild for a selected region');
  }
  const regions = lockedRegionCount(job.source);
  if (job.options.scope === 'whole-unlocked' && !regions) {
    throw new Error('Lock the trail or other terrain feature before whole-mountain retopology');
  }

  update(job, 'preparing', 5, forceBoundaryConstraint
    ? `Retrying with the locked feature as a native boundary${retryReason ? `: ${retryReason}` : ''}`
    : job.options.scope === 'selected-region'
    ? 'Building the selected-region topology proxy'
    : `Building the whole-mountain proxy around ${regions} locked region${regions === 1 ? '' : 's'}`);
  const preparation = {
    collarRings: 0,
    targetPatchSizeM: job.options.targetPatchSizeM,
    tessellationResolution: 1,
  };
  // A second whole-mountain pass already contains dependent seam T-nodes. Feeding that sheet through the
  // original internal-guide/post-cut path lets QuadWild bridge the parallel banks before the cut. Give repeat
  // jobs the locked trail as a true hole boundary; first-time jobs keep the validated global internal guide.
  // SLOPESMITH_RETOPOLOGY_HOLE_MODE=always is the docs/ideas/042 rollout: with prescribed seam subdivisions
  // the hole solve is conforming by construction, so first solves can use it too. The contour-flow sweep
  // builds its hole rims on the authored corners directly, so it is a hole-mode conforming solve always.
  const boundaryConstrainedRepeat = job.options.scope === 'whole-unlocked'
    && (contour
      || forceBoundaryConstraint
      || process.env.SLOPESMITH_RETOPOLOGY_HOLE_MODE === 'always'
      || (job.source.tJunctions?.length ?? 0) > 0);
  const prepared = job.options.scope === 'selected-region'
    ? prepareSelectedRetopology(job.source, job.selectedQuadIds, job.options.influenceRings, preparation)
    : prepareRetopologyBenchmark(job.source, { ...preparation, wholeSurface: !boundaryConstrainedRepeat });
  const workRoot = join(workspaceConfig().workspaceRoot, 'cache', 'retopology');
  await mkdir(workRoot, { recursive: true });
  const directory = await mkdtemp(join(workRoot, 'job-'));
  job.directory = directory;
  job.directories.push(directory);

  let candidate: PolygonMesh;
  let prescribedSeams = false;
  if (contour) {
    update(job, 'quadrangulating', 30, 'Sweeping graded elevation loops into quads');
    // the sweep samples heights from a finer tessellation than the resolution-1 topology proxy, so its
    // graded contours see the bicubic surface rather than the control cage's facets
    const remeshIds = new Set(prepared.constraints.remeshQuadIds);
    const remeshIndices = new Set(job.source.quadIds
      .map((id, index) => (remeshIds.has(id) ? index : -1)).filter(index => index >= 0));
    const generated = buildContourCandidate({
      surface: tessellateQuads(job.source, remeshIndices, 2),
      boundaryProxy: prepared.input,
      interfaceCurves: prepared.constraints.interface,
      targetPatchSizeM: job.options.targetPatchSizeM,
    });
    await writeFile(join(directory, 'contour-notes.log'), `${generated.notes.join('\n')}\n`);
    await writeFile(join(directory, 'contour-candidate.obj'), writeObj(generated.mesh, 'slopesmith-contour-candidate'));
    candidate = generated.mesh;
    // every locked rim carries exactly one candidate vertex per authored corner, on the corner
    prescribedSeams = true;
    update(job, 'quadrangulating', 60, `Swept ${generated.stats.sweptQuads + generated.stats.ringQuads} quads `
      + `over ${generated.stats.levels} graded levels (${generated.stats.caps + generated.stats.pits} caps, `
      + `${generated.stats.saddles} saddles)`);
  } else {
  const input = join(directory, 'input.obj');
  await writeFile(input, writeObj(prepared.input, 'slopesmith-retopology-proxy'));
  // This contains the true mountain rim plus both sides of every internal locked-trail edge. QuadWild only
  // preserves it through remeshing when it is passed explicitly; a same-basename file is not auto-discovered.
  const sharp = join(directory, 'input.sharp');
  await writeFile(sharp, quadWildSharp(prepared.input, prepared.constraints.interface));

  update(job, 'quadwild-prep', 15, 'Tracing the protected feature through the triangle proxy');
  const prepLog = await runNative(job, config.prepareExecutable,
    [input, '2', sharp, config.prepareConfig], config.root);
  await writeFile(join(directory, 'quadwild-prep.log'), prepLog);
  const remeshed = join(directory, 'input_rem_p0.obj');
  if (!existsSync(remeshed)) throw new Error('QuadWild preparation did not produce input_rem_p0.obj');

  // A hole-mode solve can be conforming by construction: pin the subdivision count around every
  // locked rim to exactly one candidate edge per protected corner (docs/ideas/042). The patched
  // quad_from_patches honors the sidecar; failing to build one only means the join machinery has
  // to work with whatever counts the free solve picks, so prescription failures never fail the job.
  if (boundaryConstrainedRepeat) {
    // A locked-feature neck narrower than the remesh edge length makes QuadWild tear an extra
    // sliver hole in the surface, which surfaces much later as an inexplicable seam failure.
    // Diagnose it here instead.
    const remeshDoc = readObj(await readFile(remeshed, 'utf8'));
    const proxyRims = boundaryLoops(prepared.input).length;
    const remeshRims = boundaryLoops(remeshDoc).length;
    if (remeshRims !== proxyRims) {
      throw new Error(`QuadWild's remesh tore the proxy surface (${remeshRims} boundary loops for the proxy's `
        + `${proxyRims}); a strip of mountain between locked-feature rims is probably narrower than the `
        + 'remesh edge length');
    }
    if (process.env.SLOPESMITH_RETOPOLOGY_PRESCRIBE !== 'off') {
    let note: string;
    try {
      const authoredRims = lockedRimLoops(prepared.input, prepared.constraints.interface);
      if (authoredRims.length) {
        const remeshCorners = parseCornersFile(await readFile(join(directory, 'input_rem_p0.corners'), 'utf8'));
        const prescription = prescribeRimSubsides(remeshDoc, remeshCorners, authoredRims);
        if (prescription.movedVertices.size) {
          // corner conforming re-seats layout corners onto their paired authored corners; the
          // split fractions in the sidecar measure this rewritten rim
          await writeFile(remeshed,
            applyVertexMovesToObj(await readFile(remeshed, 'utf8'), prescription.movedVertices));
        }
        const records = [...prescription.records];
        let holeNote = '';
        if (process.env.SLOPESMITH_RETOPOLOGY_DIRECT_JOIN !== '0') {
          // a direct join needs nearby hole rims kept at remesh resolution: freely quantized,
          // a small hole collapses to a few target-size edges whose ring quads reach across
          // the locked outline, beyond what the leaning nudge can absorb
          const nearbyHoles = prescribeNearbyHoleSubsides(remeshDoc, remeshCorners,
            prepared.constraints.interface,
            new Set(records.flatMap(record => [record.v0, record.v1])),
            2 * job.options.targetPatchSizeM);
          if (nearbyHoles.holes) {
            records.push(...nearbyHoles.records);
            holeNote = `; ${nearbyHoles.holes} nearby unlocked holes pinned at remesh resolution`;
          }
        }
        await writeFile(join(directory, 'input_rem_p0.fixed'), formatFixedSubsides(records));
        prescribedSeams = true;
        note = `Prescribed seam positions: ${prescription.loops
          .map(loop => `${loop.authoredEdges} over ${loop.arcs} arcs (worst projection `
            + `${loop.worstProjectionM.toFixed(2)} m, ${loop.movedCorners} corners conformed up to `
            + `${loop.worstCornerMoveM.toFixed(2)} m, residual ${loop.worstResidualM.toFixed(2)} m)`)
          .join(', ')}${holeNote}`;
      } else {
        note = 'Seam prescription skipped: no locked rim among the proxy boundary loops';
      }
    } catch (error) {
      note = `Seam prescription skipped: ${(error as Error).message}`;
    }
    await writeFile(join(directory, 'prescription.log'), `${note}\n`);
    }
  }

  const template = await readFile(config.quadrangulateConfig, 'utf8');
  if (!/^scaleFact\s+.+$/m.test(template)) throw new Error('QuadWild configuration has no scaleFact setting');
  const quadrangulateConfig = join(directory, 'flow_noalign_slopesmith.txt');
  // 1.6 is the calibrated 25 m whole-mountain solve. Normalize by physical solve area because QuadWild first
  // remeshes both a whole mountain and a small selected region to approximately the same triangle count.
  // A regional solve also has to honor a comparatively dense exact outer boundary. Past scale 5 the coarse
  // interior strips can fold while snapping back to that boundary, so regional density is conservatively capped.
  const maximumNativeScale = job.options.scope === 'selected-region' ? 5 : 32;
  const nativeScale = Math.max(.25, Math.min(maximumNativeScale,
    job.options.quadWildScale
      * job.options.targetPatchSizeM / DEFAULT_RETOPOLOGY_OPTIONS.targetPatchSizeM
      * Math.sqrt(QUADWILD_CALIBRATION_AREA_M2 / Math.max(1, prepared.constraints.sourceAreaM2))));
  await writeFile(quadrangulateConfig, template.replace(/^scaleFact\s+.+$/m, `scaleFact ${nativeScale}`));
  const tag = Math.round(nativeScale * 100) + 1;
  update(job, 'quadrangulating', 45, `Generating approximately ${job.options.targetPatchSizeM.toFixed(1)} m quads`);
  const quadLog = await runNative(job, config.quadrangulateExecutable,
    [remeshed, String(tag), quadrangulateConfig], config.root);
  await writeFile(join(directory, 'quadwild-quadrangulate.log'), quadLog);
  const smoothCandidate = join(directory, `input_rem_p0_${tag}_quadrangulation_smooth.obj`);
  const rawCandidate = join(directory, `input_rem_p0_${tag}_quadrangulation.obj`);
  const candidateFile = existsSync(smoothCandidate) ? smoothCandidate : rawCandidate;
  if (!existsSync(candidateFile)) throw new Error('QuadWild did not produce the expected quadrangulation');
  candidate = readObj(await readFile(candidateFile, 'utf8'));
  }

  update(job, 'integrating', 78, 'Reinserting exact locked patches and restoring the bicubic surface');
  let integrationSource = job.source;
  let bufferedRepeat = false;
  const persistentProtectedPatches = protectedQuadSet(job.source, 0).size;
  let constraints: RetopologyConstraints;
  // 042 direct join: prescribed subdivision counts and boundary positions make the locked rim
  // conforming by construction, so the exact patches join without a collar or T-nodes. It
  // requires the prescribed rim to reach integration intact: leaning first-row faces are nudged
  // clear of the locked outline rather than cut away, and geometry whose faces cannot clear (an
  // unlocked hole grazing or sharing the outline) keeps the collar path, which rebuilds the seam
  // zone around such slivers.
  let directJoin = prescribedSeams && process.env.SLOPESMITH_RETOPOLOGY_DIRECT_JOIN !== '0';
  if (job.options.scope === 'whole-unlocked') {
    // A direct conforming join must keep the rim's exact vertex count, and a hole-mode candidate
    // already carries the locked feature as a real boundary hole — so there is nothing legitimate
    // for the footprint cut to remove. Every footprint overlap is a first-row face leaning over
    // the outline: nudge those clear instead of cutting, and fall back to the transition collar
    // when one cannot clear (an unlocked hole grazing or sharing the locked outline). The contour
    // candidate's rim vertices sit exactly on the authored corners, so its chord-vs-curve slivers go
    // straight to the bounded seam-repair loop instead of through the escalating nudge.
    if (directJoin && !contour) {
      const leaning = nudgeLeaningFacesOffLockedFootprint(job.source, candidate);
      if (leaning.resolved) {
        if (leaning.nudgedVertices) {
          candidate = leaning.mesh;
          update(job, 'integrating', 78, `Nudged ${leaning.nudgedVertices} first-row vertex/vertices `
            + `clear of the locked outline (maximum ${leaning.maximumNudgeM.toFixed(2)} m)`);
        }
      } else if (process.env.SLOPESMITH_RETOPOLOGY_DIRECT_JOIN === 'keep') {
        // Keep the direct join on the UNNUDGED candidate and leave the crossings to the seam-repair loop
        // below, which moves only the vertices that actually cross and bounds how far it moves them.
        //
        // The pre-emptive nudge answers to a positive-area screen, which is deliberately stricter than the
        // gate that decides whether a join is sound. Two piecewise-linear samplings of the same rim curve
        // always interleave in hairline slivers, and a mountain carrying several locked features has enough
        // rim corners that some sliver survives every escalation. Past that point the escalation is not
        // repairing anything: on a production eight-trail fixture it moved first-row vertices up to 120 m and left
        // MORE leaning faces than it started with (15 -> 20), while the un-nudged candidate integrated
        // 702-to-702 with no T-junctions, no inverted patches and four crossings for the repair loop.
        //
        // It is opt-in because the collar fallback is the safe answer for a map where the rim really is
        // grazed, and only a caller that knows its locked features stand clear of one another should ask
        // for this instead.
        update(job, 'integrating', 78, `${leaning.passes} nudge pass(es) left first-row slivers on the `
          + 'locked outline; joining directly anyway and leaving them to seam repair');
      } else {
        directJoin = false;
        update(job, 'integrating', 78, 'A first-row face cannot clear the locked outline; '
          + 'keeping the transition-collar join for this solve');
      }
    }
    if (!directJoin) {
      candidate = cutCandidateByLockedFootprint(job.source, candidate,
        boundaryConstrainedRepeat ? Math.max(4, job.options.qualityResolution) : 1, 0).mesh;
    }
    if (boundaryConstrainedRepeat) constraints = prepared.constraints;
    else {
      const lockedIds = new Set(prepared.constraints.lockedQuadIds);
      constraints = {
        ...prepared.constraints,
        protectedQuadIds: [...prepared.constraints.lockedQuadIds],
        remeshQuadIds: job.source.quadIds.filter(id => !lockedIds.has(id)),
      };
    }
  } else constraints = prepared.constraints;
  constraints = {
    ...constraints,
    options: {
      ...constraints.options,
      wholeSurface: false,
      collarRings: 0,
      regularizeCandidate: false,
      refineBoundaryCorners: false,
      // A plural interface commonly has surplus candidate vertices. Ordered chord-length parameters keep
      // those vertices distributed along the cubic instead of independently collapsing several onto a corner.
      arcLengthInterfaceParameters: true,
    },
  };
  let seamRepairPasses = 0, seamRepairFaces = 0;
  const seamRepairHistory: string[] = [];
  let refinement: ReturnType<typeof refineCoarseCandidateInterface> | undefined;
  let integrated: ReturnType<typeof integrateRetopologyCandidate>;
  if (boundaryConstrainedRepeat && directJoin) {
    // 042 direct join: every locked rim quantized to exactly one candidate edge per protected
    // corner, so the exact patches join conformally without the transition collar. bufferedRepeat
    // stays false: the strict footprint and deviation gates apply, and the ordinary seam-repair
    // loop below handles residual crossings.
    const rim = conformCandidateOuterBoundary(job.source, candidate);
    candidate = rim.mesh;
    update(job, 'integrating', 79,
      `Re-seated ${rim.movedVertices} outer-rim vertices (maximum ${rim.maximumMoveM.toFixed(2)} m); ` +
      'joining exact locked patches directly across the prescribed seams');
    // No boundary refinement: the conforming rim maps one-to-one onto the protected corners.
    // Alignment options match the collar path's: a hole-rim vertex legitimately sits ON the locked
    // boundary, where the protected-side enforcement penalty misfires.
    integrated = integrateRetopologyCandidate(job.source, candidate, constraints,
      job.source.name, undefined, {
        preserveSurfacePaint: job.options.preserveSurfacePaint,
        topologyAwareAlignment: false,
        enforceProtectedSide: false,
        collapseFlatInterfaceFaces: true,
        conformingSeams: true,
      });
  } else if (boundaryConstrainedRepeat) {
    const rim = conformCandidateOuterBoundary(job.source, candidate);
    candidate = rim.mesh;
    update(job, 'integrating', 79,
      `Re-seated ${rim.movedVertices} outer-rim vertices (maximum ${rim.maximumMoveM.toFixed(2)} m)`);
    const trailConstraints = constraints;
    bufferedRepeat = true;
    let collarMinimumWidthM = job.options.targetPatchSizeM * .5;
    let previousDeletionCrossings = Infinity;
    for (;;) {
      const boundaryRefinement = refineCoarseCandidateInterface(job.source, candidate, trailConstraints) ?? undefined;
      if (boundaryRefinement) candidate = boundaryRefinement.mesh;
      const buffer = buildExactTrailBuffer(job.source, candidate, trailConstraints, boundaryRefinement,
        collarMinimumWidthM);
      integrationSource = buffer.source; constraints = buffer.constraints;
      refinement = buffer.refinement;
      update(job, 'integrating', 80,
        `Built ${buffer.collarPatches} exact transition patches; adjusted ${buffer.adjustedOuterVertices} outer corners`);
      integrated = integrateRetopologyCandidate(integrationSource, candidate, constraints,
        job.source.name, refinement, {
          preserveSurfacePaint: job.options.preserveSurfacePaint,
          topologyAwareAlignment: false,
          enforceProtectedSide: false,
          collapseFlatInterfaceFaces: true,
        });
      const crossing = integrated.report.crossingInterfaceFaces;
      if (!crossing.length || seamRepairPasses >= 6) break;
      seamRepairPasses++;
      // Around a tight feature the minimum-width push fans the collar chords across the candidate's first
      // rows. Narrow the collar first: a thin transition patch is valid geometry, a crossed one is rejected.
      if (collarMinimumWidthM > job.options.targetPatchSizeM * .13) {
        collarMinimumWidthM *= .5;
        seamRepairHistory.push(`collar-width:${collarMinimumWidthM.toFixed(1)}`);
        update(job, 'integrating', 81,
          `Rebuilding ${crossing.length} crossed transition chord(s) with a ${collarMinimumWidthM.toFixed(1)} m collar`);
        continue;
      }
      // Only then remove crossed faces so the rebuilt collar follows the enlarged hole. Deletion must make
      // strict progress: enlarging the hole can also create fresh crossings, and that spiral ends with the
      // feature hole merging into the mountain rim.
      if (crossing.length >= previousDeletionCrossings) break;
      previousDeletionCrossings = crossing.length;
      seamRepairHistory.push(`collar-crossing:${crossing.length}`);
      try {
        const repaired = removeCandidateFacesAndRepairBoundary(candidate, new Set(crossing));
        candidate = repaired.mesh; seamRepairFaces += repaired.removedFaces;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (repair history: ${seamRepairHistory.join(' -> ')})`, { cause: error });
      }
      update(job, 'integrating', 81,
        `Removed ${seamRepairFaces} candidate face(s) crossing the transition collar`);
    }
  } else {
    // A whole-mountain free solve can present a rim too coarse for the protected corners. The
    // boundary-constrained retry prescribes exactly one candidate edge per corner, so that solve IS the
    // denser solve this error class asks for.
    try {
      refinement = refineCoarseCandidateInterface(integrationSource, candidate, constraints) ?? undefined;
      if (refinement) candidate = refinement.mesh;
      integrated = integrateRetopologyCandidate(integrationSource, candidate, constraints,
        job.source.name, refinement, {
          preserveSurfacePaint: job.options.preserveSurfacePaint,
          topologyAwareAlignment: job.options.scope === 'whole-unlocked',
          enforceProtectedSide: true,
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.options.scope === 'whole-unlocked' && !boundaryConstrainedRepeat
        && message.startsWith('Candidate interface has')) {
        throw new BoundaryConstrainedRetry(message);
      }
      throw error;
    }
  }
  if (integrated.report.collapsedInterfaceFaces.length) {
    update(job, 'integrating', 82,
      `Collapsed ${integrated.report.collapsedInterfaceFaces.length} redundant interface knot(s)`);
  }
  const repairableSeamFaces = () => ({
    crossing: new Set([
      ...integrated.report.crossingInterfaceFaces,
      ...(bufferedRepeat ? [] : integrated.report.overlappingProtectedFaces),
    ]),
    wedges: new Map(integrated.report.interfaceWedgeSplits.map(split => [split.face, split.diagonal] as const)),
  });
  let seamProblems = repairableSeamFaces();
  while (!bufferedRepeat && job.options.scope === 'whole-unlocked'
    && (seamProblems.crossing.size || seamProblems.wedges.size)
    && seamRepairPasses < 8) {
    if (seamProblems.crossing.size && directJoin) {
      // A conforming join can never delete a first-row face — that changes the rim's boundary topology.
      // Slide the offending interior vertices off the locked footprint instead, escalating clearance
      // each pass; the surface-height fit re-seats them on the terrain afterwards.
      const marginM = Math.min(job.options.targetPatchSizeM * .5, .5 * 2 ** seamRepairPasses);
      const nudged = nudgeCrossingVerticesOffLockedFootprint(job.source, candidate,
        seamProblems.crossing, marginM);
      seamRepairHistory.push(`nudge:${seamProblems.crossing.size}`
        + (nudged.unresolvedVertices ? `(${nudged.unresolvedVertices} unresolved)` : ''));
      if (!nudged.nudgedVertices) break;
      candidate = nudged.mesh; seamRepairFaces += nudged.nudgedVertices;
      update(job, 'integrating', 83, `Nudged ${nudged.nudgedVertices} interior vertex/vertices off the `
        + `locked footprint (maximum ${nudged.maximumNudgeM.toFixed(2)} m)`);
    } else if (seamProblems.crossing.size) {
      seamRepairHistory.push(`crossing:${seamProblems.crossing.size}`);
      try {
        const repaired = removeCandidateFacesAndRepairBoundary(candidate, seamProblems.crossing);
        candidate = repaired.mesh; seamRepairFaces += repaired.removedFaces;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = `${message} (repair history: ${seamRepairHistory.join(' -> ')})`;
        if (!boundaryConstrainedRepeat && message.startsWith('Local seam repair changed candidate boundary loop count')) {
          throw new BoundaryConstrainedRetry(detail);
        }
        throw new Error(detail, { cause: error });
      }
    } else {
      seamRepairHistory.push(`wedge:${seamProblems.wedges.size}`);
      candidate = splitCandidateFacesToWedges(candidate, seamProblems.wedges);
      seamRepairFaces += seamProblems.wedges.size;
    }
    seamRepairPasses++;
    if (directJoin) {
      // Options mirror the conforming first integration above: the prescribed rim maps one-to-one onto
      // the protected corners, so no boundary refinement and no protected-side enforcement.
      integrated = integrateRetopologyCandidate(integrationSource, candidate, constraints,
        job.source.name, undefined, {
          preserveSurfacePaint: job.options.preserveSurfacePaint,
          topologyAwareAlignment: false,
          enforceProtectedSide: false,
          collapseFlatInterfaceFaces: true,
          conformingSeams: true,
        });
    } else {
      refinement = refineCoarseCandidateInterface(integrationSource, candidate, constraints) ?? undefined;
      if (refinement) candidate = refinement.mesh;
      integrated = integrateRetopologyCandidate(integrationSource, candidate, constraints,
        job.source.name, refinement, {
          preserveSurfacePaint: job.options.preserveSurfacePaint,
          topologyAwareAlignment: true,
          enforceProtectedSide: true,
        });
    }
    seamProblems = repairableSeamFaces();
  }
  if (seamRepairPasses) update(job, 'integrating', 84,
    `Repaired ${seamRepairFaces} local QuadWild seam face(s) in ${seamRepairPasses} pass(es)`);
  if (!boundaryConstrainedRepeat && integrated.report.crossingInterfaceEdges) throw new BoundaryConstrainedRetry(
    `${integrated.report.crossingInterfaceEdges} mountain edge(s) still cross the locked feature after ${seamRepairPasses} local repair pass(es)`,
  );
  const fit = fitBezierSurfaceHeight(job.source, integrated.document,
    bufferedRepeat ? persistentProtectedPatches : integrated.report.protectedPatches,
    job.options.qualityResolution,
    bufferedRepeat ? { maximumSampleCorrectionM: (job.source.spacing || job.options.targetPatchSizeM) * 2 } : {});
  integrated = { ...integrated, document: fit.document };
  if (contour) {
    // Integration's fold relaxation moves interior vertices without knowing where the locked features
    // stand, and the contour candidate's first row is a narrow strip — a one-metre dip crosses the
    // outline. Push every generated vertex back out past a small margin, judged against the locked
    // patches' exact chordal rims, before the footprint gate measures.
    const document = integrated.document;
    const locked = protectedQuadSet(document, 0);
    const lockedVertices = new Set<number>();
    const edgeQuadCount = new Map<string, number>();
    const undirected = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
    for (const quad of locked) {
      const [A, B, C, D] = document.quads[quad];
      for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as const) {
        lockedVertices.add(a);
        lockedVertices.add(b);
        edgeQuadCount.set(undirected(a, b), (edgeQuadCount.get(undirected(a, b)) ?? 0) + 1);
      }
    }
    // chain the locked set's boundary edges into rim polygons
    const rimNeighbors = new Map<number, number[]>();
    for (const [key, count] of edgeQuadCount) {
      if (count !== 1) continue;
      const [a, b] = key.split(',').map(Number);
      (rimNeighbors.get(a) ?? rimNeighbors.set(a, []).get(a)!).push(b);
      (rimNeighbors.get(b) ?? rimNeighbors.set(b, []).get(b)!).push(a);
    }
    const polygons: { xs: number[]; zs: number[]; ids: number[] }[] = [];
    const visited = new Set<number>();
    for (const start of rimNeighbors.keys()) {
      if (visited.has(start) || (rimNeighbors.get(start)?.length ?? 0) !== 2) continue;
      const xs: number[] = [], zs: number[] = [], ids: number[] = [];
      let previous = -1, at = start;
      for (let guard = 0; guard <= rimNeighbors.size; guard++) {
        xs.push(document.vertices[at * 3]);
        zs.push(document.vertices[at * 3 + 2]);
        ids.push(at);
        visited.add(at);
        const [n1, n2] = rimNeighbors.get(at)!;
        const next = n1 === previous ? n2 : n1;
        previous = at;
        at = next;
        if (at === start) break;
      }
      if (xs.length >= 3) polygons.push({ xs, zs, ids });
    }
    // Re-impose the strip: every rim vertex has exactly one generated neighbour — its intermediate-ring
    // partner — and its intended place is the rim vertex's mirror offset. Integration's relax drags ring
    // vertices (a corner's diagonal partner slides around the bend, wrapping the strip over the feature);
    // restoring the constructed offsets makes the first row rigid again before anything measures it.
    const generatedNeighbour = new Map<number, number>();
    for (let quad = 0; quad < document.quads.length; quad++) {
      if (locked.has(quad)) continue;
      const [A, B, C, D] = document.quads[quad];
      for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as const) {
        if (lockedVertices.has(a) && !lockedVertices.has(b)) generatedNeighbour.set(a, b);
        if (lockedVertices.has(b) && !lockedVertices.has(a)) generatedNeighbour.set(b, a);
      }
    }
    const stripOffsetM = job.options.targetPatchSizeM * CONTOUR_RIM_STRIP_CELLS;
    let restored = 0;
    for (const polygon of polygons) {
      const n = polygon.ids.length;
      for (let i = 0; i < n; i++) {
        const ring = generatedNeighbour.get(polygon.ids[i]);
        if (ring === undefined) continue;
        const px = polygon.xs[i], pz = polygon.zs[i];
        const tx = polygon.xs[(i + 1) % n] - polygon.xs[(i - 1 + n) % n];
        const tz = polygon.zs[(i + 1) % n] - polygon.zs[(i - 1 + n) % n];
        const length = Math.hypot(tx, tz) || 1;
        const candidates: [number, number][] = [
          [px - (tz / length) * stripOffsetM, pz + (tx / length) * stripOffsetM],
          [px + (tz / length) * stripOffsetM, pz - (tx / length) * stripOffsetM],
        ];
        const rx = document.vertices[ring * 3], rz = document.vertices[ring * 3 + 2];
        const pick = Math.hypot(candidates[0][0] - rx, candidates[0][1] - rz)
          <= Math.hypot(candidates[1][0] - rx, candidates[1][1] - rz) ? candidates[0] : candidates[1];
        if (Math.hypot(pick[0] - rx, pick[1] - rz) > 0.01) {
          document.vertices[ring * 3] = pick[0];
          document.vertices[ring * 3 + 2] = pick[1];
          restored++;
        }
      }
    }
    if (restored) update(job, 'validating', 89, `Re-seated ${restored} first-ring vertices on the strip offsets`);
    const marginM = job.options.targetPatchSizeM * 0.06;
    const clearPoint = (x: number, z: number): { inside: boolean; d: number; x: number; z: number } | null => {
      for (const polygon of polygons) {
        const n = polygon.xs.length;
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          if ((polygon.zs[i] > z) !== (polygon.zs[j] > z)
            && x < polygon.xs[i] + ((polygon.xs[j] - polygon.xs[i]) * (z - polygon.zs[i]))
              / (polygon.zs[j] - polygon.zs[i])) inside = !inside;
        }
        let bestD = Infinity, bestX = 0, bestZ = 0;
        for (let i = 0; i < n; i++) {
          const ax = polygon.xs[i], az = polygon.zs[i];
          const bx = polygon.xs[(i + 1) % n], bz = polygon.zs[(i + 1) % n];
          const abx = bx - ax, abz = bz - az;
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / len2)) : 0;
          const qx = ax + t * abx, qz = az + t * abz;
          const d = Math.hypot(x - qx, z - qz);
          if (d < bestD) { bestD = d; bestX = qx; bestZ = qz; }
        }
        if (inside || bestD < marginM) return { inside, d: bestD, x: bestX, z: bestZ };
      }
      return null;
    };
    const pushVertex = (vertex: number, from: { inside: boolean; x: number; z: number }): void => {
      const x = document.vertices[vertex * 3], z = document.vertices[vertex * 3 + 2];
      const nx = x - from.x, nz = z - from.z;
      const length = Math.hypot(nx, nz);
      const sign = from.inside ? -1 : 1;
      document.vertices[vertex * 3] = from.x + (length > 1e-9 ? (sign * nx) / length : 1) * marginM;
      document.vertices[vertex * 3 + 2] = from.z + (length > 1e-9 ? (sign * nz) / length : 0) * marginM;
    };
    let pushed = 0;
    const vertexCount = document.vertices.length / 3;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      if (lockedVertices.has(vertex)) continue;
      const hit = clearPoint(document.vertices[vertex * 3], document.vertices[vertex * 3 + 2]);
      if (hit) { pushVertex(vertex, hit); pushed++; }
    }
    // an edge between two clear vertices can still cut a rim corner: lift both ends outward along their
    // OWN normals until the midpoint clears (additive — repositioning them to the midpoint's outline
    // point would collapse the edge)
    const pushOutward = (vertex: number, extraM: number): void => {
      const x = document.vertices[vertex * 3], z = document.vertices[vertex * 3 + 2];
      let bestD = Infinity, bestX = 0, bestZ = 0;
      for (const polygon of polygons) {
        const n = polygon.xs.length;
        for (let i = 0; i < n; i++) {
          const ax = polygon.xs[i], az = polygon.zs[i];
          const bx = polygon.xs[(i + 1) % n], bz = polygon.zs[(i + 1) % n];
          const abx = bx - ax, abz = bz - az;
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / len2)) : 0;
          const qx = ax + t * abx, qz = az + t * abz;
          const d = Math.hypot(x - qx, z - qz);
          if (d < bestD) { bestD = d; bestX = qx; bestZ = qz; }
        }
      }
      const nx = x - bestX, nz = z - bestZ;
      const length = Math.hypot(nx, nz);
      if (!(length > 1e-9)) return;
      document.vertices[vertex * 3] = x + (nx / length) * extraM;
      document.vertices[vertex * 3 + 2] = z + (nz / length) * extraM;
    };
    for (let round = 0; round < 8; round++) {
      let cuts = 0;
      for (let quad = 0; quad < document.quads.length; quad++) {
        if (locked.has(quad)) continue;
        const [A, B, C, D] = document.quads[quad];
        for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as const) {
          if (lockedVertices.has(a) || lockedVertices.has(b)) continue;
          const mx = (document.vertices[a * 3] + document.vertices[b * 3]) / 2;
          const mz = (document.vertices[a * 3 + 2] + document.vertices[b * 3 + 2]) / 2;
          const hit = clearPoint(mx, mz);
          if (!hit || (!hit.inside && hit.d >= marginM * 0.8)) continue;
          cuts++;
          const extra = (hit.inside ? hit.d : 0) + marginM;
          pushOutward(a, extra);
          pushOutward(b, extra);
          pushed += 2;
        }
      }
      if (!cuts) break;
    }
    // finally, chord-crease every generated edge that runs near a locked rim: integration linearizes
    // the cross-seam edges, but a Bessel ring-to-ring edge beside a rim corner still bows metres past
    // its chord, and the footprint gate samples that bow
    const nearRim = (vertex: number): boolean => {
      const x = document.vertices[vertex * 3], z = document.vertices[vertex * 3 + 2];
      const reachM = job.options.targetPatchSizeM * 1.2;
      for (const polygon of polygons) {
        const n = polygon.xs.length;
        for (let i = 0; i < n; i++) {
          const ax = polygon.xs[i], az = polygon.zs[i];
          const bx = polygon.xs[(i + 1) % n], bz = polygon.zs[(i + 1) % n];
          const abx = bx - ax, abz = bz - az;
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / len2)) : 0;
          if (Math.hypot(x - ax - t * abx, z - az - t * abz) <= reachM) return true;
        }
      }
      return false;
    };
    const handles = { ...(document.edgeHandles ?? {}) };
    let creased = 0;
    for (let quad = 0; quad < document.quads.length; quad++) {
      if (locked.has(quad)) continue;
      const [A, B, C, D] = document.quads[quad];
      for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as const) {
        // seam edges (both endpoints locked) keep their exact handles; a cross-seam edge whose free
        // endpoint the pushes moved needs its chord REFRESHED, or the stale linear handle bows
        if (lockedVertices.has(a) && lockedVertices.has(b)) continue;
        if (!lockedVertices.has(a) && !nearRim(a)) continue;
        if (!lockedVertices.has(b) && !nearRim(b)) continue;
        const dx = document.vertices[b * 3] - document.vertices[a * 3];
        const dy = document.vertices[b * 3 + 1] - document.vertices[a * 3 + 1];
        const dz = document.vertices[b * 3 + 2] - document.vertices[a * 3 + 2];
        handles[`${a}>${b}`] = [dx / 3, dy / 3, dz / 3];
        handles[`${b}>${a}`] = [-dx / 3, -dy / 3, -dz / 3];
        creased++;
      }
    }
    integrated = { ...integrated, document: { ...document, edgeHandles: handles } };
    if (pushed || creased) update(job, 'validating', 90,
      `Pushed ${pushed} vertex move(s) and creased ${creased} first-row edges along the locked rims`);
  }

  update(job, 'validating', 91, 'Checking topology, interfaces, control cages, and surface deviation');
  if (integrated.report.connectedComponents !== 1) throw new Error(`Result has ${integrated.report.connectedComponents} disconnected components`);
  if (integrated.report.invertedCandidatePatches) {
    const worst = integrated.report.worstCandidatePatches[0];
    throw new Error(`Result has ${integrated.report.invertedCandidatePatches} inverted patches after ${seamRepairPasses} seam repair pass(es)${worst
      ? ` (worst candidate face ${worst.patch}, Jacobian ${worst.jacobian.toFixed(4)}, ${worst.fixedVertices} fixed / ${worst.interfaceVertices} trail-interface vertices)` : ''}`);
  }
  if (integrated.report.crossingInterfaceEdges) throw new Error(
    `Result has ${integrated.report.crossingInterfaceEdges} mountain edge(s) crossing through a locked feature after ${seamRepairPasses} local repair pass(es); the preview was rejected`,
  );
  const footprint = job.options.scope === 'whole-unlocked'
    ? generatedProtectedFootprintPenetration(integrated.document, persistentProtectedPatches,
      Math.max(directJoin ? 8 : 4, job.options.qualityResolution))
    : { overlappingTriangles: [], penetratingCentroids: 0, maximumCentroidDepthM: 0, worstPenetrations: [] };
  const shallowBufferedLimitM = job.options.targetPatchSizeM * .08;
  // A conforming join shares the bicubic outline curve with the locked feature, and the gate's two
  // independent piecewise-linear samplings of that same curve always interleave in hairline slivers —
  // sliver existence is meaningless there, so genuine leaning is judged by centroid depth instead.
  const invalidFootprint = bufferedRepeat
    ? footprint.maximumCentroidDepthM > shallowBufferedLimitM
      || footprint.overlappingTriangles.length > persistentProtectedPatches
    : directJoin
      ? footprint.maximumCentroidDepthM > job.options.targetPatchSizeM * .01
      : footprint.overlappingTriangles.length > 0;
  if (invalidFootprint) {
    // keep the rejected document for post-mortem: which patch actually leans is invisible from counts
    await writeFile(join(directory, 'rejected-document.json'), JSON.stringify(integrated.document));
    throw new Error(
      `Result overlaps a locked feature in top view (${footprint.overlappingTriangles.length} triangle(s), ${footprint.penetratingCentroids} interior centroid(s), maximum depth ${footprint.maximumCentroidDepthM.toFixed(2)} m`
      + `${footprint.worstPenetrations.length ? ` at ${footprint.worstPenetrations.map(p => `${p.x.toFixed(0)},${p.z.toFixed(0)}`).join(' ')}` : ''}; `
      + `boundary snap ${integrated.report.maximumBoundarySnapM.toFixed(2)} m, `
      + `${integrated.report.interfaceLoops.length} interface loop(s) `
      + integrated.report.interfaceLoops.map(loop => `${loop.protectedEdges}/${loop.candidateEdges}`).join(' ')
      + '); the preview was rejected',
    );
  }
  // A local cut expansion can deliberately move a small boundary section farther than the ordinary two-patch
  // stitching budget. It is accepted only after the crossing/inversion/aspect gates prove the repaired sheet;
  // the preview remains non-destructive and exposes the resulting edge flow before Apply.
  const maximumSafeSnapM = job.options.targetPatchSizeM * (seamRepairPasses ? 4 : 2);
  if (integrated.report.maximumBoundarySnapM > maximumSafeSnapM) throw new Error(
    `Locked interface would move ${integrated.report.maximumBoundarySnapM.toFixed(2)} m during stitching (safe limit ${maximumSafeSnapM.toFixed(2)} m); the preview was rejected`,
  );
  if (integrated.report.candidateAspectRatio.p95 > 5 || integrated.report.candidateAspectRatio.max > 100) {
    throw new Error(`Result has distorted patches (aspect ratio p95 ${integrated.report.candidateAspectRatio.p95.toFixed(2)}, max ${integrated.report.candidateAspectRatio.max.toFixed(2)}); adjust the selection, influence rings, or density`);
  }
  if (integrated.report.protectedControlDeviationM > 1e-8) throw new Error('A locked bicubic control point moved during integration');
  const normalized = normalizeTJunctions(integrated.document);
  if (normalized.length !== (integrated.document.tJunctions?.length ?? 0)) throw new Error('Result contains invalid T-junction records');
  const maximumTJunctionGapM = Math.max(0, ...findTJunctions(integrated.document).map(node => node.distance));
  if (maximumTJunctionGapM > 1e-6) throw new Error(`Result has a ${maximumTJunctionGapM.toFixed(4)} m T-junction gap`);
  const allSource = new Set(job.source.quads.map((_quad, index) => index));
  const allResult = new Set(integrated.document.quads.map((_quad, index) => index));
  const deviation = scoreSurfaceDeviation(
    tessellateQuads(job.source, allSource, job.options.qualityResolution),
    tessellateQuads(integrated.document, allResult, job.options.qualityResolution),
  );
  if ((deviation.symmetricMaxM ?? Infinity) > job.options.maximumSurfaceDeviationM) {
    throw new Error(`Maximum surface deviation ${deviation.symmetricMaxM?.toFixed(3) ?? 'unknown'} m exceeds the ${job.options.maximumSurfaceDeviationM.toFixed(3)} m limit`);
  }
  const summary: RetopologyResultSummary = {
    scope: job.options.scope,
    sourcePatches: job.source.quads.length,
    remeshedSourcePatches: constraints.remeshQuadIds.length,
    lockedPatches: Object.values(job.source.quadLocked ?? {}).filter(Boolean).length,
    protectedPatches: integrated.report.protectedPatches,
    generatedPatches: integrated.report.candidatePatches,
    totalPatches: integrated.document.quads.length,
    connectedComponents: integrated.report.connectedComponents,
    interfaceEdges: {
      protected: integrated.report.sourceInterfaceEdges,
      generated: integrated.report.candidateInterfaceEdges,
    },
    tJunctions: integrated.report.embeddedTJunctions,
    invertedPatches: integrated.report.invertedCandidatePatches,
    protectedControlDeviationM: integrated.report.protectedControlDeviationM,
    cageEdgeLengthM: integrated.report.candidateEdgeLengthM,
    cageAspectRatio: integrated.report.candidateAspectRatio,
    surfaceDeviationM: {
      sourceToResult: deviation.sourceToCandidateM,
      resultToSource: deviation.candidateToSourceM,
      symmetricMax: deviation.symmetricMaxM,
    },
  };
  return { document: integrated.document, summary, integration: integrated.report };
}

async function execute(job: JobRecord): Promise<RetopologyJobResult> {
  try {
    return await executeAttempt(job);
  } catch (error) {
    if (!(error instanceof BoundaryConstrainedRetry) || job.options.scope !== 'whole-unlocked' || job.cancelled) throw error;
    return executeAttempt(job, true, error.message);
  }
}

const jobs = new Map<string, JobRecord>();
const pending: JobRecord[] = [];
let active = 0;

function publicStatus(job: JobRecord): RetopologyJobStatus {
  const queuePosition = job.status.phase === 'queued' ? pending.indexOf(job) + 1 : undefined;
  return { ...job.status, ...(queuePosition && queuePosition > 0 ? { queuePosition } : {}) };
}

function expire(job: JobRecord): void {
  job.expires = setTimeout(() => {
    jobs.delete(job.status.id);
    for (const directory of job.directories) void rm(directory, { recursive: true, force: true });
  }, RETENTION_MS);
  job.expires.unref?.();
}

function drain(): void {
  while (active < concurrency() && pending.length) {
    const job = pending.shift()!;
    if (job.cancelled) continue;
    active++;
    job.status = { ...job.status, startedAt: new Date().toISOString() };
    void execute(job).then(result => {
      job.result = result;
      job.status = {
        ...job.status, phase: 'complete', progress: 100, detail: 'Validated result ready',
        finishedAt: new Date().toISOString(), summary: result.summary,
      };
    }).catch(error => {
      const cancelled = job.cancelled;
      job.status = {
        ...job.status, phase: cancelled ? 'cancelled' : 'failed', progress: job.status.progress,
        detail: cancelled ? 'Cancelled' : 'Retopology failed',
        error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      };
    }).finally(() => {
      job.child = undefined;
      active--;
      expire(job);
      drain();
    });
  }
}

export function createRetopologyJob(
  source: unknown,
  requested?: Partial<RetopologyJobOptions>,
  selectedQuadIds: readonly string[] = [],
): RetopologyJobStatus {
  const options = normalizeOptions(requested);
  if (options.strategy === 'quadwild') {
    const reason = unavailableReason();
    if (reason) throw new Error(reason);
  }
  // Jobs never stack up behind the running solve: a submission is only accepted while a worker slot is
  // free, so everyone else waits and retries rather than holding a place in an unbounded queue.
  if (active + pending.length >= concurrency()) {
    throw new Error('The retopology worker is busy with another job; try again when it finishes.');
  }
  const document = migrateMountain(source);
  const id = randomUUID();
  const job: JobRecord = {
    source: document,
    options,
    selectedQuadIds: [...new Set(selectedQuadIds.filter(id => typeof id === 'string'))],
    directories: [],
    cancelled: false,
    status: {
      id, phase: 'queued', progress: 0, detail: 'Waiting for the retopology worker',
      createdAt: new Date().toISOString(),
    },
  };
  jobs.set(id, job);
  pending.push(job);
  drain();
  return publicStatus(job);
}

export function retopologyJobStatus(id: string): RetopologyJobStatus | null {
  const job = jobs.get(id);
  return job ? publicStatus(job) : null;
}

export function retopologyJobResult(id: string): RetopologyJobResult | null {
  return jobs.get(id)?.result ?? null;
}

export function cancelRetopologyJob(id: string): RetopologyJobStatus | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status.phase === 'complete' || job.status.phase === 'failed' || job.status.phase === 'cancelled') return publicStatus(job);
  job.cancelled = true;
  const at = pending.indexOf(job);
  if (at >= 0) {
    pending.splice(at, 1);
    job.status = { ...job.status, phase: 'cancelled', detail: 'Cancelled', finishedAt: new Date().toISOString() };
    expire(job);
  }
  job.child?.kill();
  return publicStatus(job);
}
