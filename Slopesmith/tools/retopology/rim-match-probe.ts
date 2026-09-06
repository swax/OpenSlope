/** Offline diagnostic: why did lockedRimLoops skip a proxy hole? Reports every proxy boundary
 * loop's worst vertex distance to the interface curves.
 * Usage: npx tsx tools/retopology/rim-match-probe.ts <mountain.slope.json> [target-patch-size-m] */
import { readFileSync } from 'node:fs';
import { migrateMountain } from '../../src/core/doc/mountain';
import { prepareRetopologyBenchmark } from '../../src/core/mesh/retopology/benchmark';
import type { V3 } from '../../src/core/doc/types';
import { boundaryLoops } from '../../src/core/mesh/retopology/prescribe';

const sourceFile = process.argv[2];
if (!sourceFile) {
  console.error('Usage: npx tsx tools/retopology/rim-match-probe.ts <mountain.slope.json> [target-patch-size-m]');
  process.exit(2);
}

const target = Number(process.argv[3] ?? 25);
if (!Number.isFinite(target) || target <= 0) {
  console.error(`Target patch size must be a positive number of metres; got "${process.argv[3]}".`);
  process.exit(2);
}

const source = migrateMountain(JSON.parse(readFileSync(sourceFile, 'utf8')));
// A mountain with nothing locked has no preserved region, so there is no rim to match and nothing this
// probe can say. That is a wrong input rather than a fault — report it as a sentence, not a stack trace.
let prepared;
try {
  prepared = prepareRetopologyBenchmark(source, {
    collarRings: 0,
    targetPatchSizeM: target,
    tessellationResolution: 1,
    wholeSurface: false,
  });
} catch (error) {
  console.error(`${sourceFile}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const curves = prepared.constraints.interface;
console.log(`${curves.length} interface curves`);
const segDist = (p: V3, a: V3, b: V3): number => {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const ap: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, len2 > 0 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2 : 0));
  return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1], p[2] - a[2] - t * ab[2]);
};
for (const loop of boundaryLoops(prepared.input)) {
  let worst = 0;
  for (const vertex of loop) {
    const point = prepared.input.vertices[vertex];
    let best = Infinity;
    for (const curve of curves) {
      for (let i = 0; i + 1 < curve.samples.length && best > 0; i++) {
        best = Math.min(best, segDist(point, curve.samples[i], curve.samples[i + 1]));
      }
    }
    worst = Math.max(worst, best);
  }
  console.log(`proxy loop ${loop.length} edges: worst vertex-to-interface ${worst.toFixed(3)} m`);
}
