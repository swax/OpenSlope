/** Retail disc slots can share riding presence without publishing or serving any map files. */
const DISC_COURSES: Readonly<Record<string, string>> = {
  SSX_SNOW: 'Snowdream (SSX)',
  SSX_ELYSIUM: 'Elysium Alps (SSX)',
  SSX_MESA: 'Mesablanca (SSX)',
  SSX_MERQUERY: 'Merqury City (SSX)',
  SSX_ALOHA: 'Aloha Ice Jam (SSX)',
  SSX_PIPE: 'Pipedream (SSX)',
  SSX_UNTRACK: 'Untracked (SSX)',
  SSX_MEGAPLEX: 'Tokyo Megaplex (SSX)',
  SSX_WARMUP: 'Warmup (SSX)',
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
