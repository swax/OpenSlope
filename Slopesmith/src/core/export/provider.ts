import type { RaceMusicArrangement, SkyboxDoc } from '../doc/types';
import type { Rgba } from '../paint/ground-textures';
import type { GroupDef } from '../reference/groups';
import type { PropsPayload } from '../reference/props';
import type { ExportFile } from './files';
import type { SourceMaterial } from './materials';
import type { GeometryLookup } from './props';
import type { DiscRecipePaths } from './disc';
import type { CollisionSoundIndex } from '../effects/collision-sound';

/**
 * Everything an export needs from outside the document.
 *
 * `buildExportFolder` decides what a map folder contains; it never decides where a byte comes from. Every
 * asset it ships — a painted tile, a prop's geometry, a hit sound, the sky ring, the race track — arrives
 * through here, so one composition serves a server reading an extracted library off disk and a browser
 * reading the same assets over HTTP. Everything is async because a browser's answer is a fetch.
 */
export interface ExportProvider {
  /** Mined group defs ("<level>:<id>" → def) for the levels a placement borrows an assembly from (docs/015). */
  groupDefs(levels: readonly string[]): Promise<Map<string, GroupDef>>;

  /** Per-material submeshes of the named models, model-local raw cm. The provider batches the fetch and
   *  answers with a synchronous lookup, because the bakes emit inside tight geometry loops. */
  modelGeometry(models: readonly ModelRef[]): Promise<GeometryLookup>;

  /** Every source level's `Materials[]`, keyed by sanitised level name — what a bake resolves a slot through. */
  materialTables(): Promise<ReadonlyMap<string, readonly SourceMaterial[]>>;

  /** The imported-GLB catalogue served as the '@import' pseudo-level (docs/032). */
  importedProps(): Promise<PropsPayload>;

  /** Which extracted level supplies the native rail skin and gem crystals, and which of its models carry
   *  them. Fetched only when the document authors a rail or a gem. */
  nativeArt(): Promise<NativeArt>;

  /** A painted or prop tile's PNG bytes, verbatim — nothing is resampled, since what a page must shrink to is
   *  a property of the disc being patched. */
  referenceTexture(level: string, name: string): Promise<Uint8Array>;

  /** One sprite of the level-independent PARTICLE.SSH bank, preferring the donor the volume was lifted from. */
  particleTexture(name: string, donorLevel: string): Promise<Uint8Array>;

  /** An author-owned custom hit / ambient WAV. */
  customSound(file: string): Promise<Uint8Array>;

  /** Snowknife's locally extracted resolver for a source level. With no level, return any available complete
   * index (the executable resolver is global); null means no user-generated sidecar is installed. */
  soundIndex(level?: string): Promise<CollisionSoundIndex | null>;

  /** One slot of a level's course (or the shared crowd) effect bank as WAV. */
  courseEffectSound(level: string, slot: number, bank: 'course' | 'crowd'): Promise<Uint8Array>;

  /** One slot of a fixed global environment bank as WAV. */
  namedEffectSound(level: string, slot: number, bank: string): Promise<Uint8Array>;

  /** One slot of a level-independent environment bank, sourced from any extracted map that carries it. */
  environmentEffectSound(bank: string, slot: number, loop: boolean): Promise<Uint8Array>;

  /** The authored sky as an extracted level's `Skybox/` shape — the ring meshes and materials plus the 25
   *  pages — so `snowknife skybox` and `repack` read it without knowing it was authored (docs/025). */
  skybox(sky: SkyboxDoc): Promise<{ files: ExportFile[]; log: string[] }>;

  /** RGBA → PNG bytes for the procedural tiles and the baked lightmap pages. */
  encodePng(image: Rgba): Promise<Uint8Array>;

  /** Normalize the Scene ▸ Sound selection into the folder's `Music/track.wav` + `arrangement.json` contract:
   *  PCM16, 36 kHz, stereo, beside the arrangement the repacker reads. Undefined is a legacy save, whose
   *  hand-staged track is preserved; null is an explicit "none", which clears it. Staging decides what
   *  `Music/` holds — including what it must lose — because those are answers about what is already there. */
  stageRaceMusic(selection: string | null | undefined,
    arrangement: RaceMusicArrangement | undefined): Promise<StagedRaceMusic>;

  /** Where the disc recipe's commands point — this folder and the reference library — as the machine that
   *  runs `snowknife` addresses them. */
  discRecipePaths(): Promise<DiscRecipePaths>;
}

/** One model of one source level. */
export interface ModelRef {
  level: string;
  model: number;
}

/** The extracted level a from-scratch mountain borrows native rail/gem art from. */
export interface NativeArt {
  level: string;
  /** MaterialID skinning the donor's rail tubes, read off its own rail models — null when it ships none. */
  railMaterial: number | null;
  /** The tier crystals (2 / 3 / 5) and the ModelIDs carrying them; empty when the donor has no gem models. */
  gemTiers: { tier: number; model: number }[];
}

export interface StagedRaceMusic {
  status: 'staged' | 'cleared' | 'legacy';
  /** What `Music/` receives — the transcoded track and its arrangement contract, or nothing at all. */
  files: ExportFile[];
  /** What `Music/` loses first, so an explicit "none" retires the track an earlier export left there. */
  remove: string[];
  /** Whether a track is already staged at the destination — what makes a cleared or preserved line worth
   *  writing. Absent when the destination cannot be looked at, as a download has none to look at. */
  existing?: boolean;
  mode?: RaceMusicArrangement['mode'];
  /** The staged track's size, for the export log. */
  bytes?: number;
}
