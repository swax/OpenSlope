export type PublicCourseKind = 'project' | 'reference';
export interface PublicCourse {
  id: string;
  kind: PublicCourseKind;
  name: string;
  retailData: boolean;
  /** Local ISO course slots required by this course's asset references. */
  isoCourses: string[];
  /** Map-library names may differ from the source disc slot. */
  isoAliases?: Record<string, string>;
}
export const referenceRoom = (level: string): string => `@reference:${level.toUpperCase()}`;
export const referenceInRoom = (room: string): string | null =>
  room.startsWith('@reference:') ? room.slice('@reference:'.length) : null;
