import { join } from 'node:path';
import { readJsonOr } from '../fs-async';
import {
  isSlopesmithExportManifest, SLOPESMITH_EXPORT_MANIFEST, type SlopesmithExportManifest,
} from '../../core/export/manifest';

export {
  SLOPESMITH_EXPORT_MANIFEST, SLOPESMITH_EXPORT_SCHEMA,
  type PublicDistributionStatus, type SlopesmithContentProvenance,
  type SlopesmithExportManifest, type SlopesmithTextureSource,
} from '../../core/export/manifest';

/** The manifest of a built map folder on disk, or null when the folder carries none this build understands. */
export async function readSlopesmithExportManifest(dir: string): Promise<SlopesmithExportManifest | null> {
  const value = await readJsonOr<unknown>(join(dir, SLOPESMITH_EXPORT_MANIFEST), null);
  return isSlopesmithExportManifest(value) ? value : null;
}
