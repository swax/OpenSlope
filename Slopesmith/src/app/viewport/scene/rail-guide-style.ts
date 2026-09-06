import { RAIL_STYLE_ICE, RAIL_STYLE_WOOD } from '../../../core/rails/rails';

/** Viewport guide colours by the spline surface the board actually rides. Metal remains the established red;
 * wood and ice use distinct yellow/blue families. Selection keeps the hue but raises value as well as width. */
export const RAIL_GUIDE_PALETTES = {
  metal: { normal: 0xd63a3a, selected: 0xff9e9e },
  wood: { normal: 0xf2c94c, selected: 0xffee9a },
  ice: { normal: 0x3b9cff, selected: 0xa6d8ff },
} as const;

export function railGuidePalette(style: number) {
  if (style === RAIL_STYLE_ICE) return RAIL_GUIDE_PALETTES.ice;
  if (style === RAIL_STYLE_WOOD) return RAIL_GUIDE_PALETTES.wood;
  return RAIL_GUIDE_PALETTES.metal;
}
