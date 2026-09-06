import type { Mode } from '../../viewport/types';

/**
 * The editor's inline SVG icon strings (top-bar mode / view / history glyphs + the prop-library button),
 * currentColor-stroked so a button's active state can brighten them via CSS. `svg` wraps a path body in the
 * shared 24×24 frame; `withPlus` is the "add this" variant — the base glyph shrunk toward the top-left with a
 * small + badge in the corner (the Add rail / gem / light buttons share it, so they read as one family).
 *
 * **Lucide-derived glyphs are marked `[lucide]` below.** Ten of the thirty-five are: `focus` and `info` match a
 * Lucide icon element-for-element, and eight more share an element with one and adapt the rest. The other
 * twenty-five are original, drawn to the same frame so the set reads as one family — but the frame itself
 * (`svg()`'s 24×24 viewBox, currentColor stroke, width 2, round caps and joins) is Lucide's convention, so
 * the attribution covers this file as a whole and does not rest on the marks being a complete list.
 *
 * Those marks were established against Lucide **v0.100.0**, identified as the vintage this set came from
 * because BULB's outline appears in that release and no later one. Two cautions for anyone re-deriving them:
 * Lucide redraws icons, so current upstream will not reproduce this; and the comparison has to be over whole
 * SVG ELEMENTS, not just `d` attributes — an earlier pass compared paths alone and so could not see that
 * `focus` carries a circle, which is exactly what distinguishes Lucide's `focus` from its `scan`.
 *
 * Lucide is ISC (© Lucide Icons and Contributors), with its Feather-inherited icons MIT (© Cole Bemis) — see
 * ../../../../ThirdPartyNotices/Lucide-LICENSE.txt and the THIRD-PARTY COMPONENTS section of ../../../../NOTICE.
 */

export const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const withPlus = (body: string) => `<g transform="scale(0.78)">${body}</g><path d="M18 15v6M15 18h6"/>`;

/** Shared box glyph for Props mode, the Props visibility control, and the armed-placement cursor. */
export const PROP_BOX_ICON_BODY = '<path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z"/><path d="M3 7l9 5 9-5M12 12v10"/>';

/** Shared outline bolt for Effects navigation. Keeping it stroked avoids the coloured emoji presentation. */
export const EFFECT_BOLT_ICON_BODY = '<path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z"/>';

/** The three trick / light placement glyphs, shared by their Add buttons and their armed viewport cursors —
 *  two rails with ties, a faceted gem, a bulb. Named bodies rather than inline strings for the same reason the
 *  box is: what you clicked to arm the tool has to be what is then riding your pointer. */
export const RAIL_ICON_BODY = '<path d="M5 21 8 4M15 21 12 4"/><path d="M6.5 12.5h8.4M7.2 8.5h6.6M5.8 16.5h10.2"/>';
export const GEM_ICON_BODY = '<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M9 3 6 9l6 12M15 3l3 6-6 12"/>';
/** [lucide] shares an element with Lucide v0.100.0 `lightbulb`; the outline is adapted. */
export const BULB_ICON_BODY = '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>';
/** A billboard panel on its post — the video-screen family (docs/051). */
export const SCREEN_ICON_BODY = '<rect x="3" y="4" width="18" height="11" rx="1"/><path d="M12 15v6M9 21h6"/>';

/** Shared paint-brush glyph for Paint mode and its armed viewport cursor.
 *  [lucide] shares elements with Lucide v0.100.0 `paintbrush`; the rest is adapted. */
export const PAINT_ICON_BODY = '<path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.83 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.83L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z"/><path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7"/><path d="M14.5 17.5 4.5 15"/>';

export const MODE_ICON: Record<Mode, string> = {
  // [lucide] Lucide v0.100.0 `mountain`, element-for-element.
  info: svg('<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>'), // mountain overview
  // [lucide] shares an element with Lucide v0.100.0 `edit-3`.
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'), // pencil
  paint: svg(PAINT_ICON_BODY), // paintbrush
  sculpt: svg('<path d="M8 4h8M9 4c0 4-2 5-2 9 0 3 2 5 5 5s5-2 5-5c0-4-2-5-2-9"/><path d="M4 19h16M9 19v3h6v-3"/>'), // pottery wheel
  props: svg(PROP_BOX_ICON_BODY), // box (place props)
  effects: svg(EFFECT_BOLT_ICON_BODY), // outline lightning bolt
  play: svg('<path d="M10 2v6.5L4.3 18.4A1.1 1.1 0 0 0 5.3 20h13.4a1.1 1.1 0 0 0 1-1.6L14 8.5V2"/><path d="M8 2h8M7 15h10"/>'), // lab flask (Test mode; stored mode value stays `play`)
};

/** Users mode (docs/038). It sits beside the numbered mode row rather than inside it — it is about the server
 *  rather than about the map — so it has its own glyph rather than an entry in MODE_ICON. */
export const USERS_ICON = svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
  + '<path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>');

/** A participant actively following another tab's shared screen. */
export const WATCHING_ICON = svg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/>'
  + '<circle cx="12" cy="12" r="2.5"/>');

/** The app menu's stand-in on a narrow bar: three rules where the word "Slopesmith" no longer fits. */
export const MENU_ICON = svg('<path d="M4 7h16M4 12h16M4 17h16"/>');

// Undo / redo as icons, dimmed when there's no history to step through.
export const HIST_ICON = {
  // [lucide] shares an element with Lucide v0.100.0 `undo-2`.
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>'),
  // [lucide] shares an element with Lucide v0.100.0 `redo-2`.
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>'),
};

/** Autosave / shared-delivery state. Colour and motion carry the state; the disk remains one stable landmark. */
export const SAVE_ICON = svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>');

/** Compact media transport glyphs used by the shared Jukebox controls. */
export const MEDIA_ICON = {
  play: svg('<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M9 5v14M15 5v14"/>'),
  skip: svg('<path d="m5 5 10 7L5 19Z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>'),
  volume: svg('<path d="M4 9h4l5-4v14l-5-4H4Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
  muted: svg('<path d="M4 9h4l5-4v14l-5-4H4Z"/><path d="m17 9 4 4M21 9l-4 4"/>'),
};

// Compact edit actions shared by dense inspector rows. Tooltips + aria labels carry the words; the glyphs
// keep reorder / duplicate / delete controls readable without four uneven text buttons consuming the panel.
export const ACTION_ICON = {
  up: svg('<path d="m6 15 6-6 6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  duplicate: svg('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
  delete: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 10v7M14 10v7"/>'),
};

// View controls as icons: the Control cage, XYZ grid, Surface / Textures shading, and a focus action.
export const VIEW_ICON = {
  grid: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'),
  magnet: svg('<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>'),
  chevronDown: svg('<path d="m7 10 5 5 5-5"/>'),
  // [lucide] shares an element with Lucide v0.100.0 `image`.
  textures: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'), // image
  // [lucide] shares an element with Lucide v0.100.0 `palette`.
  surface: svg('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>'), // palette
  cage: svg('<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/>'), // dashed control box
  fGlyph: svg('<path d="M8 20V4h9"/><path d="M8 12h7"/>'), // the letter F (tile-orientation overlay)
  // [lucide] Lucide v0.100.0 `focus`, element-for-element (the centre circle is what tells it from `scan`).
  focus: svg('<circle cx="12" cy="12" r="3"/><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'), // focus frame
  // [lucide] shares an element with Lucide v0.100.0 `sun`.
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'), // master Lighting
  skybox: svg('<path d="M3 17.5 8.5 12l3.5 3.5 2.5-2.5L21 19.5"/><path d="M3 20V4h18v16Z"/><circle cx="16.5" cy="8.5" r="2"/>'), // framed horizon
  props: svg(PROP_BOX_ICON_BODY), // box (props on/off)
  lights: svg('<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13"/>'), // light, sound, video + effect emitters
  addRail: svg(withPlus(RAIL_ICON_BODY)),     // two rails + ties, + badge (add rail)
  addGem: svg(withPlus(GEM_ICON_BODY)),       // faceted gem, + badge (add gem)
  addLight: svg(withPlus(BULB_ICON_BODY)),    // light bulb, + badge (add light)
  addScreen: svg(withPlus(SCREEN_ICON_BODY)), // billboard panel, + badge (add video screen)
  tricks: svg('<path d="M12 2l2.6 6.6L21 9.3l-5 4.3L17.5 21 12 17.3 6.5 21 8 13.6l-5-4.3 6.4-.7z"/>'), // star — the trick layer
  effects: svg('<path d="M3 8c2.2-2 4.3-2 6.5 0s4.3 2 6.5 0 4.3-2 5 0"/><path d="M3 13c2.2-2 4.3-2 6.5 0s4.3 2 6.5 0 4.3-2 5 0"/><path d="M3 18c2.2-2 4.3-2 6.5 0s4.3 2 6.5 0 4.3-2 5 0"/>'), // moving world/material effects
};

/** The 2×2 tile grid that marks a bottom-dock library. ONE glyph for both of them (the Texture Library in
 *  Paint, the Prop Library in Props), because a mode only ever has one library down there — the word beside
 *  it says which. Worn by the two Tools-panel toggles and by the pull-up tabs at the bottom edge. */
export const LIB_GRID_ICON_BODY = '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>';

export const LIB_GRID_ICON = svg(LIB_GRID_ICON_BODY);

export const PROP_LIB_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LIB_GRID_ICON_BODY}</svg>`;
