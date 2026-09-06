import type { V3 } from '../doc/types';

/**
 * A reference course's VIDEO SCREENS, read back out of its `Billboards.json` (docs/051).
 *
 * That file is what `snowknife billboards` measured off the course's own boards — the ad face of every
 * billboard, sized and turned toward the riders. Reading it here is the other half of authoring one: an author
 * can see where a shipped course already carries screens before deciding where their own belong, and the two
 * are drawn by the same viewport layer because they are the same kind of thing.
 *
 * The document is in SSX MESH space (cm, Z up, X as the bundle stores it); everything below comes back in
 * editor metres through the same map the reference terrain and props use.
 */

export interface ReferenceScreen {
  name: string;
  family?: string;
  /** Original Instances.json row, when this was measured from a shipped map. */
  instance?: number;
  /** Texture page carrying the face the detector fitted. */
  page?: string;
  /** Editor metres. */
  center: V3;
  normal: V3;
  up: V3;
  width: number;
  height: number;
}

/** Mesh space (cm) -> editor metres. `editorFromRaw` with the bundle's X mirror already applied. */
const fromMesh = (p: readonly number[]): V3 => [p[0] / 100, p[2] / 100, -p[1] / 100];

function unit(p: readonly number[], fallback: V3): V3 {
  const v = fromMesh(p);
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : fallback;
}

const triple = (value: unknown): number[] | null =>
  Array.isArray(value) && value.length >= 3 && value.every(entry => typeof entry === 'number')
    ? value as number[] : null;

/**
 * Decode a `Billboards.json` document. Anything malformed is dropped rather than thrown: this is a sidecar a
 * reference course may not have at all, and a half-written one must not stop the level from opening.
 */
export function decodeBillboards(document: unknown): ReferenceScreen[] {
  const screens = (document as { Screens?: unknown })?.Screens;
  if (!Array.isArray(screens)) return [];
  const out: ReferenceScreen[] = [];
  for (const entry of screens) {
    const record = entry as Record<string, unknown>;
    const center = triple(record.Center), normal = triple(record.Normal), up = triple(record.Up);
    const width = record.Width, height = record.Height;
    if (!center || !normal || !up) continue;
    if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) continue;
    out.push({
      name: typeof record.Name === 'string' && record.Name ? record.Name : `screen ${out.length + 1}`,
      ...(typeof record.Family === 'string' && record.Family ? { family: record.Family } : {}),
      ...(Number.isInteger(record.Instance) && (record.Instance as number) >= 0
        ? { instance: record.Instance as number } : {}),
      ...(typeof record.Page === 'string' && record.Page ? { page: record.Page } : {}),
      center: fromMesh(center),
      normal: unit(normal, [0, 0, 1]),
      up: unit(up, [0, 1, 0]),
      width: width / 100,
      height: height / 100,
    });
  }
  return out;
}

/** The read-only identity/measurement shown after picking a reference screen. */
export type ReferenceScreenPickDetails = Pick<ReferenceScreen,
  'name' | 'family' | 'instance' | 'page' | 'width' | 'height'>;
