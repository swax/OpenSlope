/** Shared MC banks and default tuning from Unity's AnnouncerU / RideableBoard.Race. */
export const ANNOUNCER_EVENTS = {
  go: { bank: 'Go', label: 'Start', chance: 1 },
  bigAir: { bank: 'Big_Air', label: 'Big air', chance: 0.9 },
  land: { bank: 'Land', label: 'Landing', chance: 0.45 },
  knockdown: { bank: 'Knockdown', label: 'Wipeout', chance: 0.9 },
  slow: { bank: 'Slow', label: 'Slow riding', chance: 0.8 },
  boost: { bank: 'Boost_Icon', label: 'Boost', chance: 0.5 },
  sweet: { bank: 'Sweet', label: 'Clean run', chance: 0.6 },
} as const;
export type AnnouncerEvent = keyof typeof ANNOUNCER_EVENTS;
export const ANNOUNCER_EVENT_IDS = Object.keys(ANNOUNCER_EVENTS) as AnnouncerEvent[];
export interface AnnouncerSettings {
  volume: number;
  cooldownSeconds: number;
  events: Record<AnnouncerEvent, { chance: number; file?: string }>;
}
export type AnnouncerIndex = Record<AnnouncerEvent, string[]>;

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown, fallback: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : fallback;

export function normalizeAnnouncer(value: unknown): AnnouncerSettings {
  const raw = record(value), events = record(raw.events);
  return {
    volume: number(raw.volume, 0.85, 1),
    cooldownSeconds: number(raw.cooldownSeconds, 5, 60),
    events: Object.fromEntries(ANNOUNCER_EVENT_IDS.map(id => {
      const event = record(events[id]);
      const file = typeof event.file === 'string' && /^[A-Za-z0-9_-]+\.wav$/i.test(event.file)
        ? event.file : undefined;
      return [id, { chance: number(event.chance, ANNOUNCER_EVENTS[id].chance, 1), ...(file ? { file } : {}) }];
    })) as AnnouncerSettings['events'],
  };
}

export interface AnnouncerRideFrame { grounded: boolean; airTime: number; speed01: number; boosting: boolean }

/** Fixed-tick event detector. A reset/remount clears flight state without inventing a landing or a GO. */
export class AnnouncerRideEvents {
  private airTime = 0;
  private bigAirCalled = false;
  private slow = 0;
  private boostCooldown = 10;
  private sweet = 0;

  reset(): void {
    this.airTime = 0; this.bigAirCalled = false; this.slow = 0; this.boostCooldown = 10; this.sweet = 0;
  }

  step(dt: number, frame: AnnouncerRideFrame): AnnouncerEvent[] {
    if (!Number.isFinite(dt) || dt <= 0) return [];
    const events: AnnouncerEvent[] = [];
    if (frame.grounded) {
      if (this.airTime >= 0.7) events.push('land');
      this.airTime = 0;
      this.bigAirCalled = false;
    } else {
      this.airTime = frame.airTime;
      if (!this.bigAirCalled && frame.airTime >= 1.4) { this.bigAirCalled = true; events.push('bigAir'); }
    }
    this.boostCooldown -= dt;
    if (frame.boosting && frame.grounded && this.boostCooldown <= 0) {
      events.push('boost'); this.boostCooldown = 45;
    }
    if (frame.grounded && frame.speed01 < 0.18) {
      this.slow += dt;
      if (this.slow > 6) { events.push('slow'); this.slow = -30; }
    } else if (this.slow > 0) this.slow = 0;
    if (frame.grounded && frame.speed01 > 0.5) this.sweet += dt;
    if (this.sweet > 40) { events.push('sweet'); this.sweet = 0; }
    return events;
  }
}
