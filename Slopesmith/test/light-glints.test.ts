// tier: fast

/**
 * Light glints (docs/047): the engine's runtime sparkle on a glow light, ported from the Unity realization
 * ([Unity: 045-flares]). Run: tsx test/light-glints.test.ts
 *
 * Three things have to hold for the port to be the same effect in all three places — the editor viewport,
 * the Unity import, and a repacked disc:
 *
 *  1. **The gate is the engine's**, `SpriteRes & 0x70`. A light glints because its glow-sprite resolution is
 *     a small class (16/32/64) and for no other reason — not its name, not its type, not its brightness.
 *  2. **The colour law is Euclidean.** Every glint draws at one brightness, so a light's authored peak never
 *     reaches its sparkle; only hue and size class vary. A saturated hue keeps a full-strength channel while
 *     a white light sits at 0.577.
 *  3. **`SpriteRes` is the carrier.** An authored glint has to leave the editor in the one field Snowknife's
 *     `BuildLightGlows` and the PBD light chunk both read, or the sparkle stops at the editor's own viewport.
 */
import * as THREE from 'three';
import { DEFAULT_SUN, type AuthoredLight, type QuadMeshDoc } from '../src/core/doc/types';
import { defaultMountain } from '../src/core/doc/mountain';
import { buildMountainLevel } from '../src/core/export/level';
import { authoredFreeLights, authoredRig } from '../src/core/lighting/sign-lights';
import { GLINT_LAW, GLINT_SPARKLE_M, glintHue, glintSizeClass, glints, rigGlints } from '../src/core/lighting/glints';
import { decodeLightRig, type RawRigLight } from '../src/core/reference/lights';
import { GLINT_VERTEX_SHADER, averageStereoMatrices } from '../src/app/viewport/scene/glints';
import { check, failures } from './check';

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

console.log('== the gate is the engine\'s own: spriteRes & 0x70 ==');
check(!glints(0) && !glints(undefined), 'no resolution (an ordinary light) never glints');
check(glints(16) && glints(32) && glints(64), 'the small classes 16 / 32 / 64 glint');
check(!glints(256) && !glints(512), 'the large classes never glint — a level using only those ships zero glints');
check(glints(0x70) && glintSizeClass(0x70) === 0,
  'a resolution passing the mask but naming no single class is admitted by the gate yet has no size class of its own');
check(glintSizeClass(33) === 32, 'the class is the masked resolution, so stray low bits do not invent a new size');
check(glintSizeClass(256) === 0 && glintSizeClass(-1) === 0, 'anything the gate rejects means "no glint"');

console.log('\n== the colour law: Euclidean, so hue survives and the authored peak does not ==');
{
  const red = glintHue([1, 0, 0]);
  const white = glintHue([1, 1, 1]);
  check(near(red[0], 1) && near(red[1], 0), 'a saturated hue keeps a full-strength channel');
  check(near(white[0], 0.5774) && near(white[1], 0.5774), 'a white light sits at 0.577 — dimmer, per the law');
  const dimWhite = glintHue([0.25, 0.25, 0.25]);
  check(near(dimWhite[0], white[0]), 'the authored peak divides out: a dim white glints exactly as a bright one');
  check(glintHue([0, 0, 0]).every(c => c === 0), 'a black light yields no colour rather than a divide-by-zero');
}

console.log('\n== WebXR stereo: one halo bloom, eye-specific spike rotation ==');
{
  // Parallel eyes see a nearby off-axis light at different screen X. Unity averages the two complete
  // view-projections for the halo law; the browser must form the same cyclopean matrix rather than selecting
  // either eye. The asymmetric translations stand in for a 64 mm IPD.
  const projection = new THREE.Matrix4().makePerspective(-0.5, 0.5, 0.5, -0.5, 0.5, 100);
  const leftVp = projection.clone().multiply(new THREE.Matrix4().makeTranslation(0.032, 0, 0));
  const rightVp = projection.clone().multiply(new THREE.Matrix4().makeTranslation(-0.032, 0, 0));
  const cyclopeanVp = averageStereoMatrices(new THREE.Matrix4(), leftVp, rightVp);
  const light = new THREE.Vector4(1.2, 0.1, -5, 1);
  const ndcX = (matrix: THREE.Matrix4) => {
    const clip = light.clone().applyMatrix4(matrix);
    return clip.x / clip.w;
  };
  const leftX = ndcX(leftVp), rightX = ndcX(rightVp), bloomX = ndcX(cyclopeanVp);
  check(!near(leftX, rightX), 'the two eyes retain distinct projected X positions for the spiky glint');
  check(near(bloomX, (leftX + rightX) * 0.5),
    'the averaged stereo matrix gives both eye draws one cyclopean halo position');
  check(GLINT_VERTEX_SHADER.includes('length(ndcBloom)')
    && GLINT_VERTEX_SHADER.includes('vFade.y = -1.5707963 * ndcEye.x * twinkle'),
  'the shader sizes bloom from cyclopean NDC while rotating spikes from per-eye NDC');
}

console.log('\n== a rig becomes glints: only the gated lights, at their own size and pull ==');
{
  const lights: AuthoredLight[] = [
    { id: 'a', kind: 'point', pos: [0, 10, 0], color: '#ff0000', intensity: 1, reach: 40, glint: 32 },
    { id: 'b', kind: 'point', pos: [5, 10, 0], color: '#ffffff', intensity: 5700, reach: 40 },        // no glint
    { id: 'c', kind: 'spot', pos: [9, 10, 0], color: '#00ff00', intensity: 1, reach: 40, glint: 64 },
    { id: 'd', kind: 'point', pos: [12, 10, 0], color: '#0000ff', intensity: 1, reach: 40, glint: 16 },
  ];
  const list = rigGlints(authoredRig(authoredFreeLights(lights)));
  check(list.length === 3, `only the gated lights draw (${list.length} of ${lights.length})`);

  const medium = list.find(g => g.sizeClass === 32)!;
  const large = list.find(g => g.sizeClass === 64)!;
  const small = list.find(g => g.sizeClass === 16)!;
  // The quad carries the AURA — the game's second, larger same-hue glow — so it spans sparkle x aura.
  check(near(medium.quadM, GLINT_SPARKLE_M * GLINT_LAW.auraScale),
    `a res-32 sparkle is ${GLINT_SPARKLE_M} m across (quad ${medium.quadM.toFixed(2)} m with its aura)`);
  check(near(large.quadM, medium.quadM * 2) && near(small.quadM, medium.quadM * 0.5),
    'the size classes scale by res / 32');
  check(near(large.nudgeM, 8) && near(medium.nudgeM, 5) && near(small.nudgeM, 3),
    'the camera-ward pull is the engine\'s per-class 3 / 5 / 8 m');
  check(near(medium.hue[0], 1) && near(medium.hue[1], 0), 'each glint keeps its own light\'s hue');
  check(list.every(g => g.pos !== undefined), 'a glint is anchored on its light\'s own position');
  check(rigGlints(null).length === 0, 'no rig means no glints');
}

console.log('\n== a subtractive shadow light draws nothing (a black additive sprite is invisible anyway) ==');
{
  const raw = (over: Partial<RawRigLight>): RawRigLight => ({
    name: 'L', type: 2, colour: [1, 1, 1], dir: [0, 0, -1], pos: [0, 0, 0],
    lo: [-100, -100, -100], hi: [100, 100, 100], cone: 1, ...over,
  });
  const rig = decodeLightRig({
    level: 'TEST',
    lights: [
      raw({ name: 'lamp', spriteRes: 32 }),
      raw({ name: 'shadow', colour: [-1, -1, -1], spriteRes: 32 }),
      raw({ name: 'plain', spriteRes: 256 }),
    ],
  });
  check(rig.lights.every(l => l.spriteRes !== undefined),
    'the decoded rig carries each record\'s SpriteRes through from the server trim');
  const list = rigGlints(rig);
  check(list.length === 1 && list[0].name === 'lamp',
    `only the gated, additive light glints (${list.map(g => g.name).join(', ') || 'none'})`);
}

console.log('\n== SpriteRes carries an authored glint out of the editor ==');
{
  const doc: QuadMeshDoc = { ...defaultMountain(), sun: { ...DEFAULT_SUN, on: false } };
  doc.lights = [
    { id: 'a', name: 'flare', kind: 'point', pos: [0, 20, 0], color: '#ff2200', intensity: 2, reach: 40, glint: 32 },
    { id: 'b', name: 'plain', kind: 'point', pos: [20, 20, 0], color: '#ffffff', intensity: 1, reach: 40 },
  ];
  // `Lights.json` is written by the lighting pass, so this one runs the bake — with the sun off, which keeps
  // it cheap and leaves the light records (the point of the check) untouched.
  const files = buildMountainLevel(doc, authoredFreeLights(doc.lights));
  const written = JSON.parse(files.text['Lights.json']) as { Lights: { LightName: string; SpriteRes: number }[] };
  const byName = new Map(written.Lights.map(l => [l.LightName, l.SpriteRes]));
  check(byName.get('flare') === 32, `the glinting light exports SpriteRes 32 (got ${byName.get('flare')})`);
  check(byName.get('plain') === 0, 'a light with no glint exports 0 — Snowknife\'s gate then skips it');
  check(byName.get('Slopesmith Sun') === 0 && byName.get('Slopesmith Ambient') === 0,
    'the sun and sky ambient never glint');
  // What the far end actually does with the field, so this pin fails if the gate is ever written wrong.
  const gated = written.Lights.filter(l => (l.SpriteRes & 0x70) !== 0).map(l => l.LightName);
  check(gated.length === 1 && gated[0] === 'flare',
    `Snowknife's BuildLightGlows would bundle exactly the authored glint (${gated.join(', ') || 'none'})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall light-glint checks passed');
process.exit(failures ? 1 : 0);
