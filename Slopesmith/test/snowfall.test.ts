// tier: fast

/**
 * Ambient snowfall: the weather field a ride is taken through (docs/050), ported from the VRChat world
 * ([Unity: 044-snowfall]) whose own subject is [Trailmap: 400-rendering], "Weather: ambient snowfall".
 * Run: npx tsx test/snowfall.test.ts
 *
 * What has to hold for this to be that effect rather than a snow globe strapped to the camera:
 *
 *  1. **The flakes are world-fixed.** Moving the eye must not move a flake. That single property is the
 *     ride-through parallax the spec is emphatic about, and it is what separates snow you pass from snow you
 *     tow along behind you.
 *  2. **...yet the box is always full.** However far and however fast the eye travels, every flake wraps into
 *     the box around it, in one step — nothing is left behind at board speed or after a respawn teleport.
 *  3. **The wrap is invisible.** A flake reaching a face has already shrunk to nothing, so the teleport that
 *     recycles it happens to something that is not on screen.
 *  4. **The dial's port stop is the Unity port, value for value,** so the two realizations are the same
 *     weather where they claim to be — and it climbs monotonically from clear to whiteout either side of it.
 *  5. **The GLSL is the law.** The motion runs on the GPU, so the CPU functions the checks above measure are
 *     only worth anything if the shader still spells them the same way.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  AMOUNT_MAX, AMOUNT_PORT, BAKE_SEED, MAX_FLAKES, SNOWFALL_BLIZZARD, SNOWFALL_PORT, SNOWFLAKE_QUAD_CORNERS,
  SNOWFLAKE_QUAD_INDICES, bakeSnowFlakes, boxCentre, edgeFadeScale, flakeMotion, flakePath, fract,
  nearFadeScale, snowfallAt, wrapFlake, wrapOffset,
} from '../src/core/particles/snowfall';
import { createSnowfallLayer } from '../src/app/viewport/scene/snowfall';
import type { Stage } from '../src/app/viewport/stage';
import type { V3 } from '../src/core/doc/types';
import { check, failures, near } from './check';

const port = SNOWFALL_PORT;
const half: V3 = [port.box[0] / 2, port.box[1] / 2, port.box[2] / 2];

console.log('== the dial\'s port stop is the Unity port\'s tuning ==');
{
  // The VRChat world's `Snowfield` material, value for value (Unity/VRC/Editor/SnowfallSetup.cs). Pinned
  // rather than approximated: a drift here and the two ports are quietly two different snowfalls.
  check(port.box[0] === 40 && port.box[1] === 34 && port.box[2] === 40, 'a 40 x 34 x 40 m wrap box');
  check(port.lift === 5, '...centred 5 m above the eye, so more of it is sky than ground');
  check(port.fallMin === 2.2 && port.fallMax === 4.0, 'falling at 2.2-4.0 m/s');
  check(port.drift === 0.7, 'with up to 0.7 m/s of horizontal drift');
  check(port.sizeMin === 0.1 && port.sizeMax === 0.3, 'flakes 0.10-0.30 m across');
  check(port.nearFadeStart === 0.25 && port.nearFadeEnd === 0.6, 'shrinking away between 0.25 m and 0.6 m of the eye');
  check(port.edgeFade === 0.2, 'and over the outer 20% of each half-extent');
  check(port.alpha === 0.5 && port.boost === 0.6 && port.softness === 0.55,
    'drawn faint: alpha 0.5, brightness 0.6, softness 0.55');
  check(port.flakes === 600, `600 flakes (got ${port.flakes})`);
  check(port.box[1] < port.box[0] && port.box[1] < port.box[2],
    'the box is flatter than it is wide — vertical extent is the axis you see least of');
  // The whole point of anchoring the dial: the stop labelled as the port must BE the port.
  const dialled = snowfallAt(AMOUNT_PORT);
  check(Object.keys(port).every(key => JSON.stringify((dialled as never)[key]) === JSON.stringify((port as never)[key])),
    `and dialling ${AMOUNT_PORT} reproduces every one of those values exactly`);
}

console.log('\n== the dial ==');
{
  check(snowfallAt(0).flakes === 0, '0 is a clear day — no flakes at all');
  check(snowfallAt(AMOUNT_MAX).flakes === SNOWFALL_BLIZZARD.flakes && MAX_FLAKES === SNOWFALL_BLIZZARD.flakes,
    `${AMOUNT_MAX} is the whole baked field (${MAX_FLAKES} flakes)`);
  check(snowfallAt(AMOUNT_MAX * 3).flakes === MAX_FLAKES && snowfallAt(-5).flakes === 0,
    'and a setting off either end of the dial is clamped to it');

  // Below the port stop the fall THINS and nothing else moves — the engine's own amount behaviour.
  const light = snowfallAt(AMOUNT_PORT / 2);
  check(light.flakes === Math.round(port.flakes / 2), 'half the port setting is half the flakes');
  check(light.box[0] === port.box[0] && light.fallMax === port.fallMax && light.sizeMax === port.sizeMax
    && light.alpha === port.alpha && light.drift === port.drift,
  '...and nothing else: a light dusting is the same snow, less of it');

  // Above it the weather itself changes — but only ever as MORE SNOW and MORE WIND.
  const storm = snowfallAt(AMOUNT_MAX);
  check(storm.flakes > port.flakes * 100, `far more flakes (${port.flakes} -> ${storm.flakes})`);
  check(storm.box[0] < port.box[0] && storm.box[1] < port.box[1], '...packed into a tighter box');
  const density = (s: typeof port) => s.flakes / (s.box[0] * s.box[1] * s.box[2]);
  check(density(storm) > density(port) * 500,
    `so the density goes up ${(density(storm) / density(port)).toFixed(0)}x, which is what a whiteout is`);
  check(storm.drift > port.drift * 10 && storm.fallMin > port.fallMax, 'driven nearly sideways, and falling faster');
  // THE FLAKES THEMSELVES NEVER CHANGE SIZE OR SHAPE. Growing them is the obvious way to fill a screen and
  // the wrong one: a flake that reads as a snowflake at the port stop reads as a paper plate at the top of
  // the dial, and the eye catches the size long before it catches the weather.
  check(storm.sizeMin === port.sizeMin && storm.sizeMax === port.sizeMax,
    'and the flakes are exactly the same size they always were — a blizzard is more snow, not bigger snow');
  check(storm.softness === port.softness && storm.nearFadeStart === port.nearFadeStart
    && storm.nearFadeEnd === port.nearFadeEnd && storm.edgeFade === port.edgeFade && storm.lift === port.lift,
  '...the same shape, the same fades, the same box lift');
  check(storm.alpha > port.alpha && storm.boost === port.boost,
    'only half a stop more opaque, and the brightness never moves — coverage whitens the view, or it reads '
    + 'as a filter over the lens');

  // Monotone the whole way up: dragging the slider must never make it snow less.
  let monotone = true;
  for (let a = 0; a <= AMOUNT_MAX * 10; a++) {
    const lower = snowfallAt(a / 10), upper = snowfallAt((a + 1) / 10);
    if (upper.flakes < lower.flakes || upper.alpha < lower.alpha || upper.box[0] > lower.box[0]) monotone = false;
  }
  check(monotone, 'and every step of the dial is heavier weather than the one below it');

  // Screen coverage behaves like optical depth: density x flake area x how far the field reaches. It is the
  // measure that says whether the top of the dial is actually a whiteout, and it is why the flakes have to be
  // packed rather than grown — the same number goes up either way, but only one of them still looks like snow.
  const coverage = (s: typeof port) => {
    const density = s.flakes / (s.box[0] * s.box[1] * s.box[2]);
    const area = Math.PI * (Math.sqrt(s.softness) / 2) ** 2;          // the visible dome inside the quad
    const meanSquare = (s.sizeMax ** 3 - s.sizeMin ** 3) / (3 * (s.sizeMax - s.sizeMin));
    return density * area * meanSquare * (s.box[0] / 2) * (1 - s.edgeFade);
  };
  check(coverage(port) < 0.01, `the port stop veils almost nothing (${(coverage(port) * 100).toFixed(1)}% coverage)`);
  check(coverage(storm) > 2, `and the top of the dial covers the view ${coverage(storm).toFixed(1)}x over — a whiteout`);
}

console.log('\n== the bake ==');
{
  const a = bakeSnowFlakes();
  const b = bakeSnowFlakes();
  check(a.count === MAX_FLAKES && a.base.length === MAX_FLAKES * 3 && a.rnd.length === MAX_FLAKES * 4,
    'the field is baked once at the heaviest setting, with a base point and four randoms each');
  check(a.base.every((v, i) => v === b.base[i]) && a.rnd.every((v, i) => v === b.rnd[i]),
    'a fixed seed bakes the identical field every run');
  const other = bakeSnowFlakes(MAX_FLAKES, BAKE_SEED + 1);
  check(!a.base.every((v, i) => v === other.base[i]), '...and a different seed a different one');
  check([...a.base, ...a.rnd].every(v => v >= 0 && v < 1), 'every baked value is in [0,1)');
  // The amount draws a PREFIX of this field, so a prefix of it has to be a uniform scatter in its own
  // right — otherwise a light fall would clump into whichever corner of the box got baked first.
  for (const prefix of [snowfallAt(1).flakes, port.flakes, snowfallAt(AMOUNT_MAX).flakes]) {
    let worst = 0;
    for (const axis of [0, 1, 2]) {
      let low = 0;
      for (let i = 0; i < prefix; i++) if (a.base[i * 3 + axis] < 0.5) low++;
      worst = Math.max(worst, Math.abs(low / prefix - 0.5));
    }
    check(worst < 0.08, `the first ${prefix} flakes still fill the box evenly (worst axis ${(worst * 100).toFixed(1)}% off)`);
  }
}

console.log('\n== the instanced contract the shader reads ==');
{
  // One shared quad, and per flake nothing but a base point and four randoms. At the port stop the layout
  // hardly matters; at a hundred thousand flakes a quad soup would upload ~17 MB against ~2.8 MB here.
  check(SNOWFLAKE_QUAD_CORNERS.length === 12 && SNOWFLAKE_QUAD_INDICES.length === 6,
    'the whole geometry is four vertices and two triangles, instanced once per flake');
  const corners = new Set<string>();
  for (let k = 0; k < 4; k++) corners.add(`${SNOWFLAKE_QUAD_CORNERS[k * 3]},${SNOWFLAKE_QUAD_CORNERS[k * 3 + 1]}`);
  check(corners.size === 4 && [...corners].every(c => c.split(',').every(v => Math.abs(Number(v)) === 0.5)),
    'its corners are the four of {-0.5,+0.5}^2, which double as the fragment falloff UV');
  check(SNOWFLAKE_QUAD_CORNERS.filter((_, i) => i % 3 === 2).every(z => z === 0),
    'and it is flat — the shader builds the billboard basis itself, so the quad carries no orientation');
  check([...SNOWFLAKE_QUAD_INDICES].every(i => i >= 0 && i < 4), 'every index addresses a vertex that exists');
  const bytesPerFlake = (3 + 4) * 4;
  check(bytesPerFlake === 28,
    `each flake costs ${bytesPerFlake} bytes of buffer, so the whole baked field is `
    + `${(MAX_FLAKES * bytesPerFlake / 1e6).toFixed(1)} MB`);
}

console.log('\n== the flakes are world-fixed: the ride-through parallax ==');
{
  const flakes = bakeSnowFlakes(64, 11);
  const at = (i: number): V3 => [flakes.base[i * 3], flakes.base[i * 3 + 1], flakes.base[i * 3 + 2]];
  const t = 3.5;
  // A flake mid-box, and an eye that moves a metre. Nothing about the flake may move.
  const eyeA: V3 = [0, 0, 0];
  const eyeB: V3 = [1, 0, 0.5];
  let moved = 0, sampled = 0;
  for (let i = 0; i < flakes.count; i++) {
    const p = flakePath(at(i), flakes.rnd.subarray(i * 4, i * 4 + 4), t, port);
    const a = wrapFlake(p, boxCentre(eyeA, port), port);
    const b = wrapFlake(p, boxCentre(eyeB, port), port);
    // Only the flakes that did not cross a face between the two eyes: the rest ARE the recycle, checked below.
    const jumped = Math.abs(a[0] - b[0]) > half[0] || Math.abs(a[1] - b[1]) > half[1] || Math.abs(a[2] - b[2]) > half[2];
    if (jumped) continue;
    sampled++;
    if (!near(a[0], b[0], 1e-4) || !near(a[1], b[1], 1e-4) || !near(a[2], b[2], 1e-4)) moved++;
  }
  check(sampled > 50 && moved === 0,
    `moving the eye leaves every un-recycled flake exactly where it was (${sampled} sampled, ${moved} moved)`);

  // ...and the flakes DO fall, at the speeds the setting names.
  const m = flakeMotion(flakes.rnd, port, 0);
  const p0 = flakePath(at(0), flakes.rnd.subarray(0, 4), 0, port);
  const p1 = flakePath(at(0), flakes.rnd.subarray(0, 4), 1, port);
  check(near(p0[1] - p1[1], m.fall) && m.fall >= port.fallMin && m.fall <= port.fallMax,
    `a flake falls at its own speed in the band (${m.fall.toFixed(2)} m/s)`);
  check(Math.abs(m.drift[0]) <= port.drift && Math.abs(m.drift[1]) <= port.drift && near(p1[0] - p0[0], m.drift[0]),
    'and drifts sideways within the cap');
  check(m.size >= port.sizeMin && m.size <= port.sizeMax, 'at its own size in the band');
}

console.log('\n== ...yet the box is always full: the recycle ==');
{
  const flakes = bakeSnowFlakes(MAX_FLAKES, BAKE_SEED);
  // Eyes an ordinary run reaches and two it never should: a full-speed descent, and a respawn teleport. Run
  // at both ends of the dial, since the box the fold works in is itself one of the things the dial moves.
  const eyes: V3[] = [[0, 0, 0], [37, -210, 88], [-4000, 900, 12000], [1e6, -1e6, 1e6]];
  let outside = 0;
  for (const settings of [port, SNOWFALL_BLIZZARD]) {
    const bound = settings.box.map(v => v / 2);
    for (const eye of eyes) {
      const centre = boxCentre(eye, settings);
      for (const t of [0, 7.5, 600]) {
        for (let i = 0; i < settings.flakes; i++) {
          const p = flakePath([flakes.base[i * 3], flakes.base[i * 3 + 1], flakes.base[i * 3 + 2]],
            flakes.rnd.subarray(i * 4, i * 4 + 4), t, settings);
          const off = wrapOffset(p, centre, settings);
          for (const axis of [0, 1, 2]) if (Math.abs(off[axis]) > bound[axis] + 1e-6) outside++;
        }
      }
    }
  }
  check(outside === 0, 'every flake wraps into the box around the eye — at any speed, from anywhere, in ONE step');

  // The wrap is a fold, not a clamp: a flake pushed one full box past a face lands back where it started.
  const p: V3 = [3, 2, -5];
  const centre: V3 = [0, 0, 0];
  const a = wrapOffset(p, centre, port);
  const b = wrapOffset([p[0] + port.box[0], p[1] - port.box[1], p[2] + 2 * port.box[2]], centre, port);
  check(near(a[0], b[0], 1e-4) && near(a[1], b[1], 1e-4) && near(a[2], b[2], 1e-4),
    'and the field is periodic in the box: a whole-box shift is no shift at all');
  check(near(fract(-0.25), 0.75) && near(fract(2.5), 0.5), 'fract() folds negatives the way GLSL does');
}

console.log('\n== the wrap is invisible ==');
{
  check(near(edgeFadeScale([0, 0, 0], port), 1), 'a flake through the middle of the box is full size');
  for (const axis of [0, 1, 2]) {
    const face: V3 = [0, 0, 0];
    face[axis] = half[axis];
    check(near(edgeFadeScale(face, port), 0), `...and exactly zero at the ${'xyz'[axis]} face, where it teleports`);
    const inside: V3 = [0, 0, 0];
    inside[axis] = half[axis] * (1 - port.edgeFade * 0.5);
    const s = edgeFadeScale(inside, port);
    check(s > 0 && s < 1, `shrinking smoothly through the band before it (${s.toFixed(3)})`);
  }
  // Monotone across the band: a flake sliding toward a face may only get smaller, never flicker.
  let monotone = true, last = 1;
  for (let k = 0; k <= 40; k++) {
    const s = edgeFadeScale([0, (half[1] * k) / 40, 0], port);
    if (s > last + 1e-9) monotone = false;
    last = s;
  }
  check(monotone, 'and it only ever shrinks on the way out — no flicker at the boundary');

  check(near(nearFadeScale(0, port), 0) && near(nearFadeScale(port.nearFadeStart, port), 0),
    'a flake about to pass through the eye is gone before it arrives');
  check(near(nearFadeScale(port.nearFadeEnd, port), 1) && near(nearFadeScale(50, port), 1),
    '...and full size once it is far enough to look at');
}

console.log('\n== the layer draws it ==');
{
  // The layer only ever touches `stage.scene`, so a bare scene is the whole stage it needs — no WebGL context,
  // no canvas, and therefore a check that runs anywhere the rest of the suite does.
  const scene = new THREE.Scene();
  const layer = createSnowfallLayer({ scene } as unknown as Stage);
  const mesh = scene.children.find((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh);
  check(!!mesh, 'the field is added to the scene root, not the chirality-flipped world root');
  const geometry = mesh!.geometry as THREE.InstancedBufferGeometry;
  check(geometry.isInstancedBufferGeometry && geometry.getAttribute('position').count === 4
    && geometry.getIndex()!.count === 6 && geometry.getAttribute('flakeBase').count === MAX_FLAKES
    && geometry.getAttribute('flakeRnd').count === MAX_FLAKES,
  'carrying the instanced contract: one shared quad, the whole baked field uploaded once behind it');
  check(mesh!.frustumCulled === false,
    'never frustum-culled — the shader teleports the flakes, so the attributes bound nothing meaningful');
  const material = mesh!.material as THREE.ShaderMaterial;
  check(material.blending === THREE.AdditiveBlending && material.depthWrite === false && material.depthTest,
    'drawn additively, depth-tested but not depth-writing (behind a ridge is behind it)');

  const uniforms = layer.uniforms;
  check(layer.amount === AMOUNT_PORT && layer.flakes === port.flakes,
    `a fresh layer is already at the game's own weather (${AMOUNT_PORT} on the dial)`);
  check((uniforms.box.value as THREE.Vector3).x === port.box[0] && uniforms.lift.value === port.lift
    && (uniforms.fallRange.value as THREE.Vector2).y === port.fallMax && uniforms.alpha.value === port.alpha
    && uniforms.edgeFade.value === port.edgeFade,
  'and the shader runs on the same settings the checks above measure');

  layer.setAmount(AMOUNT_MAX);
  check(layer.flakes === MAX_FLAKES && (uniforms.alpha.value as number) === SNOWFALL_BLIZZARD.alpha,
    'dialling it up draws the whole field and pushes the blizzard settings at the shader');
  layer.setAmount(1);
  check(layer.flakes === snowfallAt(1).flakes && layer.flakes < port.flakes,
    'and dialling it down DRAWS FEWER rather than sending culled flakes down the pipe to collapse');
  layer.setAmount(AMOUNT_PORT);

  const eye = new THREE.Vector3(10, 20, 30);
  layer.sync(eye, 1 / 60, false);
  check(!layer.visible, 'no weather over the editor view');
  layer.sync(eye, 1 / 60, true);
  check(layer.visible && (uniforms.eye.value as THREE.Vector3).equals(eye), 'a run rides through it, around the eye');
  layer.setAmount(0);
  layer.sync(eye, 1 / 60, true);
  check(!layer.visible, 'and a clear day draws nothing at all, mid-run');

  // Statelessness, the property that makes the dial exact: the run's clock does not stop while the weather is
  // clear, so turning it back up shows the snow where it would have been rather than where it stopped.
  const parked = uniforms.time.value as number;
  for (let i = 0; i < 60; i++) layer.sync(eye, 1 / 60, true);
  layer.setAmount(AMOUNT_PORT);
  layer.sync(eye, 1 / 60, true);
  check((uniforms.time.value as number) > parked + 0.9,
    'the clock keeps running while the dial is at zero — turning it back up is not a resume');

  // ...but each RUN starts the weather fresh, the way the engine builds its snowfall at course init. That is
  // also what keeps the elapsed time a shader float carries down to one ride rather than one browser session.
  layer.sync(eye, 1 / 60, false);
  layer.sync(eye, 1 / 60, true);
  check((uniforms.time.value as number) < 0.05, 'and a new run restarts it');
}

console.log('\n== the GLSL is the law ==');
{
  // The motion runs on the GPU; the CPU functions above are its specification. Pin the two together, so a
  // change to one that is not made to the other fails here rather than silently unpinning every check above.
  const source = readFileSync(new URL('../src/app/viewport/scene/snowfall.ts', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  const has = (glsl: string) => source.includes(glsl);
  check(has('vec3 off = (fract((p - c) / box + 0.5) - 0.5) * box;'),
    'the wrap is the same fold the parallax and recycle checks measure');
  check(has('vec3 c = eye + vec3(0.0, lift, 0.0);'), 'about the same lifted eye');
  check(has('p.y -= fall * time;') && has('p.xz += drift * time;'),
    'the path is the same pure function of time — no simulation state on either side');
  check(has('size *= fade * fade * (3.0 - 2.0 * fade);'), 'the edge fade is the same smoothstep');
  check(has('vec3 axis = cross(vec3(0.0, 1.0, 0.0), fwd);'),
    'billboarding faces the eye POSITION with world up, so a tilted head cannot roll the flakes');
  check(has('vec3 p = flakeBase * box;'), 'the path starts from the per-INSTANCE base point');
  check(!/\bstep\(\s*flakeKeep/.test(source),
    'and no per-flake keep test survives in the shader — the amount is the instance count now');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
