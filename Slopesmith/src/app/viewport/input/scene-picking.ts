import * as THREE from 'three';
import type { Stage } from '../stage';
import {
  isReferencePropMesh, referencePropHitSlot, referencePropInstanceId, referencePropSlot,
  type ReferencePropMesh,
} from '../scene/reference-prop-mesh';

export type ScenePickSource = 'authored' | 'reference';
export type ReferencePropScope = 'standard' | 'effects';

export type ScenePick =
  | { target: 'prop'; source: 'authored'; hit: THREE.Intersection; propIndex: number }
  | { target: 'prop'; source: 'reference'; hit: THREE.Intersection; instance: ReferencePropMesh;
      instanceId: number; sourceIndex?: number; level: string; model: number; name: string }
  | { target: 'light'; source: 'authored'; hit: THREE.Intersection; lightIndex: number }
  | { target: 'source'; source: ScenePickSource; hit: THREE.Intersection;
      sourceKind: 'light' | 'sound' | 'prop'; sourceIndex: number }
  | { target: 'rail'; source: 'authored'; hit: THREE.Intersection; railIndex: number; railNode?: number }
  /** A shipped level's grind curve, by its stable `Splines.json` row — the only place that rail exists. */
  | { target: 'rail'; source: 'reference'; hit: THREE.Intersection; splineIndex: number }
  | { target: 'gem'; source: 'authored'; hit: THREE.Intersection; gemIndex: number }
  /** A video screen's panel/movie marker, by its position in the authored or reference screen table. */
  | { target: 'screen'; source: ScenePickSource; hit: THREE.Intersection; screenIndex: number }
  | { target: 'particleVolume'; source: ScenePickSource; hit: THREE.Intersection;
      volumeIndex: number; volumeId?: string }
  | { target: 'knot'; source: 'authored'; hit: THREE.Intersection }
  | { target: 'surface'; source: ScenePickSource; hit: THREE.Intersection };

export interface ScenePickQuery {
  /** Standard Props geometry, or the broader Effects host set (including effect-only proxies). */
  props?: ReferencePropScope;
  lights?: boolean;
  /** Batched light-bulb / speaker markers exposed by the Sources view toggle. */
  sources?: boolean;
  rails?: boolean;
  gems?: boolean;
  screens?: boolean;
  /** Movie-marker-only screen query, used with Sources icons so it remains clickable through scenery. */
  screenMarkers?: boolean;
  particleVolumes?: boolean;
  knots?: boolean;
  /** All visible terrain bodies, or only one side for authored-only placement tools. */
  surfaces?: boolean | ScenePickSource;
  /** Test terrain only after an entity candidate exists; an occluded entity resolves to null, not a surface. */
  occludeWithSurfaces?: boolean | ScenePickSource;
  /** Lets a scene object coplanar with a surface win despite tiny raycast precision differences. */
  surfaceEpsilon?: number;
}

export interface ScenePickingAccess {
  authoredPropRoots(): readonly THREE.Object3D[];
  referencePropRoots(scope: ReferencePropScope): readonly THREE.Object3D[];
  authoredParticleRoots?(): readonly THREE.Object3D[];
  referenceParticleRoots?(): readonly THREE.Object3D[];
  lightRoots(): readonly THREE.Object3D[];
  sourceRoots(): readonly THREE.Object3D[];
  railRoots(): readonly THREE.Object3D[];
  /** The loaded reference's drawn grind splines, pickable wherever the authored rails are. */
  referenceRailRoots?(): readonly THREE.Object3D[];
  gemRoots(): readonly THREE.Object3D[];
  /** Authored and reference video-screen panels and movie-marker clouds. */
  screenRoots?(): readonly THREE.Object3D[];
  knotTargets(): readonly THREE.Object3D[];
  surfaceTargets(): readonly { source: ScenePickSource; object: THREE.Object3D }[];
}

/**
 * Typed scene-entity picking shared by modes. It owns visibility filtering, per-family raycasts, stable-id
 * decoding, and nearest-hit resolution. The pointer router still owns precedence between gestures/tools and
 * decides whether a resolved entity selects, places, clears, or reports an unavailable-target toast.
 *
 * Mesh topology is deliberately outside this service: point/edge/patch picking is screen-space and has its own
 * priority rules in MeshPicking, while placement tools intentionally target a specific terrain/construction plane.
 */
export function createScenePicking(stage: Stage, access: ScenePickingAccess) {
  function visibleInTree(object: THREE.Object3D): boolean {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      if (!node.visible) return false;
    }
    return true;
  }

  function firstHit(
    roots: readonly THREE.Object3D[],
    recursive: boolean,
    accept: (hit: THREE.Intersection) => boolean = () => true,
  ): THREE.Intersection | undefined {
    const visibleRoots = roots.filter(visibleInTree);
    if (!visibleRoots.length) return undefined;
    return stage.ray.intersectObjects(visibleRoots, recursive)
      .find(hit => visibleInTree(hit.object) && accept(hit));
  }

  function referencePropHit(roots: readonly THREE.Object3D[], scope: ReferencePropScope): THREE.Intersection | undefined {
    const hits = stage.ray.intersectObjects(roots.filter(visibleInTree), true)
      .filter(hit => visibleInTree(hit.object) && isReferencePropMesh(hit.object));
    const nearest = hits[0];
    if (!nearest || scope !== 'effects') return nearest;
    const placement = (hit: THREE.Intersection) => referencePropHitSlot(hit)?.inst;
    const nearestPlacement = placement(nearest);
    if (!nearestPlacement?.loc || nearestPlacement.visible !== false) return nearest;
    // Effects exposes hidden state-replacement proxies (for example an intact LCD and its broken twin) at the
    // same authored transform. When both geometries intersect the pointer, select what the map currently shows;
    // the hidden outline remains selectable anywhere it does not overlap the visible state.
    const visibleColocated = hits.find(hit => {
      const candidate = placement(hit);
      return candidate?.visible !== false && candidate?.loc?.length === nearestPlacement.loc!.length
        && candidate.loc.every((value, index) => value === nearestPlacement.loc![index]);
    });
    return visibleColocated ?? nearest;
  }

  function pick(query: ScenePickQuery): ScenePick | null {
    const candidates: ScenePick[] = [];
    const consider = (candidate: ScenePick | null) => { if (candidate) candidates.push(candidate); };

    if (query.props) {
      const authored = firstHit(access.authoredPropRoots(), true,
        hit => Number.isInteger(hit.object.userData.propIndex));
      if (authored) consider({
        target: 'prop', source: 'authored', hit: authored,
        propIndex: authored.object.userData.propIndex as number,
      });

      const reference = referencePropHit(access.referencePropRoots(query.props), query.props);
      const instanceId = reference ? referencePropInstanceId(reference) : null;
      if (reference && instanceId !== null && isReferencePropMesh(reference.object)) {
        const instance = reference.object;
        const slot = referencePropSlot(instance, instanceId);
        if (slot) consider({
          target: 'prop', source: 'reference', hit: reference, instance, instanceId,
          sourceIndex: slot.inst.sourceIndex,
          level: slot.level,
          model: slot.model,
          name: slot.name,
        });
        else if (instance instanceof THREE.InstancedMesh
          && typeof instance.userData.propLevel === 'string' && Number.isInteger(instance.userData.propModel)) {
          // Small embedders/tests may still provide the pre-batching mesh-level identity without full source data.
          consider({ target: 'prop', source: 'reference', hit: reference, instance, instanceId,
            level: instance.userData.propLevel as string, model: instance.userData.propModel as number,
            name: instance.name });
        }
      }
    }

    if (query.lights) {
      const hit = firstHit(access.lightRoots(), true,
        candidate => Number.isInteger(candidate.object.userData.lightIndex)
          || (candidate.object.userData.lightPoints === true && Number.isInteger(candidate.index)));
      if (hit) consider({
        target: 'light', source: 'authored', hit,
        lightIndex: Number.isInteger(hit.object.userData.lightIndex)
          ? hit.object.userData.lightIndex as number : hit.index as number,
      });
    }

    if (query.sources) {
      const hit = firstHit(access.sourceRoots(), true, candidate => {
        const kind = candidate.object.userData.sourceKind;
        const origin = candidate.object.userData.sourceOrigin;
        return (kind === 'light' || kind === 'sound' || kind === 'prop')
          && (origin === 'authored' || origin === 'reference') && Number.isInteger(candidate.index);
      });
      if (hit) consider({
        target: 'source',
        source: hit.object.userData.sourceOrigin as ScenePickSource,
        hit,
        sourceKind: hit.object.userData.sourceKind as 'light' | 'sound' | 'prop',
        sourceIndex: hit.index as number,
      });
    }

    if (query.rails) {
      const hit = firstHit(access.railRoots(), true,
        candidate => Number.isInteger(candidate.object.userData.railIndex));
      if (hit) consider({
        target: 'rail', source: 'authored', hit,
        railIndex: hit.object.userData.railIndex as number,
        railNode: Number.isInteger(hit.object.userData.railNode)
          ? hit.object.userData.railNode as number : undefined,
      });
      const refHit = firstHit(access.referenceRailRoots?.() ?? [], true,
        candidate => Number.isInteger(candidate.object.userData.refSplineIndex));
      if (refHit) consider({
        target: 'rail', source: 'reference', hit: refHit,
        splineIndex: refHit.object.userData.refSplineIndex as number,
      });
    }

    if (query.gems) {
      const hit = firstHit(access.gemRoots(), true,
        candidate => Number.isInteger(candidate.object.userData.gemIndex));
      if (hit) consider({
        target: 'gem', source: 'authored', hit,
        gemIndex: hit.object.userData.gemIndex as number,
      });
    }

    if (query.screens || query.screenMarkers) {
      // Either half of a screen answers: its panel carries the index, and its movie marker is one point of a
      // batched cloud, so the point's own index is the screen's. Same shape as a light's bulb versus its rig.
      const hit = firstHit(access.screenRoots?.() ?? [], true,
        candidate => (query.screens === true && Number.isInteger(candidate.object.userData.screenIndex))
          || (candidate.object.userData.screenPoints === true && Number.isInteger(candidate.index)));
      const source = hit?.object.userData.screenSource;
      if (hit && (source === 'authored' || source === 'reference')) consider({
        target: 'screen', source, hit,
        screenIndex: Number.isInteger(hit.object.userData.screenIndex)
          ? hit.object.userData.screenIndex as number : hit.index as number,
      });
    }

    if (query.particleVolumes) {
      const particle = (source: ScenePickSource, roots: readonly THREE.Object3D[]) => {
        const hit = firstHit(roots, true,
          candidate => Number.isInteger(candidate.object.userData.particleVolumeIndex));
        if (!hit) return;
        consider({ target: 'particleVolume', source, hit,
          volumeIndex: hit.object.userData.particleVolumeIndex as number,
          ...(typeof hit.object.userData.particleVolumeId === 'string'
            ? { volumeId: hit.object.userData.particleVolumeId as string } : {}) });
      };
      particle('authored', access.authoredParticleRoots?.() ?? []);
      particle('reference', access.referenceParticleRoots?.() ?? []);
    }

    if (query.knots) {
      const hit = firstHit(access.knotTargets(), false);
      if (hit) consider({ target: 'knot', source: 'authored', hit });
    }

    let best = candidates.reduce<ScenePick | null>(
      (nearest, candidate) => !nearest || candidate.hit.distance < nearest.hit.distance ? candidate : nearest,
      null,
    );

    const surfaceQuery = query.surfaces ?? query.occludeWithSurfaces;
    // Occlusion-only queries are deliberately lazy. Edit/Play use this to reject a prop only when one was
    // actually hit; raycasting a large terrain before every ordinary patch click was a costly no-op.
    if (surfaceQuery && (query.surfaces || best)) {
      let surface: { source: ScenePickSource; hit: THREE.Intersection } | null = null;
      for (const target of access.surfaceTargets()) {
        if (typeof surfaceQuery === 'string' && target.source !== surfaceQuery) continue;
        if (!visibleInTree(target.object)) continue;
        const hit = stage.ray.intersectObject(target.object, false)[0];
        if (hit && (!surface || hit.distance < surface.hit.distance)) surface = { source: target.source, hit };
      }
      const occludes = surface && best
        && surface.hit.distance + (query.surfaceEpsilon ?? 0) < best.hit.distance;
      if (query.occludeWithSurfaces && occludes) return null;
      // Candidate queries return the surface when it is meaningfully nearer, or when no entity was hit.
      if (query.surfaces && surface && (!best || occludes)) {
        best = { target: 'surface', source: surface.source, hit: surface.hit };
      }
    }

    return best;
  }

  return { pick };
}

export type ScenePicking = ReturnType<typeof createScenePicking>;
