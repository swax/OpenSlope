/**
 * Export PHOTOMETER: a course built to MEASURE a fog bank on hardware rather than to be ridden.
 *
 * The problem it exists for. A fog puff's opacity can only be read off what it does to a backdrop of known
 * contrast, and a console gives one frame with no way to switch the fog off — so the reference has to be the
 * SAME surface, in the SAME frame, differing only by whether the fog is in front of it. Retail scenery
 * cannot supply that: measured on Garibaldi, two pieces of rock 100 px apart returned a contrast retention
 * of 1.94, which no blend can produce, because the second rock simply had more contrast than the first
 * ([Trailmap: tools/autotest/README.md]).
 *
 * So: one enormous checkerboard panel square across the fall line, close enough to the start gate to fill
 * the view, with a fog volume parked in front of its MIDDLE. The panel's outer thirds stay clear and are the
 * reference; its centre is the same texture under fog. Two luminances, finely interleaved so both are
 * sampled under the same fog, one frame, nothing assumed.
 *
 *   npx tsx tools/reference-study/photometer-map.ts [outDir]
 *   snowknife repack ...            # build the ISO
 *   python ../Trailmap/tools/autotest/shot.py --out fog.png
 *   python ../Trailmap/tools/autotest/fog_meter.py checker fog.png --transfer linear --block 2 \
 *          --fog <centre rect> --ref <edge rect>
 *
 * Nothing here is ridden and nothing is graded on dispatch, so it deliberately does NOT go through the
 * auto-test fixture builder: no cells, no chains, no plan. It is a photograph of a fog bank with a ruler
 * next to it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMeshFromCourse, straightCourse } from '../../src/core/doc/mountain';
import { AUTHORED_MODEL_LEVEL } from '../../src/core/doc/models';
import { createEmptyEffectsDocument } from '../../src/core/effects/authoring';
import { createFogVolume } from '../../src/core/particles/volumes';
import type { AuthoredModel, PlacedProp, V3 } from '../../src/core/doc/types';
import { CUSTOM_TEX_LEVEL, saveSharedCustomTexture } from '../../src/server/routes/textures';
import { encodePng } from '../../src/server/routes/png';
import { exportLevel } from '../../src/server/routes/export';
import { mapsRoot } from '../../src/server/workspace-config';

const NAME = 'PHOTOMETER';
/** Which retail course the pack replaces. GARI because that is what every other fixture rides. */
const TARGET = 'GARI';

// Framing, and every number here is set by what the CAMERA sees rather than by what reads well in the
// editor. A 4:3 frame at roughly 60 degrees horizontal shows about 1.15x the distance in width, so a panel
// at 90 m spans ~104 visible metres — and the bank has to cover the middle third of THAT, not of the panel.
// The first attempt put a 160 m panel at 46 m, where only ~53 m is in frame: the clear reference thirds
// were off-screen entirely, which is a fixture that cannot be measured however well it packs.
const PANEL_W = 200;      // metres across the fall line — comfortably wider than the ~104 m in frame
const PANEL_H = 80;       // taller than the ~76 m of frame height at that distance
const PANEL_AT = 90;      // metres down the fall line from the course start
// The bank sits just IN FRONT of the panel rather than halfway to it, so its projected width stays close to
// its true width: at 75 m a 30 m cloud covers ~36 m of the 104 m in frame, leaving a third clear each side.
const FOG_AT = 75;
const FOG_HEIGHT_M = 14;  // above the ground at FOG_AT, so the cloud sits in the middle of the frame

// 32 cells of 8 texels = a 256x256 page, which is ON the GS ladder and shipped verbatim. Cell SIZE in the
// texture is what matters, not on screen: at 8 texels a cell keeps a pure 4x4 interior through bilinear
// magnification, where a 4-texel cell magnified 16x becomes a soft ramp with no flat centre to sample. The
// first attempt authored 24 cells = 192 px, off the ladder, and the packer resampled it to 128.
const CELLS = 32;
const CELL_TEXELS = 8;

/** The two greys. Deliberately NOT black and white: an additive fog over a white cell saturates, and a
 *  clipped patch reads as one whose contrast shrank — the same signature as opacity. Mid and dark leave
 *  headroom at both rails whichever way the blend turns out to go. */
const DARK: [number, number, number] = [64, 64, 64];
const LIGHT: [number, number, number] = [176, 176, 176];

let temporaryAssets = '';

async function checkerTexture(): Promise<string> {
  const px = CELL_TEXELS;
  const size = CELLS * px;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const light = (((x / px) | 0) + ((y / px) | 0)) % 2 === 0;
      const [r, g, b] = light ? LIGHT : DARK;
      const at = (y * size + x) * 4;
      data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
    }
  }
  return saveSharedCustomTexture('zz-photometer-checker.png', encodePng({ w: size, h: size, data }));
}

/** One upright panel, bottom-centre anchored, as a single textured quad. Mirrors the auto-test fixture's
 *  own panel winding ([O, second axis, first axis, diagonal]) so the exporter's tessellation agrees. */
function panel(id: string, name: string, texture: string): AuthoredModel {
  const half = PANEL_W / 2;
  return {
    id, name, anchor: [0, 0, 0],
    vertices: [-half, 0, 0, half, 0, 0, -half, PANEL_H, 0, half, PANEL_H, 0],
    quads: [[0, 2, 1, 3]], texture,
  } as unknown as AuthoredModel;
}

async function main(): Promise<number> {
  const outDir = process.argv.slice(2).find(arg => !arg.startsWith('--')) || join(mapsRoot(), NAME);
  // The checkerboard is generated per run and is the only authored asset here, so it lives in a scratch
  // library rather than being left in the workspace: unlike the auto-test tiles this is not a fixture
  // anyone opens and edits, and a stray `zz-photometer-checker_2.png` per rebuild would be pure litter.
  temporaryAssets = mkdtempSync(join(tmpdir(), 'slopesmith-photometer-'));
  process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = temporaryAssets;
  const texture = `${CUSTOM_TEX_LEVEL}/${await checkerTexture()}`;

  const course = straightCourse(400, 320, 18);
  const effects = createEmptyEffectsDocument(NAME);
  const doc = buildMeshFromCourse(course, { widthM: 320, roughness: 0, targetPatchM: 20, seed: 1301 },
    { name: NAME, baseSurface: 1, effects });
  if (!doc) throw new Error('the photometer slope could not be generated');
  // Uniform paint, so nothing about the ground changes what the panel is lit by.
  if (doc.quadPaint) for (const key of Object.keys(doc.quadPaint)) {
    const surface = doc.quadPaint[Number(key)];
    if (surface !== 0 && surface !== 2) doc.quadPaint[Number(key)] = 1;
  }

  const a = course.knots[0].pos, b = course.knots[course.knots.length - 1].pos;
  const dx = b[0] - a[0], dz = b[2] - a[2], horizontal = Math.hypot(dx, dz) || 1;
  const down: V3 = [dx / horizontal, 0, dz / horizontal];
  const groundAt = (t: number) => a[1] + (b[1] - a[1]) * t / horizontal;
  const along = (t: number): V3 => [a[0] + down[0] * t, groundAt(t), a[2] + down[2] * t];

  // The panel faces back UP the fall line. Yaw is measured the same way the auto-test panels are, and the
  // fixture asserts nothing about contact — the rider is never expected to reach it.
  const panelPos = along(PANEL_AT);
  const yaw = Math.atan2(down[0], down[2]) * 180 / Math.PI;
  const models: AuthoredModel[] = [panel('model:0000', 'PhotometerPanel', texture)];
  const props: PlacedProp[] = [{
    id: 'photometer:panel', level: AUTHORED_MODEL_LEVEL, model: 0, name: 'PHOTOPANEL',
    pos: [panelPos[0], panelPos[1], panelPos[2]], yaw, scale: 1,
  }];

  // The bank, parked in front of the panel's middle. createFogVolume is a ~40 m nine-puff cloud, so on a
  // 160 m panel it leaves both outer thirds clear — which is the whole measurement: same texture, same
  // light, one part fogged and one part not, in one frame.
  const fogPos = along(FOG_AT);
  const volume = createFogVolume([fogPos[0], fogPos[1] + FOG_HEIGHT_M, fogPos[2]]);
  // CLONE A SHIPPED CLUSTER'S PUFFS rather than trusting the synthetic starter cloud. An authored bank made
  // by `createFogVolume` packs correctly — the PBD comes out with NumParticleInstances 1 and
  // NumParticleModel 1 — and draws nothing on hardware, while an identity repack of GARI renders its own
  // `Fog_Sphere_A_0` in the same pipeline. So the difference is in the puff data, and the way to find out
  // which field matters is to start from one the engine demonstrably accepts.
  const donorModels = JSON.parse(readFileSync(
    join(mapsRoot(), TARGET, 'ParticleModels.json'), 'utf8')) as {
      ParticlePrefabs: { ParticleModelName: string; ParticleObjectHeaders: { ParticleObject: {
        LowestXYZ: V3; HighestXYZ: V3; U1: number;
        AnimationFrames: { Position: V3; Rotation: V3; Unknown: number }[] } }[] }[] };
  const donor = donorModels.ParticlePrefabs.find(p => p.ParticleModelName === 'Fog_Sphere_A_0')
    ?? donorModels.ParticlePrefabs[0];
  const shipped = donor.ParticleObjectHeaders[0].ParticleObject;
  // ONE PUFF, not the whole cluster, and this is what makes the three renderers comparable. A shipped bank
  // is 18 overlapping billboards whose opacities accumulate, so measuring it answers "how thick is a GARI
  // fog bank" — a different question from the one Unity and Slopesmith were asked, where a single quad was
  // photographed. Keep the shipped puff's own radius and scale so the sprite is a real one; just draw it
  // alone. (`--cluster` restores the full bank for the bank-level question.)
  const wholeCluster = process.argv.includes('--cluster');
  const chosen = wholeCluster ? shipped.AnimationFrames : [shipped.AnimationFrames[0]];
  const span = Math.max(...chosen.map(f => f.Unknown)) * 1.5;
  volume.objects = [{
    boundsMin: (wholeCluster ? [...shipped.LowestXYZ] : [-span, -span, -span]) as V3,
    boundsMax: (wholeCluster ? [...shipped.HighestXYZ] : [span, span, span]) as V3,
    objectU1: shipped.U1,
    puffs: chosen.map(frame => ({
      position: (wholeCluster ? [...frame.Position] : [0, 0, 0]) as V3,
      scale: [...frame.Rotation] as V3, radius: frame.Unknown,
    })),
  }];
  volume.boundsOffsetMin = volume.objects[0].boundsMin;
  volume.boundsOffsetMax = volume.objects[0].boundsMax;
  console.log(`cloned ${donor.ParticleModelName}: ${shipped.AnimationFrames.length} puffs, `
    + `radii ${Math.min(...shipped.AnimationFrames.map(f => f.Unknown)).toFixed(0)}`
    + `-${Math.max(...shipped.AnimationFrames.map(f => f.Unknown)).toFixed(0)} raw`);
  // Shrunk on the puffs themselves rather than through the instance `scale`, because whether the native
  // runtime scales a puff RADIUS by the instance matrix is exactly the sort of thing this fixture is
  // supposed to measure rather than assume.
  // NAMED LIKE RETAIL, and this is not cosmetic. The engine picks a particle effect's sprite by effect TYPE
  // rather than by a stored index ([Trailmap: 400-rendering] / the extract's own note), and every shipped
  // volume is `Fog_*` — so a bank called `Photometer_Bank` packs perfectly, lands in the PBD with the right
  // counts, and draws nothing. Slopesmith's own default (`Fog_Volume`) is not a retail name either.
  volume.name = 'Fog_Sphere_A_0';
  volume.donor = TARGET;   // stage fog0.png from the course this pack replaces
  // One bank, in front of the panel's middle. (An earlier revision scattered twelve copies over four
  // heights and three lateral offsets to find out why none of them drew; the answer was not the placement
  // — `repack` was shipping the DONOR slot's fog table and discarding the export's, so the disc carried
  // GARI's ten banks at GARI's coordinates. Fixed in RepackService; one bank is enough again.)
  doc.particleVolumes = [volume];
  doc.models = models;
  doc.props = props;
  doc.effects = effects;

  const result = await exportLevel(doc as never, { outDir, lighting: false });
  console.log(result.log);

  const note = {
    name: NAME, target: TARGET, exportDir: outDir,
    panel: { widthM: PANEL_W, heightM: PANEL_H, atM: PANEL_AT, cells: CELLS,
      cellM: PANEL_W / CELLS, dark: DARK, light: LIGHT, texture },
    fog: { atM: FOG_AT, name: volume.name, puffs: volume.objects[0].puffs.length,
      radiiRaw: volume.objects[0].puffs.map(p => p.radius) },
    howToRead: 'shoot at the start gate; --fog a rect on the panel CENTRE (under the bank), '
      + '--ref a rect on the same panel well outside it. transfer=linear (the PS2 blends framebuffer '
      + 'bytes), block=2 (PCSX2 upscale_multiplier).',
  };
  writeFileSync(join(outDir, 'photometer.json'), JSON.stringify(note, null, 1) + '\n');
  console.log(`\npanel ${PANEL_W}x${PANEL_H} m at ${PANEL_AT} m, ${CELLS} cells `
    + `(${(PANEL_W / CELLS).toFixed(1)} m each); fog bank at ${FOG_AT} m`);
  console.log(`wrote ${join(outDir, 'photometer.json')}`);
  return 0;
}

main().then(code => process.exitCode = code, error => { console.error(error); process.exitCode = 1; })
  .finally(() => { if (temporaryAssets) rmSync(temporaryAssets, { recursive: true, force: true }); });
