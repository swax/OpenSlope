// tier: fast

/**
 * Authored groups (docs/015 · Authored groups): props and free lights tied together by a shared `assembly` tag,
 * each still a prop or light of its own.
 *
 *  - membership: a group needs a prop and a second member, a group selects whole, and only a selection holding
 *    exactly one group's props is that group; a group's light answers as its group;
 *  - making and breaking one, and what may not join;
 *  - turning and sizing the set about one pivot, and its lights carried by any transform of its props;
 *  - deleting a group's last prop takes its lights;
 *  - breaking a MINED group placement into its props and free lights, and the same unpacking tying them into a
 *    new group, which is how a group from the library lands;
 *  - copy / paste: a pasted group is a new group, its lights with it, and a lone pasted member is no group.
 *
 * Run: tsx test/prop-assembly.test.ts
 */
import type { AuthoredLight, PlacedProp, QuadMeshDoc } from '../src/core/doc/types';
import type { GroupDef } from '../src/core/reference/groups';
import {
  assemblyMembers, assemblyOf, assemblyRefusal, breakAssembly, carryAssemblyLights, createAssembly,
  dropOrphanedAssemblyLights, lightAssemblyOf, nextAssemblyId, placementPoses, scalePlacements, turnPlacements,
  unpackGroupPlacement, wholeAssembly, withWholeAssemblies,
} from '../src/core/props/assembly';
import { copyPlacements, pastePlacements } from '../src/core/props/clipboard';
import { EFFECT_TRIGGER_LEVEL } from '../src/core/effects/trigger-volume';
import { defaultPlacedPropCollision } from '../src/core/props/contact';
import { writePropRotation } from '../src/core/props/pose';
import { check, failures } from './check';

const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const prop = (id: string, extra: Partial<PlacedProp> = {}): PlacedProp =>
  ({ id, level: 'GARI', model: 7, name: 'Mdl_Rock_1', pos: [0, 0, 0], yaw: 0, scale: 1, ...extra });
const light = (id: string, extra: Partial<AuthoredLight> = {}): AuthoredLight =>
  ({ id, kind: 'point', pos: [0, 0, 0], color: '#ffffff', intensity: 1, reach: 10, ...extra });

// ---- membership
{
  const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
    props: [
      prop('prop:0000', { assembly: 'group:0000' }),
      prop('prop:0001'),
      prop('prop:0002', { assembly: 'group:0000', level: 'MERQ' }),
      prop('prop:0003', { assembly: 'group:0001' }),
      prop('prop:0004', { assembly: 'group:0002' }),
    ],
    lights: [light('light:0000', { assembly: 'group:0002' }), light('light:0001', { assembly: 'group:0003' }),
      light('light:0002', { assembly: 'group:0003' })],
  };
  check(near(assemblyOf(doc, 0) ?? [], [0, 2]), 'a tagged placement answers every prop of its group');
  check(assemblyOf(doc, 1) === null, 'an untagged one is on its own');
  check(assemblyOf(doc, 3) === null, 'and so is a tag on one placement alone — a group needs two members');
  check(near(assemblyOf(doc, 4) ?? [], [4]), 'a prop and a light make a group');
  check(near(lightAssemblyOf(doc, 'light:0000') ?? [], [4]), 'its light answers as its group');
  check(lightAssemblyOf(doc, 'light:0001') === null, 'lights with no prop are no group — a group is selected by its props');
  check(near(withWholeAssemblies(doc, [2, 1]), [0, 1, 2]), 'a selection touching a group takes all of it');
  check(wholeAssembly(doc, [2, 0]) === 'group:0000', 'a selection of exactly one group’s props is that group');
  check(wholeAssembly(doc, [4]) === 'group:0002', 'even when its one prop is the whole of it');
  check(wholeAssembly(doc, [0, 1, 2]) === null, 'one with anything else besides is not');
  check(wholeAssembly(doc, [0]) === null, 'nor is part of one');
  check(nextAssemblyId({ props: [], lights: [light('light:0009', { assembly: 'group:0000' })] }) === 'group:0001',
    'a new id is clear of the ids lights carry too');
}

// ---- making and breaking
{
  const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
    props: [
      prop('prop:0000', { assembly: 'group:0000' }), prop('prop:0001', { assembly: 'group:0000' }),
      prop('prop:0002'), prop('prop:0003', { line: 'line:0000' }),
      prop('prop:0004', { level: EFFECT_TRIGGER_LEVEL, effectTrigger: { size: [2, 2, 2] } }),
    ],
    lights: [light('light:0000', { assembly: 'group:0000' })],
  };
  const props = doc.props!;
  check(assemblyRefusal(props, [2]) !== null, 'one prop is not a group');
  check(assemblyRefusal(props, [2, 3]) !== null, 'a line’s member may not join — its line would lay it out again');
  check(assemblyRefusal(props, [2, 4]) !== null, 'nor may an Effects trigger volume');
  check(assemblyRefusal(props, [1, 2]) === null, 'two ordinary props may, even one already in a group');
  const id = createAssembly(doc, [1, 2]);
  check(id !== 'group:0000', 'a new group gets an id of its own', id);
  check(props[1].assembly === id && props[2].assembly === id, 'and every picked placement carries it');
  check(near(assemblyOf(doc, 0) ?? [], [0]), 'the member it took leaves its old group, which still has its light');
  check(near(breakAssembly(doc, 'group:0000'), [0]) && !props[0].assembly && !doc.lights![0].assembly,
    'breaking a group releases every member, its lights too');
}

// ---- lights selected beside props: what may group, and what the group takes
{
  const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
    props: [prop('prop:0000', { assembly: 'group:0000' }), prop('prop:0001', { assembly: 'group:0000' }),
      prop('prop:0002'), prop('prop:0003')],
    lights: [light('light:0000'), light('light:0001', { assembly: 'group:0000' }), light('light:0002')],
  };
  const props = doc.props!, lights = doc.lights!;
  check(assemblyRefusal(props, [2], 1) === null, 'a prop and a light may make a group — a lamp and its halo');
  check(assemblyRefusal(props, [], 2) !== null, 'lights alone may not: a group is selected through its props');
  const lamp = createAssembly(doc, [2], ['light:0000']);
  check(props[2].assembly === lamp && lights[0].assembly === lamp, 'the selected light is tied in with the prop');
  const merged = createAssembly(doc, [0, 1, 3], ['light:0002']);
  check(lights[1].assembly === merged && lights[2].assembly === merged,
    'a group taken whole brings its own light, beside the light selected with it');
}

// ---- turning and sizing about a pivot
{
  const props = [
    prop('prop:0000', { pos: [10, 0, 0], yaw: 350, pitch: 20 }),
    prop('prop:0001', { pos: [12, 0, 0], yaw: 0, scale: 2 }),
  ];
  turnPlacements(props, [0, 1], 90, [11, 0, 0]);
  check(near(props[0].pos, [11, 0, 1]) && near(props[1].pos, [11, 0, -1]),
    'a turn swings each member about the vertical through the pivot', JSON.stringify(props.map(p => p.pos)));
  check(props[0].yaw === 80 && props[1].yaw === 90, 'and turns each member’s own yaw, wrapping at 360');
  check(props[0].pitch === 20, 'leaving its tilt intact — yaw is the outermost angle');
  scalePlacements(props, [0, 1], 2, [11, 0, 0]);
  check(near(props[0].pos, [11, 0, 2]) && near(props[1].pos, [11, 0, -2]), 'a size change spreads the spacing');
  check(props[0].scale === 2 && props[1].scale === 4, 'and grows every member by the same factor');
}

// ---- a group's lights carried by any transform of its props
{
  const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
    props: [prop('prop:0000', { pos: [10, 0, 0], assembly: 'group:0000' }),
      prop('prop:0001', { pos: [14, 0, 0], assembly: 'group:0000' }),
      prop('prop:0002', { pos: [0, 0, 0], assembly: 'group:0001' }),
      prop('prop:0003', { pos: [0, 0, 5], assembly: 'group:0001' })],
    lights: [light('light:0000', { kind: 'spot', pos: [10, 5, 1], dir: [0, 0, 1], reach: 20, assembly: 'group:0000' }),
      light('light:0001', { pos: [0, 5, 0], assembly: 'group:0001' })],
  };
  const props = doc.props!, lights = doc.lights!;
  // the gizmo's rigid turn about the set's centre: 90° about the vertical through (12, 0, 0)
  const before = placementPoses(props, [0, 1]);
  turnPlacements(props, [0, 1], 90, [12, 0, 0]);
  check(carryAssemblyLights(doc, before) === 1, 'turning a whole group carries its light');
  check(near(lights[0].pos, [13, 5, 2]), 'swung about the same centre as its props', lights[0].pos.join());
  check(near(lights[0].dir!, [1, 0, 0]), 'its aim turned with them', lights[0].dir!.join());
  // a tilt of the members in place: the light follows the first member's turn
  const tiltedBefore = placementPoses(props, [0, 1]);
  writePropRotation(props[0], { yaw: props[0].yaw, pitch: 90 });
  writePropRotation(props[1], { yaw: props[1].yaw, pitch: 90 });
  carryAssemblyLights(doc, tiltedBefore);
  check(Math.abs(Math.hypot(...lights[0].dir!) - 1) < 1e-9, 'a tilt keeps the aim a unit vector', lights[0].dir!.join());
  const scaledBefore = placementPoses(props, [0, 1]);
  scalePlacements(props, [0, 1], 3, props[0].pos);
  carryAssemblyLights(doc, scaledBefore);
  check(lights[0].reach === 60, 'a size change scales its reach', String(lights[0].reach));
  const partBefore = placementPoses(props, [2]);
  props[2].pos = [5, 0, 0];
  check(carryAssemblyLights(doc, partBefore) === 0 && near(lights[1].pos, [0, 5, 0]),
    'moving one member within its group leaves the group’s lights where they are');
}

// ---- a free light selected beside props rides with them
{
  const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
    props: [prop('prop:0000', { pos: [10, 0, 0] }), prop('prop:0001', { pos: [14, 0, 0] })],
    lights: [light('light:0000', { pos: [12, 5, 0], reach: 10 }), light('light:0001', { pos: [0, 5, 0] })],
  };
  const props = doc.props!, lights = doc.lights!;
  const before = placementPoses(props, [0, 1]);
  turnPlacements(props, [0, 1], 90, [12, 0, 0]);
  scalePlacements(props, [0, 1], 2, [12, 0, 0]);
  check(carryAssemblyLights(doc, before, ['light:0000']) === 1, 'a light selected beside the set moves with it');
  check(near(lights[0].pos, [12, 10, 0]) && lights[0].reach === 20,
    'by the same turn and size as the props', `${lights[0].pos.join()} ${lights[0].reach}`);
  check(near(lights[1].pos, [0, 5, 0]), 'and a light not selected stays put');
}

// ---- deleting a group's last prop takes its lights
{
  const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
    props: [prop('prop:0000', { assembly: 'group:0001' })],
    lights: [light('light:0000', { assembly: 'group:0000' }), light('light:0001', { assembly: 'group:0001' }),
      light('light:0002')],
  };
  check(dropOrphanedAssemblyLights(doc, ['group:0000', 'group:0001']) === 1, 'a group with no props left loses its lights');
  check(doc.lights!.map(l => l.id).join() === 'light:0001,light:0002', 'a group still standing and free lights keep theirs');
}

// ---- unpacking a mined group placement
{
  const TRUNK = 1, LEAVES = 2;
  const SOLID = defaultPlacedPropCollision('GARI');
  const THROUGH = { mode: 1 as const, playerCollision: true, responseMass: 0, playerBounce: false, bounceAmount: 0 };
  const LAMP: GroupDef = {
    id: 'lamp', name: 'Lamp', level: 'GARI', occurrences: 9,
    props: [
      { model: TRUNK, name: 'Mdl_Lamp_Post', relPos: [0, 0, 0], relYaw: 0 },
      { model: LEAVES, name: 'Mdl_Lamp_Head', relPos: [0, 0, 0], relYaw: 0 },
    ],
    lights: [{ kind: 'spot', relPos: [0, 10, 2], dir: [0, -1, 0], color: '#ffeeaa', intensity: 3,
      coneCos: Math.cos(Math.PI / 6), reach: 20, name: 'halo' }],
  };
  const lamp = (extra: Partial<PlacedProp> = {}): PlacedProp => prop('prop:0001', {
    model: TRUNK, name: 'Lamp', group: 'lamp', pos: [5, 1, -3], yaw: 90, scale: 2, labels: ['label:0000'],
    modePresence: 'showoff',
    memberBehaviour: { [TRUNK]: { nativeCollision: SOLID }, [LEAVES]: { nativeCollision: THROUGH, fullBright: true } },
    ...extra,
  });
  {
    // breaking it, inside an authored group
    const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
      lights: [],
      props: [prop('prop:0000'), lamp({ assembly: 'group:0000' }), prop('prop:0002', { assembly: 'group:0000' })],
    };
    const { indices, lights, assembly } = unpackGroupPlacement(doc, 1, LAMP);
    const props = doc.props!;
    check(near(indices, [1, 3]), 'the leader takes the placement’s place and the others are appended', indices.join());
    check(props[1].id === 'prop:0001' && props[1].model === TRUNK && !props[1].group,
      'the leader keeps the id effects and screens attach to, as a plain prop');
    check(props[3].id !== 'prop:0001' && props[3].model === LEAVES && !!props[3].id, 'the others get ids of their own');
    check(near(props[3].pos, [5, 1, -3]) && props[3].yaw === 90 && props[3].scale === 2,
      'each piece stands where the group stood');
    check(props[3].fullBright === true && props[3].nativeCollision?.mode === THROUGH.mode && !props[1].fullBright,
      'each piece keeps its own member settings');
    check(props[3].modePresence === 'showoff', 'and the group’s mode layer');
    check(!props[1].memberBehaviour && !props[3].memberBehaviour, 'and no per-member record, now each is a prop');
    check(!!props[1].labels && !props[3].labels, 'the placement’s labels stay with the leader');
    check(assembly === 'group:0000' && near(assemblyMembers(doc, 'group:0000').props, [1, 2, 3]),
      'a group that was in an authored group leaves every piece in it');
    check(lights === 1 && doc.lights!.length === 1 && doc.lights![0].assembly === 'group:0000',
      'its light becomes a free light in that group too');
    const freed = doc.lights![0];
    check(freed.kind === 'spot' && freed.color === '#ffeeaa' && freed.intensity === 3 && !!freed.id,
      'with its kind, colour and intensity');
    check(Math.abs((freed.cone ?? 0) - 30) < 1e-9 && freed.reach === 40, 'its cone, and its reach at the group’s size',
      `${freed.cone} ${freed.reach}`);
    check(near(freed.pos, [5 + 2 * 2, 1 + 10 * 2, -3]), 'standing where the group carried it', freed.pos.join());
  }
  {
    // breaking it on its own leaves the pieces on their own
    const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = { props: [lamp()] };
    const { assembly } = unpackGroupPlacement(doc, 0, LAMP);
    check(assembly === null && doc.props!.every(p => !p.assembly) && !doc.lights![0].assembly,
      'breaking a group on its own leaves its pieces and light untied');
  }
  {
    // placing it from the library ties the pieces into a new group
    const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = { props: [prop('prop:0000', { assembly: 'group:0000' }), lamp()] };
    const { indices, assembly } = unpackGroupPlacement(doc, 1, LAMP, { tie: true });
    check(!!assembly && assembly !== 'group:0000', 'a library group lands tied into a new group', String(assembly));
    check(indices.every(i => doc.props![i].assembly === assembly) && doc.lights![0].assembly === assembly,
      'every piece and its light in it');
    check(near(assemblyOf(doc, indices[0]) ?? [], indices), 'and selecting one selects the lot');
    const single: GroupDef = { ...LAMP, props: [LAMP.props[0]], lights: [] };
    const alone: Pick<QuadMeshDoc, 'props' | 'lights'> = { props: [lamp()] };
    check(unpackGroupPlacement(alone, 0, single, { tie: true }).assembly === null && !alone.props![0].assembly,
      'a one-member group with no lights lands as a plain prop — there is nothing to tie');
  }
}

// ---- copy / paste
{
  const doc: Pick<QuadMeshDoc, 'name' | 'props' | 'lights' | 'screens' | 'effects' | 'models'> = {
    name: 'M',
    props: [
      prop('prop:0000', { assembly: 'group:0000', pos: [10, 0, 0] }), prop('prop:0001', { assembly: 'group:0000' }),
      prop('prop:0002', { assembly: 'group:0001' }), prop('prop:0003', { assembly: 'group:0001' }),
    ],
    lights: [light('light:0000', { assembly: 'group:0000', pos: [10, 4, 0] })],
  };
  const both = copyPlacements(doc, [0, 1, 2, 3])!;
  check(both.lights?.length === 1, 'copying a whole group takes its light');
  const pasted = pastePlacements(doc, both).indices;
  const ids = new Set(pasted.map(i => doc.props![i].assembly));
  check(ids.size === 2 && !ids.has('group:0000') && !ids.has('group:0001') && !ids.has(undefined),
    'two copied groups paste as two new groups', [...ids].join());
  check(near(assemblyOf(doc, pasted[0]) ?? [], pasted.slice(0, 2)), 'each holding its own copies');
  check(doc.lights!.length === 2 && doc.lights![1].assembly === doc.props![pasted[0]].assembly
    && doc.lights![1].id !== 'light:0000', 'the light lands in the pasted copy of its group, under an id of its own');
  check(near(assemblyOf(doc, 0) ?? [], [0, 1]) && doc.lights![0].assembly === 'group:0000', 'and the originals keep theirs');
  const carried = pastePlacements(doc, copyPlacements(doc, [0, 1])!, { pos: [100, 0, 0], yaw: 90, scale: 2 });
  const movedLight = doc.lights![doc.lights!.length - 1];
  const movedProp = doc.props![carried.indices[0]];
  check(near([movedLight.pos[0] - movedProp.pos[0], movedLight.pos[1] - movedProp.pos[1], movedLight.pos[2] - movedProp.pos[2]],
    [0, 8, 0]), 'a carried paste keeps the light where it stood over its prop, at the paste’s size', movedLight.pos.join());
  check(movedLight.reach === 20, 'and scales its reach with it');
  check(!copyPlacements(doc, [0])!.lights, 'part of a group copies without its lights');
  const withLight = copyPlacements({ ...doc, lights: [...doc.lights!, light('light:0009', { pos: [20, 4, 0] })] },
    [2], undefined, ['light:0009']);
  check(withLight?.lights?.length === 1, 'a free light selected beside a prop is copied with it');
  const landed = pastePlacements(doc, withLight!);
  const freeLight = doc.lights!.find(l => l.id === landed.lights[0]);
  check(landed.lights.length === 1 && !!freeLight && freeLight.assembly === undefined,
    'and lands as a free light of its own — it was never in a group', JSON.stringify(landed.lights));
  const lone = pastePlacements(doc, copyPlacements(doc, [0])!).indices[0];
  check(doc.props![lone].assembly === undefined, 'a lone member pastes on its own');
}

console.log(failures ? `\n${failures} failure(s)` : '\nprop-assembly: ok');
process.exit(failures ? 1 : 0);
