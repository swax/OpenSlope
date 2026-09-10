import * as THREE from 'three';
import { renderLoadingManager } from '../render-assets';
import { GLINT_LAW, rigGlints, type Glint } from '../../../core/lighting/glints';
import type { LightRig } from '../../../core/reference/lights';
import { particleTextureUrl } from '../../net/asset-paths';
import type { Stage } from '../stage';

/** Unity's VR glint shader forms its cyclopean projection by averaging the left/right view-projection
 *  matrices element-by-element. Keep the browser operation explicit and testable: multiplying a world point
 *  by this matrix produces one shared screen position for laws that must not disagree between the eyes. */
export function averageStereoMatrices(
  target: THREE.Matrix4,
  left: THREE.Matrix4,
  right: THREE.Matrix4,
): THREE.Matrix4 {
  const out = target.elements;
  const a = left.elements;
  const b = right.elements;
  for (let i = 0; i < 16; i++) out[i] = (a[i] + b[i]) * 0.5;
  return target;
}

/** Kept as a named contract so the stereo split can be pinned without constructing a WebGL renderer in the
 *  unit suite. `ndcBloom` sizes the whole halo from one cyclopean projection; `ndcEye` intentionally keeps
 *  the spiky star's rotation different for each eye, matching Unity's FlareHalo shader. */
export const GLINT_VERTEX_SHADER = `
  attribute vec3 glintPos;
  attribute vec3 glintHue;
  attribute float glintSize;    // drawn quad diameter (m) — the sparkle x the aura
  attribute float glintNudge;   // metres to pull toward the camera (the engine's per-class depth pull)
  uniform float halfViewportHeight;
  uniform float minPixels;
  uniform float centerBoost;
  uniform float twinkle;
  uniform float glintRange;
  uniform mat4 cyclopeanViewProjection;
  uniform float useCyclopeanBloom;
  varying vec2 vUv;
  varying vec3 vHue;
  varying vec2 vFade;           // x = range fade, y = spike-star angle (the screen-x law)
  void main() {
    vUv = uv;
    vHue = glintHue;
    vec4 centerView = modelViewMatrix * vec4(glintPos, 1.0);
    // An orthographic view has no depth term and carries its zoom in the same projection element, so both
    // projections size a metre identically (as the effects particle shader does).
    bool perspective = projectionMatrix[2][3] == -1.0;
    float depth = perspective ? max(0.001, -centerView.z) : 1.0;
    vec4 centerClipEye = projectionMatrix * centerView;
    vec2 ndcEye = centerClipEye.xy / max(1e-4, abs(centerClipEye.w));

    // Unity's stereo split: halo bloom is sized from ONE cyclopean screen position, while the star rotation
    // below keeps the current eye's screen X. modelMatrix is needed because each instanced glint position is
    // local to the authored/reference root, whereas the shared stereo matrix transforms world positions.
    vec2 ndcBloom = ndcEye;
    if (useCyclopeanBloom > 0.5) {
      vec4 centerClipBloom = cyclopeanViewProjection * modelMatrix * vec4(glintPos, 1.0);
      ndcBloom = centerClipBloom.xy / max(1e-4, abs(centerClipBloom.w));
    }
    // Centre bloom: centredness is 1 at the middle of the view and 0 at a corner; the 4th power makes it
    // the engine's tight centre-weighted lobe.
    float centred = clamp((1.41421 - length(ndcBloom)) * 0.70711, 0.0, 1.0);
    centred *= centred; centred *= centred;
    float grow = 1.0 + centerBoost * centred;
    // ...but never below the engine's constant pixel core, so a distant lamp keeps a visible glint.
    float pixelsPerMetre = projectionMatrix[1][1] * halfViewportHeight / depth;
    grow = max(grow, minPixels / max(1e-4, glintSize * pixelsPerMetre));
    vec3 viewPos = centerView.xyz + vec3(position.xy * glintSize * grow, 0.0);
    // Escape the fixture housing the light: scale the WHOLE quad along the view ray. A uniform scale of a
    // view-space point leaves x/w and y/w untouched under the perspective divide, so only depth moves.
    if (perspective) viewPos *= 1.0 - min(glintNudge, depth * 0.5) / depth;
    gl_Position = projectionMatrix * vec4(viewPos, 1.0);
    vFade.x = glintRange > 0.0 ? clamp((glintRange - depth) / (0.5 * glintRange), 0.0, 1.0) : 1.0;
    vFade.y = -1.5707963 * ndcEye.x * twinkle;
  }
`;

/**
 * LIGHT GLINTS (docs/047) — the game's runtime sparkle on a glow light: the authored `lens` halo ring, bright
 * core and many-spiked twinkle star that a level's street lamps and course flares carry
 * ([Trailmap: 160-lighting-data], the runtime glint section). This is the browser half of the port from Unity's
 * `OpenSlope/FlareHalo` shader ([Unity: 045-flares]); `core/lighting/glints.ts` is the data half (which lights
 * glint, at what colour and size) and is shared by both.
 *
 * One camera-facing quad per glint, instanced — the whole rig is a single draw call, and since the engine's
 * glint has NO time term (everything it does is a function of the light's screen position and depth) the layer
 * has no animation step. Desktop updates only the viewport-height uniform; WebXR additionally refreshes one
 * shared cyclopean matrix. Two clouds: the authored rig under `worldRoot` and the loaded reference's under
 * `refRoot`, so a dragged comparison offset carries its own glints.
 *
 * The engine's laws, all in the vertex/fragment shader as in Unity:
 *  - **World-anchored with a pixel floor.** A res-32 sparkle is ~1.5 m across and grows by plain perspective as
 *    you approach, but never shrinks below a fixed pixel size, so a far street lamp keeps a tiny constant glint.
 *  - **Screen-centre bloom.** Size × (1 + centredness⁴): glints grow when looked at dead-on. In stereo the
 *    centredness is cyclopean (one averaged left/right view-projection), so the halo is the same size in both
 *    eyes instead of fighting binocular fusion.
 *  - **Screen-x rotation.** The spike star's angle is −90° × the glint's NDC x — the sparkle turns as you ride
 *    past it. There is no time-based spin in the engine.
 *  - **Range fade.** Alpha holds to half the draw range, then fades linearly to zero at the range.
 *  - **The camera-ward pull.** The sprite draws at the depth of a point pulled 3/5/8 m toward the camera per
 *    size class, so the halo lays OVER the fixture housing its own light instead of cutting into it. Scaling
 *    the whole view-space quad by the pull factor leaves its projected position and size untouched and changes
 *    only its depth — the game projects the true position and takes only the depth from the pulled point.
 *
 * Occlusion here is the depth test plus that pull — Unity's `LightGlowFade`-off path. The console's graceful
 * source-visibility fade needs per-glint line-of-sight tests against the terrain; see docs/047 ▸ Next.
 */
export function createGlintLayer(stage: Stage) {
  /** The authored PARTICLE.SSH glint atlas: a 2×2 quadrant sheet whose ALPHA carries the three sparkle
   *  elements — halo ring (top-left), bright core (top-right), spiked twinkle star (bottom-left). It is the
   *  same shared sprite bank in every extracted level, so it loads once with no level preference. */
  const hasAtlas = { value: 0 };   // the uniform itself, so the load callback needs nothing else in scope
  const atlas = new THREE.TextureLoader(renderLoadingManager).load(particleTextureUrl('lens.png', ''),
    () => { hasAtlas.value = 1; },
    undefined,
    () => { /* no extracted bank on this install — the procedural blob below stands in */ });
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.generateMipmaps = true;                       // the halo ring samples a blurrier mip for a soft rim
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;

  const cyclopeanViewProjection = { value: new THREE.Matrix4() };
  const useCyclopeanBloom = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      glintAtlas: { value: atlas },
      hasAtlas,
      halfViewportHeight: { value: 500 },
      alpha: { value: GLINT_LAW.alpha },
      streak: { value: GLINT_LAW.streak },
      twinkle: { value: GLINT_LAW.twinkle },
      ringStrength: { value: GLINT_LAW.ring },
      hot: { value: GLINT_LAW.hot },
      auraScale: { value: GLINT_LAW.auraScale },
      auraAlpha: { value: GLINT_LAW.auraAlpha },
      power: { value: GLINT_LAW.power },
      glintRange: { value: GLINT_LAW.rangeM },
      centerBoost: { value: GLINT_LAW.centerBoost },
      cyclopeanViewProjection,
      useCyclopeanBloom,
      // The fixed-pixel floor is authored on the SPARKLE; the drawn quad is `aura` times bigger than it.
      minPixels: { value: GLINT_LAW.minPixels * GLINT_LAW.auraScale },
    },
    vertexShader: GLINT_VERTEX_SHADER,
    fragmentShader: `
      uniform sampler2D glintAtlas;
      uniform float hasAtlas;
      uniform float alpha, streak, ringStrength, hot, auraScale, auraAlpha, power;
      varying vec2 vUv;
      varying vec3 vHue;
      varying vec2 vFade;

      // One atlas element: d = quad-local coords (-0.5..0.5), scale = the element's size relative to the
      // quad, quadrant = its origin in UV space. Outside the element -> 0.
      float element(vec2 d, float scale, vec2 quadrant, float bias) {
        vec2 q = d / scale;
        vec2 inside = step(abs(q), vec2(0.5));
        return texture2D(glintAtlas, (q + 0.5) * 0.5 + quadrant, bias).a * inside.x * inside.y;
      }

      void main() {
        vec2 d = vUv - 0.5;
        float a; float white = 0.0;
        if (hasAtlas > 0.5) {
          // The three layered elements: the halo RING full-size (soft-rimmed off a blurrier mip), the bright
          // CORE at about half, and the many-spiked TWINKLE star slightly oversized and turned by the screen-x
          // law. They occupy 1/aura of the quad; the AURA — the game's second, larger same-hue glow — is a
          // soft gradient over the whole of it. Core and star also burn toward WHITE (the console's overbright
          // additive saturation) while the ring and aura stay pure hue.
          vec2 ds = d * auraScale;
          float core = element(ds, 0.55, vec2(0.5, 0.5), 0.0);
          float star = 0.0;
          if (streak > 0.0) {
            float cs = cos(vFade.y), sn = sin(vFade.y);
            vec2 rd = vec2(ds.x * cs - ds.y * sn, ds.x * sn + ds.y * cs);
            star = element(rd, 1.25, vec2(0.0, 0.0), 0.0) * streak;
          }
          a  = element(ds, 1.0, vec2(0.0, 0.5), 1.5) * ringStrength;
          a += pow(clamp(1.0 - length(d) * 2.0, 0.0, 1.0), power) * auraAlpha;
          a += core + star;
          white = (core + star) * hot;
        } else {
          a = pow(clamp(1.0 - length(d) * 2.0, 0.0, 1.0), power);   // no extracted bank: a smooth radial bloom
        }
        float visible = vFade.x;
        if (a * visible <= 0.001) discard;
        vec3 colour = vHue * (alpha * a * visible) + vec3(alpha * white * visible);
        gl_FragColor = vec4(colour, 1.0);   // premultiplied; additive with alpha 1 is the engine's One One
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  // Three renders a WebXR ArrayCamera one eye at a time. By onBeforeRender the XR manager has applied the
  // current rig parent to both sub-cameras, so this is the first safe point to form the same averaged stereo
  // view-projection Unity uses. The uniform is shared by both eye draws; ndcEye remains a built-in per-eye
  // result inside the shader. A mono XR view and ordinary desktop rendering take the original eye path.
  const leftViewProjection = new THREE.Matrix4();
  const rightViewProjection = new THREE.Matrix4();
  material.onBeforeRender = renderer => {
    useCyclopeanBloom.value = 0;
    if (renderer.xr.isPresenting) {
      const views = renderer.xr.getCamera().cameras;
      if (views.length === 2) {
        leftViewProjection.multiplyMatrices(views[0].projectionMatrix, views[0].matrixWorldInverse);
        rightViewProjection.multiplyMatrices(views[1].projectionMatrix, views[1].matrixWorldInverse);
        averageStereoMatrices(cyclopeanViewProjection.value, leftViewProjection, rightViewProjection);
        useCyclopeanBloom.value = 1;
      }
    }
    // onBeforeRender can run while the same ShaderMaterial/program remains bound from the previous object or
    // frame. Force these live camera uniforms through on every glint draw.
    material.uniformsNeedUpdate = true;
  };

  /** The shared unit quad every glint instances, with (0,0) at the bottom-left so the atlas quadrants land
   *  the same way up as they do in Unity. */
  function baseQuad(): THREE.InstancedBufferGeometry {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = 0;
    return geometry;
  }

  /** One cloud of glints under one root: the authored rig's, or a loaded reference level's. */
  function createCloud(parent: THREE.Object3D) {
    const geometry = baseQuad();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;   // the shader blooms and pulls the quad well outside the base geometry's AABB
    mesh.raycast = () => { /* display-only: the source bulbs own the click (docs/013) */ };
    mesh.visible = false;
    parent.add(mesh);
    let count = 0;

    function set(list: Glint[]) {
      count = list.length;
      if (count > 0) {
        const pos = new Float32Array(count * 3), hue = new Float32Array(count * 3);
        const size = new Float32Array(count), nudge = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const g = list[i];
          pos[i * 3] = g.pos[0]; pos[i * 3 + 1] = g.pos[1]; pos[i * 3 + 2] = g.pos[2];
          hue[i * 3] = g.hue[0]; hue[i * 3 + 1] = g.hue[1]; hue[i * 3 + 2] = g.hue[2];
          size[i] = g.quadM;
          nudge[i] = g.nudgeM;
        }
        geometry.setAttribute('glintPos', new THREE.InstancedBufferAttribute(pos, 3));
        geometry.setAttribute('glintHue', new THREE.InstancedBufferAttribute(hue, 3));
        geometry.setAttribute('glintSize', new THREE.InstancedBufferAttribute(size, 1));
        geometry.setAttribute('glintNudge', new THREE.InstancedBufferAttribute(nudge, 1));
      }
      geometry.instanceCount = count;
      mesh.visible = visible && count > 0;
    }

    return { set, show: () => { mesh.visible = visible && count > 0; }, get count() { return count; } };
  }

  let visible = false;
  const authored = createCloud(stage.worldRoot);   // the course's own lights, in data coords
  const reference = createCloud(stage.refRoot);    // a loaded reference's rig, riding its placement offset
  const drawingBufferSize = new THREE.Vector2();

  /** The course's authored rig (sign, group and free lights) — only those an author gave a glint class. */
  function setAuthored(rig: LightRig | null) { authored.set(rigGlints(rig)); }

  /** A loaded reference level's own rig: its lamps and flares glint exactly as the engine gates them. */
  function setReference(rig: LightRig | null) { reference.set(rigGlints(rig)); }

  /** Rides effective Local lights — a glint IS light the source casts, not rigging that marks where it is. */
  function show(on: boolean) {
    visible = on;
    authored.show();
    reference.show();
  }

  /** The pixel floor needs the live drawing-buffer height; WebXR's cyclopean matrix updates at draw time. */
  function sync() {
    stage.renderer.getDrawingBufferSize(drawingBufferSize);
    material.uniforms.halfViewportHeight.value = Math.max(1, drawingBufferSize.y * 0.5);
  }

  return {
    setAuthored, setReference, show, sync,
    get authoredCount() { return authored.count; },
    get referenceCount() { return reference.count; },
  };
}

export type GlintLayer = ReturnType<typeof createGlintLayer>;
