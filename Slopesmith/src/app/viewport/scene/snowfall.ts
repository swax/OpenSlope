import * as THREE from 'three';
import {
  AMOUNT_PORT, BAKE_SEED, MAX_FLAKES, SNOWFLAKE_QUAD_CORNERS, SNOWFLAKE_QUAD_INDICES, bakeSnowFlakes,
  snowfallAt, type SnowfallSettings,
} from '../../../core/particles/snowfall';
import type { Stage } from '../stage';

/**
 * AMBIENT SNOWFALL — the drawing half. The law, the tuning and the bake live in `core/particles/snowfall.ts`,
 * shared with `test/snowfall.test.ts`; the engine model is [Trailmap: 400-rendering] ("Weather: ambient
 * snowfall") and the port's sibling is the VRChat world's ([Unity: 044-snowfall]).
 *
 * The whole subsystem is ONE static mesh and ONE vertex shader. Each flake's fall, drift, camera-centred
 * toroidal wrap and billboarding are evaluated from the elapsed time and the eye position, so a flake's
 * position is a pure function of those two: there is no particle system, no simulation state, and no per-frame
 * CPU work beyond writing two uniforms. That is what makes a field this dense affordable on a headset as well
 * as a desktop.
 *
 * The field is one **instanced** quad: a four-vertex unit square, and per flake nothing but its base point in
 * the unit box and its four randoms. It is baked once for the **heaviest** setting the dial reaches, and the
 * amount is applied as an `instanceCount` over it. The bake is a uniform random scatter, so its first N flakes
 * are a uniform scatter too — which means thinning the fall removes the vertex work along with the fill,
 * rather than sending culled flakes down the pipe to collapse at zero size. Everything else the amount
 * changes is a uniform.
 *
 * The per-instance data is FLAKE DATA, not geometry, so the object transform is meaningless here and the mesh
 * sits at scene root with the shader working directly in world space. `frustumCulled` is off for the same
 * reason: the shader teleports the flakes to the eye, and an AABB over a unit quad at the origin describes
 * nowhere the field is actually drawn.
 *
 * Every function in the GLSL below has a named twin in the core module. They are a pair; change both.
 */

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 flakeBase;     // per instance: the flake's base point in the unit box [0,1)^3
  attribute vec4 flakeRnd;      // per instance: randoms — x fall speed, y size, zw horizontal drift

  uniform vec3 eye;             // the render eye, in three-world coordinates
  uniform float time;           // seconds since the run began
  uniform vec3 box;
  uniform float lift;
  uniform vec2 fallRange;
  uniform float driftMax;
  uniform vec2 sizeRange;
  uniform vec2 nearFade;
  uniform float edgeFade;

  varying vec2 vUv;

  void main() {
    // Per-flake parameters from the baked randoms (core: flakeMotion).
    float fall = mix(fallRange.x, fallRange.y, flakeRnd.x);
    float size = mix(sizeRange.x, sizeRange.y, flakeRnd.y);
    vec2 drift = (flakeRnd.zw * 2.0 - 1.0) * driftMax;

    // World-fixed flake path: a pure function of time, no simulation state anywhere (core: flakePath).
    vec3 p = flakeBase * box;
    p.y -= fall * time;
    p.xz += drift * time;

    // The engine's cell recycle as a toroidal wrap about the lifted eye (core: boxCentre / wrapOffset). A
    // flake inside the box is UNTOUCHED — the ride-through parallax — and one off a face reappears on the
    // opposite one. The wrap takes the flake CENTRE, which all four corners share, so a quad never straddles
    // it; the corner offset goes on after the billboard basis is built.
    vec3 c = eye + vec3(0.0, lift, 0.0);
    vec3 off = (fract((p - c) / box + 0.5) - 0.5) * box;
    vec3 world = c + off;

    // Shrink to nothing over the outer band of the box (core: edgeFadeScale), so the wrap teleport always
    // happens to an invisible flake. At speed the leading face would otherwise pop flakes into view.
    vec3 edge = abs(off) / (box * 0.5);
    float e = max(edge.x, max(edge.y, edge.z));
    float fade = clamp((1.0 - e) / edgeFade, 0.0, 1.0);
    size *= fade * fade * (3.0 - 2.0 * fade);

    // ...and again just before a flake passes THROUGH the eye (core: nearFadeScale): an arm's-length flake is
    // an unfocusable full-screen flash, and the worst fill-rate case in the field. The band widens with the
    // flakes, so a blizzard's larger ones still leave the frame before they fill it.
    float dist = length(world - eye);
    size *= clamp((dist - nearFade.x) / max(nearFade.y - nearFade.x, 0.01), 0.0, 1.0);

    // Billboard facing the eye POSITION with world up (facing, not view-aligned: flakes must not roll when a
    // headset wearer tilts their head). Looking straight up or down degrades the cross toward zero length,
    // which merely shrinks the flake — graceful. No spin: the dot is radially symmetric, so a spin would be
    // invisible; swap in a textured star and it needs a per-flake UV rotation here.
    vec3 fwd = (eye - world) / max(dist, 0.001);
    vec3 axis = cross(vec3(0.0, 1.0, 0.0), fwd);
    vec3 right = axis / max(length(axis), 0.001);
    vec3 up = cross(fwd, right);
    world += (right * position.x + up * position.y) * size;   // position IS the shared quad's corner

    vUv = position.xy + 0.5;
    // viewMatrix, not modelViewMatrix: the attributes are flake data and the object transform means nothing.
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 tint;
  uniform float alpha;
  uniform float boost;
  uniform float softness;
  varying vec2 vUv;

  void main() {
    // A soft round dot: a smooth polynomial dome from the quad centre, with no hard edge at any size. The
    // engine draws the weather flake as the bank's str2 soft star, which at its on-screen size and the PS2's
    // bilinear filtering reads as a translucent blurry dot rather than a discernible flake, so the dome is
    // generated rather than sampled. Softness widens it; alpha reaches exactly 0 inside the quad, so the
    // border adds nothing at all to the frame.
    vec2 d = vUv - 0.5;
    float r2 = dot(d, d) * 4.0;                       // 0 at centre, 1 at the edge midpoints
    float f = clamp(1.0 - r2 / softness, 0.0, 1.0);
    // Additive with an alpha weight (src.rgb * src.a + dst), so a faint texel adds correspondingly little.
    gl_FragColor = vec4(tint * boost, alpha * f * f);
  }
`;

export function createSnowfallLayer(stage: Stage) {
  const flakes = bakeSnowFlakes(MAX_FLAKES, BAKE_SEED);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...SNOWFLAKE_QUAD_CORNERS], 3));
  geometry.setIndex([...SNOWFLAKE_QUAD_INDICES]);
  geometry.setAttribute('flakeBase', new THREE.InstancedBufferAttribute(flakes.base, 3));
  geometry.setAttribute('flakeRnd', new THREE.InstancedBufferAttribute(flakes.rnd, 4));

  const material = new THREE.ShaderMaterial({
    name: 'Ambient snowfall',
    uniforms: {
      eye: { value: new THREE.Vector3() },
      time: { value: 0 },
      box: { value: new THREE.Vector3() },
      lift: { value: 0 },
      fallRange: { value: new THREE.Vector2() },
      driftMax: { value: 0 },
      sizeRange: { value: new THREE.Vector2() },
      nearFade: { value: new THREE.Vector2() },
      edgeFade: { value: 0 },
      tint: { value: new THREE.Vector3(1, 1, 1) },
      alpha: { value: 0 },
      boost: { value: 0 },
      softness: { value: 0 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: true,    // snow behind a ridge is behind it; only the depth WRITE is wrong for a soft sprite
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,         // the flakes live inside the wrap box; the range gate's haze starts at 300 m
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;   // the attributes are flake data; their AABB describes nowhere the field draws
  mesh.raycast = () => { /* weather is never a pick target */ };
  mesh.renderOrder = 3000;      // over the world and its transparent props, under the screen-space glare (4000)
  mesh.visible = false;
  stage.scene.add(mesh);        // NOT worldRoot: the shader already works in three-world coordinates

  let amount = AMOUNT_PORT;   // the Test dial (docs/016), defaulting to the game's own weather
  let running = false;
  let elapsed = 0;

  /** Push a whole weather setting at the shader, and draw exactly the flakes it asks for. */
  function apply(s: SnowfallSettings) {
    const u = material.uniforms;
    (u.box.value as THREE.Vector3).set(s.box[0], s.box[1], s.box[2]);
    u.lift.value = s.lift;
    (u.fallRange.value as THREE.Vector2).set(s.fallMin, s.fallMax);
    u.driftMax.value = s.drift;
    (u.sizeRange.value as THREE.Vector2).set(s.sizeMin, s.sizeMax);
    (u.nearFade.value as THREE.Vector2).set(s.nearFadeStart, s.nearFadeEnd);
    u.edgeFade.value = s.edgeFade;
    u.alpha.value = s.alpha;
    u.boost.value = s.boost;
    u.softness.value = s.softness;
    geometry.instanceCount = s.flakes;   // a prefix of a uniform scatter is a uniform scatter: the amount IS the draw
  }
  apply(snowfallAt(amount));

  /**
   * Set how much snow is falling, 0 (clear) to `AMOUNT_MAX` (whiteout). Applied on the spot: the field is
   * stateless, so a dial dragged mid-run thickens the weather around the rider without restarting anything.
   */
  function setAmount(next: number) {
    amount = next;
    apply(snowfallAt(amount));
  }

  /**
   * Advance the field and seat it on this frame's eye. `active` is whether a ride is running — the snow is
   * weather in the world being ridden, not editor furniture, so it draws for a run and not for the editor
   * view that shapes the mountain.
   *
   * The clock runs for the whole run whether or not the flakes are drawn, so the dial can be moved mid-run
   * without a visible jump: a flake's position is a function of time, and turning the weather back up
   * therefore shows the snow where it would have been rather than resuming a frozen frame. It restarts with
   * each run, the way the engine builds its snowfall at course init — which also keeps the time a shader float
   * has to carry down to the length of one ride, instead of however long a browser tab has been open.
   *
   * The eye is passed in rather than read off the camera because in a headset ride the camera hangs off the
   * rig and its own position is head-relative. Both eyes share this one value, so the wrap cell can never
   * differ between them — which on a per-eye camera position it could, at a box face.
   */
  function sync(eye: THREE.Vector3, dt: number, active: boolean) {
    if (active && !running) elapsed = 0;
    running = active;
    if (active) elapsed += dt;
    const visible = amount > 0 && active;
    mesh.visible = visible;
    if (!visible) return;
    material.uniforms.time.value = elapsed;
    (material.uniforms.eye.value as THREE.Vector3).copy(eye);
  }

  return {
    setAmount, sync,
    get amount() { return amount; },
    get visible() { return mesh.visible; },
    /** How many flakes the current setting actually draws — the profiler's and the checks' honest number. */
    get flakes() { return geometry.instanceCount; },
    /** The live uniform block, so a check can read the tuning the shader is actually running on. */
    get uniforms() { return material.uniforms; },
  };
}

export type SnowfallLayer = ReturnType<typeof createSnowfallLayer>;
