import type { V3 } from '../../../core/doc/types';

export type PlacementEndpoint = { pos: V3; vertex: number | null };

/** Constrain a placement point to the dominant world axis from `anchor` while Shift is held.
 * An existing vertex is still reused when it already lies on that axis; otherwise the constrained
 * position becomes a new point so axis lock never silently moves an existing mesh vertex. */
export function constrainPlacement(endpoint: PlacementEndpoint, anchor: V3 | null, axisLocked: boolean): PlacementEndpoint {
  if (!axisLocked || !anchor) return { pos: [...endpoint.pos] as V3, vertex: endpoint.vertex };
  const delta: V3 = [endpoint.pos[0] - anchor[0], endpoint.pos[1] - anchor[1], endpoint.pos[2] - anchor[2]];
  let axis = 0;
  if (Math.abs(delta[1]) > Math.abs(delta[axis])) axis = 1;
  if (Math.abs(delta[2]) > Math.abs(delta[axis])) axis = 2;
  const pos: V3 = [...anchor] as V3;
  pos[axis] = endpoint.pos[axis];
  const stillOnVertex = Math.hypot(pos[0] - endpoint.pos[0], pos[1] - endpoint.pos[1], pos[2] - endpoint.pos[2]) < 1e-6;
  return { pos, vertex: stillOnVertex ? endpoint.vertex : null };
}
