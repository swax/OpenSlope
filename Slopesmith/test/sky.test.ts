import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportSkybox, levelsWithSkybox, readLevelPanorama, readSkyRing, readSkyTile, saveCustomSky,
} from '../src/server/routes/skybox';
import { decodePng } from '../src/server/routes/png';
import type { Rgba } from '../src/core/paint/ground-textures';
import { panelRect, panoramaSize, SKY_TIERS } from '../src/core/sky/ring';
import { sliceRing, stitchPanorama } from '../src/core/sky/slice';
import { skyColorFromBytes, skyColorFromHex, skyColorToHex } from '../src/app/viewport/scene/sky';
import {
  DEFAULT_FAL_MODEL, FAL_PANORAMA_MODEL, createFalGenerationProvenance,
} from '../src/core/paint/fal-models';
import { check, failures } from './check';

/**
 * Headless check of the skybox pipeline (docs/025): the generated ring metadata, the
 * panorama stitch, the round trip back through the slicer, and both export shapes.
 *
 * The round trip is the real test. A sky's tiles stitch into a panorama and that panorama cuts back into
 * tiles; if the azimuth spans, the U direction or the band heights are wrong anywhere, the pixels come back
 * displaced and the error shows up as a large mean difference. Getting the same picture back is what says
 * the ring model matches the geometry SSX actually ships.
 */

const levels = await levelsWithSkybox();
const assetRoot = mkdtempSync(join(tmpdir(), 'slopesmith-sky-assets-'));
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = assetRoot;
check(levels.length > 0, `levels shipping a sky: ${levels.join(', ') || '(none)'}`);

// Three works internally in linear light. Hex strings and PNG/canvas bytes are sRGB, so each direction must
// convert exactly once: the old double conversion made #ff5500 preview as the much redder #ff1700.
check(skyColorToHex(skyColorFromHex('#ff5500')) === '#ff5500', 'explicit TopColor survives the viewport colour-space round trip');
check(skyColorToHex(skyColorFromBytes(255, 85, 0)) === '#ff5500', 'panorama-derived TopColor survives the viewport colour-space round trip');

for (const level of levels) {
  const ring = await readSkyRing(level);
  const upper = ring.panels.filter(p => p.band === 'upper');
  const lower = ring.panels.filter(p => p.band === 'lower');
  check(upper.length > 0 && lower.length > 0 && ring.tiles.length === ring.panels.length + 1,
    `${level}: generated metadata covers ${upper.length} upper + ${lower.length} lower + ground`);

  // every panel's panorama rect must be a forward, non-empty span: if a panel straddled the anchor its x1
  // would come back BEHIND its x0, which is exactly the wrap bug the 180° anchor exists to avoid
  const bad = ring.panels.filter(p => { const r = panelRect(p, ring); return !(r.x1 > r.x0) || !(r.y1 > r.y0); });
  check(bad.length === 0, `${level}: every panel is a forward rect (${bad.length} broken)`);

  // the two bands must each tile the full 360° exactly once — no gaps, no overlaps
  for (const [name, band] of [['upper', upper], ['lower', lower]] as const) {
    const covered = band.reduce((sum, p) => { const r = panelRect(p, ring); return sum + (r.x1 - r.x0); }, 0);
    check(Math.abs(covered - 1) < 1e-6, `${level}: ${name} band covers the horizon exactly once (${covered.toFixed(6)})`);
  }
}

// --- round trip: a level's own tiles -> panorama -> tiles ---
const level = levels.includes('GARI') ? 'GARI' : levels[0];
if (level) {
  const ring = await readSkyRing(level);
  const pano = decodePng(await readLevelPanorama(level));
  const cut = sliceRing(pano, ring);
  let worst = 0, worstPanel = -1;
  for (const p of ring.panels) {
    const orig = await readSkyTile(level, p.index);
    const back = cut[p.index];
    if (orig.w !== back.w || orig.h !== back.h) { check(false, `${level}: panel ${p.index} size ${back.w}x${back.h} != ${orig.w}x${orig.h}`); continue; }
    let sum = 0;
    for (let i = 0; i < orig.w * orig.h; i++)
      for (let c = 0; c < 3; c++) sum += Math.abs(orig.data[i * 4 + c] - back.data[i * 4 + c]);
    const mean = sum / (orig.w * orig.h * 3);
    if (mean > worst) { worst = mean; worstPanel = p.index; }
  }
  // resampling twice through bilinear costs a few levels of 255; a misplaced panel costs tens
  check(worst < 8, `${level}: tiles survive a panorama round trip (worst panel ${worstPanel}, mean Δ ${worst.toFixed(2)}/255)`);
}

// --- export: a level sky, taken whole ---
const dir = mkdtempSync(join(tmpdir(), 'skycheck-'));
try {
  const log = await exportSkybox(dir, { source: { kind: 'level', level }, on: true });
  console.log('   ' + log.join('\n   '));
  const pages = readdirSync(join(dir, 'Skybox', 'Textures'));
  const ring = await readSkyRing(level);
  check(pages.length === ring.tiles.length, `level sky exports every measured page (${pages.length})`);
  const meshes = readdirSync(join(dir, 'Skybox', 'Meshes'));
  check(meshes.length === ring.tiles.length, 'level sky exports exactly the extracted ring meshes');
  const meta = JSON.parse(readFileSync(join(dir, 'Skybox', 'Sky.json'), 'utf8'));
  check(meta.Source === 'level' && meta.Level === level && !('Cap' in meta), `Sky.json contains only current sky metadata (${JSON.stringify(meta)})`);
  // taken whole means byte-identical: the repack lifts the original bank, so the pages must not be re-encoded
  const orig = readFileSync(join('..', 'Maps', level, 'Skybox', 'Textures', '0000.png'));
  const out = readFileSync(join(dir, 'Skybox', 'Textures', '0000.png'));
  check(orig.equals(out), 'a level sky ships its pages verbatim (byte-identical)');

  // --- export: a custom panorama, cut against that level's ring ---
  const { w, h } = panoramaSize(SKY_TIERS.high.upper, ring);
  // the store answers with the name it used — a name already in Shared/Skies steps aside (docs/038)
  const skyGeneration = createFalGenerationProvenance(
    [DEFAULT_FAL_MODEL, FAL_PANORAMA_MODEL], '2026-08-16T19:30:00.000Z');
  const skyName = await saveCustomSky('skycheck', await readLevelPanorama(level), 'band', '', skyGeneration);
  const skyArchive = JSON.parse(readFileSync(join(assetRoot, 'skies', `${skyName}.generation.json`), 'utf8'));
  check(skyArchive.models.length === 2 && skyArchive.models[1].id === FAL_PANORAMA_MODEL,
    'a generated sky archives both the base and panorama model beside its PNG');
  const clog = await exportSkybox(dir,
    { source: { kind: 'custom', name: skyName }, on: true, tier: 'standard', ring: level });
  console.log('   ' + clog.join('\n   '));
  const t = SKY_TIERS.standard;
  const upperIndex = ring.panels.find(panel => panel.band === 'upper')!.index;
  const lowerIndex = ring.panels.find(panel => panel.band === 'lower')!.index;
  const p0 = decodePng(readFileSync(join(dir, 'Skybox', 'Textures', String(upperIndex).padStart(4, '0') + '.png')));
  const p8 = decodePng(readFileSync(join(dir, 'Skybox', 'Textures', String(lowerIndex).padStart(4, '0') + '.png')));
  const ground = decodePng(readFileSync(join(dir, 'Skybox', 'Textures', String(ring.groundIndex).padStart(4, '0') + '.png')));
  check(p0.w === t.upper && p8.w === t.lower && ground.w === t.ground,
    `custom sky honours its tier (upper ${p0.w}, lower ${p8.w}, ground ${ground.w}; panorama stored ${w}x${h})`);
  // the ring is the sky's own property, so the pages are cut against the geometry the document names
  const cmeta = JSON.parse(readFileSync(join(dir, 'Skybox', 'Sky.json'), 'utf8'));
  check(cmeta.Source === 'custom' && cmeta.Ring === level,
    `a custom sky is cut against the ring its document names (Ring ${cmeta.Ring})`);

  const firstPanel = ring.panels[0].index;
  const partial = Array.from<Rgba | null>({ length: ring.tiles.length }).fill(null);
  partial[firstPanel] = await readSkyTile(level, firstPanel);
  const src = stitchPanorama(partial, ring, 64, 12);
  check(src.w === 64, 'stitch accepts a partial tile set (missing panels stay blank)');
} finally {
  rmSync(dir, { recursive: true, force: true });
  // the check's own panorama must not survive it — a leftover would sit in the editor's sky picker for good
  rmSync(assetRoot, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall sky checks passed');
process.exit(failures ? 1 : 0);
