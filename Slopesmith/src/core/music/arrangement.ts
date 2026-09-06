import type { RaceMusicArrangement, RaceMusicMode } from '../doc/types';

export const DEFAULT_RACE_MUSIC_ARRANGEMENT: RaceMusicArrangement = {
  mode: 'linear-loop',
  bpm: 120,
  loopStartSeconds: 0,
  /** Zero means the source file's end, so this default survives changing tracks. */
  loopEndSeconds: 0,
};

export function normalizeRaceMusicArrangement(value: unknown,
  fallbackMode: RaceMusicMode = 'retail-graph'): RaceMusicArrangement {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const mode: RaceMusicMode = raw.mode === 'linear-loop' || raw.mode === 'retail-graph'
    ? raw.mode : fallbackMode;
  const finite = (field: string, fallback: number): number => typeof raw[field] === 'number' && Number.isFinite(raw[field])
    ? Number(raw[field]) : fallback;
  const bpm = Math.max(40, Math.min(300, finite('bpm', DEFAULT_RACE_MUSIC_ARRANGEMENT.bpm)));
  const loopStartSeconds = Math.max(0, finite('loopStartSeconds', 0));
  const rawEnd = Math.max(0, finite('loopEndSeconds', 0));
  const loopEndSeconds = rawEnd > 0 && rawEnd <= loopStartSeconds ? loopStartSeconds + 0.01 : rawEnd;
  return { mode, bpm, loopStartSeconds, loopEndSeconds };
}
