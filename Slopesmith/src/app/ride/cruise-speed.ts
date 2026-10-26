import type { RefAiPathEvent } from '../../core/reference/terrain';

/** Type-101 cruise inputs from Trailmap 250/395. Stations are horizontal metres; speed is m/s. */
export function cruiseSpeedInput(
  events: readonly RefAiPathEvent[],
  previous: number,
  current: number,
  speed: number,
  aggression: number,
) {
  // Keep source order: the first overlapping record wins, even when a later record starts nearer.
  const event = events.find(event => event.type === 101 && event.start <= current + 6 && event.end >= previous);
  if (!event) return null;
  const target = event.value / 3.6;
  const entered = event.start <= current;
  const slop = 5 / 3.6;
  const lower = (target - slop) * (aggression === 1 ? 1 : aggression / 1.410261);
  const overspeed = speed > target + slop;
  const throttle = !overspeed && speed < lower;
  return { target, entered, throttle, brake: overspeed && entered, boost: throttle && entered };
}
