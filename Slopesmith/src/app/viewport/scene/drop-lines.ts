import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { Stage } from '../stage';

/**
 * Drop lines (docs/012 · Drop lines): a thin plumb line from each selected Props-mode thing — a placed prop or every
 * member of a set, a gem, a rail or prop-line point, a light, a screen — straight down to the first authored
 * surface beneath it, ending in a dot where it lands. Where a prop stands relative to the snow is most of what
 * matters about it in this game, and from a perspective view a floating gem and a seated one can look identical;
 * the line answers it at a glance, in World and Surface frames alike, and follows a drag as it goes.
 *
 * Nothing is drawn for a thing standing on or sunk into the surface, or over nothing at all: there is no line to
 * show. The lines draw over the scene, as the gizmo does, so a ridge in front never hides them.
 *
 * The layer asks for the selected points every frame but casts only when they — or the ground — change, so an
 * idle selection costs a comparison and a drag costs one downward cast per point per frame, capped at
 * `MAX_DROP_LINES`.
 */

/** Where the selection's drop lines start and land. The host answers in data space. */
export interface DropLineSource {
  /** Every selected point that takes a drop line, re-read each frame; empty for none. */
  points(): readonly V3[];
  /** The height of the first authored surface straight below data-space (x, y, z), or null where nothing is. */
  groundBelow(x: number, y: number, z: number): number | null;
  /** Changes whenever the ground does, so the lines are re-cast after a terrain edit under a still selection. */
  groundVersion(): string;
}

/** The most lines one selection draws: a box-select of a forest still reads, and a drag stays cheap. */
export const MAX_DROP_LINES = 256;

/** Drop-line amber, the selection marquee's colour, which reads on snow, rock and sky alike. */
const DROP_LINE_COLOR = 0xffa23a;
/** Above the scene's overlays, as the gizmo it hangs from is. */
const DROP_LINE_RENDER_ORDER = 95;

/** A soft round dot, built as data rather than on a canvas so the layer needs no DOM. */
function dotTexture(): THREE.DataTexture {
  const n = 16, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
    const i = (y * n + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, (1 - r) * 4)));
  }
  const texture = new THREE.DataTexture(data, n, n);
  texture.needsUpdate = true;
  return texture;
}

export function createDropLinesLayer(stage: Stage, source: DropLineSource) {
  const linePositions = new Float32Array(MAX_DROP_LINES * 6);
  const dotPositions = new Float32Array(MAX_DROP_LINES * 3);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  lineGeometry.setDrawRange(0, 0);
  const dotGeometry = new THREE.BufferGeometry();
  dotGeometry.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3));
  dotGeometry.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
    color: DROP_LINE_COLOR, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
  }));
  const dots = new THREE.Points(dotGeometry, new THREE.PointsMaterial({
    color: DROP_LINE_COLOR, size: 7, sizeAttenuation: false, map: dotTexture(), transparent: true,
    alphaTest: 0.05, depthTest: false, depthWrite: false,
  }));
  for (const object of [lines, dots]) {
    object.renderOrder = DROP_LINE_RENDER_ORDER;
    object.frustumCulled = false; // the buffers are rewritten in place; their bounds are never recomputed
    object.raycast = () => { /* an indicator, never a pick target */ };
  }
  const group = new THREE.Group();
  group.name = 'Drop lines';
  group.add(lines, dots);
  stage.worldRoot.add(group); // data coords: worldRoot carries the Z mirror

  let lastPoints: number[] = [];
  let lastGround = '';
  let shown = 0;

  /** Re-read the selection and re-cast where it moved (or the ground did). Cheap when nothing changed. */
  function sync() {
    const points = source.points();
    const count = Math.min(points.length, MAX_DROP_LINES);
    const ground = count ? source.groundVersion() : lastGround;
    let same = count * 3 === lastPoints.length && ground === lastGround;
    for (let i = 0; same && i < count; i++)
      for (let k = 0; k < 3; k++) if (points[i][k] !== lastPoints[i * 3 + k]) { same = false; break; }
    if (same) return;
    lastPoints = [];
    lastGround = ground;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const [x, y, z] = points[i];
      lastPoints.push(x, y, z);
      const below = source.groundBelow(x, y, z);
      if (below === null || y - below < 1e-3) continue; // on or in the surface, or over nothing: no line to draw
      linePositions.set([x, y, z, x, below, z], n * 6);
      dotPositions.set([x, below, z], n * 3);
      n++;
    }
    shown = n;
    lineGeometry.setDrawRange(0, n * 2);
    dotGeometry.setDrawRange(0, n);
    lineGeometry.getAttribute('position').needsUpdate = true;
    dotGeometry.getAttribute('position').needsUpdate = true;
    group.visible = n > 0;
  }

  return {
    sync,
    /** How many lines are drawn now. */
    get count() { return shown; },
    /** The drawn lines' ends, data space: `[top, foot]` per line. */
    segments(): [V3, V3][] {
      return Array.from({ length: shown }, (_, i) => {
        const p = linePositions.subarray(i * 6, i * 6 + 6);
        return [[p[0], p[1], p[2]], [p[3], p[4], p[5]]];
      });
    },
  };
}

export type DropLinesLayer = ReturnType<typeof createDropLinesLayer>;
