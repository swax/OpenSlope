// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCanvas } from '@napi-rs/canvas';
import { Stage } from '../src/app/viewport/stage';
import { dataToScene } from '../src/app/viewport/coordinates';
import type { V3 } from '../src/core/doc/types';
import type { PlacementEndpoint } from '../src/app/viewport/input/placement-constraint';
import { createSurfaceToolLayer } from '../src/app/viewport/tools/create-surface';
import { createPatchToolLayer } from '../src/app/viewport/tools/create-patch';
import { createGridToolLayer } from '../src/app/viewport/tools/create-grid';
import { createTubeToolLayer } from '../src/app/viewport/tools/create-tube';
import { createLoftPreviewLayer } from '../src/app/viewport/tools/loft-preview';

function fixture(ortho: boolean) {
  const camera = ortho
    ? new THREE.OrthographicCamera(-120, 120, 90, -90, 0.1, 5000)
    : new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 5000);
  // A shallow view: a horizontal plane through the anchor meets a nearby ray hundreds of metres away.
  camera.position.set(0, 60, 200);
  camera.lookAt(0, 50, 0);
  camera.updateMatrixWorld(true);
  let vertex: PlacementEndpoint | null = null,
    surface: THREE.Vector3 | null = null,
    surfacePicks = 0;
  const stage = Object.assign(Object.create(Stage.prototype) as Stage, {
    camera,
    controls: { target: new THREE.Vector3(0, 50, 0) },
    ray: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    worldRoot: new THREE.Group(),
    scene: new THREE.Scene(),
    renderer: { domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } },
    cb: {},
    gizmo: { dragging: false, mode: 'translate' },
    castAt() {
      this.ray.setFromCamera(this.pointer, this.camera);
    },
    pickSurface() {
      surfacePicks++;
      return surface ? { point: surface } : null;
    },
    snapDataPoint: (p: V3) => p,
    attachGizmo() {},
    detachGizmo() {},
  });
  stage.worldRoot.scale.z = -1;
  stage.worldRoot.updateMatrixWorld(true);
  return {
    stage,
    pickVertex: () => vertex,
    vertex(next: PlacementEndpoint | null) {
      vertex = next;
    },
    surface(next: THREE.Vector3 | null) {
      surface = next;
    },
    get surfacePicks() {
      return surfacePicks;
    },
    aim(x: number, y: number) {
      stage.pointer.set(x, y);
      stage.ray.setFromCamera(stage.pointer, camera);
    },
    depth(p: V3) {
      return dataToScene(p).applyMatrix4(camera.matrixWorldInverse).z;
    },
    projection(p: V3) {
      return dataToScene(p).project(camera);
    },
  };
}

const tools = [
  {
    name: 'surface',
    create(f: ReturnType<typeof fixture>) {
      const tool = createSurfaceToolLayer(
        f.stage,
        () => new THREE.Mesh(),
        f.pickVertex,
        () => null,
      );
      return { tool, points: () => tool.points.map(p => p.pos), hover: () => tool.hover?.pos };
    },
  },
  {
    name: 'patch',
    create(f: ReturnType<typeof fixture>) {
      const tool = createPatchToolLayer(
        f.stage,
        () => new THREE.Mesh(),
        createLoftPreviewLayer(f.stage, () => null),
        f.pickVertex,
      );
      return { tool, points: () => tool.points.map(p => p.pos), hover: () => tool.hover?.pos };
    },
  },
  {
    name: 'grid',
    create(f: ReturnType<typeof fixture>) {
      const tool = createGridToolLayer(f.stage, () => new THREE.Mesh(), f.pickVertex);
      return { tool, points: () => tool.points.map(p => p.pos), hover: () => tool.hover?.pos };
    },
  },
  {
    name: 'tube',
    create(f: ReturnType<typeof fixture>) {
      const tool = createTubeToolLayer(f.stage, () => new THREE.Mesh(), f.pickVertex);
      return { tool, points: () => tool.points, hover: () => tool.hover ?? undefined };
    },
  },
];
const near = (a: number, b: number) => assert(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const move = { shiftKey: false, ctrlKey: false, metaKey: false } as PointerEvent;
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => createCanvas(256, 64) } as unknown as Document;
try {
  for (const { name, create } of tools)
    for (const ortho of [false, true]) {
      const f = fixture(ortho),
        drawing = create(f);
      drawing.tool.setActive(true);
      f.aim(-0.25, 0);
      drawing.tool.onCommit();
      const first = drawing.points()[0];
      near(f.depth(first), f.depth([0, 50, 0]));
      assert.equal(f.surfacePicks, 1, `${name}: first free point tries the terrain, then uses the view depth`);
      // A distant hill must not pull subsequent points away from the freely drawn chain.
      f.surface(new THREE.Vector3(0, -500, -2000));
      f.aim(0.1, 0.08);
      drawing.tool.onHover(move);
      const hover = drawing.hover()!;
      near(f.depth(hover), f.depth(first));
      near(f.projection(hover).x, 0.1);
      near(f.projection(hover).y, 0.08);
      assert(dataToScene(first).distanceTo(dataToScene(hover)) < 100, `${name}: nearby clicks stay nearby`);
      drawing.tool.onCommit();
      assert.deepEqual(drawing.points()[1], hover, `${name}: click commits the previewed depth`);
      assert.equal(f.surfacePicks, 1, `${name}: terrain behind the cursor does not take the next point`);

      // Snapping establishes a different depth; the next free point must inherit that latest anchor.
      drawing.tool.setActive(false);
      drawing.tool.setActive(true);
      const snapped: PlacementEndpoint = { pos: [20, 70, -80], vertex: 7 };
      f.vertex(snapped);
      const at = f.projection(snapped.pos);
      f.aim(at.x, at.y);
      drawing.tool.onCommit();
      f.vertex(null);
      f.aim(at.x + 0.25, at.y + 0.08);
      drawing.tool.onHover(move);
      near(f.depth(drawing.hover()!), f.depth(snapped.pos));
      drawing.tool.onCommit();
      near(f.depth(drawing.points()[1]), f.depth(snapped.pos));

      if (name !== 'tube') {
        drawing.tool.setActive(false);
        drawing.tool.setActive(true);
        f.vertex(null);
        f.surface(null);
        f.aim(-0.25, 0);
        // The first point is free; the second snap changes the chain's depth.
        drawing.tool.onCommit(false, false);
        const originalDepth = f.depth(drawing.points()[0]);
        f.vertex(snapped);
        f.aim(at.x, at.y);
        drawing.tool.onCommit();
        f.vertex(null);
        f.aim(at.x + 0.25, at.y + 0.08);
        drawing.tool.onHover(move);
        near(f.depth(drawing.hover()!), f.depth(snapped.pos));
        assert(Math.abs(f.depth(drawing.hover()!) - originalDepth) > 10, `${name}: latest point sets the depth`);
        drawing.tool.onCommit();
        near(f.depth(drawing.points()[2]), f.depth(snapped.pos));
      }

      // Ctrl explicitly requests a terrain contact instead of the chain's depth.
      drawing.tool.setActive(false);
      drawing.tool.setActive(true);
      f.vertex(snapped);
      f.aim(at.x, at.y);
      drawing.tool.onCommit();
      f.vertex(null);
      f.surface(new THREE.Vector3(0, -500, -2000));
      f.aim(0.1, 0.08);
      drawing.tool.onHover({ ...move, ctrlKey: true } as PointerEvent);
      assert.deepEqual(drawing.hover(), [0, -500, 2000]);
      drawing.tool.onCommit(false, true);
      assert.deepEqual(drawing.points()[1], [0, -500, 2000]);
    }
} finally {
  globalThis.document = previousDocument;
}
console.log(
  'DRAWING DEPTH: surface, patch, grid and tube keep previous-point depth in perspective/orthographic views; hover, snaps and Ctrl terrain placement agree.',
);
