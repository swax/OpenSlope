/** Retail disc slots can share riding presence without publishing or serving any map files. */
const DISC_COURSES: Readonly<Record<string, string>> = {
  GARI: 'Garibaldi',
  SNOW: 'Snowdream',
  ELYSIUM: 'Elysium Alps',
  MESA: 'Mesablanca',
  MERQUER: 'Merqury City',
  ALOHA: 'Aloha Ice Jam',
  PIPE: 'Pipedream',
  UNTRACK: 'Untracked',
  MEGAPLE: 'Tokyo Megaplex',
  BIGAIR: 'Big Air',
  TRICK: 'Trick Tutorial',
  ALASKA: 'Alaska',
};

export const isDiscCourse = (course: string): boolean => Object.hasOwn(DISC_COURSES, course.toUpperCase());
export const discCourseName = (course: string): string => DISC_COURSES[course.toUpperCase()] ?? course;
