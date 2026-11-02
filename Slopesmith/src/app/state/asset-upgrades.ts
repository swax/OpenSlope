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
  palette?: {
    references(): readonly string[];
    upgrade(replacements: ReadonlyMap<string, string>): void;
  };
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
        // Discover shared map/palette references together, so each asset is verified only once.
        const preview = await previewAssetMigration(
          { document, palette: { quadTex: deps.palette?.references() ?? [] } },
          deps.sources(),
        );
        if (!deps.writable() || deps.context() !== context || deps.getDoc() !== document) continue;
        const count = upgradeExactAssetReferences(document, {
          ...preview,
          rows: preview.rows.map(row => ({
            ...row,
            paths: row.paths.filter(path => path[0] === 'document').map(path => path.slice(1)),
          })),
        });
        if (count) deps.changed(count);
        if (!deps.writable() || deps.context() !== context || deps.getDoc() !== document) continue;
        deps.palette?.upgrade(
          new Map(
            preview.rows.flatMap(row =>
              row.kind === 'texture' && row.to && ['verified', 'matching'].includes(row.status)
                ? [[row.from, row.to] as const]
                : [],
            ),
          ),
        );
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
