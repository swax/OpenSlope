import type { NativeCollisionProfile, PlacedProp } from '../doc/types';
import { AUTHORED_MODEL_LEVEL } from '../doc/models';
import { IMPORTED_PROP_LEVEL } from './imported';
import { NATIVE_COLLISION_MODE, nativeContactState } from '../collision/native';

/** Semantic contact states authored by ordinary placed props [Trailmap: 130-collision-data, 150-logic]. */
export type PlacedPropContactState = 'none' | 'through' | 'solid';

/**
 * Backward-compatible default for documents saved before every placement carried an explicit Solid value.
 * Borrowed source art keeps the established solid default; arbitrary authored/imported geometry stays decorative
 * until opted in. New placements materialize this result so the UI and exporters share one unambiguous value.
 */
export function defaultPlacedPropSolid(level: string): boolean {
  return level !== AUTHORED_MODEL_LEVEL && level !== IMPORTED_PROP_LEVEL;
}

/** Complete editable default materialized on every new placement. Raw values remain independent after creation. */
export function defaultPlacedPropCollision(level: string): NativeCollisionProfile {
  const solid = defaultPlacedPropSolid(level);
  return {
    mode: solid ? NATIVE_COLLISION_MODE.triangleProxy : NATIVE_COLLISION_MODE.none,
    playerCollision: solid,
    responseMass: solid ? 1e30 : 0,
    playerBounce: solid,
    bounceAmount: solid ? 0.5 : 0,
  };
}

export interface SourceCollisionFacts {
  sourceIndex?: number;
  shape?: number;
  playerCollision?: boolean;
  responseMass?: number;
  playerBounce?: boolean;
  bounce?: number;
  physicsBody?: number;
  contact?: 'ghost' | 'through' | 'movable' | 'solid';
}

/** Copy a concrete extracted instance without collapsing its independently authored fields. */
export function collisionProfileFromSourceInstance(level: string, source: SourceCollisionFacts): NativeCollisionProfile {
  const mode = Number.isInteger(source.shape) && source.shape! >= 0 && source.shape! <= 3
    ? source.shape as 0 | 1 | 2 | 3 : NATIVE_COLLISION_MODE.none;
  const responseClass = source.contact === 'solid' || source.contact === 'movable';
  return {
    mode,
    playerCollision: source.playerCollision ?? source.contact !== 'ghost',
    responseMass: typeof source.responseMass === 'number' && source.responseMass >= 0
      ? source.responseMass : responseClass ? 1e30 : 0,
    playerBounce: source.playerBounce ?? responseClass,
    bounceAmount: typeof source.bounce === 'number' && source.bounce >= 0
      ? source.bounce : responseClass ? 0.5 : 0,
    ...(typeof source.physicsBody === 'number' && source.physicsBody >= 0
      ? { physicsSource: { level, body: Math.trunc(source.physicsBody),
          ...(source.sourceIndex !== undefined ? { instance: source.sourceIndex } : {}) } }
      : {}),
  };
}

/** Spec-defined result for one exact authored profile. Mode 1 always has the placement's generated mesh proxy. */
export function collisionProfileContactState(profile: NativeCollisionProfile): PlacedPropContactState {
  return nativeContactState({
    visible: true,
    playerCollision: profile.playerCollision,
    playerBounce: profile.playerBounce,
    mode: profile.mode,
    responseMass: profile.responseMass,
    hasTriangleProxy: profile.mode === NATIVE_COLLISION_MODE.triangleProxy,
    hasPhysicsBody: !!profile.physicsSource,
  });
}

/**
 * Compatibility compiler for maps saved before placed props carried a complete profile. Effects/sounds influence
 * this one-time legacy inference only; explicit profiles are never rewritten by attachments.
 */
export function inferredPlacedPropCollision(
  prop: Pick<PlacedProp, 'level' | 'solid' | 'effectTrigger' | 'bounce'>,
  collisionEffect = false,
  hitSound = false,
): NativeCollisionProfile {
  const solid = !prop.effectTrigger
    && (typeof prop.solid === 'boolean' ? prop.solid : defaultPlacedPropSolid(prop.level));
  const contactOnly = !solid && (!!prop.effectTrigger || collisionEffect || hitSound);
  return {
    mode: solid || contactOnly ? NATIVE_COLLISION_MODE.triangleProxy : NATIVE_COLLISION_MODE.none,
    playerCollision: solid || contactOnly,
    responseMass: solid ? 1e30 : 0,
    playerBounce: solid,
    bounceAmount: solid ? (typeof prop.bounce === 'number' ? Math.max(0, prop.bounce) : 0.5) : 0,
  };
}

/** Explicit authored profile, or the backward-compatible inference for an older document. */
export function placedPropCollisionProfile(
  prop: Pick<PlacedProp, 'level' | 'solid' | 'effectTrigger' | 'bounce' | 'nativeCollision'>,
  collisionEffect = false,
  hitSound = false,
): NativeCollisionProfile {
  return prop.nativeCollision ?? inferredPlacedPropCollision(prop, collisionEffect, hitSound);
}

/** Effective semantic Solid result. Exact profile fields win over the legacy Solid flag. */
export function placedPropSolid(
  prop: Pick<PlacedProp, 'level' | 'solid' | 'effectTrigger' | 'bounce' | 'nativeCollision'>,
): boolean {
  return collisionProfileContactState(placedPropCollisionProfile(prop)) === 'solid';
}

/**
 * Ordinary authoring compiles Solid to a response-enabled mode-1 proxy. A non-solid placement only receives
 * a pass-through proxy when a collision effect or hit sound needs contact; otherwise it remains decorative.
 */
export function placedPropContactState(
  prop: Pick<PlacedProp, 'level' | 'solid' | 'effectTrigger' | 'bounce' | 'nativeCollision'>,
  collisionEffect: boolean, hitSound: boolean): PlacedPropContactState {
  return collisionProfileContactState(placedPropCollisionProfile(prop, collisionEffect, hitSound));
}

export function placedPropContactLabel(state: PlacedPropContactState): string {
  return state === 'solid' ? 'solid — rider responds; attached effects and sounds can fire'
    : state === 'through' ? 'ride-through — attached effects and sounds can fire'
      : 'no contact — decorative only';
}
