import * as THREE from 'three';
import { captureProgress } from '../../state/capture-progress';
import { mountainSpeedSolver, type MountainSpeedSolver, type SpeedLine, type SpeedQuilt } from '../../ride/mountain-speed';
import { TRAIL_SPEED_FILL_OPACITY } from '../constants';
import { trailSpeedColor } from './trail-speed-colors';

/** How long the quilt must hold still before the prediction is ridden again: a drag re-emits patches every frame. */
const SETTLE_MS = 250;
/** The prediction rides in slices this long, so a large mountain never holds the page. */
const SLICE_MS = 8;
/** A gate further than this from any ground it could set off on is not on the mountain: the key says so. */
const FAR_START_M = 10;

export interface SpeedShadeHost {
  /** The quilt the terrain draws — its live buffers, read when a prediction starts — or null with none. */
  quilt(): SpeedQuilt | null;
  /** The course's lines the prediction rides, read when it starts (see `linesChanged`). */
  lines(): SpeedLine[];
  /** Whether that quilt is a mountain's: a model's mesh, being edited in its place, has no start to ride from. */
  applies(): boolean;
  /** The shading now does (or no longer does) show — its key follows. */
  shown(shown: boolean): void;
  /** A word for the key under the colours, or null for none; a host with no say over the start leaves it out. */
  note?(text: string | null): void;
}

/**
 * A mountain's course shaded by the speed a rider carries down it (docs/023 · Predicted speed, the mountain;
 * app/ride/mountain-speed.ts), in the trail prediction's colours — the authored mountain, or a loaded reference
 * level. A wash over the terrain that SHARES its geometry, as the cage view's depth mask does — positions, index and
 * hidden patches alike — and reads its colours from an attribute of its own on it, so a drag carries the wash with
 * the surface and only the prediction waits: it is ridden again a moment after the quilt or the course last moved, a
 * slice at a time, and the colours it replaces stand until it is done. Ground the course's lines do not come near is
 * left bare.
 */
export function createSpeedShade(parent: THREE.Object3D, host: SpeedShadeHost) {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: TRAIL_SPEED_FILL_OPACITY,
    depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // The terrain's own `color` attribute carries its tint and light; the wash reads `speedColor` in its place, whose
  // alpha leaves a wall bare.
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute vec4 speedColor;\n'
      + shader.vertexShader.replace('#include <color_vertex>', 'vColor = speedColor;');
  };
  material.customProgramCacheKey = () => 'mountain-speed-shade';
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.renderOrder = 8; // over the terrain, under the selection's fills (9) and the cage wires
  mesh.visible = false;
  mesh.raycast = () => { /* a pure wash, never a pick target */ };
  parent.add(mesh);

  let on = false;
  /** Whether the quilt was a mountain's when last asked (`refresh`). */
  let applied = host.applies();
  /** What the course's lines were when last told (`linesChanged`). */
  let linesKey: string | null = null;
  /** The last finished prediction's colours, linear rgba per lattice point; null before one, or once stale beyond
   *  use. */
  let colors: Float32Array | null = null;
  /** How far the gate stood from the ground in that prediction, metres. */
  let startGap = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let solver: MountainSpeedSolver | null = null;
  /** Ends the capture hold a pending prediction keeps, so a screenshot waits for the colours it would show. */
  let holding: (() => void) | null = null;

  /** Seat the colours on the shared geometry when they fit it, and show the wash when there is one to show. */
  function present() {
    const g = mesh.geometry;
    const fits = !!colors && g.getAttribute('position')?.count === colors.length / 4;
    if (fits) {
      const attr = g.getAttribute('speedColor') as THREE.BufferAttribute | undefined;
      if (attr?.array === colors) attr.needsUpdate = true;
      else g.setAttribute('speedColor', new THREE.BufferAttribute(colors!, 4));
    }
    const shown = on && host.applies() && fits;
    if (shown !== mesh.visible) { mesh.visible = shown; host.shown(shown); }
    host.note?.(!shown || startGap <= FAR_START_M ? null
      : Number.isFinite(startGap)
        ? `The course starts ${startGap.toFixed(0)} m from any ground to ride, so nearly nothing is reached — `
          + 'move it onto the mountain.'
        : 'There is no ground to ride along the course.');
  }

  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    solver = null;
    holding?.();
    holding = null;
  }

  /** Ride the prediction again once things have held still for `delay`. */
  function schedule(delay = SETTLE_MS) {
    stop();
    if (!on || !host.applies()) return;
    holding = captureProgress.begin('predicted speed');
    timer = setTimeout(slice, delay);
  }

  function slice() {
    timer = null;
    const quilt = host.quilt();
    if (!on || !quilt || linesKey === null || !host.applies()) { stop(); return; }
    solver ??= mountainSpeedSolver(quilt, host.lines());
    const until = performance.now() + SLICE_MS;
    const result = solver.run(() => performance.now() < until);
    if (!result) { timer = setTimeout(slice, 0); return; }
    stop();
    // Ground no lane comes near, or nobody rides, is left bare rather than shown as ground never reached.
    const rgba = new Float32Array(result.speed.length * 4);
    for (let i = 0; i < result.speed.length; i++) {
      trailSpeedColor(result.speed[i], result.air[i] === 1).toArray(rgba, i * 4);
      rgba[i * 4 + 3] = result.bare[i] ? 0 : 1;
    }
    colors = rgba;
    startGap = result.startGap;
    present();
  }

  return {
    /** Turn the wash on or off. */
    setOn(next: boolean) {
      if (next === on) return;
      on = next;
      // Nothing follows the quilt while the wash is off, so what it last showed is no guide to the next.
      if (on) schedule(0); else { stop(); colors = null; }
      present();
    },
    /** The course's lines may have changed: `key` names what they are now, so the same lines ride nothing again,
     *  and null clears them. */
    linesChanged(key: string | null) {
      if (key === linesKey) return;
      linesKey = key;
      schedule();
    },
    /** The terrain rebuilt its geometry: follow it there. The last colours stand while they still fit it. Null: the
     *  terrain is gone, and so is all it showed. */
    geometryRebuilt(g: THREE.BufferGeometry | null) {
      mesh.geometry = g ?? new THREE.BufferGeometry();
      if (!g) colors = null;
      present();
      schedule();
    },
    /** Patches moved or were repainted in place: re-ride once they settle. */
    changed() { schedule(); },
    /** Whether the quilt is a mountain's may have changed (a model edit began or ended): if it did, show or hide, and
     *  re-ride. A model's mesh takes the terrain's place meanwhile, so nothing shown before it is kept. Hosts call
     *  this on every synced document too, so it does nothing while the answer stands. */
    refresh() {
      const applies = host.applies();
      if (applies === applied) return;
      applied = applies;
      if (!applies) colors = null;
      present();
      schedule(0);
    },
  };
}

export type SpeedShade = ReturnType<typeof createSpeedShade>;
