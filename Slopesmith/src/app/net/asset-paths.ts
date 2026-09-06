import { parseTexRef, type TexRef } from '../../core/paint/textures';
import { builtinCharacterUrl } from '../../core/characters/builtins';
import { clientAssetUrl } from './client';

const referenceTextureRevisions = new Map<string, Map<string, string>>();
const referenceSkyRevisions = new Map<string, { panorama?: string; ground?: string }>();

const levelKey = (level: string) => level.trim().toLowerCase();
const withRevision = (url: string, revision?: string): string =>
  revision ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(revision)}` : url;

/** Replace one level's known tile revisions with the metadata from its latest catalogue/terrain response. */
export function registerReferenceTextureRevisions(level: string, revisions: Record<string, string>): void {
  referenceTextureRevisions.set(levelKey(level), new Map(Object.entries(revisions)));
}

/** Replace the shared sky revision table after `/api/skybox` is revalidated. */
export function registerReferenceSkyRevisions(
  revisions: Record<string, { panorama?: string; ground?: string }>,
): void {
  referenceSkyRevisions.clear();
  for (const [level, version] of Object.entries(revisions)) referenceSkyRevisions.set(levelKey(level), version);
}

/**
 * The URLs the browser asks for asset bytes on — one per byte route, and nothing else.
 *
 * A stored asset name is its identity: an upload lands beside a name that is taken rather than over it
 * (docs/038), so a ref names bytes that cannot change and a URL built here is a permanent address. That is
 * what lets these be plain string builders — a ref doubles as its own cache key, in the browser's HTTP cache
 * and in the editor's decoded-texture maps alike.
 */

export function textureUrl(level: string, name: string): string {
  const target = `/api/texture?level=${encodeURIComponent(level)}&name=${encodeURIComponent(name)}`;
  // Extracted banks are shared, immutable reference art. Do not partition hundreds of tile-cache entries by
  // tab or authored mountain. Only the Custom bank needs the open mountain in its URL.
  if (level.toLowerCase() === 'custom') return clientAssetUrl(target);
  return withRevision(target, referenceTextureRevisions.get(levelKey(level))?.get(name));
}

export function textureRefUrl(ref: TexRef): string {
  const { level, name } = parseTexRef(ref);
  return textureUrl(level, name);
}

export function customSkyUrl(name: string, part: 'panorama' | 'ground', ring = ''): string {
  const target = `/api/${part === 'panorama' ? 'skypano' : 'skyground'}?sky=${encodeURIComponent(name)}`;
  return clientAssetUrl(part === 'ground' && ring ? `${target}&ring=${encodeURIComponent(ring)}` : target);
}

export function particleTextureUrl(name: string, level: string): string {
  return `/api/particle-texture?name=${encodeURIComponent(name)}&level=${encodeURIComponent(level)}`;
}

export function referenceSkyUrl(level: string, part: 'panorama' | 'ground'): string {
  const target = `/api/${part === 'panorama' ? 'skypano' : 'skyground'}?level=${encodeURIComponent(level)}`;
  return withRevision(target, referenceSkyRevisions.get(levelKey(level))?.[part]);
}

export function customSoundUrl(name: string): string {
  return clientAssetUrl(`/api/custom-sound?name=${encodeURIComponent(name)}`);
}

/** One slot of a level's course / crowd bank, or of a named fixed global environment bank. */
export function effectSoundUrl(level: string, slot: number, bank: string): string {
  return `/api/effect-sound?level=${encodeURIComponent(level)}&slot=${slot}&bank=${encodeURIComponent(bank)}`;
}

/** A shared environment-bank slot for authored mountains, without coupling them to a donor level name. */
export function environmentSoundUrl(bank: string, slot: number, loop = true): string {
  return `/api/environment-sound?bank=${encodeURIComponent(bank)}&slot=${Math.trunc(slot)}`
    + (loop ? '&loop=1' : '');
}

/** One page of a level's shipped sky bank, addressed by its generated ring slot. */
export function skyPageUrl(level: string, index: number, revision?: string): string {
  return withRevision(`/api/skybox/page?level=${encodeURIComponent(level)}&index=${index}`, revision);
}

export function customMusicUrl(name: string): string {
  return clientAssetUrl(`/api/custom-music-file?name=${encodeURIComponent(name)}`);
}

export function characterModelUrl(modelId: string): string {
  // A built-in is part of the client build and is served as a static file; everything else is a name in the
  // server-wide character library.
  return builtinCharacterUrl(modelId) ?? `/api/character-model?name=${encodeURIComponent(modelId)}`;
}
