// tier: fast

/**
 * Authored groups (docs/015 · Authored groups): placements tied together by a shared `assembly` tag, each still a
 * prop of its own.
 *
 *  - membership: a tag needs two placements to be a group, a group selects whole, and only a selection holding
 *    exactly one group's members is that group;
 *  - making and breaking one, and what may not join;
 *  - turning and sizing the set about one pivot;
 *  - breaking a MINED group placement into its props and free lights;
 *  - copy / paste: a pasted group is a new group, and a lone pasted member is no group.
 *
 * Run: tsx test/prop-assembly.test.ts
 */
import type { PlacedProp, QuadMeshDoc } from '../src/core/doc/types';
import type { GroupDef } from '../src/core/reference/groups';
import {
  assemblyIndices, assemblyOf, assemblyRefusal, breakAssembly, createAssembly, scalePlacements, turnPlacements,
  unpackGroupPlacement, wholeAssembly, withWholeAssemblies,
} from '../src/core/props/assembly';
import { copyPlacements, pastePlacements } from '../src/core/props/clipboard';
import { EFFECT_TRIGGER_LEVEL } from '../src/core/effects/trigger-volume';
import { defaultPlacedPropCollision } from '../src/core/props/contact';
import { check, failures } from './check';

const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const prop = (id: string, extra: Partial<PlacedProp> = {}): PlacedProp =>
  ({ id, level: 'GARI', model: 7, name: 'Mdl_Rock_1', pos: [0, 0, 0], yaw: 0, scale: 1, ...extra });

// ---- membership
{
  const props = [
    prop('prop:0000', { assembly: 'group:0000' }),
    prop('prop:0001'),
    prop('prop:0002', { assembly: 'group:0000', level: 'MERQ' }),
    prop('prop:0003', { assembly: 'group:0001' }),
  ];
  check(near(assemblyOf(props, 0) ?? [], [0, 2]), 'a tagged placement answers every member of its group');
  check(assemblyOf(props, 1) === null, 'an untagged one is on its own');
  check(assemblyOf(props, 3) === null, 'and so is a tag on one placement alone — a group needs two');
  check(near(withWholeAssemblies(props, [2, 1]), [0, 1, 2]), 'a selection touching a group takes all of it');
  check(wholeAssembly(props, [2, 0]) === 'group:0000', 'a selection of exactly one group’s members is that group');
  check(wholeAssembly(props, [0, 1, 2]) === null, 'one with anything else besides is not');
  check(wholeAssembly(props, [0]) === null, 'nor is part of one');
}

// ---- making and breaking
{
  const props = [
    prop('prop:0000', { assembly: 'group:0000' }), prop('prop:0001', { assembly: 'group:0000' }),
    prop('prop:0002'), prop('prop:0003', { line: 'line:0000' }),
    prop('prop:0004', { level: EFFECT_TRIGGER_LEVEL, effectTrigger: { size: [2, 2, 2] } }),
  ];
  check(assemblyRefusal(props, [2]) !== null, 'one prop is not a group');
  check(assemblyRefusal(props, [2, 3]) !== null, 'a line’s member may not join — its line would lay it out again');
  check(assemblyRefusal(props, [2, 4]) !== null, 'nor may an Effects trigger volume');
  check(assemblyRefusal(props, [1, 2]) === null, 'two ordinary props may, even one already in a group');
  const id = createAssembly(props, [1, 2]);
  check(id !== 'group:0000', 'a new group gets an id of its own', id);
  check(props[1].assembly === id && props[2].assembly === id, 'and every picked placement carries it');
  check(assemblyOf(props, 0) === null, 'the member it took leaves its old group, which is no group with one left');
  check(near(breakAssembly(props, id), [1, 2]) && !props[1].assembly && !props[2].assembly,
    'breaking a group releases every member');
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

// ---- breaking a mined group placement
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
  const doc: Pick<QuadMeshDoc, 'props' | 'lights'> = {
    lights: [],
    props: [
      prop('prop:0000'),
      prop('prop:0001', {
        model: TRUNK, name: 'Lamp', group: 'lamp', pos: [5, 1, -3], yaw: 90, scale: 2, labels: ['label:0000'],
        assembly: 'group:0000', modePresence: 'showoff',
        memberBehaviour: { [TRUNK]: { nativeCollision: SOLID }, [LEAVES]: { nativeCollision: THROUGH, fullBright: true } },
      }),
      prop('prop:0002', { assembly: 'group:0000' }),
    ],
  };
  const { indices, lights } = unpackGroupPlacement(doc, 1, LAMP);
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
  check(props[1].assembly === 'group:0000' && props[3].assembly === 'group:0000',
    'a group that was in an authored group leaves every piece in it');
  check(near(assemblyIndices(props, 'group:0000'), [1, 2, 3]), 'so that group now holds them all');
  check(lights === 1 && doc.lights!.length === 1, 'its light becomes a free light');
  const light = doc.lights![0];
  check(light.kind === 'spot' && light.color === '#ffeeaa' && light.intensity === 3 && !!light.id,
    'with its kind, colour and intensity');
  check(Math.abs((light.cone ?? 0) - 30) < 1e-9 && light.reach === 40, 'its cone, and its reach at the group’s size',
    `${light.cone} ${light.reach}`);
  check(near(light.pos, [5 + 2 * 2, 1 + 10 * 2, -3]), 'standing where the group carried it', light.pos.join());
}

// ---- copy / paste
{
  const doc: Pick<QuadMeshDoc, 'name' | 'props' | 'screens' | 'effects' | 'models'> = {
    name: 'M',
    props: [
      prop('prop:0000', { assembly: 'group:0000' }), prop('prop:0001', { assembly: 'group:0000' }),
      prop('prop:0002', { assembly: 'group:0001' }), prop('prop:0003', { assembly: 'group:0001' }),
    ],
  };
  const both = copyPlacements(doc, [0, 1, 2, 3])!;
  const pasted = pastePlacements(doc, both).indices;
  const ids = new Set(pasted.map(i => doc.props![i].assembly));
  check(ids.size === 2 && !ids.has('group:0000') && !ids.has('group:0001') && !ids.has(undefined),
    'two copied groups paste as two new groups', [...ids].join());
  check(near(assemblyOf(doc.props!, pasted[0]) ?? [], pasted.slice(0, 2)), 'each holding its own copies');
  check(near(assemblyOf(doc.props!, 0) ?? [], [0, 1]), 'and the originals keep theirs');
  const lone = pastePlacements(doc, copyPlacements(doc, [0])!).indices[0];
  check(doc.props![lone].assembly === undefined, 'a lone member pastes on its own');
}

console.log(failures ? `\n${failures} failure(s)` : '\nprop-assembly: ok');
process.exit(failures ? 1 : 0);
