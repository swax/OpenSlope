import type { V3 } from '../doc/types';

/**
 * The light on the ground under a point — the term a prop's per-instance key is read from (docs/032 ·
 * lighting). Retail's prop lighting is not recomputed from the scene; it is *read* from the terrain's own
 * baked light, so this is the one place that reads it and both the export bake and the editor preview go
 * through it. Their agreement is the whole point: previewing a mountain and shipping it have to light props
 * the same way, and they cannot drift if there is only one sampler.
 *
 * `colored` is the per-vertex lit RGB the lightmap encodes (`computeModelColored` + any rig glow), index
 * aligned with `positions`. A_S is its peak channel, which is exactly what `encodeLightmapTexel` writes.
 *
 * Nearest-vertex rather than interpolated: the lightmap tessellation is far finer than the scale over which
 * prop lighting varies, and a prop sits on one patch's worth of ground. Nearest in 3D rather than in XZ:
 * where the quilt folds over itself (a tunnel, an overhang) two sheets of ground share an XZ, and a prop on
 * the lower one must read the floor it stands on, not the roof above it. On open ground the two agree.
 */
export function groundLightSampler(positions: Float32Array,
                                   colored: Float32Array): (p: V3) => number {
  const CELL = 4;                                     // metres; about a prop's own footprint
  const vertCount = positions.length / 3;
  const grid = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;
  for (let i = 0; i < vertCount; i++) {
    const k = key(Math.floor(positions[i * 3] / CELL), Math.floor(positions[i * 3 + 2] / CELL));
    const b = grid.get(k);
    if (b) b.push(i); else grid.set(k, [i]);
  }
  return (p: V3): number => {
    const cx = Math.floor(p[0] / CELL), cz = Math.floor(p[2] / CELL);
    for (let r = 0; r <= 8; r++) {                    // expanding rings; off the quilt reads as fully lit
      let best = -1, bd = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const b = grid.get(key(cx + dx, cz + dz));
          if (!b) continue;
          for (const i of b) {
            const d = (positions[i * 3] - p[0]) ** 2 + (positions[i * 3 + 1] - p[1]) ** 2
              + (positions[i * 3 + 2] - p[2]) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
        }
      }
      if (best >= 0) {
        const c = best * 3;
        return Math.min(1, Math.max(colored[c], colored[c + 1], colored[c + 2]));
      }
    }
    return 1;
  };
}
