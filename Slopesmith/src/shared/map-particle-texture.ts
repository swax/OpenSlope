import { referenceParticleTexturePaths } from '../core/effects/particle-textures';
import { referenceAssetId } from '../core/reference/asset-manifest';
import { assetMapKey } from '../core/reference/asset-version';
import { sha256 } from '../core/reference/asset-hash';
import { mapGame } from '../core/reference/map-game';
import { joinMapPath, type MapDataSource } from './map-data';
import { listLevelOrigins } from './map-levels';

/** Discover a legacy shared sprite once; its bytes then use the ordinary immutable texture resolver. */
export async function readParticleTextureReference(
  io: MapDataSource,
  name: string,
  levels: readonly string[],
): Promise<string | undefined> {
  for (const level of levels) {
    const profile = await io.readJsonOr<unknown>(joinMapPath(io.root, level, 'RidingEffects.json'), {});
    for (const path of referenceParticleTexturePaths(name, profile)) {
      const bytes = await io.readBytesOrNull(joinMapPath(io.root, level, 'Textures', path));
      if (!bytes) continue;
      const origin = (await listLevelOrigins(io, [level]))[0] ?? { name: level };
      return referenceAssetId(
        mapGame(origin),
        assetMapKey(level, origin.course),
        'texture',
        path.toLowerCase(),
        await sha256(bytes),
      );
    }
  }
}
