import type { ShadowMask } from './shadow-mask';

/** A render mesh in model coordinates, optionally posed into editor metres. Geometry is shared between instances. */
export interface LightingOccluder {
  positions: Float32Array;
  indices: Uint32Array;
  matrix?: readonly number[];
  uvs?: Float32Array;
  mask?: ShadowMask;
}

export interface ShadowCutout {
  start: number;
  count: number;
  vertexOffset: number;
  uvs: Float32Array;
  mask: ShadowMask;
}
export interface LightingGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  cutouts?: readonly ShadowCutout[];
}

/** Assemble blockers in the worker, leaving terrain vertices/normals as a separate lighting query. */
export function lightingGeometry(terrain: LightingGeometry, props: readonly LightingOccluder[] = []): LightingGeometry {
  if (!props.length) return terrain;
  const meshes = [terrain, ...props];
  const positions = new Float32Array(meshes.reduce((n, mesh) => n + mesh.positions.length, 0));
  const indices = new Uint32Array(meshes.reduce((n, mesh) => n + mesh.indices.length, 0));
  const cutouts: ShadowCutout[] = [...(terrain.cutouts ?? [])];
  let vertex = 0,
    triangle = 0;
  for (const mesh of meshes) {
    const { matrix: m, mask, uvs } = mesh as LightingOccluder;
    if (mask && uvs?.length === (mesh.positions.length / 3) * 2)
      cutouts.push({ start: triangle, count: mesh.indices.length, vertexOffset: vertex, uvs, mask });
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i],
        y = mesh.positions[i + 1],
        z = mesh.positions[i + 2];
      positions[vertex * 3 + i] = m ? m[0] * x + m[4] * y + m[8] * z + m[12] : x;
      positions[vertex * 3 + i + 1] = m ? m[1] * x + m[5] * y + m[9] * z + m[13] : y;
      positions[vertex * 3 + i + 2] = m ? m[2] * x + m[6] * y + m[10] * z + m[14] : z;
    }
    for (let i = 0; i < mesh.indices.length; i++) indices[triangle++] = mesh.indices[i] + vertex;
    vertex += mesh.positions.length / 3;
  }
  return { positions, indices, cutouts };
}
