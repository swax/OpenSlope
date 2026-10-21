import type { V3 } from '../doc/types';
import type { PropInstance } from '../reference/props';
import { applyQuat } from '../props/pose';

/** [Trailmap: 160-instance, 160-instance-frame, 400-lighting]. World-space,
 * display-domain lighting for a dynamic body. Spatial interpolation is our
 * approximation, like Unity's avatar probes; the source records stay intact. */
export interface RiderLight {
  ambient: V3;
  keys: { color: V3; direction: V3 }[];
}
export interface RiderLightProbe extends RiderLight {
  position: V3;
}

export function evaluateRiderLight(light: RiderLight, normal: V3): V3 {
  const length = Math.hypot(...normal) || 1;
  const result = [...light.ambient] as V3;
  for (const key of light.keys) {
    const facing = Math.max(0, normal.reduce((sum, v, i) => sum + v * key.direction[i], 0) / length);
    for (let c = 0; c < 3; c++) result[c] += key.color[c] * facing;
  }
  return result.map(value => Math.min(1, Math.max(0, value))) as V3;
}

/** Metres in the reference's editor frame. Its live root supplies placement and chirality. */
export function referenceRiderProbes(instances: readonly PropInstance[]): RiderLightProbe[] {
  const seen = new Set<string>();
  const probes: RiderLightProbe[] = [];
  for (const instance of instances) {
    const light = instance.lighting;
    if (!light) continue;
    const ambient = light.ambient.map(value => value / 256) as V3;
    const keys = light.keys.flatMap(key => {
      const local = key.direction.map((v, i) => v * Math.sign(instance.scale[i] || 1)) as V3;
      const raw = applyQuat(local, instance.rot);
      const magnitude = Math.hypot(...raw);
      if (magnitude < 1e-6 || Math.hypot(...key.color) < 1e-6) return [];
      return [
        {
          color: key.color.map(value => value / 256) as V3,
          direction: [-raw[0] / magnitude, raw[2] / magnitude, -raw[1] / magnitude] as V3,
        },
      ];
    });
    // Self-lit signs/bulbs describe their material, not environmental light.
    if (!keys.length && ambient.every(value => value >= 1)) continue;
    const position: V3 = [-instance.loc[0] / 100, instance.loc[2] / 100, -instance.loc[1] / 100];
    const cell = position.map(v => Math.sign(v) * Math.floor(Math.abs(v) + 0.5)).join(',');
    if (seen.has(cell)) continue;
    seen.add(cell);
    probes.push({ position, ambient, keys });
  }
  return probes;
}

interface Node {
  probe: RiderLightProbe;
  axis: number;
  left: Node | null;
  right: Node | null;
}
export class RiderLightField {
  private readonly root: Node | null;
  constructor(probes: readonly RiderLightProbe[]) {
    const build = (items: RiderLightProbe[], axis: number): Node | null => {
      if (!items.length) return null;
      items.sort((a, b) => a.position[axis] - b.position[axis]);
      const mid = items.length >> 1;
      return {
        probe: items[mid],
        axis,
        left: build(items.slice(0, mid), (axis + 1) % 3),
        right: build(items.slice(mid + 1), (axis + 1) % 3),
      };
    };
    this.root = build([...probes], 0);
  }
  sample(position: V3): RiderLight | null {
    if (!this.root || !position.every(Number.isFinite)) return null;
    const nearest: { distance: number; probe: RiderLightProbe }[] = [];
    const visit = (node: Node | null) => {
      if (!node) return;
      const distance = node.probe.position.reduce((sum, v, i) => sum + (v - position[i]) ** 2, 0);
      nearest.push({ distance, probe: node.probe });
      nearest.sort((a, b) => a.distance - b.distance);
      if (nearest.length > 4) nearest.pop();
      const split = position[node.axis] - node.probe.position[node.axis];
      visit(split < 0 ? node.left : node.right);
      if (nearest.length < 4 || split * split <= nearest[nearest.length - 1].distance)
        visit(split < 0 ? node.right : node.left);
    };
    visit(this.root);
    const total = nearest.reduce((sum, item) => sum + 1 / (1 + item.distance), 0);
    const result: RiderLight = { ambient: [0, 0, 0], keys: [] };
    for (const { distance, probe } of nearest) {
      const weight = 1 / ((1 + distance) * total);
      for (let c = 0; c < 3; c++) result.ambient[c] += probe.ambient[c] * weight;
      for (const key of probe.keys)
        result.keys.push({ direction: key.direction, color: key.color.map(v => v * weight) as V3 });
    }
    return result;
  }
}
