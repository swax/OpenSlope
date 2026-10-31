export function normalizeMapDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const name = value.trim();
  return name && name.length <= 200 && [...name].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    ? name
    : undefined;
}

const importedNames = new Map<string, string>();
export function registerDiscCourseNames(names: Readonly<Record<string, unknown>> = {}): void {
  for (const [id, value] of Object.entries(names)) {
    const normalized = normalizeMapDisplayName(value);
    const title = /^AVALANCHE_/i.test(id) ? normalized?.replace(/^1080(?:°)?\s+Avalanche\s*[·-]\s*/i, '') : normalized;
    if (title && isDiscCourse(id)) importedNames.set(id.toUpperCase(), title);
  }
}
export function importedDiscCourseNames(courses: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    courses.flatMap(id => {
      const title = importedNames.get(id.toUpperCase());
      return title ? [[id, title]] : [];
    }),
  );
}

/** Legacy labels for imports made before titles were extracted from disc metadata. */
const DISC_COURSES: Readonly<Record<string, string>> = {
  SSXGBA_GARIBALDI: 'Garibaldi',
  SSXGBA_SNOWDREAM: 'Snowdream',
  SSXGBA_ELYSIUM_ALPS: 'Elysium Alps',
  SSXGBA_MESABLANCA: 'Mesablanca',
  SSXGBA_MERQURY_CITY: 'Merqury City',
  SSXGBA_TOKYO_MEGAPLEX: 'Tokyo Megaplex',
  SSXGBA_ALOHA_ICE_JAM: 'Aloha Ice Jam',
  SSXGBA_ALASKA: 'Alaska',
  MADTRIX_AN_ANTARTICA: 'Antarctica (Mad Trix)',
  MADTRIX_DC_WASHINGTON: 'Washington DC (Mad Trix)',
  MADTRIX_LV_LAS_VEGAS: 'Las Vegas (Mad Trix)',
  MADTRIX_MK_MT_KILI: 'Mount Kilimanjaro (Mad Trix)',
  MADTRIX_MP_MACHU_PIHU: 'Machu Picchu (Mad Trix)',
  MADTRIX_NP_NEPAL: 'Nepal (Mad Trix)',
  MADTRIX_RV_ROME: 'Rome (Mad Trix)',
  MADTRIX_SF_SAN_FRAN: 'San Francisco (Mad Trix)',
  MADTRIX_TH_TAHOE: 'Tahoe (Mad Trix)',
  MADTRIX_TR_TRAINING: 'Training (Mad Trix)',
  MADTRIX_VA_VALDEZ_ALASKA: 'Valdez Alaska (Mad Trix)',
  // USA menu category/title table, indexed by source family/layout. [Trailmap: 600-course-names]
  AVALANCHE_CRS00_00: 'Half-Pipe',
  AVALANCHE_CRS00_03: "Sid's Night Midi",
  AVALANCHE_CRS01_00: 'Tenderfoot Pass',
  AVALANCHE_CRS01_01: 'Powder Threat',
  AVALANCHE_CRS01_02: 'Revolution Cliff',
  AVALANCHE_CRS01_03: 'Evolution Riff',
  AVALANCHE_CRS02_00: 'Spinal Damage',
  AVALANCHE_CRS02_01: 'Ballistic',
  AVALANCHE_CRS02_02: 'No Way Out',
  AVALANCHE_CRS02_03: 'Outway Knoll',
  AVALANCHE_CRS03_00: 'Frosty Shadows',
  AVALANCHE_CRS03_01: 'Tree Top Trauma',
  AVALANCHE_CRS03_02: 'Midnight City',
  AVALANCHE_CRS03_03: 'Top Tree Mama',
  AVALANCHE_CRS04_00: 'Ski School',
  AVALANCHE_CRS04_01: "Grits n' Gravy",
  AVALANCHE_CRS04_02: 'Rotted Ridge',
  AVALANCHE_CRS04_03: "Dazzlin' Teaser",
  AVALANCHE_CRS05_00: 'Air-Make',
  AVALANCHE_CRS05_01: 'Trestle Trouble',
  AVALANCHE_CRS05_02: 'Diesel Disaster',
  AVALANCHE_CRS05_03: 'Treble Tussle',
  AVALANCHE_CRS06_00: 'Terrain Park',
  AVALANCHE_CRS06_02: 'Sick With It',
  AVALANCHE_CRS06_03: "Wit's Thicket",
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
const ON_TOUR_DAY = new Set([
  'ER1',
  'ER2',
  'ER3',
  'ER4',
  'NP2',
  'NP3',
  'NPP',
  'VB1',
  'VB2',
  'VB4',
  'VH1',
  'WR1',
  'WR2',
  'WR3',
  'WR4',
]);
const ON_TOUR_NIGHT = new Set(['ER3', 'ER4', 'NP3', 'VB1', 'VB4', 'VH1', 'WR1', 'WR2', 'WR3', 'WR4']);
const trickySlot = (slot: string): string | undefined => {
  if (!slot.startsWith('TRICKY_')) return;
  const bare = slot.slice(7);
  return !bare.includes('_') && Object.hasOwn(DISC_COURSES, bare) ? bare : undefined;
};
export function canonicalDiscCourse(course: string): string {
  const slot = course.toUpperCase();
  return /^[A-Z0-9_-]+$/.test(slot) && !/^(SSXGBA_|TRICKY_|SSX_|SSX3_|SSXOT_|AVALANCHE_|MADTRIX_)/.test(slot)
    ? `TRICKY_${slot}`
    : course;
}
/** A saved reference may still use the bare Tricky slot returned by older scanners. */
export function discContainsCourse(courses: readonly string[], course: string): boolean {
  const slot = course.toUpperCase();
  const canonical = canonicalDiscCourse(slot);
  return courses.some(id => {
    const candidate = id.toUpperCase();
    return candidate === slot || canonicalDiscCourse(candidate) === canonical;
  });
}
const onTourSlot = (slot: string): RegExpMatchArray | null => {
  const match = slot.match(/^SSXOT_([A-Z0-9]{3})_(DAY|NIGHT)$/);
  return match && (match[2] === 'DAY' ? ON_TOUR_DAY : ON_TOUR_NIGHT).has(match[1]) ? match : null;
};
export const isDiscCourse = (course: string): boolean => {
  const slot = course.toUpperCase();
  return (
    Object.hasOwn(DISC_COURSES, slot) ||
    !!trickySlot(slot) ||
    (slot.startsWith('SSX3_') && SSX3_SECTIONS.has(slot.slice(5))) ||
    !!onTourSlot(slot)
  );
};
export const discCourseName = (course: string): string => {
  const slot = course.toUpperCase();
  const imported = importedNames.get(slot);
  if (imported) return imported;
  if (DISC_COURSES[slot]) return DISC_COURSES[slot];
  const tricky = trickySlot(slot);
  if (tricky) return DISC_COURSES[tricky];
  const tour = onTourSlot(slot);
  if (tour) return `${tour[1]} · ${tour[2] === 'DAY' ? 'Day' : 'Night'} (SSX On Tour)`;
  if (!slot.startsWith('SSX3_') || !SSX3_SECTIONS.has(slot.slice(5))) return course;
  const section = slot.slice(5);
  return section.startsWith('PEAK') ? `Peak ${section.slice(4)} (SSX 3)` : `${section.replaceAll('_', ' → ')} (SSX 3)`;
};
