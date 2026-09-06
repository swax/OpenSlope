import type { SlopesmithContentProvenance } from './manifest';

/**
 * `Origin.json` — where a map folder came from, and whether it carries retail bytes.
 *
 * Two facts, written by both producers of a `Maps/<NAME>/` folder: `snowknife import` states that a folder is
 * an extract of a course off somebody's disc, and a Slopesmith export states that it is authored and whether
 * its own classification found borrowed art in it. They are separate questions on purpose — an authored
 * mountain that places a retail tree is `slopesmith` + retail data, and that combination is the whole reason
 * one boolean would not do.
 *
 * It is a map-folder contract in the same sense `World.json` is (docs/049): PascalCase keys, the game's own
 * naming, written beside the geometry rather than inferred by whoever reads it. The reader's fallback for a
 * folder written before this file existed lives in `server/routes/levels.ts`, and is deliberately
 * conservative — an unmarked folder reads as retail, because the only way an unmarked folder gets here is a
 * `snowknife import` from an era before this contract.
 *
 * What consumes it: the reference picker's listing (`/api/levels`), which carries each folder's answer so the
 * Scene toolbox can say what the loaded reference IS — an extract of a retail course, or an authored export,
 * and whether it borrows retail art (docs/036). Nothing about rendering or export reads it.
 */

export const MAP_ORIGIN_FILE = 'Origin.json';
export const MAP_ORIGIN_SCHEMA = 'openslope-origin/v1';

/** Who wrote the folder. Not the same question as what is inside it. */
export type MapOriginKind = 'retail' | 'slopesmith';

/** The single reason a retail extract carries. An extract IS the disc's bytes, so there is nothing to
 *  enumerate — the `retail-*` reason list is for authored folders, where it says which channels borrowed. */
export const RETAIL_EXTRACT_REASON = 'retail-extract';

/** A legacy Slopesmith export that predates the provenance guard: authored, but nothing recorded what it
 *  borrowed, so it is treated as though it borrowed something. */
export const UNCLASSIFIED_EXPORT_REASON = 'retail-unclassified-legacy-export';

/**
 * A folder nothing in it identifies: no origin record, no export manifest, and none of the files a BIG unpack
 * leaves behind. It predates every producer that says what it is.
 *
 * It reads as retail, which is the same answer an unmarked folder already gets — but written down, the record
 * says *why* rather than claiming to be an extract. Nothing here can tell an early authored export from an
 * extraction made by hand, and inventing a `Course` for one would put a guess where a provenance field goes.
 * Re-exporting the mountain is what settles it.
 */
export const UNIDENTIFIED_FOLDER_REASON = 'retail-unidentified-folder';

export interface MapOriginRecord {
  Schema: typeof MAP_ORIGIN_SCHEMA;
  Origin: MapOriginKind;
  /** The course slot an extract was read from (`GARI`). Absent on an authored mountain. */
  Course?: string;
  /** Whether the folder contains or references bytes that came off a retail disc. */
  RetailData: boolean;
  /** Why, in the same vocabulary `classifyExportProvenance` uses. Empty exactly when `RetailData` is false. */
  Reasons: string[];
}

/** The record `snowknife import` writes. Stated here as well as in C# so the two producers cannot drift:
 *  `test/map-origin.test.ts` checks this against the shipped JSON Schema the importer validates against. */
export const retailExtractOrigin = (course: string): MapOriginRecord => ({
  Schema: MAP_ORIGIN_SCHEMA,
  Origin: 'retail',
  Course: course.toUpperCase(),
  RetailData: true,
  Reasons: [RETAIL_EXTRACT_REASON],
});

/**
 * The record an export writes, from the classification it already performed.
 *
 * Only the `retail-` half of `reasons` travels: a `user-` reason is about rights in somebody's own uploads,
 * which is a different question with a different answer (`--confirm-rights`), and putting it here would make
 * a mountain full of the author's own photographs look like it needs a copy of the game.
 */
export function authoredOrigin(provenance: SlopesmithContentProvenance): MapOriginRecord {
  const reasons = provenance.reasons.filter(reason => reason.startsWith('retail-'));
  return {
    Schema: MAP_ORIGIN_SCHEMA,
    Origin: 'slopesmith',
    RetailData: provenance.retailDerived,
    Reasons: provenance.retailDerived ? (reasons.length ? reasons : [UNCLASSIFIED_EXPORT_REASON]) : [],
  };
}

/** What an unmarked folder is taken to be. Retail, because that is what an unmarked folder in a Maps library
 *  overwhelmingly is, and because the failure that matters is describing retail bytes as authored — not
 *  describing an authored mountain as an extract until its owner re-exports it. */
export const UNMARKED_ORIGIN: MapOriginRecord = {
  Schema: MAP_ORIGIN_SCHEMA,
  Origin: 'retail',
  RetailData: true,
  Reasons: [RETAIL_EXTRACT_REASON],
};

/**
 * Read back a record off disk, or null when it is not one this build understands.
 *
 * Null is not "no retail data" — every caller turns it into the conservative `UNMARKED_ORIGIN` or into its
 * own inference. Keeping the parse and the fallback separate is what lets a corrupt file and an absent one
 * take the same safe path without either being mistaken for a clean `RetailData: false`.
 */
export function normalizeMapOrigin(value: unknown): MapOriginRecord | null {
  const raw = value as Partial<MapOriginRecord> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.Schema !== MAP_ORIGIN_SCHEMA) return null;
  if (raw.Origin !== 'retail' && raw.Origin !== 'slopesmith') return null;
  if (typeof raw.RetailData !== 'boolean') return null;
  const reasons = Array.isArray(raw.Reasons)
    ? raw.Reasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
    : [];
  // The invariant the schema states, enforced on read as well: a folder cannot claim retail data with no
  // reason, and cannot list reasons while claiming none. Either way round it is a record we did not write.
  if (raw.RetailData !== reasons.length > 0) return null;
  return {
    Schema: MAP_ORIGIN_SCHEMA,
    Origin: raw.Origin,
    ...(typeof raw.Course === 'string' && raw.Course ? { Course: raw.Course } : {}),
    RetailData: raw.RetailData,
    Reasons: reasons,
  };
}

/** What a reference map summary carries to the editor: enough to list it and to say what it is — the origin
 *  row under the Reference picker reads exactly this. */
export interface MapOriginSummary {
  name: string;
  origin: MapOriginKind;
  /** The course slot an extract was read from (`GARI`), when the record names one. */
  course?: string;
  retailData: boolean;
  reasons: string[];
}

export const originSummary = (name: string, record: MapOriginRecord): MapOriginSummary => ({
  name, origin: record.Origin, ...(record.Course ? { course: record.Course } : {}),
  retailData: record.RetailData, reasons: record.Reasons,
});
