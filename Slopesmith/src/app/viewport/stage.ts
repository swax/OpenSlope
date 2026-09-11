import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { ViewportCallbacks } from './types';
import type { V3 } from '../../core/doc/types';
import { makeReticleTexture } from './gizmo/geometry';
import { createGizmoArcs, type SurfaceRails } from './gizmo/arcs';
import { pickTree, type TreeGeometry } from './mesh/surface-trees';
import { createXrContext } from './xr-context';

/** Which kind of node the single shared translate gizmo is currently seated on — every selection type
 *  (terrain corner / course knot / tangent handle / reference / placed prop / free light / rail node / gem)
 *  routes through the one gizmo, and the kind tells the shell where a drag report should go. */
export type GizmoKind =
  | 'corner' | 'corners' | 'controlpoints' | 'knot' | 'anchor' | 'handle' | 'cagehandle' | 'reference'
  | 'prop' | 'props' | 'editmixed' | 'light' | 'railnode' | 'gem' | 'screen' | 'effect' | 'edgeextrusion';

/**
 * The shared 3D substrate every viewport layer draws into: the renderer, scene, the active camera pair, the
 * orbit controls, the two chirality roots (worldRoot flips Z to the game's handedness; refRoot adds the
 * reference's placement offset under it), the raycaster, the one translate gizmo, and the pivot / marquee
 * overlays. Layer controllers hold a `Stage` and mutate their own groups under `worldRoot` / `refRoot`;
 * cross-cutting side-effects of a gizmo seat (re-frame a corner, drop the reference selection) are inverted
 * out through the `afterGizmoAttach` / `onGizmoDrag` / `onGizmoChange` / `pickTargets` hooks the shell wires.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  /** Mutable attribute record captured by Three's WebXRManager. Changing its AA answer only while setSession
   *  builds an XR layer selects off vs XR antialiasing without changing the already-created desktop context. */
  private xrLayerAttributes: WebGLContextAttributes | null = null;
  private readonly xrContext: ReturnType<typeof createXrContext>;
  get xrContextPreparing(): boolean { return this.xrContext.preparing; }
  prepareXrContext(): Promise<void> { return this.xrContext.prepare(); }
  readonly scene = new THREE.Scene();
  /** Active view camera (perspective by default, swapped to orthographic by the projection toggle). */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  perspCam: THREE.PerspectiveCamera;
  orthoCam: THREE.OrthographicCamera | null = null;
  isOrtho = false;
  orthoHalfH = 100;   // ortho frustum half-height, kept across resizes (zoom changes camera.zoom)
  authoredFar = 4000; // far plane sized to the authored mountain's span (restored when a reference clears)
  readonly controls: OrbitControls;

  /** Unity-style translate gizmo (X/Y/Z arrows = 1 axis, plane quads = 2 axes, centre = free move),
   *  attached to whatever node is selected so the drag axis is always explicit. One gizmo at a time. */
  readonly gizmo: TransformControls;
  gizmoKind: GizmoKind | null = null;
  gizmoKnot = 0;
  gizmoDir = ''; // for kind 'handle': which tangent direction (u-/u+/v-/v+) the nub drives
  gizmoRestrict = false; // hide the XY / YZ / XYZ handles (true in the Surface corner frame)
  /** The rails the Surface-mode arrows bend along, asked for once per frame. The viewport owns the selection and the
   *  net, so it answers; null means the gizmo is not on an exact slide and the stock straight arrows stand. */
  surfaceRails: (() => SurfaceRails | null) | null = null;

  // WYSIWYG: the SSX game is left-handed and Three.js is right-handed. worldRoot flips Z (scale.z = -1) for
  // the whole scene so the editor shows the GAME's orientation. Visual meshes parent here in data coords;
  // interactive meshes (knots / handles) instead live at scene root with Z negated by hand so the gizmo
  // never sees a negative-scale parent. The read-only reference parents under refRoot (under worldRoot) so it
  // shares the flip; refRoot only adds the placement offset.
  readonly worldRoot = new THREE.Group();
  readonly refRoot = new THREE.Group();

  readonly ray = new THREE.Raycaster();
  readonly pointer = new THREE.Vector2();

  /** The authored ground mesh — the shared target for ground-relative placement raycasts (gems / props /
   *  paint drop onto it). Set by the terrain layer (the shell, until terrain is its own controller). */
  terrainMesh: THREE.Mesh | null = null;

  // Surface-pick acceleration (see pickSurface). A terrain sheet is wide and thin, so its bounding sphere
  // covers most of the frame and a stock raycast clears the cheap early-out and walks every triangle —
  // measured at 56 ms per cast on a 278k-vertex mountain, on a path that runs per POINTER MOVE.
  private readonly pickLocalRay = new THREE.Ray();
  private readonly pickInv = new THREE.Matrix4();

  readonly marqueeEl: HTMLDivElement;      // rubber-band rectangle for box-select (HTML overlay over the canvas)
  readonly pivotMarker: THREE.Sprite;      // reticle (white dot + black ring) flashed at the orbit / zoom point
  private pivotTimer = 0;

  // --- hooks the shell wires after it has built the layer controllers (kept as no-ops until then) ---
  /** The pickable surfaces (authored terrain + loaded reference) for pivot / focus raycasts. */
  pickTargets: () => THREE.Object3D[] = () => [];
  /** Authored-space point quantizer supplied by the viewport's global Snap setting. */
  snapDataPoint: (point: V3) => V3 = point => [...point] as V3;
  /** Just seated the gizmo on `kind`: re-frame a corner gizmo to the slope and drop the reference selection. */
  afterGizmoAttach: (kind: GizmoKind) => void = () => {};
  /** A gizmo drag started (true) or ended (false): freeze / release the slide surface. */
  onGizmoDrag: (dragging: boolean) => void = () => {};
  /** The gizmo moved its target: forward the new position through the matching host callback. */
  onGizmoChange: () => void = () => {};

  /** Present one antialias value to Three while it creates an XR layer, then restore the desktop context's real
   *  answer. Returns a restore function so the async setSession path cannot leave the override behind. */
  prepareXrAntialias(enabled: boolean): { applied: boolean; restore: () => void } {
    const attributes = this.xrLayerAttributes;
    if (!attributes) return { applied: false, restore: () => {} };
    const previous = attributes.antialias;
    attributes.antialias = enabled;
    return { applied: enabled, restore: () => { attributes.antialias = previous; } };
  }

  constructor(
    readonly container: HTMLElement,
    readonly cb: ViewportCallbacks,
    antialias = false,
  ) {
    // WebGL cannot change the default framebuffer's sample count after boot. Three's WebXRManager gets one
    // mutable copy of the resulting attributes so the same global preference can also configure the separately
    // created XR layer. Both XRWebGLLayer and Three's projection target read this flag.
    const canvas = document.createElement('canvas');
    // Select the XR adapter before any native XR session exists. On Chrome PCVR, switching adapters after
    // requestSession can restore WebGL successfully while leaving that first session's headset output black.
    const context = canvas.getContext('webgl2', {
      antialias, powerPreference: 'high-performance', xrCompatible: true,
    });
    if (context) {
      this.xrContext = createXrContext(context);
      this.xrLayerAttributes = this.xrContext.layerAttributes;
      this.renderer = new THREE.WebGLRenderer({ canvas, context, powerPreference: 'high-performance' });
    } else {
      this.renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' });
      this.xrContext = createXrContext(this.renderer.getContext());
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap: phones report 3-4x = needless fill cost
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x16202c);

    this.perspCam = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
    this.perspCam.position.set(60, 140, -70);
    this.camera = this.perspCam;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 90, 60);

    this.worldRoot.scale.z = -1;   // mirror the whole scene to the game's chirality (WYSIWYG)
    this.scene.add(this.worldRoot);
    this.worldRoot.add(this.refRoot); // worldRoot supplies the game-chirality flip; refRoot only adds the offset

    // navigation pivot: a small white dot ringed in black (a reticle), flashed at the orbit / zoom point.
    this.pivotMarker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeReticleTexture(), depthTest: false, depthWrite: false, transparent: true, fog: false,
    }));
    this.pivotMarker.renderOrder = 20;
    this.pivotMarker.visible = false;
    this.scene.add(this.pivotMarker);

    // rubber-band rectangle for box-select (HTML overlay over the canvas)
    this.marqueeEl = document.createElement('div');
    this.marqueeEl.style.cssText =
      'position:absolute;border:1px solid #ffa23a;background:rgba(255,162,58,0.15);pointer-events:none;display:none;z-index:5';
    container.appendChild(this.marqueeEl); // #viewport is already position:absolute = a containing block

    // translate gizmo: attached to a selected node, it disables the orbit camera while a handle is dragged and
    // reports the moved position back through the host callbacks. Created before the shell's pointer listeners
    // so its hover fires first -> gizmo.axis is current when pointerDown reads it.
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.5);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', e => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.controls.enabled = !dragging;
      if (!dragging && this.gizmoKind === 'reference') this.cb.onMoveReference?.(); // drag ended: persist the offset
      this.onGizmoDrag(dragging);
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    // In the surface-corner frame, show only the four handles the spec calls for (tangent pad, normal arrow,
    // two in-plane arrows). Hide the vertical-plane pads (XY, YZ) and the free-move centre (XYZ) — free 3D is
    // the World / Shift escape hatch. TransformControls recomputes handle visibility each frame, so wrap the
    // helper's updateMatrixWorld to force our hides LAST, on both the drawn gizmo AND the invisible pickers.
    const gz = (this.gizmo as unknown as { _gizmo: { updateMatrixWorld(f?: boolean): void;
      gizmo: Record<string, THREE.Object3D>; picker: Record<string, THREE.Object3D> } })._gizmo;
    const hideNames = new Set(['XY', 'YZ', 'XYZ']);
    const arcs = createGizmoArcs(gz.gizmo.translate, gz.picker.translate);
    const baseUpdate = gz.updateMatrixWorld.bind(gz);
    gz.updateMatrixWorld = (force?: boolean) => {
      baseUpdate(force);
      // The same wrapper bends the two in-plane arrows along the rails the slide runs down (gizmo/arcs.ts), so what
      // the user pulls is the curve the corner takes. No rails — World mode, a knot, a corner region — no arcs.
      arcs.update(this.gizmoRestrict ? this.surfaceRails?.() ?? null : null);
      if (!this.gizmoRestrict) return;
      for (const grp of [gz.gizmo.translate, gz.picker.translate])
        for (const h of grp.children) if (hideNames.has(h.name)) h.visible = false;
    };
  }

  /** Set the shared raycaster from a client-space pointer event. */
  castAt(e: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    // Raycaster.setFromCamera changes origin/direction but retains any near/far from earlier bounded probes.
    // A pointer cast always spans the full view; callers that need a limited diagnostic ray use their own raycaster.
    this.ray.near = 0;
    this.ray.far = Infinity;
    this.ray.setFromCamera(this.pointer, this.camera);
  }

  /**
   * The authored-ground point under the CURRENT ray (cast it with `castAt` first), or null for a miss.
   * The `point` of {@link pickSurface} on `terrainMesh` — see it for how the cast resolves.
   *
   * Returns a fresh vector; callers may retain it.
   */
  groundHit(): THREE.Vector3 | null {
    return this.pickSurface(this.terrainMesh)?.point ?? null;
  }

  /**
   * The whole intersection with one surface mesh under the CURRENT ray (cast it with `castAt` first), or
   * null for a miss.
   *
   * A drop-in for `ray.intersectObject(mesh, false)[0]` — the same ray against the same triangles,
   * DoubleSide to match the terrain materials, reporting the same world-space `point`, seated `object`,
   * `faceIndex` (so `faceIndex / facesPerCell` still names the cell) and geometry-local flat `face.normal` —
   * but resolved through a cached BVH instead of a linear triangle walk. Hover paths call this on every
   * pointer move, where the stock walk measured 56 ms (an ~18 fps ceiling before anything is drawn) against
   * ~0.004 ms here. The tree indexes position + index only, so the hit carries no interpolated `uv` /
   * `normal`; a caller that needs those wants the stock cast.
   *
   * A stroke that is editing the surface it is picking keeps the same tree: an incremental re-emit moves the
   * quilt through the buffers the tree indexes, and the terrain layer refits it over exactly the patches that
   * moved (mesh/surface-trees.ts). `build` false is for a caller that would rather take the stock walk than
   * pay a cold tree build inside a gesture.
   *
   * Returns fresh objects; callers may retain them.
   */
  pickSurface(mesh: THREE.Mesh | null, build = true): THREE.Intersection | null {
    if (!mesh) return null;
    const bvh = pickTree(mesh.geometry as TreeGeometry, build);
    if (!bvh) return this.ray.intersectObject(mesh, false)[0] ?? null;
    mesh.updateWorldMatrix(true, false);
    this.pickInv.copy(mesh.matrixWorld).invert();
    this.pickLocalRay.copy(this.ray.ray).applyMatrix4(this.pickInv); // the BVH indexes geometry-local space
    const hit = bvh.raycastFirst(this.pickLocalRay, THREE.DoubleSide);
    if (!hit) return null;
    hit.point.applyMatrix4(mesh.matrixWorld);                    // local -> world, as a stock hit reports it
    hit.distance = this.ray.ray.origin.distanceTo(hit.point);    // ...and its distance measured there
    hit.object = mesh;
    return hit;
  }

  /** World units per screen pixel at a point (both projections), for screen-constant handle / nub sizing. */
  worldPerPixel(at: THREE.Vector3): number {
    const h = this.container.clientHeight || 1;
    if ((this.camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const pc = this.camera as THREE.PerspectiveCamera;
      return (2 * pc.position.distanceTo(at) * Math.tan((pc.fov * Math.PI / 180) / 2)) / h;
    }
    const oc = this.camera as THREE.OrthographicCamera;
    return (oc.top - oc.bottom) / oc.zoom / h;
  }

  /** Nearest world hit on the visible surfaces (terrain / loaded reference) under the cursor, or null. */
  pivotAt(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    this.castAt(e);
    const hit = this.ray.intersectObjects(this.pickTargets(), false)[0];
    return hit ? hit.point.clone() : null;
  }

  /** A point along the cursor ray at `dist` from the camera (pivot fallback when the ray hits nothing). */
  rayPoint(e: { clientX: number; clientY: number }, dist: number): THREE.Vector3 {
    this.castAt(e);
    return this.ray.ray.origin.clone().addScaledVector(this.ray.ray.direction, dist);
  }

  /** Intersect the current pointer ray with a screen-facing construction plane. By default the plane passes
   *  through the camera's navigation target; callers may pass an existing endpoint so a free-space chain stays
   *  at that endpoint's depth. The ray must already have been cast for the current pointer event. */
  screenPlanePoint(through: THREE.Vector3 = this.controls.target): THREE.Vector3 | null {
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
    return this.ray.ray.intersectPlane(plane, new THREE.Vector3());
  }

  // The pivot reticle was a diagnostic aid that flashed at the orbit / zoom / focus point; its call sites are
  // commented out. showPivot / scheduleHidePivot are kept, unused, so it's a one-line job to switch it back on.
  showPivot(p: THREE.Vector3) {
    clearTimeout(this.pivotTimer);
    this.pivotMarker.position.copy(p);
    const s = this.isOrtho && this.orthoCam
      ? (this.orthoHalfH / this.orthoCam.zoom) * 0.032
      : this.camera.position.distanceTo(p) * 0.016; // sprite quad size in world units → ~constant on screen
    this.pivotMarker.scale.setScalar(Math.max(0.6, s));
    this.pivotMarker.visible = true;
  }

  /** Hide the pivot marker shortly after the last wheel tick (orbit hides it explicitly on release). */
  scheduleHidePivot() {
    clearTimeout(this.pivotTimer);
    this.pivotTimer = window.setTimeout(() => { this.pivotMarker.visible = false; }, 450);
  }

  hidePivot() {
    clearTimeout(this.pivotTimer);
    this.pivotMarker.visible = false;
  }

  /** Seat the shared gizmo on a node. The corner re-frame + reference-selection drop are inverted out through
   *  `afterGizmoAttach` (the shell wires them to the corner-gizmo + reference layers). */
  attachGizmo(obj: THREE.Object3D, kind: GizmoKind, idx: number, dir = '') {
    this.gizmoKind = kind;
    this.gizmoKnot = idx;
    this.gizmoDir = dir;
    if (this.gizmo.object !== obj) this.gizmo.attach(obj);
    this.afterGizmoAttach(kind);
  }

  /** Hide the translate gizmo (nothing selected, or paint/sculpt mode). */
  detachGizmo() {
    this.gizmo.enabled = true; // clear any hover-gating so it never detaches in a stuck-disabled state
    this.gizmoRestrict = false; // nothing selected → the shared gizmo is unrestricted again
    if (this.gizmoKind === null && !this.gizmo.object) return;
    this.gizmoKind = null;
    this.gizmo.detach();
  }
}
