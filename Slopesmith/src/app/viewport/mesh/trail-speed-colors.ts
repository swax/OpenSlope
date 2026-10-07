import * as THREE from 'three';
import { TRAIL_SPEED_SCALE_MAX } from '../../ride/trail-speed';
import { TRAIL_SPEED_AIR_COLOR, TRAIL_SPEED_STOPS } from '../constants';

/** The ramp's stops and the air colour in the renderer's working (linear) space, which is how a vertex-colour
 *  attribute is read — so a swatch and the shade it keys match. */
const stops = TRAIL_SPEED_STOPS.map(([at, hex]) => ({ speed: at * TRAIL_SPEED_SCALE_MAX, color: new THREE.Color(hex) }));
const air = new THREE.Color(TRAIL_SPEED_AIR_COLOR);
const mixed = new THREE.Color();

/** The colour a predicted ride shades a selected trail patch (docs/023 · Predicted speed): blue in the air, else the
 *  speed's place on the ramp, standing red to green at the speed cap. */
export function trailSpeedColor(speed: number, airborne: boolean): THREE.Color {
  if (airborne) return air;
  const v = Number.isFinite(speed) ? speed : 0;
  const upper = stops.findIndex(stop => stop.speed >= v);
  if (upper <= 0) return upper === 0 ? stops[0].color : stops[stops.length - 1].color;
  const lo = stops[upper - 1], hi = stops[upper];
  return mixed.copy(lo.color).lerp(hi.color, (v - lo.speed) / (hi.speed - lo.speed));
}

/** The key's rows: each stop with the speed it stands for, and the air colour. */
export function trailSpeedKey(): { hex: string; speed: number | null }[] {
  return [
    ...stops.map(stop => ({ hex: `#${stop.color.getHexString()}`, speed: stop.speed })),
    { hex: `#${air.getHexString()}`, speed: null },
  ];
}
