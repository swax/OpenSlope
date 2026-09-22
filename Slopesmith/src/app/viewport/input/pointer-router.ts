import * as THREE from 'three';
import type { QuadMeshDoc, V3 } from '../../../core/doc/types';
import { railHasTube } from '../../../core/rails/rails';
import type { MeshAdjacency } from '../../../core/mesh/topology';
import type { PreviewData } from '../../../core/mesh/tessellation';
import { makeTexRef, parseTexRef, resolveTerrainTexRef, type TexRef } from '../../../core/paint/textures';
import { orientFromPatchUV } from '../../../core/paint/orientation';
import type { ReferenceMesh } from '../../../core/reference/terrain';
import type { CreateEdgeEndpoint, MeshSelectionState, Mode, RefPropSurfaceDetails } from '../types';
import type { Stage } from '../stage';
import { vertexName } from '../../state/mesh-names';
import { constrainPlacement } from './placement-constraint';
import { dataToScene, sceneToData } from '../coordinates';
import type { CageHandleId, SelectionLayer } from '../mesh/selection';
import type { MeshComponentHit, MeshPicking } from './mesh-picking';
import type { ScenePicking } from './scene-picking';
import type { CageLayer } from '../mesh/cage';
import type { TransformLayer } from '../gizmo/transform';
import type { CameraController } from '../camera/controller';
import type { RideLayer } from '../scene/ride';
import type { SurgeryLayer } from '../tools/surgery';
import type { PatchToolLayer } from '../tools/create-patch';
import type { TubeToolLayer } from '../tools/create-tube';
import type { TrailToolLayer } from '../tools/create-trail';
import type { WeldToolLayer } from '../tools/weld';
import type { ClipboardPlacementLayer } from '../tools/clipboard-placement';
import type { EdgeExtrusionLayer } from '../tools/edge-extrusion';
import type { CreateEdgeLayer } from '../tools/create-edge';
import type { BridgePreviewLayer } from '../tools/bridge-preview';
import type { GemsLayer } from '../scene/gems';
import type { ScreensLayer } from '../scene/screens';
import type { PropsLayer } from '../scene/props';
import type { LightsLayer } from '../scene/lights';
import type { RailsLayer } from '../scene/rails';
import type { ReferenceDecor } from '../scene/reference-decor';
import type { PaintLayer } from '../mesh/paint';
import {
  referencePropHitFaceIndex, referencePropHitGeometry, referencePropHitSlot, type ReferencePropMesh,
} from '../scene/reference-prop-mesh';

/** The layer controllers a pointer gesture routes through — the router calls their pick / commit / hover /
 *  selection entry points in priority order; each layer owns its own scene objects and state. All exist
 *  before the router is constructed. */
export interface RouterLayers {
  selection: SelectionLayer;
  picking: MeshPicking;
  scenePicking: ScenePicking;
  cage: CageLayer;
  transforms: TransformLayer;
  cameraCtl: CameraController;
  rideCtl: RideLayer;
  surgery: SurgeryLayer;
  patchTool: PatchToolLayer;
  tubeTool: TubeToolLayer;
  trailTool: TrailToolLayer;
  weldTool: WeldToolLayer;
  clipboardPlacement: ClipboardPlacementLayer;
  edgeExtrusion: EdgeExtrusionLayer;
  createEdge: CreateEdgeLayer;
  bridgePreview: BridgePreviewLayer;
  gems: GemsLayer;
  screens: ScreensLayer;
  props: PropsLayer;
  lights: LightsLayer;
  rails: RailsLayer;
  refDecor: ReferenceDecor;
  paint: PaintLayer;
}

/** The narrow host state the dispatch reads: the active mode, the live mesh substrate (terrain / net /
 *  preview / reference), the tool toggles, and the snap / pick helpers the host still owns. */
export interface RouterAccess {
  mode(): Mode;
  isMountain(): boolean;
  terrain(): THREE.Mesh;
  reference(): THREE.Mesh | null;
  refData(): ReferenceMesh | null;
  refLevel(): string;
  preview(): PreviewData | null;
  net(): { positions: number[]; adj: MeshAdjacency } | null;
  /** The authored document, so a pick can name what it landed on (docs/039). */
  meshDoc(): QuadMeshDoc | null;
  netSpacing(): number;
  refSelected(): boolean;
  snapPoint(point: V3): V3;
  pickKnot(): THREE.Intersection | undefined;
  pickAnchor(): THREE.Intersection | undefined;
  /** Visible authored course-knot meshes, used by Info's screen-rectangle selection. */
  courseKnots(): readonly THREE.Object3D[];
  /** The Create Edge hover endpoint changed; the host relays it to its preview listener. */
  createEdgePreviewChanged(): void;
}

/** Host actions a pick resolves to: the whole-reference selection lives in the host (Info's movable). */
export interface RouterHostHooks {
  selectReference(): void;
  clearRefSelection(): void;
}

/**
 * The viewport's pointer / wheel input dispatch: the one place a raw DOM gesture becomes an editor action.
 * It owns the gesture state machine — the deferred clicks that become drags (props / Edit / touch-nav), the
 * box-select marquee, the paint / sculpt strokes and their brush footprint ring, the deferred RMB tile-rotate,
 * MMB paint-sample / prop-copy taps, and the gem row drag — routing each event through the mode's layers
 * (ride > camera > armed tools > selection). The layers own their scene objects and commits; the host owns
 * the mode, the mesh substrate and the whole-reference selection the router reaches back into
 * (`RouterAccess` / `RouterHostHooks`).
 */
export function createPointerRouter(stage: Stage, sel: MeshSelectionState, layers: RouterLayers, access: RouterAccess, host: RouterHostHooks) {
  let painting = false;
  let sculpting = false;
  let sculptDabbing = false;
  let sculptGrab: { plane: THREE.Plane; start: THREE.Vector3; center: THREE.Vector3 } | null = null;
  /** A middle-button press position: a Paint click samples, a Props click copies, and a drag pans. */
  let mmbDown: { x: number; y: number } | null = null;
  /** A deferred single-finger touch press in a nav mode: a drag orbits (custom ray-cast), a tap selects. */
  let touchNav: { x: number; y: number } | null = null;
  /** RMB remains the third-person look fallback only when no highlighted Play target consumes the press. */
  let rideOrbitMouse = false;
  // props select mode defers the LMB press: a still click selects on release, a drag becomes the marquee
  let propClickPending: { x: number; y: number } | null = null;
  // Info uses the same click-or-marquee contract for authored course knots.
  let infoClickPending: { x: number; y: number } | null = null;
  // mountain Edit (cage on) defers the LMB press the same way: a still click selects a control point / edge /
  // face / prop, while a drag resolves every enabled family. Modifiers survive pointer wobble/release.
  let editClickPending: { x: number; y: number; shift: boolean; ctrl: boolean } | null = null;
  let marquee: { x0: number; y0: number } | null = null;
  let marqueeKind: 'edit' | 'props' | 'knots' = 'edit'; // what the finished rectangle selects
  let marqueeSelectionMode: 'replace' | 'add' | 'remove' = 'replace';
  /** Surface under the initial vertex drag, used only to break a rectangle that encloses both mountains. */
  let marqueeVertexHint: 'authored' | 'reference' | null = null;
  let brushRadius = 60;
  /** Where the pointer is over the canvas, or nothing once it has left. Recorded rather than resolved: the
   *  only reader is awareness (docs/039), which wants a terrain point at its own rate rather than a ray cast
   *  on every move in every mode. */
  let pointerAt: { clientX: number; clientY: number } | null = null;

  /** Consume a positively identified mesh click when the active view has no action for it. Valid component
   * clicks continue into the view's normal handler; empty space is not an unsupported click. */
  function rejectUnsupportedMeshPick(enabled: (hit: MeshComponentHit) => boolean): boolean {
    const hit = layers.picking.pickMeshComponent();
    if (!hit || enabled(hit)) return false;
    stage.cb.onClickTargetUnavailable?.(hit.kind, hit.source);
    return true;
  }

  /** Ordinary Edit selection-family gate. Disabled hits are acknowledged but may fall through to the next
   * enabled family in the point > edge > patch precedence chain. */
  function editPickEnabled(kind: MeshComponentHit['kind']): boolean {
    return kind === 'vertex' ? sel.editPickKinds.point
      : kind === 'line' ? sel.editPickKinds.edge
      : sel.editPickKinds.patch;
  }

  function rejectUnsupportedPropPick(modelBanner = false, toggle = false): boolean {
    const pick = layers.scenePicking.pick({
      props: 'standard', occludeWithSurfaces: true, surfaceEpsilon: 1e-3,
    });
    if (pick?.target !== 'prop') return false;
    // Edit mode: a clicked authored placement acts — a MODEL piece enters its edit session, a
    // reference-library placement raises the revise banner (the host decides).
    if (modelBanner && pick.source === 'authored' && stage.cb.onEditPropPick?.(pick.propIndex, toggle)) return true;
    stage.cb.onClickTargetUnavailable?.('prop', pick.source);
    return true;
  }

  /** Test mode: a prop standing on the ride target is part of the mountain you are riding, so the point clicked
   * on it is an ordinary play point — the ride's contact probe seats a board on rideable prop faces exactly as
   * it does on terrain (ride/physics `probe`), which is what makes a start on a roof or a ramp a real start. A
   * prop on the OTHER mountain stays a rejected click, like the terrain under it. True = click consumed here. */
  function playPropPick(): boolean {
    const pick = layers.scenePicking.pick({
      props: 'standard', occludeWithSurfaces: true, surfaceEpsilon: 1e-3,
    });
    if (pick?.target !== 'prop') return false;
    if (pick.source !== layers.rideCtl.playTarget) {
      stage.cb.onClickTargetUnavailable?.('prop', pick.source);
      return true;
    }
    const p = pick.hit.point; // world space, like the terrain pick — the host decides what the point means
    stage.cb.onPlayClick?.([p.x, p.y, p.z]);
    return true;
  }

  /** The texture identity at a prop hit: the clicked material submesh's frame-zero tile + appearance
   *  details, stamped on the mesh by reference-decor / scene/props (a model with several textures
   *  resolves to exactly the one under the cursor). Null ref = that surface is untextured (neutral clay). */
  function propPickTex(hit: THREE.Intersection): { ref: TexRef | null; name: string;
    surface: RefPropSurfaceDetails | null } {
    const ud = hit.object.userData;
    const slot = referencePropHitSlot(hit);
    const tex = slot?.tex ?? (typeof ud.propTex === 'string' ? ud.propTex : null);
    const level = slot?.level ?? (typeof ud.propTexLevel === 'string' ? ud.propTexLevel : null);
    const surface = slot?.surface ?? (ud.propSurface as RefPropSurfaceDetails | undefined) ?? null;
    return tex && level ? { ref: makeTexRef(level, tex), name: tex, surface } : { ref: null, name: '', surface };
  }

  /** The connected face group around the clicked triangle: every triangle reachable through shared
   *  (welded) vertices. The prop weld is on (position, uv) pairs, so this is exactly the clicked UV
   *  ISLAND — one wall, one leaf quad, one mapped atlas region — not the whole material submesh (which,
   *  on a single-texture model, would be the entire model). Null falls back to the whole submesh. */
  function propPickFaceGroup(hit: THREE.Intersection): number[] | null {
    const geometry = referencePropHitGeometry(hit) ?? undefined;
    const faceIndex = referencePropHitFaceIndex(hit);
    const index = geometry?.getIndex();
    const triCount = index ? Math.floor(index.count / 3) : 0;
    if (!index || faceIndex == null || faceIndex < 0 || faceIndex >= triCount) return null;
    const trisOf = new Map<number, number[]>(); // vertex index → triangles touching it
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const v = index.getX(t * 3 + k);
        const arr = trisOf.get(v);
        if (arr) arr.push(t); else trisOf.set(v, [t]);
      }
    }
    const inGroup = new Set<number>([faceIndex]);
    const stack = [faceIndex];
    while (stack.length) {
      const t = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        for (const n of trisOf.get(index.getX(t * 3 + k)) ?? []) {
          if (!inGroup.has(n)) { inGroup.add(n); stack.push(n); }
        }
      }
    }
    return [...inGroup];
  }

  /** The clicked surface's deduped triangle edges in UV space — the palette draws them over the tile art
   *  so you can see how the surface maps onto the texture. `faces` limits it to the clicked face group
   *  (the UV island); null covers the whole submesh. Null result = the geometry carries no UVs. */
  function propPickUvEdges(hit: THREE.Intersection, faces: number[] | null): Float32Array | null {
    const geometry = referencePropHitGeometry(hit) ?? undefined;
    const uv = geometry?.getAttribute('uv');
    const index = geometry?.getIndex();
    if (!uv || !index) return null;
    const seen = new Set<number>();
    const out: number[] = [];
    const edge = (a: number, b: number) => {
      const key = a < b ? a * 16777216 + b : b * 16777216 + a; // vertex counts stay far below 2^24 (PS2 data)
      if (seen.has(key)) return;
      seen.add(key);
      out.push(uv.getX(a), uv.getY(a), uv.getX(b), uv.getY(b));
    };
    const triCount = Math.floor(index.count / 3);
    for (const t of faces ?? Array.from({ length: triCount }, (_, i) => i)) {
      const a = index.getX(t * 3), b = index.getX(t * 3 + 1), c = index.getX(t * 3 + 2);
      edge(a, b); edge(b, c); edge(c, a);
    }
    return out.length ? new Float32Array(out) : null;
  }

  /** Paint select mode: a click on a visible prop (terrain in front still wins) inspects the clicked
   *  SURFACE through onInspectPropTexture: the connected face group under the cursor gets the viewport
   *  outline and the palette its UV wireframe. Returns undefined when no prop was hit, null for an
   *  untextured prop surface, or its texture ref. */
  function inspectPropTextureAtPointer(): TexRef | null | undefined {
    const pick = layers.scenePicking.pick({
      props: 'standard', occludeWithSurfaces: true, surfaceEpsilon: 1e-3,
    });
    if (pick?.target !== 'prop') return undefined;
    const t = propPickTex(pick.hit);
    const faces = t.ref ? propPickFaceGroup(pick.hit) : null;
    if (t.ref) layers.refDecor.inspectSurface(pick.hit.object,
      pick.source === 'reference' ? pick.instanceId : 0, faces);
    else layers.refDecor.clearSurfaceInspection(); // untextured: the toast explains; nothing to mark
    stage.cb.onInspectPropTexture?.(t.ref, pick.source === 'reference' ? pick.name : pick.hit.object.name,
      t.surface, t.ref ? propPickUvEdges(pick.hit, faces) : null);
    return t.ref;
  }

  // Sculpt brush footprint: a unit circle scaled to brushRadius and aligned to the hovered surface tangent.
  const ringPts: THREE.Vector3[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ringPts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  const brushRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPts),
    new THREE.LineBasicMaterial({ color: 0x6ee7a8, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  brushRing.renderOrder = 10;
  brushRing.visible = false;
  stage.scene.add(brushRing);
  const brushUp = new THREE.Vector3(0, 1, 0);

  function sculptWorldNormal(hit: THREE.Intersection): THREE.Vector3 {
    const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? brushUp;
    if (normal.lengthSq() < 1e-10) normal.copy(brushUp); else normal.normalize();
    return normal;
  }

  function updateSculptRing(hit: THREE.Intersection) {
    brushRing.position.copy(hit.point); // scene-root world position
    const normal = sculptWorldNormal(hit);
    brushRing.quaternion.setFromUnitVectors(brushUp, normal);
    brushRing.scale.setScalar(brushRadius);
  }

  function sculptQuad(hit: THREE.Intersection): number | null {
    const preview = access.preview();
    return preview && hit.faceIndex != null ? Math.floor(hit.faceIndex / preview.facesPerCell) : null;
  }

  function sculptAt(hit: THREE.Intersection) {
    const quad = sculptQuad(hit);
    if (quad == null) return;
    const normal = sculptWorldNormal(hit);
    stage.cb.onSculpt(
      [hit.point.x, hit.point.y, -hit.point.z], quad,
      [normal.x, normal.y, -normal.z], // flipped world point/vector -> data
    );
  }

  function beginSculptDab(hit: THREE.Intersection): boolean {
    const quad = sculptQuad(hit);
    if (quad == null) return false;
    const normal = sculptWorldNormal(hit);
    stage.cb.onBeginSculpt(
      [hit.point.x, hit.point.y, -hit.point.z], quad,
      [normal.x, normal.y, -normal.z],
    );
    sculptDabbing = true;
    sculptAt(hit);
    return true;
  }

  function endSculptDab() {
    if (!sculptDabbing) return;
    sculptDabbing = false;
    stage.cb.onEndSculpt();
  }

  function beginSculptGrab(hit: THREE.Intersection): boolean {
    const quad = sculptQuad(hit);
    if (quad == null) return false;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      stage.camera.getWorldDirection(new THREE.Vector3()), hit.point,
    );
    sculptGrab = { plane, start: hit.point.clone(), center: hit.point.clone() };
    stage.cb.onBeginSculptGrab([hit.point.x, hit.point.y, -hit.point.z], quad);
    return true;
  }

  function updateSculptGrab() {
    if (!sculptGrab) return;
    const point = stage.ray.ray.intersectPlane(sculptGrab.plane, new THREE.Vector3());
    if (!point) return;
    const sceneDelta = point.sub(sculptGrab.start);
    brushRing.visible = true;
    brushRing.position.copy(sculptGrab.center).add(sceneDelta);
    stage.cb.onSculptGrab([sceneDelta.x, sceneDelta.y, -sceneDelta.z]);
  }

  function endSculptGrab() {
    if (!sculptGrab) return;
    sculptGrab = null;
    stage.cb.onEndSculptGrab();
  }

  // ---- wheel zoom (custom): the wheel routes to the camera controller, except over a placement ghost ----

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation(); // we own the wheel; don't let OrbitControls also zoom
    if (layers.rideCtl.riding) {
      layers.rideCtl.zoomThirdPersonWheel(e.deltaY, e.deltaMode);
      return; // a test ride owns the camera; first person deliberately consumes the wheel without zooming
    }
    if (layers.cameraCtl.flying) { layers.cameraCtl.trimFlySpeed(e.deltaY); return; } // fly mode: the wheel trims speed
    // loop-cut surgery: over a live ghost the wheel SLIDES the cut along the strip, like the placement wheel
    // turns a prop — it doesn't zoom. With no live ghost the layer declines, so the wheel zooms as usual.
    if (access.mode() === 'edit' && layers.surgery.onWheel(e)) return;
    // props placement: over the ghost the wheel adjusts the pending drop, not the camera — turn the held prop
    // (Shift = resize). Off the terrain (no ghost) it zooms as usual. Paint's brush turns on ← / → instead
    // (shortcuts.ts), so the wheel always zooms there.
    if (access.mode() === 'props' && layers.props.propArm && layers.props.propGhost?.visible) {
      if (e.shiftKey) layers.props.pendingScale = Math.min(5, Math.max(0.1, layers.props.pendingScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      else { layers.props.pendingYaw = (layers.props.pendingYaw + (e.deltaY < 0 ? 15 : -15) + 360) % 360; layers.props.yawManual = true; }
      layers.props.seatPropGhost();
      return;
    }
    layers.cameraCtl.wheelZoom(e);
  }

  function hideMarquee() { marquee = null; marqueeSelectionMode = 'replace'; stage.marqueeEl.style.display = 'none'; }

  function updateMarqueeRect(x1: number, y1: number) {
    if (!marquee) return;
    const x = Math.min(marquee.x0, x1), y = Math.min(marquee.y0, y1);
    stage.marqueeEl.style.left = `${x}px`;
    stage.marqueeEl.style.top = `${y}px`;
    stage.marqueeEl.style.width = `${Math.abs(x1 - marquee.x0)}px`;
    stage.marqueeEl.style.height = `${Math.abs(y1 - marquee.y0)}px`;
  }

  /** Finish one Edit marquee across every enabled mesh/prop family, choosing one mountain substrate. */
  function finishEditMarquee(mode: 'replace' | 'add' | 'remove' = 'replace') {
    const props = sel.editPickKinds.prop ? propsInMarquee() : [];
    layers.selection.finishEditMarquee(
      mode, marquee, marqueeVertexHint, props,
      layers.props.selectedProp !== null || layers.props.multiSelProps.length > 0,
    );
    marqueeVertexHint = null;
  }

  /** Doc indices of every placed prop whose ORIGIN projects inside the marquee rect (props box-select). */
  function propsInMarquee(): number[] {
    if (!marquee || !layers.props.placedPropGroup.visible) return [];
    const r = stage.container.getBoundingClientRect();
    const left = parseFloat(stage.marqueeEl.style.left), top = parseFloat(stage.marqueeEl.style.top);
    const right = left + parseFloat(stage.marqueeEl.style.width), bottom = top + parseFloat(stage.marqueeEl.style.height);
    const v = new THREE.Vector3();
    const out: number[] = [];
    for (let i = 0; i < layers.props.lastPlacedProps.length; i++) {
      const p = layers.props.lastPlacedProps[i].pos;
      v.set(p[0], p[1], -p[2]).project(stage.camera); // data pos; on-screen position is Z-flipped like the corners
      if (v.z < -1 || v.z > 1) continue; // behind the camera / beyond the far plane
      const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
      if (sx >= left && sx <= right && sy >= top && sy <= bottom) out.push(i);
    }
    return out;
  }

  /** Course indices whose visible knot handles project inside the Info-mode marquee. */
  function knotsInMarquee(): number[] {
    if (!marquee) return [];
    const knots = access.courseKnots();
    if (!knots.length) return [];
    const r = stage.container.getBoundingClientRect();
    const left = parseFloat(stage.marqueeEl.style.left), top = parseFloat(stage.marqueeEl.style.top);
    const right = left + parseFloat(stage.marqueeEl.style.width), bottom = top + parseFloat(stage.marqueeEl.style.height);
    const world = new THREE.Vector3();
    const out: number[] = [];
    for (const knot of knots) {
      knot.getWorldPosition(world);
      const projected = world.clone().project(stage.camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const sx = (projected.x * 0.5 + 0.5) * r.width, sy = (-projected.y * 0.5 + 0.5) * r.height;
      if (sx >= left && sx <= right && sy >= top && sy <= bottom) out.push(knot.userData.knot as number);
    }
    return out.sort((a, b) => a - b);
  }

  /** Select free light `i`: clear the other scene-object selections, then seat the gizmo on it. */
  function selectLight(i: number) {
    stage.cb.onSelectKnot(null);
    layers.selection.placeCornerMarker(null);
    host.clearRefSelection();
    layers.props.clearSelection(); // a light and a prop can't both be selected
    layers.refDecor.clearPropSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearRigSource();
    layers.rails.clearSelection();
    layers.gems.clearSelection();
    layers.screens.clearSelection();
    layers.lights.seatLight(i);
  }

  /** A source icon is an inspection selection: bulbs expand one rig, speakers expand one listener range. */
  function selectSourceMarker(source: 'authored' | 'reference', kind: 'light' | 'sound' | 'prop', index: number) {
    stage.cb.onSelectKnot(null);
    layers.selection.placeCornerMarker(null);
    host.clearRefSelection();
    layers.props.clearSelection();
    layers.refDecor.clearPropSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearSelection();
    layers.lights.clearRigSource();
    layers.rails.clearSelection();
    layers.gems.clearSelection();
    layers.screens.clearSelection();
    if (source === 'authored' && kind === 'light') layers.lights.selectRigSource(index);
    else if (source === 'reference') layers.refDecor.selectSource(kind, index);
  }

  /** Resolve the next edge endpoint: an existing corner wins, then any authored edge curve, then terrain,
   *  then a screen-facing free-space plane through the chain's previous endpoint (or the camera target). */
  function createEdgePlacement(axisLocked = false): CreateEdgeEndpoint | null {
    const cid = layers.picking.pickCorner();
    const cp = cid !== null ? layers.picking.cornerPos(cid) : null;
    let endpoint: CreateEdgeEndpoint | null = cp ? { pos: cp, vertex: cid } : null;
    const authoredEdge = !endpoint ? layers.picking.pickAnyEdgeAt() : null;
    if (authoredEdge && access.net()) {
      const closest = layers.picking.curveScreenClosest(authoredEdge[0], authoredEdge[1]);
      endpoint = { pos: closest.pos, vertex: null, edge: authoredEdge, t: Math.min(0.999, Math.max(0.001, closest.t)) };
    }
    const hit = !endpoint ? stage.pickSurface(access.terrain()) : null; // per pointer move — accelerated
    if (hit) {
      const preview = access.preview();
      const quad = hit.faceIndex != null && preview ? Math.floor(hit.faceIndex / preview.facesPerCell) : null;
      const edge = quad !== null ? layers.picking.pickEdgeAt(quad) : null;
      if (edge && access.net()) {
        const closest = layers.picking.curveScreenClosest(edge[0], edge[1]);
        endpoint = { pos: closest.pos, vertex: null, edge, t: Math.min(0.999, Math.max(0.001, closest.t)) };
      } else endpoint = { pos: access.snapPoint(sceneToData(hit.point)), vertex: null };
    }
    const start = layers.createEdge.start;
    if (!endpoint) {
      const point = stage.screenPlanePoint(start ? dataToScene(start) : undefined);
      endpoint = point ? { pos: access.snapPoint(sceneToData(point)), vertex: null } : null;
    }
    if (endpoint?.edge) return endpoint; // an edge contact must remain exactly on its host curve
    return endpoint ? constrainPlacement(endpoint, start, axisLocked) : null;
  }

  /** Commit the endpoint resolved by the same path that drives the hover ghost. */
  function createEdgeClick(axisLocked = false) {
    const endpoint = createEdgePlacement(axisLocked);
    if (endpoint) stage.cb.onCreateEdgePoint?.(endpoint);
  }

  /** Select rail `r` node `n`: clear the other scene-object selections, then seat the gizmo on the node
   *  (a rail node and a prop / light / gem / reference can't both be selected). */
  /** Select rail `r`, at node `n` or — with `null` — as a whole with no node gizmo (Effects inspection). */
  function selectRailNode(r: number, n: number | null) {
    stage.cb.onSelectKnot(null);
    layers.selection.placeCornerMarker(null);
    host.clearRefSelection();
    layers.props.clearSelection();
    layers.refDecor.clearPropSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearSelection();
    layers.lights.clearRigSource();
    layers.gems.clearSelection();
    layers.screens.clearSelection();
    if (n === null) layers.rails.seatRail(r); else layers.rails.seatNode(r, n);
  }

  /** Select gem `i`: clear the other scene-object selections, then seat the gizmo on it. */
  function selectGem(i: number) {
    stage.cb.onSelectKnot(null);
    layers.selection.placeCornerMarker(null);
    host.clearRefSelection();
    layers.props.clearSelection();
    layers.refDecor.clearPropSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearSelection();
    layers.lights.clearRigSource();
    layers.rails.clearSelection();
    layers.screens.clearSelection();
    layers.gems.seatGem(i);
  }

  /** Select a video screen: authored screens receive the gizmo; reference screens inspect read-only. */
  function selectScreen(source: 'authored' | 'reference', i: number) {
    stage.cb.onSelectKnot(null);
    layers.selection.placeCornerMarker(null);
    host.clearRefSelection();
    layers.props.clearSelection();
    layers.refDecor.clearPropSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearSelection();
    layers.lights.clearRigSource();
    layers.rails.clearSelection();
    layers.gems.clearSelection();
    if (source === 'authored') layers.screens.seatScreen(i);
    else layers.screens.seatReferenceScreen(i);
  }

  // ---- gem-tool pointer handling (input dispatch; the gem scene objects live in GemsLayer) ----

  /** Final authored gem position for a terrain hit: apply the tool's height, then the global grid snap. */
  function gemPlacementPoint(point: THREE.Vector3): V3 {
    return access.snapPoint([point.x, point.y + layers.gems.gemArmOpts.height, -point.z]);
  }

  /** Gem-tool press (mouse): pick a gem to select it, else begin a drag-to-row on the terrain (deferred to
   *  pointerUp — a stationary release drops one gem, a dragged release lays a spaced row). */
  function gemPointerDown(e: PointerEvent) {
    const pick = layers.scenePicking.pick({ gems: true, surfaces: 'authored' });
    if (pick?.target === 'gem') { selectGem(pick.gemIndex); return; }
    if (pick?.target !== 'surface') { layers.gems.clearSelection(); stage.cb.onSelectGem?.(null); return; }
    const p = gemPlacementPoint(pick.hit.point);
    layers.gems.gemLine = { start: p, end: p };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  /** Gem-row drag move: track the current ground end + draw the preview line. */
  function gemPointerMove(e: PointerEvent) {
    if (!layers.gems.gemLine) return;
    stage.castAt(e);
    const ground = stage.pickSurface(access.terrain()); // per pointer move — accelerated
    if (!ground) return;
    layers.gems.gemLine.end = gemPlacementPoint(ground.point);
    const a = layers.gems.gemLine.start, b = layers.gems.gemLine.end;
    layers.gems.gemLinePreview.geometry.setFromPoints([new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2])]);
    layers.gems.gemLinePreview.visible = true;
    layers.gems.updateGemGhost(); // the ghost tracks the row's far end while dragging
  }

  /** Gem-row drag release: a stationary release drops one gem; a dragged release lays a spaced row. */
  function gemPointerUp(e: PointerEvent) {
    const line = layers.gems.gemLine;
    layers.gems.gemLine = null;
    layers.gems.gemLinePreview.visible = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (!line) return;
    const a = line.start, b = line.end;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (len < 3) stage.cb.onPlaceGem?.(a);            // barely moved → a single gem
    else stage.cb.onPlaceGemLine?.(a, b);             // dragged → a spaced row between the ends
  }

  /** Props-mode middle-click copy: pick up whatever prop is under the cursor — a placed
   *  prop (arm its model to place more) or a reference-world prop (arm a copy). Nearest hit wins. */
  function pickPropAtPointer() {
    const pick = layers.scenePicking.pick({ props: 'standard' });
    if (pick?.target !== 'prop') return;
    if (pick.source === 'authored') stage.cb.onPickPlacedProp?.(pick.propIndex);
    else stage.cb.onPickReferenceProp?.(pick.level, pick.model, pick.name, pick.sourceIndex);
  }

  /** Props mode click. Placing (a prop armed): commit the ghost's pose on the terrain, nothing else is
   *  pickable. Select (nothing armed): whatever's nearest under the cursor wins — an authored/reference prop,
   *  light, rail node, gem, or bare terrain — closest-hit so it reads like "click what you see". MMB copies a
   *  prop instead of selecting it. */
  function pickOrPlaceProp() {
    // rail drawing: a terrain click appends a height-adjusted, grid-snapped node; nothing else
    // is pickable while laying a rail, so the flow stays a straight chain of clicks.
    if (layers.rails.railArmed) {
      if (rejectUnsupportedMeshPick(hit => hit.kind === 'surface' && hit.source === 'authored')) return;
      const hit = stage.ray.intersectObject(access.terrain(), false)[0];
      const rail = layers.rails.selectedRail === null ? null : layers.rails.rails[layers.rails.selectedRail];
      if (hit && rail) stage.cb.onAppendRailNode?.(access.snapPoint([hit.point.x, hit.point.y + rail.height, -hit.point.z]));
      return;
    }

    // Placement mode owns LMB until Esc puts the held prop down; scene-object selection resumes afterward.
    if (layers.props.propArm) {
      // Use the ghost's ground picker: its refit tree follows terrain edits while a stock raycast can
      // reject that same visible surface against old render bounds. Resolve anew so a miss can't stamp
      // the previous hover position (and touch placement doesn't need a preceding mouse move).
      const hit = stage.groundHit();
      if (hit) {
        stage.cb.onPlaceProp?.(layers.props.seatedDropPos(hit), layers.props.pendingYaw, layers.props.pendingScale);
        if (!layers.props.yawManual) layers.props.pendingYaw = Math.random() * 360;
      }
      layers.props.propGhostHit = hit;
      layers.props.seatPropGhost(); // show the next drop's turn, or hide a preview no longer over terrain
      return;
    }

    // Source icons are screen-space overlay controls, so a deliberate icon click wins even when its world
    // position is behind the prop/terrain it annotates.
    const sourcePick = layers.scenePicking.pick({ sources: true, screenMarkers: true });
    if (sourcePick?.target === 'screen') {
      selectScreen(sourcePick.source, sourcePick.screenIndex); return;
    }
    if (sourcePick?.target === 'source') {
      selectSourceMarker(sourcePick.source, sourcePick.sourceKind, sourcePick.sourceIndex); return;
    }
    const pick = layers.scenePicking.pick({
      props: 'standard', lights: true, rails: true, gems: true, screens: true,
      surfaces: true, surfaceEpsilon: 1e-3,
    });

    // nearest under the cursor decides the action (a reference prop selects READ-ONLY — MMB picks it up)
    if (pick?.target === 'gem') { selectGem(pick.gemIndex); return; }
    // A screen sits a hand's width proud of the board it covers, so it wins the click there — which is what
    // makes an attached screen editable at all (the board behind it would otherwise always be nearer).
    if (pick?.target === 'screen') { selectScreen(pick.source, pick.screenIndex); return; }
    if (pick?.target === 'light') { selectLight(pick.lightIndex); return; }
    if (pick?.target === 'prop' && pick.source === 'authored') { selectProp(pick.propIndex); return; }
    if (pick?.target === 'prop' && pick.source === 'reference') {
      selectReferenceProp(pick.instance, pick.instanceId); return;
    }
    // Authored only: a shipped level's grind curve is drawn for Effects mode and is not a thing Props edits
    // (its guide layer is hidden here anyway, so this is the type narrowing catching up with the visibility).
    if (pick?.target === 'rail' && pick.source === 'authored') {
      // a node bulb resolves its exact node; a hit on the tube grabs the node nearest the click
      const p = pick.hit.point;
      selectRailNode(pick.railIndex, pick.railNode
        ?? layers.rails.nearestNodeOnRail(pick.railIndex, [p.x, p.y, -p.z]));
      return;
    }
    if (pick?.target === 'surface') {
      const placementEnabled = layers.gems.gemArmed || layers.lights.lightArmed;
      if (rejectUnsupportedMeshPick(hit => placementEnabled && hit.kind === 'surface' && hit.source === 'authored')) return;
      const p: V3 = [pick.hit.point.x, pick.hit.point.y, -pick.hit.point.z];
      if (layers.gems.gemArmed) { stage.cb.onPlaceGem?.(gemPlacementPoint(pick.hit.point)); return; } // touch tap
      if (layers.lights.lightArmed) { stage.cb.onPlaceLight?.(p); return; }
    }
    // Bare mesh components are not selectable in Props view. Keep the current scene-object selection intact
    // and acknowledge the exact component instead of treating it as an empty-space deselect.
    if (rejectUnsupportedMeshPick(() => false)) return;
    layers.props.clearSelection();
    layers.refDecor.clearPropSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearSelection();
    layers.lights.clearRigSource();
    layers.rails.clearSelection();
    layers.gems.clearSelection();
    layers.screens.clearSelection();
    stage.cb.onSelectProp?.(null);
    stage.cb.onSelectLight?.(null);
    stage.cb.onSelectRailNode?.(null, null);
    stage.cb.onSelectGem?.(null);
    stage.cb.onSelectScreen?.(null);
  }

  /** Effects mode click: select an attached effect when the nearest visible scene object is its host. Other
   * scene objects keep the standard unavailable-target toast; terrain/empty space clears the effect selection. */
  function pickAttachedEffect(additive = false) {
    const pick = layers.scenePicking.pick({
      props: 'effects', lights: true, rails: true, gems: true, knots: true,
      particleVolumes: true,
      surfaces: true, surfaceEpsilon: 1e-3,
    });
    if (pick && pick.target !== 'surface') {
      if (pick.target === 'particleVolume') {
        stage.cb.onSelectParticleVolume?.(pick.source, pick.volumeIndex, pick.volumeId);
        return;
      }
      // Every spline answers here rather than only the ones Effects mode owns, and the TUBE decides how. A
      // curve with no tube — a motion path, or a bare grind rail — has no geometry in Props mode to send an
      // author to, so the click seats a node to drag. A piped rail belongs to Props, but it is what a rail
      // toggle and a mover NAME, so clicking one in the mode that switches it reports that join instead of
      // sending the author away to a mode that knows nothing about it (docs/026).
      // A shipped level's grind curve is the only place that rail exists — its tube is an unjoined instance —
      // so clicking one inspects the spline itself rather than reporting an unavailable target.
      if (pick.target === 'rail' && pick.source === 'reference') {
        stage.cb.onSelectReferenceSpline?.(pick.splineIndex);
        return;
      }
      if (pick.target === 'rail' && layers.rails.rails[pick.railIndex]) {
        const p = pick.hit.point;
        selectRailNode(pick.railIndex, railHasTube(layers.rails.rails[pick.railIndex]) ? null
          : pick.railNode ?? layers.rails.nearestNodeOnRail(pick.railIndex, [p.x, p.y, -p.z]));
        return;
      }
      if (pick.target !== 'prop') {
        stage.cb.onClickTargetUnavailable?.(pick.target === 'source' ? 'light' : pick.target, pick.source);
        return;
      }
      if (pick.source === 'authored') {
        const selected = stage.cb.onSelectEffectProp?.(pick.propIndex, additive) ?? false;
        if (!selected) stage.cb.onClickTargetUnavailable?.('prop', 'authored');
        return;
      }
      const selected = pick.sourceIndex !== undefined
        ? stage.cb.onSelectReferenceEffectProp?.(pick.sourceIndex, additive) ?? false : false;
      if (!selected) stage.cb.onClickTargetUnavailable?.('prop', 'reference');
      return;
    }
    stage.cb.onClearEffectSelection?.();
  }

  /** Select placed prop `i`: clear the other scene-object selections, then seat the gizmo on it. */
  function selectProp(i: number) {
    stage.cb.onSelectKnot(null);
    layers.selection.placeCornerMarker(null);
    layers.refDecor.clearSurfaceInspection();
    host.clearRefSelection();
    layers.refDecor.clearPropSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearSelection(); // a prop and a light can't both be selected
    layers.lights.clearRigSource();
    layers.rails.clearSelection();
    layers.gems.clearSelection();
    layers.screens.clearSelection();
    layers.props.seatProp(i);
  }

  /** Select a reference prop READ-ONLY: outline the clicked instance (every submesh of its model, seated by
   *  the instance's own matrix) and tell the host, which shows it in the preview card. No gizmo — the
   *  reference can't be edited; a middle-click picks the model up to place a copy instead. */
  function selectReferenceProp(im: ReferencePropMesh, instanceId: number) {
    stage.cb.onSelectKnot(null);
    layers.selection.placeCornerMarker(null);
    layers.refDecor.clearSurfaceInspection();
    host.clearRefSelection();
    // The reference-selection callback mirrors this mutual exclusion into host state in one pass. Calling
    // every individual null-selection callback here would schedule several full document rebuilds before the
    // read-only prop could show its outline/details.
    layers.props.clearSelection();
    layers.refDecor.clearSourceSelection();
    layers.lights.clearSelection();
    layers.lights.clearRigSource();
    layers.rails.clearSelection();
    layers.gems.clearSelection();
    layers.screens.clearSelection();
    layers.refDecor.selectPropInstance(im, instanceId); // seat the read-only outline + notify the host
  }

  /**
   * Double-click to focus: frame whatever is under the cursor — a course knot (with a little context), the
   * whole loaded reference, or the clicked spot on the terrain. Skipped in paint / sculpt (a double-click
   * there is part of the stroke). The camera keeps its current angle and just retargets + dollies in.
   */
  function onDoubleClick(e: MouseEvent) {
    if (layers.rideCtl.riding) return; // a test ride owns input
    if (access.mode() === 'paint' || access.mode() === 'sculpt') return;
    if (access.mode() === 'edit' && layers.createEdge.armed) return; // endpoint clicks own the gesture; Enter/Esc finishes
    stage.castAt(e);
    const preview = access.preview(), reference = access.reference(), refData = access.refData();
    // Edit + cage: on the authored net a double-click near a control-net edge selects its whole EDGE-loop
    // (the complete perimeter when that edge is on a boundary; the straight-through loop otherwise), and
    // one into the open face its FACE-loop strip (not a camera focus); the read-only reference does the edge-loop.
    // A knot under the cursor still focuses (checked first) — knots sit above the terrain the loop pick raycasts.
    if (access.mode() === 'edit' && layers.cage.cage && !access.pickKnot()) {
      let filteredNoticeSent = false;
      const filtered = (kind: MeshComponentHit['kind'], source: MeshComponentHit['source']) => {
        if (editPickEnabled(kind)) return false;
        if (!filteredNoticeSent) stage.cb.onClickTargetUnavailable?.(kind, source);
        filteredNoticeSent = true;
        return true;
      };
      const nearest = layers.picking.pickMeshComponent();
      if (nearest) filtered(nearest.kind, nearest.source);
      if (access.isMountain() && preview) {
        const freeEdge = layers.picking.pickFreeEdgeAt();
        if (freeEdge) {
          if (!filtered('line', 'authored')) {
            layers.edgeExtrusion.setSideHint(null); stage.cb.onSelectEdgeLoop?.(freeEdge, e.shiftKey); return;
          }
        }
        const hit = stage.ray.intersectObject(access.terrain(), false)[0];
        if (hit && hit.faceIndex != null) {
          const quad = Math.floor(hit.faceIndex / preview.facesPerCell);
          const edge = layers.picking.pickEdgeAt(quad);
          if (edge) {
            if (!filtered('line', 'authored')) {
              layers.edgeExtrusion.setSideHint(quad); stage.cb.onSelectEdgeLoop?.(edge, e.shiftKey); return;
            }
          } // edge-loop, skip the focus
          if (!filtered('surface', 'authored')) {
            stage.cb.onSelectCellLoop?.(quad, e.shiftKey); return;            // face double-click → the face-loop strip
          }
        }
        const edge = stage.isOrtho ? layers.picking.pickAnyEdgeAt() : null;
        if (edge) {
          if (!filtered('line', 'authored')) {
            layers.edgeExtrusion.setSideHint(null); stage.cb.onSelectEdgeLoop?.(edge, e.shiftKey); return;
          }
        } // edge-on ortho: no face ray to seed the loop
      }
      if (reference && refData) {
        const re = layers.picking.pickRefEdge();
        if (re) {
          if (!filtered('line', 'reference')) {
            layers.selection.clearRefCells(); layers.selection.clearRefVertices(); layers.selection.refEdgeSelect(re, e.shiftKey ? 'loopAdd' : 'loop'); return;
          }
        } // edge-loop
        const rp = layers.picking.pickRefPatch();
        if (rp !== null) {
          if (!filtered('surface', 'reference')) {
            layers.selection.clearRefEdges(); layers.selection.clearRefVertices(); layers.selection.refCellLoop(rp, e.shiftKey); return;
          }
        } // patch double-click → the face-loop strip
      }
      if (filteredNoticeSent) return;
    }
    let center: THREE.Vector3 | null = null, radius = 0;
    const knotHit = access.pickKnot();
    if (knotHit) {
      center = knotHit.point.clone(); radius = Math.max(60, access.netSpacing() * 2);
    } else {
      // frame the CLICKED SPOT on whichever surface is nearer under the cursor (reference or authored terrain) —
      // NOT the whole reference bbox, which read as a jarring zoom-out on a double-click meant to inspect a patch.
      const refHit = reference && refData ? stage.ray.intersectObject(reference, false)[0] : undefined;
      const terrHit = stage.ray.intersectObject(access.terrain(), false)[0];
      const hit = refHit && (!terrHit || refHit.distance <= terrHit.distance) ? refHit : terrHit;
      if (hit) { center = hit.point.clone(); radius = Math.max(100, access.netSpacing() * 3); }
    }
    if (!center) return; // double-clicked empty space — leave the camera be
    layers.cameraCtl.frameSphere(center, radius);
    // stage.showPivot(center.clone()); stage.scheduleHidePivot(); // pivot reticle disabled — was a diagnostic aid (see showPivot)
  }

  function pointerDown(e: PointerEvent) {
    if (layers.rideCtl.riding) {
      // The following MouseEvent owns desktop actions. Unlike Pointer Events it emits once per changed button,
      // and using both streams would start an RMB grab here then reinterpret the compatibility mousedown as look.
      if (e.pointerType === 'mouse') e.stopPropagation();
      return; // no editor picking / camera while the ride owns input
    }
    // A missed release used to make the old marquee win every later pointerup, so clicking empty space could
    // never clear it. A new press is definitive proof that any previous deferred selection gesture is stale.
    if (propClickPending || infoClickPending || editClickPending || marquee) cancelSelectionDrag();
    layers.cameraCtl.activePointers.add(e.pointerId);
    if (e.pointerType === 'touch') layers.cameraCtl.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // a second finger = two-finger navigate: drop any single-finger stroke / orbit and hand off to
    // OrbitControls' pinch-zoom / pan (see cancelStroke; controls stay enabled for touch), with our own
    // twist overlay armed on top — fingers rotating around each other yaw the view (applyTwist).
    if (e.pointerType === 'touch' && layers.cameraCtl.activePointers.size > 1) {
      cancelStroke();
      layers.cameraCtl.twist = layers.cameraCtl.touchPts.size === 2 ? layers.cameraCtl.beginTwist() : null; // exactly two fingers can twist
      return;
    }

    // Test mode: a LMB / single-finger tap on the target mountain drops an AI rider there — or places the ride
    // start, if the panel armed that (the host decides; see onPlayClick). Its props count as the mountain they
    // stand on, so a click on one is that same play point. RMB / MMB still navigate.
    if (access.mode() === 'play' && (e.pointerType === 'touch' || (e.button === 0 && !e.altKey))) {
      stage.castAt(e);
      if (playPropPick()) return;
      const surfaceSource = layers.picking.vertexSourceAtPointer();
      if (rejectUnsupportedMeshPick(() => surfaceSource === layers.rideCtl.playTarget)) return;
      layers.rideCtl.pickPlaySurface(); return;
    }
    // desktop camera: RMB = orbit around the cursor's surface hit; Alt+RMB = fly look + WASD.
    if (e.pointerType !== 'touch') {
      if (e.button === 2) {
        if (e.altKey) { layers.cameraCtl.startFly(e); return; } // Alt+RMB: fly look + WASD
        layers.cameraCtl.startOrbit(e); return;
      }
      // MMB pans on drag; a stationary Paint click selects/arms a texture and a Props click picks up a prop.
      if (e.button === 1) { layers.cameraCtl.seatTargetAhead(); mmbDown = access.mode() === 'paint' || access.mode() === 'props' ? { x: e.clientX, y: e.clientY } : null; }
    }
    if (e.button !== 0) return; // MMB (pan) handled by OrbitControls; ignore here
    // a press on a gizmo handle is the gizmo's to drive (it set .axis on the preceding hover) - defer to
    // it. But not when hover-gating disabled the gizmo because the cursor is over a tangent nub: nubs
    // win over the corner's gizmo handles underneath them, so let the press fall through to the nub.
    if (stage.gizmo.enabled && stage.gizmo.axis) return;
    const touch = e.pointerType === 'touch';
    stage.castAt(e);

    if (access.mode() === 'sculpt' && rejectUnsupportedPropPick()) return;
    // Paint: without a brush, LMB on a prop inspects its clicked submesh without arming it. With a brush
    // armed the click rejects instead — a mis-tap on an overhanging prop must not repaint the terrain.
    if (access.mode() === 'paint') {
      if (layers.paint.paintArm) { if (rejectUnsupportedPropPick()) return; }
      else if (inspectPropTextureAtPointer() !== undefined) return;
    }

    // Surface-driven views treat point / edge overlays as transparent when a valid surface lies under them.
    // Only a component with no usable surface underneath is acknowledged as unsupported. Sculpt remains
    // authored-only; unarmed Paint may inspect the reference but cannot apply a brush to it.
    const surfaceSource = layers.picking.vertexSourceAtPointer();
    if (access.mode() === 'paint' && rejectUnsupportedMeshPick(() => surfaceSource === 'authored'
      || (surfaceSource === 'reference' && !layers.paint.paintArm))) return;
    if (access.mode() === 'sculpt'
      && rejectUnsupportedMeshPick(() => surfaceSource === 'authored')) return;

    if (access.mode() === 'paint') {
      // reaching here means the click did NOT land on a prop — any inspected-submesh outline is stale
      layers.refDecor.clearSurfaceInspection();
      if (layers.paint.paintArm) { // placement mode: left button places the active tile (drag = a stroke of them)
        painting = paintAtPointer();
        if (painting && !touch) stage.controls.enabled = false;
      } else layers.paint.paintSelectAtPointer(e.shiftKey); // select/inspect only; MMB or the panel button arms it
      return;
    }

    if (access.mode() === 'sculpt') {
      const hit = stage.pickSurface(access.terrain()); // the tree is warm from the hover the press landed on
      if (hit) {
        const grab = stage.cb.isGrabBrush();
        sculpting = grab ? beginSculptGrab(hit) : beginSculptDab(hit);
        if (!touch) { stage.controls.enabled = false; (e.target as Element).setPointerCapture(e.pointerId); }
        updateSculptRing(hit);
      }
      return;
    }

    // nav modes (Info / Edit): a single finger defers — a drag orbits around the touched surface point (the
    // custom ray-cast orbit, same as desktop RMB), a stationary tap selects on release (see pointerUp), so
    // picking a knot / corner still works. A mouse click selects immediately.
    if (touch) { touchNav = { x: e.clientX, y: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); return; }
    // Info: defer the press so a still click keeps ordinary knot/reference selection while a drag can
    // rubber-band several authored course knots for bulk deletion.
    if (access.mode() === 'info') {
      infoClickPending = { x: e.clientX, y: e.clientY };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    // Gem tool (mouse): drag-aware — a press selects a gem or begins a row on the terrain (committed on release).
    if (access.mode() === 'props' && layers.gems.gemArmed) { gemPointerDown(e); return; }
    // props select mode (nothing armed): defer the press — a still click selects on release (pointerUp),
    // a drag past the tap threshold rubber-bands a multi-selection instead (see pointerMove).
    if (access.mode() === 'props' && !layers.props.propArm && !layers.rails.railArmed && !layers.lights.lightArmed) {
      propClickPending = { x: e.clientX, y: e.clientY };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    // Clipboard paste: one terrain or construction-plane click commits the hovering copy, then disarms it.
    if (access.mode() === 'edit' && layers.clipboardPlacement.active) { layers.clipboardPlacement.onCommit(); return; }
    // loop-cut surgery (docs/017): a left click commits the previewed cut (the ghost the hover built) and
    // stays armed for another. The click IS the commit — no corner select / box-select deferral.
    if (access.mode() === 'edit' && layers.surgery.onCommit()) return;
    // Create Tube: collect its two axis endpoints; the panel controls derive a live quad shell from them.
    if (access.mode() === 'edit' && layers.tubeTool.active) { layers.tubeTool.onCommit(e.shiftKey); return; }
    // Create Trail: each click extends the centre spline; Enter commits the generated two-patch ribbon.
    if (access.mode() === 'edit' && layers.trailTool.active) { layers.trailTool.onCommit(e.shiftKey); return; }
    // Create patch: collect four terrain / free-space / existing-vertex corners, then append and disarm.
    if (access.mode() === 'edit' && layers.patchTool.active) { layers.patchTool.onCommit(e.shiftKey); return; }
    // target-weld gesture (docs/023 S4): a left click picks the FROM vertex, the next the INTO survivor, then
    // fuses via onWeld. The click IS the pick — no corner select / box-select deferral.
    if (access.mode() === 'edit' && layers.weldTool.active && layers.weldTool.onCommit()) return;
    // mountain Edit with the cage on: defer the press like props — a still click selects the corner / knot /
    // nub on release (Shift = range), a drag past the tap threshold rubber-bands a box-selection of corners
    // (see pointerMove). A press that landed on a gizmo handle already returned above, so this never steals a
    // gizmo drag. Create Edge skips the deferral: a click drops its next endpoint immediately.
    if (access.mode() === 'edit' && access.isMountain() && layers.cage.cage && !layers.createEdge.armed) {
      editClickPending = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      marqueeVertexHint = layers.picking.vertexSourceAtPointer();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    selectAtPointer(e.shiftKey, e.ctrlKey || e.metaKey);
  }

  /** A click / tap in a nav mode (Info or Edit): select what's under the cursor (the ray must already be
   *  cast). In Info it highlights for the Scene tree — and seats the translate gizmo on Info's movables:
   *  a course knot, or the reference body's centre handle; in Edit it seats the gizmo on the picked
   *  knot / tangent nub / corner, or clears the selection over empty space. */
  function selectAtPointer(shift = false, ctrl = false) {
    // loop-cut surgery owns the click via surgery.onCommit (pointerDown); a touch tap reaches here with no
    // hover preview to commit, so swallow it rather than fall through to corner selection.
    if (access.mode() === 'edit' && layers.surgery.tool) return;
    // Clipboard-paste touch tap (mouse is handled in pointerDown).
    if (access.mode() === 'edit' && layers.clipboardPlacement.active) { layers.clipboardPlacement.onCommit(); return; }
    // Create patch touch tap (mouse is handled in pointerDown).
    if (access.mode() === 'edit' && layers.patchTool.active) { layers.patchTool.onCommit(shift); return; }
    // Create Tube touch tap (mouse is handled in pointerDown).
    if (access.mode() === 'edit' && layers.tubeTool.active) { layers.tubeTool.onCommit(shift); return; }
    // Create Trail touch tap (mouse is handled in pointerDown).
    if (access.mode() === 'edit' && layers.trailTool.active) { layers.trailTool.onCommit(shift); return; }
    // target-weld gesture (docs/023 S4): a touch tap reaches here (mouse is handled in pointerDown); pick FROM / INTO.
    if (access.mode() === 'edit' && layers.weldTool.active && layers.weldTool.onCommit()) return;
    // props mode: place the armed prop at its ghost, or (select mode) grab what's under the cursor / clear.
    // Runs for a mouse click (pointerDown) and a touch tap (pointerUp).
    if (access.mode() === 'props') { pickOrPlaceProp(); return; }
    if (access.mode() === 'effects') {
      if (layers.rails.railArmed) pickOrPlaceProp();
      else pickAttachedEffect(ctrl);
      return;
    }

    if (access.mode() === 'edit' && layers.createEdge.armed) { createEdgeClick(shift); return; }

    let filteredNoticeSent = false;
    const filteredEditPick = (kind: MeshComponentHit['kind'], source: MeshComponentHit['source']) => {
      if (editPickEnabled(kind)) return false;
      if (!filteredNoticeSent) stage.cb.onClickTargetUnavailable?.(kind, source);
      filteredNoticeSent = true;
      return true;
    };

    if (access.mode() === 'edit') {
      const coincident = layers.createEdge.pickCoincidentVertices();
      if (coincident) {
        if (!filteredEditPick('vertex', 'authored')) {
          // A diagnostic is extra information about an ordinary mesh selection, not a replacement for it.
          // Route one of the real coincident IDs through the normal corner callback; the host expands it to the
          // whole coincident group and seats the shared move gizmo while retaining the warning/action panel.
          layers.selection.clearRefLoops();
          stage.cb.onSelectCoincidentVertices?.(coincident);
          const vertex = layers.picking.pickCorner() ?? coincident.vertices[0] ?? null;
          if (vertex !== null) {
            stage.cb.onSelectKnot(null);
            layers.selection.placeCornerMarker(vertex);
            stage.attachGizmo(layers.selection.cornerMarker, 'corner', vertex);
            stage.cb.onSelectCorner(vertex);
          }
          return;
        }
      }
      const crossing = layers.createEdge.pickEdgeCrossing();
      if (crossing) {
        if (!filteredEditPick('line', 'authored')) {
          layers.selection.clearRefLoops();
          stage.cb.onSelectEdgeCrossing?.(crossing);
          // A third-party/T-junction vertex can occupy the same screen point as an unresolved edge crossing.
          // Keep it movable. A pure interior edge/edge crossing has no vertex to attach to until it is welded.
          const vertex = layers.picking.pickCorner();
          if (vertex !== null) {
            stage.cb.onSelectKnot(null);
            layers.selection.placeCornerMarker(vertex);
            stage.attachGizmo(layers.selection.cornerMarker, 'corner', vertex);
            stage.cb.onSelectCorner(vertex);
          } else {
            stage.detachGizmo();
            layers.selection.placeCornerMarker(null);
            stage.cb.onSelectCorner(null);
          }
          return;
        }
      }
      stage.cb.onSelectEdgeCrossing?.(null);
      stage.cb.onSelectCoincidentVertices?.(null);
    }

    const reference = access.reference(), refData = access.refData();
    // Info mode: select a knot / the reference / the mountain body so it highlights in the scene tree.
    // The terrain stays read-only here, but Info's own objects move: a course knot seats the translate
    // gizmo (the run line is Info's document — its drag reroutes the exported spawn/respawn/race line),
    // and clicking the reference body reveals the centre move handle + gizmo so the whole world can be
    // slid clear of the authored mountain.
    if (access.mode() === 'info') {
      const sourcePick = layers.scenePicking.pick({ sources: true });
      if (sourcePick?.target === 'source') {
        selectSourceMarker(sourcePick.source, sourcePick.sourceKind, sourcePick.sourceIndex);
        return;
      }
      // Clicking away from an overlay marker returns Info to its ordinary scene selection and drops the
      // selected rig/range plus any sound emitter's owning-prop context.
      layers.refDecor.clearPropSelection();
      layers.lights.clearRigSource();
      // Start/finish flags before knots: the start flag floats over knot 0 on an untouched run.
      const anchorHit = access.pickAnchor();
      if (anchorHit) {
        host.clearRefSelection();
        stage.cb.onSelectKnot(null);
        stage.attachGizmo(anchorHit.object as THREE.Mesh, 'anchor', 0);
        return;
      }
      const knotHit = access.pickKnot();
      if (knotHit) {
        host.clearRefSelection();
        const idx = knotHit.object.userData.knot as number;
        stage.cb.onSelectKnot(idx);
        stage.attachGizmo(knotHit.object as THREE.Mesh, 'knot', idx); // drag it with the translate gizmo
        return;
      }
      if (rejectUnsupportedPropPick()) return;
      // Info handles a terrain body / reference surface as a Scene selection, but has no vertex or line edit.
      if (rejectUnsupportedMeshPick(hit => hit.kind === 'surface')) return;
      if (reference && stage.ray.intersectObject(reference, false)[0]) { host.selectReference(); return; }
      host.clearRefSelection(); // clicking off the reference drops its move handle / gizmo
      if (stage.gizmoKind === 'knot') { stage.detachGizmo(); stage.cb.onSelectKnot(null); } // clicking off a knot drops it too
      stage.cb.onSelectMountain?.(); // terrain or empty space -> select the mountain (clears any reference box)
      return;
    }

    const anchorHit = access.pickAnchor();   // the flags sit above the knots; grab them first
    if (anchorHit) {
      stage.cb.onSelectKnot(null);
      layers.selection.placeCornerMarker(null);
      stage.cb.onSelectCorner(null);
      layers.selection.clearRefLoops();
      stage.attachGizmo(anchorHit.object as THREE.Mesh, 'anchor', 0);
      return;
    }

    const knotHit = access.pickKnot();
    if (knotHit) {
      const idx = knotHit.object.userData.knot as number;
      stage.cb.onSelectKnot(idx);
      layers.selection.placeCornerMarker(null);   // a knot and a corner can't both be the gizmo target
      stage.cb.onSelectCorner(null);
      layers.selection.clearRefLoops();
      stage.attachGizmo(knotHit.object as THREE.Mesh, 'knot', idx); // drag it with the translate gizmo
      return;
    }

    // Pinned sub-cage dots are directly selectable. When the two mountains overlap, the nearest visible
    // surface breaks a tie.
    if (access.mode() === 'edit' && layers.cage.cage && layers.cage.subCage && layers.transforms.mode === 'move') {
      const authoredPoint = access.isMountain() ? layers.picking.pickSubCagePoint() : null;
      const referencePoint = layers.picking.pickReferenceSubCagePoint();
      const source = authoredPoint && referencePoint ? (layers.picking.vertexSourceAtPointer() ?? 'authored')
        : referencePoint ? 'reference' : authoredPoint ? 'authored' : null;
      const pointFiltered = source ? filteredEditPick('vertex', source) : false;
      if (!pointFiltered && source === 'authored' && authoredPoint) {
        if ((shift || ctrl) && layers.selection.referenceMeshSelectionActive()) return;
        // Shift remains an in-family range/add gesture. Ctrl is the cross-family toggle and may add this
        // floating control point beside selected edges, patches, or props.
        if (shift && (sel.edgeSel.length || sel.cellSel.length)) return;
        stage.cb.onSelectKnot(null);
        layers.selection.clearRefLoops();
        stage.cb.onSelectControlPoints?.([authoredPoint], ctrl ? 'toggle' : shift ? 'add' : 'replace');
        return;
      }
      if (!pointFiltered && source === 'reference' && referencePoint) {
        if ((shift || ctrl) && layers.selection.authoredMeshSelectionActive()) return;
        stage.cb.onSelectKnot(null);
        stage.detachGizmo();
        layers.selection.placeCornerMarker(null);
        stage.cb.onSelectCorner(null);
        layers.selection.selectReferenceControlPoints([referencePoint], ctrl ? 'toggle' : shift ? 'add' : 'replace');
        return;
      }
    }

    // tangent-handle nubs of the selected corner: click one to re-seat the gizmo on it and shape that
    // tangent on an explicit axis / plane (the corner stays selected). Takes priority over the corner.
    if (access.isMountain() && access.mode() === 'edit' && layers.transforms.mode === 'move') {
      const nubs = layers.cage.visibleNubs();
      const nubHit = nubs.length ? stage.ray.intersectObjects(nubs, false)[0] : undefined;
      if (nubHit && !filteredEditPick('vertex', 'authored')) {
        stage.attachGizmo(nubHit.object as THREE.Mesh, 'handle', 0, nubHit.object.userData.dir as string);
        stage.gizmo.enabled = true; // hover-gating disabled it to let this press through; re-enable to drag
        return;
      }
    }

    // cage handles: a singly-selected cell / edge shows its editable control points as pickable spheres — the
    // eight edge tangents (any single selection) plus the four interior twist points (a single cell). Click one
    // to seat the translate gizmo on it and pull that handle (Surface⇄World pill respected). Priority over the
    // corner / edge / face picks, like the tangent nubs (the cell / edge / corner families are mutually exclusive).
    if (access.isMountain() && access.mode() === 'edit' && layers.transforms.mode === 'move' && layers.selection.cageHandleMeshes.length) {
      const hit = stage.ray.intersectObjects(layers.selection.cageHandleMeshes, false)[0];
      if (hit && !filteredEditPick('vertex', 'authored')) {
        layers.selection.selectCageHandle(hit.object.userData as CageHandleId);
        stage.gizmo.enabled = true; // hover-gating disabled it to let this press through; re-enable to drag
        return;
      }
    }

    // Edit's own always-on-top points and handles win above. A visible prop wins over the terrain topology
    // beneath it: an authored placement selects (box + gizmo + banner) via the host. With the Prop pick
    // filter off, placements are click-transparent and the pick falls through to the mesh beneath.
    if (access.mode() === 'edit' && sel.editPickKinds.prop && rejectUnsupportedPropPick(true, ctrl)) return;

    // mountain control-net editing: with the cage shown, click a terrain corner to select it and seat
    // the translate gizmo on it; dragging a gizmo handle then moves it on a constrained axis / plane.
    if (access.isMountain() && layers.cage.cage && access.mode() === 'edit') {
      const ci = layers.picking.pickCorner();
      if (ci !== null && !filteredEditPick('vertex', 'authored')) {
        if ((shift || ctrl) && layers.selection.referenceMeshSelectionActive()) return; // modified picks never cross surfaces/families
        stage.cb.onSelectKnot(null);
        layers.selection.clearRefLoops();       // a corner pick (any modifier) replaces any reference highlight
        // Ctrl toggles this corner in / out of a multi-selection; Shift takes the rectangular block of corners
        // spanned to the anchor across the quad grid — both build the group selection (the host seats the
        // centroid gizmo), matching the edge modifiers. A plain click single-selects: seat the translate gizmo
        // + tangent handles on just this one.
        const mixedControlSelection = layers.selection.controlPointSel.some(id => id.kind !== 'vertex');
        const doc = access.meshDoc(), picked = doc ? vertexName(doc, ci) : null;
        if (ctrl && mixedControlSelection && picked !== null) { stage.cb.onSelectControlPoints?.([{ kind: 'vertex', vertex: picked }], 'toggle'); return; }
        if (shift && mixedControlSelection && picked !== null) { stage.cb.onSelectControlPoints?.([{ kind: 'vertex', vertex: picked }], 'add'); return; }
        if (ctrl) { stage.cb.onToggleCorner?.(ci); return; }
        if (shift) { stage.cb.onRangeSelectCorner?.(ci); return; }
        layers.selection.placeCornerMarker(ci); // seat the invisible gizmo anchor on the corner
        stage.attachGizmo(layers.selection.cornerMarker, 'corner', ci); // gizmo on the corner
        stage.cb.onSelectCorner(ci);
        return;
      }
    }

    // Reference control net: vertex > edge > face, matching the authored pick priority. Read-only — selections
    // highlight and can be copied, but never receive a transform gizmo. Moving the whole reference is Info-only.
    if (reference && refData && layers.cage.cage && access.mode() === 'edit') {
      const rv = layers.picking.pickReferenceCorner();
      if (rv !== null && !filteredEditPick('vertex', 'reference')) {
        if ((shift || ctrl) && layers.selection.authoredMeshSelectionActive()) return;
        if ((shift || ctrl) && (sel.refEdgeSel.length || sel.refCellSel.length)) return;
        stage.cb.onSelectKnot(null);
        stage.detachGizmo();
        layers.selection.placeCornerMarker(null);
        stage.cb.onSelectCorner(null);
        layers.selection.selectReferenceVertex(rv, ctrl ? 'toggle' : shift ? 'range' : 'replace');
        return;
      }
      const re = layers.picking.pickRefEdge();
      if (re && !filteredEditPick('line', 'reference')) {
        const mode = ctrl ? 'toggle' : shift ? 'range' : 'replace';
        if (mode !== 'replace' && layers.selection.authoredMeshSelectionActive()) return;
        if (mode !== 'replace' && sel.refCellSel.length) return; // cross-family lock: a modified edge pick won't drop a live cell selection
        stage.cb.onSelectKnot(null);
        stage.detachGizmo();
        layers.selection.placeCornerMarker(null);
        stage.cb.onSelectCorner(null);
        layers.selection.clearRefCells();       // edge is the active ref family (a plain pick drops the cell shading)
        layers.selection.clearRefVertices();
        layers.selection.refEdgeSelect(re, mode);
        return;
      }
      const rp = layers.picking.pickRefPatch();
      if (rp !== null && !filteredEditPick('surface', 'reference')) {
        const mode = ctrl ? 'toggle' : shift ? 'range' : 'replace';
        if (mode !== 'replace' && layers.selection.authoredMeshSelectionActive()) return;
        if (mode !== 'replace' && sel.refEdgeSel.length) return; // cross-family lock: a modified patch pick won't drop a live edge selection
        stage.cb.onSelectKnot(null);
        stage.detachGizmo();
        layers.selection.placeCornerMarker(null);
        stage.cb.onSelectCorner(null);
        layers.selection.clearRefEdges();       // patch is the active ref family (a plain pick drops the edge selection)
        layers.selection.clearRefVertices();
        layers.selection.refCellSelect(rp, mode);
        return;
      }
    }

    // edges + cell faces: with the cage on, one terrain raycast serves both. A click NEAR a control-net edge
    // (missed every corner, nearer than the face) selects that EDGE; a click into the open FACE selects the CELL.
    // Both carry the same modifiers — plain replace, Ctrl toggle, Shift range (an edge run along its loop / a
    // rectangular block of cells across the grid) — and a double-click takes the whole loop (edge-loop / face-loop).
    const preview = access.preview();
    if (access.isMountain() && layers.cage.cage && access.mode() === 'edit' && preview) {
      const freeEdge = layers.picking.pickFreeEdgeAt();
      if (freeEdge && !filteredEditPick('line', 'authored')) {
        if ((shift || ctrl) && layers.selection.referenceMeshSelectionActive()) return;
        stage.cb.onSelectKnot(null);
        layers.selection.clearRefLoops();
        layers.edgeExtrusion.setSideHint(null);
        stage.cb.onSelectEdge?.(freeEdge, ctrl ? 'toggle' : shift ? 'range' : 'replace');
        return;
      }
      const hit = stage.ray.intersectObject(access.terrain(), false)[0];
      if (hit && hit.faceIndex != null) {
        const quad = Math.floor(hit.faceIndex / preview.facesPerCell); // face index → quad id (topology-general)
        const edge = layers.picking.pickEdgeAt(quad);
        if (edge && !filteredEditPick('line', 'authored')) {
          if ((shift || ctrl) && layers.selection.referenceMeshSelectionActive()) return;
          stage.cb.onSelectKnot(null);
          layers.selection.clearRefLoops();
          layers.edgeExtrusion.setSideHint(quad);
          stage.cb.onSelectEdge?.(edge, ctrl ? 'toggle' : shift ? 'range' : 'replace');
          return;
        }
        // a click into the open FACE selects the CELL — Ctrl toggles it into a non-consecutive set, Shift takes
        // the rectangular block of cells to the anchor across the grid, plain single-selects (the edge modifiers).
        if (!filteredEditPick('surface', 'authored')) {
          if ((shift || ctrl) && layers.selection.referenceMeshSelectionActive()) return;
          stage.cb.onSelectKnot(null);
          layers.selection.clearRefLoops();
          stage.cb.onSelectEditCell?.(quad, ctrl ? 'toggle' : shift ? 'range' : 'replace');
          return;
        }
      }
      const edge = stage.isOrtho ? layers.picking.pickAnyEdgeAt() : null;
      if (edge && !filteredEditPick('line', 'authored')) {
        if ((shift || ctrl) && layers.selection.referenceMeshSelectionActive()) return;
        stage.cb.onSelectKnot(null);
        layers.selection.clearRefLoops();
        layers.edgeExtrusion.setSideHint(null);
        stage.cb.onSelectEdge?.(edge, ctrl ? 'toggle' : shift ? 'range' : 'replace');
        return;
      }
    }

    // A filtered hit with no enabled family underneath is not empty space: keep the live selection intact.
    if (filteredNoticeSent) return;

    // A modified miss means "add/toggle nothing", never "replace with nothing". This protects authored and
    // reference point/edge/cell selections alike; a plain empty-space click keeps the normal deselect behavior.
    if (shift || ctrl) return;

    const wasRefSelected = access.refSelected(); // clicking off a selected reference should drop its box too
    stage.cb.onSelectKnot(null);
    stage.detachGizmo();
    layers.selection.placeCornerMarker(null);
    stage.cb.onSelectCorner(null);
    host.clearRefSelection();
    layers.selection.clearRefLoops();
    if (wasRefSelected) stage.cb.onSelectMountain?.(); // deselect the reference in the scene tree (clears its box)
    // The same plain click-on-nothing also ends an unlocked model edit session — the click-on / click-off
    // flow. The host applies the lock and armed-tool rules.
    if (access.mode() === 'edit') stage.cb.onEditClickAway?.();
  }

  /** A second finger landed: abandon any in-progress single-finger stroke / orbit and hand the camera to
   *  OrbitControls' two-finger pinch-zoom / pan (it has been tracking both pointers all along); our twist
   *  overlay rides on top, yawing the view when the fingers rotate around each other (applyTwist). */
  function cancelStroke() {
    if (layers.edgeExtrusion.active) layers.edgeExtrusion.cancel();
    endSculptGrab();
    endSculptDab();
    painting = false;
    sculpting = false;
    mmbDown = null;
    touchNav = null;
    propClickPending = null;
    infoClickPending = null;
    editClickPending = null;
    marqueeVertexHint = null;
    layers.cameraCtl.cancelOrbit(); // reseat the pivot ahead so OrbitControls resumes cleanly, then let it drive
    hideMarquee();
    brushRing.visible = false;
    stage.controls.enabled = true;
  }

  /** Abort only the click-or-box selection gesture. Safe on a normal lostpointercapture after pointerUp: by
   *  then all three fields are already empty, so it cannot disturb the selection that was just committed. */
  function cancelSelectionDrag() {
    if (!propClickPending && !infoClickPending && !editClickPending && !marquee) return;
    propClickPending = null;
    infoClickPending = null;
    editClickPending = null;
    marqueeVertexHint = null;
    hideMarquee();
    stage.controls.enabled = true;
  }

  function cancelSculptDrag() {
    if (!sculpting) return;
    endSculptGrab();
    endSculptDab();
    sculpting = false;
    stage.controls.enabled = true;
  }

  function pointerMove(e: PointerEvent) {
    pointerAt = { clientX: e.clientX, clientY: e.clientY };
    if (layers.rideCtl.riding) {
      if (layers.rideCtl.walking && e.pointerType === 'mouse')
        layers.rideCtl.setDesktopBoardAim(ridePointerNdc(e.clientX, e.clientY));
      // Captured RMB-look is driven from ride/pointer-lock's document mousemove. Keep this path as the fallback
      // while the request is pending, after Escape breaks the capture, or when Pointer Lock is unavailable.
      if (e.pointerType === 'mouse' && rideOrbitMouse
        && (typeof document === 'undefined' || document.pointerLockElement !== dom)) {
        layers.rideCtl.orbitCamera(e.movementX || 0, e.movementY || 0);
        e.preventDefault();
      }
      return;
    }
    // two-finger twist overlay: track the live finger positions; with both down, fold their rotation into
    // the view as yaw (OrbitControls keeps driving the simultaneous pinch-zoom / pan from the same moves)
    if (e.pointerType === 'touch' && layers.cameraCtl.touchPts.has(e.pointerId)) {
      layers.cameraCtl.touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (layers.cameraCtl.twist && layers.cameraCtl.touchPts.size === 2) { layers.cameraCtl.applyTwist(); return; }
    }
    if (layers.cameraCtl.orbiting) { layers.cameraCtl.applyOrbitMove(e); return; }
    if (layers.cameraCtl.flying) { layers.cameraCtl.applyLook(e.movementX || 0, e.movementY || 0); return; }
    if (layers.edgeExtrusion.dragging) { layers.edgeExtrusion.update(e); return; }
    if (layers.edgeExtrusion.staged && layers.edgeExtrusion.mode === 'pull') return;
    if (layers.gems.gemLine) { gemPointerMove(e); return; } // dragging a gem row
    // a deferred single-finger touch that moves past the tap threshold is an orbit-drag, not a tap-to-select
    if (touchNav) { if (Math.hypot(e.clientX - touchNav.x, e.clientY - touchNav.y) > 4) { touchNav = null; layers.cameraCtl.startOrbit(e); } return; }
    // a deferred Info press that moves past the tap threshold becomes a course-knot marquee
    if (infoClickPending) {
      if (Math.hypot(e.clientX - infoClickPending.x, e.clientY - infoClickPending.y) > 4) {
        const r = stage.container.getBoundingClientRect();
        marqueeKind = 'knots';
        marqueeSelectionMode = 'replace';
        marquee = { x0: infoClickPending.x - r.left, y0: infoClickPending.y - r.top };
        infoClickPending = null;
        stage.marqueeEl.style.display = 'block';
        updateMarqueeRect(e.clientX - r.left, e.clientY - r.top);
        stage.controls.enabled = false;
      }
      return;
    }
    // a deferred props-mode press that moves past the tap threshold becomes the box-select marquee
    if (propClickPending) {
      if (Math.hypot(e.clientX - propClickPending.x, e.clientY - propClickPending.y) > 4) {
        const r = stage.container.getBoundingClientRect();
        marqueeKind = 'props';
        marqueeSelectionMode = 'replace';
        marquee = { x0: propClickPending.x - r.left, y0: propClickPending.y - r.top };
        propClickPending = null;
        stage.marqueeEl.style.display = 'block';
        updateMarqueeRect(e.clientX - r.left, e.clientY - r.top);
        stage.controls.enabled = false;
      }
      return;
    }
    // a deferred Edit-mode press that moves past the tap threshold becomes the all-enabled-family marquee
    if (editClickPending) {
      if (Math.hypot(e.clientX - editClickPending.x, e.clientY - editClickPending.y) > 4) {
        const pending = editClickPending;
        const r = stage.container.getBoundingClientRect();
        marqueeKind = 'edit';
        marqueeSelectionMode = pending.ctrl ? 'remove' : pending.shift ? 'add' : 'replace';
        marquee = { x0: pending.x - r.left, y0: pending.y - r.top };
        editClickPending = null;
        stage.marqueeEl.style.display = 'block';
        updateMarqueeRect(e.clientX - r.left, e.clientY - r.top);
        stage.controls.enabled = false;
      }
      return;
    }
    if (marquee) {
      const r = stage.container.getBoundingClientRect();
      updateMarqueeRect(e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (access.mode() === 'sculpt') {
      stage.castAt(e);
      if (sculpting && sculptGrab) { updateSculptGrab(); return; }
      // The terrain's cached pick tree answers the ring's hover in microseconds; the stock triangle walk is
      // ~56 ms on a big mountain, which is what left the ring — and any MMB pan taken while Sculpt is hovered
      // — trailing the cursor. A live dab keeps that same tree: the quilt is re-emitted through the buffers it
      // indexes and the terrain layer refits it over the patches that moved (mesh/surface-trees.ts). `build`
      // false only declines to pay a COLD build inside the stroke, which the hover before it has already paid.
      const hit = stage.pickSurface(access.terrain(), !sculpting);
      brushRing.visible = !!hit;
      if (hit) {
        updateSculptRing(hit);
        if (sculpting) sculptAt(hit);
      }
      return;
    }
    brushRing.visible = false;
    // Paste vertices: its faithful teal copy follows authored terrain or the free-space construction plane and
    // owns Edit hover while armed.
    if (access.mode() === 'edit' && layers.clipboardPlacement.onHover(e)) return;
    // Create patch: a teal square follows the hit point and surface tangent; it owns Edit hover while armed.
    if (access.mode() === 'edit' && layers.patchTool.onHover(e)) return;
    // Create Tube: its next axis endpoint follows terrain or the free-space construction plane.
    if (access.mode() === 'edit' && layers.tubeTool.onHover(e)) return;
    // Create Trail: the next centre-spline knot follows terrain or the construction plane.
    if (access.mode() === 'edit' && layers.trailTool.onHover(e)) return;
    // Create Edge: preview the next endpoint and segment, reusing the exact host vertex under a snap.
    if (access.mode() === 'edit' && layers.createEdge.armed) {
      stage.castAt(e);
      const endpoint = createEdgePlacement(e.shiftKey);
      layers.createEdge.showGhost(endpoint?.pos ?? null, endpoint?.vertex != null || endpoint?.edge != null);
      access.createEdgePreviewChanged();
      return;
    }
    // target-weld gesture (docs/023 S4): once a FROM is picked, the aim line tracks the cursor. Owns the Edit hover
    // while armed (returns), so it precedes the gizmo gate / selection path below.
    if (access.mode() === 'edit' && layers.weldTool.onHover(e)) return;
    // loop-cut surgery: the hovered terrain edge previews a cut (the first live hover feedback in Edit) — it
    // owns the hover, so it precedes the gizmo hover-gate / selection path below.
    if (access.mode() === 'edit' && layers.surgery.onHover(e)) return;
    gizmoHoverGate(e); // let tangent nubs win over the gizmo handles underneath them
    // every node (corner, knot, tangent nub) is moved by the translate gizmo now; only the placement
    // ghosts and painting still ride the raw pointer here.
    if (access.mode() === 'props') {
      if (layers.props.propArm) { stage.castAt(e); layers.props.updateGhost(); } // the held prop's ghost rides the hover
      else if (layers.gems.gemArmed && !layers.gems.gemLine) { stage.castAt(e); layers.gems.updateGemGhost(); } // so does the gem tool's crystal
      return;
    }
    if (access.mode() === 'paint' && layers.paint.paintArm) {
      stage.castAt(e);
      layers.paint.updatePaintGhost(painting);    // the brush ghost rides the hover (and the stroke)
      if (painting) paintAtPointer(true); // left button held: keep painting the stroke
    }
  }

  /** While merely hovering (not dragging), disable the gizmo whenever the cursor is over a visible
   *  tangent nub that isn't already its target. A disabled gizmo ignores the press (its own pointerdown
   *  early-returns on !enabled), so the click falls through to the nub branch and re-seats the gizmo
   *  there - i.e. nubs take precedence over the corner's gizmo handles drawn on top of them. */
  function gizmoHoverGate(e: PointerEvent) {
    if (access.mode() !== 'edit' || !access.isMountain() || painting || !stage.gizmo.object || stage.gizmo.dragging) return;
    if (layers.transforms.mode !== 'move') { stage.gizmo.enabled = true; return; } // rotate / scale handles own the gesture until W returns to point editing
    const nubs = layers.cage.visibleNubs().filter(m => m !== stage.gizmo.object);
    // cage handles win over the anchor's gizmo the same way nubs do — but never the PICKED handle: it IS the
    // gizmo target, so hovering it must let the gizmo arrows through (to drag), not re-gate the press.
    const handles = layers.selection.cageHandleMeshes.filter(m => !layers.selection.cageHandleMatches(layers.selection.selectedCageHandle, m.userData as CageHandleId));
    const others = [...nubs, ...handles];
    if (!others.length) { stage.gizmo.enabled = true; return; }
    stage.castAt(e);
    stage.gizmo.enabled = stage.ray.intersectObjects(others, false).length === 0;
  }

  function pointerUp(e: PointerEvent) {
    if (layers.rideCtl.riding) {
      if (e.type === 'pointercancel') clearRideMouseButtons();
      return;
    }
    layers.cameraCtl.activePointers.delete(e.pointerId);
    layers.cameraCtl.touchPts.delete(e.pointerId);
    if (layers.cameraCtl.twist && layers.cameraCtl.touchPts.size < 2) layers.cameraCtl.twist = null; // a finger lifted: the twist gesture is over
    if (layers.cameraCtl.orbiting) { layers.cameraCtl.endOrbit(e); return; }
    if (layers.cameraCtl.flying) { layers.cameraCtl.endFly(e); return; }
    // A staged Path extrusion still needs ordinary clicks/taps to select its guide. Only a live pull drag owns release.
    if (layers.edgeExtrusion.dragging) { layers.edgeExtrusion.finish(e, e.type !== 'pointercancel'); return; }
    if (layers.edgeExtrusion.staged && layers.edgeExtrusion.mode === 'pull') return;
    if (layers.gems.gemLine) { gemPointerUp(e); return; } // finished a gem-row drag (or a stationary single gem)
    // a deferred single-finger touch that never dragged is a tap: select what's under it, like a mouse click
    if (touchNav) {
      touchNav = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      stage.castAt(e);
      selectAtPointer(e.shiftKey, e.ctrlKey || e.metaKey);
      return;
    }
    // a deferred Info press that never dragged is an ordinary click: select the knot/reference/mountain now
    if (infoClickPending) {
      infoClickPending = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      stage.castAt(e);
      selectAtPointer(e.shiftKey, e.ctrlKey || e.metaKey);
      return;
    }
    // a deferred props-mode press that never dragged is a click: select what's under it now
    if (propClickPending) {
      propClickPending = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      stage.castAt(e);
      pickOrPlaceProp();
      return;
    }
    // a deferred Edit-mode press that never dragged is a click: select the corner / knot / nub (Shift = range)
    if (editClickPending) {
      const pending = editClickPending;
      editClickPending = null;
      marqueeVertexHint = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      stage.castAt(e);
      selectAtPointer(pending.shift || e.shiftKey, pending.ctrl || e.ctrlKey || e.metaKey);
      return;
    }
    if (marquee) {
      const kind = marqueeKind;
      const propIndices = kind === 'props' ? propsInMarquee() : [];
      const knotIndices = kind === 'knots' ? knotsInMarquee() : [];
      if (kind === 'edit') {
        const liveMode = e.ctrlKey || e.metaKey ? 'remove' : e.shiftKey ? 'add' : marqueeSelectionMode;
        finishEditMarquee(liveMode); // reads the live rectangle before hideMarquee clears it
      }
      hideMarquee();
      stage.controls.enabled = true;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      if (kind === 'props') stage.cb.onSelectProps?.(propIndices);
      else if (kind === 'knots') {
        host.clearRefSelection();
        stage.cb.onSelectKnots?.(knotIndices);
      }
      return;
    }
    // a middle-CLICK (no pan) selects + arms a Paint texture, or picks up a prop in Props
    if (e.button === 1 && mmbDown) {
      const moved = Math.hypot(e.clientX - mmbDown.x, e.clientY - mmbDown.y);
      mmbDown = null;
      if (moved < 4) {
        stage.castAt(e);
        if (access.mode() === 'paint') {
          const propTexture = inspectPropTextureAtPointer();
          if (propTexture !== undefined) {
            if (propTexture) pickAtPointer(true);
          } else {
            layers.refDecor.clearSurfaceInspection();
            layers.paint.paintSelectAtPointer(false);
            pickAtPointer(true);
          }
        } else if (access.mode() === 'props') pickPropAtPointer();
      }
      return;
    }
    painting = false;
    endSculptGrab();
    endSculptDab();
    sculpting = false;
    stage.controls.enabled = true;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  /** Paint the cell under the cursor. `midStroke` from the pointer-move repeat, which declines to pay a cold
   *  pick-tree build inside the stroke (see PaintLayer.cellAtPointer). */
  function paintAtPointer(midStroke = false): boolean {
    const c = layers.paint.cellAtPointer(midStroke);
    if (c === null) return false;
    stage.cb.onPaintCell(c);
    return true;
  }

  /** Sample the nearest visible surface (prop, authored terrain or loaded reference) and resolve its texture.
   *  A prop hit reads the clicked submesh's stamped tile; a reference hit maps face -> patch -> TexturePath +
   *  SurfaceType; an authored hit maps face -> cell -> the painted tile + SurfaceType. Reports through onPick. */
  function pickAtPointer(preserveInspection = false) {
    if (!preserveInspection) layers.refDecor.clearSurfaceInspection();
    // props first: a model surface in front of the terrain picks ITS texture (occluded props lose)
    const propPick = layers.scenePicking.pick({
      props: 'standard', occludeWithSurfaces: true, surfaceEpsilon: 1e-3,
    });
    if (propPick?.target === 'prop') {
      const t = propPickTex(propPick.hit);
      stage.cb.onPick({ source: 'prop', ref: t.ref, surface: null, name: t.name, rot: 0, mirror: false });
      return;
    }
    const reference = access.reference(), refData = access.refData();
    const targets: THREE.Object3D[] = reference ? [access.terrain(), reference] : [access.terrain()];
    const hit = stage.ray.intersectObjects(targets, false)[0];
    if (!hit || hit.faceIndex == null) { stage.cb.onPick({ source: 'current', ref: null, surface: null, name: '', rot: 0, mirror: false }); return; }
    if (reference && hit.object === reference && refData) {
      const rd = refData;
      const patch = Math.floor(hit.faceIndex / rd.facesPerPatch);
      const name = rd.patchTex[patch] ?? null;
      const ref = name ? resolveTerrainTexRef(access.refLevel(), name) : null;
      // recover the tile's D4 from the patch's own tile-UVs (green frame-F → pink art-F turn)
      const uv = rd.patchUV[patch];
      const o = ref && uv ? orientFromPatchUV(uv) : { rot: 0, mirror: false };
      stage.cb.onPick({
        source: 'reference', ref, surface: rd.patchSurf[patch] ?? null,
        name: name ?? '', rot: o.rot, mirror: o.mirror,
      });
      return;
    }
    const preview = access.preview();
    if (!preview) { stage.cb.onPick({ source: 'current', ref: null, surface: null, name: '', rot: 0, mirror: false }); return; }
    const pv = preview;
    const cell = Math.floor(hit.faceIndex / pv.facesPerCell);
    const ref = pv.cellTex[cell] ?? null;
    const surface = pv.cellSurf[cell] ?? null;
    const o = pv.cellOrient[cell] ?? { rot: 0, mirror: false }; // an authored cell keeps the exact orientation it was painted at
    stage.cb.onPick({ source: 'current', ref, surface, name: ref ? parseTexRef(ref).name : '', rot: o.rot, mirror: o.mirror });
  }

  const dom = stage.renderer.domElement;

  /** Current visible/captured cursor as camera NDC. Pointer lock owns the centre reticle; otherwise the press or
   * hover position is exact. The ride rebuilds the world ray from this each frame as its camera moves. */
  function ridePointerNdc(clientX: number, clientY: number): [number, number] {
    // Pointer lock leaves client coordinates parked at the old cursor. In captured first person the view centre
    // is the only honest aim; an unlocked cursor uses the exact visible position.
    const locked = typeof document !== 'undefined' && document.pointerLockElement === dom;
    if (locked) return [0, 0];
    const rect = dom.getBoundingClientRect();
    return [
      ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    ];
  }

  /** Start target interaction on mouse-down. An unconsumed RMB retains its camera-look meaning. */
  function beginRideMouseButton(button: number, clientX: number, clientY: number): boolean {
    let consumed = false;
    if (layers.rideCtl.walking) {
      layers.rideCtl.setDesktopBoardAim(ridePointerNdc(clientX, clientY));
      consumed = layers.rideCtl.beginDesktopPointer(button);
    }
    if (button === 2) rideOrbitMouse = !consumed;
    return consumed;
  }

  function endRideMouseButton(button: number) {
    if (button === 2) rideOrbitMouse = false;
    layers.rideCtl.endDesktopPointer(button);
  }

  function clearRideMouseButtons() {
    rideOrbitMouse = false;
    layers.rideCtl.endDesktopPointer(2);
  }

  function mouseDown(e: MouseEvent) {
    if (!layers.rideCtl.riding) return;
    const consumed = beginRideMouseButton(e.button, e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    // The ride's pointer-lock listener lives on this same canvas. A board grab must not also start RMB look.
    if (consumed) e.stopImmediatePropagation();
  }

  function mouseUp(e: MouseEvent) {
    endRideMouseButton(e.button);
  }

  // Capture pointer-down before TransformControls so selection tools can gate a gizmo press consistently.
  dom.addEventListener('pointerdown', e => pointerDown(e), { capture: true });
  dom.addEventListener('pointermove', e => pointerMove(e));
  dom.addEventListener('pointerup', e => pointerUp(e));
  dom.addEventListener('dblclick', e => onDoubleClick(e)); // double-click anything to focus the camera on it
  dom.addEventListener('pointercancel', e => pointerUp(e)); // touch can cancel mid-stroke
  // Mouse events retain a held RMB across the whole camera/grab gesture; Pointer Events may report only the
  // combined button chord's empty/non-empty transitions.
  dom.addEventListener('mousedown', mouseDown, { capture: true });
  // Headless picking tests deliberately provide only the canvas. The browser window owns releases beyond its
  // edge and focus loss; the guarded canvas fallback still serves synthetic/local releases without one.
  if (typeof window !== 'undefined') {
    window.addEventListener('mouseup', mouseUp, { capture: true });
    window.addEventListener('blur', clearRideMouseButtons);
  } else dom.addEventListener('mouseup', mouseUp, { capture: true });
  // A pointer that has left the canvas is nowhere on the mountain, and telling the room otherwise would park
  // this participant's cursor wherever they last happened to be.
  dom.addEventListener('pointerleave', () => {
    pointerAt = null;
    if (layers.rideCtl.riding && layers.rideCtl.walking) layers.rideCtl.setDesktopBoardAim(null);
  });
  // Capture can be revoked without a pointerup (window switch, browser gesture, device interruption). Never
  // leave a deferred click / rubber-band behind in that case; the next click must start from a clean slate.
  dom.addEventListener('lostpointercapture', () => {
    clearRideMouseButtons();
    cancelSelectionDrag(); cancelSculptDrag();
  });
  dom.style.touchAction = 'none'; // single finger is ours; CameraController configures the OrbitControls slots
  dom.addEventListener('contextmenu', e => e.preventDefault()); // RMB-drag must not pop the menu
  // Own the wheel: a capture listener on the container runs before (and stops) OrbitControls' own
  // canvas wheel listener, so we get a single consistent zoom. Touch pinch is untouched (not a wheel).
  stage.container.addEventListener('wheel', e => onWheel(e), { capture: true, passive: false });

  return {
    cancelSelectionDrag,
    createEdgePlacement,
    /** Where the pointer is over the canvas, or null once it has left it. */
    get pointerAt() { return pointerAt; },
    /** Sculpt brush footprint radius (world units); the ring overlay tracks it live. */
    get brushRadius() { return brushRadius; },
    set brushRadius(v: number) { brushRadius = v; },
  };
}

export type PointerRouter = ReturnType<typeof createPointerRouter>;
