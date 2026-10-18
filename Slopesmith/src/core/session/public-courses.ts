export type PublicCourseKind = 'project' | 'reference';
export interface PublicCourse {
  id: string;
  kind: PublicCourseKind;
  name: string;
  /** Which catalogue entry was opened; ISO and server references can share a course ID. */
  source?: 'iso' | 'server';
  retailData: boolean;
  /** Local ISO slots supplying game assets. Optional for authored mountains; required for retail terrain. */
  isoCourses: string[];
  /** Map-library names may differ from the source disc slot. */
  isoAliases?: Record<string, string>;
}
export const referenceRoom = (level: string): string => `@reference:${level.toUpperCase()}`;
export const referenceInRoom = (room: string): string | null =>
  room.startsWith('@reference:') ? room.slice('@reference:'.length) : null;
