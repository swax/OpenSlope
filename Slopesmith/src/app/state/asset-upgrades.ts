import {
  previewAssetMigration,
  upgradeExactAssetReferences,
  type AssetMigrationSources,
} from '../../core/reference/asset-migration';

/** Background discovery cannot change a different project, a followed map, or newer reference edits. */
export function createAssetUpgrades(deps: {
  getDoc(): object;
  context(): string;
  writable(): boolean;
  sources(): AssetMigrationSources;
  changed(count: number): void;
  failed?(error: unknown): void;
}) {
  let running: Promise<void> | undefined;
  let requested = false;
  async function run() {
    while (requested) {
      requested = false;
      if (!deps.writable()) continue;
      const document = deps.getDoc(),
        context = deps.context();
      try {
        const preview = await previewAssetMigration(document, deps.sources());
        if (!deps.writable() || deps.context() !== context || deps.getDoc() !== document) continue;
        const count = upgradeExactAssetReferences(document, preview);
        if (count) deps.changed(count);
      } catch (error) {
        deps.failed?.(error);
      }
    }
  }
  function request(): Promise<void> {
    requested = true;
    running ??= Promise.resolve()
      .then(run)
      .finally(() => {
        running = undefined;
        if (requested) void request();
      });
    return running;
  }
  return { request };
}
