import * as THREE from 'three';
import type { AuthoredLight, V3 } from '../../../core/doc/types';
import { authoredRig, freeLightToPlaced, type PlacedLight } from '../../../core/lighting/sign-lights';
import { propRigGlow, type LightRig } from '../../../core/reference/lights';
import { PROP_RIG_MAX_BOOST, SIGN_TINT_STRENGTH } from '../constants';
import { addLightGizmo, lightAimTarget } from '../gizmo/geometry';
import type { Stage } from '../stage';
import { disposeSourceMarkerPoints, setSourceMarkerSelected, sourceMarkerPoints } from './source-markers';

/**
 * Authored local lights (docs/013): the derived billboard SIGN lights + the hand-placed FREE lights, as one
 * rig. This layer owns the light data + compact bulb markers / selected wire rig (under `stage.worldRoot`)
 * + free-light editing. The rig's EFFECTS are consumed elsewhere — the terrain glow (the shell's terrain
 * lighting reads `authoredRigData` / `authoredLightsVisible` and bakes its own cached buffer) and the billboard
 * tint (`signTint`, read by the props layer). A rig/visibility change fires the `relight` hook so the shell
 * re-folds the terrain glow. Free-light selection follows the same shell-orchestrated pattern as rails / gems.
 */
export function createLightsLayer(stage: Stage) {
  const authoredLightsGroup = new THREE.Group();     // derived sign/group source bulbs + one selected rig
  const authoredDetailGroup = new THREE.Group();
  let authoredLightMarkers: THREE.Points | null = null;
  let authoredSourceIndices: number[] = [];
  let selectedRigSource: number | null = null;
  let authoredLights: PlacedLight[] = [];
  let authoredRigData: LightRig | null = null;
  let authoredLightsVisible = false;                 // effective Local lights: terrain glow + billboard tint
  let authoredRigVisible = false;                    // Sources pill (legacy name): bulbs + selected rig

  const freeLightGroup = new THREE.Group();
  const freeLightDetailGroup = new THREE.Group();
  let freeLightMarkers: THREE.Points | null = null;
  let freeLights: AuthoredLight[] = [];
  let selectedLight: string | null = null;           // the selected free light's stable id (docs/039)
  let lightArmed = false;                            // an Add-light click armed placement (drops on the next ground click)

  const lightMoveHandle = new THREE.Object3D();      // scene-root gizmo anchor for the selected free light

  /** A rig or visibility change: the shell invalidates the cached terrain glow (when `rigChanged`) and re-lights. */
  let relight: (rigChanged: boolean) => void = () => {};

  // ---- authored sign lights (a spot per placed billboard, docs/013) ----

  /** Set the authored local lights — the derived billboard sign lights PLUS the resolved free lights — as one
   *  rig for the terrain glow + billboard tint. Rebuilds the fixed sign-light gizmos, invalidates the cached
   *  terrain glow (via relight) and re-folds it. The billboard tint is applied by the host's following
   *  setPlacedProps, which reads this rig (signTint). */
  function setAuthoredLights(newLights: PlacedLight[]) {
    authoredLights = newLights;
    authoredRigData = newLights.length ? authoredRig(newLights) : null;
    buildAuthoredGizmos();
    relight(true);
  }

  /** The effective Local lights gate: show / hide the LIGHT the authored sources (sign + free) cast — their
   *  terrain glow AND their billboard tint. The billboard tint is re-evaluated by the host's prop rebuild on
   *  toggle; the terrain glow re-folds via relight. The wire gizmos ride Sources instead. */
  function showAuthoredLights(on: boolean) {
    authoredLightsVisible = on;
    relight(false);
  }

  /** The persisted Sources toggle exposes compact source bulbs. Only the selected source expands into
   * its full cone/sphere rig; hidden free lights remain unpickable. */
  function showAuthoredLightRig(on: boolean) {
    authoredRigVisible = on;
    authoredLightsGroup.visible = on && authoredSourceIndices.length > 0;
    freeLightGroup.visible = on && freeLights.length > 0;
  }

  function hasAuthoredLights(): boolean { return !!authoredRigData; }

  function clearDetail(group: THREE.Group) {
    group.traverse(object => {
      if (object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    group.clear();
    group.visible = false;
  }

  function detailFor(light: PlacedLight, group: THREE.Group) {
    clearDetail(group);
    const positions: number[] = [], colors: number[] = [];
    addLightGizmo(positions, colors, authoredRig([light]).lights[0], new THREE.Color());
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false }));
    lines.raycast = () => { /* selected rig is display-only; bulbs own the click */ };
    group.add(lines);
    group.visible = true;
  }

  /** Build one batched bulb cloud for derived sign/group sources; the chosen source alone gets full rig lines. */
  function buildAuthoredGizmos() {
    if (authoredLightMarkers) authoredLightsGroup.remove(authoredLightMarkers);
    disposeSourceMarkerPoints(authoredLightMarkers);
    authoredSourceIndices = authoredLights.map((light, index) => ({ light, index }))
      .filter(({ light }) => light.ofProp !== undefined || light.ofGroup !== undefined)
      .map(({ index }) => index);
    authoredLightMarkers = authoredSourceIndices.length ? sourceMarkerPoints(stage, 'light', 'authored',
      authoredSourceIndices.map(index => new THREE.Vector3(...authoredLights[index].pos)), {
        colors: authoredSourceIndices.map(index => authoredLights[index].colorHex),
        icons: authoredSourceIndices.map(index => authoredLights[index].kind === 'spot' ? 'spotlight' : 'bulb'),
        aimTargets: authoredSourceIndices.map(index => lightAimTarget(authoredLights[index])),
        selectedIndex: selectedRigSource,
      }) : null;
    if (authoredLightMarkers) authoredLightsGroup.add(authoredLightMarkers);
    if (selectedRigSource !== null && authoredSourceIndices[selectedRigSource] !== undefined)
      detailFor(authoredLights[authoredSourceIndices[selectedRigSource]], authoredDetailGroup);
    else { selectedRigSource = null; clearDetail(authoredDetailGroup); }
    authoredLightsGroup.visible = authoredRigVisible && authoredSourceIndices.length > 0;
  }

  /** Tint colour for a billboard from the sign light aimed at it: a saturating multiply
   *  `1 + MAX·(1 − e^(−strength·glow))` per channel, sampled where the light aims. Read by the props layer. */
  function signTint(aimAt: V3): THREE.Color {
    const M = PROP_RIG_MAX_BOOST, s = SIGN_TINT_STRENGTH;
    const [gr, gg, gb] = propRigGlow(aimAt, authoredRigData!);
    return new THREE.Color(1 + M * (1 - Math.exp(-s * gr)), 1 + M * (1 - Math.exp(-s * gg)), 1 + M * (1 - Math.exp(-s * gb)));
  }

  // ---- free lights (hand-placed, editable) ----

  /** Arm / disarm free-light placement: while armed, a props-mode click on empty terrain drops a new light. */
  function setArmed(on: boolean) { lightArmed = on; }

  /** Where the selected light sits in the list right now, or -1. The selection names a light rather than the
   *  slot it happens to occupy, so it is resolved fresh on every rebuild: deleting a light below it moves its
   *  index and leaves the selection exactly where it was (docs/039). */
  const selectedIndex = (): number =>
    selectedLight === null ? -1 : freeLights.findIndex(light => light.id === selectedLight);

  /** Rebuild the free-light bulb cloud from the doc and keep the selected light's one expanded rig + move
   * handle in sync. Parallels setPlacedProps without drawing every cone at once. */
  function setFreeLights(newLights: AuthoredLight[], selectedId: string | null) {
    freeLights = newLights;
    selectedLight = selectedId;
    buildFreeLightGizmos();
    const selIdx = selectedIndex();
    if (selIdx >= 0) {
      if (!(stage.gizmoKind === 'light' && stage.gizmo.dragging)) {
        placeLightHandle(selIdx);
        lightMoveHandle.visible = true;
        if (stage.gizmoKind !== 'light') stage.attachGizmo(lightMoveHandle, 'light', selIdx);
      }
    } else if (stage.gizmoKind === 'light') {
      clearSelection();
    }
  }

  function buildFreeLightGizmos() {
    const selIdx = selectedIndex();
    if (freeLightMarkers) freeLightGroup.remove(freeLightMarkers);
    disposeSourceMarkerPoints(freeLightMarkers);
    freeLightMarkers = freeLights.length ? sourceMarkerPoints(stage, 'light', 'authored',
      freeLights.map(light => new THREE.Vector3(...light.pos)), {
        colors: freeLights.map(light => light.color),
        icons: freeLights.map(light => light.kind === 'spot' ? 'spotlight' : 'bulb'),
        aimTargets: freeLights.map((light, index) => lightAimTarget(freeLightToPlaced(light, index))),
        selectedIndex: selIdx < 0 ? null : selIdx,
      }) : null;
    if (freeLightMarkers) {
      // Free lights remain semantic editable-light picks rather than derived source-only picks.
      freeLightMarkers.userData.lightPoints = true;
      delete freeLightMarkers.userData.sourceKind;
      delete freeLightMarkers.userData.sourceOrigin;
      freeLightGroup.add(freeLightMarkers);
    }
    // The index is still what names a light to a human: `Light 3` is the third in the list, wherever it moved.
    if (selIdx >= 0) detailFor(freeLightToPlaced(freeLights[selIdx], selIdx), freeLightDetailGroup);
    else clearDetail(freeLightDetailGroup);
    freeLightGroup.visible = authoredRigVisible && freeLights.length > 0;
  }

  /** Seat the scene-root gizmo handle on free light `i` (data pos, Z negated onto the flipped scene). */
  function placeLightHandle(i: number) {
    const L = freeLights[i];
    if (!L) return;
    lightMoveHandle.position.set(L.pos[0], L.pos[1], -L.pos[2]);
  }

  /** Seat the translate gizmo on the free light a pick landed on — an index, because that is what a raycast
   *  yields — and tell the host which light that is by name. */
  function seatLight(i: number) {
    const id = freeLights[i]?.id;
    if (!id) return;
    selectedLight = id;
    clearRigSource();
    buildFreeLightGizmos();
    placeLightHandle(i);
    lightMoveHandle.visible = true;
    stage.attachGizmo(lightMoveHandle, 'light', i);
    stage.cb.onSelectLight?.(id);
  }

  /** Drop any free-light selection: hide the handle and release the gizmo if it was on it. */
  function clearSelection() {
    if (selectedLight === null && stage.gizmoKind !== 'light') return;
    const rebuild = selectedLight !== null;
    selectedLight = null;
    lightMoveHandle.visible = false;
    if (stage.gizmoKind === 'light') stage.detachGizmo();
    if (rebuild) buildFreeLightGizmos();
  }

  /** Expand one non-editable derived sign/group source without manufacturing a document light selection. */
  function selectRigSource(index: number): boolean {
    const authoredIndex = authoredSourceIndices[index];
    const light = authoredIndex === undefined ? undefined : authoredLights[authoredIndex];
    if (!light) return false;
    selectedRigSource = index;
    setSourceMarkerSelected(authoredLightMarkers, index);
    detailFor(light, authoredDetailGroup);
    return true;
  }

  function clearRigSource() {
    selectedRigSource = null;
    setSourceMarkerSelected(authoredLightMarkers, null);
    clearDetail(authoredDetailGroup);
  }

  authoredDetailGroup.visible = false;
  authoredLightsGroup.add(authoredDetailGroup);
  authoredLightsGroup.visible = false;
  stage.worldRoot.add(authoredLightsGroup); // sign-light gizmos ride the same flip as the props
  freeLightDetailGroup.visible = false;
  freeLightGroup.add(freeLightDetailGroup);
  freeLightGroup.visible = false;
  stage.worldRoot.add(freeLightGroup);      // hand-placed free lights, same data coords as the props
  lightMoveHandle.visible = false;
  stage.scene.add(lightMoveHandle);

  return {
    get authoredLightsGroup() { return authoredLightsGroup; },
    get authoredLights() { return authoredLights; },
    get authoredRigData() { return authoredRigData; },
    get authoredLightsVisible() { return authoredLightsVisible; },
    get authoredRigVisible() { return authoredRigVisible; },
    get freeLightGroup() { return freeLightGroup; },
    get freeLights() { return freeLights; },
    get selectedLight() { return selectedLight; },
    get lightArmed() { return lightArmed; },
    /** Whether free-light placement is armed (the Prop Tools' Add light button shows pressed while it is). */
    get lightPlacing() { return lightArmed; },
    get relight() { return relight; },
    set relight(fn: (rigChanged: boolean) => void) { relight = fn; },
    setAuthoredLights, showAuthoredLights, showAuthoredLightRig, hasAuthoredLights, signTint,
    setArmed, setFreeLights, seatLight, clearSelection, selectRigSource, clearRigSource,
  };
}

export type LightsLayer = ReturnType<typeof createLightsLayer>;
