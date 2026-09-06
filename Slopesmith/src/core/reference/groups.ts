import type { PlacedProp, V3 } from '../doc/types';
import type { RawRigLight } from './lights';
import { reachM, colorHex } from './lights';
import { rawLinearToEditor, normalize, type PlacedLight } from '../lighting/sign-lights';
import { composeYaw, rotateByPlacement, tiltFields } from '../props/pose';

/**
 * GROUP PROPS (docs/015): assemblies mined from a reference level's own placement data — the fire hydrant
 * and its top lid, the directional sign and its stand, the street lamp and the halo spot at its head — each
 * placeable as ONE library entry whose members derive from the single placement.
 *
 * The shipped levels author assemblies two ways, and both are mined here:
 *
 *  - **Co-placed models.** Multi-model props are stacked at an IDENTICAL Location + Rotation (the member
 *    offset is baked into each model's local geometry): every reference `FireHyDrant_TopLid` sits exactly on
 *    its `FireHyDrant_Base`, every `DirectionalSign` exactly on its `DirectionalSignStand`. So a group is a
 *    set of models that repeatedly co-occur at the same placement — exact matching, not proximity fuzz.
 *
 *  - **Fixture lights.** A lamp's light is a separate Lights.json record standing at a CONSISTENT offset in
 *    the fixture's local frame (the reference `mediumHalo_streetLight` spots sit 25.4 m up, ~4.6 m out along the
 *    arm of each `StreetLight_Tall`, rotating with its yaw). Expressing each nearby light in each instance's
 *    local frame and clustering the offsets recovers that attachment.
 *
 * A placed group is stored as a single `PlacedProp` carrying `group: <def id>` — the leader model plus the
 * def id; the sibling member models and the lights are DERIVED from the def at render / bake / export time
 * (the same philosophy as the derived billboard sign lights, docs/013). Move the placement, everything
 * follows; delete it, everything's gone.
 *
 * Mining is pure (parsed JSON in, defs out) so it's shared verbatim by the dev-server endpoint
 * (`/api/groups`, server/routes/groups.ts) and the export (server/routes/export.ts) — the def a placement references is
 * reproducible from the level data alone, so docs stay small and stable.
 */

/** One prop member of a group, relative to the group origin. Mined members carry relPos [0,0,0] / relYaw 0
 *  (the shipped assemblies co-place members exactly); the fields exist so hand-authored groups can offset. */
export interface GroupPropDef {
  model: number;
  name: string;
  /** Member origin relative to the group origin, editor metres (pre-scale, pre-yaw). */
  relPos: V3;
  /** Member yaw relative to the group yaw, degrees. */
  relYaw: number;
}

/** One light member of a group, in the group's local editor frame (m, Y-up; same frame as relPos). */
export interface GroupLightDef {
  kind: 'spot' | 'point';
  /** Source position relative to the group origin, editor metres (pre-scale, pre-yaw). */
  relPos: V3;
  /** From-light propagation (aim) unit vector in the group's local editor frame. */
  dir: V3;
  /** Colour "#rrggbb" (peak-normalised) and HDR intensity (peak channel), like the decoded reference rig. */
  color: string;
  intensity: number;
  /** Spot cone half-angle cosine (1 for a point). */
  coneCos: number;
  /** Reach in metres (pre-scale). */
  reach: number;
  name: string;
}

/** One mined group: an id stable per level, its members, and how often the level places the assembly. */
export interface GroupDef {
  /** Slug unique within the level; a placement references it as `PlacedProp.group`. */
  id: string;
  /** Display name, e.g. "FireHyDrant" / "StreetLight_Tall". */
  name: string;
  level: string;
  /** Prop members; [0] is the LEADER (largest member — the model a placement stores / previews). */
  props: GroupPropDef[];
  lights: GroupLightDef[];
  /** How many times the source level places this assembly (the mining evidence). */
  occurrences: number;
}

/** The JSON `/api/groups?level=` sends. */
export interface GroupsPayload { level: string; groups: GroupDef[]; error?: string }

// ---- mining inputs (trimmed off Instances.json / Models.json by the server) --------------------------

/** One instance trimmed to what mining reads, raw SSX space (cm, Z-up). */
export interface GroupSourceInstance {
  model: number;
  loc: number[];
  /** Placement quaternion [x, y, z, w]. */
  rot: number[];
  scale: number[];
}
export interface GroupSourceModel { id: number; name: string }

// ---- mining tunables ---------------------------------------------------------------------------------

const MIN_COMBO_OCC = 3;     // a model set must co-place at least this often to be an assembly
const MAX_COMBO_MODELS = 6;  // larger identical-origin stacks are modular architecture, not a prop assembly
const MIN_FIXTURE_OCC = 8;   // a single model needs this many placements before light-mining it
const LIGHT_NEAR_CM = 3500;  // only lights within 35 m of an instance can be attached to it (past the
                             // tallest fixture head, short of the NEXT lamp in a regularly spaced row —
                             // whose halo would otherwise sit at a "consistent" local offset too)
const LIGHT_CLUSTER_CM = 100; // local offsets within this bucket are "the same" attachment point
const MAX_GROUP_LIGHTS = 4;  // cap the light members per group (a lamp has one head, maybe two)

/** Rotate `v` by the CONJUGATE of unit quaternion `q` [x,y,z,w] — world → the instance's local frame. */
function qRotInv(q: number[], v: V3): V3 {
  const x = -q[0], y = -q[1], z = -q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Same rotation? |q1·q2| ≈ 1 (q and −q encode the same rotation). */
function sameRot(a: number[], b: number[]): boolean {
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) > 0.9999;
}

/** Display / slug name for a member set: the members' longest common name prefix, cleaned of the `Mdl_`
 *  prefix and any trailing separators / id digits — "FireHyDrant_Base_1005" + "FireHyDrant_TopLid_1005" →
 *  "FireHyDrant". Falls back to the first member's cleaned name when the prefix is too short to read. */
function comboName(names: string[]): string {
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let k = 0;
    while (k < prefix.length && k < n.length && prefix[k] === n[k]) k++;
    prefix = prefix.slice(0, k);
  }
  const clean = (s: string) => s.replace(/^Mdl_/, '').replace(/[_\d]+$/, '');
  const p = clean(prefix);
  return p.length >= 3 ? p : clean(names[0]);
}

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';

/** One placement of an assembly (raw space) — the frame nearby lights are expressed in. */
interface Occurrence { loc: number[]; rot: number[]; scale: number }

/**
 * Attach lights to an assembly: express every nearby positive local light (spot / point; sun-named fills and
 * subtractive shadow lights excluded) in each occurrence's local frame, cluster the offsets, and keep the
 * clusters consistent across enough occurrences — a light that genuinely belongs to the fixture sits at the
 * SAME local offset every time it appears; scene lighting that just happens to be nearby doesn't.
 */
function attachLights(occs: Occurrence[], lights: RawRigLight[]): GroupLightDef[] {
  const minCover = Math.max(4, Math.ceil(occs.length * 0.3));
  if (occs.length < minCover) return [];
  interface Cluster { occ: Set<number>; local: V3[]; dir: V3[]; recs: RawRigLight[] }
  const clusters = new Map<string, Cluster>();
  for (let oi = 0; oi < occs.length; oi++) {
    const o = occs[oi];
    const s = o.scale || 1;
    for (const L of lights) {
      const dx = L.pos[0] - o.loc[0], dy = L.pos[1] - o.loc[1], dz = L.pos[2] - o.loc[2];
      if (dx * dx + dy * dy + dz * dz > LIGHT_NEAR_CM * LIGHT_NEAR_CM) continue;
      const lp = qRotInv(o.rot, [dx, dy, dz]);
      const local: V3 = [lp[0] / s, lp[1] / s, lp[2] / s];
      const ld = qRotInv(o.rot, [L.dir[0] ?? 0, L.dir[1] ?? 0, L.dir[2] ?? 0]);
      const key = `${L.type}:${Math.round(local[0] / LIGHT_CLUSTER_CM)},${Math.round(local[1] / LIGHT_CLUSTER_CM)},${Math.round(local[2] / LIGHT_CLUSTER_CM)}`;
      let c = clusters.get(key);
      if (!c) clusters.set(key, (c = { occ: new Set(), local: [], dir: [], recs: [] }));
      c.occ.add(oi);
      c.local.push(local);
      c.dir.push(ld);
      c.recs.push(L);
    }
  }
  const mean = (vs: V3[]): V3 => {
    const m: V3 = [0, 0, 0];
    for (const v of vs) { m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; }
    return [m[0] / vs.length, m[1] / vs.length, m[2] / vs.length];
  };
  const out: GroupLightDef[] = [];
  const kept = [...clusters.values()].filter(c => c.occ.size >= minCover).sort((a, b) => b.occ.size - a.occ.size);
  for (const c of kept.slice(0, MAX_GROUP_LIGHTS)) {
    const col: number[] = [0, 0, 0];
    let cone = 0, reach = 0, spots = 0;
    for (const r of c.recs) {
      col[0] += r.colour[0] || 0; col[1] += r.colour[1] || 0; col[2] += r.colour[2] || 0;
      cone += r.cone ?? 1;
      reach += reachM(r.pos, r.lo ?? r.pos, r.hi ?? r.pos);
      if (r.type === 1) spots++;
    }
    const n = c.recs.length;
    col[0] /= n; col[1] /= n; col[2] /= n;
    const kind = spots * 2 >= n ? 'spot' : 'point';
    // the cluster's dominant name family (a fixture's records share one; a stray co-located record doesn't)
    const nameCounts = new Map<string, number>();
    for (const r of c.recs) {
      const base = r.name.replace(/[_\d]+$/, '');
      nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1);
    }
    const topName = [...nameCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'light';
    out.push({
      kind,
      relPos: rawLinearToEditor(mean(c.local)),
      dir: normalize(rawLinearToEditor(mean(c.dir))),
      color: colorHex(col, false),
      intensity: Math.max(col[0], col[1], col[2]),
      coneCos: kind === 'spot' ? cone / n : 1,
      reach: Math.min(Math.max(reach / n, 5), 80),
      name: topName,
    });
  }
  return out;
}

/**
 * Mine a level's group defs from its placement data. `instances` should already exclude invisible records;
 * junk twins (a breakable's shattered replacement, co-placed with the intact model) and Reset twins (a
 * stand's co-placed reset-surface shell — a gameplay volume, not visible art) are excluded here so a mined
 * assembly never stacks a broken mesh or a collision shell over the real one.
 */
export function mineGroups(
  level: string,
  models: GroupSourceModel[],
  instances: GroupSourceInstance[],
  rigLights: RawRigLight[],
): GroupDef[] {
  const nameOf = new Map(models.map(m => [m.id, m.name]));
  const usable = instances.filter(i => {
    const n = nameOf.get(i.model);
    return !!n && !/junk|_reset/i.test(n);
  });
  // positive local lights only: spots / points that aren't subtractive and aren't the sun-fill family
  // (bakeRigLighting skips those too — they're global light, not a fixture's own)
  const lights = rigLights.filter(L =>
    (L.type === 1 || L.type === 2) &&
    Math.max(L.colour[0] || 0, L.colour[1] || 0, L.colour[2] || 0) > 0 &&
    !L.name.toLowerCase().includes('sun'));

  // ---- co-placed model sets: bucket by exact location, signature = the distinct models sharing it ----
  const buckets = new Map<string, GroupSourceInstance[]>();
  for (const i of usable) {
    const key = `${Math.round(i.loc[0] * 8)},${Math.round(i.loc[1] * 8)},${Math.round(i.loc[2] * 8)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(i);
  }
  const combos = new Map<string, { members: number[]; occs: Occurrence[] }>();
  const comboMember = new Set<number>(); // models that belong to an accepted combo (excluded from fixtures)
  for (const b of buckets.values()) {
    const memberIds = [...new Set(b.map(i => i.model))].sort((x, y) => x - y);
    if (memberIds.length < 2 || memberIds.length > MAX_COMBO_MODELS) continue;
    if (!b.every(i => sameRot(i.rot, b[0].rot) && Math.abs((i.scale[0] ?? 1) - (b[0].scale[0] ?? 1)) < 1e-3)) continue;
    const sig = memberIds.join(',');
    let c = combos.get(sig);
    if (!c) combos.set(sig, (c = { members: memberIds, occs: [] }));
    c.occs.push({ loc: b[0].loc, rot: b[0].rot, scale: b[0].scale[0] ?? 1 });
  }

  const defs: GroupDef[] = [];
  const usedIds = new Set<string>();
  const freshId = (base: string) => {
    let id = base, k = 2;
    while (usedIds.has(id)) id = `${base}-${k++}`;
    usedIds.add(id);
    return id;
  };

  for (const c of combos.values()) {
    if (c.occs.length < MIN_COMBO_OCC) continue;
    const names = c.members.map(m => nameOf.get(m)!);
    const name = comboName(names);
    for (const m of c.members) comboMember.add(m);
    defs.push({
      id: freshId(slugOf(name)),
      name,
      level,
      props: c.members.map(m => ({ model: m, name: nameOf.get(m)!, relPos: [0, 0, 0], relYaw: 0 })),
      lights: attachLights(c.occs, lights),
      occurrences: c.occs.length,
    });
  }

  // ---- fixture lights on single models: enough placements + a consistent local light offset ----
  if (lights.length) {
    const byModel = new Map<number, Occurrence[]>();
    for (const i of usable) {
      if (comboMember.has(i.model)) continue;
      const n = nameOf.get(i.model)!;
      if (/billboard/i.test(n)) continue; // billboards already derive their sign light (docs/013)
      let occ = byModel.get(i.model);
      if (!occ) byModel.set(i.model, (occ = []));
      occ.push({ loc: i.loc, rot: i.rot, scale: i.scale[0] ?? 1 });
    }
    for (const [model, occs] of byModel) {
      if (occs.length < MIN_FIXTURE_OCC) continue;
      const attached = attachLights(occs, lights);
      if (!attached.length) continue;
      const name = comboName([nameOf.get(model)!]);
      defs.push({
        id: freshId(slugOf(name)),
        name,
        level,
        props: [{ model, name: nameOf.get(model)!, relPos: [0, 0, 0], relYaw: 0 }],
        lights: attached,
        occurrences: occs.length,
      });
    }
  }

  defs.sort((a, b) => b.occurrences - a.occurrences);
  return defs;
}

// ---- expansion: one placement → its member props / lights -------------------------------------------

/** A member's world position: the group-local offset scaled + rotated through the placement (mirrors
 *  signlights.mapPoint, already past rawLinearToEditor). */
function memberWorldPos(pp: PlacedProp, rel: V3): V3 {
  const r = rotateByPlacement([rel[0] * pp.scale, rel[1] * pp.scale, rel[2] * pp.scale], pp);
  return [r[0] + pp.pos[0], r[1] + pp.pos[1], r[2] + pp.pos[2]];
}

/** Expand a group placement into per-member prop placements (for the export bake — the members write as
 *  individual instances at identical origins, exactly the form the shipped levels author). A member's own
 *  `relYaw` is a turn in the GROUP's frame, so it composes onto the placement's rotation rather than adding
 *  to its yaw — a tilted group carries its members around with it. */
export function expandGroupProps(pp: PlacedProp, def: GroupDef): PlacedProp[] {
  return def.props.map(m => ({
    level: pp.level,
    model: m.model,
    name: m.name,
    pos: memberWorldPos(pp, m.relPos),
    ...composeYawFields(pp, m.relYaw),
    scale: pp.scale,
  }));
}

function composeYawFields(pp: PlacedProp, relYaw: number): { yaw: number; pitch?: number; roll?: number } {
  const r = composeYaw(pp, relYaw);
  return { yaw: r.yaw, ...tiltFields(r) };
}

/** A group placement's light members resolved into the authored-rig form (editor space, scaled + rotated with
 *  the placement) — they join the sign + free lights for the terrain glow, prop tint, gizmos and export. */
export function groupPlacedLights(pp: PlacedProp, def: GroupDef, placedIndex: number): PlacedLight[] {
  return def.lights.map((L, k) => ({
    name: `${def.name} ${L.name || 'light'}${def.lights.length > 1 ? ` ${k + 1}` : ''}`,
    kind: L.kind,
    pos: memberWorldPos(pp, L.relPos),
    dir: rotateByPlacement(L.dir, pp),
    colorHex: L.color,
    intensity: L.intensity,
    coneCos: L.coneCos,
    reach: L.reach * pp.scale,
    ofGroup: placedIndex,
  }));
}

/** Every group placement's light members, resolved. `defOf` returns the placement's def (null while its
 *  level's defs are still loading — those placements just contribute no lights until the fetch lands). */
export function authoredGroupLights(
  props: PlacedProp[] | undefined,
  defOf: (pp: PlacedProp) => GroupDef | null,
): PlacedLight[] {
  const out: PlacedLight[] = [];
  (props ?? []).forEach((pp, i) => {
    if (!pp.group) return;
    const def = defOf(pp);
    if (def) out.push(...groupPlacedLights(pp, def, i));
  });
  return out;
}
