import type { TimedRaceMode } from '../../core/doc/race';
import type { RideTrickDisplay } from './score';

/** Run information that remains presentation-independent: the desktop chip and WebXR wrist read the same state. */
export interface RideRunStatus {
  mode: TimedRaceMode;
  phase: 'running' | 'finished' | 'time-up';
  /** Mode-facing clock: elapsed in Race, remaining in Showoff. */
  clockSeconds: number;
  /** Always elapsed, so a final result can show the rider's time in either mode. */
  elapsedSeconds: number;
  /** Banked score plus the live in-progress trick preview, frozen when the event ends. */
  score: number;
  /** Unity's run-scoped held-boost energy, used by the wrist bar while the run is live. */
  boostMeter: number;
  /** Showoff-only live or briefly held trick calculation. Race deliberately exposes no points presentation. */
  trick: RideTrickDisplay | null;
}
