import * as THREE from 'three';
import type { PlacedProp, Screen, V3 } from '../../../core/doc/types';
import { screenPose, screenProp, type ScreenPose } from '../../../core/props/screen';
import type { ReferenceScreenPickDetails } from '../../../core/reference/screens';
import { disposeSourceMarkerPoints, setSourceMarkerSelected, sourceMarkerPoints } from './source-markers';
import { screenPresentation } from './screen-presentation';
import { createScreenTestPatternTexture } from './screen-test-pattern';
import type { ScenePickSource } from '../input/scene-picking';
import type { Stage } from '../stage';

/**
 * Video SCREENS (docs/051): the rectangles a runtime lays video over. While the shared Jukebox is idle, Sources
 * draws an opaque colour-bar coverage card with a lit border and movie marker. During playback the shared live
 * texture covers every authored and reference panel while Sources is off; Sources on deliberately restores
 * the test card, borders, markers and pick targets for fit inspection.
 *
 * They ride the **Sources** view with the light bulbs and the speakers, because that is what they are: a
 * marker at every place the world emits something, shown when you are asking that question and out of the way
 * when you are not. A course carries dozens of boards, so the panels are drawn without names — a field of
 * floating labels buries the boards it annotates. The marker cloud says WHERE, the inspector says WHICH.
 *
 * Two sets, the same drawing: the AUTHORED screens on the document (selectable, gizmo-movable, the ones the
 * export writes) and the loaded reference's own, read from the `Billboards.json` `snowknife billboards`
 * measured off that course — which is what lets an author see where a shipped course's boards already carry
 * screens before placing any of their own.
 *
 * Authored screens live under `stage.worldRoot` in data coords like the gems and rails; reference screens sit
 * under `stage.refRoot`, so they follow the reference's own placement offset.
 */

const EDGE_COLOR = 0x3fe0d0;
const EDGE_SELECTED = 0xffd447;
const REFERENCE_EDGE = 0x8fa3b8;
// Screens sit 0.1 m proud of the faces they cover, but kilometre-scale camera ranges can still quantize both
// surfaces to the same depth. Bias the coverage card and live video forward by one depth unit, matching Unity.
const SCREEN_DEPTH_BIAS = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 } as const;

/** A screen resolved for drawing, with the identity a pick reports back. */
export interface ScreenDraw extends ReferenceScreenPickDetails {
  pose: ScreenPose;
  level: string;
}

export function createScreensLayer(stage: Stage) {
  const authored = new THREE.Group(); authored.name = 'Screens';
  const reference = new THREE.Group(); reference.name = 'Reference screens';
  stage.worldRoot.add(authored);
  stage.refRoot.add(reference);

  const panelGeo = new THREE.PlaneGeometry(1, 1);
  const testPatternMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, map: createScreenTestPatternTexture(), side: THREE.DoubleSide,
    transparent: false, opacity: 1, depthWrite: true, toneMapped: false, ...SCREEN_DEPTH_BIAS,
  });
  const videoMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.DoubleSide, toneMapped: false, ...SCREEN_DEPTH_BIAS,
  });
  const moveHandle = new THREE.Object3D();
  moveHandle.visible = false;
  stage.scene.add(moveHandle);   // scene-root gizmo anchor, Z negated by hand like the other families

  let screens: Screen[] = [];
  let props: readonly PlacedProp[] | undefined;
  let selected: string | null = null;
  let referenceDraws: ScreenDraw[] = [];
  let selectedReference: number | null = null;
  let authoredMarkers: THREE.Points | null = null;
  let referenceMarkers: THREE.Points | null = null;
  // Off until the host seeds the Sources view at boot, which is where screens are drawn — the alternative is
  // a frame of panels on a course whose author asked for none.
  let sourcesVisible = false;
  let videoTexture: THREE.Texture | null = null;
  const noRaycast = () => { /* playback-only panels do not steal authoring clicks */ };

  /** Where the selected screen sits right now, or -1 — resolved fresh, since a selection names a screen
   *  rather than the slot it happens to occupy (docs/039). */
  const selectedIndex = (): number =>
    selected === null ? -1 : screens.findIndex(screen => screen.id === selected);

  /** One screen: the panel and its border, built in data coords from the resolved rectangle, so an attached
   *  screen lands wherever its board currently stands. The name is deliberately not drawn — a course carries
   *  dozens of these, and a field of floating labels buries the boards they are meant to annotate; the marker
   *  cloud says WHERE and the inspector says WHICH. */
  function build(draw: ScreenDraw, edgeColor: number, source: ScenePickSource,
                 pickIndex: number): THREE.Object3D {
    const { pose } = draw;
    const group = new THREE.Group();
    group.position.set(pose.center[0], pose.center[1], pose.center[2]);
    // The stored rectangle IS the frame: +X right, +Y up, +Z out of the screen.
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...pose.right), new THREE.Vector3(...pose.up), new THREE.Vector3(...pose.normal)));

    const panel = new THREE.Mesh(panelGeo, testPatternMat);
    panel.scale.set(pose.width, pose.height, 1);
    panel.userData.screenPanel = true;
    panel.userData.screenPickRaycast = panel.raycast;
    panel.userData.screenSource = source;
    panel.userData.screenIndex = pickIndex;
    group.add(panel);

    const edgeMat = new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.9 });
    const hw = pose.width / 2, hh = pose.height / 2;
    const edges = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-hw, -hh, 0), new THREE.Vector3(hw, -hh, 0),
      new THREE.Vector3(hw, hh, 0), new THREE.Vector3(-hw, hh, 0),
    ]), edgeMat);
    edges.userData.screenEdge = true;
    edges.userData.screenEdgeColor = edgeColor;
    edges.userData.screenInspection = true;
    edges.raycast = () => { /* thin lines are a poor pick target; the panel answers */ };
    group.add(edges);

    // A stub out of the front face: which way the screen looks is the thing most easily got wrong, and it is
    // invisible on a flat panel seen head-on.
    const nose = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, Math.min(hw, hh) * 0.5),
    ]), edgeMat);
    nose.userData.screenInspection = true;
    nose.raycast = () => { /* not a pick target */ };
    group.add(nose);
    group.userData.screenSource = source;
    group.userData.screenIndex = pickIndex;
    return group;
  }

  /**
   * Drop a set's drawings and everything they allocated — the border geometry, the per-screen line material,
   * and what the marker cloud holds. Rebuilds are ordinary here (every screen edit, every prop move an
   * attached screen rides), so anything not released is released never.
   *
   * Collected before anything is disposed: disposing a cloud clears its own children, which a live traversal
   * must not be walking. Materials go through a Set because a screen's border and its facing stub share one.
   */
  function clear(group: THREE.Group) {
    const lines: THREE.Line[] = [];
    const clouds: THREE.Points[] = [];
    const materials = new Set<THREE.Material>();
    group.traverse(object => {
      if (object instanceof THREE.Points && object.userData.sourceSelectionGeometry) clouds.push(object);
      else if (object instanceof THREE.Line) lines.push(object);   // LineLoop extends Line
    });
    for (const line of lines) {
      line.geometry.dispose();
      for (const material of Array.isArray(line.material) ? line.material : [line.material]) materials.add(material);
    }
    for (const material of materials) material.dispose();
    for (const cloud of clouds) { cloud.geometry.dispose(); disposeSourceMarkerPoints(cloud); }
    group.clear();
  }

  /**
   * The movie markers: one constant-screen-size icon at each screen's centre, in the same batched cloud the
   * bulbs and speakers use. A board 400 m down the run is a few pixels of panel and would be missed; the
   * marker is what makes it findable, and clicking one selects that screen exactly as clicking its panel does.
   */
  function markers(poses: readonly ScreenPose[], source: ScenePickSource,
                   selectedAt: number | null): THREE.Points | null {
    if (!poses.length) return null;
    const points = sourceMarkerPoints(stage, 'screen', source,
      poses.map(pose => new THREE.Vector3(...pose.center)), { selectedIndex: selectedAt });
    // A screen is an editable object of its own, not a derived source readout, so it keeps its own pick
    // identity — the same distinction a free light draws against the sign-light bulbs beside it.
    delete points.userData.sourceKind;
    delete points.userData.sourceOrigin;
    points.userData.screenPoints = true;
    points.userData.screenSource = source;
    points.userData.screenInspection = true;
    return points;
  }

  /** Update the two independent selections without rebuilding geometry. Selected reference screens stay
   * read-only: the yellow border and bold movie marker are inspection feedback, never a gizmo. */
  function syncSelectionAppearance() {
    const syncGroup = (group: THREE.Group, source: ScenePickSource, selectedAt: number | null) => {
      for (const child of group.children) {
        if (!(child instanceof THREE.Group)) continue;
        const isSelected = child.userData.screenSource === source
          && child.userData.screenIndex === selectedAt;
        child.traverse(object => {
          if (object.userData.screenEdge === true && object instanceof THREE.Line) {
            const material = object.material as THREE.LineBasicMaterial;
            material.color.setHex(isSelected ? EDGE_SELECTED : object.userData.screenEdgeColor as number);
          }
        });
      }
    };
    const authoredAt = selectedIndex();
    syncGroup(authored, 'authored', authoredAt < 0 ? null : authoredAt);
    syncGroup(reference, 'reference', selectedReference);
    setSourceMarkerSelected(authoredMarkers, authoredAt < 0 ? null : authoredAt);
    setSourceMarkerSelected(referenceMarkers, selectedReference);
  }

  /** Apply the independent playback/Sources gates to both authored and reference sets. */
  function syncPresentation() {
    const presentation = screenPresentation(sourcesVisible, videoTexture !== null);
    const syncGroup = (group: THREE.Group) => {
      group.visible = presentation.layerVisible && group.children.length > 0;
      group.traverse(object => {
        if (object.userData.screenPanel === true && object instanceof THREE.Mesh) {
          object.visible = presentation.panelVisible;
          // Sources is the explicit fit-inspection view: every screen becomes an opaque colour card, selected
          // or not. With Sources off, active playback owns the picture and idle panels are hidden by the gate.
          object.material = sourcesVisible ? testPatternMat : videoTexture ? videoMat : testPatternMat;
          object.raycast = presentation.pickable
            ? object.userData.screenPickRaycast as THREE.Mesh['raycast'] : noRaycast;
        } else if (object.userData.screenInspection === true) {
          object.visible = presentation.inspectionVisible;
        }
      });
    };
    syncGroup(authored);
    syncGroup(reference);

    const at = selectedIndex();
    moveHandle.visible = sourcesVisible && at >= 0;
    if (!sourcesVisible && stage.gizmoKind === 'screen') stage.detachGizmo();
    else if (sourcesVisible && at >= 0 && stage.gizmoKind !== 'screen') {
      placeHandle(at);
      stage.attachGizmo(moveHandle, 'screen', at);
    }
  }

  /** Rebuild the authored screens from the document and keep the selected one's gizmo in sync. */
  function setScreens(next: readonly Screen[], placements: readonly PlacedProp[] | undefined,
                      selectedId: string | null) {
    clear(authored);
    screens = [...next];
    props = placements;
    selected = selectedId;
    if (selected !== null) selectedReference = null;
    const at = selectedIndex();
    const poses = screens.map(screen => screenPose(screen, screenProp(screen, props)));
    poses.forEach((pose, index) => {
      authored.add(build({ pose, level: '', name: screens[index].name ?? '',
        width: pose.width, height: pose.height }, EDGE_COLOR, 'authored', index));
    });
    authoredMarkers = markers(poses, 'authored', at < 0 ? null : at);
    if (authoredMarkers) authored.add(authoredMarkers);
    if (at >= 0) {
      if (sourcesVisible && !(stage.gizmoKind === 'screen' && stage.gizmo.dragging)) {
        placeHandle(at);
        moveHandle.visible = true;
        if (stage.gizmoKind !== 'screen') stage.attachGizmo(moveHandle, 'screen', at);
      }
    } else if (stage.gizmoKind === 'screen') clearSelection();
    syncSelectionAppearance();
    syncPresentation();
  }

  /** The loaded reference course's own measured screens. They select for read-only inspection through either
   *  the panel or movie marker; only authored screens ever receive a transform gizmo. */
  function setReference(draws: readonly ScreenDraw[]) {
    const hadSelection = selectedReference !== null;
    clear(reference);
    referenceDraws = [...draws];
    selectedReference = null;
    for (let index = 0; index < draws.length; index++)
      reference.add(build(draws[index], REFERENCE_EDGE, 'reference', index));
    referenceMarkers = markers(draws.map(draw => draw.pose), 'reference', null);
    if (referenceMarkers) reference.add(referenceMarkers);
    syncSelectionAppearance();
    syncPresentation();
    if (hadSelection) stage.cb.onSelectReferenceScreen?.(null, null);
  }

  function setVisible(on: boolean) {
    sourcesVisible = on;
    syncPresentation();
  }

  /** One decoded Jukebox texture is intentionally shared by every screen material. Null returns to idle. */
  function setVideoTexture(texture: THREE.Texture | null) {
    videoTexture = texture;
    videoMat.map = texture;
    videoMat.needsUpdate = true;
    syncPresentation();
  }

  /** Seat the scene-root gizmo handle on screen `i` (data pos, Z negated onto the flipped scene). */
  function placeHandle(i: number) {
    const screen = screens[i];
    if (!screen) return;
    const pose = screenPose(screen, screenProp(screen, props));
    moveHandle.position.set(pose.center[0], pose.center[1], -pose.center[2]);
  }

  /** Seat the gizmo on the screen a pick landed on, and tell the host which screen that is by name. */
  function seatScreen(i: number) {
    const id = screens[i]?.id;
    if (!id) return;
    selected = id;
    selectedReference = null;
    placeHandle(i);
    moveHandle.visible = true;
    stage.attachGizmo(moveHandle, 'screen', i);
    syncSelectionAppearance();
    syncPresentation();
    stage.cb.onSelectScreen?.(id);
  }

  /** Select a detected screen for inspection. Its reference transform is immutable, so no gizmo is attached. */
  function seatReferenceScreen(i: number) {
    const draw = referenceDraws[i];
    if (!draw) return;
    selected = null;
    selectedReference = i;
    moveHandle.visible = false;
    if (stage.gizmoKind === 'screen') stage.detachGizmo();
    syncSelectionAppearance();
    syncPresentation();
    const { name, family, instance, page, width, height } = draw;
    stage.cb.onSelectReferenceScreen?.(draw.level, { name, family, instance, page, width, height });
  }

  function clearSelection() {
    if (selected === null && selectedReference === null && stage.gizmoKind !== 'screen') return;
    selected = null;
    selectedReference = null;
    moveHandle.visible = false;
    if (stage.gizmoKind === 'screen') stage.detachGizmo();
    syncSelectionAppearance();
    syncPresentation();
  }

  /** Where the gizmo currently sits, in data coords — what a drag commits as the screen's new centre. */
  const handlePosition = (): V3 => [moveHandle.position.x, moveHandle.position.y, -moveHandle.position.z];

  return {
    get group() { return authored; },
    get referenceGroup() { return reference; },
    get screens() { return screens; },
    get selectedScreen() { return selected; },
    get selectedReferenceScreen() { return selectedReference; },
    setScreens, setReference, setVisible, setVideoTexture, seatScreen, seatReferenceScreen,
    clearSelection, handlePosition,
  };
}

export type ScreensLayer = ReturnType<typeof createScreensLayer>;
