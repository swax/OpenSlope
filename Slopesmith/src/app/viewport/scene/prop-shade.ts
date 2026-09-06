import * as THREE from 'three';
import { surfaceStyle } from '../../../core/doc/types';
import type { PlacedPropContactState } from '../../../core/props/contact';
import { SURFACE_POLY_OFFSET } from '../constants';
import { BACKFACE_TINT_GLSL } from '../mesh/backface-tint';
import { materialTextureArray, useTextureArray } from '../mesh/texture-array';
import type { ShadeMode } from '../types';

// Neutral overrides for the shade views: Surface swaps tiles for a flat clay solid; Wireframe draws the
// same geometry as bare triangle wires. Wireframe uses the same hidden-line treatment as the terrain cage:
// a colourless solid fills depth, then hidden wires draw faint and visible wires draw bright.
export const PROP_CLAY_COLOR = 0xb0b4ba;
/** Mix at FULL darkness over the Surface view's flat clay. Far louder than the terrain's, because here the
 *  tint IS the signal rather than an overlay on tile art there is any point still reading. */
export const PROP_DARK_TINT_MIX = 0.55;

/**
 * The authored sun, as the toward-light direction in SCENE-ROOT world space, `w` = 1 while an authored sun
 * is on. Shared across every clay material, so one assignment re-reads the whole view.
 *
 * Z is negated against the editor-space vector for the same reason `setPropLight` negates it on `propKey`:
 * the light is expressed at scene root while every prop hangs under `worldRoot`, which mirrors Z to show
 * the game's handedness.
 */
const claySun = { value: new THREE.Vector4(0, 0, 0, 0) };

/** Point the Surface view's darkness reading at the authored sun, or `null` for none — the studio rig is a
 *  viewing light, not a shipping one, so with it up there is no darkness fact to state and nothing tints. */
export function setPropShadeSun(dir: readonly [number, number, number] | null): void {
  if (dir) claySun.value.set(dir[0], dir[1], -dir[2], 1);
  else claySun.value.set(0, 0, 0, 0);
}

/**
 * The Surface view's colour for one prop's CONTACT class — the prop-side twin of the terrain's ride-feel
 * tint, off the same authored fact the export compiles (`core/props/contact.ts`, [Trailmap: 130, 150]).
 *
 * A **solid** placement carrying a rideable SurfaceType wears that surface's own colour, deliberately the
 * same swatch the snow beside it wears: riding onto the prop takes that family's ride feel and board audio,
 * so "this reads as ice" is the fact being stated. A solid placement with no ride surface is an obstacle
 * rather than a surface, so it gets a colour of its own instead of borrowing a ride feel it doesn't have.
 * Both stay clear of the terrain palette's occupied hues (blue and teal are unused there) and of the
 * back-face magenta that mixes over the top of whichever of them applies.
 */
export const PROP_SOLID_COLOR = 0x4a85ed;    // solid, no ride surface — an obstacle
export const PROP_THROUGH_COLOR = 0x2fbca0;  // ride-through: no response, but effects and sounds fire

export function propContactTint(state: PlacedPropContactState, surface?: number): number {
  if (state === 'none') return PROP_CLAY_COLOR;
  if (state === 'through') return PROP_THROUGH_COLOR;
  if (typeof surface !== 'number' || surface < 0) return PROP_SOLID_COLOR;
  return new THREE.Color(...surfaceStyle(surface).color).getHex();
}

/** userData key a prop tree's builder stamps to colour its Surface-view clay (`propContactTint`). Read from
 *  the nearest ancestor that carries it, so a placement stamps once and every submesh under it follows. */
export const PROP_SHADE_TINT = 'propShadeTint';

function shadeTint(mesh: THREE.Object3D): number {
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    const tint = node.userData[PROP_SHADE_TINT];
    if (typeof tint === 'number') return tint;
  }
  return PROP_CLAY_COLOR;
}
const PROP_OCCLUDED_DIM = 0.08;
const depthMaskMat = new THREE.MeshBasicMaterial({
  colorWrite: false, side: THREE.DoubleSide, ...SURFACE_POLY_OFFSET,
});
const hiddenWireMat = new THREE.MeshBasicMaterial({
  color: 0x9aa0a8, wireframe: true, transparent: true, opacity: PROP_OCCLUDED_DIM,
  depthTest: true, depthWrite: false, depthFunc: THREE.GreaterDepth, side: THREE.DoubleSide,
});
const visibleWireMat = new THREE.MeshBasicMaterial({
  color: 0x9aa0a8, wireframe: true, transparent: true, opacity: 1,
  depthTest: true, depthWrite: false, side: THREE.DoubleSide,
});

/** A filled-triangle material that keeps only a screen-antialiased barycentric rim. Unlike Three's built-in
 * `wireframe`, it leaves BatchedMesh's triangle draw ranges untouched, so heterogeneous geometry can remain
 * in one multi-draw batch without skewing its edge indices. */
function barycentricWireMaterial(opacity: number,
  depthFunc: THREE.DepthModes = THREE.LessEqualDepth): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0x9aa0a8, transparent: true, opacity, depthTest: true, depthWrite: false,
    depthFunc, side: THREE.DoubleSide,
  });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 propBarycentric;\nvarying vec3 vPropBarycentric;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPropBarycentric = propBarycentric;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPropBarycentric;')
      .replace('#include <opaque_fragment>', `
        vec3 propEdgeAA = smoothstep(vec3(0.0), fwidth(vPropBarycentric) * 1.15, vPropBarycentric);
        float propEdgeCoverage = 1.0 - min(min(propEdgeAA.x, propEdgeAA.y), propEdgeAA.z);
        if (propEdgeCoverage <= 0.01) discard;
        diffuseColor.a *= propEdgeCoverage;
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => 'prop-barycentric-wire-v1';
  return material;
}

const hiddenBatchedWireMat = barycentricWireMaterial(PROP_OCCLUDED_DIM, THREE.GreaterDepth);
const visibleBatchedWireMat = barycentricWireMaterial(1);

const clayMats = new Map<string, THREE.MeshLambertMaterial>();

/**
 * The Surface view's stand-in for one prop material: flat clay wearing the tile's ALPHA and none of its
 * colour, magenta-tinted by how little of the authored sun's KEY the face receives.
 *
 * Keeping the map for its alpha is what lets the art go while the silhouette stays — a leaf card, a fence
 * or a banner reads as its cut shape rather than as the grey rectangle a plain solid draws. That is the
 * whole reason the map is still bound on a material that shows none of its colour.
 *
 * **The tint is a property of the prop, not of where you stand.** That is what makes it the terrain
 * dead-side tint's true twin: terrain's magenta states a fact about the surface (which side the rider falls
 * through) and never moves with the camera, so a prop reading that answered "which side am I on" would have
 * been the odd one out. What a prop has instead of a ridable side is a LIT side. Object light is baked once
 * per vertex from the stored normal as `ambient + Σ max(0, N·L)·key` and shown identically from both faces
 * ([Trailmap: 400], docs/028), so a sheet turned away from the key ships ambient-only dark from every view,
 * and the magenta says exactly that — on both of its faces, steady as you fly around it.
 *
 * **Graded rather than a flag, and that is load-bearing.** A hard test at `N·L = 0` puts a discontinuity
 * exactly where shipped art clusters: MEGAPLE's fence panels sit edge-on to the key at `N·L` between −0.11
 * and +0.11 and ship at 36–46% of texture-true whichever side of zero they land, yet alternate panel by
 * panel because half of them store a mirrored normal. Flagging on the sign would paint that alternation as
 * a defect. Fading over `smoothstep(0, 0.5, N·L)` reads them as what they are — uniformly dim — while still
 * taking a squarely-turned sheet (the flipbook at −0.46) to full tint.
 *
 * N comes off the STORED normal, which is what the game lights from and what `facing-arrows.ts` now draws;
 * on a retail model that is `PropSub.normals`, and only where none ships does `computeVertexNormals` put the
 * winding there. Three's own normal pipeline carries it through instancing, batching and mirrors, which no
 * `gl_FrontFacing` reading survives: Three derives `frontFace` from `object.matrixWorld.determinant()`
 * alone, and the reference decor hides RAW_TO_EDITOR inside the PER-INSTANCE matrix where that cannot see it.
 *
 * `prop-shader-webgl.fixture.ts` renders both compositions and holds the two claims that matter — the tint
 * does not move with the camera, and it follows the sun — which also makes it the guard on these `#include`
 * anchors: a Three upgrade renaming one would leave the tile's colour and the packed light index showing.
 */
function clayVariant(source: THREE.Material, tint: number): THREE.Material {
  const map = (source as THREE.MeshLambertMaterial).map ?? null;
  // A source drawing through a packed bank keeps its `map` on the 1x1 stand-in, so a clay variant that only
  // copied `map` would test a solid white alpha and every cutout would fill in as a rectangle. Carry the
  // array across and let the same rewrite bind it — the silhouette is the whole point of keeping a map here.
  const array = materialTextureArray(source);
  const key = `${array?.uuid ?? map?.uuid ?? 'flat'}|${source.alphaTest}|${source.transparent ? 1 : 0}`
    + `|${source.alphaHash ? 1 : 0}`
    + `|${source.depthWrite ? 1 : 0}|${tint}`;
  let material = clayMats.get(key);
  if (!material) {
    material = new THREE.MeshLambertMaterial({
      color: tint, side: THREE.DoubleSide, map,
      alphaTest: source.alphaTest, alphaHash: source.alphaHash,
      transparent: source.transparent, depthWrite: source.depthWrite,
    });
    material.onBeforeCompile = shader => {
      shader.uniforms.uClaySun = claySun;   // shared: one assignment re-reads every clay material
      // The view-space stored normal. Its own varying rather than Lambert's `vNormal`, because
      // `normal_fragment_begin` would already have applied the double-sided flip that hides which way the
      // face actually points — the flip this reading exists to see past.
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec3 vClayNormal;\nvoid main() {')
        // after defaultnormal_vertex: instancing / batching / skinning folded in, then normalMatrix
        .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n\tvClayNormal = transformedNormal;');
      shader.fragmentShader = shader.fragmentShader
        // `viewMatrix` is in Three's standard fragment prefix, so the sun stays a world-space uniform that
        // only the sun panel writes rather than something the render loop has to refresh per camera move.
        .replace('void main() {', 'uniform vec4 uClaySun;\nvarying vec3 vClayNormal;\nvoid main() {')
        // Keep the tile's alpha (the cutout silhouette), drop its colour for the flat solid. Anchored after
        // `color_fragment` and before `alphatest_fragment`: the cut still tests the tile's own alpha, and
        // this lands past BOTH colour sources. The second one is the trap — a retail prop's `instanceColor`
        // is not a tint at all but `propLightIndexColor`'s packed 24-bit native light-table index, which
        // `color_fragment` would multiply straight into the clay (index 0 renders black, 1–255 a red ramp).
        // The lit prop materials neutralise it the same way, at `mix(vColor, vec3(1.0), uNativeRecords)`.
        .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb = diffuse;')
        // `max(0, N·L)` is the engine's own clamp; the smoothstep only decides how fast the tint arrives.
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
	float clayKey = max( 0.0, dot( normalize( vClayNormal ), mat3( viewMatrix ) * uClaySun.xyz ) );
	float clayDark = uClaySun.w * ( 1.0 - smoothstep( 0.0, 0.5, clayKey ) );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, ${BACKFACE_TINT_GLSL}, clayDark * ${PROP_DARK_TINT_MIX.toFixed(2)} );`);
    };
    // The injected source is identical for every variant (both constants compile in), so one key keeps the
    // whole family on one program instead of one per tile.
    material.customProgramCacheKey = () => 'prop-surface-clay';
    // Applied last so the array rewrite lands on the already-injected shader, and so the clay family keeps its
    // single program per flavour rather than one per bank member.
    if (array) useTextureArray(material, array, 'clay');
    clayMats.set(key, material);
  }
  return material;
}

const WIREFRAME_PASS = 'propWireframePass';
const WIREFRAME_PASSES = 'propWireframePasses';

interface BatchedMeshInternals {
  _matricesTexture: THREE.DataTexture;
  _indirectTexture: THREE.DataTexture;
}

function resetPassTransform(pass: THREE.Mesh): void {
  pass.position.set(0, 0, 0);
  pass.quaternion.identity();
  pass.scale.set(1, 1, 1);
  pass.matrix.identity();
  pass.matrixAutoUpdate = false;
  pass.matrixWorldNeedsUpdate = true;
}

function wireframePass(source: THREE.Mesh, material: THREE.Material): THREE.Mesh {
  let pass: THREE.Mesh;
  if (source instanceof THREE.InstancedMesh) {
    const instanced = new THREE.InstancedMesh(source.geometry, material, source.count);
    instanced.instanceMatrix = source.instanceMatrix; // animations and Play mutations update the shared buffer
    instanced.frustumCulled = false; // the source's aggregate bound can move after this pass is created
    pass = instanced;
  } else {
    pass = new THREE.Mesh(source.geometry, material);
    pass.frustumCulled = source.frustumCulled;
  }
  resetPassTransform(pass);
  pass.name = `${source.name || 'Prop'} wireframe pass`;
  pass.userData = { [WIREFRAME_PASS]: true };
  pass.castShadow = false;
  pass.receiveShadow = false;
  pass.raycast = () => { /* renderer-only duplicate; the original depth mesh remains the pick target */ };
  return pass;
}

function barycentricGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = source.getAttribute('position');
  const index = source.getIndex();
  const count = index?.count ?? position?.count ?? 0;
  const positions = new Float32Array(count * 3);
  const barycentrics = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex++) {
    const sourceVertex = index ? index.getX(vertex) : vertex;
    positions[vertex * 3] = position.getX(sourceVertex);
    positions[vertex * 3 + 1] = position.getY(sourceVertex);
    positions[vertex * 3 + 2] = position.getZ(sourceVertex);
    barycentrics[vertex * 3 + (vertex % 3)] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('propBarycentric', new THREE.BufferAttribute(barycentrics, 3));
  return geometry;
}

function shareBatchMatrices(pass: THREE.BatchedMesh, source: THREE.BatchedMesh): void {
  const passInternals = pass as unknown as BatchedMeshInternals;
  const sourceInternals = source as unknown as BatchedMeshInternals;
  passInternals._matricesTexture.dispose();
  passInternals._matricesTexture = sourceInternals._matricesTexture;
}

/** Three's BatchedMesh `wireframe` flag substitutes a generated edge index buffer without remapping the
 * heterogeneous triangle ranges. Build one non-indexed barycentric geometry per source submesh instead; its
 * shader draws only triangle rims while the objects remain in two true multi-draw batches. */
function batchedWireframePasses(source: THREE.BatchedMesh): THREE.Mesh[] {
  const slots = source.userData.propSlots as Array<{ geometry?: THREE.BufferGeometry } | undefined> | undefined;
  if (!slots?.length) return [];
  const wireBySource = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  for (const slot of slots) if (slot?.geometry && !wireBySource.has(slot.geometry))
    wireBySource.set(slot.geometry, barycentricGeometry(slot.geometry));
  const vertices = [...wireBySource.values()].reduce((sum, geometry) =>
    sum + geometry.getAttribute('position').count, 0);
  if (!vertices) return [];

  const hidden = new THREE.BatchedMesh(slots.length, vertices, vertices * 2, hiddenBatchedWireMat);
  hidden.perObjectFrustumCulled = source.perObjectFrustumCulled;
  hidden.sortObjects = false;
  const geometryIds = new Map<THREE.BufferGeometry, number>();
  for (const [sourceGeometry, wireGeometry] of wireBySource)
    geometryIds.set(sourceGeometry, hidden.addGeometry(wireGeometry));
  slots.forEach((slot, sourceId) => {
    if (!slot?.geometry) return;
    const instanceId = hidden.addInstance(geometryIds.get(slot.geometry)!);
    if (instanceId !== sourceId) throw new Error('Prop wire batch instance order diverged from its source batch');
  });
  shareBatchMatrices(hidden, source);
  hidden.computeBoundingSphere();

  // Copy the compact wire draw ranges into the bright pass, but share both the combined geometry and the
  // source batch's live matrix texture. Each pass retains its own camera-dependent indirect command texture.
  const visible = new THREE.BatchedMesh(slots.length, vertices, vertices * 2, visibleBatchedWireMat);
  visible.copy(hidden);
  visible.geometry.dispose();
  visible.geometry = hidden.geometry;
  shareBatchMatrices(visible, source);
  visible.material = visibleBatchedWireMat;
  wireBySource.forEach(geometry => geometry.dispose());

  for (const [pass, topology] of [[hidden, 'hidden'], [visible, 'visible']] as const) {
    resetPassTransform(pass);
    pass.name = `${source.name || 'Prop batch'} ${topology} barycentric wire batch`;
    pass.userData = { [WIREFRAME_PASS]: true, propWireGeometryOwner: pass === hidden };
    pass.frustumCulled = false; // native per-object culling still trims the multi-draw commands
    pass.castShadow = false;
    pass.receiveShadow = false;
    pass.raycast = () => { /* renderer-only duplicate; the original depth batch remains the pick target */ };
  }
  return [hidden, visible];
}

function ensureWireframePasses(mesh: THREE.Mesh): THREE.Mesh[] {
  const existing = mesh.userData[WIREFRAME_PASSES] as THREE.Mesh[] | undefined;
  if (existing) return existing;
  const passes = mesh instanceof THREE.BatchedMesh
    ? batchedWireframePasses(mesh)
    : [wireframePass(mesh, hiddenWireMat), wireframePass(mesh, visibleWireMat)];
  for (const pass of passes) {
    const hidden = (pass.material as THREE.Material).depthFunc === THREE.GreaterDepth;
    pass.renderOrder = mesh.renderOrder + (hidden ? 0 : 1);
    mesh.add(pass);
  }
  return mesh.userData[WIREFRAME_PASSES] = passes;
}

/** Drop the renderer-only passes before a prop tree is discarded. Ordinary geometry/materials are shared;
 * barycentric batches own one combined geometry and one indirect command texture per pass. */
export function disposePropShade(root: THREE.Object3D): void {
  root.traverse(object => {
    if (object.userData[WIREFRAME_PASS]) return;
    const passes = object.userData[WIREFRAME_PASSES] as THREE.Mesh[] | undefined;
    if (!passes) return;
    for (const pass of passes) {
      object.remove(pass);
      if (pass instanceof THREE.BatchedMesh) {
        const internals = pass as unknown as BatchedMeshInternals;
        internals._indirectTexture.dispose();
        if (pass.userData.propWireGeometryOwner) pass.geometry.dispose();
      } else if (pass instanceof THREE.InstancedMesh) pass.dispose();
    }
    delete object.userData[WIREFRAME_PASSES];
  });
}

/**
 * Swap a prop tree's mesh materials to match the shade view — clay in Surface, triangle wires in Wireframe —
 * restoring the stashed originals in Textured. Surface drops every prop's art for `clayVariant`'s flat solid
 * (silhouette and back-face tint kept); Wireframe overrides everything (the wires ARE the silhouette).
 * Fat-line overlays (selection outlines) subclass Mesh but keep their LineMaterial.
 */
export function applyPropShade(root: THREE.Object3D, mode: ShadeMode): void {
  root.traverse(object => {
    const mesh = object as THREE.Mesh & { isLineSegments2?: boolean };
    if (!mesh.isMesh || mesh.isLineSegments2 || mesh.userData[WIREFRAME_PASS]) return;
    const original = (mesh.userData.texturedMaterial ?? mesh.material) as THREE.Material | THREE.Material[];
    const passes = mode === 'none' ? ensureWireframePasses(mesh)
      : mesh.userData[WIREFRAME_PASSES] as THREE.Mesh[] | undefined;
    if (passes) for (const pass of passes) pass.visible = mode === 'none';
    const tint = mode === 'surface' ? shadeTint(mesh) : PROP_CLAY_COLOR;
    const override = mode === 'none' ? depthMaskMat
      : mode === 'surface' ? (Array.isArray(original)
        ? original.map(material => clayVariant(material, tint)) : clayVariant(original, tint))
        : null;
    if (!override) {
      if (mesh.userData.texturedMaterial) { mesh.material = original; delete mesh.userData.texturedMaterial; }
      return;
    }
    mesh.userData.texturedMaterial ??= mesh.material; // first override stashes the real material
    mesh.material = override;
  });
}
