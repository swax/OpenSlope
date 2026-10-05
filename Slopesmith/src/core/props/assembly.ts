import type { AuthoredLight, PlacedProp, QuadMeshDoc, V3 } from '../doc/types';
import { nextLightId } from '../doc/ids';
import { nextPlacedPropId } from '../effects/authoring';
import { isEffectTriggerProp } from '../effects/trigger-volume';
import { expandGroupProps, groupPlacedLights, type GroupDef } from '../reference/groups';
import { applyQuat, conjugateQuat, multiplyQuat, placementQuat, rotateY } from './pose';

/**
 * Authored GROUPS (docs/015 · Authored groups): any placements and free lights the author ties together, tagged
 * with one shared `assembly` id.
 *
 * A mined group is ONE placement whose members derive from a def. An authored group is the other way round: every
 * member stays an ordinary placement or free light, with its own pose, level, settings, effects and screens, so a
 * group can mix levels and nothing downstream — export, Test, collision, sound — has to know it exists. What the
 * tag adds is editing: a click on any member selects the group, and the selection's gizmo and the group panel move,
 * turn and size the set as one, its lights carried along.
 *
 * A group is selected through its PROPS, so it needs at least one, and two members in all. A tag that falls short
 * (its partners deleted, a lone member pasted) is no group, and every reader here treats it as absent.
 */

/** The parts of a document a group spans. */
export type AssemblyDoc = Pick<QuadMeshDoc, 'props' | 'lights'>;

/** Where a placement stands — what a transform of a group changes. */
export type PlacementPose = Pick<PlacedProp, 'pos' | 'yaw' | 'pitch' | 'roll' | 'scale'>;

/** The members tagged `id`, by index into the document's props and lights, in document order. */
export function assemblyMembers(doc: AssemblyDoc, id: string): { props: number[]; lights: number[] } {
  const props: number[] = [], lights: number[] = [];
  (doc.props ?? []).forEach((prop, i) => { if (prop.assembly === id) props.push(i); });
  (doc.lights ?? []).forEach((light, i) => { if (light.assembly === id) lights.push(i); });
  return { props, lights };
}

/** Whether these members make a group: a prop to select it by, and a second member of either kind. */
const isGroup = (members: { props: number[]; lights: number[] }) =>
  members.props.length > 0 && members.props.length + members.lights.length > 1;

/** The props of the group placement `index` belongs to, itself included — or null when it is on its own. */
export function assemblyOf(doc: AssemblyDoc, index: number): number[] | null {
  const id = doc.props?.[index]?.assembly;
  if (!id) return null;
  const members = assemblyMembers(doc, id);
  return isGroup(members) ? members.props : null;
}

/** The props of the group free light `id` belongs to — what selecting it selects — or null when it is on its own. */
export function lightAssemblyOf(doc: AssemblyDoc, lightId: string): number[] | null {
  const group = doc.lights?.find(light => light.id === lightId)?.assembly;
  if (!group) return null;
  const members = assemblyMembers(doc, group);
  return isGroup(members) ? members.props : null;
}

/** `indices` with every group any of them belongs to filled in, sorted — so a group always selects whole. */
export function withWholeAssemblies(doc: AssemblyDoc, indices: readonly number[]): number[] {
  const out = new Set(indices);
  for (const index of indices) for (const member of assemblyOf(doc, index) ?? []) out.add(member);
  return [...out].sort((a, b) => a - b);
}

/** The group `indices` are exactly — every prop of one group and nothing else — or null. */
export function wholeAssembly(doc: AssemblyDoc, indices: readonly number[]): string | null {
  const id = doc.props?.[indices[0]]?.assembly;
  const members = id ? assemblyOf(doc, indices[0]) : null;
  if (!id || !members) return null;
  const picked = new Set(indices);
  return picked.size === members.length && members.every(i => picked.has(i)) ? id : null;
}

/** The groups `indices` hold every prop of. */
export function wholeAssembliesIn(doc: AssemblyDoc, indices: readonly number[]): string[] {
  const picked = new Set(indices);
  const ids = new Set(indices.map(i => doc.props?.[i]?.assembly).filter((id): id is string => !!id));
  return [...ids].filter(id => assemblyMembers(doc, id).props.every(i => picked.has(i)));
}

/** A group id no placement or light uses yet. */
export function nextAssemblyId(doc: AssemblyDoc): string {
  const used = new Set([...doc.props ?? [], ...doc.lights ?? []].map(item => item.assembly)
    .filter((id): id is string => !!id));
  for (let i = 0; ; i++) {
    const id = `group:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** Why the placements at `indices`, with `lights` free lights selected beside them, cannot become a group — or
 *  null when they can. A group is selected through its props, so it needs one, and a second member of either kind. */
export function assemblyRefusal(props: readonly PlacedProp[], indices: readonly number[], lights = 0): string | null {
  const picked = [...new Set(indices)].map(i => props[i]).filter((prop): prop is PlacedProp => !!prop);
  if (!picked.length) return 'A group needs a prop — select one with the lights.';
  if (picked.length + lights < 2) return 'Select at least two props, or a prop and a light, to make a group.';
  // A line lays its members out again whenever it changes, which would pull them back out of any group's shape.
  if (picked.some(prop => prop.line)) return 'Props laid out by a line can’t join a group — break the line into props first.';
  if (picked.some(isEffectTriggerProp)) return 'Effects trigger volumes can’t join a group.';
  return null;
}

/** Tie the placements at `indices`, and the free lights `lightIds`, into one new group and answer its id. A member
 *  of another group leaves it; a group taken whole brings its lights along. */
export function createAssembly(doc: AssemblyDoc, indices: readonly number[], lightIds: readonly string[] = []): string {
  const id = nextAssemblyId(doc);
  const absorbed = new Set(wholeAssembliesIn(doc, indices));
  for (const index of new Set(indices)) if (doc.props?.[index]) doc.props[index].assembly = id;
  for (const light of doc.lights ?? [])
    if ((light.assembly && absorbed.has(light.assembly)) || (light.id && lightIds.includes(light.id))) light.assembly = id;
  return id;
}

/** Release every member of group `id` — props and lights — and answer the props' indices. */
export function breakAssembly(doc: AssemblyDoc, id: string): number[] {
  const members = assemblyMembers(doc, id);
  for (const index of members.props) delete doc.props![index].assembly;
  for (const index of members.lights) delete doc.lights![index].assembly;
  return members.props;
}

/** Turn the placements at `indices` `deg` degrees about the vertical through `pivot` (data space). Yaw is the
 *  outermost of a placement's YXZ angles, so adding to it carries any tilt round intact. */
export function turnPlacements(props: PlacedProp[], indices: readonly number[], deg: number, pivot: V3): void {
  for (const index of indices) {
    const prop = props[index];
    if (!prop) continue;
    const [x, y, z] = rotateY([prop.pos[0] - pivot[0], prop.pos[1] - pivot[1], prop.pos[2] - pivot[2]], deg);
    prop.pos = [pivot[0] + x, pivot[1] + y, pivot[2] + z];
    prop.yaw = ((prop.yaw + deg) % 360 + 360) % 360;
  }
}

/** Scale the placements at `indices` by `factor` about `pivot`: their spacing and their sizes together. */
export function scalePlacements(props: PlacedProp[], indices: readonly number[], factor: number, pivot: V3): void {
  for (const index of indices) {
    const prop = props[index];
    if (!prop) continue;
    prop.pos = [0, 1, 2].map(k => pivot[k] + (prop.pos[k] - pivot[k]) * factor) as V3;
    prop.scale *= factor;
  }
}

/** Where the placements at `indices` stand now — taken before a transform, for `carryAssemblyLights` after it. */
export function placementPoses(props: readonly PlacedProp[], indices: readonly number[]): Map<number, PlacementPose> {
  const out = new Map<number, PlacementPose>();
  for (const index of indices) {
    const prop = props[index];
    if (prop) out.set(index, structuredClone({ pos: prop.pos, yaw: prop.yaw, pitch: prop.pitch, roll: prop.roll,
      scale: prop.scale }));
  }
  return out;
}

/**
 * Carry lights along after the props in `before` were moved rigidly — dragged, turned or scaled together: the
 * lights of every group whose props all moved, and `alsoLights`, free lights selected beside them. `before` holds
 * where each moved prop stood (`placementPoses`); the props now stand where they were taken. Any one moved prop's
 * before and after poses ARE the transform, because a rigid move applies the same one to every member: its turn
 * composed ahead of each rotation, its scale on every size and offset. So each light is carried as though it were
 * fixed to that prop, its aim turned and its reach scaled with it.
 *
 * Answers how many lights moved. Lights of a group only partly moved stay put — that is a member being placed
 * within its group, not the group moving.
 */
export function carryAssemblyLights(doc: AssemblyDoc, before: ReadonlyMap<number, PlacementPose>,
  alsoLights: readonly string[] = []): number {
  const lights = doc.lights ?? [];
  const carried = new Set<number>();
  const carry = (reference: number | undefined, indices: Iterable<number>) => {
    const from = reference === undefined ? undefined : before.get(reference);
    const to = reference === undefined ? undefined : doc.props?.[reference];
    if (!from || !to || !(from.scale > 0)) return;
    const turn = multiplyQuat(placementQuat(to), conjugateQuat(placementQuat(from)));
    const factor = to.scale / from.scale;
    for (const index of indices) {
      const light = lights[index];
      if (!light || carried.has(index)) continue;
      const offset = applyQuat([light.pos[0] - from.pos[0], light.pos[1] - from.pos[1], light.pos[2] - from.pos[2]], turn);
      light.pos = [to.pos[0] + offset[0] * factor, to.pos[1] + offset[1] * factor, to.pos[2] + offset[2] * factor];
      if (light.dir) light.dir = applyQuat(light.dir, turn);
      light.reach *= factor;
      carried.add(index);
    }
  };
  if (lights.some(light => light.assembly)) for (const id of wholeAssembliesIn(doc, [...before.keys()])) {
    const members = assemblyMembers(doc, id);
    carry(members.props[0], members.lights);
  }
  if (alsoLights.length) carry(before.keys().next().value,
    lights.flatMap((light, index) => light.id && alsoLights.includes(light.id) ? [index] : []));
  return carried.size;
}

/** Remove the lights of groups `ids` that have no props left — a group's lights go when the group does. Answers
 *  how many went. */
export function dropOrphanedAssemblyLights(doc: AssemblyDoc, ids: Iterable<string>): number {
  const gone = new Set([...ids].filter(id => !assemblyMembers(doc, id).props.length));
  if (!gone.size || !doc.lights) return 0;
  const before = doc.lights.length;
  doc.lights = doc.lights.filter(light => !light.assembly || !gone.has(light.assembly));
  return before - doc.lights.length;
}

/**
 * Break a mined GROUP placement into the placements it carries (docs/015): each member where it stands, with its
 * own settings (docs/069), and each of the group's lights as a free light.
 *
 * The leader takes the placement's place and keeps its id, so the effects and screens attached to the group stay
 * on the leader — the member whose pose is the placement's own. The others are appended, so no other placement's
 * index moves.
 *
 * What the pieces are tied into: the authored group the placement already belonged to, if any. Otherwise `tie`
 * ties them into a new one — how a group from the library lands — and without it they are left on their own, which
 * is what breaking a group means. A one-member group with no lights has nothing to tie.
 *
 * Answers the indices of every piece, leader first, how many lights were freed, and the group they are in.
 */
export function unpackGroupPlacement(doc: AssemblyDoc, index: number, def: GroupDef, opts: { tie?: boolean } = {}):
  { indices: number[]; lights: number; assembly: string | null } {
  const props = doc.props ?? [];
  const placement = props[index];
  if (!placement) return { indices: [], lights: 0, assembly: null };
  const freed = groupPlacedLights(placement, def, index);
  const pieces = expandGroupProps(placement, def);
  const assembly = placement.assembly
    ?? (opts.tie && pieces.length + freed.length > 1 ? nextAssemblyId(doc) : undefined);
  const tag = assembly ? { assembly } : {};
  const [leader, ...others] = pieces;
  props[index] = { ...leader, ...(placement.id ? { id: placement.id } : {}),
    ...(placement.labels ? { labels: placement.labels } : {}), ...tag };
  const indices = [index];
  for (const member of others) indices.push(props.push({ ...member, id: nextPlacedPropId(props), ...tag }) - 1);
  if (freed.length) {
    const lights = (doc.lights ??= []);
    for (const light of freed) {
      const authored: AuthoredLight = {
        id: nextLightId(lights), kind: light.kind, name: light.name, pos: light.pos,
        color: light.colorHex, intensity: light.intensity, reach: light.reach,
        ...(light.kind === 'spot'
          ? { dir: light.dir, cone: Math.acos(Math.min(1, Math.max(-1, light.coneCos))) * 180 / Math.PI } : {}),
        ...(light.glint ? { glint: light.glint } : {}),
        ...tag,
      };
      lights.push(authored);
    }
  }
  return { indices, lights: freed.length, assembly: assembly ?? null };
}
