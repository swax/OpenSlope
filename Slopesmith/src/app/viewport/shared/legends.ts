import * as THREE from 'three';
import { DEFAULT_SURFACE, SURFACE_STYLE, surfaceStyle, SURFACE_TYPES } from '../../../core/doc/types';
import {
  SURFACE_AUTHOR_OPTIONS, SURFACE_TYPES as REFERENCE_SURFACE_TYPES,
} from '../../../core/reference/surface-types';
import { CAGE_INTERIOR_COLOR, CAGE_BOUNDARY_COLOR, CAGE_LOCKED_COLOR, CAGE_TEAR_COLOR, FRAME_GLYPH_COLOR,
  CAGE_EXTRA3_COLOR, CAGE_EXTRA5_COLOR, CAGE_POINT_COLOR } from '../constants';
import { BACKFACE_TINT_RGB } from '../mesh/backface-tint';
import { PROP_DARK_TINT_MIX, PROP_CLAY_COLOR, PROP_SOLID_COLOR, PROP_THROUGH_COLOR,
  propContactTint } from '../scene/prop-shade';
import type { ShadeMode } from '../types';

/** One swatch row: [css colour, label, swatch size css]. */
type LegendRow = [string, string, string];

/** One lower-left colour-key panel: a title over swatch rows. A plain string among the items is a GROUP
 *  CAPTION — a hairline and a quiet heading over the rows that follow, for a key long enough that the rows
 *  need sorting into kinds. Starts hidden; `setShadeMode` reveals it per shade view. */
function buildLegendPanel(title: string, items: (LegendRow | string)[]): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'll-panel';
  el.style.display = 'none';
  el.innerHTML = `<div class="ll-title">${title}</div>` + items.map((item, index) => typeof item === 'string'
    ? `${index ? '<div class="ll-sep"></div>' : ''}<div class="ll-group">${item}</div>`
    : `<div class="ll-row"><span class="ll-swatch" style="background:${item[0]};${item[2]}"></span>${item[1]}</div>`)
    .join('');
  return el;
}

/**
 * The lower-left colour keys, mounted into `#lowerleft` (or the viewport container): the cage-colour key in the
 * cage-only / no-solid view, and the SurfaceType + prop-contact pair in the Surface view. `setShadeMode` picks
 * which as the terrain shade view changes; the two Surface keys show together, since that view states both.
 */
export function createLegends(container: HTMLElement) {
  const host = document.getElementById('lowerleft') ?? container;
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
  // cage line colours (cage-only view): thin line swatches, matching how the edges draw
  const cageRows: [string, string, string][] = ([
    [CAGE_INTERIOR_COLOR, 'Grid'],
    [CAGE_BOUNDARY_COLOR, 'Rim (outer edge)'],
    [CAGE_TEAR_COLOR, 'Tear (bright = exposed · dim = watertight)'],
    [CAGE_LOCKED_COLOR, 'Locked patch edge'],
    [FRAME_GLYPH_COLOR, 'Patch frame F (with the F overlay on)'],
  ] as [number, string][]).map(([c, label]) => [hex(c), label, 'width:16px;height:3px']);
  // extraordinary poles draw as dots (over the reference cage), so swatch them round, not as line strokes
  cageRows.push(
    [hex(CAGE_EXTRA3_COLOR), 'Pole · valence 3', 'width:8px;height:8px;border-radius:50%'],
    [hex(CAGE_EXTRA5_COLOR), 'Pole · valence 5', 'width:8px;height:8px;border-radius:50%'],
    [hex(CAGE_INTERIOR_COLOR), 'Edge loops (click a vertex in Edit)', 'width:16px;height:5px'],
    [hex(CAGE_POINT_COLOR), 'Loop ends + picked vertex (enlarged dots)', 'width:9px;height:9px;border-radius:50%'],
  );
  const cageLegend = buildLegendPanel('Cage colours', cageRows);
  // SurfaceType ride-feel tints (Surface view): square swatches, one per styled surface — not one per
  // PAINTABLE surface. The view colours reference terrain and rideable props too, and those wear families the
  // terrain palette does not offer (MEGAPLE's metal, its bounce barriers). A colour on screen with no row
  // here states nothing, so the key follows the style table.
  //
  // Grouped by WHERE each type can be authored, because that is the question a swatch raises once the key
  // covers everything: the terrain paint menu (`SURFACE_TYPES`) and a rideable prop's own list
  // (`SURFACE_AUTHOR_OPTIONS`) are different sets, overlapping in five families. What neither offers is
  // shipped-data vocabulary you can read but not assign. Types keep their number, which is what the prop
  // inspector's ride-surface row and the RE surface tables are keyed by.
  const propSurfaces = new Set(SURFACE_AUTHOR_OPTIONS.map(option => option.type));
  const paintable = (type: number) => SURFACE_TYPES[type] !== undefined;
  const styledTypes = Object.keys(SURFACE_STYLE).map(Number);
  // Through THREE.Color rather than straight to CSS: the style table's triples are working-space (linear)
  // values, which is how both the terrain's vertex-colour attribute and the prop clay's material colour read
  // them, and the renderer outputs them converted. A raw `rgb()` swatch is that colour UNCONVERTED — darker
  // than the surface it claims to key, by a lot once a family is saturated rather than pastel.
  const surfaceRow = (type: number): LegendRow => {
    const name = SURFACE_TYPES[type] ?? REFERENCE_SURFACE_TYPES[type]?.label ?? 'unknown';
    return [`#${new THREE.Color(...surfaceStyle(type).color).getHexString()}`,
      `${type} ${name}`, 'width:12px;height:12px'];
  };
  const surfaceGroup = (caption: string, keep: (type: number) => boolean): (LegendRow | string)[] => {
    const rows = styledTypes.filter(keep).map(surfaceRow);
    return rows.length ? [caption, ...rows] : [];
  };
  const surfaceLegend = buildLegendPanel('Surface types', [
    ...surfaceGroup('Terrain + props', type => paintable(type) && propSurfaces.has(type)),
    ...surfaceGroup('Terrain only', type => paintable(type) && !propSurfaces.has(type)),
    ...surfaceGroup('Props only', type => !paintable(type) && propSurfaces.has(type)),
    ...surfaceGroup('Reference only', type => !paintable(type) && !propSurfaces.has(type)),
  ]);
  // Prop CONTACT classes, the prop-side twin of the ride-feel key above and its own panel because it keys a
  // different kind of object: these ride the collision profile — authored on a placement, compiled from the
  // shipped facts on a reference instance — rather than a painted tile. The dark row sits here rather than
  // up there because it states a prop's own lighting, the thing terrain gets from the lightmap instead.
  const mixed = (base: number) => `rgb(${BACKFACE_TINT_RGB.map((c, i) =>
    Math.round(255 * (((base >> (16 - i * 8)) & 0xff) / 255 * (1 - PROP_DARK_TINT_MIX)
      + c * PROP_DARK_TINT_MIX))).join(',')})`;
  const propRows: [string, string, string][] = [
    [hex(PROP_SOLID_COLOR), 'Solid — obstacle (no ride surface)', 'width:12px;height:12px'],
    // A rideable solid wears its SurfaceType's own colour from the key above, so this row shows the default
    // rather than repeating all eleven swatches a second time.
    [hex(propContactTint('solid', DEFAULT_SURFACE)), 'Solid — rideable · wears its ride-feel colour above',
      'width:12px;height:12px'],
    [hex(PROP_THROUGH_COLOR), 'Ride-through — no response, effects and sounds fire', 'width:12px;height:12px'],
    [hex(PROP_CLAY_COLOR), 'Decorative — no contact', 'width:12px;height:12px'],
    // Swatched as the MIX the clay actually renders at full darkness, not the raw hue, so the row matches
    // what is on screen. The tint fades in with the face's key light, so shallower shades of it mean dimmer.
    [mixed(PROP_CLAY_COLOR), 'Ships dark — its normal is turned off the sun', 'width:12px;height:12px'],
  ];
  const propLegend = buildLegendPanel('Prop types', propRows);
  host.prepend(propLegend);    // stacks under Surface types, which prepends after it
  host.prepend(surfaceLegend); // order between cage and surface is irrelevant — never both shown
  host.prepend(cageLegend);    // all three land left of #cmdsheet (the controls list)

  /** Show the colour keys that ride this shade view: cage-only (none), or the SurfaceType + prop pair. */
  function setShadeMode(m: ShadeMode) {
    cageLegend.style.display = m === 'none' ? 'block' : 'none';
    surfaceLegend.style.display = m === 'surface' ? 'block' : 'none';
    propLegend.style.display = m === 'surface' ? 'block' : 'none';
  }

  return { setShadeMode };
}

export type Legends = ReturnType<typeof createLegends>;
