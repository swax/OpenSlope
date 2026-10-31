import { isDiscCourse } from './disc-courses';

export const MAP_TYPES = ['run', 'hub', 'connector', 'run-chain', 'full-mountain'] as const;
export type MapType = (typeof MAP_TYPES)[number];
export interface CourseLayout {
  MapType: MapType;
  WorldId?: string;
  ParentMap?: string;
  SourceSections?: string[];
  Connects?: string[];
}
const layouts = new Map<string, CourseLayout>();
export function normalizeCourseLayout(value: unknown): CourseLayout | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (!MAP_TYPES.includes(row.MapType as MapType)) return;
  const text = (v: unknown) =>
    typeof v === 'string' && v.length <= 100 && /^[-a-zA-Z0-9_:.]+$/.test(v) ? v : undefined;
  const list = (v: unknown) =>
    Array.isArray(v) && v.length <= 255 && v.every(item => text(item)) ? (v as string[]) : undefined;
  return {
    MapType: row.MapType as MapType,
    ...(text(row.WorldId) ? { WorldId: text(row.WorldId) } : {}),
    ...(text(row.ParentMap) ? { ParentMap: text(row.ParentMap) } : {}),
    ...(list(row.SourceSections) ? { SourceSections: list(row.SourceSections) } : {}),
    ...(list(row.Connects) ? { Connects: list(row.Connects) } : {}),
  };
}
export function registerCourseLayouts(rows: Readonly<Record<string, unknown>> = {}): void {
  for (const [id, raw] of Object.entries(rows)) {
    const layout = normalizeCourseLayout(raw);
    if (layout && isDiscCourse(id)) layouts.set(id.toUpperCase(), layout);
  }
}
/** Older scans have no metadata; infer structural IDs, never retail display names. */
export function courseLayout(id: string): CourseLayout {
  const key = id.toUpperCase();
  const known = layouts.get(key);
  if (known) return known;
  if (!key.startsWith('SSX3_')) return { MapType: 'run' };
  const section = key.slice(5);
  const MapType: MapType =
    section === 'ALL'
      ? 'full-mountain'
      : /^PEAK[1-3]$/.test(section)
        ? 'run-chain'
        : section.includes('_')
          ? 'connector'
          : /^[A-E]$/.test(section)
            ? 'hub'
            : 'run';
  return {
    MapType,
    WorldId: 'ssx-3:bam',
    ...(MapType === 'full-mountain'
      ? {}
      : {
          ParentMap:
            MapType === 'run-chain' ? 'SSX3_ALL' : `SSX3_PEAK${section[0] <= 'B' ? 1 : section[0] <= 'D' ? 2 : 3}`,
        }),
  };
}
export function importedCourseLayouts(ids: readonly string[]): Record<string, CourseLayout> {
  return Object.fromEntries(ids.map(id => [id, courseLayout(id)]));
}
export function isoCourseVisible(id: string, allTypes: boolean, required: readonly string[] = []): boolean {
  return (
    !id.toUpperCase().startsWith('SSX3_') || allTypes || required.includes(id) || courseLayout(id).MapType === 'run'
  );
}
