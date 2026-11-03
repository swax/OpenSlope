import type { PlacedProp } from '../doc/types';
import type { PropMaterial } from '../reference/props';
import type { Rgba } from '../paint/ground-textures';
import { makeTexRef, resolvePropTex } from '../paint/textures';
import { textureShadowMask, type ShadowMask } from '../lighting/shadow-mask';
import type { GeometryLookup, GeomSub } from './props';

/** Resolve only used, alpha-enabled rest-frame images once before the synchronous export bake. */
export async function preparePropShadowMasks(
  props: readonly PlacedProp[],
  geometryOf: GeometryLookup,
  materialOf: (level: string, mat: number) => PropMaterial | undefined,
  readImage: (ref: string) => Promise<Rgba | undefined>,
): Promise<(prop: PlacedProp, sub: GeomSub) => ShadowMask | null | undefined> {
  const masks = new Map<string, Map<GeomSub, ShadowMask | null | undefined>>();
  const images = new Map<string, Promise<Rgba | undefined>>();
  const seen = new Set<string>();
  const jobs: Promise<void>[] = [];
  for (const prop of props) {
    const key = `${prop.level}:${prop.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let bySub = masks.get(prop.level);
    if (!bySub) masks.set(prop.level, (bySub = new Map()));
    for (const sub of geometryOf(prop.level, prop.model)?.subs ?? []) {
      if (bySub.has(sub)) continue;
      bySub.set(sub, undefined);
      const material = materialOf(prop.level, sub.mat);
      if (!material) continue;
      const policy = {
        mode: material.alphaMode,
        alphaPass: material.blend,
        priority: material.prio,
        pixelAlpha: material.pixelAlpha,
      };
      if (policy.mode === 'glow') {
        bySub.set(sub, null);
        continue;
      }
      if (policy.mode === 'opaque' || (!policy.mode && !policy.alphaPass && !policy.priority && !policy.pixelAlpha))
        continue;
      const tile = resolvePropTex(prop.level, material.frames[0] ?? material.tex);
      if (!tile.name) continue;
      const ref = makeTexRef(tile.level, tile.name);
      let image = images.get(ref);
      if (!image) images.set(ref, (image = readImage(ref).catch(() => undefined)));
      const target = bySub;
      jobs.push(
        image.then(pixels => {
          target.set(sub, textureShadowMask(pixels, policy));
        }),
      );
    }
  }
  await Promise.all(jobs);
  return (prop, sub) => masks.get(prop.level)?.get(sub);
}
