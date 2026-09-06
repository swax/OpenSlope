import type { V3, PlacedProp, AuthoredLight } from '../doc/types';
import type { LightRig, RigLight } from '../reference/lights';
import { rotateByPlacement } from '../props/pose';
import { glintSizeClass } from './glints';

/**
 * AUTHORED sign lights — the light-side companion to placed props (docs/012) and the reference light-rig
 * study (docs/013 / lights.ts). Where ref-lights READS an extracted level's Lights.json, this AUTHORS the
 * same thing: dropping a billboard on a course drops a matching sign light in front of it, aimed at its face,
 * exactly the `SD_sp_SignLight`-off-a-`Mdl_Billboard` pattern the shipped levels carry.
 *
 * The light is DERIVED from the billboard's placement + its model's local bounding box — not stored — so it
 * follows the billboard automatically (move it, the light moves; delete it, the light's gone). Both the editor
 * preview (from the loaded prop geometry) and the export bake (from the model meshes on disk) call the same
 * pure `deriveSignLight`, so what you see is what ships.
 *
 * Recipe, grounded on the reference SignLights (all identical in form — a Type-1 spot standing ~15 m off the
 * board along its thin front-back axis, ~22–30° cone, white at intensity 1): a spot standing ~15 m off, mounted
 * a little above the face centre, aimed down at the board's lower face. The shipped lights aim dead horizontal
 * and rely on the baked lightmap's BOUNCE for the snow glow under a sign; since an authored course has no
 * bounce to bake, the authored light rakes down instead, so it both lights the sign face AND pools on the snow
 * in front — the effect the sign lights were remembered for. The lit side is the board's +thin-axis face; yaw
 * the billboard 180° to light the other side.
 */

/** A model's local axis-aligned bounding box, in raw SSX centimetres (Z-up) — the space Meshes/*.obj store. */
export interface LocalBox { min: V3; max: V3; }

/** One authored sign light, in editor/data space (metres, Y-up) — the frame `corners` + `PlacedProp.pos` use.
 *  Convertible straight to a ref-lights `RigLight` (already editor-space) for the terrain bake / prop tint /
 *  gizmo, and to a raw SSX Lights.json record on export. */
export interface PlacedLight {
  name: string;
  kind: 'spot' | 'point';
  pos: V3;
  /** From-light propagation (aim) unit vector, editor space. */
  dir: V3;
  colorHex: string;
  intensity: number;
  /** Spot cone half-angle cosine (1 for a point). */
  coneCos: number;
  /** Reach in metres — sizes the falloff cap and the exported influence box. */
  reach: number;
  /** Glow-sprite resolution class (16/32/64) making this light draw the game's runtime glint (docs/047).
   *  0 / absent = no glint — the shipped SignLights carry no glint either. */
  glint?: number;
  /** Index of the billboard prop it was derived from (a sign light only; a free light has none). */
  ofProp?: number;
  /** Index of the group placement it was derived from (a group-def light member only — docs/015). */
  ofGroup?: number;
  /** The point on the board a sign light aims at (editor metres) — where the billboard is tinted, since it's on
   *  the beam whatever the board's height (its geometric centre can sit above a down-raked beam). */
  aimAt?: V3;
}

/** Does this model get a sign light dropped with it? The shipped SignLights sit on `Mdl_Billboard_*`. */
export function isSignProp(name: string): boolean {
  return name.toLowerCase().includes('billboard');
}

/** Intensity-weight K the TERRAIN bake uses for authored sign lights (`bakeRigLighting`'s 4th arg). Much
 *  smaller than the reference default (3) because these lights are authored deliberately dim (white, I=1) yet
 *  are meant to pool visibly on the snow — the smaller K lifts a dim light instead of taming an HDR one. The
 *  preview (viewport) and the exported lightmap fold both use this, so they match. */
export const SIGN_TERRAIN_WEIGHT_K = 0.5;

const CONE_COS = Math.cos((30 * Math.PI) / 180); // 30° half-angle: a touch wider than the shipped 22.5° so the down-raked beam catches the snow in front
const SIGN_COLOR = '#ffffff';                     // the reference SignLights are white
const SIGN_INTENSITY = 1;
const MOUNT_FRAC = 0.5;   // light mounted this fraction of the half-height above the face centre
const MOUNT_CAP_CM = 800; // ...capped at 8 m so a very tall sign's light doesn't fly absurdly high
const AIM_FOOT_FRAC = 0.75; // aim at a point this fraction of the half-height below centre (the lower face / foot)

// ---- editor/data-space mapping (the same transform placedPropMatrix / buildPlacedProps render with) --------
// A model-local point (raw cm) → editor metres: RAW_TO_EDITOR (=editorFromRaw's linear map), then the
// placement's uniform scale, rotation, and translation. A direction skips scale/translation.

export const rawLinearToEditor = (v: V3): V3 => [-v[0] / 100, v[2] / 100, -v[1] / 100];
export const normalize = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

function mapPoint(pp: PlacedProp, vLocalCm: V3): V3 {
  const e = rawLinearToEditor(vLocalCm);
  const s: V3 = [e[0] * pp.scale, e[1] * pp.scale, e[2] * pp.scale];
  const r = rotateByPlacement(s, pp);
  return [r[0] + pp.pos[0], r[1] + pp.pos[1], r[2] + pp.pos[2]];
}
function mapDir(pp: PlacedProp, dLocalCm: V3): V3 {
  return normalize(rotateByPlacement(rawLinearToEditor(dLocalCm), pp)); // uniform +scale doesn't change a direction
}

/**
 * Derive the sign light for one placed billboard from its model-local bounding box (raw cm). The board's
 * thinner horizontal axis is its front-back normal; the light stands `standoff` out along +normal, mounted a
 * little above the face centre and aimed down at the lower face, so it lights the sign and pools on the snow
 * in front. Everything is computed in model-local cm, then mapped through the placement (pose + uniform scale)
 * into editor metres, so the light rides the billboard's position, yaw and size.
 */
export function deriveSignLight(pp: PlacedProp, box: LocalBox, index: number): PlacedLight {
  const ex = box.max[0] - box.min[0], ey = box.max[1] - box.min[1], ez = box.max[2] - box.min[2];
  const center: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];

  // thinner horizontal axis (X or Y) = the board's front-back normal; the other horizontal is its width, Z its height
  const normalIsX = ex <= ey;
  const normalLocal: V3 = normalIsX ? [1, 0, 0] : [0, 1, 0];
  const halfThk = (normalIsX ? ex : ey) / 2;
  const halfW = (normalIsX ? ey : ex) / 2;
  const halfH = ez / 2;

  // standoff (cm): ~15 m like the shipped lights, nudged out for an unusually wide sign so it clears the face
  const standoffCm = Math.min(Math.max(1500, halfW * 0.7 + 300), 2200);
  const mountCm = Math.min(halfH * MOUNT_FRAC, MOUNT_CAP_CM); // mounted a little above the face centre
  const lightLocal: V3 = [
    center[0] + normalLocal[0] * standoffCm,
    center[1] + normalLocal[1] * standoffCm,
    center[2] + mountCm,
  ];
  const aimTargetLocal: V3 = [center[0], center[1], center[2] - halfH * AIM_FOOT_FRAC]; // lower face / foot
  const aimLocal: V3 = [
    aimTargetLocal[0] - lightLocal[0], aimTargetLocal[1] - lightLocal[1], aimTargetLocal[2] - lightLocal[2],
  ];

  const diagCm = Math.hypot(halfW, halfH, halfThk);
  const reachCm = standoffCm + diagCm + 500;

  return {
    name: `Sign light ${index + 1}`,
    kind: 'spot',
    pos: mapPoint(pp, lightLocal),
    dir: mapDir(pp, aimLocal),
    colorHex: SIGN_COLOR,
    intensity: SIGN_INTENSITY,
    coneCos: CONE_COS,
    reach: (reachCm * pp.scale) / 100,
    ofProp: index,
    aimAt: mapPoint(pp, aimTargetLocal),
  };
}

/** Provider of a placed prop's model-local bbox (raw cm), or null if its geometry isn't available yet. Both
 *  callers supply one: the editor from the loaded prop payload, the export from the meshes on disk. */
export type BoxProvider = (level: string, model: number) => LocalBox | null;

/** Every billboard placement's derived sign light. Skips non-billboards and any whose geometry is missing. */
export function authoredSignLights(props: PlacedProp[] | undefined, boxOf: BoxProvider): PlacedLight[] {
  const out: PlacedLight[] = [];
  if (!props) return out;
  props.forEach((pp, i) => {
    if (pp.effectTrigger || !isSignProp(pp.name)) return;
    const box = boxOf(pp.level, pp.model);
    if (box) out.push(deriveSignLight(pp, box, i));
  });
  return out;
}

const DEFAULT_SPOT_CONE_DEG = 35;

/** Resolve a hand-placed free light (doc data) into the editor-space `PlacedLight` the rig consumes: a point
 *  (omni, cone cosine 1) or a spot (cone from its half-angle, aimed along `dir`, default straight down). No
 *  `ofProp` / `aimAt` — a free light isn't tied to a prop (it lights whatever's near it via the shared rig). */
export function freeLightToPlaced(a: AuthoredLight, index: number): PlacedLight {
  const dir = normalize(a.dir ?? [0, -1, 0]);
  return {
    name: a.name ?? `Light ${index + 1}`,
    kind: a.kind,
    pos: a.pos,
    dir,
    colorHex: a.color,
    intensity: a.intensity,
    coneCos: a.kind === 'spot' ? Math.cos(((a.cone ?? DEFAULT_SPOT_CONE_DEG) * Math.PI) / 180) : 1,
    reach: a.reach,
    glint: glintSizeClass(a.glint),
  };
}

/** Every hand-placed free light resolved into rig form. */
export function authoredFreeLights(lights: AuthoredLight[] | undefined): PlacedLight[] {
  return (lights ?? []).map(freeLightToPlaced);
}

/** Wrap the authored lights (sign + free) as a ref-lights LightRig so the SAME terrain bake / prop tint / gizmo
 *  code the reference overlay uses consumes them verbatim (they're already editor-space, positive). Points get
 *  the `point` category; everything else reads as `sign` for the gizmo colouring. */
export function authoredRig(lights: PlacedLight[]): LightRig {
  const rigLights: RigLight[] = lights.map(l => ({
    name: l.name,
    kind: l.kind,
    category: l.kind === 'point' ? 'point' : 'sign',
    negative: false,
    pos: l.pos,
    dir: l.dir,
    colorHex: l.colorHex,
    intensity: l.intensity,
    coneCos: l.coneCos,
    reach: l.reach,
    spriteRes: l.glint ?? 0,   // the engine's glint gate rides through as the rig's own field (docs/047)
  }));
  return { level: 'authored', lights: rigLights, counts: { sign: rigLights.length } };
}
