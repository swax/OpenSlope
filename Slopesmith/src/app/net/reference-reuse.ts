import {
  previewAssetMigration,
  upgradeExactAssetReferences,
  type AssetMigrationSources,
} from '../../core/reference/asset-migration';
import { parseAssetVersion } from '../../core/reference/asset-version';
import { assetMigrationSources } from './asset-migration';

/** Reuse works on a copy: missing originals stay intact and never select a merely similar replacement. */
export async function normalizeReusedReferences<T>(
  value: T,
  sources: AssetMigrationSources = assetMigrationSources(false),
): Promise<T> {
  const result = structuredClone(value);
  try {
    const preview = await previewAssetMigration(result, sources);
    const count = upgradeExactAssetReferences(result, preview);
    if (count) console.info(`[assets] Auto-updated ${count} exact reference(s) to asset2 while reusing content.`);
  } catch {
    // Being offline or missing the original is not permission to change the selected asset.
  }
  return result;
}

export async function normalizeReusedTexture(ref: string): Promise<string> {
  return (await normalizeReusedReferences({ texture: ref })).texture;
}

/** New picks already use asset2; only legacy templates need asynchronous verification before a re-layout. */
export function hasAsset1References(value: unknown): boolean {
  if (typeof value === 'string') {
    const asset = parseAssetVersion(value.split('/')[0]);
    return !!asset && !asset.kind;
  }
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return false;
  return Object.values(value).some(hasAsset1References);
}
