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

// The streamed mountain uses hubs, events and their named connectors. Keep
// this inventory bounded so arbitrary SSX3_ names cannot become public rooms.
const SSX3_SECTIONS = new Set([
  'A',
  'A_ABA1',
  'A_ARA1',
  'A_ASS1',
  'ABA1',
  'ABC1',
  'ABC1_A',
  'ARA1',
  'ARA1_B',
  'ASS1',
  'B',
  'B_BHP1',
  'B_BRA2',
  'BHP1',
  'BRA2',
  'C',
  'C_CBA2',
  'C_CHP2',
  'C_CRA3',
  'CBA2',
  'CHP2',
  'CRA3',
  'CRA3_D',
  'D',
  'D_DRA4',
  'D_DSS2',
  'DBC2',
  'DBC2_D',
  'DRA4',
  'DRA4_A',
  'DSS2',
  'E',
  'E_EBA3',
  'E_EHP3',
  'E_ERA5',
  'E_ESS3',
  'EBA3',
  'EBC3',
  'EBC3_E',
  'EHP3',
  'ERA5',
  'ERA5_C',
  'ESS3',
  'PEAK1',
  'PEAK2',
  'PEAK3',
]);
export const isDiscCourse = (course: string): boolean => {
  const slot = course.toUpperCase();
  return Object.hasOwn(DISC_COURSES, slot) || (slot.startsWith('SSX3_') && SSX3_SECTIONS.has(slot.slice(5)));
};
export const discCourseName = (course: string): string => {
  const slot = course.toUpperCase();
  if (DISC_COURSES[slot]) return DISC_COURSES[slot];
  if (!slot.startsWith('SSX3_') || !SSX3_SECTIONS.has(slot.slice(5))) return course;
  const section = slot.slice(5);
  return section.startsWith('PEAK') ? `Peak ${section.slice(4)} (SSX 3)` : `${section.replaceAll('_', ' → ')} (SSX 3)`;
};
