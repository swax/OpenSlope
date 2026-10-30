import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { RefAiPath } from '../../../core/reference/terrain';
import type { V3 } from '../../../core/doc/types';
import { aiPathEventSpan } from '../../../core/reference/ai-paths';
import {
  AI_PATH_EVENT_SHAPE_PATHS,
  AI_PATH_OUTLINE,
  aiPathColor,
  aiPathCssColor,
  aiPathEventStyle,
  type AiPathEventShape,
} from '../../ai-path-style';
import { occludedMaterial, textSprite } from '../shared/overlays';
import { CAGE_OCCLUDED_DIM } from '../constants';
import { fadeMaterial, fadeObject } from '../shared/fade';
import type { Stage } from '../stage';

/** Rating-coloured paths with event spans and symbols; only the selected route has numbered annotations. */
export function createReferenceAiPathsLayer(stage: Stage, root: THREE.Object3D = stage.refRoot) {
  const group = new THREE.Group();
  const annotationGroup = new THREE.Group();
  const eventGroup = new THREE.Group();
  root.add(group, eventGroup, annotationGroup);
  let paths: RefAiPath[] = [];
  let visible = false;
  let selected: number | null = null;
  let fade = 1;
  const lineMaterial = (color: number, width: number, dashed = false) =>
    new LineMaterial({
      color,
      linewidth: width,
      dashed,
      dashSize: 3,
      gapSize: 2,
      // Overlay queue: opaque terrain tiles can be created after these materials as images load.
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  const outlines = [lineMaterial(AI_PATH_OUTLINE, 9), lineMaterial(AI_PATH_OUTLINE, 9, true)];
  const eventBorder = lineMaterial(AI_PATH_OUTLINE, 9);
  const eventMaterials = new Map(
    [100, 101, 103, 300, -1].map(type => {
      const { color } = aiPathEventStyle(type);
      return [color, lineMaterial(color, 6)];
    }),
  );
  const fixedMaterials = [...outlines, eventBorder, ...eventMaterials.values()];
  const aiPathMaterials = [...fixedMaterials];
  const pathMaterials = new Map<string, { normal: LineMaterial; selected: LineMaterial }>();
  const behindMaterials = new Map<THREE.Material, THREE.Material>();
  const pointTextures = new Map<AiPathEventShape, THREE.CanvasTexture>();
  // Course decor also runs without a DOM; create canvas textures only for actual event markers.
  function pointTexture(shape: AiPathEventShape) {
    let texture = pointTextures.get(shape);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(2, 2);
      ctx.fillStyle = '#fff';
      ctx.fill(new Path2D(AI_PATH_EVENT_SHAPE_PATHS[shape]));
      texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.userData.aiPathEventShape = shape;
      pointTextures.set(shape, texture);
    }
    return texture;
  }
  const makePointMaterial = (color: number, shape: AiPathEventShape, size: number) =>
    new THREE.PointsMaterial({
      color,
      size,
      map: pointTexture(shape),
      alphaTest: 0.2,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
    });
  const pointBorders = new Map<AiPathEventShape, THREE.PointsMaterial>();
  function pointBorder(shape: AiPathEventShape) {
    let material = pointBorders.get(shape);
    if (!material) {
      material = makePointMaterial(AI_PATH_OUTLINE, shape, 17);
      pointBorders.set(shape, material);
    }
    return material;
  }
  const pointMaterials = new Map<string, THREE.PointsMaterial>();
  function pointMaterial(color: number, shape: AiPathEventShape) {
    const key = `${color}/${shape}`;
    let material = pointMaterials.get(key);
    if (!material) {
      material = makePointMaterial(color, shape, 13);
      pointMaterials.set(key, material);
    }
    return material;
  }

  function behindMaterial<T extends THREE.Material>(source: T): T {
    let material = behindMaterials.get(source);
    if (!material) {
      material = occludedMaterial(source);
      // A cloned material inherits the bright pass's saved fade baseline; the hidden pass owns a dimmer one.
      if (source.userData.unfaded)
        material.userData.unfaded = {
          opacity: source.userData.unfaded.opacity * CAGE_OCCLUDED_DIM,
          transparent: true,
        };
      behindMaterials.set(source, material);
      if (material instanceof LineMaterial) aiPathMaterials.push(material);
    }
    return material as T;
  }

  /** Share geometry and identity with the bright pass; picking still resolves the original object. */
  function addBehindPass(
    object: LineSegments2 | THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | THREE.Sprite,
  ) {
    const behind = object.clone(false);
    behind.position.set(0, 0, 0);
    behind.quaternion.identity();
    behind.scale.set(1, 1, 1);
    behind.material = behindMaterial(object.material);
    behind.userData = {};
    behind.raycast = () => {};
    object.add(behind);
  }

  function material(path: RefAiPath, active: boolean) {
    const color = aiPathColor(path.rating);
    const key = `${color}/${path.respawnable}`;
    let pair = pathMaterials.get(key);
    if (!pair) {
      pair = {
        normal: lineMaterial(color, 2.5, !path.respawnable),
        selected: lineMaterial(color, 4.5, !path.respawnable),
      };
      for (const m of [pair.normal, pair.selected]) {
        m.resolution.copy(outlines[0].resolution);
        aiPathMaterials.push(m);
      }
      pathMaterials.set(key, pair);
    }
    return active ? pair.selected : pair.normal;
  }

  function addLine(target: THREE.Group, points: V3[], mat: LineMaterial, order: number) {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flat());
    const line = new Line2(geometry, mat);
    line.computeLineDistances();
    line.renderOrder = order;
    addBehindPass(line);
    target.add(line);
    return line;
  }

  function clearAnnotations() {
    for (const child of annotationGroup.children) {
      if (child instanceof THREE.Sprite) {
        behindMaterials.get(child.material)?.dispose();
        behindMaterials.delete(child.material);
        child.material.map?.dispose();
        child.material.dispose();
      } else if (child instanceof Line2 || child instanceof THREE.Points) child.geometry.dispose();
    }
    annotationGroup.clear();
  }

  /** Whole-network events share a few draw calls by colour, rather than a draw and label per event. */
  function buildEventOverview() {
    const batches = new Map<
      string,
      { segments: number[]; endpoints: number[]; color: number; shape: AiPathEventShape; jump: boolean }
    >();
    const borders: number[] = [];
    const dots = new Map<AiPathEventShape, number[]>();
    for (const path of paths) {
      for (const event of path.events) {
        const span = aiPathEventSpan(path.points, event.start, event.end);
        if (!span.length) continue;
        const { color, shape } = aiPathEventStyle(event.type);
        const key = `${color}/${shape}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = { segments: [], endpoints: [], color, shape, jump: event.type === 100 };
          batches.set(key, batch);
        }
        for (let i = 1; i < span.length; i++) batch.segments.push(...span[i - 1], ...span[i]);
        batch.endpoints.push(...span[0]);
        if (span.length > 1) batch.endpoints.push(...span.at(-1)!);
      }
    }
    function segments(positions: number[], mat: LineMaterial, order: number) {
      if (!positions.length) return;
      const line = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), mat);
      line.renderOrder = order;
      line.raycast = () => {}; // The complete base paths retain stable pick identities.
      addBehindPass(line);
      eventGroup.add(line);
    }
    function points(positions: number[], mat: THREE.PointsMaterial, order: number) {
      if (!positions.length) return;
      const geometry = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3),
      );
      const points = new THREE.Points(geometry, mat);
      points.renderOrder = order;
      points.raycast = () => {};
      addBehindPass(points);
      eventGroup.add(points);
    }
    for (const batch of batches.values()) {
      for (const value of batch.segments) borders.push(value);
      let shapeDots = dots.get(batch.shape);
      if (!shapeDots) dots.set(batch.shape, (shapeDots = []));
      for (const value of batch.endpoints) shapeDots.push(value);
      // Jumps remain legible where a broad cruise-speed range overlaps them.
      segments(batch.segments, eventMaterials.get(batch.color)!, batch.jump ? 5 : 4);
      points(batch.endpoints, pointMaterial(batch.color, batch.shape), 6);
    }
    segments(borders, eventBorder, 3);
    for (const [shape, positions] of dots) points(positions, pointBorder(shape), 5);
  }

  function updatePathMaterials() {
    for (const child of group.children) {
      const path = paths.find(path => path.originalIndex === child.userData.refAiPathIndex)!;
      const line = child as Line2;
      line.material = material(path, path.originalIndex === selected);
      child.renderOrder = path.originalIndex === selected ? 2 : 0;
      const behind = line.children[0] as Line2;
      behind.material = behindMaterial(line.material);
      behind.renderOrder = child.renderOrder;
    }
  }

  /** Keep event numbers readable while zooming, like the pixel-sized line and event dots. */
  function eventLabel(index: number, color: number, point: V3) {
    const label = textSprite(String(index + 1), aiPathCssColor(color), 6);
    label.position.set(point[0], point[1] + 0.25, point[2]);
    label.material.depthTest = true;
    label.material.depthWrite = false;
    label.renderOrder = 7;
    label.center.set(0.5, 0);
    const world = new THREE.Vector3(),
      size = new THREE.Vector2();
    label.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getSize(size);
      label.getWorldPosition(world).applyMatrix4(camera.matrixWorldInverse);
      const depth = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? Math.abs(world.z) : 1;
      const width = (72 * 2 * depth) / (camera.projectionMatrix.elements[5] * size.y);
      label.scale.set(width, width / 4, 1);
      label.updateMatrixWorld(true);
    };
    label.userData.aiPathEvent = index;
    addBehindPass(label);
    annotationGroup.add(label);
  }

  function selectAiPath(index: number | null) {
    if (selected === index) return;
    selected = index;
    clearAnnotations();
    updatePathMaterials();
    const path = paths.find(path => path.originalIndex === index);
    if (!path) {
      setFade(fade);
      return;
    }
    addLine(annotationGroup, path.points, outlines[path.respawnable ? 0 : 1], 1);
    path.events.forEach((event, eventIndex) => {
      const span = aiPathEventSpan(path.points, event.start, event.end);
      if (!span.length) return;
      const { color, shape } = aiPathEventStyle(event.type);
      if (span.length > 1) {
        addLine(annotationGroup, span, eventBorder, 3);
        const range = addLine(annotationGroup, span, eventMaterials.get(color)!, event.type === 100 ? 5 : 4);
        range.userData.aiPathEvent = eventIndex;
        range.userData.eventStations = [event.start, event.end];
      }
      const endpoints = span.length > 1 ? [span[0], span.at(-1)!] : [span[0]];
      for (const [mat, order] of [
        [pointBorder(shape), 5],
        [pointMaterial(color, shape), 6],
      ] as const) {
        const dots = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints(endpoints.map(p => new THREE.Vector3(...p))),
          mat,
        );
        dots.renderOrder = order;
        dots.userData.aiPathEvent = eventIndex;
        addBehindPass(dots);
        annotationGroup.add(dots);
      }
      eventLabel(eventIndex, color, span[0]);
    });
    setFade(fade);
  }

  function setAiPaths(next: RefAiPath[] | null) {
    clearAnnotations();
    for (const child of eventGroup.children) (child as LineSegments2 | THREE.Points).geometry.dispose();
    eventGroup.clear();
    for (const child of group.children) (child as Line2).geometry.dispose();
    group.clear();
    for (const pair of pathMaterials.values()) {
      pair.normal.dispose();
      pair.selected.dispose();
    }
    pathMaterials.clear();
    for (const material of behindMaterials.values()) material.dispose();
    behindMaterials.clear();
    aiPathMaterials.splice(fixedMaterials.length);
    selected = null;
    paths = next ?? [];
    for (const path of paths) {
      if (path.points.length < 2) continue;
      const line = addLine(group, path.points, material(path, false), 0);
      line.userData.refAiPathIndex = path.originalIndex;
    }
    buildEventOverview();
    showAiPaths(visible);
    setFade(fade);
  }

  function showAiPaths(on: boolean) {
    visible = on;
    group.visible = on && group.children.length > 0;
    annotationGroup.visible = group.visible;
    eventGroup.visible = group.visible;
  }
  /** Course drawing fades the whole authored overlay; rebuilds and selections keep that same factor. */
  function setFade(factor: number) {
    fade = factor;
    for (const material of new Set([
      ...aiPathMaterials,
      ...pointBorders.values(),
      ...pointMaterials.values(),
      ...behindMaterials.values(),
    ]))
      fadeMaterial(material, factor);
    fadeObject(annotationGroup, factor);
  }
  showAiPaths(false);
  return {
    setAiPaths,
    showAiPaths,
    selectAiPath,
    setFade,
    aiPathMaterials,
    aiPathGroup: group,
    aiPathAnnotations: annotationGroup,
    aiPathEvents: eventGroup,
  };
}
