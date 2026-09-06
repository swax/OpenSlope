import * as THREE from 'three';
import type { CoursePath, V3 } from '../../../core/doc/types';
import { courseCenters, startFrame, finishFrame, startGateLines, startGateBoxes } from '../../../core/doc/course';
import type { Stage } from '../stage';

/**
 * Where the race starts and ends (docs/003): the start-gate prop + the six path starts at the course
 * head, a checkered line at the tail — the point the exported race line's DistanceToFinish reaches zero —
 * and the exported path points themselves, small beads along the curve (the spine resampled at ~15 m; the
 * actual AIP / race-line vertices the disc ships, between the editable knots). Everything is derived from
 * core/doc/course, the SAME functions the export writes AIP.json / SOP.json / the gate prop from, so the
 * markers are the positions the disc ships. Part of the course guide (the run's spine + knots): the shell
 * shows them together in Info mode. Non-interactive, so the whole group lives at scene root with Z negated
 * by hand, like the spine line it annotates.
 */
/** Metres the grabbable start/finish flags float above the point they set (see `anchorHandle`). The viewport
 *  subtracts it when a drag reports back, so the stored anchor is the ground point, not the flag. */
export const ANCHOR_HANDLE_LIFT = 5;

export function createCourseMarkersLayer(stage: Stage) {
  const group = new THREE.Group();
  // the per-course meshes live in their own subgroup so a rebuild disposes them without touching the
  // persistent labels (a knot gizmo drag rebuilds every frame; re-baking the canvas labels would churn)
  const rebuilt = new THREE.Group();
  group.add(rebuilt);
  let visible = true;
  let built = false;

  const flip = (p: V3): V3 => [p[0], p[1], -p[2]];

  const gateMat = new THREE.MeshLambertMaterial({ color: 0x999999, emissive: 0x222222 }); // the shipped prop's untextured grey
  const spawnMat = new THREE.MeshBasicMaterial({ color: 0x41d06a });
  const startLineMat = new THREE.MeshBasicMaterial({
    color: 0x41d06a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false,
  });
  const spawnGeo = new THREE.SphereGeometry(0.35, 12, 10);
  const beadGeo = new THREE.SphereGeometry(1.6, 8, 6); // exported path points: well under the knot handles
  const beadMat = new THREE.MeshBasicMaterial({ color: 0x36a746 }); // the line's green, a step dimmer: derived data, not grabbable
  const checkpointMat = new THREE.MeshBasicMaterial({
    color: 0xffa83d, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false,
  });

  // 2x2 black/white checker, repeated per metre across the finish strip
  const checker = new THREE.DataTexture(
    new Uint8Array([30, 30, 30, 255, 235, 235, 235, 255, 235, 235, 235, 255, 30, 30, 30, 255]), 2, 2,
  );
  checker.magFilter = THREE.NearestFilter;
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.needsUpdate = true;
  const finishMat = new THREE.MeshBasicMaterial({ map: checker, side: THREE.DoubleSide });

  /** A billboard text label (canvas-baked), `w` metres wide. */
  function label(text: string, color: string, w: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `bold ${text.length > 10 ? 34 : 44}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 256, 32);
    ctx.fillStyle = color;
    ctx.fillText(text, 256, 32);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    sprite.scale.set(w, w / 8, 1);
    return sprite;
  }
  const startLabel = label('START', '#69df8c', 18);
  const finishLabel = label('FINISH', '#ffffff', 18);
  group.add(startLabel, finishLabel);

  /**
   * The two grabbable anchors, floated on a stem above the point they set. Lifted because by default the
   * start anchor sits exactly ON knot 0 — at ground level the two handles would occupy the same pixel and
   * knot 0 could never be grabbed again. The stem keeps it legible as "this flag marks that spot".
   */
  const handleMat = new THREE.MeshBasicMaterial({ color: 0xffd447 });
  const stemMat = new THREE.LineBasicMaterial({ color: 0xffd447, transparent: true, opacity: 0.5 });
  const handleGeo = new THREE.OctahedronGeometry(1.6);
  function anchorHandle(which: 'start' | 'finish') {
    const mesh = new THREE.Mesh(handleGeo, handleMat);
    mesh.userData.anchor = which;
    const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -ANCHOR_HANDLE_LIFT, 0)]), stemMat);
    stem.raycast = () => { /* the flag is the grab target, not its pole */ };
    mesh.add(stem);
    group.add(mesh);
    return mesh;
  }
  const startHandle = anchorHandle('start');
  const finishHandle = anchorHandle('finish');

  /** A flat strip across the course, `depth` m along the run, local X laid along `side`. */
  function strip(pos: V3, side: V3, width: number, depth: number, mat: THREE.Material): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(width, depth);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    const p = flip(pos);
    m.position.set(p[0], p[1] + 0.05, p[2]);
    m.rotation.y = Math.atan2(side[2], side[0]); // flipped-space yaw: local +X onto [side.x, -side.z]
    return m;
  }

  /** Rebuild both markers from the course (null / short course clears them). */
  function setCourse(course: CoursePath | null) {
    for (const c of [...rebuilt.children]) {
      c.traverse(n => {
        if (n instanceof THREE.InstancedMesh) n.dispose(); // the instance-matrix buffer is the mesh's own (beadGeo is shared)
        if (n instanceof THREE.Mesh && n.geometry !== spawnGeo && n.geometry !== beadGeo) n.geometry.dispose();
        if (n instanceof THREE.Sprite) { n.material.map?.dispose(); n.material.dispose(); }
      });
      rebuilt.remove(c);
    }
    built = !!course && course.knots.length >= 2;
    group.visible = visible && built;
    if (!course || !built) return;

    const start = startFrame(course);
    // the gate prop's three boxes, exactly as buildStartGate bakes them (axis-aligned, so the Z flip is
    // just the base point's)
    for (const { base, size } of startGateBoxes(start.left, start.right)) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), gateMat);
      const p = flip(base);
      b.position.set(p[0], p[1] + size[1] / 2, p[2]);
      rebuilt.add(b);
    }
    rebuilt.add(strip(start.pos, start.side, start.width, 1.2, startLineMat));
    for (const line of startGateLines(course)) {
      const dot = new THREE.Mesh(spawnGeo, spawnMat);
      const p = flip(line[0]);
      dot.position.set(p[0], p[1], p[2]);
      rebuilt.add(dot);
    }
    startLabel.position.set(...flip(start.pos));
    startLabel.position.y += 8;
    startHandle.position.set(...flip(start.pos));
    startHandle.position.y += ANCHOR_HANDLE_LIFT;

    // the exported path points, one bead per ~15 m sample — what AIP.json / the race line actually carry
    const centers = courseCenters(course);
    const beads = new THREE.InstancedMesh(beadGeo, beadMat, centers.length);
    const m4 = new THREE.Matrix4();
    centers.forEach((c, i) => {
      const p = flip(c);
      beads.setMatrixAt(i, m4.makeTranslation(p[0], p[1], p[2]));
    });
    beads.instanceMatrix.needsUpdate = true;
    rebuilt.add(beads);

    // A type-11 checkpoint is a station on the race line, independent of any visual prop next to it. Draw a
    // bright transverse strip at each checkpoint knot and state the exact SOP payload above it, so an author can
    // read trigger order/value without hunting for (or accidentally selecting) a flashing sign model.
    course.knots.forEach((knot, i) => {
      const bonus = knot.checkpointBonus ?? 0;
      if (bonus <= 0) return;
      const a = course.knots[Math.max(0, i - 1)].pos;
      const b = course.knots[Math.min(course.knots.length - 1, i + 1)].pos;
      const dx = b[0] - a[0], dz = b[2] - a[2], h = Math.hypot(dx, dz) || 1;
      const side: V3 = [-dz / h, 0, dx / h];
      rebuilt.add(strip(knot.pos, side, knot.width, 2.2, checkpointMat));
      const minutes = Math.floor(bonus / 60), seconds = bonus % 60;
      const tag = label(`CHECKPOINT +${minutes}:${String(seconds).padStart(2, '0')}`, '#ffbd66', 32);
      const p = flip(knot.pos);
      tag.position.set(p[0], p[1] + 8, p[2]);
      rebuilt.add(tag);
    });

    const finish = finishFrame(course);
    checker.repeat.set(Math.max(4, Math.round(finish.width)), 3);
    rebuilt.add(strip(finish.pos, finish.side, finish.width, 3, finishMat));
    finishLabel.position.set(...flip(finish.pos));
    finishLabel.position.y += 8;
    finishHandle.position.set(...flip(finish.pos));
    finishHandle.position.y += ANCHOR_HANDLE_LIFT;
  }

  /** The two grabbable anchor flags, for the shell's picking + gizmo. Empty while the layer is hidden — a
   *  hidden guide has nothing to grab, exactly like the knot handles. */
  function handles(): THREE.Mesh[] {
    return visible && built ? [startHandle, finishHandle] : [];
  }

  /** Shown with the run's guide line (Info mode), like the spine + knots. */
  function setVisible(on: boolean) {
    visible = on;
    group.visible = on && built;
  }

  stage.scene.add(group);
  return { setCourse, setVisible, handles };
}

export type CourseMarkersLayer = ReturnType<typeof createCourseMarkersLayer>;
