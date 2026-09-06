import type { V3 } from '../../doc/types';

/** Minimal polygon mesh interchange used by the offline retopology benchmark. Faces use perimeter order. */
export interface PolygonMesh {
  vertices: V3[];
  faces: number[][];
}

/** OBJ deliberately stays the benchmark boundary: all three candidate tools read and write it. */
export function writeObj(mesh: PolygonMesh, name = 'mesh'): string {
  const lines = [`# SlopeSmith retopology benchmark`, `o ${name}`];
  for (const [x, y, z] of mesh.vertices) lines.push(`v ${x} ${y} ${z}`);
  for (const face of mesh.faces) {
    if (face.length >= 3) lines.push(`f ${face.map(vertex => vertex + 1).join(' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Read vertex positions and polygon faces from OBJ. UV/normal indices are accepted and ignored. */
export function readObj(text: string): PolygonMesh {
  const vertices: V3[] = [], faces: number[][] = [];
  for (const [lineIndex, source] of text.split(/\r?\n/).entries()) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/), kind = fields.shift();
    if (kind === 'v') {
      const point = fields.slice(0, 3).map(Number);
      if (point.length !== 3 || point.some(value => !Number.isFinite(value))) {
        throw new Error(`OBJ line ${lineIndex + 1} has an invalid vertex`);
      }
      vertices.push(point as V3);
    } else if (kind === 'f') {
      const face = fields.map(token => {
        const raw = Number(token.split('/')[0]);
        if (!Number.isInteger(raw) || raw === 0) throw new Error(`OBJ line ${lineIndex + 1} has an invalid face index`);
        return raw < 0 ? vertices.length + raw : raw - 1;
      });
      if (face.length < 3 || face.some(vertex => vertex < 0 || vertex >= vertices.length)) {
        throw new Error(`OBJ line ${lineIndex + 1} has a face outside the vertex pool`);
      }
      faces.push(face);
    }
  }
  if (!vertices.length || !faces.length) throw new Error('OBJ contains no polygon mesh');
  return { vertices, faces };
}

/** Fan-triangulate a polygon mesh without changing its vertex pool. */
export function triangulateFaces(mesh: PolygonMesh): [number, number, number][] {
  const triangles: [number, number, number][] = [];
  for (const face of mesh.faces) {
    for (let corner = 1; corner + 1 < face.length; corner++) {
      const triangle: [number, number, number] = [face[0], face[corner], face[corner + 1]];
      if (new Set(triangle).size === 3) triangles.push(triangle);
    }
  }
  return triangles;
}

/** Mean polygon-edge length (including shared edges once per incident face), matching QuadWild's scale basis. */
export function meanFaceEdgeLength(mesh: PolygonMesh): number {
  let total = 0, count = 0;
  for (const face of mesh.faces) for (let corner = 0; corner < face.length; corner++) {
    const a = mesh.vertices[face[corner]], b = mesh.vertices[face[(corner + 1) % face.length]];
    if (!a || !b) continue;
    total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    count++;
  }
  return count ? total / count : 0;
}
