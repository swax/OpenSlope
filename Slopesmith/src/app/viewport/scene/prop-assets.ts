import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { V3 } from '../../../core/doc/types';
import type { LevelProps, PhysicsBodyMassProps, PropInstance, PropModelClip } from '../../../core/reference/props';
import type { GroupDef, GroupPropDef } from '../../../core/reference/groups';
import { resolvePropTex } from '../../../core/paint/textures';
import { isSingleFacingSheet, PropTextureCache } from '../../props/textures';
import { RAW_TO_EDITOR, WORLD_UP } from '../constants';
import type { PropSubGeom } from '../types';

/**
 * Shared prop-model asset caches, keyed "<level>:<model>": the decoded submesh geometry, the mined group
 * defs (docs/015), per-model local boxes, and the amber selection-outline edge lines + their one fat-line
 * material. The props, gems and reference layers all read these (a placed prop, a native gem crystal, and a
 * reference-world prop can share a model), so they live in one injected holder rather than any one layer.
 */
export function createPropAssets() {
  const propTex = new PropTextureCache();                             // textures + materials for props (from Textures/)
  const propGeom = new Map<string, PropSubGeom[]>();                  // "<level>:<model>" -> per-material submeshes
  const propClips = new Map<string, PropModelClip>();                 // embedded model clip, when the source model has one
  const groupDefs = new Map<string, GroupDef>();                      // "<level>:<id>" -> mined group def (docs/015)
  const propLocalBoxes = new Map<string, { min: V3; max: V3 }>();     // "<level>:<model>" -> local bbox (raw cm)
  const propPrincipalExtents = new Map<string, { muzzle: V3; axis: V3; length: number }>();
  // Collision resources are cached beside render geometry so any authored/source-derived profile can preview
  // the exact sphere tree it borrowed from a reference instance. Keys include the source level because native
  // physics indices are level-local.
  const nativeInstances = new Map<string, PropInstance>();
  const physicsBodies = new Map<string, Float32Array>();
  const physicsMassProps = new Map<string, PhysicsBodyMassProps>();
  const propEdgeGeos = new Map<string, LineSegmentsGeometry[]>();     // "<level>:<model>" -> per-submesh edge lines
  const propWireGeos = new Map<string, LineSegmentsGeometry[]>();     // same, but every rendered triangle edge
  // prop selection is an amber EDGE OUTLINE over the prop's own textures (placed and reference alike) — one
  // shared fat-line material (resolution refreshed on resize) + per-model cached edge geometry (threshold 30°).
  const propOutlineMat = new LineMaterial({ color: 0xffc24d, linewidth: 2.5, transparent: true, opacity: 0.95,
    depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const effectOutlineMat = new LineMaterial({ color: 0xb66cff, linewidth: 1.25, transparent: true, opacity: 0.72,
    depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });

  /** Cache a level's prop-model submesh geometries (keyed "<level>:<model>") so placements can render them
   *  textured. Idempotent — a model already cached is left alone. The host calls this after fetching /api/props. */
  function registerPropModels(props: LevelProps) {
    for (const instance of props.instances) nativeInstances.set(`${props.level}:${instance.sourceIndex}`, instance);
    for (const [id, body] of props.physicsBodies ?? []) physicsBodies.set(`${props.level}:${id}`, body);
    for (const [id, mass] of props.physicsMassProps ?? []) physicsMassProps.set(`${props.level}:${id}`, mass);
    for (const m of props.models) {
      const key = `${props.level}:${m.id}`;
      if (propGeom.has(key)) continue;
      const subs: PropSubGeom[] = m.subs.map(s => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(s.uvs, 2));
        g.setIndex(new THREE.BufferAttribute(s.indices, 1));
        if (s.normals?.length === s.positions.length)
          g.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
        else g.computeVertexNormals();
        const material = props.materials.get(s.mat);
        // a material's tile may name its own bank ("Custom/lamp.png" — imported props, docs/032); a plain
        // file name lives in this level's own Textures/, which is every extracted level's case
        const tile = resolvePropTex(props.level, material?.tex);
        return {
          geometry: g,
          ...(s.object !== undefined ? { object: s.object } : {}),
          level: tile.level,
          tex: tile.name,
          frames: material?.frames ?? [],
          crowdFrames: props.crowdFrames,
          blend: material?.blend ?? false,
          pixelAlpha: material?.pixelAlpha ?? false,
          alphaMode: material?.alphaMode,
          prio: material?.prio ?? false,
          sheet: isSingleFacingSheet(g.getAttribute('normal')?.array),
          mat: s.mat,
        };
      });
      propGeom.set(key, subs);
      const clip = m.animation ?? m.rotation;
      if (clip) propClips.set(key, clip);
    }
  }

  /** Whether a placement's model geometry is cached (so the host knows to fetch its level first). */
  function hasPropGeom(level: string, model: number): boolean { return propGeom.has(`${level}:${model}`); }

  /** Drop one model key and everything derived from its geometry. */
  function purgePropKey(key: string) {
    for (const sub of propGeom.get(key) ?? []) sub.geometry.dispose();
    for (const edge of propEdgeGeos.get(key) ?? []) edge.dispose();
    propGeom.delete(key); propEdgeGeos.delete(key);
    propClips.delete(key);
    propLocalBoxes.delete(key); propPrincipalExtents.delete(key);
  }

  const liveSig = new Map<string, string>(); // '<level>:<n>' -> content signature of the registered bake
  /** Register a LIVE pseudo-level — authored models ('@models', re-baked on every edit) and imported GLB
   *  props ('@import', replaced when the same file is loaded again). Unlike registerPropModels these
   *  definitions change under a stable model number, so registration REPLACES: changed models dispose their
   *  previous geometry (and the caches derived from it), unchanged ones are skipped via a content
   *  signature, and keys for models that have gone away are purged. */
  function syncLiveModels(props: LevelProps) {
    const seen = new Set(props.models.map(m => `${props.level}:${m.id}`));
    for (const key of [...propGeom.keys()]) {
      if (key.startsWith(`${props.level}:`) && !seen.has(key)) { purgePropKey(key); liveSig.delete(key); }
    }
    for (const m of props.models) {
      const key = `${props.level}:${m.id}`;
      let hash = m.subs.length * 31 + m.name.length;
      for (const s of m.subs) {
        hash = (hash * 31 + s.positions.length * 7 + s.indices.length) >>> 0;
        hash = (hash * 31 + (s.object ?? -1)) >>> 0;
        for (let i = 0; i < s.positions.length; i++) hash = (hash * 31 + (s.positions[i] * 8 | 0)) >>> 0;
      }
      // The CLIP is part of the signature too. A re-import that only retimes a spin leaves every vertex
      // where it was, so a geometry-only signature would call the model unchanged and keep serving the
      // clip it was registered with — the one shape of edit this whole path exists to pick up.
      hash = (hash * 31 + (m.animation?.clipFrames ?? m.rotation?.clipFrames ?? 0)) >>> 0;
      hash = (hash * 31 + (m.animation?.objects.length ?? 0)) >>> 0;
      // …and so is every MATERIAL field the submeshes below copy. Retexturing a model or editing its
      // flipbook moves no vertex either, and a submesh registered against the old tile keeps drawing it.
      for (const s of m.subs) {
        const material = props.materials.get(s.mat);
        for (const part of [material?.tex ?? '', ...(material?.frames ?? [])])
          for (let i = 0; i < part.length; i++) hash = (hash * 31 + part.charCodeAt(i)) >>> 0;
        hash = (hash * 31 + (material?.blend ? 1 : 0)) >>> 0;
        hash = (hash * 31 + (material?.pixelAlpha ? 1 : 0)) >>> 0;
        for (const char of material?.alphaMode ?? '') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        hash = (hash * 31 + (material?.prio ? 1 : 0)) >>> 0;
        const scroll = material?.scroll ? JSON.stringify(material.scroll) : '';
        for (let i = 0; i < scroll.length; i++) hash = (hash * 31 + scroll.charCodeAt(i)) >>> 0;
      }
      const sig = `${hash}`;
      if (liveSig.get(key) === sig && propGeom.has(key)) continue;
      purgePropKey(key);
      liveSig.set(key, sig);
      propGeom.set(key, m.subs.map(s => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(s.uvs, 2));
        g.setIndex(new THREE.BufferAttribute(s.indices, 1));
        if (s.normals?.length === s.positions.length)
          g.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
        else g.computeVertexNormals();
        // a live model's tile ref is "LEVEL/file.png" — the texture fetches from THAT level's bank, and
        // its material's frames are bare names in that same bank
        const material = props.materials.get(s.mat);
        const tile = resolvePropTex(props.level, material?.tex);
        return {
          geometry: g,
          // which object of the model's clip moves this run — an imported GLB that declared a spin
          ...(s.object !== undefined ? { object: s.object } : {}),
          level: tile.level,
          tex: tile.name,
          frames: material?.frames ?? [],
          crowdFrames: props.crowdFrames,
          blend: material?.blend ?? false,
          pixelAlpha: material?.pixelAlpha ?? false,
          alphaMode: material?.alphaMode,
          prio: material?.prio ?? false,
          sheet: isSingleFacingSheet(g.getAttribute('normal')?.array),
          mat: s.mat,
        };
      }));
      // Registered here for the same reason registerPropModels does it: the clip is looked up by model key
      // when a placement is built, and a model with geometry but no clip renders perfectly and never moves.
      const clip = m.animation ?? m.rotation;
      if (clip) propClips.set(key, clip);
    }
  }

  /** Register a level's mined group defs so placements referencing them can resolve their members. */
  function registerGroupDefs(level: string, defs: GroupDef[]) {
    for (const d of defs) groupDefs.set(`${level}:${d.id}`, d);
  }

  /** A placement's member list: the group def's props (leader first), or the placement's own model as a
   *  one-member list. A group whose def isn't registered yet renders just its leader until the fetch lands. */
  function membersOf(level: string, model: number, name: string, group?: string): GroupPropDef[] {
    const def = group ? groupDefs.get(`${level}:${group}`) : undefined;
    return def?.props ?? [{ model, name, relPos: [0, 0, 0], relYaw: 0 }];
  }

  /** A member's matrix under the placement pose: its group-local offset / turn, then RAW_TO_EDITOR to seat
   *  the model's cm/Z-up geometry upright in editor m/Y-up. */
  function memberLocalMatrix(m: GroupPropDef): THREE.Matrix4 {
    const q = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, (m.relYaw * Math.PI) / 180);
    return new THREE.Matrix4()
      .compose(new THREE.Vector3(m.relPos[0], m.relPos[1], m.relPos[2]), q, new THREE.Vector3(1, 1, 1))
      .multiply(RAW_TO_EDITOR);
  }

  /** A model's local bounding box (raw cm), unioned over its cached submeshes; null until registered. */
  function propLocalBox(level: string, model: number): { min: V3; max: V3 } | null {
    const key = `${level}:${model}`;
    const cached = propLocalBoxes.get(key);
    if (cached) return cached;
    const subs = propGeom.get(key);
    if (!subs?.length) return null; // not cached — the geometry may register later
    const box = new THREE.Box3();
    for (const s of subs) {
      if (!s.geometry.boundingBox) s.geometry.computeBoundingBox();
      box.union(s.geometry.boundingBox!);
    }
    const out = { min: [box.min.x, box.min.y, box.min.z] as V3, max: [box.max.x, box.max.y, box.max.z] as V3 };
    propLocalBoxes.set(key, out);
    return out;
  }

  /** Geometry-derived long axis and +Z-facing end of a prop model. This is the same covariance/power-iteration
   *  construction used by the Unity bundle path for launcher barrels, but cached on Slopesmith's shared model
   *  geometry so effects, selection, and future prop tools can consume one convention-free result. */
  function propPrincipalExtent(level: string, model: number): { muzzle: V3; axis: V3; length: number } | null {
    const key = `${level}:${model}`;
    const cached = propPrincipalExtents.get(key);
    if (cached) return cached;
    const subs = propGeom.get(key);
    if (!subs?.length) return null;
    let count = 0;
    const center = new THREE.Vector3();
    for (const sub of subs) {
      const positions = sub.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        center.x += positions.getX(i); center.y += positions.getY(i); center.z += positions.getZ(i); count++;
      }
    }
    if (count < 2) return null;
    center.multiplyScalar(1 / count);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const sub of subs) {
      const positions = sub.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i) - center.x, y = positions.getY(i) - center.y, z = positions.getZ(i) - center.z;
        xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
      }
    }
    const axis = new THREE.Vector3(1, 1, 1).normalize();
    for (let i = 0; i < 24; i++) {
      const next = new THREE.Vector3(
        xx * axis.x + xy * axis.y + xz * axis.z,
        xy * axis.x + yy * axis.y + yz * axis.z,
        xz * axis.x + yz * axis.y + zz * axis.z,
      );
      if (next.lengthSq() < 1e-12) break;
      axis.copy(next.normalize());
    }
    if (axis.z < 0) axis.negate(); // raw-model +Z becomes editor/world up after RAW_TO_EDITOR
    let minimum = Infinity, maximum = -Infinity;
    for (const sub of subs) {
      const positions = sub.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        const projection = (positions.getX(i) - center.x) * axis.x
          + (positions.getY(i) - center.y) * axis.y + (positions.getZ(i) - center.z) * axis.z;
        minimum = Math.min(minimum, projection); maximum = Math.max(maximum, projection);
      }
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
    const muzzle = center.clone().addScaledVector(axis, maximum);
    const result = {
      muzzle: [muzzle.x, muzzle.y, muzzle.z] as V3,
      axis: [axis.x, axis.y, axis.z] as V3,
      length: maximum - minimum,
    };
    propPrincipalExtents.set(key, result);
    return result;
  }

  const nativeInstance = (level: string, sourceIndex: number): PropInstance | null =>
    nativeInstances.get(`${level}:${sourceIndex}`) ?? null;
  const physicsBody = (level: string, body: number): Float32Array | null =>
    physicsBodies.get(`${level}:${body}`) ?? null;
  const physicsMass = (level: string, body: number): PhysicsBodyMassProps | null =>
    physicsMassProps.get(`${level}:${body}`) ?? null;

  /** The amber edge-line geometry for a model's submeshes (cached per model). */
  function propEdges(level: string, model: number, geoms: THREE.BufferGeometry[]): LineSegmentsGeometry[] {
    const key = `${level}:${model}`;
    let e = propEdgeGeos.get(key);
    if (!e) {
      e = geoms.map(g => new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(g, 30)));
      propEdgeGeos.set(key, e);
    }
    return e;
  }

  /** The exact triangle-wire topology used by MeshBasicMaterial.wireframe in the no-solid view. */
  function propWireEdges(level: string, model: number, geoms: THREE.BufferGeometry[]): LineSegmentsGeometry[] {
    const key = `${level}:${model}`;
    let e = propWireGeos.get(key);
    if (!e) {
      e = geoms.map(g => new LineSegmentsGeometry().fromWireframeGeometry(new THREE.WireframeGeometry(g)));
      propWireGeos.set(key, e);
    }
    return e;
  }

  return {
    get propTex() { return propTex; },
    get propGeom() { return propGeom; },
    get propClips() { return propClips; },
    get groupDefs() { return groupDefs; },
    get propOutlineMat() { return propOutlineMat; },
    get effectOutlineMat() { return effectOutlineMat; },
    registerPropModels, syncLiveModels, hasPropGeom, registerGroupDefs, membersOf, memberLocalMatrix,
    propLocalBox, propPrincipalExtent, propEdges, propWireEdges, nativeInstance, physicsBody, physicsMass,
  };
}

export type PropAssets = ReturnType<typeof createPropAssets>;
