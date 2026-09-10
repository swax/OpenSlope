import type { EffectsDocument } from './document';

/** Project-owned native-name sprite overrides; kept in the portable effects extension. */
export function authoredParticleTextures(document: EffectsDocument | null | undefined): Record<string, string> {
  const ext = document?.extensions?.slopesmith;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {};
  const refs = ext.particleTextures;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return {};
  return Object.fromEntries(Object.entries(refs).filter(([name, ref]) =>
    /^[a-zA-Z0-9_-]+$/.test(name) && typeof ref === 'string' && /^Custom\/[^/\\]+\.png$/i.test(ref))) as Record<string, string>;
}
