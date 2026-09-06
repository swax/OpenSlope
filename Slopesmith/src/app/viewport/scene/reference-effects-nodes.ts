/**
 * Pure payload decoding for the reference effect graph: node payload words in, plain value types out. Nothing
 * here touches the scene graph, the Three.js roots or the runtime's live state, so the ride layer, the arrow
 * overlay and the offline course runner can all read the same authored data the preview runtime does.
 */
import * as THREE from 'three';
import type { EffectNode } from '../../../core/effects/document';
import type { BoostVolumeSpec } from '../../ride/boost-volumes';

/** Only trigger circumstances use a rendered-bounds proximity approximation in Play. Collision
 * circumstances and CollisonSound rows are exact-contact events [Trailmap: 370, 420]. A trigger column with
 * an explicit dispatcher is an OUTPUT rather than a rider volume: Cracked is the retail example, firing its
 * own slot's trigger only when the strength pool runs out. */
export function playProximityRadius(circumstance: string, objectRadius: number,
  explicitlyDispatched = false): number | null {
  return circumstance === 'trigger' && !explicitlyDispatched ? Math.max(14, objectRadius + 1) : null;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const finiteOr = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const numberField = (fields: Record<string, unknown> | null, key: string, fallback: number): number => {
  const value = fields?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

/**
 * One payload decode for every reader of the MainType-0 boost family: the ride's containment runtime resolves
 * it into editor world space, the arrow overlay into the reference's own frame, and the offline course runner
 * (scripts/ai-course-run.ts) into the same world frame the ride uses. Only the two frame changes differ, so
 * they are what the caller supplies — `world` for the push axes, which are world-space fields the host's
 * rotation must not turn, and `hostLocal` for the lap-gated stage axis, which is the one field it does.
 */
/**
 * The Cracked node's two payload words ([Trailmap: 230-level-ssf type 0 sub 14]).
 *
 * `U0` is the CRACK's lifetime in seconds, not the surface's: when it expires the node retires and takes the
 * accumulated damage with it, so the surface heals. Every retail pane authors -1 and never expires. `U1` is
 * the strength pool, an impact budget rather than a count of hits — retail's panes ship 5, which is about
 * three seconds of being ridden or one hard landing.
 */
export function crackedSurfaceSpec(node: EffectNode): { lifetimeSeconds: number; strength: number } | null {
  if (node.semanticType !== 'property.cracked') return null;
  const type0 = isObject(node.payload.type0) ? node.payload.type0 : null;
  const cracked = type0 && isObject(type0.type0Sub14) ? type0.type0Sub14 : null;
  if (!cracked) return null;
  return { lifetimeSeconds: finiteOr(cracked.U0), strength: finiteOr(cracked.U1) };
}

/** DeadNodeMode 2 in a Cracked Trigger thread tombstones the addressed support instance's collision. This is
 * the exact Megaplex pairing: the visible pane fires MainType 7 at an invisible solid surface whose called
 * graph contains this node. Outside that thread it remains an ordinary node-lifetime tombstone. */
export function crackedBreakTombstonesCollider(node: EffectNode): boolean {
  if (node.semanticType === 'property.node-tombstone') return true;
  const type0 = isObject(node.payload.type0) ? node.payload.type0 : null;
  return node.mainType === 0 && type0?.SubType === 5 && type0.DeadNodeMode === 2;
}

export function boostVolumeSpec(node: EffectNode, world: (raw: THREE.Vector3) => THREE.Vector3,
  hostLocal: (raw: THREE.Vector3) => THREE.Vector3,
  worldPoint?: (raw: THREE.Vector3) => THREE.Vector3): BoostVolumeSpec | null {
  const type0 = isObject(node.payload.type0) ? node.payload.type0 : null;
  if (!type0) return null;
  const axis = (x: unknown, y: unknown, z: unknown) =>
    world(new THREE.Vector3(finiteOr(x), finiteOr(y), finiteOr(z)));
  /**
   * The vertical lift's target altitude, which is the ONE field in this family that names a POSITION rather
   * than a direction or a magnitude — and so the one that has to travel through the full transform instead of
   * just the basis.
   *
   * `world` is deliberately a vector map: it applies the frame's rotation and scale and drops the
   * translation, which is right for a push axis and wrong for a point. Converting the altitude by a bare
   * 1/100 gets the right answer only while the ridden world happens to sit at the native origin in Y — true
   * by default, since the reference loads offset along X alone, and false the moment anyone drags it
   * vertically. Then the lift aims at a stale altitude: dragged down, it carries riders further than authored.
   *
   * So the caller supplies a point map when it has one, and the bare scale is the fallback for a caller with
   * no frame to speak of (the arrow overlay, which draws in the reference's own space).
   */
  const toEditorY = (rawZ: number) => (worldPoint
    ? worldPoint(new THREE.Vector3(0, 0, rawZ)).y
    : rawZ / 100);
  /** A LENGTH, not a point: the snap tolerance is a gap, so it takes the scale and nothing else. */
  const toEditorLength = (raw: number) => raw / 100;
  const boostMode = (payload: Record<string, unknown> | null) => ({
    mode: Math.trunc(finiteOr(payload?.Mode)),
    seconds: Math.max(0, finiteOr(payload?.U1)),
  });

  switch (node.semanticType) {
    case 'property.boost': {
      const b = isObject(type0.Boost) ? type0.Boost : null;
      const dir = isObject(b?.BoostDir) ? b!.BoostDir : null;
      if (!b || !dir) return null;
      return {
        kind: 'directional', dir: axis(dir.X, dir.Y, dir.Z).normalize(),
        target: finiteOr(b.BoostAmount), rate: finiteOr(b.U2), ...boostMode(b),
      };
    }
    case 'property.z-boost': {
      const z = isObject(type0.type0Sub18) ? type0.type0Sub18 : null;
      if (!z) return null;
      return {
        kind: 'vertical-lift', dir: axis(z.U2, z.U3, z.U4).normalize(),
        target: finiteOr(z.U1), rate: finiteOr(z.U0),
        targetY: toEditorY(finiteOr(z.U5)), snapTolerance: toEditorLength(finiteOr(z.U6)),
      };
    }
    case 'property.lap-boost': {
      const l = isObject(type0.type0Sub15) ? type0.type0Sub15 : null;
      if (!l) return null;
      return {
        kind: 'lap-gated', dir: axis(l.U2, l.U3, l.U4).normalize(),
        target: finiteOr(l.U1), rate: finiteOr(l.U0),
        // hostLocal, not world: the stage axis is the one field in the family the engine DOES turn by the
        // host, running its instance matrix over (1,0,0) ([Trailmap: 360-lapboost-stage]).
        axis: hostLocal(new THREE.Vector3(1, 0, 0)).normalize(),
        // The engine's gate is the host box floor plus 1000 engine units; the ride owns the box, so only the
        // offset travels — in editor metres.
        stageFloorOffset: 10,
      };
    }
    case 'property.tube-end-boost': {
      const t = isObject(type0.type0Sub24) ? type0.type0Sub24 : null;
      if (!t) return null;
      return {
        // Its update is sub-7's, so it carries sub-7's mode and window at sub-7's payload offsets.
        kind: 'tube-end', rate: finiteOr(t.U2), mode: Math.trunc(finiteOr(t.U0)),
        seconds: Math.max(0, finiteOr(t.U1)),
        stages: [
          { dir: axis(t.U7, t.U8, t.U9).normalize(), speed: finiteOr(t.U16) },
          { dir: axis(t.U10, t.U11, t.U12).normalize(), speed: finiteOr(t.U17) },
          { dir: axis(t.U13, t.U14, t.U15).normalize(), speed: finiteOr(t.U18) },
        ],
      };
    }
    default: return null;
  }
}
