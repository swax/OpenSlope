import * as THREE from 'three';
import type { V3 } from '../src/core/doc/types';
import { buildReferenceMesh, type RawPatch } from '../src/core/reference/terrain';
import { referenceGroundLightSampler } from '../src/app/viewport/mesh/reference-lighting';

/** A shaded floor, a bright roof at the same XZ, open snow, and a legacy-lit surface. */
export function groundLightingFixture(shade: V3 = [0.2, 0.2, 0.2], source: 'image' | 'vertex' = 'image') {
  const colors = [shade, [0.8, 0.7, 0.6], [1, 1, 1], [0.01, 0.01, 0.01]];
  const patch = (x: number, y: number, id: number, rgb = true): RawPatch => ({
    Points: Array.from({ length: 16 }, (_, i) => [
      -(x + (Math.floor(i / 4) * 8) / 3 - 4) * 100,
      -(((i % 4) * 8) / 3 - 4) * 100,
      y * 100,
    ]),
    SurfaceType: 1,
    LightmapID: source === 'image' ? id : -1,
    LightMapPoint: source === 'image' ? [0, 0, 1, 1] : [0, 0, 0, 0],
    ...(rgb && source === 'image' ? { LightmapEncoding: 'rgb-multiply' as const } : {}),
    ...(rgb && source === 'vertex' ? { LightColorPoints: Array.from({ length: 16 }, () => [...colors[id]]) } : {}),
  });
  const patches = [patch(0, 0, 0), patch(0, 8, 1), patch(20, 0, 2), patch(40, 0, 3, false)];
  const maps = new Map(
    colors.map((rgb, id) => [
      id,
      {
        a: new Float32Array(128 * 128).fill(rgb[0]),
        rgb: Float32Array.from({ length: 128 * 128 * 3 }, (_, i) => rgb[i % 3]),
      },
    ]),
  );
  const data = buildReferenceMesh(patches, source === 'image' ? maps : undefined, 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  return { data, geometry, sample: referenceGroundLightSampler(geometry, data)! };
}
