import { discRecipeFiles } from './disc';
import { type ExportFile, type ExportFolder } from './files';

/** A complete imported course, independent of the destination game's texture numbering. */
export function referenceExportFolder(name: string, source: readonly ExportFile[]): ExportFolder {
  const files = new Map(source.map(file => [file.path, file.bytes]));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const textures = new Map<string, string>();
  for (const path of files.keys()) {
    const match = /^Textures\/([^/]+\.png)$/i.exec(path);
    if (match) textures.set(match[1].toLowerCase(), `source_${match[1]}`);
  }
  const texture = (value: unknown) =>
    typeof value === 'string' ? (textures.get(value.toLowerCase()) ?? value) : value;
  for (const path of ['Patches.json', 'Materials.json']) {
    const bytes = files.get(path);
    if (!bytes) {
      if (path === 'Patches.json') throw new Error('This map has no Patches.json. Load it again before exporting.');
      continue;
    }
    const data = JSON.parse(decoder.decode(bytes)) as Record<string, Array<Record<string, unknown>>>;
    for (const row of data[path === 'Patches.json' ? 'Patches' : 'Materials'] ?? []) {
      row.TexturePath = texture(row.TexturePath);
      if (Array.isArray(row.TextureFlipbook)) row.TextureFlipbook = row.TextureFlipbook.map(texture);
    }
    files.set(path, encoder.encode(JSON.stringify(data)));
  }
  for (const [path, bytes] of [...files]) {
    const match = /^Textures\/([^/]+\.png)$/i.exec(path);
    if (match) {
      files.delete(path);
      files.set(`Textures/${textures.get(match[1].toLowerCase())!}`, bytes);
    }
  }
  // A reference may itself be an authored export. Retain its settings/provenance while making every
  // staged page self-contained; its old donor pointers must not override the supplied PNGs.
  const manifest = files.get('Slopesmith.json');
  const data = manifest
    ? (JSON.parse(decoder.decode(manifest)) as Record<string, unknown>)
    : ({ schema: 1, kind: 'slopesmith-export', level: name, documentVersion: 1 } as Record<string, unknown>);
  data.textures = Object.fromEntries(
    [...textures.values()].map(staged => [staged, { level: 'custom', name: staged, staged }]),
  );
  files.set('Slopesmith.json', encoder.encode(JSON.stringify(data)));
  const recipe = discRecipeFiles(name, {
    exportDir: name,
    archive: `${name}.snowknife.zip`,
    levelData: 'Maps/TRICKY_GARI',
    levelDataRelative: '../Maps/TRICKY_GARI',
  });
  for (const file of recipe.files) files.set(file.path, file.bytes);
  return {
    files: [...files].map(([path, bytes]) => ({ path, bytes })),
    remove: [],
    log: [`Exported ${name}'s imported course files.`, ...recipe.log],
  };
}
