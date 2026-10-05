import type { AuthoredLight, PlacedProp, QuadMeshDoc, V3 } from '../doc/types';
import { nextLightId } from '../doc/ids';
import { nextPlacedPropId } from '../effects/authoring';
import { isEffectTriggerProp } from '../effects/trigger-volume';
import { expandGroupProps, groupPlacedLights, type GroupDef } from '../reference/groups';
import { rotateY } from './pose';

/**
 * Authored GROUPS (docs/015 · Authored groups): any placements the author ties together, tagged with one shared
 * `PlacedProp.assembly` id.
 *
 * A mined group is ONE placement whose members derive from a def. An authored group is the other way round: every
 * member stays an ordinary placement, with its own pose, level, settings, effects and screens, so a group can mix
 * levels and nothing downstream — export, Test, collision, sound — has to know it exists. What the tag adds is
 * editing: a click on any member selects them all, and the selection's gizmo and the group panel move, turn and
 * size the set as one.
 *
 * A group needs two members. A tag on one placement alone (its partners deleted, or a lone member pasted) is no
 * group, and every reader here treats it as absent.
 */

/** The placements tagged `id`, by index, in document order. */
export function assemblyIndices(props: readonly PlacedProp[], id: string): number[] {
  const out: number[] = [];
  props.forEach((prop, i) => { if (prop.assembly === id) out.push(i); });
  return out;
}

/** Every member of the group placement `index` belongs to, itself included — or null when it is on its own. */
export function assemblyOf(props: readonly PlacedProp[], index: number): number[] | null {
  const id = props[index]?.assembly;
  if (!id) return null;
  const members = assemblyIndices(props, id);
  return members.length > 1 ? members : null;
}

/** `indices` with every group any of them belongs to filled in, sorted — so a group always selects whole. */
export function withWholeAssemblies(props: readonly PlacedProp[], indices: readonly number[]): number[] {
  const out = new Set(indices);
  for (const index of indices) for (const member of assemblyOf(props, index) ?? []) out.add(member);
  return [...out].sort((a, b) => a - b);
}

/** The group `indices` are exactly — every member of one group and nothing else — or null. */
export function wholeAssembly(props: readonly PlacedProp[], indices: readonly number[]): string | null {
  const id = props[indices[0]]?.assembly;
  if (!id) return null;
  const members = assemblyIndices(props, id);
  const picked = new Set(indices);
  return members.length > 1 && picked.size === members.length && members.every(i => picked.has(i)) ? id : null;
}

/** A group id no placement uses yet. */
export function nextAssemblyId(props: readonly PlacedProp[]): string {
  const used = new Set(props.map(prop => prop.assembly).filter((id): id is string => !!id));
  for (let i = 0; ; i++) {
    const id = `group:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** Why the placements at `indices` cannot become a group, or null when they can. */
export function assemblyRefusal(props: readonly PlacedProp[], indices: readonly number[]): string | null {
  const picked = [...new Set(indices)].map(i => props[i]).filter((prop): prop is PlacedProp => !!prop);
  if (picked.length < 2) return 'Select at least two props to make a group.';
  // A line lays its members out again whenever it changes, which would pull them back out of any group's shape.
  if (picked.some(prop => prop.line)) return 'Props laid out by a line can’t join a group — break the line into props first.';
  if (picked.some(isEffectTriggerProp)) return 'Effects trigger volumes can’t join a group.';
  return null;
}

/** Tie the placements at `indices` into one new group and answer its id. A member of another group leaves it. */
export function createAssembly(props: PlacedProp[], indices: readonly number[]): string {
  const id = nextAssemblyId(props);
  for (const index of new Set(indices)) if (props[index]) props[index].assembly = id;
  return id;
}

/** Release every member of group `id` into a placement of its own, and answer their indices. */
export function breakAssembly(props: PlacedProp[], id: string): number[] {
  const members = assemblyIndices(props, id);
  for (const index of members) delete props[index].assembly;
  return members;
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

/**
 * Break a mined GROUP placement into the placements it carries (docs/015): each member where it stands, with its
 * own settings (docs/069), and each of the group's lights as a free light.
 *
 * The leader takes the placement's place and keeps its id, so the effects and screens attached to the group stay
 * on the leader — the member whose pose is the placement's own. The others are appended, so no other placement's
 * index moves. A group that was itself a member of an authored group keeps every piece in it.
 *
 * Answers the indices of every piece, leader first, and how many lights were freed.
 */
export function unpackGroupPlacement(doc: Pick<QuadMeshDoc, 'props' | 'lights'>, index: number, def: GroupDef):
  { indices: number[]; lights: number } {
  const props = doc.props ?? [];
  const placement = props[index];
  if (!placement) return { indices: [], lights: 0 };
  const freed = groupPlacedLights(placement, def, index);
  const keep = {
    ...(placement.labels ? { labels: placement.labels } : {}),
    ...(placement.assembly ? { assembly: placement.assembly } : {}),
  };
  const [leader, ...others] = expandGroupProps(placement, def);
  props[index] = { ...leader, ...(placement.id ? { id: placement.id } : {}), ...keep };
  const indices = [index];
  for (const member of others) {
    const { labels: _labels, ...shared } = keep;
    indices.push(props.push({ ...member, id: nextPlacedPropId(props), ...shared }) - 1);
  }
  if (freed.length) {
    const lights = (doc.lights ??= []);
    for (const light of freed) {
      const authored: AuthoredLight = {
        id: nextLightId(lights), kind: light.kind, name: light.name, pos: light.pos,
        color: light.colorHex, intensity: light.intensity, reach: light.reach,
        ...(light.kind === 'spot'
          ? { dir: light.dir, cone: Math.acos(Math.min(1, Math.max(-1, light.coneCos))) * 180 / Math.PI } : {}),
        ...(light.glint ? { glint: light.glint } : {}),
      };
      lights.push(authored);
    }
  }
  return { indices, lights: freed.length };
}
