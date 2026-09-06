import type { SkyboxDoc } from '../doc/types';
import type { Rgba } from '../paint/ground-textures';
import { SKY_TIERS, tileSizes, type SkyRing } from '../sky/ring';
import { sliceRing } from '../sky/slice';
import { textFile, type ExportFile } from './files';

/**
 * The authored sky as an extracted level's `Skybox/` (docs/025), composed from bytes already in hand.
 *
 * `Skybox/` comes out shaped exactly like an extracted level's, because that is what everything downstream
 * already reads: `snowknife skybox` merges Models.json + Meshes/ into the Skybox.obj Unity bakes its cubemap
 * from, and `repack` encodes Textures/ into `<stem>_sky.ssh`. So:
 *
 *   Models.json / Materials.json / Meshes/   the ring, copied verbatim from a level that ships one. Any level
 *                                            will do when compatible, but it is the one the pages were cut
 *                                            against, so the
 *                                            seams land on the geometry that will actually draw them.
 *   Textures/*.png                           the measured slots: a level sky's own, verbatim; a custom sky's, cut
 *                                            from its panorama at that ring's real azimuth spans.
 *   Sky.json                                 what this sky IS, for the repack: source, ring and TopColor.
 *
 * Finding the ring and reading those bytes is the provider's half — a folder on disk for the server, an HTTP
 * route for the browser — so only the composition lives here, and both write the same folder.
 */

/** The measured page set, in the two forms a sky supplies it. */
export type SkyboxPageSource =
  /** A level sky ships its own pages untouched, in slot order. */
  | { kind: 'level'; pages: readonly Uint8Array[] }
  /** A custom sky is cut from its stored panorama against the ring's real wall-panel spans. */
  | { kind: 'custom'; panorama: Rgba };

export interface SkyboxSource {
  /** The level whose ring geometry the pages are cut for, sanitised. */
  ringLevel: string;
  /** That ring verbatim: `Skybox/Models.json`, `Skybox/Materials.json` and `Skybox/Meshes/*`, already
   *  addressed relative to the export folder. */
  ringFiles: ExportFile[];
  /** Measured composition metadata from that ring's generated `Ring.json`. */
  ring: SkyRing;
  pages: SkyboxPageSource;
}

const pageName = (index: number) => String(index).padStart(4, '0') + '.png';

export async function composeSkybox(sky: SkyboxDoc, source: SkyboxSource,
  encodePng: (image: Rgba) => Promise<Uint8Array>): Promise<{ files: ExportFile[]; log: string[] }> {
  const files: ExportFile[] = [...source.ringFiles];
  const pageCount = source.ring.tiles.length;
  const log = [`skybox: ${source.ringLevel}'s ring (${pageCount} meshes) + materials`];

  if (source.pages.kind === 'level') {
    source.pages.pages.forEach((bytes, i) => files.push({ path: `Skybox/Textures/${pageName(i)}`, bytes }));
    log.push(`skybox: ${source.ringLevel}'s own ${pageCount} pages, verbatim`);
  } else {
    const tier = SKY_TIERS[sky.tier ?? 'standard'];
    const tiles = sliceRing(source.pages.panorama, { ...source.ring, tiles: tileSizes(tier, source.ring) });
    for (const [i, tile] of tiles.entries())
      files.push({ path: `Skybox/Textures/${pageName(i)}`, bytes: await encodePng(tile) });
    const name = sky.source.kind === 'custom' ? sky.source.name : source.ringLevel;
    log.push(`skybox: "${name}" cut into ${pageCount} pages against ${source.ringLevel}'s ring `
      + `(${tier.upper}px upper / ${tier.lower}px lower / ${tier.ground}px ground)`);
  }

  files.push(textFile('Skybox/Sky.json', JSON.stringify({
    Source: sky.source.kind === 'level' ? 'level' : 'custom',
    Level: sky.source.kind === 'level' ? source.ringLevel : undefined,
    Ring: source.ringLevel,
    Tier: sky.source.kind === 'custom' ? (sky.tier ?? 'standard') : undefined,
    TopColor: sky.topColor,
  })));
  return { files, log };
}
