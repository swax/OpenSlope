import type { EditDoc } from '../doc/doc-edit';
import { parseTexRef } from '../paint/textures';
import { behaviourRecords } from '../props/defaults';
import { classifyExportProvenance } from '../export/manifest';
import { parseAssetVersion } from '../reference/asset-version';
import { canonicalDiscCourse } from '../reference/disc-courses';
import { splitMapSource } from '../reference/map-source';
import type { ProjectBundle } from './transfer';

/** Asset levels are explicit refs; internal/generated and mountain-local banks never need a disc. */
function projectAssetMaps(doc: EditDoc, assetTextures: readonly string[] = []) {
  const levels = new Set<string>();
  const references = new Set<string>();
  const level = (value: string | undefined) => {
    if (!value || value.startsWith('@') || value.toLowerCase() === 'custom') return;
    const version = parseAssetVersion(value);
    const name = (version?.map ?? splitMapSource(value).name).toUpperCase();
    levels.add(name);
    if (version?.game === 'slopesmith') references.add(name);
  };
  const texture = (value: string | undefined | null) => {
    if (value) level(parseTexRef(value).level);
  };
  for (const ref of Object.values(doc.quadTex ?? {})) texture(ref);
  for (const ref of assetTextures) texture(ref);
  for (const model of doc.models ?? []) {
    texture(model.texture);
    for (const frame of model.frames ?? []) texture(frame);
  }
  for (const prop of doc.props ?? []) {
    level(prop.level);
    for (const record of behaviourRecords(prop)) level(record.nativeCollision?.physicsSource?.level);
  }
  for (const volume of doc.particleVolumes ?? []) texture(volume.texture);
  if (doc.skybox?.source.kind === 'level') level(doc.skybox.source.level);
  const textures = Object.fromEntries(Object.entries(doc.quadTex ?? {}).map(([id, ref]) => [id, parseTexRef(ref)]));
  // A custom sky's export ring is not needed to draw its uploaded panorama in play.
  const { reasons } = classifyExportProvenance(doc, textures);
  const needsDonor = reasons.some(reason => reason.startsWith('retail-') && reason !== 'retail-sky-ring');
  if (needsDonor && !levels.size) levels.add('GARI');
  return { levels, references };
}

export function projectIsoCourses(doc: EditDoc, assetTextures: readonly string[] = []): string[] {
  return [...projectAssetMaps(doc, assetTextures).levels].sort();
}

export function projectAssetRequirements(
  document: EditDoc,
  textures: readonly string[] = [],
  sourceAliases: Readonly<Record<string, string>> = {},
): { isoCourses: string[]; referenceMaps: string[] } {
  const aliases = new Map(Object.entries(sourceAliases).map(([name, slot]) => [name.toUpperCase(), slot]));
  const { levels, references } = projectAssetMaps(document, textures);
  const isoCourses = [
    ...new Set(
      [...levels]
        .filter(level => !references.has(level))
        .map(level => canonicalDiscCourse((aliases.get(level) ?? level).toUpperCase())),
    ),
  ].sort();
  return { isoCourses, referenceMaps: [...references].sort() };
}

/** Old downloaded bundles need no migration: recover dependencies from their saved refs and prop materials. */
export function bundleAssetRequirements(bundle: ProjectBundle): { isoCourses: string[]; referenceMaps: string[] } {
  const textures: string[] = [];
  for (const asset of bundle.assets) {
    const blob = asset.kind === 'prop' && bundle.blobs?.[asset.hash];
    if (!blob) continue;
    try {
      const record = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(blob), c => c.charCodeAt(0)))) as {
        materials?: { tex?: string; frames?: string[] }[];
      };
      for (const material of record.materials ?? []) {
        if (typeof material.tex === 'string') textures.push(material.tex);
        for (const frame of material.frames ?? []) if (typeof frame === 'string') textures.push(frame);
      }
    } catch {
      // A missing/corrupt custom prop must not hide the document's remaining game dependencies.
    }
  }
  return projectAssetRequirements(bundle.document, textures, bundle.isoAliases);
}

export function bundleIsoCourses(bundle: ProjectBundle): string[] {
  return bundleAssetRequirements(bundle).isoCourses;
}
