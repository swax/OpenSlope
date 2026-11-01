import type { EditDoc } from '../../core/doc/doc-edit';
import type { PropsPayload } from '../../core/reference/props';
import { parseAssetVersion } from '../../core/reference/asset-version';
import { findMapChoice } from '../../core/reference/map-source';

function availableAssets(availableLevels: readonly string[]) {
  const available = availableLevels.map(name => ({ name }));
  const hasLevel = (level: string) => {
    return (
      !!parseAssetVersion(level) ||
      level.startsWith('@') ||
      level.toLowerCase() === 'custom' ||
      !!findMapChoice(available, level)
    );
  };
  const hasTexture = (ref: string) => hasLevel(ref.split('/')[0]);
  return { hasLevel, hasTexture };
}

/** Keep authored geometry playable even when some of its disc art is absent from this device. */
export function publicMountainDocument(document: EditDoc, availableLevels: readonly string[], placeholders = false): EditDoc {
  const { hasLevel, hasTexture } = availableAssets(availableLevels);
  return {
    ...document,
    quadTex: Object.fromEntries(Object.entries(document.quadTex ?? {}).filter(([, ref]) => placeholders || hasTexture(ref))),
    models: document.models?.map(model => ({
      ...model,
      texture: model.texture && (placeholders || hasTexture(model.texture)) ? model.texture : undefined,
      frames: model.frames?.filter(ref => placeholders || hasTexture(ref)),
    })),
    props: document.props?.filter(prop => placeholders || hasLevel(prop.level)),
    particleVolumes: document.particleVolumes?.filter(volume => !volume.texture || hasTexture(volume.texture)),
    skybox:
      document.skybox?.source.kind === 'level' && !hasLevel(document.skybox.source.level) ? undefined : document.skybox,
  };
}

/** Imported geometry is custom, but its material slots may have been repainted with game textures. */
export function publicPropPayload(payload: PropsPayload, availableLevels: readonly string[], placeholders = false): PropsPayload {
  const { hasTexture } = availableAssets(availableLevels);
  return {
    ...payload,
    materials: payload.materials.map(material => ({
      ...material,
      tex: material.tex && (placeholders || hasTexture(material.tex)) ? material.tex : null,
      frames: material.frames?.filter(ref => placeholders || hasTexture(ref)),
    })),
  };
}
