// tier: fast

/**
 * How the export allocates reserved event ids to authored WAVs.
 *
 * An uploaded WAV supplies the CLIP; the reserved event supplies the ROUTING, and the routing decides how
 * `snowknife repack` ENCODES the bank slot behind it. A continuing emitter's slot is written with a loop
 * region and an impact's is not [Trailmap: 260-psadpcm-loop], which means the two uses of one file are two
 * different sets of bytes and cannot share a slot. Allocating by filename alone gave them one, and since the
 * event appeared in `ambientSounds` the shared slot was encoded looping — so hitting the prop started a
 * one-shot that sustained for the rest of the run, on a disc where nothing else looked wrong.
 *
 * The gated class is the deliberate exception, and it is asserted here for the same reason: events 16/28/57
 * ARE one id serving a hit and a sustaining emitter together, which is what a retail fire hydrant is, so a
 * fix that split them would have broken the feature it was tidying.
 *
 * Run: tsx test/export-sound-events.test.ts
 */
import { buildExportFolder } from '../src/core/export/folder';
import { blankMountain } from '../src/core/doc/mountain';
import type { EditDoc } from '../src/core/doc/doc-edit';
import type { ExportProvider } from '../src/core/export/provider';
import { check, failures } from './check';

/**
 * Enough provider to export a two-prop document. Everything the document does not reach answers empty rather
 * than throwing, so a change that starts reaching for bytes shows up as a failed assertion here rather than
 * as a stack trace from somewhere unrelated.
 */
const provider = {
  groupDefs: async () => new Map(),
  // A model with no submeshes: the props here exist to carry SOUND records, and giving them geometry would
  // only add bake output that none of the assertions read.
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
  discRecipePaths: async () => ({ exportDir: 'SOUNDTEST', levelData: 'Maps/DONOR', levelDataRelative: '../DONOR' }),
  stageRaceMusic: async () => ({ status: 'cleared', files: [], remove: [] }),
} as unknown as ExportProvider;

const SHARED = 'thunder.wav';

/** Two props, one WAV: the first is hit by the rider, the second hums it as a bed. */
function doc(hitGated?: string[]): EditDoc {
  const base = blankMountain('SOUNDTEST') as unknown as EditDoc;
  return {
    ...base,
    props: [
      { id: 'impact', level: 'DONOR', model: 1, name: 'Mdl_Crate', pos: [0, 0, 0], yaw: 0, scale: 1,
        collisionSoundFile: SHARED },
      { id: 'bed', level: 'DONOR', model: 1, name: 'Mdl_Crate', pos: [10, 0, 0], yaw: 0, scale: 1,
        ambientSoundFile: SHARED },
    ],
    ...(hitGated ? { hitGatedSounds: hitGated } : {}),
  } as unknown as EditDoc;
}

async function effectsOf(source: EditDoc): Promise<Record<string, unknown>> {
  const folder = await buildExportFolder(source, provider, { lighting: false });
  const file = folder.files.find(entry => entry.path.endsWith('Effects.json'));
  if (!file) throw new Error('the export wrote no Effects.json');
  return JSON.parse(new TextDecoder().decode(file.bytes)) as Record<string, unknown>;
}

async function main(): Promise<void> {
  {
    const effects = await effectsOf(doc());
    const slopesmith = (effects.extensions as Record<string, Record<string, never>>).slopesmith;
    const events = slopesmith.customSoundEvents as unknown as Record<string, string>;
    const collision = slopesmith.collisionSounds as unknown as Record<string, number>;
    const ambient = slopesmith.ambientSounds as unknown as Record<string, { event: number }>;

    check(collision.impact !== undefined && ambient.bed !== undefined,
      'both uses of the WAV survive the export');
    check(collision.impact !== ambient.bed?.event,
      `one WAV in two roles takes two events (impact ${collision.impact}, bed ${ambient.bed?.event})`);
    check(Object.keys(events).length === 2,
      `and therefore two reserved events (got ${Object.keys(events).length})`);
    check(new Set(Object.values(events)).size === 1,
      'both events name the same staged clip — one WAV, encoded twice');
  }

  {
    // The same document with the file CLAIMED. The gate is one id doing both jobs, so here they must agree.
    const effects = await effectsOf(doc([SHARED]));
    const slopesmith = (effects.extensions as Record<string, Record<string, never>>).slopesmith;
    const collision = slopesmith.collisionSounds as unknown as Record<string, number>;
    const ambient = slopesmith.ambientSounds as unknown as Record<string, { event: number }>;

    check(collision.impact === ambient.bed?.event,
      `a hit-gated claim keeps ONE id across both roles (impact ${collision.impact}, bed ${ambient.bed?.event})`);
    check(collision.impact === 16 || collision.impact === 28 || collision.impact === 57,
      `and that id is one the engine's interactive class tests (got ${collision.impact})`);
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall ok');
  process.exit(failures ? 1 : 0);
}

void main();
