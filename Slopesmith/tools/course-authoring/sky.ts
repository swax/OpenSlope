/** Deterministic conditioning and staging for course-owned custom panoramas. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Rgba } from '../../src/core/paint/ground-textures';
import type { SkyboxDoc } from '../../src/core/doc/types';
import { panoramaSize, ringTopEquirectV, SKY_TIERS } from '../../src/core/sky/ring';
import { deriveTopColor, fitToBand } from '../../src/core/sky/slice';
import { decodePng, encodePng } from '../../src/server/routes/png';
import { levelsWithSkybox, readSkyRing } from '../../src/server/routes/skybox';
import { mapsRoot } from '../../src/server/workspace-config';

const at = (image: Rgba, x: number, y: number): number => (y * image.w + x) * 4;

/**
 * Cross-fade each outside edge with the antipodal image. The pixels that meet after wrapping were neighbours
 * before the blend, so the native cylinder cannot expose a hard vertical join.
 */
export function wrapBlendX(image: Rgba, band = 0.18): Rgba {
  const out: Rgba = { w: image.w, h: image.h, data: new Uint8Array(image.data.length) };
  const blendWidth = Math.max(1, Math.round(image.w * band));
  const half = image.w >> 1;
  for (let y = 0; y < image.h; y++) {
    for (let x = 0; x < image.w; x++) {
      const blend = Math.min(1, Math.min(x, image.w - 1 - x) / blendWidth);
      const source = at(image, x, y);
      const opposite = at(image, (x + half) % image.w, y);
      const target = at(out, x, y);
      for (let channel = 0; channel < 4; channel++) {
        out.data[target + channel] = image.data[opposite + channel] * (1 - blend)
          + image.data[source + channel] * blend;
      }
    }
  }
  return out;
}

/** Converge the open cylinder rim to one colour so the panorama meets the solid top fill continuously. */
export function calmTop(image: Rgba, topV: number, fade = 0.12): Rgba {
  const out: Rgba = { w: image.w, h: image.h, data: new Uint8Array(image.data) };
  const topY = Math.min(out.h - 1, Math.max(0, Math.round(topV * out.h)));
  const mean = [0, 0, 0];
  for (let x = 0; x < out.w; x++) {
    const source = at(out, x, topY);
    mean[0] += out.data[source];
    mean[1] += out.data[source + 1];
    mean[2] += out.data[source + 2];
  }
  for (let channel = 0; channel < 3; channel++) mean[channel] /= out.w;

  const fadeRows = Math.max(1, Math.round(out.h * fade));
  const end = Math.min(out.h, topY + fadeRows);
  for (let y = 0; y < end; y++) {
    const blend = y <= topY ? 1 : 1 - (y - topY) / fadeRows;
    for (let x = 0; x < out.w; x++) {
      const target = at(out, x, y);
      for (let channel = 0; channel < 3; channel++) {
        out.data[target + channel] += (mean[channel] - out.data[target + channel]) * blend;
      }
    }
  }
  return out;
}

const colorHex = (rgb: [number, number, number]): string => '#' + rgb
  .map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
  .join('');

export interface PrepareCourseSkyOptions {
  skyName: string;
  sourceFile: string;
  courseFile: string;
  courseLabel: string;
  preferredRing?: string;
  wrapBand?: number;
  topFade?: number;
  tier?: SkyboxDoc['tier'];
}

export async function prepareCourseSky(options: PrepareCourseSkyOptions): Promise<SkyboxDoc> {
  const levels = await levelsWithSkybox();
  const ringLevel = options.preferredRing && levels.includes(options.preferredRing)
    ? options.preferredRing
    : levels.includes('GARI') ? 'GARI' : levels[0];
  if (!ringLevel) {
    throw new Error(`${options.courseLabel} sky needs one extracted level with Skybox/Ring.json`);
  }

  const ring = await readSkyRing(ringLevel);
  const generated = decodePng(await readFile(options.sourceFile));
  const conditioned = calmTop(
    wrapBlendX(generated, options.wrapBand),
    ringTopEquirectV(ring),
    options.topFade,
  );
  const size = panoramaSize(SKY_TIERS.high.upper, ring);
  const band = fitToBand(conditioned, size.w, size.h, ring, 'equirect');
  const bytes = encodePng(band);

  const sharedFile = join(mapsRoot(), 'Shared', 'Skies', `${options.skyName}.png`);
  await Promise.all([
    mkdir(dirname(options.courseFile), { recursive: true }),
    mkdir(dirname(sharedFile), { recursive: true }),
  ]);
  await Promise.all([writeFile(options.courseFile, bytes), writeFile(sharedFile, bytes)]);

  const topColor = colorHex(deriveTopColor(band));
  console.log(`sky: ${generated.w}x${generated.h} source -> ${band.w}x${band.h} band, top ${topColor}`);
  return {
    source: { kind: 'custom', name: options.skyName },
    ring: ringLevel,
    on: true,
    tier: options.tier ?? 'standard',
    topColor,
  };
}
