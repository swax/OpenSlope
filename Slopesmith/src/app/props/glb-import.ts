import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAX_IMPORT_SPINS, MAX_IMPORT_TRIS, importedEmittersFromExtras, importedMaterialFlipbook,
  importedMaterialScroll, importedPropName, importedSpinAnimation, importedSpinFromExtras,
  rawFromGltfDirection, rawFromGltfPoint,
  type ImportedEmitter, type ImportedPropRecord } from '../../core/props/imported';
import type { PropAlphaMode, PropModelAnimation } from '../../core/reference/props';
import type { UvScrollEffect } from '../../core/effects/world-effects';

/**
 * GLB → prop geometry. Turns a user's glTF binary into the per-material submeshes the prop pipeline already
 * speaks (`PropSub`), plus the base-colour images to stage into the Custom texture bank.
 *
 * The conversion is a straight change of frame, not a re-authoring: glTF is Y-up metres and so is the
 * editor, so the work is flattening the node hierarchy into world space and then applying the inverse
 * of the raw→editor map every prop stores its vertices in — editorFromRaw(x,y,z) = (−x/100, z/100, −y/100),
 * so rawFromEditor(x,y,z) = (−100x, −100z, 100y) (viewport/constants.ts).
 *
 * That map is ORIENTATION-REVERSING (a mirror), so the triangle order reverses with it — `a, c, b`. This is
 * not cosmetic and it is not about which side draws. A prop's normals are derived from its stored winding
 * (`computeVertexNormals` over the raw buffer, prop-assets.ts) and the hardware lights a face from that
 * normal alone — `ambient + Σ max(0, N·L)·key`, shown identically from both sides (docs/028). So mirroring
 * the positions without reversing the indices points every face INTO the model: it still draws, because prop
 * meshes are double-sided, but it draws ambient-only dark from every view, the editor's PS2 shading preview
 * shows it dark, the selection's facing arrows point inward, and it exports dark to the ISO.
 *
 * The authored-model bake reverses for exactly the same reason (`authoredModelLevelProps`, models.ts:
 * "reversed vs editor CCW — the raw mirror flips it back"), and retail agrees: every shipped prop measured
 * — GARI's boulders, SNOW's snow blower — encloses a POSITIVE signed volume in raw space, which is the
 * orientation this reversal reproduces.
 *
 * The UV V flip below is a separate, unrelated axis convention.
 *
 * Scale is taken as authored: 1 glTF unit = 1 metre = 100 raw cm. A model built in centimetres arrives 100×
 * too large, which is obvious on screen and fixed with ⇧scroll rather than guessed at here — the importer
 * reports the resulting footprint so the mistake is legible instead of silent.
 *
 * See docs/032-imported-props.md.
 */

/** Longest edge a staged base-colour image keeps. Matches the Texture Library's own custom-tile cap
 *  (MAX_CUSTOM_TEX): these land in the same bank and the server would shrink past it anyway, so capping
 *  here just keeps the upload small. */
const MAX_IMPORT_TEX = 512;

/** One (material, animated object) run of geometry, in the model-local raw cm / Z-up / X-mirrored space
 *  every prop stores. A submesh is split by BOTH because a material is how it draws and an object is how
 *  it moves: a snow gun's fan wears the same steel as its mast and still has to turn without it. */
export interface ImportedSub {
  mat: number;
  /** `animation.objects[]` index, omitted for geometry that does not move. */
  object?: number;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** A GLB converted and ready to stage: geometry plus, per material, the PNG to upload into the Custom bank. */
export interface ImportedPropDraft {
  name: string;
  tris: number;
  verts: number;
  /** Model footprint in editor metres (x, y, z), for the confirmation the importer reports. */
  size: [number, number, number];
  subs: ImportedSub[];
  /** Indexed by MATERIAL (`ImportedSub.mat`), not by submesh — several submeshes share a material when a
   *  model's moving and static parts are cut from the same page. The base-colour PNG to stage, or null
   *  for an untextured material (which renders as the neutral clay the prop pipeline falls back to). */
  textures: (Blob | null)[];
  /** Also by material: the surface motion the file declared for itself in glTF `extras`, or null.
   *  three.js parks a material's extras on `userData`, so this costs nothing to read — it is simply the
   *  one piece of the source file the importer used to drop on the floor. */
  scrolls: (UvScrollEffect | null)[];
  /** Also by material: the flipbook state list cut out of a declared filmstrip page, or null. Frame 0 is
   *  the same image `textures` carries, so staging uploads it once and the rest follow it into the bank. */
  flipbooks: (Blob[] | null)[];
  /** Explicit glTF MASK/BLEND law by material. null keeps the imported-page pixel classifier authoritative. */
  alphaModes: (PropAlphaMode | null)[];
  /** Particle emitters declared on the file's nodes, spawn points already converted into the same
   *  model-local raw frame as `subs` — including the horizontal re-centring. */
  emitters: ImportedEmitter[];
  /** The object-hierarchy clip built from the file's declared spins, or null when nothing turns. */
  animation: PropModelAnimation | null;
}

const loader = new GLTFLoader();

/** bytes → base64, chunked because String.fromCharCode's argument list is bounded and a 50k-triangle model
 *  is comfortably past it. */
function bytesToB64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Pack a converted draft into the record the server stores, given the tile ref staged for each material
 *  ("Custom/<name>.png", or null where the material had no art worth a bank slot). `frameTiles` carries the
 *  refs of a flipbook material's frames 1..N-1; frame 0 is the material's own tile, so the stored state list
 *  is that tile followed by them. */
export function draftToRecord(draft: ImportedPropDraft, tiles: (string | null)[],
  frameTiles: (string[] | null)[] = []): Omit<ImportedPropRecord, 'id'> {
  return {
    name: draft.name,
    tris: draft.tris,
    subs: draft.subs.map(s => ({
      mat: s.mat,
      pos: bytesToB64(s.positions),
      uv: bytesToB64(s.uvs),
      idx: bytesToB64(s.indices),
      ...(s.object !== undefined ? { object: s.object } : {}),
    })),
    // Over the MATERIALS, which is what `tiles` and `scrolls` are indexed by — a submesh list would
    // renumber the moment a model's moving part shares a page with the body it was cut from.
    materials: draft.textures.map((_, i) => {
      const rest = frameTiles[i];
      const base = tiles[i] ?? null;
      return {
        id: i,
        tex: base,
        ...(draft.alphaModes[i] ? { alphaMode: draft.alphaModes[i]!,
          ...(draft.alphaModes[i] === 'blend' ? { blend: true } : {}) } : {}),
        ...(draft.scrolls[i] ? { scroll: draft.scrolls[i]! } : {}),
        ...(base && rest?.length ? { frames: [base, ...rest] } : {}),
      };
    }),
    ...(draft.emitters.length ? { emitters: draft.emitters } : {}),
    ...(draft.animation ? { animation: draft.animation } : {}),
  };
}

/** Encode any canvas-drawable image to a PNG blob, shrunk to fit `max` on its longest edge. */
async function imageToPng(image: CanvasImageSource, max: number, alphaFactor = 1): Promise<Blob | null> {
  const w = (image as HTMLImageElement).naturalWidth || (image as ImageBitmap).width;
  const h = (image as HTMLImageElement).naturalHeight || (image as ImageBitmap).height;
  if (!w || !h) return null;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (alphaFactor < 1) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = Math.round(pixels.data[i] * alphaFactor);
    context.putImageData(pixels, 0, 0);
  }
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
}

/** Cut one frame out of a vertical filmstrip page and encode it as its own PNG. Band `index` of `count`,
 *  counted from the top, which is the reading order a painted strip is laid out in. */
async function imageBandToPng(image: CanvasImageSource, index: number, count: number,
  max: number, alphaFactor = 1): Promise<Blob | null> {
  const w = (image as HTMLImageElement).naturalWidth || (image as ImageBitmap).width;
  const h = (image as HTMLImageElement).naturalHeight || (image as ImageBitmap).height;
  if (!w || !h || count < 1) return null;
  const band = h / count;
  const scale = Math.min(1, max / Math.max(w, band));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(band * scale));
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, band * index, w, band,
    0, 0, canvas.width, canvas.height);
  if (alphaFactor < 1) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = Math.round(pixels.data[i] * alphaFactor);
    context.putImageData(pixels, 0, 0);
  }
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
}

/** A flat tile of a material's base colour, so a textureless-but-coloured GLB does not flatten to grey clay.
 *  8×8 rather than 1×1 because the bank's PS2 conform path reasons in power-of-two pages. */
async function solidColorPng(color: THREE.Color, alpha = 1): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, `
    + `${Math.round(color.b * 255)}, ${alpha})`;
  ctx.fillRect(0, 0, 8, 8);
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
}

/** The base-colour image of a glTF material, or a flat tile of its base-colour factor, or null when it is
 *  plain white (which the neutral clay already approximates — no point spending a bank slot on it). */
async function materialTexture(material: THREE.Material): Promise<Blob | null> {
  const standard = material as THREE.MeshStandardMaterial;
  const alphaMode = materialAlphaMode(material);
  const alpha = alphaMode ? Math.max(0, Math.min(1, standard.opacity)) : 1;
  const image = standard.map?.image as CanvasImageSource | undefined;
  if (image) {
    try { return await imageToPng(image, MAX_IMPORT_TEX, alpha); } catch { /* fall through to the colour */ }
  }
  const color = standard.color;
  if (!color) return null;
  const white = color.r > 0.98 && color.g > 0.98 && color.b > 0.98;
  return white && alpha === 1 ? null : solidColorPng(color, alpha);
}

/** Three's GLTFLoader maps glTF MASK to alphaTest and BLEND to transparent. OPAQUE and an omitted field are
 * intentionally both auto here, preserving the established conventional-PNG import behavior. */
function materialAlphaMode(material: THREE.Material | null | undefined): PropAlphaMode | null {
  if (!material) return null;
  return material.alphaTest > 0 ? 'cutout' : material.transparent ? 'blend' : null;
}

/** A material's flipbook as one PNG per frame, or null when it declared none. A declaration with no image
 *  behind it yields null rather than a list of colour swatches: a state list of one flat colour is not a
 *  flipbook, and staging it would spend bank slots on nothing. */
async function materialFlipbook(material: THREE.Material | null): Promise<Blob[] | null> {
  const count = material ? importedMaterialFlipbook(material.userData) : null;
  const image = (material as THREE.MeshStandardMaterial | null)?.map?.image as CanvasImageSource | undefined;
  if (!count || !image) return null;
  const alpha = materialAlphaMode(material) ? Math.max(0, Math.min(1,
    (material as THREE.MeshStandardMaterial).opacity)) : 1;
  try {
    const frames = await Promise.all(Array.from({ length: count },
      (_, index) => imageBandToPng(image, index, count, MAX_IMPORT_TEX, alpha)));
    return frames.every((frame): frame is Blob => !!frame) ? frames : null;
  } catch {
    return null;
  }
}

/** Every visible mesh in the scene, with the world matrix that flattens its node hierarchy. */
function collectMeshes(scene: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  scene.updateWorldMatrix(true, true);
  scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.getAttribute('position')) out.push(mesh);
  });
  return out;
}

/** Split a mesh into (material, geometry-group) pairs. GLTFLoader emits one mesh per glTF primitive, so
 *  this is usually a single pair — but a merged multi-material mesh carries `geometry.groups` instead. */
function meshParts(mesh: THREE.Mesh): { material: THREE.Material; start: number; count: number }[] {
  const geometry = mesh.geometry;
  const total = geometry.index?.count ?? geometry.getAttribute('position').count;
  if (!Array.isArray(mesh.material)) return [{ material: mesh.material, start: 0, count: total }];
  if (!geometry.groups.length) return [{ material: mesh.material[0], start: 0, count: total }];
  return geometry.groups.map(g => ({
    material: (mesh.material as THREE.Material[])[g.materialIndex ?? 0],
    start: g.start,
    count: g.count === Infinity ? total - g.start : g.count,
  }));
}

/**
 * Parse a GLB/glTF file into placeable prop geometry.
 *
 * Throws — with a message meant for a toast — when the file carries no renderable mesh or exceeds
 * MAX_IMPORT_TRIS. The cap is checked BEFORE any upload so a rejected model leaves nothing behind.
 */
export async function glbToPropDraft(file: File): Promise<ImportedPropDraft> {
  const gltf = await loader.parseAsync(await file.arrayBuffer(), '');
  const meshes = collectMeshes(gltf.scene);
  if (!meshes.length) throw new Error('no meshes in this file');

  // The nodes that declared a rotation, and — for every mesh — which of them it turns with. A mesh belongs to
  // the NEAREST declaring ancestor (itself included), so a whole assembly can be parented under one
  // spinning node without each piece having to repeat the declaration.
  const spinNodes: { node: THREE.Object3D; spin: NonNullable<ReturnType<typeof importedSpinFromExtras>> }[] = [];
  gltf.scene.traverse(node => {
    const spin = importedSpinFromExtras(node.userData);
    if (spin && spinNodes.length < MAX_IMPORT_SPINS) spinNodes.push({ node, spin });
  });
  const spinOrdinal = (mesh: THREE.Object3D): number => {
    for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
      const found = spinNodes.findIndex(s => s.node === node);
      if (found >= 0) return found;
    }
    return -1;
  };
  // A declared spin nested below another declared spin inherits that motion. Keep only the nearest one:
  // the clip builder already obtains every earlier ancestor through the resulting parent chain.
  const parentSpinOrdinal = (child: THREE.Object3D): number | undefined => {
    for (let node = child.parent; node; node = node.parent) {
      const found = spinNodes.findIndex(s => s.node === node);
      if (found >= 0) return found;
    }
    return undefined;
  };

  // Group by (material, spin): a material is how a run DRAWS and the spin is how it MOVES, and a submesh
  // carries one of each. Materials are numbered separately so several submeshes can share one page.
  const materials: (THREE.Material | undefined)[] = [];
  const materialIndex = new Map<string, number>();
  const byRun = new Map<string, { mat: number; spin: number; pos: number[]; uv: number[]; idx: number[] }>();
  const vertex = new THREE.Vector3();
  let tris = 0;

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const index = geometry.index;
    const spin = spinOrdinal(mesh);
    for (const part of meshParts(mesh)) {
      const materialKey = part.material?.uuid ?? 'none';
      let mat = materialIndex.get(materialKey);
      if (mat === undefined) {
        materialIndex.set(materialKey, mat = materials.length);
        materials.push(part.material);
      }
      const key = `${mat}|${spin}`;
      let bucket = byRun.get(key);
      if (!bucket) byRun.set(key, bucket = { mat, spin, pos: [], uv: [], idx: [] });
      // remap this part's vertices into the bucket, deduped per source vertex so shared corners stay shared
      const remap = new Map<number, number>();
      const emit = (source: number): number => {
        let mapped = remap.get(source);
        if (mapped === undefined) {
          mapped = bucket!.pos.length / 3;
          remap.set(source, mapped);
          // node hierarchy → world (editor metres, Y-up), then editor → raw (cm, Z-up, X-mirrored)
          vertex.fromBufferAttribute(position, source).applyMatrix4(mesh.matrixWorld);
          bucket!.pos.push(-100 * vertex.x, -100 * vertex.z, 100 * vertex.y);
          // glTF UV v runs top-down; prop UVs are raw OBJ vt (bottom-left origin, loaded with flipY)
          bucket!.uv.push(uv ? uv.getX(source) : 0, uv ? 1 - uv.getY(source) : 0);
        }
        return mapped;
      };
      for (let i = 0; i < part.count; i += 3) {
        const a = index ? index.getX(part.start + i) : part.start + i;
        const b = index ? index.getX(part.start + i + 1) : part.start + i + 1;
        const c = index ? index.getX(part.start + i + 2) : part.start + i + 2;
        bucket.idx.push(emit(a), emit(c), emit(b)); // reversed: the raw frame is a mirror (see above)
        tris++;
      }
    }
  }

  if (!tris) throw new Error('no triangles in this file');
  if (tris > MAX_IMPORT_TRIS) {
    throw new Error(`${tris.toLocaleString()} triangles exceeds the ${MAX_IMPORT_TRIS.toLocaleString()} limit`);
  }

  const runs = [...byRun.values()];
  const subs: ImportedSub[] = runs.map(b => ({
    mat: b.mat,
    positions: new Float32Array(b.pos),
    uvs: new Float32Array(b.uv),
    indices: new Uint32Array(b.idx),
  }));

  // Seat the model on its own origin: centre it horizontally (raw x/y) so a click drops it under the cursor
  // rather than wherever the exporter's origin happened to sit. Vertical (raw z) is left alone — propBaseOffset
  // reads the lowest vertex to stand the model on the terrain.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const sub of subs) {
    for (let i = 0; i < sub.positions.length; i += 3) {
      minX = Math.min(minX, sub.positions[i]); maxX = Math.max(maxX, sub.positions[i]);
      minY = Math.min(minY, sub.positions[i + 1]); maxY = Math.max(maxY, sub.positions[i + 1]);
      minZ = Math.min(minZ, sub.positions[i + 2]); maxZ = Math.max(maxZ, sub.positions[i + 2]);
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (const sub of subs) {
    for (let i = 0; i < sub.positions.length; i += 3) { sub.positions[i] -= cx; sub.positions[i + 1] -= cy; }
  }

  // Emitters, put through the SAME transform the vertices just took — frame change and re-centring
  // both. Doing only the frame change leaves a spawn point sitting wherever the exporter's origin
  // happened to be, which is a metre or two off the muzzle and looks like a physics bug rather than
  // an import one. Declared on nodes rather than materials because an emitter is a point.
  const emitters: ImportedEmitter[] = [];
  gltf.scene.traverse(node => {
    for (const found of importedEmittersFromExtras(node.userData)) {
      vertex.set(found.at[0], found.at[1], found.at[2]).applyMatrix4(node.matrixWorld);
      const [rx, ry, rz] = rawFromGltfPoint([vertex.x, vertex.y, vertex.z], cx, cy);
      found.emitter.fields.U9 = rx;
      found.emitter.fields.U10 = ry;
      found.emitter.fields.U11 = rz;
      emitters.push(found.emitter);
    }
  });

  // The clip, built AFTER the re-centring for the same reason the emitters are: a pivot is a point, and a
  // point that skipped the shift turns the fan about somewhere off in front of the machine. The axis is a
  // direction — it takes the frame change without the shift, through the node's own world rotation so a
  // declaration stays local to the node that made it.
  const spun = importedSpinAnimation(spinNodes.map(({ node, spin }) => {
    node.updateWorldMatrix(true, false);
    vertex.setFromMatrixPosition(node.matrixWorld);
    const axis = new THREE.Vector3(spin.axis[0], spin.axis[1], spin.axis[2])
      .transformDirection(node.matrixWorld);
    const base = {
      pivot: rawFromGltfPoint([vertex.x, vertex.y, vertex.z], cx, cy),
      axis: rawFromGltfDirection([axis.x, axis.y, axis.z]),
      parent: parentSpinOrdinal(node),
    };
    return spin.revsPerSecond !== undefined
      ? { ...base, revsPerSecond: spin.revsPerSecond }
      : { ...base, amplitudeDegrees: spin.amplitudeDegrees, periodSeconds: spin.periodSeconds };
  }));
  if (spun) {
    for (const [i, sub] of subs.entries()) {
      const ordinal = runs[i].spin;
      sub.object = ordinal >= 0 ? spun.objectOf[ordinal] : 0;
    }
  }

  const flipbooks = await Promise.all(materials.map(m => materialFlipbook(m ?? null)));
  // A flipbook material's own page is the whole filmstrip, so its base tile is frame 0 rather than the
  // uncut image — otherwise the prop would render every frame at once, stacked.
  const textures = await Promise.all(materials.map(async (m, i) =>
    flipbooks[i]?.[0] ?? (m ? materialTexture(m) : null)));
  const scrolls = materials.map(m => importedMaterialScroll(m?.userData));
  const alphaModes = materials.map(materialAlphaMode);
  const verts = subs.reduce((n, s) => n + s.positions.length / 3, 0);
  return {
    name: importedPropName(file.name),
    tris,
    verts,
    // back to editor metres for a footprint the user can compare against the mountain
    size: [(maxX - minX) / 100, (maxZ - minZ) / 100, (maxY - minY) / 100],
    subs,
    textures,
    scrolls,
    flipbooks,
    alphaModes,
    emitters,
    animation: spun?.animation ?? null,
  };
}
