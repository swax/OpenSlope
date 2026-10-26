/** A saturated rating scale distinct from the blue/purple wireframe and legible against snow. */
export const AI_PATH_RATING_COLORS = [0x187b42, 0xb45b06, 0xb62c2c] as const;
export const AI_PATH_OUTLINE = 0x0b1626;
export type AiPathEventShape = 'triangle' | 'circle' | 'diamond' | 'flag' | 'square' | 'cross';

/** Shared 32×32 paths for map marker textures and the inspector's legend. */
export const AI_PATH_EVENT_SHAPE_PATHS: Record<AiPathEventShape, string> = {
  triangle: 'M16 3L29 28H3Z',
  circle: 'M29 16A13 13 0 1 1 3 16A13 13 0 1 1 29 16Z',
  diamond: 'M16 2L30 16L16 30L2 16Z',
  flag: 'M6 2H29L24 10L29 18H10V30H6Z',
  square: 'M4 4H28V28H4Z',
  cross: 'M7 3L16 12L25 3L29 7L20 16L29 25L25 29L16 20L7 29L3 25L12 16L3 7Z',
};

export function aiPathColor(rating: number): number {
  const value = Number.isFinite(rating) ? Math.max(0, Math.min(100, rating)) : 50;
  const half = value <= 50 ? 0 : 1;
  const t = (value - half * 50) / 50;
  const a = AI_PATH_RATING_COLORS[half],
    b = AI_PATH_RATING_COLORS[half + 1];
  return [16, 8, 0].reduce(
    (color, shift) => color | (Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t) << shift),
    0,
  );
}

/** Descriptive labels for confirmed Tricky behavior, not recovered original names; unknown codes retain their identity. */
export function aiPathEventStyle(type: number): { name: string; color: number; shape: AiPathEventShape } {
  if (type === -1 || type === 0xffffffff) return { name: 'Disabled', color: 0x536176, shape: 'cross' };
  if (type === 100) return { name: 'Jump', color: 0x167c40, shape: 'triangle' };
  if (type === 101) return { name: 'Cruise speed', color: 0x206dc5, shape: 'circle' };
  if (type === 103) return { name: 'Reset before region', color: 0xc62d50, shape: 'diamond' };
  if (type === 104) return { name: 'No reset', color: 0xc62d50, shape: 'diamond' };
  if (type === 105) return { name: 'Reset after region', color: 0xc62d50, shape: 'diamond' };
  if (type === 300) return { name: 'Reselect path', color: 0x087d92, shape: 'flag' };
  return { name: 'Unidentified', color: 0x536176, shape: 'square' };
}

export const aiPathCssColor = (color: number) => `#${color.toString(16).padStart(6, '0')}`;
