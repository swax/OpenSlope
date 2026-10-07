import * as THREE from 'three';
import type { PropCage } from '../../../core/props/deform';
import type { PropSub } from '../../../core/reference/props';
import type { V3 } from '../../../core/doc/types';
import type { Stage } from '../stage';

/** A transient cage and private preview. No shared model buffers or stored placements are changed. */
export function createPropDeformLayer(stage: Stage, materialVariant: (material: THREE.Material) => THREE.Material) {
  const overlay = new THREE.Group(), anchor = new THREE.Object3D();
  stage.scene.add(overlay, anchor);
  const sphere = new THREE.SphereGeometry(1, 10, 8);
  const normal = new THREE.MeshBasicMaterial({ color: 0x41dbcc, depthTest: false, depthWrite: false });
  const selected = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
  const wire = new THREE.LineBasicMaterial({ color: 0x41dbcc, depthTest: false, depthWrite: false, transparent: true, opacity: 0.7 });
  let preview: THREE.Object3D | null = null, meshes: THREE.Mesh[] = [], bulbs: THREE.Mesh[] = [];
  let cage: PropCage | null = null;
  let matrix = new THREE.Matrix4(), inverse = new THREE.Matrix4();
  let mode: 'section' | 'corner' = 'section', picked = 3;
  let onChange: (cage: PropCage, finished: boolean) => void = () => {};
  let onSelect = () => {};
  let base: { points: V3[]; inverseAnchor: THREE.Matrix4 } | null = null;

  const ids = () => mode === 'section' ? [0, 1, 2, 3].map(i => picked * 4 + i) : [picked];
  const toScene = (p: V3) => new THREE.Vector3(...p).applyMatrix4(matrix);
  const center = (indices: number[]) => indices.reduce((p, i) => p.add(toScene(cage!.points[i])), new THREE.Vector3()).divideScalar(indices.length);

  function clearOverlay() {
    for (const item of [...overlay.children]) {
      overlay.remove(item);
      if (item instanceof THREE.LineSegments) item.geometry.dispose();
    }
    bulbs = [];
  }

  function draw(seat = true) {
    clearOverlay();
    if (!cage) return;
    const lines: number[] = [], chosen = new Set(ids());
    const edge = (a: number, b: number) => lines.push(...toScene(cage!.points[a]).toArray(), ...toScene(cage!.points[b]).toArray());
    for (let ring = 0; ring < 4; ring++) {
      for (const [a, b] of [[0, 1], [0, 2], [1, 3], [2, 3]]) edge(ring * 4 + a, ring * 4 + b);
      if (ring < 3) for (let corner = 0; corner < 4; corner++) edge(ring * 4 + corner, (ring + 1) * 4 + corner);
    }
    const line = new THREE.LineSegments(new THREE.BufferGeometry(), wire);
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    line.renderOrder = 10_001; line.raycast = () => {};
    overlay.add(line);
    const points = mode === 'section' ? [0, 1, 2, 3].map(i => center([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 3])) : cage.points.map(toScene);
    points.forEach((point, index) => {
      const bulb = new THREE.Mesh(sphere, index === picked ? selected : normal);
      bulb.position.copy(point);
      // Screen-sized handles remain usable on both a little rail and a mountain-sized bridge.
      const distance = stage.camera.position.distanceTo(point);
      const size = stage.camera instanceof THREE.PerspectiveCamera
        ? distance * Math.tan(THREE.MathUtils.degToRad(stage.camera.fov / 2)) * 12 / stage.renderer.domElement.clientHeight
        : (stage.camera.top - stage.camera.bottom) / stage.camera.zoom * 6 / stage.renderer.domElement.clientHeight;
      bulb.scale.setScalar(Math.max(0.01, size));
      bulb.userData.control = index; bulb.renderOrder = 10_002; bulb.raycast = () => {};
      overlay.add(bulb); bulbs.push(bulb);
    });
    // Mark the four corners of a selected section too, so the scope of a ring drag is clear.
    if (mode === 'section') for (const index of chosen) {
      const bulb = new THREE.Mesh(sphere, selected);
      bulb.position.copy(toScene(cage.points[index])); bulb.scale.copy(bulbs[0].scale).multiplyScalar(0.45);
      bulb.renderOrder = 10_002; bulb.raycast = () => {}; overlay.add(bulb);
    }
    if (seat && !stage.gizmo.dragging) {
      anchor.userData.deformSection = mode === 'section';
      anchor.position.copy(center(ids())); anchor.quaternion.identity(); anchor.scale.set(1, 1, 1);
      stage.attachGizmo(anchor, 'propdeform', picked);
    }
    overlay.updateMatrixWorld(true);
  }

  function close() {
    if (stage.gizmoKind === 'propdeform') stage.detachGizmo();
    if (preview) preview.removeFromParent();
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
    }
    preview = null; meshes = []; cage = null; base = null; clearOverlay();
  }

  function open(value: PropCage, template: THREE.Object3D,
    changed: typeof onChange, selection: typeof onSelect) {
    close();
    template.updateWorldMatrix(true, true);
    preview = new THREE.Group();
    // Flatten the static draw meshes. Cloning the tree would also clone wireframe passes and their
    // cyclic userData; privately owned materials keep a world rebuild from disposing our preview.
    const isOutline = (item: THREE.Object3D) => item instanceof THREE.Line
      || !!(item as THREE.Object3D & { isLineSegments2?: boolean }).isLineSegments2
      || !!item.userData.propWireframePass;
    const originals: THREE.Mesh[] = [];
    template.traverse(item => { if (item instanceof THREE.Mesh && !isOutline(item)) originals.push(item); });
    if (!originals.length) { close(); throw new Error('The prop mesh is still loading.'); }
    for (const original of originals) {
      const source = (original.userData.texturedMaterial ?? original.material) as THREE.Material | THREE.Material[];
      const material = Array.isArray(source) ? source.map(materialVariant) : materialVariant(source);
      const mesh = new THREE.Mesh(original.geometry.clone(), material);
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(original.matrixWorld);
      mesh.renderOrder = original.renderOrder; mesh.raycast = () => {};
      preview.add(mesh); meshes.push(mesh);
    }
    matrix = originals[0].matrixWorld.clone(); inverse = matrix.clone().invert();
    stage.scene.add(preview);
    cage = structuredClone(value); mode = 'section'; picked = 3;
    onChange = changed; onSelect = selection;
    draw();
  }

  function geometry(subs: readonly PropSub[]) {
    if (subs.length !== meshes.length) throw new Error('This prop has unsupported mesh parts.');
    subs.forEach((sub, i) => {
      const mesh = meshes[i];
      if (mesh.geometry.userData.deformIndices === sub.indices) {
        (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).copyArray(sub.positions);
        mesh.geometry.getAttribute('position').needsUpdate = true;
        mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
        return;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(sub.positions, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(sub.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(sub.indices, 1));
      g.userData.deformIndices = sub.indices;
      g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
      mesh.geometry.dispose(); mesh.geometry = g;
    });
  }

  function pickHandle(): boolean {
    if (!cage) return false;
    draw(false); // refresh screen-sized handles after a camera move
    const hits: THREE.Intersection[] = [];
    for (const bulb of bulbs) THREE.Mesh.prototype.raycast.call(bulb, stage.ray, hits);
    hits.sort((a, b) => a.distance - b.distance);
    if (hits[0]) { picked = hits[0].object.userData.control as number; draw(); onSelect(); }
    return true; // the session owns empty clicks too; the prop cannot be replaced mid-deformation
  }

  function dragging(on: boolean) {
    if (!cage) return;
    if (on) { anchor.updateMatrixWorld(true); base = { points: structuredClone(cage.points), inverseAnchor: anchor.matrixWorld.clone().invert() }; }
    else { base = null; onChange(structuredClone(cage), true); draw(); }
  }

  function changed() {
    if (!cage || !base) return;
    anchor.updateMatrixWorld(true);
    const delta = anchor.matrixWorld.clone().multiply(base.inverseAnchor);
    for (const i of ids()) cage.points[i] = toScene(base.points[i]).applyMatrix4(delta).applyMatrix4(inverse).toArray() as V3;
    draw(false); onChange(structuredClone(cage), false);
  }

  return { open, close, geometry, pickHandle, dragging, changed,
    get active() { return cage !== null; },
    get selection() { return { mode, index: picked }; },
    setMode(value: 'section' | 'corner') {
      if (value === mode) return;
      mode = value; picked = value === 'section' ? Math.floor(picked / 4) : picked * 4; draw(); onSelect();
    },
    select(index: number) { picked = Math.max(0, Math.min(mode === 'section' ? 3 : 15, index)); draw(); },
    setCage(value: PropCage) { cage = structuredClone(value); draw(); },
    sync() { if (cage && !stage.gizmo.dragging) draw(); },
  };
}
export type PropDeformLayer = ReturnType<typeof createPropDeformLayer>;
