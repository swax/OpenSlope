import * as THREE from 'three';
import {
  DEFAULT_GODRAY_COURSE, GODRAY_LAW, GODRAY_SPOKES, buildGodRayRim, godRayPresentation, type GodRayCourse,
} from '../../../core/lighting/god-rays';
import { rideTree, type TreeGeometry } from '../mesh/surface-trees';
import type { Stage } from '../stage';

/**
 * SUN GOD-RAYS — the beams that fan across the view when you look toward the sun
 * ([Trailmap: 400-rendering], the celestial-glare section).
 *
 * Flat views retain the console's exact screen-space fan. WebXR deliberately uses the same sky-anchored
 * billboard compromise as the Unity realization: a full-screen, depthless overlay pasted identically across
 * both lenses has no stereo cue and is uncomfortable, while a camera-relative world billboard projects
 * independently through each eye. The course-authored sun sprite is a second additive billboard shared by
 * both paths.
 */
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const VIEW_FORWARD = new THREE.Vector3(0, 0, -1);

type RayUniforms = ReturnType<typeof rayUniforms>;

function rayUniforms() {
  return {
    fanColor: { value: new THREE.Color(1, 0.49, 0.09) },
    fanIntensity: { value: DEFAULT_GODRAY_COURSE.fanIntensity },
    displayGain: { value: GODRAY_LAW.fanDisplayGain },
    visibility: { value: 1 },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunDistance: { value: 240 },
    xrRayRadius: { value: 200 },
    xrEdgeStart: { value: GODRAY_LAW.xrEdgeStart },
  };
}

function createRayMaterial(uniforms: RayUniforms, xrBillboard: boolean) {
  return new THREE.ShaderMaterial({
    uniforms,
    defines: xrBillboard ? { XR_BILLBOARD: 1 } : {},
    vertexShader: /* glsl */ `
      attribute float amp;
      uniform vec3 sunDirection;
      uniform float sunDistance;
      uniform float xrRayRadius;
      varying float vAmp;
      varying float vRamp;
      void main() {
        vAmp = amp;
        // position.z carries the core->rim ramp rather than depth in both geometries.
        vRamp = position.z;
        #ifdef XR_BILLBOARD
          // A body at infinity: each eye starts at its own camera position and advances along the SAME world
          // direction. Building the disc in view space lets the eye's live asymmetric projection place it.
          vec3 centreView = (viewMatrix * vec4(cameraPosition + sunDirection * sunDistance, 1.0)).xyz;
          vec3 viewPosition = centreView + vec3(position.xy * xrRayRadius, 0.0);
          gl_Position = projectionMatrix * vec4(viewPosition, 1.0);
        #else
          // Desktop positions are already NDC, rebuilt on the CPU to meet all four screen corners exactly.
          gl_Position = vec4(position.xy, 0.0, 1.0);
        #endif
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 fanColor;
      uniform float fanIntensity;
      uniform float displayGain;
      uniform float visibility;
      uniform float xrEdgeStart;
      varying float vAmp;
      varying float vRamp;
      void main() {
        float r = clamp(vRamp, 0.0, 1.0);
        float rays = vAmp * fanIntensity * displayGain;
        float edge = 1.0;
        #ifdef XR_BILLBOARD
          edge = 1.0 - smoothstep(xrEdgeStart, 1.0, r);
        #endif
        gl_FragColor = vec4(fanColor * rays * visibility * edge, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    fog: false,
  });
}

/** One centre/rim triangle per procedural spoke. The XR disc is circular, so it needs no screen-corner splice. */
function createXrFanGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(GODRAY_SPOKES.length * 9);
  const amps = new Float32Array(GODRAY_SPOKES.length * 3);
  let v = 0;
  for (let i = 0; i < GODRAY_SPOKES.length; i++) {
    const a = GODRAY_SPOKES[i];
    const b = GODRAY_SPOKES[(i + 1) % GODRAY_SPOKES.length];
    const ar = (a.deg * Math.PI) / 180;
    const br = (b.deg * Math.PI) / 180;
    positions.set([0, 0, 0], v * 3); amps[v++] = a.amp;
    positions.set([Math.cos(ar), Math.sin(ar), 1], v * 3); amps[v++] = a.amp;
    positions.set([Math.cos(br), Math.sin(br), 1], v * 3); amps[v++] = a.amp;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('amp', new THREE.BufferAttribute(amps, 1));
  return geometry;
}

function createSunMaterial() {
  const uniforms = {
    sunColor: { value: new THREE.Color(1, 0.72, 0.36) },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunDistance: { value: 240 },
    sunRadius: { value: 36 },
    visibility: { value: 1 },
    intensity: { value: DEFAULT_GODRAY_COURSE.spriteIntensity },
    displayGain: { value: GODRAY_LAW.coronaDisplayGain },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      uniform vec3 sunDirection;
      uniform float sunDistance;
      uniform float sunRadius;
      varying vec2 vDisc;
      void main() {
        vDisc = position.xy;
        vec3 centreView = (viewMatrix * vec4(cameraPosition + sunDirection * sunDistance, 1.0)).xyz;
        gl_Position = projectionMatrix * vec4(centreView + vec3(position.xy * sunRadius, 0.0), 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 sunColor;
      uniform float visibility;
      uniform float intensity;
      uniform float displayGain;
      varying vec2 vDisc;
      void main() {
        float r = length(vDisc);
        if (r >= 1.0) discard;
        // Retail selects only the atlas's white top-right corona tile. Its alpha is almost exactly inverse
        // smoothstep. The neighbouring star/ring tiles and the calculated 16-pixel rectangle are not submitted.
        float corona = 1.0 - smoothstep(0.0, 1.0, r);
        gl_FragColor = vec4(sunColor * intensity * visibility * corona * displayGain, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    fog: false,
  });
  return { material, uniforms };
}

export function createGodRayLayer(stage: Stage) {
  // Desktop: enough room for every spoke plus four moving corner splices, as indexed-free triangle soup.
  const MAX_RIM = 48;
  const MAX_VERTS = MAX_RIM * 3;
  const positions = new THREE.BufferAttribute(new Float32Array(MAX_VERTS * 3), 3);
  const amps = new THREE.BufferAttribute(new Float32Array(MAX_VERTS), 1);
  positions.setUsage(THREE.DynamicDrawUsage);
  amps.setUsage(THREE.DynamicDrawUsage);
  const desktopGeometry = new THREE.BufferGeometry();
  desktopGeometry.setAttribute('position', positions);
  desktopGeometry.setAttribute('amp', amps);
  desktopGeometry.setDrawRange(0, 0);

  const desktopUniforms = rayUniforms();
  const xrUniforms = rayUniforms();
  const desktopMaterial = createRayMaterial(desktopUniforms, false);
  const xrMaterial = createRayMaterial(xrUniforms, true);
  const desktopMesh = new THREE.Mesh(desktopGeometry, desktopMaterial);
  desktopMesh.name = 'sun-god-rays.desktop';
  const xrMesh = new THREE.Mesh(createXrFanGeometry(), xrMaterial);
  xrMesh.name = 'sun-god-rays.xr';
  const sun = createSunMaterial();
  const sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), sun.material);
  sunMesh.name = 'sun-god-rays.sun';

  for (const mesh of [desktopMesh, xrMesh, sunMesh]) {
    mesh.frustumCulled = false; // every vertex is camera-relative or already clip space
    mesh.visible = false;
    stage.scene.add(mesh);      // scene root: none of these coordinates belong under the chirality mirror
  }
  sunMesh.renderOrder = 3999;
  desktopMesh.renderOrder = xrMesh.renderOrder = 4000;

  let course: GodRayCourse | null = null;
  // Prop lighting is a Play presentation layer. Its switch can suppress the fan without throwing away the
  // course glare selected by the Skybox/Test context, so re-enabling it restores on the next frame.
  let enabled = true;
  /** Direction TO the sun, in Three world coordinates. */
  const sunDir = new THREE.Vector3(0, 1, 0);
  const scratch = new THREE.Vector3();
  const viewEye = new THREE.Vector3();
  const viewForward = new THREE.Vector3();
  const eyeScratch = new THREE.Vector3();
  const forwardScratch = new THREE.Vector3();
  const viewWorld = new THREE.Matrix4();

  // ---- source-visibility fade -----------------------------------------------------------------------------
  let occluders: (() => (THREE.Mesh | null)[]) | null = null;
  let visibility = 1;
  const rayOrigin = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  const probe = new THREE.Ray();
  const toLocal = new THREE.Matrix4();
  const side = new THREE.Vector3();
  const upAxis = new THREE.Vector3();

  /** Terrain the sight lines test against. Meshes may come and go, so this is a getter, not a list. */
  function setOccluders(fn: (() => (THREE.Mesh | null)[]) | null) { occluders = fn; }

  /** True when nothing stands between the eye and the sky along `dir`. */
  function clear(dir: THREE.Vector3): boolean {
    const meshes = occluders?.() ?? [];
    for (const mesh of meshes) {
      if (!mesh) continue;
      const bvh = rideTree(mesh.geometry as TreeGeometry);
      if (!bvh) continue;
      mesh.updateWorldMatrix(true, false);
      probe.origin.copy(rayOrigin);
      probe.direction.copy(dir).normalize();
      probe.applyMatrix4(toLocal.copy(mesh.matrixWorld).invert());
      if (bvh.raycastFirst(probe, THREE.DoubleSide, 0, GODRAY_LAW.sightRange)) return false;
    }
    return true;
  }

  /** The fraction of the cone toward the sun that reaches the sky. */
  function clearFraction(eye: THREE.Vector3): number {
    if (!occluders) return 1;
    rayOrigin.copy(eye);
    const upish = Math.abs(sunDir.y) < 0.9 ? UP : FORWARD;
    side.crossVectors(sunDir, upish).normalize();
    upAxis.crossVectors(side, sunDir).normalize();
    const spread = Math.tan((GODRAY_LAW.sightSpreadDegrees * Math.PI) / 180);
    let hits = 0;
    if (clear(rayDir.copy(sunDir))) hits++;
    if (clear(rayDir.copy(sunDir).addScaledVector(side, spread))) hits++;
    if (clear(rayDir.copy(sunDir).addScaledVector(side, -spread))) hits++;
    if (clear(rayDir.copy(sunDir).addScaledVector(upAxis, spread))) hits++;
    if (clear(rayDir.copy(sunDir).addScaledVector(upAxis, -spread))) hits++;
    return hits * 0.2;
  }

  function hide() {
    desktopMesh.visible = false;
    xrMesh.visible = false;
    sunMesh.visible = false;
  }

  /** Turn the glare and its authored sun on with a course's settings, or off. */
  function setCourse(next: GodRayCourse | null) {
    course = next;
    if (next) {
      for (const uniforms of [desktopUniforms, xrUniforms]) {
        // The final retail draw path uses CoreColour for every fan vertex; it is not an RGB core→rim ramp.
        // These values enter a custom shader that deliberately reproduces the GS's display-byte-domain
        // additive blend. Store the authored bytes verbatim; sRGB->linear conversion would darken them before
        // blending and reverse the retail corona/fan balance.
        uniforms.fanColor.value.setRGB(next.core[0] / 255, next.core[1] / 255, next.core[2] / 255);
        uniforms.fanIntensity.value = next.fanIntensity;
      }
      // RimColour belongs to the single textured corona primitive in the final retail draw routine.
      sun.uniforms.sunColor.value.setRGB(next.rim[0] / 255, next.rim[1] / 255, next.rim[2] / 255);
      sun.uniforms.intensity.value = next.spriteIntensity;
    }
    hide(); // sync decides once it has the current presentation camera
  }

  function setEnabled(on: boolean) {
    enabled = on;
    if (!enabled) hide();
  }

  /** Point the glare. `dir` is the direction TO the sun in Three world coordinates. */
  function setSunDirection(dir: THREE.Vector3) {
    sunDir.copy(dir).normalize();
    xrUniforms.sunDirection.value.copy(sunDir);
    sun.uniforms.sunDirection.value.copy(sunDir);
  }

  /**
   * Resolve the view before Three's render call. WebXR has already written this frame's raw eye matrices, but
   * it does not combine them with the freshly seated rig parent until render(), so do that small multiplication
   * here. Averaging the eyes gives source occlusion a stable head centre; the shaders still project per eye.
   */
  function resolveView(xr: boolean) {
    if (xr) {
      const views = stage.renderer.xr.getCamera().cameras;
      if (views.length) {
        const parent = stage.camera.parent;
        parent?.updateWorldMatrix(true, false);
        viewEye.set(0, 0, 0);
        viewForward.set(0, 0, 0);
        for (const view of views) {
          if (parent) viewWorld.multiplyMatrices(parent.matrixWorld, view.matrix);
          else viewWorld.copy(view.matrix);
          eyeScratch.setFromMatrixPosition(viewWorld);
          forwardScratch.copy(VIEW_FORWARD).transformDirection(viewWorld);
          viewEye.add(eyeScratch);
          viewForward.add(forwardScratch);
        }
        viewEye.multiplyScalar(1 / views.length);
        viewForward.normalize();
        return;
      }
    }
    stage.camera.updateWorldMatrix(true, false);
    stage.camera.getWorldPosition(viewEye);
    stage.camera.getWorldDirection(viewForward);
  }

  /** Rebuild/select the presentation for this frame's current camera. Call after XR has seated its rig. */
  function sync() {
    if (!enabled || !course) { hide(); return; }
    const xr = stage.renderer.xr.isPresenting;
    resolveView(xr);

    // Projecting a source behind the eye mirrors it onto the screen; hide all three presentation meshes instead.
    if (viewForward.dot(sunDir) <= 0) { hide(); return; }

    const target = clearFraction(viewEye);
    visibility += Math.max(-GODRAY_LAW.fadePerFrame, Math.min(GODRAY_LAW.fadePerFrame, target - visibility));
    desktopUniforms.visibility.value = visibility;
    xrUniforms.visibility.value = visibility;
    sun.uniforms.visibility.value = visibility;

    const presentation = godRayPresentation(course, stage.camera.far);
    xrUniforms.sunDistance.value = presentation.distance;
    xrUniforms.xrRayRadius.value = presentation.xrRayRadius;
    sun.uniforms.sunDistance.value = presentation.distance;
    sun.uniforms.sunRadius.value = presentation.sunRadius;
    sunMesh.visible = true;

    if (xr) {
      desktopMesh.visible = false;
      xrMesh.visible = true;
      return;
    }

    xrMesh.visible = false;
    // Desktop retains the console law: project the directional source and run every spoke to the NDC border.
    scratch.copy(viewEye).addScaledVector(sunDir, 1e5).project(stage.camera);
    const rim = buildGodRayRim({ x: scratch.x, y: scratch.y });
    const pos = positions.array as Float32Array;
    const amp = amps.array as Float32Array;
    let v = 0;
    for (let i = 0; i < rim.length; i++) {
      const a = rim[i];
      const b = rim[(i + 1) % rim.length];
      // Flat wedges retain the hard angular steps that make neighbouring bands read as beams.
      pos[v * 3] = scratch.x; pos[v * 3 + 1] = scratch.y; pos[v * 3 + 2] = 0; amp[v] = a.amp; v++;
      pos[v * 3] = a.x; pos[v * 3 + 1] = a.y; pos[v * 3 + 2] = 1; amp[v] = a.amp; v++;
      pos[v * 3] = b.x; pos[v * 3 + 1] = b.y; pos[v * 3 + 2] = 1; amp[v] = a.amp; v++;
    }
    positions.needsUpdate = true;
    amps.needsUpdate = true;
    desktopGeometry.setDrawRange(0, v);
    desktopMesh.visible = true;
  }

  return {
    setCourse, setEnabled, setSunDirection, setOccluders, sync,
    get active() { return !!course; },
    get visibility() { return visibility; },
  };
}

export type GodRayLayer = ReturnType<typeof createGodRayLayer>;
