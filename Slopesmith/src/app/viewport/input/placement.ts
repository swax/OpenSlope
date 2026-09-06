import type * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { dataToScene, sceneToData } from '../coordinates';
import type { Stage } from '../stage';
import { constrainPlacement, type PlacementEndpoint } from './placement-constraint';

export interface PlacementResolver {
  stage: Stage;
  terrain: () => THREE.Mesh;
  pickVertex: () => PlacementEndpoint | null;
}

/** Shared placement fallback: vertex snap, terrain hit, then a screen-facing plane through the chain anchor. */
export function resolvePlacementEndpoint(
  resolver: PlacementResolver,
  anchor: V3 | null,
  axisLocked = false,
  surfaceLiftM = 0,
): PlacementEndpoint | null {
  const { stage } = resolver;
  let endpoint = resolver.pickVertex();
  let surfaceContact = !!endpoint;
  if (!endpoint) {
    // Runs per pointer move while a placement tool is armed, so it goes through the surface's cached pick
    // tree rather than walking every triangle. The resolver's own surface, NOT stage.terrainMesh: a
    // model-edit session places against the surrounding mountain backdrop (Viewport.placementSurface).
    const hit = stage.pickSurface(resolver.terrain());
    if (hit) {
      endpoint = { pos: stage.snapDataPoint(sceneToData(hit.point)), vertex: null };
      surfaceContact = true;
    }
  }
  if (!endpoint) {
    const point = stage.screenPlanePoint(anchor ? dataToScene(anchor) : undefined);
    if (point) endpoint = { pos: stage.snapDataPoint(sceneToData(point)), vertex: null };
  }
  // A generated surface must not be coplanar with the terrain it was traced over. Placement tools that ask
  // for a lift get it only on a real mesh/vertex contact; free-space construction remains exactly under the
  // cursor. Clear the source vertex because the lifted point is intentionally a new position, not a topology
  // snap to that vertex.
  if (endpoint && surfaceContact && surfaceLiftM !== 0) endpoint = {
    pos: [endpoint.pos[0], endpoint.pos[1] + surfaceLiftM, endpoint.pos[2]],
    vertex: null,
  };
  return endpoint ? constrainPlacement(endpoint, anchor, axisLocked) : null;
}
