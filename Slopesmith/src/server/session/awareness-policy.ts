/**
 * Awareness is disposable visual state, so its cadence can trade smoothness for a bounded amount of room
 * traffic as more participants arrive. Register assignments and every control message remain outside this
 * policy: they are reliable, ordered messages and never slow down with the room size.
 */
export interface AwarenessPolicy {
  /** How long the server gathers latest states before sending one shared room batch. */
  flushMs: number;
  /** The minimum period browsers should use when publishing their own latest state. */
  publishMs: number;
}

const TIERS: ReadonlyArray<{ through: number; policy: AwarenessPolicy }> = [
  { through: 25, policy: { flushMs: 30, publishMs: 80 } },
  { through: 50, policy: { flushMs: 80, publishMs: 80 } },
  { through: 75, policy: { flushMs: 125, publishMs: 125 } },
  { through: Infinity, policy: { flushMs: 200, publishMs: 200 } },
];

/** A room must fall this far below a tier boundary before its cadence speeds up again. */
export const AWARENESS_POLICY_HYSTERESIS = 3;

const tierFor = (participants: number): number => {
  const count = Math.max(0, Math.floor(participants));
  return TIERS.findIndex(tier => count <= tier.through);
};

/**
 * The policy for a room size. Growing rooms slow down as soon as they cross a boundary. Shrinking rooms keep
 * their current cadence for three departures, avoiding a join/leave pair repeatedly restarting every
 * browser's awareness timer around 25, 50 or 75 participants.
 */
export function awarenessPolicyFor(participants: number, previous?: AwarenessPolicy): AwarenessPolicy {
  const wanted = tierFor(participants);
  if (!previous) return TIERS[wanted].policy;
  const held = TIERS.findIndex(tier => tier.policy.publishMs === previous.publishMs
    && tier.policy.flushMs === previous.flushMs);
  if (held < 0 || wanted >= held) return TIERS[wanted].policy;

  const lowerBoundary = TIERS[held - 1].through;
  if (participants > lowerBoundary - AWARENESS_POLICY_HYSTERESIS) return TIERS[held].policy;
  return TIERS[wanted].policy;
}
