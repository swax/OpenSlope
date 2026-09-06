import * as THREE from 'three';
import type { Stage } from '../stage';

export type SourceMarkerKind = 'light' | 'sound' | 'prop' | 'screen';
export type SourceMarkerOrigin = 'authored' | 'reference';
export type LightSourceMarkerIcon = 'bulb' | 'spotlight';

const ICON_SIZE = 32;
const ICON_COLUMNS = 2;
const ICON_ATLAS_WIDTH = ICON_SIZE * ICON_COLUMNS;
const MARKER_PX = 28;
// Occluded Sources are only a location hint. Keep them at one quarter of the former 28% x-ray strength so
// visible bulbs, speakers and movie icons dominate while every hidden marker remains discoverable/clickable.
const OCCLUDED_OPACITY = 0.07;

export interface SourceMarkerOptions {
  /** Per-bulb display colours. Sound markers retain their fixed cyan speaker fill. */
  colors?: readonly THREE.ColorRepresentation[];
  /** Point/directional lights use bulbs; spot lights use a theatre spotlight silhouette. */
  icons?: readonly LightSourceMarkerIcon[];
  /** Cone-centre target in the marker cloud's local space; rotates spotlight silhouettes on screen. */
  aimTargets?: readonly THREE.Vector3[];
  /** One marker receives the bold black selected outline; null/omitted leaves every marker thin. */
  selectedIndex?: number | null;
}

/** Build a tiny vector-like RGBA icon without a DOM canvas, so the same marker code remains testable in Node. */
function sourceIconTexture(kind: SourceMarkerKind, selected = false): THREE.DataTexture {
  const data = new Uint8Array(ICON_ATLAS_WIDTH * ICON_SIZE * 4);
  const pixel = (x: number, y: number, color: readonly [number, number, number, number]) => {
    if (x < 0 || y < 0 || x >= ICON_ATLAS_WIDTH || y >= ICON_SIZE) return;
    data[(y * ICON_ATLAS_WIDTH + x) * 4] = color[0];
    data[(y * ICON_ATLAS_WIDTH + x) * 4 + 1] = color[1];
    data[(y * ICON_ATLAS_WIDTH + x) * 4 + 2] = color[2];
    data[(y * ICON_ATLAS_WIDTH + x) * 4 + 3] = color[3];
  };
  const disc = (cx: number, cy: number, radius: number, color: readonly [number, number, number, number]) => {
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++)
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) pixel(x, y, color);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, width: number,
    color: readonly [number, number, number, number]) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      disc(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), width, color);
    }
  };
  const dark = [0, 0, 0, 255] as const;
  const fill = [255, 255, 255, 255] as const;

  if (kind === 'light') {
    // White is multiplied by the geometry's per-source vertex colour. Keeping the contour true black means
    // pale/yellow bulbs and saturated red/blue bulbs remain equally legible.
    const outlineWidth = selected ? 2.7 : 1.25;
    const fillWidth = selected ? 0.65 : 0.8;
    // rays, glass bulb, neck and screw base
    for (const [x0, y0, x1, y1] of [[16, 1, 16, 5], [5, 7, 8, 10], [27, 7, 24, 10],
      [3, 17, 7, 17], [29, 17, 25, 17]] as const) {
      line(x0, y0, x1, y1, outlineWidth, dark); line(x0, y0, x1, y1, fillWidth, fill);
    }
    disc(16, 15, selected ? 10.5 : 9, dark);
    disc(16, 15, selected ? 7.3 : 7.8, fill);
    // flatten the lower bulb into a short neck before the base
    for (let y = 20; y <= 24; y++) for (let x = 11; x <= 21; x++) pixel(x, y, dark);
    for (let y = 20; y <= (selected ? 21 : 22); y++) for (let x = 13; x <= 19; x++) pixel(x, y, fill);
    line(11, 25, 21, 25, selected ? 2.3 : 1.2, dark); line(12, 25, 20, 25, 0.45, fill);
    line(12, 28, 20, 28, selected ? 2.3 : 1.2, dark); line(13, 28, 19, 28, 0.45, fill);

    // A side-on theatre lamp occupies the second atlas tile. Its flared can, front lens, yoke and short
    // light rays read differently from the omni-directional bulb even when hundreds of markers are visible.
    const ox = ICON_SIZE;
    const spotLine = (x0: number, y0: number, x1: number, y1: number, width: number,
      color: readonly [number, number, number, number]) => line(ox + x0, y0, ox + x1, y1, width, color);
    const spotDisc = (x: number, y: number, radius: number,
      color: readonly [number, number, number, number]) => disc(ox + x, y, radius, color);
    // lamp housing: dark outer can with a smaller colour-multiplied face
    for (let y = 7; y <= 25; y++) {
      const left = y < 11 ? 8 - Math.floor((y - 7) / 2) : y > 21 ? 6 + Math.floor((y - 21) / 2) : 5;
      const right = y < 11 ? 20 + (y - 7) : y > 21 ? 24 - (y - 21) : 24;
      for (let x = left; x <= right; x++) pixel(ox + x, y, dark);
    }
    for (let y = selected ? 11 : 10; y <= (selected ? 20 : 22); y++) {
      const left = 8;
      const right = y < 13 ? 19 + (y - 10) : y > 19 ? 22 - (y - 19) : 22;
      for (let x = left; x <= right; x++) pixel(ox + x, y, fill);
    }
    // front lens and rear handle
    spotLine(24, 9, 24, 23, selected ? 2.5 : 1.25, dark);
    spotLine(24, 12, 24, 20, 0.55, fill);
    spotLine(6, 9, 3, 6, selected ? 2.2 : 1.1, dark);
    spotLine(4, 6, 9, 5, selected ? 2.2 : 1.1, dark);
    // hanging yoke / stand
    spotLine(9, 23, 11, 28, selected ? 2.2 : 1.15, dark);
    spotLine(21, 23, 19, 28, selected ? 2.2 : 1.15, dark);
    spotLine(10, 29, 20, 29, selected ? 2.4 : 1.3, dark);
    // three short beams coming off the lens
    for (const [x0, y0, x1, y1] of [[27, 11, 30, 9], [27, 16, 31, 16], [27, 21, 30, 23]] as const) {
      spotLine(x0, y0, x1, y1, selected ? 2 : 1.05, dark);
      spotDisc(x1, y1, selected ? 0.35 : 0.55, fill);
    }
  } else if (kind === 'prop') {
    // an isometric wireframe cube — the stand-in glyph for a placement with nothing visible to click
    // (hidden trigger/proxy/junk instances, surfaceless models); amber like the editor's selection accents
    const amber = [255, 194, 77, 255] as const;
    const outlineWidth = selected ? 2.4 : 1.3;
    const fillWidth = selected ? 0.9 : 0.6;
    const edges = [
      [16, 3, 27, 9], [16, 3, 5, 9],     // top-face far edges
      [5, 9, 16, 15], [27, 9, 16, 15],   // top-face near edges
      [5, 9, 5, 22], [27, 9, 27, 22],    // outer verticals
      [16, 15, 16, 28],                  // centre vertical
      [5, 22, 16, 28], [27, 22, 16, 28], // bottom edges
    ] as const;
    for (const [x0, y0, x1, y1] of edges) line(x0, y0, x1, y1, outlineWidth, dark);
    for (const [x0, y0, x1, y1] of edges) line(x0, y0, x1, y1, fillWidth, amber);
  } else if (kind === 'screen') {
    // A video screen on its post: the board seen head-on with a play triangle, which is what says "video"
    // rather than "sign" at 28 px. Teal, the accent the screen panels already draw their border in, so the
    // marker and the rectangle it stands on read as one thing.
    const teal = [63, 224, 208, 255] as const;
    const outlineWidth = selected ? 2.6 : 1.4;
    // screen bezel: a dark slab with a teal face
    for (let y = 5; y <= 21; y++) for (let x = 3; x <= 29; x++) pixel(x, y, dark);
    for (let y = 5 + Math.round(outlineWidth); y <= 21 - Math.round(outlineWidth); y++)
      for (let x = 3 + Math.round(outlineWidth); x <= 29 - Math.round(outlineWidth); x++) pixel(x, y, teal);
    // play triangle, punched back out in dark so it reads at any size
    for (let y = 8; y <= 18; y++) {
      const half = Math.round((10 - Math.abs(13 - y)) * 0.9);
      for (let x = 13; x <= 13 + half; x++) pixel(x, y, dark);
    }
    // post and footing
    line(16, 21, 16, 27, selected ? 3 : 1.9, dark);
    line(11, 28, 21, 28, selected ? 2.6 : 1.6, dark);
  } else {
    const cyan = [83, 217, 255, 255] as const;
    // speaker body + horn
    for (let y = 11; y <= 21; y++) for (let x = 4; x <= 11; x++) pixel(x, y, dark);
    for (let y = 13; y <= 19; y++) for (let x = 6; x <= 11; x++) pixel(x, y, cyan);
    for (let y = 7; y <= 25; y++) {
      const left = y < 11 ? 19 - (y - 7) * 2 : y <= 21 ? 11 : 11 + (y - 21) * 2;
      for (let x = left; x <= 19; x++) pixel(x, y, dark);
      if (y >= 9 && y <= 23) for (let x = Math.min(18, left + 2); x <= 17; x++) pixel(x, y, cyan);
    }
    // two broadcast arcs
    for (const radius of [7, 11]) for (let deg = -55; deg <= 55; deg += 3) {
      const a = deg * Math.PI / 180;
      const x = Math.round(17 + Math.cos(a) * radius), y = Math.round(16 + Math.sin(a) * radius);
      disc(x, y, 1.7, dark); disc(x, y, 0.65, cyan);
    }
  }

  const texture = new THREE.DataTexture(data, ICON_ATLAS_WIDTH, ICON_SIZE, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Keep the source family in one Points draw call while choosing one horizontal atlas tile per marker. */
function sourceMarkerMaterial(texture: THREE.Texture, vertexColors: boolean, depthTest: boolean,
  opacity: number, alphaTest: number): THREE.PointsMaterial {
  const material = new THREE.PointsMaterial({
    map: texture, size: MARKER_PX, sizeAttenuation: false, opacity,
    vertexColors, transparent: true, alphaTest, depthTest, depthWrite: false,
  });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float sourceIcon;
attribute vec3 sourceAimTarget;
varying float vSourceIcon;
varying vec2 vSourceDirection;`)
      .replace('void main() {', 'void main() {\n\tvSourceIcon = sourceIcon;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 sourceTargetView = modelViewMatrix * vec4(sourceAimTarget, 1.0);
  vec4 sourceTargetClip = projectionMatrix * sourceTargetView;
  vec2 sourceProjectedDirection = sourceTargetClip.xy / sourceTargetClip.w - gl_Position.xy / gl_Position.w;
  vSourceDirection = length(sourceProjectedDirection) > 0.00001
    ? normalize(vec2(sourceProjectedDirection.x, -sourceProjectedDirection.y)) : vec2(1.0, 0.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSourceIcon;\nvarying vec2 vSourceDirection;')
      .replace('#include <map_particle_fragment>', `
#ifdef USE_MAP
  vec2 sourcePointCoord = gl_PointCoord;
  if (vSourceIcon > 0.5) {
    vec2 sourceCentered = sourcePointCoord - 0.5;
    sourcePointCoord = vec2(
      dot(sourceCentered, vSourceDirection),
      dot(sourceCentered, vec2(-vSourceDirection.y, vSourceDirection.x))
    ) + 0.5;
    if (any(lessThan(sourcePointCoord, vec2(0.0))) || any(greaterThan(sourcePointCoord, vec2(1.0)))) discard;
  }
  vec2 sourceUv = vec2(
    (sourcePointCoord.x * ${ICON_SIZE - 1}.0 + 0.5 + vSourceIcon * ${ICON_SIZE}.0) / ${ICON_ATLAS_WIDTH}.0,
    ((1.0 - sourcePointCoord.y) * ${ICON_SIZE - 1}.0 + 0.5) / ${ICON_SIZE}.0
  );
  diffuseColor *= texture2D(map, sourceUv);
#endif`);
  };
  material.customProgramCacheKey = () => 'source-marker-directional-atlas-v2';
  return material;
}

/** One draw-call icon cloud. Its custom raycast matches the icon's constant screen size instead of using
 * THREE.Points' fixed world-unit threshold, so distant sources remain as easy to click as nearby ones. */
export function sourceMarkerPoints(stage: Stage, kind: SourceMarkerKind, origin: SourceMarkerOrigin,
  positions: readonly THREE.Vector3[], options: SourceMarkerOptions = {}): THREE.Points {
  const geometry = new THREE.BufferGeometry().setFromPoints([...positions]);
  const vertexColors = kind === 'light';
  geometry.setAttribute('sourceIcon', new THREE.Float32BufferAttribute(positions.map((_, index) =>
    kind === 'light' && options.icons?.[index] === 'spotlight' ? 1 : 0), 1));
  const aimTargetValues: number[] = [];
  for (let index = 0; index < positions.length; index++) {
    const target = options.aimTargets?.[index] ?? positions[index].clone().add(new THREE.Vector3(1, 0, 0));
    aimTargetValues.push(target.x, target.y, target.z);
  }
  geometry.setAttribute('sourceAimTarget', new THREE.Float32BufferAttribute(aimTargetValues, 3));
  if (vertexColors) {
    const values: number[] = [];
    for (let index = 0; index < positions.length; index++) {
      const color = new THREE.Color(options.colors?.[index] ?? '#ffd24a');
      values.push(color.r, color.g, color.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(values, 3));
  }
  const texture = sourceIconTexture(kind);
  // The base pass is the x-ray hint: it always draws, but faintly. A second full-bright pass below obeys the
  // scene depth buffer, covering this one wherever the source is visible and failing wherever terrain/props
  // occlude it. The result reads as bright in front and dim behind without sacrificing discoverability.
  const material = sourceMarkerMaterial(texture, vertexColors, false, OCCLUDED_OPACITY, 0.02);
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 90;
  const visibleMaterial = sourceMarkerMaterial(texture, vertexColors, true, 1, 0.08);
  const visiblePass = new THREE.Points(geometry, visibleMaterial);
  visiblePass.renderOrder = 91;
  visiblePass.userData.sourceVisiblePass = true;
  visiblePass.raycast = () => {}; // the parent owns the one constant-screen-size click target
  points.add(visiblePass);

  // The selected marker is still part of the same clickable batch. These two one-point render passes simply
  // redraw that position with a bolder black-outline texture, preserving the visible/occluded treatment.
  const selectedGeometry = new THREE.BufferGeometry();
  const selectedTexture = sourceIconTexture(kind, true);
  const selectedXrayMaterial = sourceMarkerMaterial(selectedTexture, vertexColors, false, OCCLUDED_OPACITY, 0.02);
  const selectedXrayPass = new THREE.Points(selectedGeometry, selectedXrayMaterial);
  selectedXrayPass.renderOrder = 92;
  selectedXrayPass.userData.sourceSelectionPass = true;
  selectedXrayPass.raycast = () => {};
  const selectedVisibleMaterial = sourceMarkerMaterial(selectedTexture, vertexColors, true, 1, 0.08);
  const selectedVisiblePass = new THREE.Points(selectedGeometry, selectedVisibleMaterial);
  selectedVisiblePass.renderOrder = 93;
  selectedVisiblePass.userData.sourceSelectionPass = true;
  selectedVisiblePass.raycast = () => {};
  points.add(selectedXrayPass, selectedVisiblePass);
  points.userData.sourceSelectionGeometry = selectedGeometry;
  points.userData.sourceKind = kind;
  points.userData.sourceOrigin = origin;
  points.raycast = (raycaster, intersections) => {
    const attribute = geometry.getAttribute('position');
    const world = new THREE.Vector3(), onRay = new THREE.Vector3();
    for (let index = 0; index < attribute.count; index++) {
      world.fromBufferAttribute(attribute, index).applyMatrix4(points.matrixWorld);
      const worldPerPixel = typeof (stage as Partial<Stage>).worldPerPixel === 'function'
        ? stage.worldPerPixel(world) : 0.1;
      const distanceToRay = raycaster.ray.distanceToPoint(world);
      if (distanceToRay > worldPerPixel * MARKER_PX * 0.58) continue;
      raycaster.ray.closestPointToPoint(world, onRay);
      const distance = raycaster.ray.origin.distanceTo(onRay);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      intersections.push({ distance, distanceToRay, point: onRay.clone(), index, object: points });
    }
  };
  setSourceMarkerSelected(points, options.selectedIndex ?? null);
  return points;
}

/** Update the one bold-outline marker without rebuilding or splitting the batched clickable cloud. */
export function setSourceMarkerSelected(points: THREE.Points | null, index: number | null) {
  if (!points) return;
  const selected = points.userData.sourceSelectionGeometry as THREE.BufferGeometry | undefined;
  if (!selected) return;
  const positions = points.geometry.getAttribute('position');
  if (index === null || index < 0 || index >= positions.count) {
    selected.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    selected.setAttribute('sourceIcon', new THREE.Float32BufferAttribute([], 1));
    selected.setAttribute('sourceAimTarget', new THREE.Float32BufferAttribute([], 3));
    if (points.material instanceof THREE.PointsMaterial && points.material.vertexColors)
      selected.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
  } else {
    selected.setAttribute('position', new THREE.Float32BufferAttribute([
      positions.getX(index), positions.getY(index), positions.getZ(index),
    ], 3));
    const icons = points.geometry.getAttribute('sourceIcon');
    selected.setAttribute('sourceIcon', new THREE.Float32BufferAttribute([icons?.getX(index) ?? 0], 1));
    const target = points.geometry.getAttribute('sourceAimTarget');
    selected.setAttribute('sourceAimTarget', new THREE.Float32BufferAttribute([
      target?.getX(index) ?? positions.getX(index) + 1,
      target?.getY(index) ?? positions.getY(index), target?.getZ(index) ?? positions.getZ(index),
    ], 3));
    const colors = points.geometry.getAttribute('color');
    if (colors) selected.setAttribute('color', new THREE.Float32BufferAttribute([
      colors.getX(index), colors.getY(index), colors.getZ(index),
    ], 3));
  }
  selected.computeBoundingSphere();
}

export function disposeSourceMarkerPoints(points: THREE.Points | null) {
  if (!points) return;
  let selectedTexture: THREE.Texture | null = null;
  for (const child of points.children) {
    if (!(child instanceof THREE.Points)) continue;
    const childMaterial = child.material as THREE.PointsMaterial;
    if (child.userData.sourceSelectionPass === true && !selectedTexture) selectedTexture = childMaterial.map;
    childMaterial.dispose();
  }
  selectedTexture?.dispose();
  const selectionGeometry = points.userData.sourceSelectionGeometry as THREE.BufferGeometry | undefined;
  selectionGeometry?.dispose();
  points.clear();
  points.geometry.dispose();
  const material = points.material as THREE.PointsMaterial;
  material.map?.dispose();
  material.dispose();
}
