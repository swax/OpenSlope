import { discCourseName, normalizeMapDisplayName } from './disc-courses';
import { splitMapSource, type MapSource } from './map-source';
import { parseAssetVersion } from './asset-version';
export { normalizeMapDisplayName } from './disc-courses';

/** Stable source identities shared by map catalogues and their Game → Map pickers. */
const GAME_LABELS: Readonly<Record<string, string>> = {
  slopesmith: 'Custom / Authored',
  ssx: 'SSX',
  'ssx-tricky': 'SSX Tricky',
  'ssx-3': 'SSX 3',
  'ssx-on-tour': 'SSX On Tour',
  '1080-avalanche': '1080° Avalanche',
  'jonny-moseley-mad-trix': 'Jonny Moseley Mad Trix',
  unknown: 'Unknown',
};

const TRICKY_COURSES = new Set([
  'ALASKA',
  'ALOHA',
  'ELYSIUM',
  'GARI',
  'MEGAPLE',
  'MERQUER',
  'MESA',
  'PIPE',
  'SMOKEMTN',
  'SNOW',
  'TRICK',
  'UNTRACK',
]);

export function normalizeMapGame(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function mapGame(source: { name: string; game?: string; course?: string; origin?: string }): string {
  const version = parseAssetVersion(source.name);
  if (version) return version.game;
  if (source.origin === 'slopesmith' || ['Custom', '@models', '@import'].includes(source.name)) return 'slopesmith';
  const explicit = normalizeMapGame(source.game);
  if (explicit) return explicit;
  // Legacy folders retain known course identities. An arbitrary folder name never implies Tricky.
  for (const value of [source.course, source.name]) {
    const name = splitMapSource(value ?? '').name.toUpperCase();
    if (name.startsWith('SSXOT_')) return 'ssx-on-tour';
    if (name.startsWith('SSX3_')) return 'ssx-3';
    if (name.startsWith('SSX_')) return 'ssx';
    if (name.startsWith('TRICKY_')) return 'ssx-tricky';
    if (name.startsWith('AVALANCHE_')) return '1080-avalanche';
    if (name.startsWith('MADTRIX_')) return 'jonny-moseley-mad-trix';
    if (TRICKY_COURSES.has(name)) return 'ssx-tricky';
  }
  return 'unknown';
}

export const mapGameLabel = (game: string): string => (Object.hasOwn(GAME_LABELS, game) ? GAME_LABELS[game] : game);

/** Prefer source metadata, retaining legacy labels and stable folder IDs. */
export function mapDisplayName(source: MapSourceChoice): string {
  const version = parseAssetVersion(source.name);
  if (version) return mapDisplayName({ ...source, name: version.map, game: version.game });
  const game = mapGame(source);
  if (game === 'slopesmith') return splitMapSource(source.name).name;
  const imported = normalizeMapDisplayName(source.displayName);
  if (imported) return imported;
  for (const course of [source.course, source.name]) {
    if (!course) continue;
    const name = splitMapSource(course).name;
    const title = discCourseName(name);
    if (title === name) continue;
    const prefix = `${mapGameLabel(game)} · `;
    return title.startsWith(prefix) ? title.slice(prefix.length) : title;
  }
  return splitMapSource(source.name).name;
}

export interface MapSourceChoice {
  name: string;
  source?: MapSource;
  displayName?: string;
  game?: string;
  origin?: string;
  course?: string;
  label?: string;
}
