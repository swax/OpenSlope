import type * as THREE from 'three';

/** World-space actions produced by the SSF graph runtime after stable instance references have been resolved. */
export type RideEffectAction =
  | { kind: 'reset' }
  | { kind: 'hud-message'; text: string; color: [number, number, number]; durationSeconds: number }
  | { kind: 'speed-boost'; amount: number }
  | { kind: 'trick-boost'; seconds: number }
  | { kind: 'score-multiplier'; multiplier: number }
  | { kind: 'teleport'; position: THREE.Vector3; heading: THREE.Vector3 };

export interface RideEffectState {
  speedBoostSeconds: number;
  trickBoostSeconds: number;
  scoreMultiplier: number;
  /** Unity's run-scoped 0..1 boost meter; null outside a live scored run. */
  boostMeter: number | null;
}
