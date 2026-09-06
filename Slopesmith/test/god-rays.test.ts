// tier: fast

/**
 * Sun god-rays: the engine's celestial glare fan ([Trailmap: 400-rendering], the celestial-glare section),
 * ported to the editor viewport and to Unity ([Unity: 046-sun-god-rays]).
 * Run: tsx test/god-rays.test.ts
 *
 * What has to hold for the port to be the same effect everywhere:
 *
 *  1. **The spoke pattern is procedural and original.** It stays ordered, deterministic and varied without
 *     embedding the retail engine's arbitrary angle/intensity selection.
 *  2. **Every rim vertex reaches the screen border.** That is the geometry law; a fan that stops short
 *     leaves the corners of the view dark and the effect reads as a sprite instead of light.
 *  3. **The falloff is the engine's,** `(C − min(d², C)) / C` with C = 3 — brightness falls with the SQUARE
 *     of the screen distance travelled, so long rays into far corners arrive dimmer than short ones.
 *  4. **The corners are spliced in.** The four screen corners join the fan in angular order wherever they
 *     fall, which is what keeps it convex and gapless as the sun crosses the view.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  DEFAULT_GODRAY_COURSE, GODRAY_LAW, GODRAY_SPOKES, buildGodRayRim, godRayPresentation,
  normalizeGodRayCourse, sceneDirFromGlareAzEl, spokeIntensityAt,
} from '../src/core/lighting/god-rays';
import { sunDirFromElAz } from '../src/core/lighting/lightmap';
import { defaultMountain } from '../src/core/doc/mountain';
import { buildMountainLevel } from '../src/core/export/level';
import { createGodRayLayer } from '../src/app/viewport/scene/god-rays';
import { check, failures, near } from './check';

const onBorder = (v: { x: number; y: number }) =>
  near(Math.abs(v.x), 1, 1e-6) || near(Math.abs(v.y), 1, 1e-6);

console.log('== the project-authored procedural spoke pattern ==');
check(GODRAY_SPOKES.length === 32, `32 generated spokes (got ${GODRAY_SPOKES.length})`);
check(GODRAY_SPOKES.every(s => Number.isFinite(s.deg) && Number.isFinite(s.amp)),
  'every generated angle and amplitude is finite');
check(GODRAY_SPOKES.every(s => s.amp >= 0.18 && s.amp <= 0.9),
  'every generated amplitude stays in the authored visibility band');
check(GODRAY_SPOKES[0].deg === 0 && GODRAY_SPOKES.at(-1)!.deg < 360,
  'the generated pattern covers one turn without duplicating its first spoke');
{
  let rising = true;
  for (let i = 1; i < GODRAY_SPOKES.length; i++) if (GODRAY_SPOKES[i].deg <= GODRAY_SPOKES[i - 1].deg) rising = false;
  check(rising, 'angles rise strictly — the fan is already in angular order');
  const gaps = GODRAY_SPOKES.slice(1).map((s, i) => s.deg - GODRAY_SPOKES[i].deg);
  check(Math.min(...gaps) <= 6 && Math.max(...gaps) >= 16,
    `formula-driven spacing is visibly uneven (${Math.min(...gaps).toFixed(2)}° … ${Math.max(...gaps).toFixed(2)}°)`);
  const amplitudeRange = Math.max(...GODRAY_SPOKES.map(s => s.amp)) - Math.min(...GODRAY_SPOKES.map(s => s.amp));
  const amplitudeMean = GODRAY_SPOKES.reduce((sum, s) => sum + s.amp, 0) / GODRAY_SPOKES.length;
  check(amplitudeRange > 0.6, `brightness keeps retail-like dim gaps (range ${amplitudeRange.toFixed(3)})`);
  check(amplitudeMean > 0.52 && amplitudeMean < 0.56,
    `the original pattern keeps the retail table's measured mean (${amplitudeMean.toFixed(3)})`);
}

console.log('\n== interpolation between spokes ==');
check(near(spokeIntensityAt(0), GODRAY_SPOKES[0].amp), 'on a spoke, the spoke\'s own intensity');
check(near(spokeIntensityAt((GODRAY_SPOKES[1].deg * Math.PI) / 180), GODRAY_SPOKES[1].amp),
  'and on the next one');
{
  const midDeg = (GODRAY_SPOKES[0].deg + GODRAY_SPOKES[1].deg) / 2;
  const mid = spokeIntensityAt((midDeg * Math.PI) / 180);
  check(near(mid, (GODRAY_SPOKES[0].amp + GODRAY_SPOKES[1].amp) / 2),
    'between two spokes it interpolates rather than jumping');
  const wrapDeg = (GODRAY_SPOKES.at(-1)!.deg + 360) / 2;
  const wrapped = spokeIntensityAt((wrapDeg * Math.PI) / 180);
  check(wrapped > 0 && wrapped < 1, `the last→first wrap segment interpolates (${wrapped.toFixed(3)})`);
  check(near(spokeIntensityAt(2 * Math.PI), spokeIntensityAt(0)), 'the angle domain wraps cleanly at 2π');
}

console.log('\n== the fan: every ray reaches the border ==');
for (const sun of [{ x: 0, y: 0 }, { x: 0.6, y: -0.35 }, { x: -0.9, y: 0.9 }]) {
  const rim = buildGodRayRim(sun);
  check(rim.length === GODRAY_SPOKES.length + 4,
    `sun (${sun.x}, ${sun.y}): generated spokes + 4 corner splices = ${rim.length} rim vertices`);
  check(rim.every(onBorder), `sun (${sun.x}, ${sun.y}): every rim vertex lands on the screen border`);
  check(rim.every(v => v.x >= -1 - 1e-6 && v.x <= 1 + 1e-6 && v.y >= -1 - 1e-6 && v.y <= 1 + 1e-6),
    `sun (${sun.x}, ${sun.y}): and none overshoots outside it`);
  // atan2 returns (−π, π] while the rim is ordered over [0, 2π), so normalize before comparing or the
  // wrap at 0 reads as a break in ordering.
  const TAU = Math.PI * 2;
  const bearing = (v: { x: number; y: number }) =>
    ((Math.atan2(v.y - sun.y, v.x - sun.x) % TAU) + TAU) % TAU;
  let ordered = true;
  for (let i = 1; i < rim.length; i++) if (bearing(rim[i]) < bearing(rim[i - 1]) - 1e-9) ordered = false;
  check(ordered, `sun (${sun.x}, ${sun.y}): the rim stays in angular order, so the fan is convex and gapless`);
  // The four corners must be present, or the fan cuts across them.
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const;
  const hit = corners.filter(([gx, gy]) => rim.some(v => near(v.x, gx, 1e-6) && near(v.y, gy, 1e-6)));
  check(hit.length === 4, `sun (${sun.x}, ${sun.y}): all four screen corners are fan vertices (${hit.length}/4)`);
}

console.log('\n== the falloff is the engine\'s squared-distance law ==');
{
  const rim = buildGodRayRim({ x: 0, y: 0 });
  const C = GODRAY_LAW.falloffClamp;
  check(C === 3, 'the clamp is the engine\'s 3');
  let matched = true;
  for (const v of rim) {
    const d2 = v.x * v.x + v.y * v.y;
    const expected = spokeIntensityAt(Math.atan2(v.y, v.x)) * ((C - Math.min(d2, C)) / C);
    if (!near(v.amp, expected, 1e-6)) matched = false;
  }
  check(matched, 'every rim amplitude is spoke intensity × (C − min(d², C)) / C');
  // A ray leaving through an edge midpoint travels 1; one reaching a corner travels √2. Squared, that is
  // 1 vs 2 — so the corner ray is markedly dimmer even at equal authored intensity.
  const edge = (C - 1) / C;
  const corner = (C - 2) / C;
  check(edge > corner, `a corner-bound ray arrives dimmer than an edge-bound one (${corner.toFixed(3)} < ${edge.toFixed(3)})`);
  check(rim.every(v => v.amp >= 0), 'no amplitude goes negative');
}

console.log('\n== an off-centre sun still fills the view ==');
{
  // With the sun near a corner, most rays are short and bright and a few sweep the whole screen.
  const rim = buildGodRayRim({ x: 0.85, y: 0.85 });
  const spread = Math.max(...rim.map(v => v.amp)) - Math.min(...rim.map(v => v.amp));
  check(spread > 0.1, `ray brightness spreads with a corner sun (range ${spread.toFixed(3)}) — the falloff is doing work`);
  check(rim.every(onBorder), 'and the rays still all terminate on the border');
}

console.log('\n== the settings are MAP DATA, not constants in the source ==');
{
  // A course's glare arrives in its map folder (World.json, written by `snowknife import` from the course's
  // own world-configuration record) or on an authored mountain's document. Nothing here may know a course by
  // name: pinning that is what keeps a re-import authoritative instead of a table someone has to maintain.
  const source = readFileSync(new URL('../src/core/lighting/god-rays.ts', import.meta.url), 'utf8');
  for (const slot of ['ELYSIUM', 'MESA', 'ALOHA', 'PIPE', 'GARI', 'SNOW']) {
    check(!source.includes(slot), `the module names no course (${slot} absent)`);
  }
  check(!/\bRETAIL_/.test(source), 'and carries no retail table');
}

console.log('\n== normalizing a stored / loaded glare ==');
{
  const d = normalizeGodRayCourse(null);
  check(!d.enabled, 'nothing at all normalizes to a glare that is OFF - the safe default');
  check(d.core.length === 3 && d.rim.length === 3, 'and still carries a complete colour pair');
  const partial = normalizeGodRayCourse({ enabled: true, el: 2.5 });
  check(partial.enabled && partial.el === 2.5, 'a partial record keeps what it set');
  check(partial.az === DEFAULT_GODRAY_COURSE.az && partial.distance === DEFAULT_GODRAY_COURSE.distance
    && partial.fanIntensity === DEFAULT_GODRAY_COURSE.fanIntensity
    && partial.spriteIntensity === DEFAULT_GODRAY_COURSE.spriteIntensity,
  'and fills a newly-authored partial value from the complete authoring default');
  const junk = normalizeGodRayCourse({ core: ['x', 1, 2], az: NaN } as never);
  check(junk.core.every((v: number) => Number.isFinite(v)) && Number.isFinite(junk.az),
    'garbage in a stored field never reaches the renderer as NaN');
}

console.log('\n== metre-scale sun and stereo presentation ==');
{
  const course = normalizeGodRayCourse({ enabled: true, distance: 24000, size: 7200 });
  const ordinary = godRayPresentation(course, 4000);
  check(near(ordinary.distance, 240), 'the native 24000-unit sun distance becomes 240 scene metres');
  check(near(ordinary.sunRadius, 72), 'native SizeUnits is the radius, converted directly to 72 scene metres');
  check(near(ordinary.xrRayRadius, ordinary.distance * Math.tan(40 * Math.PI / 180)),
    'the XR fan keeps the shared 40-degree angular reach');

  const shallow = godRayPresentation(course, 100);
  check(near(shallow.distance, 90), 'a shallow far plane pulls the sun safely inside it');
  check(near(shallow.sunRadius / shallow.distance, ordinary.sunRadius / ordinary.distance),
    'far-plane clamping preserves the sun sprite angular size');
}

console.log('\n== the paused-Mesa GS transfer balance ==');
{
  // Live DMA: corona vertex RGBA 76/55/5/92, brightest fan centre RGBA 124/62/11/77.
  // The continuous form below ignores only that integer truncation. It preserves the important result:
  // the white textured corona saturates first, so the fan cannot leave a visible convergence point.
  const spriteIntensity = 0.721347332;
  const fanIntensity = 0.705450296;
  const brightestSpoke = 18 / 21;
  const corona = [153 / 255, 110 / 255, 10 / 255]
    .map(c => c * spriteIntensity * GODRAY_LAW.coronaDisplayGain);
  const fan = [248 / 255, 125 / 255, 23 / 255]
    .map(c => c * fanIntensity * brightestSpoke * GODRAY_LAW.fanDisplayGain);
  check(near(corona[0], 0.86223548, 1e-6) && near(fan[0], 0.29518951, 1e-6),
    `Mesa's continuous red contributions reproduce the packet scale (${corona[0].toFixed(3)} corona, ${fan[0].toFixed(3)} max fan)`);
  check(corona[0] > fan[0] * 2.8 && corona[1] > fan[1] * 4,
    'the corona dominates the brightest fan wedge enough to wash out its centre');
}

console.log('\n== desktop and WebXR choose different safe presentations ==');
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.03, 4000);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  const xrCamera = new THREE.ArrayCamera();
  const xr = { isPresenting: false, getCamera: () => xrCamera };
  const layer = createGodRayLayer({ scene, camera, renderer: { xr } } as never);
  layer.setCourse(normalizeGodRayCourse({
    enabled: true,
    core: [235, 97, 255], fanIntensity: 0.17093688,
    rim: [116, 83, 255], spriteIntensity: 0.3665579,
    distance: 24000, size: 7200,
  }));
  layer.setSunDirection(new THREE.Vector3(0, 0, -1));
  layer.sync();

  const desktop = scene.getObjectByName('sun-god-rays.desktop')!;
  const stereo = scene.getObjectByName('sun-god-rays.xr')!;
  const sun = scene.getObjectByName('sun-god-rays.sun')!;
  check(desktop.visible && !stereo.visible && sun.visible,
    'flat rendering keeps the exact screen-fill fan and now draws the authored sun sprite');
  const rayMaterial = (desktop as THREE.Mesh).material as THREE.ShaderMaterial;
  const sunMaterial = (sun as THREE.Mesh).material as THREE.ShaderMaterial;
  const expectedFan = new THREE.Color().setRGB(235 / 255, 97 / 255, 1);
  const expectedSprite = new THREE.Color().setRGB(116 / 255, 83 / 255, 1);
  check(near(rayMaterial.uniforms.fanIntensity.value, 0.17093688)
    && rayMaterial.uniforms.fanColor.value.equals(expectedFan)
    && near(rayMaterial.uniforms.displayGain.value, 128 / 255),
  'the fan uses raw CoreColour, recovered intensity and the GS 128/255 display gain');
  check(near(sunMaterial.uniforms.intensity.value, 0.3665579)
    && sunMaterial.uniforms.sunColor.value.equals(expectedSprite)
    && near(sunMaterial.uniforms.displayGain.value, 255 / 128),
  'the corona uses raw RimColour, recovered sprite intensity and the textured GS 255/128 gain');
  check(sunMaterial.fragmentShader.includes('1.0 - smoothstep(0.0, 1.0, r)')
    && !sunMaterial.fragmentShader.includes('fixedCore')
    && !sunMaterial.fragmentShader.includes('longSpokes'),
  'the celestial sprite is only the measured broad corona; dead core and neighbouring atlas star stay absent');
  check(!('coreBoost' in rayMaterial.uniforms) && !('rayStrength' in rayMaterial.uniforms),
    'no project-authored core bloom or global ray gain remains in the retail data path');

  const rig = new THREE.Group();
  rig.position.set(120, 35, -80);
  rig.add(camera);
  scene.add(rig);
  rig.updateMatrixWorld(true);
  const left = new THREE.PerspectiveCamera(55, 1, 0.03, 4000);
  const right = new THREE.PerspectiveCamera(55, 1, 0.03, 4000);
  left.matrix.makeTranslation(-0.032, 1.7, 0);
  right.matrix.makeTranslation(0.032, 1.7, 0);
  xrCamera.cameras = [left, right];
  xr.isPresenting = true;
  layer.sync();
  check(!desktop.visible && stereo.visible && sun.visible,
    'WebXR replaces the lens-fixed screen fill with one stereo-projected sky billboard plus the sun');

  layer.setCourse(null);
  layer.sync();
  check(!desktop.visible && !stereo.visible && !sun.visible,
    'a course with no enabled glare still draws neither rays nor a sun');
}

console.log('\n== the sun points where the course put it ==');
{
  // Two frame conversions stand between the game's authored azimuth and the scene: editorFromRaw's
  // (-x, z, -y), then worldRoot's Z mirror. Skipping either puts the sun exactly opposite - the one
  // failure mode that still LOOKS plausible (a sun, beams, wrong side of the sky), so it is pinned.
  const synthetic = sceneDirFromGlareAzEl(37, 11.25);
  const len = Math.hypot(synthetic[0], synthetic[1], synthetic[2]);
  check(near(len, 1, 1e-6), `the direction is a unit vector (${len.toFixed(6)})`);
  check(near(synthetic[1], Math.sin((11.25 * Math.PI) / 180), 1e-6),
    'elevation survives both conversions untouched - Y is sin(el)');

  // The bug this replaces: sunDirFromElAz measures azimuth in EDITOR space, so handing it the game's RAW
  // azimuth flips both horizontal axes. Assert the two really are opposite, so nobody "simplifies" back.
  const wrong = sunDirFromElAz(11.25, 37);
  check(near(synthetic[0], -wrong[0], 1e-6) && near(synthetic[2], wrong[2], 1e-6),
    'and it is NOT sunDirFromElAz - that convention lands the sun 180 deg away in the horizontal plane');

  // Elevation is the axis that decides whether the glare is visible from the course at all.
  for (const el of [0, 12.6325, 45]) {
    const d = sceneDirFromGlareAzEl(0, el);
    check(near(d[1], Math.sin((el * Math.PI) / 180), 1e-6), `el ${el} deg -> Y ${d[1].toFixed(4)}`);
  }
  check(sceneDirFromGlareAzEl(0, 90)[1] > 0.999, 'a 90 deg sun is straight up, not straight down');
}

console.log('\n== the export contract ==');
{
  // World.json is the SAME contract snowknife writes from a disc, so an authored course and an imported one
  // are read identically by the editor, by Unity and by a repack.
  const doc = defaultMountain();
  const off = buildMountainLevel(doc, [], { lighting: false }).text['World.json'];
  check(off === undefined, 'a mountain with no glare writes no World.json at all');

  doc.glare = normalizeGodRayCourse({
    enabled: true,
    core: [213, 144, 72], fanIntensity: 0.27,
    rim: [88, 55, 34], spriteIntensity: 0.43,
    az: 123.5, el: 11.25, distance: 24680, size: 7654,
  });
  const on = buildMountainLevel(doc, [], { lighting: false }).text['World.json'];
  check(typeof on === 'string', 'a mountain WITH a glare writes one');
  const parsed = JSON.parse(on as string);
  check(parsed.Schema === 'openslope-world/v1', `it declares the shared schema (${parsed.Schema})`);
  check(parsed.Glare.Enabled === true, 'the flag survives');
  check(JSON.stringify(parsed.Glare.CoreColour) === '[213,144,72]', 'colours go out as 0-255 integer triples');
  check(parsed.Glare.FanIntensity === 0.27 && parsed.Glare.SpriteIntensity === 0.43,
    'the independent fan and corona intensities go out unmodified');
  check(parsed.Glare.AzimuthDegrees === 123.5 && parsed.Glare.ElevationDegrees === 11.25,
    "the angles go out unrounded, in the game's own frame");
  check(parsed.Glare.DistanceUnits === 24680 && parsed.Glare.SizeUnits === 7654,
    'distance and size stay in map units, like every other exported number');
  const round = normalizeGodRayCourse({
    enabled: parsed.Glare.Enabled,
    core: parsed.Glare.CoreColour, fanIntensity: parsed.Glare.FanIntensity,
    rim: parsed.Glare.RimColour, spriteIntensity: parsed.Glare.SpriteIntensity,
    az: parsed.Glare.AzimuthDegrees, el: parsed.Glare.ElevationDegrees,
    distance: parsed.Glare.DistanceUnits, size: parsed.Glare.SizeUnits,
  });
  check(JSON.stringify(round) === JSON.stringify(doc.glare), 'and the file round-trips back to what was authored');
}

console.log(failures ? `\n${failures} FAILED` : '\nall god-ray checks passed');
process.exit(failures ? 1 : 0);
