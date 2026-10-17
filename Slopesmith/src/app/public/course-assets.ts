import type { EditDoc } from '../../core/doc/doc-edit';
import type { PropsPayload } from '../../core/reference/props';

function availableAssets(availableLevels: readonly string[]) {
  const available = new Set(availableLevels.map(level => level.toLowerCase()));
  const hasLevel = (level: string) => level.startsWith('@') || level.toLowerCase() === 'custom'
    || available.has(level.toLowerCase());
  const hasTexture = (ref: string) => hasLevel(ref.split('/')[0]);
  return { hasLevel, hasTexture };
}

/** Keep authored geometry playable even when some of its disc art is absent from this device. */
export function publicMountainDocument(document: EditDoc, availableLevels: readonly string[]): EditDoc {
  const { hasLevel, hasTexture } = availableAssets(availableLevels);
  return {
    ...document,
    quadTex: Object.fromEntries(Object.entries(document.quadTex ?? {}).filter(([, ref]) => hasTexture(ref))),
    models: document.models?.map(model => ({ ...model,
      texture: model.texture && hasTexture(model.texture) ? model.texture : undefined,
      frames: model.frames?.filter(hasTexture),
    })),
    props: document.props?.filter(prop => hasLevel(prop.level)),
    particleVolumes: document.particleVolumes?.filter(volume => !volume.texture || hasTexture(volume.texture)),
    skybox: document.skybox?.source.kind === 'level' && !hasLevel(document.skybox.source.level)
      ? undefined : document.skybox,
  };
}

/** Imported geometry is custom, but its material slots may have been repainted with game textures. */
export function publicPropPayload(payload: PropsPayload, availableLevels: readonly string[]): PropsPayload {
  const { hasTexture } = availableAssets(availableLevels);
  return { ...payload, materials: payload.materials.map(material => ({ ...material,
    tex: material.tex && hasTexture(material.tex) ? material.tex : null,
    frames: material.frames?.filter(hasTexture),
  })) };
}
