import type { NativeCollisionProfile, PlacedProp, V3 } from '../doc/types';
import {
  NATIVE_COLLISION_MODE,
  nativeContactState,
  type NativeCollisionState,
} from '../collision/native';

/** Pseudo-level used by Effects-authored trigger boxes. They have generated box geometry, not a prop library model. */
export const EFFECT_TRIGGER_LEVEL = '@effects';
export const DEFAULT_EFFECT_TRIGGER_SIZE: V3 = [12, 6, 12];
export const MIN_EFFECT_TRIGGER_SIZE = 0.5;

/** Specified state for an attached collision trigger [Trailmap: 130-collision-data, 150-logic]: hidden,
 * pass-through, and backed by its box proxy. */
export const EFFECT_TRIGGER_COLLISION_STATE: NativeCollisionState = Object.freeze({
  visible: false,
  playerCollision: true,
  playerBounce: false,
  mode: NATIVE_COLLISION_MODE.triangleProxy,
  responseMass: 0,
  hasTriangleProxy: true,
  hasPhysicsBody: false,
});

/** Editable defaults stamped when Add Trigger creates a placed volume. Later effect edits never rewrite them. */
export function effectTriggerCollisionProfile(): NativeCollisionProfile {
  return {
    mode: NATIVE_COLLISION_MODE.triangleProxy,
    playerCollision: true,
    responseMass: 0,
    playerBounce: false,
    bounceAmount: 0,
  };
}

/** Per [Trailmap: 130-collision-data], a detached/persistent-only trigger has no collision shape and cannot
 * dispatch a collision graph. */
export function effectTriggerCollisionState(enabled: boolean): NativeCollisionState {
  return enabled ? EFFECT_TRIGGER_COLLISION_STATE : {
    ...EFFECT_TRIGGER_COLLISION_STATE,
    playerCollision: false,
    mode: NATIVE_COLLISION_MODE.none,
    hasTriangleProxy: false,
  };
}

export const effectTriggerContactState = (enabled: boolean) =>
  nativeContactState(effectTriggerCollisionState(enabled));

/**
 * Trigger authoring can be the first feature to place anything on a mountain. Persist the array in that
 * empty-document case instead of returning a throwaway fallback that leaves the new attachment orphaned.
 */
export function ensureEffectTriggerProps(document: { props?: PlacedProp[] }): PlacedProp[] {
  return (document.props ??= []);
}

export function isEffectTriggerProp(prop: PlacedProp | null | undefined): prop is PlacedProp & {
  effectTrigger: { size: V3 };
} {
  return !!prop?.effectTrigger && prop.level === EFFECT_TRIGGER_LEVEL
    && Array.isArray(prop.effectTrigger.size) && prop.effectTrigger.size.length === 3;
}

/** Keep authored dimensions positive and large enough that a fast rider cannot trivially skip the volume. */
export function clampEffectTriggerSize(size: readonly number[]): V3 {
  return [0, 1, 2].map(index => {
    const value = Number(size[index]);
    return Number.isFinite(value) ? Math.max(MIN_EFFECT_TRIGGER_SIZE, Math.abs(value)) : DEFAULT_EFFECT_TRIGGER_SIZE[index];
  }) as V3;
}

/** Effective box dimensions after the placed-prop uniform scale (e.g. a Props-mode multi-scale). */
export function effectTriggerWorldSize(prop: PlacedProp): V3 {
  const size = clampEffectTriggerSize(prop.effectTrigger?.size ?? DEFAULT_EFFECT_TRIGGER_SIZE);
  const scale = Number.isFinite(prop.scale) ? Math.max(0.01, Math.abs(prop.scale)) : 1;
  return [size[0] * scale, size[1] * scale, size[2] * scale];
}
