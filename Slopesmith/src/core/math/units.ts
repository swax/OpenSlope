/**
 * The ride, the effects runtime and the stored data all work in metres per second; every speed the editor SHOWS is
 * in mph, the unit the ride's HUD reads, so a number in a panel can be checked against the speedometer.
 */
export const MPH_PER_MPS = 2.236936;

/** A speed in m/s as the editor shows it: mph, whole unless `digits` asks for more. */
export const mphText = (mps: number, digits = 0): string => `${(mps * MPH_PER_MPS).toFixed(digits)} mph`;
