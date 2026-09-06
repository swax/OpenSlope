/** Shared imported-prop measurements and placement-frame helpers for authored courses. */
import type { V3 } from '../../src/core/doc/types';
import type { ImportedPropRecord } from '../../src/core/props/imported';

export const unit = (direction: [number, number]): [number, number] => {
  const length = Math.hypot(direction[0], direction[1]);
  return length < 1e-9 ? [0, 0] : [direction[0] / length, direction[1] / length];
};

/** An imported model measured in the editor-space frame used by placements. */
export interface Measured {
  id: number;
  name: string;
  tris: number;
  /** Lowest vertex above the model origin. */
  base: number;
  size: { x: number; y: number; z: number };
  /** Horizontal direction of greatest extent. */
  long: [number, number];
  /** Horizontal direction of least extent. */
  thin: [number, number];
  /** Horizontal direction in which the model surface rises. */
  rise: [number, number];
  /** Model-local vertices in editor metres. */
  pts: [number, number, number][];
}

const editorFromRaw = (x: number, y: number, z: number): V3 => [-x / 100, z / 100, -y / 100];

/** Decode a copied float buffer because base64 bytes are not guaranteed to be four-byte aligned. */
function unpackFloats(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  const out = new Float32Array(bytes.byteLength / 4);
  Buffer.from(out.buffer).set(bytes);
  return out;
}

function measureVertices(
  identity: Pick<Measured, 'id' | 'name' | 'tris'>,
  vertices: V3[],
): Measured {
  if (!vertices.length) throw new Error(`Imported prop "${identity.name}" has no vertices to measure`);
  const axis = (component: number) => {
    let lo = Infinity, hi = -Infinity;
    for (const vertex of vertices) {
      lo = Math.min(lo, vertex[component]);
      hi = Math.max(hi, vertex[component]);
    }
    return { lo, hi, span: hi - lo };
  };
  const [x, y, z] = [axis(0), axis(1), axis(2)];

  // Means over each height half cancel the along-edge component that min/max vertices would retain.
  const byHeight = [...vertices].sort((a, b) => a[1] - b[1]);
  const half = Math.max(1, Math.floor(byHeight.length / 2));
  const mean = (list: V3[]): [number, number] => [
    list.reduce((total, vertex) => total + vertex[0], 0) / list.length,
    list.reduce((total, vertex) => total + vertex[2], 0) / list.length,
  ];
  const low = mean(byHeight.slice(0, half));
  const high = mean(byHeight.slice(-half));
  const rise = unit([high[0] - low[0], high[1] - low[1]]);

  // Sweep horizontal directions instead of using an axis-aligned box, which overstates diagonal props.
  let long: [number, number] = [1, 0], thin: [number, number] = [0, 1];
  let widest = -Infinity, narrowest = Infinity;
  for (let angle = 0; angle < 180; angle += 5) {
    const direction: [number, number] = [
      Math.cos((angle * Math.PI) / 180),
      Math.sin((angle * Math.PI) / 180),
    ];
    let lo = Infinity, hi = -Infinity;
    for (const vertex of vertices) {
      const projected = vertex[0] * direction[0] + vertex[2] * direction[1];
      lo = Math.min(lo, projected);
      hi = Math.max(hi, projected);
    }
    if (hi - lo > widest) { widest = hi - lo; long = direction; }
    if (hi - lo < narrowest) { narrowest = hi - lo; thin = direction; }
  }

  return {
    ...identity,
    base: y.lo,
    size: { x: x.span, y: y.span, z: z.span },
    rise: rise[0] === 0 && rise[1] === 0 ? long : rise,
    long,
    thin,
    pts: vertices.map(vertex => [vertex[0], vertex[1], vertex[2]]),
  };
}

export function measure(record: ImportedPropRecord): Measured {
  const vertices: V3[] = [];
  for (const sub of record.subs) {
    const positions = unpackFloats(sub.pos);
    for (let index = 0; index + 2 < positions.length; index += 3) {
      vertices.push(editorFromRaw(positions[index], positions[index + 1], positions[index + 2]));
    }
  }
  return measureVertices({ id: record.id, name: record.name, tris: record.tris }, vertices);
}

/** Structural subset of the headless GLB draft, kept here to avoid coupling measurement to texture staging. */
export interface MeasurablePropDraft {
  name: string;
  tris: number;
  subs: readonly { positions: Float32Array }[];
}

export function measurePropDraft(draft: MeasurablePropDraft, id = 0): Measured {
  const vertices: V3[] = [];
  for (const sub of draft.subs) {
    for (let index = 0; index + 2 < sub.positions.length; index += 3) {
      vertices.push(editorFromRaw(
        sub.positions[index],
        sub.positions[index + 1],
        sub.positions[index + 2],
      ));
    }
  }
  return measureVertices({ id, name: draft.name, tris: draft.tris }, vertices);
}

/** Yaw in degrees that turns a model-local horizontal direction onto a world direction. */
export const yawFrom = (local: [number, number], world: [number, number]): number =>
  ((Math.atan2(world[0], world[1]) - Math.atan2(local[0], local[1])) * 180) / Math.PI;

/** Exact reach of a turned, scaled model along a world direction, measured from its origin. */
export function spanAlong(
  measured: Measured,
  yaw: number,
  world: [number, number],
  scale: number,
  belowLocalY = Infinity,
): { lo: number; hi: number } {
  const angle = (yaw * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let lo = Infinity, hi = -Infinity;
  for (const [x, y, z] of measured.pts) {
    if (y > belowLocalY) continue;
    const projected = (x * cos + z * sin) * world[0] + (-x * sin + z * cos) * world[1];
    lo = Math.min(lo, projected);
    hi = Math.max(hi, projected);
  }
  return lo === Infinity ? { lo: 0, hi: 0 } : { lo: lo * scale, hi: hi * scale };
}

export const extentAlong = (
  measured: Measured,
  yaw: number,
  world: [number, number],
  scale: number,
): number => {
  const { lo, hi } = spanAlong(measured, yaw, world, scale);
  return hi - lo;
};
