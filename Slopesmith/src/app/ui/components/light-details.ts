import type GUI from 'lil-gui';
import type { AuthoredLight } from '../../../core/doc/types';
import type { RigLight } from '../../../core/reference/lights';
import { glints, glintSizeClass } from '../../../core/lighting/glints';
import { detail, liveDetail, tip } from './gui';

const fixed = (value: number, places = 2): string => {
  if (!Number.isFinite(value)) return 'unknown';
  const out = value.toFixed(places);
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out;
};

const vector = (values: readonly number[], places = 2): string =>
  values.map(value => fixed(value, places)).join(', ');

const parseVector = (value: string): [number, number, number] | null => {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : null;
};

const unit = (values: readonly number[]): [number, number, number] => {
  const length = Math.hypot(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0) || 1;
  return [(values[0] ?? 0) / length, (values[1] ?? 0) / length, (values[2] ?? 0) / length];
};

function colourReadout(target: GUI, hex: string) {
  const colour = tip(detail(target, hex, 'colour'),
    'Normalized display hue; brightness is listed separately because retail channels commonly exceed 1.');
  const swatch = document.createElement('span');
  swatch.className = 'sp-colour-swatch';
  swatch.style.backgroundColor = hex;
  swatch.setAttribute('role', 'img');
  swatch.setAttribute('aria-label', `Colour ${hex}`);
  colour.domElement.querySelector<HTMLElement>('.lil-widget')?.prepend(swatch);
}

/** Populate the read-only reference-light inspector using the same common field order/units as an authored
 *  mountain light. Native-only category/cosine facts follow the common block. */
export function addReferenceLightDetails(target: GUI, level: string, light: RigLight, mountainName = 'Mountain') {
  tip(detail(target, light.name || '(unnamed light)', 'name'),
    'The native record name — retail names often reveal the fixture role (SignLight, Tunnel, Shadow).');
  tip(detail(target, level, 'source'),
    `This is a read-only light recovered from ${level}, not an editable light in ${mountainName}.`);
  tip(detail(target, light.kind, 'type'),
    'Spot has a cone, point radiates everywhere, sun is directional; ambient records have no source marker.');
  tip(detail(target, light.negative ? 'subtractive — removes light' : 'additive — casts light', 'effect'),
    'All-negative native colours are subtractive shadow lights used to pool darkness; ordinary positive lights add illumination.');
  colourReadout(target, light.colorHex);
  tip(detail(target, fixed(light.intensity, 3), 'brightness'),
    'Peak absolute native HDR colour channel. Values above 1 are intentionally brighter than display white.');
  tip(detail(target, vector(light.pos), 'position (m)'),
    'Source position in editor metres (the same transform as the reference terrain and props).');
  if (light.kind !== 'point')
    tip(detail(target, vector(light.dir, 3), 'direction'),
      'Normalized propagation direction in editor space. The expanded viewport rig follows this vector.');
  if (light.kind === 'spot') {
    const halfAngle = Math.acos(Math.max(-1, Math.min(1, light.coneCos))) * 180 / Math.PI;
    tip(detail(target, fixed(halfAngle, 2), 'cone half-angle (°)'),
      `Recovered spot-cone half-angle, shown in the same units used to edit ${mountainName} spotlights.`);
  }
  tip(detail(target, fixed(light.reach), 'reach (m)'),
    'Distance from the source to the farthest corner of its native influence box. The viewport clamps very large rigs only for display.');
  const spriteRes = light.spriteRes ?? 0;
  tip(detail(target, glints(spriteRes) ? `${spriteRes} — draws a glint` : `${spriteRes} — no glint`, 'glow sprite res'),
    'The native SpriteRes field — only the small classes (16, 32, 64) draw a glint.',
    'The engine draws its runtime glint — the halo, core and twinkle star on a lamp or flare — only for '
    + 'those resolution classes; 0 and the large classes never sparkle.');
  tip(detail(target, light.category, 'native category'),
    'Semantic category inferred from the native name and type for studying the retail rig.');
  if (light.kind === 'spot')
    tip(detail(target, fixed(light.coneCos, 4), 'native cone cosine'),
      'The exact value stored by Lights.json; the common cone row above converts it to an editable-style half-angle.');
}

/** Populate an editable mountain light inspector with the same common field order/units as the reference
 *  inspector. Position remains gizmo-driven but is a live matching readout; the authored light properties are
 *  otherwise editable in place. */
export function addAuthoredLightDetails(target: GUI, light: AuthoredLight, index: number,
  mountainName: string, scheduleRebuild: () => void, rebuildTools: () => void) {
  const fallbackName = `Light ${index + 1}`;
  const nameState = { value: light.name ?? fallbackName };
  const nameController: ReturnType<GUI['add']> = tip(target.add(nameState, 'value').name('name').onFinishChange((value: string) => {
    const next = value.trim();
    if (!next || next === fallbackName) delete light.name; else light.name = next;
    nameState.value = light.name ?? fallbackName;
    nameController.updateDisplay();
    scheduleRebuild();
  }), 'Optional name used by the source marker and exported light record. Clearing it restores the automatic numbered name.');
  tip(detail(target, mountainName, 'source'),
    `This is an editable free light stored with ${mountainName}.`);
  tip(target.add(light, 'kind', { point: 'point', spot: 'spot' }).name('type').onChange(() => {
    if (light.kind === 'spot') { light.dir ??= [0, -1, 0]; light.cone ??= 35; }
    scheduleRebuild();
    rebuildTools();
  }), 'Point radiates in every direction; spot casts a cone along its direction.');
  tip(detail(target, 'additive — casts light', 'effect'),
    `${mountainName} lights add illumination. Subtractive shadow lights are currently reference-only.`);
  tip(target.addColor(light, 'color').name('colour').onChange(scheduleRebuild),
    'The light hue.');
  tip(target.add(light, 'intensity', 0, 6, 0.1).name('brightness').onChange(scheduleRebuild),
    'Peak HDR strength. Values above 1 are intentionally brighter than display white.');
  tip(liveDetail(target, () => vector(light.pos), 'position (m)'),
    'Live source position in editor metres. Drag the selected bulb’s move gizmo in the viewport to edit it.');
  if (light.kind === 'spot') {
    const directionState = { value: vector(unit(light.dir ?? [0, -1, 0]), 3) };
    const directionController: ReturnType<GUI['add']> = tip(target.add(directionState, 'value').name('direction').onFinishChange((value: string) => {
      const parsed = parseVector(value);
      if (parsed && Math.hypot(...parsed) > 1e-6) light.dir = unit(parsed);
      directionState.value = vector(unit(light.dir ?? [0, -1, 0]), 3);
      directionController.updateDisplay();
      scheduleRebuild();
    }), 'Editable normalized spotlight direction as x, y, z. Separate values with commas or spaces; invalid and zero-length vectors revert to the current direction.');
    light.cone ??= 35;
    tip(target.add(light, 'cone', 5, 80, 1).name('cone half-angle (°)').onChange(scheduleRebuild),
      'Half-angle of the spotlight cone, in the same units shown for a reference spotlight.');
  }
  tip(target.add(light, 'reach', 5, 150, 1).name('reach (m)').onChange(scheduleRebuild),
    'How far the light carries before it fades out.');
  // The runtime GLINT (docs/047): a size class here is the engine's own gate, written straight to the exported
  // record's SpriteRes — so the sparkle the viewport draws is the sparkle the game, Snowknife and Unity draw.
  const glintState = { value: glintSizeClass(light.glint) };
  tip(target.add(glintState, 'value', { off: 0, 'small (16)': 16, 'medium (32)': 32, 'large (64)': 64 })
    .name('glint').onChange((value: number) => {
      const size = glintSizeClass(Number(value));
      if (size) light.glint = size; else delete light.glint;
      scheduleRebuild();
    }),
    'Draw the game’s runtime sparkle on this light; the class sets its size.',
    'The halo ring, bright core and twinkling spike star a street lamp or course flare carries — a medium '
    + 'sparkle is about 1.5 m across at its own distance. Every glint draws at the same brightness whatever '
    + 'the light’s, so only hue and size vary. Exported as the light record’s SpriteRes, the engine’s own gate.');
}
