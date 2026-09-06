import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { CAGE_OCCLUDED_DIM } from '../constants';

/**
 * Push arrows for the MainType-0 boost family ([Trailmap: 360-node]). The purple outline says a prop carries
 * an effect; for a boost that is only half the data, because the node's whole point is a DIRECTION — an
 * exhaust vent, a conveyor, an air shaft and a finish tube are the same node pointing different ways. The
 * arrow draws that axis where the volume sits, so the layout reads off the mountain instead of out of the
 * inspector's three direction fields.
 *
 * Arrows are drawn in the reference's own frame (under `refRoot`) so they ride the comparison offset with the
 * props they belong to, and they are ghosted the way the control cage is: a boost usually lives INSIDE the
 * tube, vent or shaft that would hide it, so the occluded part still draws, dim. Megaplex authors 44 of them,
 * which is exactly the count that would shout if they all drew at full strength through the mountain.
 */

/** Editor metres. A zero-speed node still draws its axis at the floor length. */
const MIN_LENGTH = 6, MAX_LENGTH = 24, LENGTH_PER_SPEED = 0.06;

export interface BoostArrow {
  /** Anchor in the parent's frame — the host instance's origin, where the selection ring sits. */
  origin: THREE.Vector3;
  /** Push axis in the parent's frame. Need not be unit length; a zero vector draws nothing. */
  dir: THREE.Vector3;
  /** Authored target speed, which sets the shaft length between the floor and cap above. */
  speed: number;
  /** Barbs stacked back from the tip. One for a plain push; the tube-end launch numbers its three staged
   *  directions 1–3, so which arrow a rider gets is readable from the arrow itself. */
  barbs: number;
}

/** Cyan is the boost colour the preview pulses already use; the emphasised pair marks the selected host. The
 *  occluded twin of each is the dim behind-surface pass. */
export function boostArrowMaterial(emphasis: boolean, occluded: boolean): LineMaterial {
  const opacity = emphasis ? 1 : 0.8;
  return new LineMaterial({
    color: emphasis ? 0x9ceaff : 0x5bd6ff,
    linewidth: emphasis ? 3.2 : 2,
    transparent: true,
    opacity: occluded ? opacity * CAGE_OCCLUDED_DIM : opacity,
    depthWrite: false,
    // Only the fragments farther than the surface: the part of the arrow buried in its own tube.
    ...(occluded ? { depthFunc: THREE.GreaterDepth } : {}),
    // Fat lines rasterise as triangles, and worldRoot's chirality flip inverts their winding.
    side: THREE.DoubleSide,
  });
}

/** Line-segment positions for a set of arrows: an anchor cross, a shaft, and `barbs` stacked heads. */
export function boostArrowSegments(arrows: readonly BoostArrow[]): number[] {
  const out: number[] = [];
  for (const arrow of arrows) appendArrow(out, arrow);
  return out;
}

const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0);

function appendArrow(out: number[], arrow: BoostArrow): void {
  if (arrow.dir.lengthSq() < 1e-8) return;
  const dir = arrow.dir.clone().normalize();
  const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, MIN_LENGTH + arrow.speed * LENGTH_PER_SPEED));
  const head = length * 0.2, half = head * 0.45;
  // Two perpendiculars, so the head reads as an arrow from any camera angle rather than collapsing to a line
  // when viewed along its own fin plane.
  const p = new THREE.Vector3().crossVectors(Math.abs(dir.y) > 0.9 ? X_AXIS : Y_AXIS, dir).normalize();
  const q = new THREE.Vector3().crossVectors(dir, p).normalize();
  const tip = arrow.origin.clone().addScaledVector(dir, length);
  const segment = (a: THREE.Vector3, b: THREE.Vector3) =>
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  // Anchor cross: which prop owns the arrow, for a vent sitting shoulder to shoulder with its twin.
  for (const side of [p, q]) segment(
    arrow.origin.clone().addScaledVector(side, -half),
    arrow.origin.clone().addScaledVector(side, half));
  segment(arrow.origin, tip);
  for (let barb = 0; barb < Math.max(1, arrow.barbs); barb++) {
    const apex = tip.clone().addScaledVector(dir, -barb * head * 0.7);
    const back = apex.clone().addScaledVector(dir, -head);
    for (const side of [p, q]) {
      segment(apex, back.clone().addScaledVector(side, half));
      segment(apex, back.clone().addScaledVector(side, -half));
    }
  }
}

/**
 * The drawn layer: one group under `parent` holding a plain and an emphasised line set, each in a visible and
 * an occluded pass over shared geometry. The caller owns which arrows land in which set and when the group is
 * shown.
 */
export function createBoostArrowLayer(parent: THREE.Object3D) {
  const group = new THREE.Group();
  group.name = 'Boost push arrows';
  group.visible = false;
  parent.add(group);
  const materials = [
    boostArrowMaterial(false, false), boostArrowMaterial(false, true),
    boostArrowMaterial(true, false), boostArrowMaterial(true, true),
  ] as const;
  let geometries: LineSegmentsGeometry[] = [];

  function clear() {
    for (const geometry of geometries) geometry.dispose();
    geometries = [];
    group.clear();
  }

  return {
    /** Fat lines rasterise in pixels, so the host's resize() keeps these fresh. */
    get materials() { return materials; },
    setArrows(plain: readonly BoostArrow[], emphasised: readonly BoostArrow[]) {
      clear();
      for (const [set, arrows] of [plain, emphasised].entries()) {
        const positions = boostArrowSegments(arrows);
        if (!positions.length) continue;
        const geometry = new LineSegmentsGeometry().setPositions(positions);
        geometries.push(geometry);
        // The two passes partition the same arrow by depth — one draws what the surface hides, the other
        // what it doesn't — so neither can dim or double-draw the other.
        for (const occluded of [true, false]) {
          const lines = new LineSegments2(geometry, materials[set * 2 + (occluded ? 1 : 0)]);
          lines.renderOrder = 100;
          lines.raycast = () => { /* never a pick target */ };
          group.add(lines);
        }
      }
    },
    setVisible(on: boolean) { group.visible = on; },
    dispose() {
      clear();
      parent.remove(group);
      for (const material of materials) material.dispose();
    },
  };
}

export type BoostArrowLayer = ReturnType<typeof createBoostArrowLayer>;
