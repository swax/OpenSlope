// tier: fast

/**
 * A GROUP placement's per-member behaviour (docs/069): a tree's trunk solid and silent under ride-through leaves
 * that rustle.
 *
 *  - resolution: a member with an entry of its own behaves by it; one without behaves as its placement, except
 *    that only the leader inherits the ambient loop (a group placed before per-member behaviour kept ONE loop);
 *    the mode layer is always the group's;
 *  - expansion: the export's member placements carry that behaviour, and legacy Solid/bounce flags reach only
 *    the members that infer from their placement;
 *  - materializing: the first per-member edit writes an entry for every member holding what it does now;
 *  - library defaults: each member its own model's derived defaults;
 *  - sanitizing, and the WAV walk that project transfer and assets share;
 *  - export: per-member tuning joins on `<id>#<model>`, which the bake registers for that member's mesh alone,
 *    and a self-lit member's lighting is written ahead of its placement's so the first-wins join picks it;
 *  - Test: a placement key covers its members' collider keys, so retiring the group retires every member.
 *
 * Run: tsx test/group-member-behaviour.test.ts
 */
import type { PlacedProp } from '../src/core/doc/types';
import type { EditDoc } from '../src/core/doc/doc-edit';
import type { LevelProps, PropInstance, PropModel } from '../src/core/reference/props';
import type { GroupDef } from '../src/core/reference/groups';
import type { ExportProvider } from '../src/core/export/provider';
import {
  behaviourRecords, groupMemberDefaults, groupMemberKey, groupMemberProp, materializeMemberBehaviour, memberBehaviour,
  sanitizePropBehaviour,
} from '../src/core/props/defaults';
import { defaultPlacedPropCollision, placedPropSolid } from '../src/core/props/contact';
import { expandGroupProps } from '../src/core/reference/groups';
import { buildExportFolder } from '../src/core/export/folder';
import { blankMountain } from '../src/core/doc/mountain';
import { obstacleHostKey, obstacleKeyCovers } from '../src/app/ride/obstacles';
import { check, failures } from './check';

const TRUNK = 1, LEAVES = 2;
const SOLID = defaultPlacedPropCollision('GARI');
const THROUGH = { mode: 1 as const, playerCollision: true, responseMass: 0, playerBounce: false, bounceAmount: 0 };
const TREE: GroupDef = {
  id: 'tree', name: 'Tree', level: 'GARI', lights: [], occurrences: 40,
  props: [
    { model: TRUNK, name: 'Mdl_TreeH_Trunk', relPos: [0, 0, 0], relYaw: 0 },
    { model: LEAVES, name: 'Mdl_TreeH_SnowLeaves', relPos: [0, 0, 0], relYaw: 0 },
  ],
};
const placement = (over: Partial<PlacedProp> = {}): PlacedProp => ({
  id: 'prop:0001', level: 'GARI', model: TRUNK, name: 'Tree', group: 'tree', pos: [5, 1, -3], yaw: 0, scale: 1,
  ...over,
});

// ---- resolution
{
  const shared = placement({ collisionSound: 72, ambientSound: 97, modePresence: 'showoff' });
  check(memberBehaviour(shared, TRUNK).ambientSound === 97, 'without entries, the leader keeps the placement’s loop');
  check(memberBehaviour(shared, LEAVES).ambientSound === undefined,
    'and the other members do not — one loop per group, as Test always played it');
  check(memberBehaviour(shared, LEAVES).collisionSound === 72, 'the hit sound is every member’s');
  check(memberBehaviour(shared, LEAVES).modePresence === 'showoff', 'the mode layer is the group’s');

  const split = placement({
    modePresence: 'showoff',
    memberBehaviour: {
      [TRUNK]: { nativeCollision: SOLID, collisionSound: 72 },
      [LEAVES]: { nativeCollision: THROUGH, collisionSound: 7, ambientSound: 97 },
    },
  });
  const leaves = memberBehaviour(split, LEAVES);
  check(leaves.collisionSound === 7 && leaves.nativeCollision?.responseMass === 0,
    'a member with an entry behaves by it');
  check(leaves.ambientSound === 97, 'and carries its own loop even though it is not the leader');
  check(leaves.memberBehaviour === undefined, 'a member has no members of its own');
  check(leaves.modePresence === 'showoff', 'the mode layer is still the group’s');
  check(placedPropSolid(groupMemberProp(split, TRUNK)) && !placedPropSolid(groupMemberProp(split, LEAVES)),
    'as a placement, the trunk is solid and the leaves are not');
}

// ---- expansion: what the export bakes and tunes per member
{
  const legacy = placement({ solid: false });
  const [trunk, leaves] = expandGroupProps(legacy, TREE);
  check(trunk.solid === false && leaves.solid === false,
    'a legacy group’s Solid flag reaches every member that infers from it');
  const split = placement({ solid: false, memberBehaviour: { [TRUNK]: { nativeCollision: SOLID } } });
  const [ownTrunk, fallbackLeaves] = expandGroupProps(split, TREE);
  check(ownTrunk.solid === undefined && placedPropSolid(ownTrunk),
    'a member with its own entry ignores the placement’s legacy flag');
  check(fallbackLeaves.solid === false, 'and a member without one still infers as its placement does');
  check(trunk.model === TRUNK && leaves.model === LEAVES && trunk.pos.join() === '5,1,-3',
    'members keep their models and poses');
}

// ---- materializing: the first per-member edit changes nothing else
{
  const legacy = placement({ solid: false, collisionSound: 72, ambientSound: 97 });
  const entries = materializeMemberBehaviour(legacy, [TRUNK, LEAVES]);
  check(Object.keys(entries).sort().join() === `${TRUNK},${LEAVES}`, 'every member gets an entry');
  check(entries[TRUNK].nativeCollision !== undefined && entries[LEAVES].nativeCollision !== undefined,
    'each with its collision profile written out, legacy inference included');
  check(entries[TRUNK].nativeCollision?.playerCollision === true && entries[TRUNK].nativeCollision?.responseMass === 0,
    'a non-solid legacy group with a hit sound stays ride-through, not decorative');
  check(entries[TRUNK].ambientSound === 97 && entries[LEAVES].ambientSound === undefined,
    'the loop stays on the leader alone');
  check(entries[TRUNK].modePresence === undefined, 'no member carries a mode layer');
  const after = placement({ ...legacy, memberBehaviour: entries });
  const before = expandGroupProps(legacy, TREE), now = expandGroupProps(after, TREE);
  check(before.every((member, i) => placedPropSolid(member) === placedPropSolid(now[i])
    && member.collisionSound === now[i].collisionSound && member.ambientSound === now[i].ambientSound),
  'the expanded members behave exactly as before the split');
}

// ---- library defaults: each member its own model's
{
  let index = 0;
  const inst = (model: number, over: Partial<PropInstance>): PropInstance => ({
    sourceIndex: index++, ltgState: 0, model, loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], name: 'i',
    visible: true, playerCollision: true, playerBounce: true, collisionSound: -1, contact: 'solid', bounce: 0.5,
    surface: -1, shape: 1, responseMass: 1e30, dynamicMass: -1, physicsBody: -1, externalSounds: [], ...over,
  });
  const model = (id: number, name: string): PropModel => ({ id, name, subs: [] });
  const level = {
    level: 'GARI', models: [model(TRUNK, 'Mdl_TreeH_Trunk'), model(LEAVES, 'Mdl_TreeH_SnowLeaves')],
    instances: [
      inst(TRUNK, { collisionSound: 72 }), inst(TRUNK, { collisionSound: 72, ltgState: 2 }),
      inst(TRUNK, { collisionSound: 72, ltgState: 2 }),
      inst(LEAVES, { contact: 'through', responseMass: 0, playerBounce: false, bounce: -1, collisionSound: 7 }),
    ],
    materials: new Map(), crowdFrames: [],
  } as LevelProps;
  const defaults = groupMemberDefaults('GARI', [TRUNK, LEAVES], level);
  check(defaults[TRUNK].collisionSound === 72 && defaults[TRUNK].nativeCollision.responseMass !== 0,
    'the trunk arrives solid with its thud');
  check(defaults[LEAVES].collisionSound === 7 && defaults[LEAVES].nativeCollision.responseMass === 0,
    'the leaves arrive ride-through with their rustle');
  check(defaults[TRUNK].modePresence === undefined, 'a member default never carries the mode layer');
}

// ---- sanitizing and the WAV walk
{
  const clean = sanitizePropBehaviour({
    memberBehaviour: {
      1: { collisionSound: 72, modePresence: 'showoff', memberBehaviour: { 3: { collisionSound: 1 } } },
      leaves: { collisionSound: 7 },
      2: { bogus: true },
    },
  });
  check(JSON.stringify(clean) === JSON.stringify({ memberBehaviour: { 1: { collisionSound: 72 } } }),
    'model-id keys only, each entry sanitized, no mode layer or members of its own, empty entries dropped',
    JSON.stringify(clean));
  const files = behaviourRecords(placement({ collisionSoundFile: 'a.wav',
    memberBehaviour: { [LEAVES]: { ambientSoundFile: 'b.wav' } } }))
    .flatMap(record => [record.collisionSoundFile, record.ambientSoundFile]).filter(Boolean);
  check(files.join() === 'a.wav,b.wav', 'the WAVs a group names are its own and its members’', files.join());
}

// ---- Test collider keys
{
  const member = `authored:${groupMemberKey('prop:0001', LEAVES)}`;
  check(obstacleKeyCovers(member, 'authored:prop:0001'), 'retiring a group placement covers its members');
  check(!obstacleKeyCovers('authored:prop:00012', 'authored:prop:0001'), 'but never another placement’s id');
  check(obstacleHostKey(member) === 'authored:prop:0001' && obstacleHostKey('reference:12') === 'reference:12',
    'a member key resolves to its placement’s');
}

// ---- export: per-member tuning, joined per member
const provider = {
  groupDefs: async () => new Map([['GARI:tree', TREE]]),
  modelGeometry: async () => () => ({ subs: [] }),
  materialTables: async () => new Map(),
  importedProps: async () => ({ models: [], instances: [] }),
  nativeArt: async () => ({ rail: null, gem: null }),
  referenceTexture: async () => new Uint8Array(),
  particleTexture: async () => new Uint8Array(),
  customSound: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]),
  soundIndex: async () => null,
  courseEffectSound: async () => new Uint8Array(),
  namedEffectSound: async () => new Uint8Array(),
  environmentEffectSound: async () => new Uint8Array(),
  skybox: async () => ({ files: [], log: [] }),
  discRecipePaths: async () => ({ exportDir: 'GROUPTEST', levelData: 'Maps/GARI', levelDataRelative: '../GARI' }),
  stageRaceMusic: async () => ({ status: 'cleared', files: [], remove: [] }),
  encodePng: async () => new Uint8Array(), // the lit case's lightmap pages; no assertion reads them
} as unknown as ExportProvider;

type Join = Record<string, unknown>;
async function exportOf(props: PlacedProp[], lighting = false) {
  const doc = { ...(blankMountain('GROUPTEST') as unknown as EditDoc), props } as EditDoc;
  const folder = await buildExportFolder(doc, provider, { lighting });
  const read = (name: string) => {
    const file = folder.files.find(entry => entry.path.endsWith(name));
    if (!file) throw new Error(`the export wrote no ${name}`);
    return JSON.parse(new TextDecoder().decode(file.bytes)) as unknown;
  };
  return { read, slopesmith: (read('Effects.json') as { extensions: { slopesmith: Record<string, Join> } })
    .extensions.slopesmith };
}
const slopesmithOf = async (props: PlacedProp[]) => (await exportOf(props)).slopesmith;

async function main(): Promise<void> {
  {
    const out = await slopesmithOf([placement({
      modePresence: 'showoff',
      memberBehaviour: {
        [TRUNK]: { nativeCollision: SOLID, collisionSound: 72, surface: 12 },
        [LEAVES]: { nativeCollision: THROUGH, collisionSound: 7 },
      },
    })]);
    const baked = out.bakedGroups as Record<string, string[]>;
    const trunkKey = groupMemberKey('prop:0001', TRUNK), leavesKey = groupMemberKey('prop:0001', LEAVES);
    check(baked['prop:0001']?.length === 2, 'the placement id still joins every member (effects, poses)');
    check(baked[trunkKey]?.length === 1 && baked[leavesKey]?.length === 1 && baked[trunkKey][0] !== baked[leavesKey][0],
      'each member key joins its own mesh alone', JSON.stringify(baked));
    const sounds = out.collisionSounds as Record<string, number>;
    check(sounds[trunkKey] === 72 && sounds[leavesKey] === 7, 'each member ships its own hit sound');
    check(sounds['prop:0001'] === undefined, 'and nothing per-member is written under the placement id');
    const collisions = out.nativeCollisions as Record<string, { responseMass: number; transform: { location: number[] } }>;
    check(collisions[trunkKey]?.responseMass !== 0 && collisions[leavesKey]?.responseMass === 0,
      'the trunk ships solid and the leaves ride-through');
    check(!!collisions[leavesKey]?.transform, 'each member collision carries its own instance transform');
    check((out.propSurfaces as Record<string, number>)[trunkKey] === 12, 'the trunk’s ride surface is its own');
  }
  {
    // A group placed before per-member behaviour: every member takes the hit sound, only the leader the loop.
    const out = await slopesmithOf([placement({ collisionSound: 72, ambientSound: 97 })]);
    const sounds = out.collisionSounds as Record<string, number>;
    const ambient = out.ambientSounds as Record<string, unknown>;
    check(sounds[groupMemberKey('prop:0001', TRUNK)] === 72 && sounds[groupMemberKey('prop:0001', LEAVES)] === 72,
      'an older group’s hit sound reaches every member, as it did');
    check(Object.keys(ambient).join() === groupMemberKey('prop:0001', TRUNK),
      'and it ships ONE loop, on the leader', Object.keys(ambient).join());
  }
  {
    // Lighting is the one channel with both a placement entry and member entries: the member's must win.
    const { slopesmith } = await exportOf([placement({
      memberBehaviour: { [TRUNK]: { nativeCollision: SOLID }, [LEAVES]: { nativeCollision: THROUGH, fullBright: true } },
    })], true);
    const lighting = slopesmith.propLighting as Record<string, { amb: number[]; key: number[] }>;
    const leaves = lighting[groupMemberKey('prop:0001', LEAVES)], group = lighting['prop:0001'];
    check(!!leaves && !!group, 'a self-lit member has its own lighting entry beside the placement’s');
    const keys = Object.keys(lighting);
    check(keys.indexOf(groupMemberKey('prop:0001', LEAVES)) < keys.indexOf('prop:0001'),
      'written first, so the first-wins join gives that member its own', keys.join());
    check(JSON.stringify(leaves) !== JSON.stringify(group), 'and it differs from the sunlit placement’s');
  }

  console.log(failures ? `\n${failures} failure(s)` : '\ngroup-member-behaviour: ok');
  process.exit(failures ? 1 : 0);
}

void main();
