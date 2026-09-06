/**
 * The SurfaceType legend: the small integer terrain patches — and the rare RIDEABLE prop — carry to select
 * every per-surface behavior: ride feel (friction / sink / spray, [Trailmap: 310-surface-response]) and the
 * board-audio family the carve/glide loops come from (the SNOW.INF group, [Trailmap: 190-audio-data]).
 * Most props carry -1 ("none") and route through object handling — they are obstacles, not surfaces; a
 * surface-typed prop (Merqury City rooftops, wood bridges) rides and sounds like that material
 * [Trailmap: 120-objects]. Labels + audio groups are the dumped ELF material table (research/extracted-data).
 */
export const SURFACE_TYPES: readonly { label: string; audio: string }[] = [
  { label: 'reset / out of bounds', audio: 'POWDER' },
  { label: 'standard snow', audio: 'PACK' },
  { label: 'standard off track', audio: 'LOOSE' },
  { label: 'powdered snow', audio: 'POWDER' },
  { label: 'slow powdered snow', audio: 'POWDER' },
  { label: 'ice', audio: 'ICE' },
  { label: 'bounce / unskiable', audio: 'ICE' },
  { label: 'ice / water no trail', audio: 'PACK' },
  { label: 'glidy snow particles', audio: 'PACK' },
  { label: 'rock / off track', audio: 'ROCK' },
  { label: 'wall', audio: 'ROCK' },
  { label: 'ice crunch no trail', audio: 'ROCK' },
  { label: 'wood', audio: 'WOOD' },
  { label: 'off-track metal', audio: 'METAL' },
  { label: 'speed / grinding', audio: 'GLASS' },
  { label: 'standard unknown', audio: 'PACK' },
  { label: 'sand', audio: 'PACK' },
  { label: 'no collision', audio: 'PACK' },
  { label: 'show-off ramp / metal', audio: 'CHUTE' },
  { label: 'unknown', audio: 'CHUTE' },
];

/** Human-readable "12 · wood (WOOD audio)" for a SurfaceType; 'none' for -1 (object handling). */
export function surfaceTypeLabel(type: number): string {
  if (type < 0) return 'none';
  const s = SURFACE_TYPES[type];
  return s ? `${type} · ${s.label} (${s.audio} audio)` : String(type);
}

/** The authoring choices for a solid custom prop's ride surface — the types retail props actually wear
 *  (1/5/9/12/13 observed) plus the safe distinctive families. Deliberately excludes hazardous types
 *  (0 reset, 17 no-collision) and the untraced ones. -1 = default object handling (obstacle, not surface). */
export const SURFACE_AUTHOR_OPTIONS: readonly { name: string; type: number }[] = [
  { name: '(default — obstacle feel)', type: -1 },
  { name: 'snow', type: 1 },
  { name: 'powder', type: 3 },
  { name: 'ice', type: 5 },
  { name: 'rock', type: 9 },
  { name: 'wood', type: 12 },
  { name: 'metal', type: 13 },
  { name: 'glass (speed)', type: 14 },
  { name: 'sand', type: 16 },
  { name: 'ramp metal (chute)', type: 18 },
];
