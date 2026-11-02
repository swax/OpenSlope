import type { EffectsDocument } from './document';

/** Native browser imports name sprites through SpriteBank; Snowknife folders use Particles/<name>. */
export function referenceParticleTexturePaths(name: string, profile: unknown): string[] {
  if (!/^[a-z0-9_-]+\.png$/i.test(name)) return [];
  let mapped: unknown;
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const riding = profile as Record<string, unknown>;
    if (riding.Schema === 'openslope-riding-effects/v1' && riding.Enabled !== false) {
      const bank = riding.SpriteBank;
      if (bank && typeof bank === 'object' && !Array.isArray(bank))
        mapped = Object.entries(bank).find(([key]) => key.toLowerCase() === name.slice(0, -4).toLowerCase())?.[1];
      if (mapped === undefined)
        mapped =
          name.toLowerCase() === 'spry.png' ? riding.Sheet : /^ex0[6-9]\.png$/i.test(name) ? riding.Puff : undefined;
    }
  }
  if (mapped !== undefined)
    return typeof mapped === 'string' &&
      mapped.split('/').every(part => /^[a-z0-9_.-]+$/i.test(part) && part !== '.' && part !== '..')
      ? [mapped]
      : [];
  return [`Particles/${name}`, name];
}

/** Project-owned native-name sprite overrides; kept in the portable effects extension. */
export function authoredParticleTextures(document: EffectsDocument | null | undefined): Record<string, string> {
  const ext = document?.extensions?.slopesmith;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {};
  const refs = ext.particleTextures;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return {};
  return Object.fromEntries(
    Object.entries(refs).filter(
      ([name, ref]) => /^[a-zA-Z0-9_-]+$/.test(name) && typeof ref === 'string' && /^Custom\/[^/\\]+\.png$/i.test(ref),
    ),
  ) as Record<string, string>;
}
