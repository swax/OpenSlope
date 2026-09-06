import type { AuthoredModel, PlacedProp, QuadMeshDoc, V3 } from './types';
import { seedMeshIds } from './ids';
import { orientUV } from '../paint/orientation';
import type { LevelProps } from '../reference/props';
import {
  applyQuat, conjugateQuat, isTilted, multiplyQuat, placementQuat, propRotationFromQuat, rotateByPlacement,
  writePropRotation, type PropRotation,
} from '../props/pose';

/**
 * Authored polygon models (docs/026-successor: model editing): the definition/instance split over the
 * mesh tools. A model's mesh lives in its own record under `mdoc.models` — never in the terrain net — in
 * WORLD coordinates at the spot it was built. Editing materializes it as a `linearCage` QuadMeshDoc the
 * ordinary edit stack operates on (the wrapper SHARES the model's arrays, so in-place vertex drags land
 * in the document with no write-back step); pure topology ops replace arrays, which `commitModelEditDoc`
 * copies back, dropping any curvature channel an op wrote — a model's flat cage is derived, never stored.
 */

export function nextModelId(models: readonly AuthoredModel[]): string {
  const used = new Set(models.map(model => model.id));
  for (let i = 0; ; i++) {
    const id = `model:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

export function createAuthoredModel(mdoc: QuadMeshDoc, name: string): AuthoredModel {
  const models = (mdoc.models ??= []);
  const model: AuthoredModel = {
    id: nextModelId(models), name: name || 'Model',
    anchor: [0, 0, 0], vertices: [], quads: [],
  };
  models.push(model);
  return model;
}

export function findModel(mdoc: QuadMeshDoc, id: string | null | undefined): AuthoredModel | null {
  return id ? mdoc.models?.find(model => model.id === id) ?? null : null;
}

/**
 * Materialize a model as the QuadMeshDoc the edit stack (ops, selection, viewport substrate) operates on.
 * Mesh fields are the model's OWN arrays — an in-place mutation (gizmo drag, setVertex) is immediately the
 * document's state, so undo snapshots and persistence always see the live mesh. The mountain meta fields
 * ride along solely to satisfy the doc shape; commit never reads them back. Vertex / quad identity is minted
 * per session for the ops contract to carry and dropped at commit, because a model record stores none
 * (types.ts `AuthoredModel`).
 */
export function modelEditDocFor(mdoc: QuadMeshDoc, model: AuthoredModel): QuadMeshDoc {
  return {
    version: 5, kind: 'mountain', name: model.name,
    spacing: mdoc.spacing, course: mdoc.course, baseSurface: mdoc.baseSurface,
    vertices: model.vertices, quads: model.quads,
    ...seedMeshIds(0, model.vertices.length / 3, model.quads.length),
    ...(model.freeEdges ? { freeEdges: model.freeEdges } : {}),
    ...(model.tJunctions ? { tJunctions: model.tJunctions } : {}),
    ...(model.quadLocked ? { quadLocked: model.quadLocked } : {}),
    // the substrate WEARS the model's uniform tile AT its orientation (both derived per materialize, never
    // written back), so the edit session previews the same texture, the same way up, its placements render
    // with — including the tile-orientation F overlay, which reads the same per-quad channel the terrain does
    ...(model.texture ? { quadTex: Object.fromEntries(model.quads.map((_, q) => [q, model.texture!])) } : {}),
    ...(model.texture && model.orient
      ? { quadOrient: Object.fromEntries(model.quads.map((_, q) => [q, { ...model.orient! }])) } : {}),
    linearCage: true,
  };
}

/**
 * The tile UV one quad corner wears: the FULL 0–1 rect, A(0,0) B(1,0) C(0,1) D(1,1) — V down the A→C spine
 * — turned through the model's D4 (`AuthoredModel.orient`).
 *
 * ONE definition for a rule that has to hold in three places at once: the viewport bake
 * (`authoredModelLevelProps`), the export bake (`bakeAuthoredModelProps` in core/export/props.ts), and the
 * edit substrate, which reaches it as a derived per-quad `quadOrient` rather than through this function.
 * They used to hold a private `CORNER_UV` each, which was harmless while the mapping was a constant and is
 * not once it has a state — a turn that reached the preview but not the export would be invisible until an
 * ISO was built. A wedge's collapsed third corner takes the tile's top CENTRE, so its two edges stay
 * symmetric about the tile whichever way the tile is turned.
 */
const CORNER_UV: readonly [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
export function tiledPropUV(corner: number, wedge: boolean,
  orient?: { rot: number; mirror: boolean }): [number, number] {
  const [u, v] = wedge && corner === 2 ? [0.5, 1] : CORNER_UV[corner];
  return orient ? orientUV(u, v, orient.rot, orient.mirror) : [u, v];
}

/** The base-centre of a mesh: bbox centre at min-Y — the natural placement origin for a prop. */
function baseCentre(vertices: readonly number[]): V3 {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    minX = Math.min(minX, vertices[i]); maxX = Math.max(maxX, vertices[i]);
    minY = Math.min(minY, vertices[i + 1]);
    minZ = Math.min(minZ, vertices[i + 2]); maxZ = Math.max(maxZ, vertices[i + 2]);
  }
  return [(minX + maxX) / 2, minY, (minZ + maxZ) / 2];
}

/**
 * Write a pure op's result doc back into the model record. Only the mesh + texture channels return;
 * curvature an op wrote (split-inherited handles, re-cut twist) is DROPPED — under the linear cage the
 * chord/3 default reproduces the exact same flat shape, so the model self-heals to curvature-free.
 * The first geometry to land also seats the model's placement anchor at its base centre.
 */
export function commitModelEditDoc(model: AuthoredModel, doc: QuadMeshDoc): void {
  const hadGeometry = model.vertices.length > 0;
  model.vertices = doc.vertices;
  model.quads = doc.quads;
  if (doc.freeEdges?.length) model.freeEdges = doc.freeEdges; else delete model.freeEdges;
  if (doc.tJunctions?.length) model.tJunctions = doc.tJunctions; else delete model.tJunctions;
  if (doc.quadLocked && Object.keys(doc.quadLocked).length) model.quadLocked = doc.quadLocked; else delete model.quadLocked;
  // quadTex / quadOrient are DERIVED from model.texture + model.orient at materialize time (and curvature
  // channels are never stored) — none write back, so the model record stays the lean polygon + one-tile form.
  if (!hadGeometry && model.vertices.length) model.anchor = baseCentre(model.vertices);
}

/**
 * REVISE a reference prop into an authored model (docs/028): bake ONE placement's posed triangle mesh into
 * a new model record — the exact inverse of `authoredModelLevelProps`' vertex/winding mapping (raw cm,
 * Z-up, X negated), so a converted model re-bakes to the same raw triangles. Per-corner vertices weld back
 * to shared ids and every triangle lands as a wedge quad the mesh tools can edit. UVs/materials do NOT
 * carry: a model wears one uniform tile — assign one after (a Custom tile can carry the prop's own art).
 */
export function reviseModelFromProp(
  mdoc: QuadMeshDoc, name: string,
  subs: readonly { positions: Float32Array; indices: ArrayLike<number> }[],
  pose: { pos: V3; yaw: number; pitch?: number; roll?: number; scale: number },
): AuthoredModel {
  const model = createAuthoredModel(mdoc, name);
  const k = pose.scale;
  const vertices: number[] = [];
  const quads: [number, number, number, number][] = [];
  const idOf = new Map<string, number>(); // welds per-corner duplicates back to shared ids, across submeshes
  for (const sub of subs) {
    const vertexAt = (corner: number): number => {
      const rx = sub.positions[corner * 3], ry = sub.positions[corner * 3 + 1], rz = sub.positions[corner * 3 + 2];
      const key = `${rx},${ry},${rz}`;
      const known = idOf.get(key);
      if (known !== undefined) return known;
      // raw model-local (cm, Z-up, X negated) → editor-local metres, then the placement pose (T · R · S)
      const local: V3 = [k * (-rx / 100), k * (rz / 100), k * (-ry / 100)];
      const r = rotateByPlacement(local, pose);
      const id = vertices.length / 3;
      vertices.push(pose.pos[0] + r[0], pose.pos[1] + r[1], pose.pos[2] + r[2]);
      idOf.set(key, id);
      return id;
    };
    for (let t = 0; t + 2 < sub.indices.length; t += 3) {
      // authoredModelLevelProps emits wedge [A,B,C] as the raw triangle (A, C, B); invert that here
      const A = vertexAt(sub.indices[t]), C = vertexAt(sub.indices[t + 1]), B = vertexAt(sub.indices[t + 2]);
      if (A === B || B === C || C === A) continue; // a weld collapsed the source triangle
      quads.push([A, B, C, C]);
    }
  }
  model.vertices = vertices;
  model.quads = quads;
  if (vertices.length) model.anchor = baseCentre(vertices);
  return model;
}

/**
 * REBASE a model's stored frame onto one of its placements: the placement's pose bakes into the
 * world-space vertices (the definition re-materializes exactly where that placement stands, and the
 * placement becomes the identity/home pose at its own position), while every OTHER placement's rotation and
 * scale re-derive so nothing rendered moves — translate·rotate·uniform-scale poses compose closed, so the
 * re-parenting is exact. This is what lets an edit session open AT the placement that was clicked while
 * edits still flow to every placement of the model (the definition stays shared). Returns the absorbed
 * rotation/scale (the caller re-frames attached emitter offsets with it), or null when the placement already
 * IS the home pose.
 */
export function rebaseModelToPlacement(mdoc: QuadMeshDoc, model: AuthoredModel, placement: PlacedProp):
{ rotation: PropRotation; scale: number } | null {
  if (placement.level !== AUTHORED_MODEL_LEVEL || modelIdFromNumber(placement.model) !== model.id) return null;
  const { scale } = placement;
  if (placement.yaw === 0 && !isTilted(placement) && scale === 1 && placement.pos[0] === model.anchor[0]
    && placement.pos[1] === model.anchor[1] && placement.pos[2] === model.anchor[2]) return null;
  const rotation: PropRotation = { yaw: placement.yaw, pitch: placement.pitch, roll: placement.roll };
  const absorbed = placementQuat(rotation);
  const [ax, ay, az] = model.anchor;
  for (let i = 0; i < model.vertices.length; i += 3) {
    const local: V3 = [scale * (model.vertices[i] - ax), scale * (model.vertices[i + 1] - ay),
      scale * (model.vertices[i + 2] - az)];
    const r = applyQuat(local, absorbed);
    model.vertices[i] = placement.pos[0] + r[0];
    model.vertices[i + 1] = placement.pos[1] + r[1];
    model.vertices[i + 2] = placement.pos[2] + r[2];
  }
  model.anchor = [placement.pos[0], placement.pos[1], placement.pos[2]];
  // Every placement composes with the absorbed pose's inverse: position stays, rotation/scale re-derive —
  // the picked placement lands exactly on the identity (no rotation, scale 1, pos = anchor). The vertices
  // now carry `R_a` on the INSIDE (`v' − anchor = R_a·s_a·(v − anchor)`), so a placement that still has to
  // render `R_pp·s_pp` must keep `R_pp' = R_pp · R_a⁻¹` — right-multiplied. Two rotations about the same
  // vertical commute, which is why the yaw-only path can subtract one angle either way round; a tilt does
  // not, and getting the side wrong there swings every other placement of the model.
  const inverse = conjugateQuat(absorbed);
  for (const pp of mdoc.props ?? []) {
    if (pp.level !== AUTHORED_MODEL_LEVEL || modelIdFromNumber(pp.model) !== model.id) continue;
    if (!isTilted(pp) && !isTilted(rotation)) pp.yaw = (((pp.yaw - rotation.yaw) % 360) + 360) % 360;
    else writePropRotation(pp, propRotationFromQuat(multiplyQuat(placementQuat(pp), inverse)));
    pp.scale = pp.scale / scale;
  }
  return { rotation, scale };
}

/** "Save As" is a REVISION: 'Rail jump' → 'Rail jump v2' → 'Rail jump v3'. */
export function reviseModelName(name: string): string {
  const match = /^(.*) v(\d+)$/.exec(name);
  return match ? `${match[1]} v${Number(match[2]) + 1}` : `${name} v2`;
}

export function duplicateAuthoredModel(mdoc: QuadMeshDoc, model: AuthoredModel): AuthoredModel {
  const models = (mdoc.models ??= []);
  const copy: AuthoredModel = structuredClone(model);
  copy.id = nextModelId(models);
  copy.name = reviseModelName(model.name);
  models.push(copy);
  return copy;
}

// ---- placements: authored models as ordinary props (the definition/instance split) --------------------

/** The synthetic prop-library "level" authored models live under. A placement of a model is an ordinary
 *  PlacedProp with this level and the model's NUMBER — so selection, gizmos, groups-of-one, effects
 *  attachments and the export all treat it exactly like a borrowed reference prop. */
export const AUTHORED_MODEL_LEVEL = '@models';

/** The stable number a placement stores ↔ the model id: 'model:0007' ↔ 7. */
export const modelNumber = (id: string): number => Number(id.slice('model:'.length));
export const modelIdFromNumber = (n: number): string => `model:${n.toString().padStart(4, '0')}`;

export function findModelByNumber(mdoc: QuadMeshDoc, n: number): AuthoredModel | null {
  return findModel(mdoc, modelIdFromNumber(n));
}

/**
 * One authored model's flipbook state list, or empty for a still image.
 *
 * Headed by the model's own tile whatever the document says, because that is the invariant every shipped
 * native flipbook material holds (`frames[0] === TexturePath`) and what the renderer draws at rest. A list
 * that falls below two entries is not a flipbook at all — a state list of one is a still image — so it
 * resolves to none rather than to a one-frame animation.
 */
export function authoredModelFrames(model: AuthoredModel): string[] {
  const rest = (model.frames ?? []).slice(1).filter(ref => typeof ref === 'string' && !!ref);
  return model.texture && rest.length ? [model.texture, ...rest] : [];
}

/**
 * Bake the authored models into the SAME LevelProps shape an extracted level decodes to — raw SSX space
 * (cm, Z-up, X negated), anchor-local — so the prop library grid, thumbnails, arming ghost, placement
 * seating and instance rendering all consume them through the one existing pipeline.
 *
 * Vertices emit PER QUAD CORNER (not shared) so each quad carries its own UV rect: the FULL tile 0–1,
 * A(0,0) B(1,0) C(0,1) D(1,1) — V runs down the A→C spine, so a downstream scroll flows along the strip
 * and wraps CONTINUOUSLY across quads (no inset, docs/008). Quads triangulate two-per-quad (a wedge one),
 * wound so RAW_TO_EDITOR lands them in the terrain's editor-space orientation. The model's tile ref
 * "LEVEL/NNNN.png" rides the materials table whole; the registrar splits it to fetch from that level.
 */
export function authoredModelLevelProps(mdoc: QuadMeshDoc): LevelProps {
  const models = (mdoc.models ?? []).map(model => {
    const [ax, ay, az] = model.anchor;
    const raw = (i: number): [number, number, number] => [
      -100 * (model.vertices[i * 3] - ax),                    // raw = (-100·x, -100·z, 100·y) of local metres
      -100 * (model.vertices[i * 3 + 2] - az),
      100 * (model.vertices[i * 3 + 1] - ay),
    ];
    const positions: number[] = [], uvs: number[] = [], tris: number[] = [];
    for (const quad of model.quads) {
      const base = positions.length / 3;
      const wedge = quad[2] === quad[3];
      const corners = wedge ? 3 : 4;
      for (let s = 0; s < corners; s++) {
        positions.push(...raw(quad[s]));
        uvs.push(...tiledPropUV(s, wedge, model.orient));
      }
      if (wedge) tris.push(base, base + 2, base + 1);         // reversed vs editor CCW — the raw mirror flips it back
      else tris.push(base, base + 2, base + 3, base, base + 3, base + 1);
    }
    return {
      id: modelNumber(model.id), name: model.name,
      subs: [{
        mat: model.texture ? modelNumber(model.id) : -1,     // per-model material slot carrying its tile ref
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(tris),
      }],
    };
  });
  const materials = new Map<number, { tex: string | null; frames: string[]; blend?: boolean; pixelAlpha?: boolean }>();
  for (const model of mdoc.models ?? []) {
    // The tile rides whole as a cross-level ref; its FRAMES go bare, because a frame list resolves against
    // whichever bank the tile already named — the same convention an imported prop's payload uses.
    if (model.texture) materials.set(modelNumber(model.id), {
      tex: model.texture,
      frames: authoredModelFrames(model).map(ref => ref.slice(ref.indexOf('/') + 1)),
      ...(model.blend ? { blend: true } : {}),
      pixelAlpha: true,
    });
  }
  return { level: AUTHORED_MODEL_LEVEL, models, instances: [], materials, crowdFrames: [] };
}
