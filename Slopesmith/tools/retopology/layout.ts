/**
 * Parse the QuadWild stage-3 intermediates retained in a retopology job directory, reconstruct
 * the coarse patch-layout graph, and re-derive the per-subside subdivision counts that
 * quad_from_patches chose by walking the quadrangulation output's per-patch material groups.
 *
 *   npx tsx tools/retopology/layout.ts <job-directory>
 *
 * Verifies (exits non-zero on any failure):
 *   - every patch-border edge is consumed by exactly one corner-to-corner arc (subside)
 *   - each patch's arcs close into a single 2-regular cycle over its effective corners
 *   - every quad-mesh patch side maps onto exactly one layout arc, with equal counts from
 *     both incident patches, geometrically on the arc polyline
 *   - per-patch side counts sum even; per-patch quad counts total the output mesh
 *
 * The per-arc integer vector this prints is the quantity a SlopeSmith quantizer would own
 * (Slopesmith/docs/ideas/042-relayout-quantization.md, milestone M0).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type V3 = [number, number, number];

const cliArgs = process.argv.slice(2);
const jobDir = cliArgs.find(arg => !arg.startsWith('--'));
const tagArgAt = cliArgs.indexOf('--tag');
const requestedTag = tagArgAt >= 0 ? cliArgs[tagArgAt + 1] : undefined;
if (!jobDir) {
  console.error('Usage: npx tsx tools/retopology/layout.ts <job-directory> [--tag N]');
  process.exit(2);
}

let failures = 0;
const fail = (message: string): void => {
  failures++;
  console.error(`  !! ${message}`);
};

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function pointSegDist(p: V3, a: V3, b: V3): number {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = Math.max(0, Math.min(1, len2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2 : 0));
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
}

/** Minimal OBJ reader keeping usemtl groups; optionally welds exact-duplicate positions so
 * per-patch groups share seam vertices even if the exporter duplicated them. */
function parseObj(file: string, weld: boolean) {
  const verts: V3[] = [];
  const faces: number[][] = [];
  const faceMat: number[] = [];
  const mats: string[] = [];
  const seen = new Map<string, number>();
  const remap: number[] = [];
  let current = -1;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const raw = line.slice(2).trim();
      const prior = weld ? seen.get(raw) : undefined;
      if (prior !== undefined) {
        remap.push(prior);
        continue;
      }
      if (weld) seen.set(raw, verts.length);
      remap.push(verts.length);
      const p = raw.split(/\s+/).map(Number);
      verts.push([p[0], p[1], p[2]]);
    } else if (line.startsWith('f ')) {
      faces.push(line.slice(2).trim().split(/\s+/).map(token => remap[parseInt(token.split('/')[0], 10) - 1]));
      faceMat.push(current);
    } else if (line.startsWith('usemtl')) {
      const name = line.slice(6).trim();
      let index = mats.indexOf(name);
      if (index < 0) { mats.push(name); index = mats.length - 1; }
      current = index;
    }
  }
  return { verts, faces, faceMat, mats };
}

const edgeKey = (a: number, b: number): string => `${Math.min(a, b)}_${Math.max(a, b)}`;

// ---------- stage-3 intermediates ----------
const tri = parseObj(join(jobDir, 'input_rem_p0.obj'), false);

const patchLines = readFileSync(join(jobDir, 'input_rem_p0.patch'), 'utf8').trim().split(/\r?\n/);
if (parseInt(patchLines[0], 10) !== tri.faces.length) {
  throw new Error(`.patch face count ${patchLines[0]} does not match mesh (${tri.faces.length})`);
}
const facePatch = patchLines.slice(1).map(line => parseInt(line, 10));
const numPatches = Math.max(...facePatch) + 1;

const cornerTokens = readFileSync(join(jobDir, 'input_rem_p0.corners'), 'utf8').trim().split(/\s+/).map(Number);
const patchCorners: number[][] = [];
for (let at = 1, p = 0; p < cornerTokens[0]; p++) {
  const count = cornerTokens[at++];
  patchCorners.push(cornerTokens.slice(at, at + count));
  at += count;
}
const cornerSet = new Set<number>(patchCorners.flat());

const cFeatureTokens = readFileSync(join(jobDir, 'input_rem_p0.c_feature'), 'utf8').trim().split(/\s+/).map(Number);
const cFeature = new Set<number>(cFeatureTokens.slice(1, 1 + cFeatureTokens[0]));

// .feature lines are "faceIndex,edgeIndex" pairs marking feature (sharp) triangle edges
const featureEdges = new Set<string>();
for (const line of readFileSync(join(jobDir, 'input_rem_p0.feature'), 'utf8').trim().split(/\r?\n/).slice(1)) {
  const [face, edge] = line.split(',').map(Number);
  featureEdges.add(edgeKey(tri.faces[face][edge], tri.faces[face][(edge + 1) % 3]));
}

console.log(`tri mesh: ${tri.verts.length} verts, ${tri.faces.length} faces, ${numPatches} patches`);
console.log(`declared corners: ${cornerSet.size} distinct verts; c_feature corners: ${cFeature.size}; feature edges: ${featureEdges.size}`);

// ---------- layout graph: arcs are QuadWild subsides ----------
const edgeFaces = new Map<string, number[]>();
for (let f = 0; f < tri.faces.length; f++) {
  for (let e = 0; e < 3; e++) {
    const key = edgeKey(tri.faces[f][e], tri.faces[f][(e + 1) % 3]);
    let list = edgeFaces.get(key);
    if (!list) edgeFaces.set(key, (list = []));
    list.push(f);
  }
}

// border edge -> patch pair, with -1 for the mesh boundary (hole-mode rims)
const borderEdges = new Map<string, [number, number]>();
for (const [key, incident] of edgeFaces) {
  if (incident.length === 1) {
    borderEdges.set(key, [facePatch[incident[0]], -1]);
  } else if (incident.length === 2) {
    const p = facePatch[incident[0]], q = facePatch[incident[1]];
    if (p !== q) borderEdges.set(key, [Math.min(p, q), Math.max(p, q)]);
  } else {
    throw new Error(`non-manifold edge ${key} (${incident.length} faces)`);
  }
}

const vertBorder = new Map<number, string[]>();
for (const key of borderEdges.keys()) {
  for (const v of key.split('_').map(Number)) {
    let list = vertBorder.get(v);
    if (!list) vertBorder.set(v, (list = []));
    list.push(key);
  }
}
for (const [v, edges] of vertBorder) {
  if (edges.length > 2 && !cornerSet.has(v)) fail(`junction vertex ${v} (${edges.length} border edges) is not a declared corner`);
}

interface Arc {
  id: number;
  pair: [number, number];
  vStart: number;
  vEnd: number;
  polyline: number[];
  length: number;
  onFeature: number;
}
const arcs: Arc[] = [];
const visited = new Set<string>();
for (const corner of cornerSet) {
  for (const startEdge of vertBorder.get(corner) ?? []) {
    if (visited.has(startEdge)) continue;
    const label = borderEdges.get(startEdge)!;
    const polyline = [corner];
    let previous = corner;
    let edge = startEdge;
    let onFeature = 0;
    let length = 0;
    for (;;) {
      visited.add(edge);
      if (featureEdges.has(edge)) onFeature++;
      const [a, b] = edge.split('_').map(Number);
      const next = a === previous ? b : a;
      length += dist(tri.verts[previous], tri.verts[next]);
      polyline.push(next);
      if (cornerSet.has(next)) break;
      const continuations = (vertBorder.get(next) ?? []).filter(key => key !== edge && !visited.has(key));
      if (continuations.length !== 1) throw new Error(`arc trace stuck at vertex ${next} (${continuations.length} continuations)`);
      const nextLabel = borderEdges.get(continuations[0])!;
      if (nextLabel[0] !== label[0] || nextLabel[1] !== label[1]) throw new Error(`patch-pair label change mid-arc at vertex ${next}`);
      previous = next;
      edge = continuations[0];
    }
    arcs.push({ id: arcs.length, pair: label, vStart: corner, vEnd: polyline[polyline.length - 1], polyline, length, onFeature });
  }
}
const orphanEdges = [...borderEdges.keys()].filter(key => !visited.has(key)).length;
if (orphanEdges) fail(`${orphanEdges} border edges not reached from any corner`);
console.log(`layout graph: ${cornerSet.size} corner nodes, ${arcs.length} subside arcs, ${borderEdges.size} border edges`);

// A declared side can be split by a neighbor patch's corner sitting flat on it; a patch's
// effective corners are its arcs' endpoints, and .corners must be a subset of them.
const patchArcs: number[][] = Array.from({ length: numPatches }, () => []);
for (const arc of arcs) {
  for (const p of arc.pair) if (p >= 0) patchArcs[p].push(arc.id);
}
const patchEffCorners: number[][] = [];
for (let p = 0; p < numPatches; p++) {
  const degree = new Map<number, number>();
  for (const id of patchArcs[p]) {
    degree.set(arcs[id].vStart, (degree.get(arcs[id].vStart) ?? 0) + 1);
    degree.set(arcs[id].vEnd, (degree.get(arcs[id].vEnd) ?? 0) + 1);
  }
  patchEffCorners.push([...degree.keys()].sort((a, b) => a - b));
  if (!patchCorners[p].every(corner => degree.has(corner))) fail(`patch ${p}: declared corners are not all arc endpoints`);
  if ([...degree.values()].some(d => d !== 2) || patchArcs[p].length !== degree.size) {
    fail(`patch ${p}: arcs do not form a single 2-regular cycle`);
  }
}

// ---------- quadrangulation output: walk per-patch boundaries ----------
// the file name embeds the tag quad_from_patches was invoked with
const quadPattern = requestedTag
  ? new RegExp(`^input_rem_p0_${requestedTag}_quadrangulation\\.obj$`)
  : /^input_rem_p0_\d+_quadrangulation\.obj$/;
const quadName = readdirSync(jobDir).find(name => quadPattern.test(name));
if (!quadName) throw new Error('no matching input_rem_p0_<tag>_quadrangulation.obj in job directory');
console.log(`quadrangulation: ${quadName}`);
const quad = parseObj(join(jobDir, quadName), true);
console.log(`quad mesh: ${quad.verts.length} verts, ${quad.faces.length} faces, ${quad.mats.length} material groups`);

const cornerQuadVert = new Map<number, number>();
const quadVertCorner = new Map<number, number>();
let worstCornerMatch = 0;
for (const corner of cornerSet) {
  let best = -1, bestDistance = Infinity;
  for (let i = 0; i < quad.verts.length; i++) {
    const d = dist(tri.verts[corner], quad.verts[i]);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  if (quadVertCorner.has(best)) throw new Error(`corners ${quadVertCorner.get(best)} and ${corner} match the same quad vertex`);
  cornerQuadVert.set(corner, best);
  quadVertCorner.set(best, corner);
  worstCornerMatch = Math.max(worstCornerMatch, bestDistance);
}
console.log(`corner -> quad vertex worst match distance: ${worstCornerMatch.toExponential(2)}`);

const matFaces: number[][] = Array.from({ length: quad.mats.length }, () => []);
for (let f = 0; f < quad.faces.length; f++) matFaces[quad.faceMat[f]].push(f);

interface Side { patch: number; verts: number[] }
const sides: Side[] = [];
const matPatch: number[] = [];
for (let m = 0; m < quad.mats.length; m++) {
  const edgeUse = new Map<string, number>();
  for (const f of matFaces[m]) {
    const face = quad.faces[f];
    for (let e = 0; e < face.length; e++) {
      const key = edgeKey(face[e], face[(e + 1) % face.length]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const adjacency = new Map<number, number[]>();
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    const [a, b] = key.split('_').map(Number);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let list = adjacency.get(x);
      if (!list) adjacency.set(x, (list = []));
      list.push(y);
    }
  }
  for (const [v, neighbors] of adjacency) {
    if (neighbors.length !== 2) throw new Error(`material ${m}: boundary vertex ${v} has ${neighbors.length} boundary neighbors`);
  }
  const boundaryCorners = [...adjacency.keys()].filter(v => quadVertCorner.has(v));
  const start = boundaryCorners[0];
  const loop = [start];
  for (let previous = -1, at = start; ;) {
    const [n1, n2] = adjacency.get(at)!;
    const next = n1 === previous ? n2 : n1;
    previous = at;
    at = next;
    if (at === start) break;
    loop.push(at);
  }
  if (loop.length !== adjacency.size) throw new Error(`material ${m}: boundary is not a single loop`);

  const cornerIdsHere = boundaryCorners.map(v => quadVertCorner.get(v)!).sort((a, b) => a - b);
  const patch = patchEffCorners.findIndex(
    effective => effective.length === cornerIdsHere.length && effective.every((c, i) => c === cornerIdsHere[i]),
  );
  if (patch < 0) throw new Error(`material ${m}: corner set [${cornerIdsHere}] matches no patch`);
  matPatch.push(patch);

  const cornerPositions = loop.map((v, i) => (quadVertCorner.has(v) ? i : -1)).filter(i => i >= 0);
  for (let s = 0; s < cornerPositions.length; s++) {
    const from = cornerPositions[s];
    const to = cornerPositions[(s + 1) % cornerPositions.length];
    const verts: number[] = [];
    for (let i = from; ; i = (i + 1) % loop.length) {
      verts.push(loop[i]);
      if (i === to && verts.length > 1) break;
    }
    sides.push({ patch, verts });
  }
}

// ---------- match sides to arcs; re-derive and verify the chosen counts ----------
const arcDistance = (arc: Arc, point: V3): number => {
  let best = Infinity;
  for (let i = 0; i + 1 < arc.polyline.length; i++) {
    best = Math.min(best, pointSegDist(point, tri.verts[arc.polyline[i]], tri.verts[arc.polyline[i + 1]]));
  }
  return best;
};

const arcCounts = new Map<number, { counts: number[]; maxDeviation: number }>();
for (const side of sides) {
  const first = quadVertCorner.get(side.verts[0])!;
  const last = quadVertCorner.get(side.verts[side.verts.length - 1])!;
  const candidates = arcs.filter(
    arc =>
      (arc.pair[0] === side.patch || arc.pair[1] === side.patch) &&
      ((arc.vStart === first && arc.vEnd === last) || (arc.vStart === last && arc.vEnd === first)),
  );
  // two arcs of one patch may share both endpoints; the side midpoint disambiguates
  const midpoint = quad.verts[side.verts[Math.floor(side.verts.length / 2)]];
  const arc = candidates.length === 1
    ? candidates[0]
    : candidates.reduce<Arc | undefined>((best, candidate) =>
        !best || arcDistance(candidate, midpoint) < arcDistance(best, midpoint) ? candidate : best, undefined);
  if (!arc) {
    fail(`side of patch ${side.patch} (${first}->${last}) matches no layout arc`);
    continue;
  }
  let maxDeviation = 0;
  for (const v of side.verts) maxDeviation = Math.max(maxDeviation, arcDistance(arc, quad.verts[v]));
  let record = arcCounts.get(arc.id);
  if (!record) arcCounts.set(arc.id, (record = { counts: [], maxDeviation: 0 }));
  record.counts.push(side.verts.length - 1);
  record.maxDeviation = Math.max(record.maxDeviation, maxDeviation);
}

for (const arc of arcs) {
  const record = arcCounts.get(arc.id);
  const expected = arc.pair[1] === -1 ? 1 : 2;
  if (!record || record.counts.length !== expected) {
    fail(`arc ${arc.id} (patches ${arc.pair}) covered by ${record?.counts.length ?? 0}/${expected} quad sides`);
  } else if (expected === 2 && record.counts[0] !== record.counts[1]) {
    fail(`arc ${arc.id} non-conforming: ${record.counts[0]} vs ${record.counts[1]}`);
  }
}

console.log('\nper-arc subdivision counts chosen by quad_from_patches:');
console.log('arc | patches | corners        | len(m) | triE | count | spacing | onFeat');
let worstDeviation = 0;
for (const arc of arcs) {
  const record = arcCounts.get(arc.id);
  const count = record?.counts[0] ?? NaN;
  worstDeviation = Math.max(worstDeviation, record?.maxDeviation ?? 0);
  const pairLabel = arc.pair[1] === -1 ? `${arc.pair[0]}|hole` : `${arc.pair[0]}|${arc.pair[1]}`;
  console.log(
    `${String(arc.id).padStart(3)} | ${pairLabel.padEnd(7)} | ${`${arc.vStart}->${arc.vEnd}`.padEnd(14)} | ${arc.length.toFixed(0).padStart(6)} | ` +
    `${String(arc.polyline.length - 1).padStart(4)} | ${String(count).padStart(5)} | ${(arc.length / count).toFixed(1).padStart(7)} | ${arc.onFeature}`,
  );
}
console.log(`max deviation of any quad side vertex from its layout arc: ${worstDeviation.toFixed(4)}`);

console.log('\nper-patch subside counts:');
let accountedQuads = 0;
for (let p = 0; p < numPatches; p++) {
  const counts = patchArcs[p].map(id => arcCounts.get(id)?.counts[0] ?? NaN);
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum % 2 !== 0) fail(`patch ${p}: side counts sum to odd ${sum}`);
  const quadCount = matFaces[matPatch.indexOf(p)].length;
  accountedQuads += quadCount;
  console.log(`patch ${String(p).padStart(2)} (${patchCorners[p].length} declared corners, ${patchArcs[p].length} subsides): [${counts.join(', ')}] sum=${sum} quads=${quadCount}`);
}
if (accountedQuads !== quad.faces.length) fail(`per-patch quads ${accountedQuads} != mesh total ${quad.faces.length}`);

// candidate-join loops: each closed chain of locked-feature arcs is a rim whose subdivision
// total is the candidate edge count a locked-feature join must work with. Hole-mode rims are
// mesh-boundary arcs; explicit-trail runs carry the trail as interior fully-on-feature arcs.
function reportLoops(label: string, subset: Arc[]): void {
  const adjacency = new Map<number, Arc[]>();
  for (const arc of subset) {
    for (const v of [arc.vStart, arc.vEnd]) {
      let list = adjacency.get(v);
      if (!list) adjacency.set(v, (list = []));
      list.push(arc);
    }
  }
  const seen = new Set<number>();
  for (const arc of subset) {
    if (seen.has(arc.id)) continue;
    const loop: Arc[] = [];
    const start = arc.vStart;
    let at = start;
    for (let current = arc; ;) {
      seen.add(current.id);
      loop.push(current);
      at = current.vStart === at ? current.vEnd : current.vStart;
      const next = (adjacency.get(at) ?? []).find(candidate => !seen.has(candidate.id));
      if (!next) break;
      current = next;
    }
    const total = loop.reduce((sum, a) => sum + (arcCounts.get(a.id)?.counts[0] ?? 0), 0);
    const length = loop.reduce((sum, a) => sum + a.length, 0);
    const corners = new Set(loop.flatMap(a => [a.vStart, a.vEnd]));
    const featureCorners = [...corners].filter(c => cFeature.has(c)).length;
    console.log(
      `\n${label} ${at === start ? 'loop' : 'chain'}: ${loop.length} arcs, ${corners.size} corners ` +
      `(${featureCorners} in .c_feature), length ${length.toFixed(1)}, total subdivisions = ${total}`,
    );
  }
}
reportLoops('boundary', arcs.filter(arc => arc.pair[1] === -1));
reportLoops('interior feature', arcs.filter(arc => arc.pair[1] >= 0 && arc.onFeature === arc.polyline.length - 1));

if (failures) {
  console.error(`\n${failures} verification failure(s)`);
  process.exit(1);
}
console.log('\nall layout/quantization consistency checks passed');
