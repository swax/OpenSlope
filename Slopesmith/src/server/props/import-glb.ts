import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import {
  MAX_IMPORT_SPINS, MAX_IMPORT_TRIS, importedEmittersFromExtras, importedMaterialFlipbook,
  importedMaterialScroll, importedPropName, importedSpinAnimation, importedSpinFromExtras,
  rawFromGltfDirection, rawFromGltfPoint,
  type ImportedEmitter, type ImportedPropRecord,
} from '../../core/props/imported';
import {
  decodeGlb, matrixPosition, transformDirection, transformPoint,
  type DecodedGltf, type GltfMaterial,
} from '../../core/props/glb-decode';
import { CUSTOM_TEX_LEVEL, makeTexRef } from '../../core/paint/textures';
import type { PropAlphaMode, PropModelAnimation } from '../../core/reference/props';
import type { UvScrollEffect } from '../../core/effects/world-effects';
import type { Rgba } from '../../core/paint/ground-textures';
import { decodePng, encodePng } from '../routes/png';
import { MAX_CUSTOM_TEX, saveSharedCustomTexture, shrinkToFit } from '../routes/textures';

/**
 * GLB → `ImportedPropRecord`, with no browser in the loop.
 *
 * The headless twin of `app/props/glb-import.ts`, which stays the reference: it is the path a user's drag
 * onto the Prop Library takes, and every rule below is copied from it deliberately rather than re-derived,
 * because two importers that disagree about winding or re-centring would ship props that look right from
 * whichever half was tested. What differs is only the machinery underneath — `glb-decode.ts` instead of
 * three.js's `GLTFLoader`, `png.ts` instead of a canvas, `Buffer` instead of `Blob` — and the two are
 * checked against each other by the same claim `tools/prop-recipes/check.py` makes: a closed prop's stored
 * geometry encloses a POSITIVE raw volume (test/glb-import.test.ts).
 *
 * This is what lets a recipe finish the job. `tools/prop-recipes/` already builds committed GLBs; until now
 * the last step — getting one into a project — was a human dragging the file into a panel, which is not a
 * step a script can take and not one that can be repeated identically for eighteen props.
 *
 * See docs/032-imported-props.md.
 */

/** One (material, animated object) run of geometry, in the model-local raw cm / Z-up / X-mirrored space
 *  every prop stores. Split by BOTH because a material is how a run draws and an object is how it moves. */
export interface HeadlessSub {
  mat: number;
  /** `animation.objects[]` index, omitted for geometry that does not move. */
  object?: number;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** A converted GLB, ready to stage: geometry plus, per MATERIAL, the PNG to put in the Custom bank. */
export interface HeadlessPropDraft {
  name: string;
  tris: number;
  verts: number;
  /** Model footprint in editor metres (x, y, z) — the confirmation the browser importer toasts. */
  size: [number, number, number];
  subs: HeadlessSub[];
  /** Indexed by MATERIAL, not by submesh: several submeshes share a material when a model's moving and
   *  static parts are cut from the same page. null = untextured, which renders as neutral clay. */
  textures: (Buffer | null)[];
  /** Also by material: the surface motion the file declared for itself in glTF `extras`, or null. */
  scrolls: (UvScrollEffect | null)[];
  /** Also by material: the flipbook state list cut out of a declared filmstrip page, or null. Frame 0 is
   *  the same image `textures` carries, so staging writes it once and the rest follow it into the bank. */
  flipbooks: (Buffer[] | null)[];
  /** Explicit glTF MASK/BLEND law by material. null keeps conventional PNG pixel inference. */
  alphaModes: (PropAlphaMode | null)[];
  /** Emitters the file's nodes declared, spawn points already in the same model-local raw frame as `subs`
   *  — the horizontal re-centring included. */
  emitters: ImportedEmitter[];
  /** The object-hierarchy clip built from the file's declared spins, or null when nothing turns. */
  animation: PropModelAnimation | null;
}

export interface GlbImportOptions {
  /** The name the file arrived under. Sets the display name and the default tile stem, exactly as the
   *  browser importer takes them from the dropped `File`. */
  fileName?: string;
  /** Display name override, for a caller that has a better one than the file stem. */
  name?: string;
  /**
   * The stem the staged base-colour art takes in the Custom bank, instead of the file's own.
   *
   * This is the KIT lever. A set of props cut from one shared atlas should reference ONE tile, not one copy
   * each: passing the same `tileName` for all of them means the first import writes the page and the rest
   * recognise their own bytes already in the bank and reference them (`saveSharedCustomTexture`). Props
   * with genuinely different art under one name still land beside each other, so this can only ever save a
   * slot, never merge two pictures.
   */
  tileName?: string;
  /** Resolve an image the file referenced by relative URI rather than embedding. `importGlbFile` supplies
   *  one that reads from the GLB's own folder; a caller holding bytes alone can leave it out. */
  readImage?(uri: string): Promise<Uint8Array | null>;
}

/** Longest edge a staged base-colour image keeps — the Custom bank's own cap, since these land in it and
 *  `saveCustomTexture` would shrink past it anyway. Matches `MAX_IMPORT_TEX` in the browser importer. */
const MAX_IMPORT_TEX = MAX_CUSTOM_TEX;

/** Typed array → base64, the packing `PropsPayload` already uses on the wire (tools/re-canaries/make.ts). */
const b64 = (view: ArrayBufferView): string =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');

/** Linear (what glTF stores) → sRGB (what a PNG holds), so a flat tile cut from `baseColorFactor` is the
 *  colour the browser importer's canvas would have painted. */
function srgbByte(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/** Re-encode an image to the bank's flavour: plain 8-bit RGBA, shrunk to fit `MAX_IMPORT_TEX`. */
const toBankPng = (image: Rgba): Buffer => encodePng(shrinkToFit(image, MAX_IMPORT_TEX));

/** Cut one frame out of a vertical filmstrip page. Band `index` of `count`, counted from the TOP, which is
 *  the reading order a painted strip is laid out in. Rows are taken by slicing the decoded pixels, so a
 *  page whose height does not divide evenly loses a row at a seam rather than shifting every later frame. */
function imageBand(image: Rgba, index: number, count: number): Rgba {
  const y0 = Math.round((image.h * index) / count);
  const y1 = Math.max(y0 + 1, Math.round((image.h * (index + 1)) / count));
  const rows = Math.min(image.h, y1) - y0;
  return { w: image.w, h: rows, data: image.data.slice(y0 * image.w * 4, (y0 + rows) * image.w * 4) };
}

/** A flat tile of a material's base colour, so a textureless-but-coloured GLB does not flatten to grey
 *  clay. 8×8 rather than 1×1 because the bank's PS2 conform path reasons in power-of-two pages. */
function solidColorPng(factor: readonly number[], keepAlpha = false): Buffer {
  const data = new Uint8Array(8 * 8 * 4);
  const [r, g, b] = [srgbByte(factor[0]), srgbByte(factor[1]), srgbByte(factor[2])];
  for (let i = 0; i < 8 * 8; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b;
    data[i * 4 + 3] = keepAlpha ? Math.round(Math.max(0, Math.min(1, factor[3] ?? 1)) * 255) : 255;
  }
  return encodePng({ w: 8, h: 8, data });
}

/** A material's base-colour image as decoded pixels, or null — embedded bytes first, then whatever the
 *  caller can resolve for a `uri`. A page this decoder cannot read is treated as absent rather than fatal:
 *  the material falls back to its colour, which is what the browser's canvas path does on a decode error. */
async function materialImage(gltf: DecodedGltf, material: GltfMaterial | null,
  opts: GlbImportOptions): Promise<Rgba | null> {
  const source = material?.baseColorImage ?? null;
  const image = source === null ? null : gltf.images[source] ?? null;
  if (!image) return null;
  const bytes = image.bytes ?? (image.uri ? await opts.readImage?.(image.uri) ?? null : null);
  if (!bytes) return null;
  try {
    const decoded = decodePng(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (materialAlphaMode(material) && (material?.baseColorFactor[3] ?? 1) < 1) {
      const factor = Math.max(0, Math.min(1, material?.baseColorFactor[3] ?? 1));
      for (let i = 3; i < decoded.data.length; i += 4) decoded.data[i] = Math.round(decoded.data[i] * factor);
    }
    return decoded;
  } catch {
    return null;
  }
}

/** Preserve only authored MASK/BLEND. Omitted/default OPAQUE remains pixel-auto for compatibility with the
 * conventional RGBA pages Slopesmith imported before explicit mode support. */
function materialAlphaMode(material: GltfMaterial | null | undefined): PropAlphaMode | null {
  return material?.alphaMode === 'MASK' ? 'cutout' : material?.alphaMode === 'BLEND' ? 'blend' : null;
}

/**
 * Convert a GLB into placeable prop geometry — the headless `glbToPropDraft`.
 *
 * Throws, with a message meant for a toast or a console line, when the file carries no renderable mesh or
 * exceeds `MAX_IMPORT_TRIS`. The cap is checked BEFORE any image is encoded and long before anything is
 * staged, so a refused model leaves nothing behind in the texture bank.
 */
export async function glbPropDraft(bytes: Uint8Array, opts: GlbImportOptions = {}):
Promise<HeadlessPropDraft> {
  const gltf = decodeGlb(bytes);
  const drawn = gltf.nodes.filter(node => node.mesh !== null && gltf.meshes[node.mesh]?.primitives.length);
  if (!drawn.length) throw new Error('no meshes in this file');

  // The nodes that declared a rotation, and — for every mesh — which of them it turns with. A mesh belongs
  // to the NEAREST declaring ancestor (itself included), so a whole assembly can be parented under one
  // spinning node without each piece having to repeat the declaration.
  const spinNodes: { node: number; spin: NonNullable<ReturnType<typeof importedSpinFromExtras>> }[] = [];
  for (const node of gltf.nodes) {
    const spin = importedSpinFromExtras(node.extras);
    if (spin && spinNodes.length < MAX_IMPORT_SPINS) spinNodes.push({ node: node.index, spin });
  }
  const ordinalOf = (node: number): number => spinNodes.findIndex(s => s.node === node);
  const spinOrdinal = (start: number): number => {
    for (let node = start; node >= 0; node = gltf.nodes[node].parent) {
      const found = ordinalOf(node);
      if (found >= 0) return found;
    }
    return -1;
  };
  // A declared spin nested below another inherits that motion. Keep only the nearest one: the clip builder
  // already obtains every earlier ancestor through the resulting parent chain.
  const parentSpinOrdinal = (child: number): number | undefined => {
    const found = spinOrdinal(gltf.nodes[child].parent);
    return found >= 0 ? found : undefined;
  };

  // Group by (material, spin): a material is how a run DRAWS and the spin is how it MOVES, and a submesh
  // carries one of each. Materials are numbered separately so several submeshes can share one page.
  const materials: (GltfMaterial | null)[] = [];
  const materialIndex = new Map<string, number>();
  const byRun = new Map<string, { mat: number; spin: number; pos: number[]; uv: number[]; idx: number[] }>();
  let tris = 0;

  for (const node of drawn) {
    const spin = spinOrdinal(node.index);
    for (const part of gltf.meshes[node.mesh!].primitives) {
      const materialKey = part.material === null ? 'none' : `m${part.material}`;
      let mat = materialIndex.get(materialKey);
      if (mat === undefined) {
        materialIndex.set(materialKey, mat = materials.length);
        materials.push(part.material === null ? null : gltf.materials[part.material] ?? null);
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
          const [x, y, z] = transformPoint(node.world,
            [part.positions[source * 3], part.positions[source * 3 + 1], part.positions[source * 3 + 2]]);
          bucket!.pos.push(-100 * x, -100 * z, 100 * y);
          // glTF UV v runs top-down; prop UVs are raw OBJ vt (bottom-left origin, loaded with flipY)
          bucket!.uv.push(part.uvs ? part.uvs[source * 2] : 0, part.uvs ? 1 - part.uvs[source * 2 + 1] : 0);
        }
        return mapped;
      };
      const corners = part.indices?.length ?? part.positions.length / 3;
      for (let i = 0; i + 2 < corners; i += 3) {
        const a = part.indices ? part.indices[i] : i;
        const b = part.indices ? part.indices[i + 1] : i + 1;
        const c = part.indices ? part.indices[i + 2] : i + 2;
        // Reversed — `a, c, b`. The raw frame is a MIRROR of the editor's, and a prop's normals come from
        // its stored winding alone (`computeVertexNormals` over the raw buffer), so mirroring the positions
        // without reversing the indices points every face INTO the model. It still draws, because prop
        // meshes are double-sided, and it draws ambient-only dark from every view — in the editor, in the
        // thumbnails and on the disc. Every retail prop measured encloses a POSITIVE raw volume, which is
        // the orientation this reversal reproduces; `check.py` asserts it, and so does this importer's test.
        bucket.idx.push(emit(a), emit(c), emit(b));
        tris++;
      }
    }
  }

  if (!tris) throw new Error('no triangles in this file');
  if (tris > MAX_IMPORT_TRIS) {
    throw new Error(`${tris.toLocaleString()} triangles exceeds the ${MAX_IMPORT_TRIS.toLocaleString()} limit`);
  }

  const runs = [...byRun.values()];
  const subs: HeadlessSub[] = runs.map(b => ({
    mat: b.mat,
    positions: new Float32Array(b.pos),
    uvs: new Float32Array(b.uv),
    indices: new Uint32Array(b.idx),
  }));

  // Seat the model on its own origin: centre it horizontally (raw x/y) so a placement drops it under the
  // cursor rather than wherever the exporter's origin happened to sit. Vertical (raw z) is left alone —
  // `propBaseOffset` reads the lowest vertex to stand the model on the terrain.
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

  // Emitters, put through the SAME transform the vertices just took — frame change and re-centring both.
  // Doing only the frame change leaves a spawn point sitting wherever the exporter's origin happened to be,
  // which is a metre or two off the muzzle and reads as a physics bug rather than an import one.
  const emitters: ImportedEmitter[] = [];
  for (const node of gltf.nodes) {
    for (const found of importedEmittersFromExtras(node.extras)) {
      const world = transformPoint(node.world, found.at);
      const [rx, ry, rz] = rawFromGltfPoint(world, cx, cy);
      found.emitter.fields.U9 = rx;
      found.emitter.fields.U10 = ry;
      found.emitter.fields.U11 = rz;
      emitters.push(found.emitter);
    }
  }

  // The clip, built AFTER the re-centring for the same reason the emitters are: a pivot is a POINT, and one
  // that skipped the shift turns the fan about somewhere off in front of the machine. The axis is a
  // DIRECTION — it takes the frame change without the shift, through the node's own world rotation so a
  // declaration stays local to the node that made it.
  const spun = importedSpinAnimation(spinNodes.map(({ node, spin }) => {
    const world = gltf.nodes[node].world;
    const base = {
      pivot: rawFromGltfPoint(matrixPosition(world), cx, cy),
      axis: rawFromGltfDirection(transformDirection(world, spin.axis)),
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

  const pages = await Promise.all(materials.map(m => materialImage(gltf, m, opts)));
  // A flipbook declaration with no image behind it yields null rather than a list of colour swatches: a
  // state list of one flat colour is not a flipbook, and staging it would spend bank slots on nothing.
  const flipbooks = materials.map((material, i) => {
    const count = material ? importedMaterialFlipbook(material.extras) : null;
    const page = pages[i];
    return count && page
      ? Array.from({ length: count }, (_frame, index) => toBankPng(imageBand(page, index, count)))
      : null;
  });
  // A flipbook material's own page is the whole filmstrip, so its base tile is frame 0 rather than the
  // uncut image — otherwise the prop would render every frame at once, stacked.
  const textures = materials.map((material, i) => {
    const strip = flipbooks[i];
    if (strip) return strip[0];
    if (pages[i]) return toBankPng(pages[i]!);
    const factor = material?.baseColorFactor;
    // Plain white is what the neutral clay already approximates — no point spending a bank slot on it.
    if (!factor || ((factor[0] > 0.98 && factor[1] > 0.98 && factor[2] > 0.98)
      && (!materialAlphaMode(material) || factor[3] >= 0.999))) return null;
    return solidColorPng(factor, !!materialAlphaMode(material));
  });
  const scrolls = materials.map(m => importedMaterialScroll(m?.extras));
  const alphaModes = materials.map(materialAlphaMode);
  const verts = subs.reduce((n, s) => n + s.positions.length / 3, 0);
  return {
    name: opts.name ?? importedPropName(opts.fileName ?? 'prop.glb'),
    tris,
    verts,
    // back to editor metres for a footprint the caller can compare against the mountain
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

/**
 * Put a converted draft's art in the open mountain's texture bank and pack the result into its stored record.
 *
 * The refs are "Custom/<name>.png" — the cross-level form `resolvePropTex` already resolves — so an
 * imported model's art shows up in the Texture Library like any other custom tile and needs no serving
 * route of its own (docs/005). Staging goes through `saveSharedCustomTexture` rather than the plain upload
 * so a kit built from one atlas costs one bank slot; see `GlbImportOptions.tileName`.
 */
export async function stagePropDraft(draft: HeadlessPropDraft, opts: GlbImportOptions = {}):
Promise<Omit<ImportedPropRecord, 'id'>> {
  const fallback = (opts.fileName ?? draft.name).replace(/\.(glb|gltf)$/i, '');
  // With an explicit kit name, material 0 IS that name — a shared atlas should read as the atlas it is.
  // Later materials take a suffix outside the `_2`, `_3` variant alphabet so a second material can never
  // be mistaken for a collision-dodging copy of the first.
  const stemFor = (mat: number) => opts.tileName
    ? (mat === 0 ? opts.tileName : `${opts.tileName}_m${mat}`)
    : `${fallback}_${mat}`;

  const tiles: (string | null)[] = [];
  const frames: (string[] | null)[] = [];
  for (const [mat, png] of draft.textures.entries()) {
    if (!png) { tiles.push(null); frames.push(null); continue; }
    const stored = await saveSharedCustomTexture(stemFor(mat), png);
    tiles.push(makeTexRef(CUSTOM_TEX_LEVEL, stored));
    const book = draft.flipbooks[mat];
    // Frame 0 is the material's own tile, already staged, so only 1..N-1 are new files here. They are named
    // off the stem frame 0 actually GOT rather than the one it asked for, so a strip whose base stepped
    // aside for a taken name does not leave its own frames sitting under the name it did not get.
    const base = stored.replace(/\.png$/i, '');
    frames.push(book
      ? await Promise.all(book.slice(1).map(async (frame, index) =>
        makeTexRef(CUSTOM_TEX_LEVEL, await saveSharedCustomTexture(`${base}_f${index + 1}`, frame))))
      : null);
  }

  return {
    name: draft.name,
    tris: draft.tris,
    subs: draft.subs.map(s => ({
      mat: s.mat,
      pos: b64(s.positions),
      uv: b64(s.uvs),
      idx: b64(s.indices),
      ...(s.object !== undefined ? { object: s.object } : {}),
    })),
    // Over the MATERIALS, which is what `tiles` and `scrolls` are indexed by — a submesh list would
    // renumber the moment a model's moving part shares a page with the body it was cut from.
    materials: draft.textures.map((_png, mat) => {
      const rest = frames[mat];
      const base = tiles[mat];
      return {
        id: mat,
        tex: base,
        ...(draft.alphaModes[mat] ? { alphaMode: draft.alphaModes[mat]!,
          ...(draft.alphaModes[mat] === 'blend' ? { blend: true } : {}) } : {}),
        ...(draft.scrolls[mat] ? { scroll: draft.scrolls[mat]! } : {}),
        ...(base && rest?.length ? { frames: [base, ...rest] } : {}),
      };
    }),
    ...(draft.emitters.length ? { emitters: draft.emitters } : {}),
    ...(draft.animation ? { animation: draft.animation } : {}),
  };
}

/** GLB bytes → the record `saveImportedProp` stores, art staged. The caller still chooses whether this is a
 *  new model (`saveImportedProp`, its own number) or new geometry on one already placed
 *  (`replaceImportedProp`, the same number) — that decision belongs to whoever knows the catalogue. */
export async function importGlbRecord(bytes: Uint8Array, opts: GlbImportOptions = {}):
Promise<Omit<ImportedPropRecord, 'id'>> {
  return stagePropDraft(await glbPropDraft(bytes, opts), opts);
}

/** The same, from a file on disk — the entry point a recipe script calls. An image the GLB referenced by
 *  relative URI is read from the model's OWN folder and nowhere else, so a file naming `../../secrets.png`
 *  gets a missing texture rather than a copy of it in the bank. */
export async function importGlbFile(path: string, opts: GlbImportOptions = {}):
Promise<Omit<ImportedPropRecord, 'id'>> {
  const file = resolve(path);
  const folder = dirname(file);
  return importGlbRecord(await readFile(file), {
    fileName: basename(file),
    readImage: async uri => {
      const target = resolve(folder, decodeURIComponent(uri));
      if (target !== folder && !target.startsWith(folder + sep)) return null;
      return readFile(target).catch(() => null);
    },
    ...opts,
  });
}
