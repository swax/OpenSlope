import { tip } from '../components/gui';
import { segmented, type SegOption } from '../components/controls';
import { svg } from '../components/icons';
import type { BrushDir, BrushFalloff, BrushOp, FlattenMode, FlattenPlaneBehavior } from '../../../core/doc/mountain';
import type { ToolsContext } from './widgets';

const SCULPT_ICON = {
  falloffSmooth: svg('<path d="M3 19c4.5 0 5.1-13 9-13s4.5 13 9 13"/><path d="M3 19h18" opacity=".35"/>'),
  falloffLinear: svg('<path d="m3 19 9-13 9 13"/><path d="M3 19h18" opacity=".35"/>'),
  falloffSharp: svg('<path d="M3 19c6 0 6.5-13 9-13s3 13 9 13"/><path d="M3 19h18" opacity=".35"/>'),
  falloffConstant: svg('<path d="M3 19V6h18v13"/><path d="M3 19h18" opacity=".35"/>'),
  vertical: svg('<path d="M12 21V4M7 9l5-5 5 5"/><path d="M4 21h16" opacity=".45"/>'),
  normal: svg('<path d="m3 18 18-7"/><path d="m10 15-3-7M4 11l3-3 4 1"/>'),
  height: svg('<path d="M3 16h18M5 12h14"/><path d="M12 4v6M9 7l3 3 3-3"/>'),
  surface: svg('<path d="m3 18 18-8M5 14l14-6"/><path d="m12 11-2-5M7 8l3-2 2 2"/>'),
  area: svg('<path d="M3 17c3-6 5 2 8-4s5 2 10-5"/><path d="m4 14 16-7" stroke-dasharray="2 2"/><circle cx="6" cy="12" r="1"/><circle cx="12" cy="11" r="1"/><circle cx="18" cy="8" r="1"/>'),
  locked: svg('<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  follow: svg('<path d="M4 17c4-8 8 4 16-8"/><path d="m16 8 4 1-1 4"/><circle cx="4" cy="17" r="2"/>'),
};

function iconChoice<T extends string>(
  host: { $children: HTMLElement }, label: string, options: SegOption<T>[], get: () => T, set: (value: T) => void,
) {
  const row = document.createElement('div');
  row.className = 'sp-sculpt-choice';
  const caption = document.createElement('span');
  caption.textContent = label;
  const control = segmented(options, get, set);
  control.el.setAttribute('role', 'group');
  control.el.setAttribute('aria-label', label);
  row.append(caption, control.el);
  host.$children.appendChild(row);
}

/**
 * The Sculpt-mode toolbox: the brush op / push-direction / size / strength controls, bound to the shared
 * mutable brush config the host's arm / apply code reads. The size slider drives the viewport's green
 * brush ring live.
 */
export function buildSculptTools(ctx: ToolsContext) {
  const { gui, brush, viewport, rebuildTools } = ctx;
  const operations = document.createElement('div');
  operations.className = 'sp-gui-custom sp-sculpt-ops';
  operations.setAttribute('role', 'group');
  operations.setAttribute('aria-label', 'Sculpt operation');
  const heading = document.createElement('div'); heading.className = 'sp-sculpt-ops-title'; heading.textContent = 'Operation';
  operations.appendChild(heading);
  const family = (name: string, options: { value: BrushOp; label: string; title: string }[]) => {
    const row = document.createElement('div'); row.className = 'sp-sculpt-op-family';
    const caption = document.createElement('span'); caption.textContent = name;
    const control = segmented<BrushOp>(options, () => brush.op, op => { brush.op = op; rebuildTools(); });
    control.el.setAttribute('role', 'group');
    control.el.setAttribute('aria-label', `${name} sculpt operations`);
    row.append(caption, control.el); operations.appendChild(row);
  };
  family('Displace', [
    { value: 'raise', label: 'Raise', title: 'Raise terrain vertically or along its surface normal.' },
    { value: 'lower', label: 'Lower', title: 'Lower terrain vertically or along its surface normal.' },
  ]);
  family('Refine', [
    { value: 'smooth', label: 'Smooth', title: 'Relax the broad corner shape and authored Bezier detail.' },
    { value: 'flatten', label: 'Flatten', title: 'Move complete Bezier cages toward a chosen plane.' },
  ]);
  family('Move', [
    { value: 'grab', label: 'Grab', title: 'Drag one captured surface-space footprint in the view plane.' },
    { value: 'push', label: 'Push', title: 'Continuously shove newly encountered terrain along the surface.' },
  ]);
  gui.$children.appendChild(operations);

  const common = gui.addFolder('Brush');
  common.open();
  tip(common.add(brush, 'radius', 10, 250, 5).name('size (m)'),
    'Radius along the connected control surface. The green ring aligns to the surface under the pointer.')
    .onChange((r: number) => (viewport.brushRadius = r));
  iconChoice<BrushFalloff>(common, 'Falloff', [
    { value: 'smooth', label: 'Smooth falloff', icon: SCULPT_ICON.falloffSmooth, title: 'Smooth — a rounded bell that eases softly to zero at the brush edge.' },
    { value: 'linear', label: 'Linear falloff', icon: SCULPT_ICON.falloffLinear, title: 'Linear — strength fades evenly from the centre to the brush edge.' },
    { value: 'sharp', label: 'Sharp falloff', icon: SCULPT_ICON.falloffSharp, title: 'Sharp — concentrates the effect near the centre with a quick fade.' },
    { value: 'constant', label: 'Constant falloff', icon: SCULPT_ICON.falloffConstant, title: 'Constant — full strength across the footprint with a hard edge.' },
  ], () => brush.falloff, value => { brush.falloff = value; });

  if (brush.op === 'raise' || brush.op === 'lower') {
    const options = gui.addFolder('Tool options'); options.open();
    iconChoice<BrushDir>(options, 'Direction', [
      { value: 'vertical', label: 'Vertical direction', icon: SCULPT_ICON.vertical, title: 'Vertical — raise or lower straight along world height.' },
      { value: 'normal', label: 'Surface-normal direction', icon: SCULPT_ICON.normal, title: 'Surface normal — push out of the slope face to build walls and overhangs.' },
    ], () => brush.dir, value => { brush.dir = value; });
    tip(options.add(brush, 'strength', 0.1, 6, 0.1).name('step (m)'), 'How far each dab moves the terrain.');
  } else if (brush.op === 'smooth') {
    const options = gui.addFolder('Tool options'); options.open();
    tip(options.add(brush, 'smoothAmount', 5, 100, 5).name('amount (%)'),
      'How strongly each dab relaxes corners, boundary handles, and interior detail.');
  } else if (brush.op === 'flatten') {
    const options = gui.addFolder('Tool options'); options.open();
    iconChoice<FlattenMode>(options, 'Plane', [
      { value: 'height', label: 'World-height plane', icon: SCULPT_ICON.height, title: 'Height — flatten to a horizontal world-Y plane through the sampled point.' },
      { value: 'surface', label: 'Surface-tangent plane', icon: SCULPT_ICON.surface, title: 'Surface — flatten to the tangent plane at the sampled point.' },
      { value: 'area', label: 'Area-average plane', icon: SCULPT_ICON.area, title: 'Area — estimate a falloff-weighted plane across the whole brush footprint.' },
    ], () => brush.flattenMode, value => { brush.flattenMode = value; });
    iconChoice<FlattenPlaneBehavior>(options, 'Sampling', [
      { value: 'locked', label: 'Locked plane', icon: SCULPT_ICON.locked, title: 'Locked — keep the plane sampled on press while the stroke crosses other surfaces.' },
      { value: 'follow', label: 'Follow-stroke plane', icon: SCULPT_ICON.follow, title: 'Follow — resample the flatten plane beneath every dab.' },
    ], () => brush.flattenPlaneBehavior, value => { brush.flattenPlaneBehavior = value; });
    tip(options.add(brush, 'flattenAmount', 5, 100, 5).name('amount (%)'),
      'How far every affected Bezier control moves toward the target plane per dab.');
  } else if (brush.op === 'push') {
    const options = gui.addFolder('Tool options'); options.open();
    tip(options.add(brush, 'pushAmount', 5, 100, 5).name('amount (%)'),
      'How much of each surface-tangent pointer movement is transferred into the terrain.');
  }
}
