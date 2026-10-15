// Bake first-party art through the public gear API. Native builds consume only
// the saved GLB and have no dependency on the authoring application's runtime.
import { createBoard } from '../../Slopesmith/src/app/ride/gear';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const board = createBoard('snowboard');
board.group.updateMatrixWorld(true);
const data: number[] = [];
const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
board.group.traverse(node => {
  if (!('isMesh' in node) || !node.isMesh) return;
  const mesh = node as import('three').Mesh;
  const geometry = mesh.geometry, position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const colours = geometry.getAttribute('color');
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const indices = geometry.index?.array ?? Array.from({ length: position.count }, (_, i) => i);
  for (let k = 0; k < indices.length; k++) {
    const i = Number(indices[k]), group = geometry.groups.find(g => k >= g.start && k < g.start + g.count);
    const material = materials[group?.materialIndex ?? 0] as import('three').MeshLambertMaterial;
    if (material.map || material.opacity !== 1) throw new Error('The stock board must have opaque vertex-colour art');
    const p = board.group.position.clone().set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(mesh.matrixWorld);
    const n = board.group.position.clone().set(normal.getX(i), normal.getY(i), normal.getZ(i)).transformDirection(mesh.matrixWorld);
    // The source nose is +Z; Native's board model nose is -Z. A half turn keeps
    // winding/normals intact, unlike mirroring one axis.
    const xyz = [-p.x, p.y, -p.z], rgb = material.color.toArray();
    if (material.vertexColors && colours) {
      rgb[0] *= colours.getX(i); rgb[1] *= colours.getY(i); rgb[2] *= colours.getZ(i);
    }
    data.push(...xyz, ...rgb, -n.x, n.y, -n.z);
    xyz.forEach((v, axis) => { low[axis] = Math.min(low[axis], v); high[axis] = Math.max(high[axis], v); });
  }
});
const count = data.length / 9;
const binary = Buffer.alloc(data.length * 4);
data.forEach((value, i) => binary.writeFloatLE(value, i * 4));
const gltf = {
  asset: { version: '2.0', generator: 'OpenSlope first-party gear art bake', copyright: 'OpenSlope contributors; Apache-2.0' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Slopesmith stock snowboard', mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1, NORMAL: 2 }, mode: 4 }] }],
  buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length, byteStride: 36, target: 34962 }],
  accessors: [0, 12, 24].map((byteOffset, index) => ({ bufferView: 0, byteOffset, componentType: 5126, count, type: 'VEC3', ...(index === 0 ? { min: low, max: high } : {}) })),
};
const json = Buffer.from(JSON.stringify(gltf)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
json.copy(padded);
const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + padded.length + binary.length, 8);
header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
const path = process.argv[2] ?? fileURLToPath(new URL('../assets/snowboard.glb', import.meta.url));
writeFileSync(path, Buffer.concat([header, padded, binHeader, binary]));
console.log(`Saved ${count / 3} first-party snowboard triangles to ${path}`);
