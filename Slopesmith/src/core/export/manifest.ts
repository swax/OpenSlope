import type { EditDoc } from '../doc/doc-edit';
import { AUTHORED_MODEL_LEVEL } from '../doc/models';
import { IMPORTED_PROP_LEVEL } from '../props/imported';

export const SLOPESMITH_EXPORT_MANIFEST = 'Slopesmith.json';
export const SLOPESMITH_EXPORT_SCHEMA = 1;

export type PublicDistributionStatus =
  | 'allowed'
  | 'rights-review-required'
  | 'blocked-retail-derived';

/**
 * A conservative, machine-readable statement about the bytes an export contains. It is a routing guard,
 * not a legal conclusion: `allowed` means the exporter found only OpenSlope-generated terrain and authored
 * document data; user-supplied files still need their owner to confirm the rights they rely on, and any
 * borrowed retail art blocks the public-target staging path altogether.
 */
export interface SlopesmithContentProvenance {
  source: 'slopesmith-authored';
  publicDistribution: PublicDistributionStatus;
  retailDerived: boolean;
  userSupplied: boolean;
  reasons: string[];
}

export interface SlopesmithTextureSource {
  level: string;
  name: string;
  /** File name beneath this export's Textures/ when a self-contained copy was staged. */
  staged?: string;
}

/** Portable provenance for a built map folder: `Patches.json` names each page by a flat file name, so this
 *  sidecar retains which extracted map supplied it — for `repack`, which decides the page's disc treatment
 *  from it, and for reopening the folder as a reference (docs/036). It carries the patch identity the same
 *  file cannot hold either. */
export interface SlopesmithExportManifest {
  schema: 1;
  kind: 'slopesmith-export';
  level: string;
  documentVersion: number;
  /** Present on exports produced after the public-distribution guard was introduced. Missing means unknown. */
  provenance?: SlopesmithContentProvenance;
  /** Passes from the start gate to the finish this map is raced over. Written only above the single-pass
   *  default, and the only place the number can travel: a lap count is a property of the disc SLOT in retail
   *  ([Trailmap: 390-lap-counter]) and an authored map has no slot until it is packed onto one, so no native
   *  file has a field for it. snowknife's bundle reads it here in preference to its own retail table. */
  laps?: number;
  /** Seconds on the showoff clock. Written whenever the map has been given one, and here for the same reason
   *  laps are: retail seeds a trick run's countdown from a per-course record in its executable
   *  ([Trailmap: 390-showoff-clock]), so no native file has a field for it either. snowknife's bundle reads it
   *  here in preference to its own retail table; a map that never set one inherits the packed slot's. */
  showoffSeconds?: number;
  /** The stable quad id behind each `Patches.json` record, in that file's own order (docs/039). The engine
   *  consumes an ordered patch array with no id column, so the id→ordinal table lives here: it is what lets a
   *  re-export made after topology surgery be rejoined to its predecessor and diffed patch for patch, rather
   *  than read as every patch below the edit having changed. */
  patches?: string[];
  textures: Record<string, SlopesmithTextureSource>;
  props?: {
    format: 'ssx-native-map-v1';
    instances: 'Instances.json';
    models: 'Models.json';
    meshes: 'Meshes';
    collision: 'Collision';
    materials: 'Materials.json';
    preview?: 'Props.obj';
  };
  canonical?: {
    schema: 1;
    format: 'ssx-native-map-v1';
    instances: number;
    models: number;
    meshes: number;
    collisionMeshes: number;
  };
}

/** Classify the actual content channels the folder exports, keeping the decision deterministic and auditable. */
export function classifyExportProvenance(
  doc: EditDoc,
  textures: Readonly<Record<string, SlopesmithTextureSource>>,
): SlopesmithContentProvenance {
  const retail = new Set<string>();
  const supplied = new Set<string>();
  const internalLevel = (level: string) => level.startsWith('@');

  for (const source of Object.values(textures)) {
    if (source.level.toLowerCase() === 'custom') supplied.add('user-texture');
    else if (!internalLevel(source.level)) retail.add('retail-texture');
  }

  for (const prop of doc.props ?? []) {
    if (prop.level === IMPORTED_PROP_LEVEL) supplied.add('user-imported-model');
    else if (prop.level !== AUTHORED_MODEL_LEVEL && !internalLevel(prop.level)) retail.add('retail-prop-art');
    if (prop.nativeCollision?.physicsSource && !internalLevel(prop.nativeCollision.physicsSource.level))
      retail.add('retail-collision-shape');
    if (prop.collisionSoundFile || prop.ambientSoundFile) supplied.add('user-audio');
    if (prop.collisionSound !== undefined || prop.ambientSound !== undefined) retail.add('retail-audio');
  }

  for (const model of doc.models ?? []) {
    for (const ref of [model.texture, ...(model.frames ?? [])]) {
      if (!ref) continue;
      const level = ref.split('/', 1)[0];
      if (level.toLowerCase() === 'custom') supplied.add('user-texture');
      else if (!internalLevel(level)) retail.add('retail-texture');
    }
  }

  // A document imported from a native SSF carries a source fingerprint. Newly authored effect graphs do not.
  // The graph can still be used locally, but public staging requires recreating it from authored behavior.
  if (doc.effects?.source) retail.add('retail-effect-graph');

  // These features currently borrow visual bytes from a user-provided disc even when their placement,
  // geometry path, or panorama is authored in Slopesmith.
  if (doc.rails?.length) retail.add('retail-rail-art');
  if (doc.gems?.length) retail.add('retail-gem-art');
  if (doc.particleVolumes?.length) retail.add('retail-particle-art');
  if (doc.skybox) {
    retail.add(doc.skybox.source.kind === 'level' ? 'retail-sky' : 'retail-sky-ring');
    if (doc.skybox.source.kind === 'custom') supplied.add('user-sky');
  }
  if (typeof doc.raceMusic === 'string') supplied.add('user-music');

  const reasons = [...retail, ...supplied].sort();
  const retailDerived = retail.size > 0;
  const userSupplied = supplied.size > 0;
  return {
    source: 'slopesmith-authored',
    publicDistribution: retailDerived ? 'blocked-retail-derived'
      : userSupplied ? 'rights-review-required' : 'allowed',
    retailDerived,
    userSupplied,
    reasons,
  };
}

/** Whether a value read back off disk is a manifest this build understands. */
export function isSlopesmithExportManifest(value: unknown): value is SlopesmithExportManifest {
  const m = value as Partial<SlopesmithExportManifest> | null;
  const p = m?.provenance;
  const reasons = p?.reasons;
  const validProvenance = p === undefined || (p.source === 'slopesmith-authored'
    && typeof p.retailDerived === 'boolean' && typeof p.userSupplied === 'boolean'
    && Array.isArray(reasons) && reasons.every(reason => typeof reason === 'string' && reason.length > 0)
    && (p.publicDistribution === 'allowed'
      ? !p.retailDerived && !p.userSupplied && reasons.length === 0
      : p.publicDistribution === 'rights-review-required'
        ? !p.retailDerived && p.userSupplied && reasons.length > 0
          && reasons.every(reason => reason.startsWith('user-'))
        : p.publicDistribution === 'blocked-retail-derived'
          && p.retailDerived && reasons.some(reason => reason.startsWith('retail-'))));
  return !!m && m.schema === SLOPESMITH_EXPORT_SCHEMA && m.kind === 'slopesmith-export'
    && typeof m.level === 'string' && !!m.textures && typeof m.textures === 'object'
    && validProvenance;
}
