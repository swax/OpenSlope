import { createAssetMigrationVerifier } from '../../core/reference/asset-migration-verifier';
import type { AssetMigrationSources } from '../../core/reference/asset-migration';
import type { PropsPayload } from '../../core/reference/props';
import { availableAssetMaps, clearAssetCatalogue, readAssetBankAt, readAssetManifestAt } from './asset-versions';
import { textureUrl } from './asset-paths';
import { imageAssetUrl } from './asset-images';
import { workspaceFetch } from './workspace';

/** Manual review and automatic upgrades use the same current workspace and hash checks. */
export function assetMigrationSources(refresh = true): AssetMigrationSources {
  if (refresh) clearAssetCatalogue();
  return {
    maps: availableAssetMaps,
    manifest: readAssetManifestAt,
    version: readAssetBankAt,
    verify: createAssetMigrationVerifier({
      async texture(level, name) {
        const response = await fetch(await imageAssetUrl(textureUrl(level, name)));
        if (!response.ok) throw new Error('The current texture is unavailable.');
        return new Uint8Array(await response.arrayBuffer());
      },
      async props(level) {
        const response = await workspaceFetch(`/api/props?level=${encodeURIComponent(level)}`);
        if (!response.ok) throw new Error('The current prop definition is unavailable.');
        return (await response.json()) as PropsPayload;
      },
    }),
  };
}
