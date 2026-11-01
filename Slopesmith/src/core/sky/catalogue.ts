import { findMapChoice, mapSourceId, type MapSource } from '../reference/map-source';
import type { SkyRing } from './ring';

export interface SkyCatalogue {
  levels?: string[];
  nativeLevels?: string[];
  skies?: string[];
  rings?: Record<string, SkyRing>;
  versions?: Record<string, { panorama?: string; ground?: string }>;
}

/** Keep two copies of a course independent, including its measured ring and cache revisions. */
export function qualifySkyCatalogue(catalogue: SkyCatalogue, source: MapSource): SkyCatalogue {
  const qualify = <T>(entries: Record<string, T> = {}) =>
    Object.fromEntries(Object.entries(entries).map(([name, value]) => [mapSourceId(source, name), value]));
  return {
    ...catalogue,
    levels: (catalogue.levels ?? []).map(name => mapSourceId(source, name)),
    nativeLevels: (catalogue.nativeLevels ?? []).map(name => mapSourceId(source, name)),
    rings: qualify(catalogue.rings),
    versions: qualify(catalogue.versions),
  };
}

/** Explicit sources never fall through to another copy; older unqualified skies remain local-first. */
export const findSkyLevel = (levels: readonly string[], id: string): string | undefined =>
  findMapChoice(
    levels.map(name => ({ name })),
    id,
  )?.name;
