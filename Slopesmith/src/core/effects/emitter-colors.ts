import type { JsonObject, JsonValue } from './document';

/** Renderer/interchange colour order. Native SSF order is confined to the two adapters below. */
export type RgbaColor = readonly [r: number, g: number, b: number, a: number];

const finite = (fields: Record<string, JsonValue>, key: string, fallback = 1): number => {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

/** Convert the native SSF A,R,G,B quartets at U33..U48 to semantic R,G,B,A tuples. */
export function emitterColorStopsFromNativeArgb(fields: Record<string, JsonValue>): RgbaColor[] {
  const stops: RgbaColor[] = [];
  for (let i = 33; i <= 48; i += 4) stops.push([
    finite(fields, `U${i + 1}`),
    finite(fields, `U${i + 2}`),
    finite(fields, `U${i + 3}`),
    finite(fields, `U${i}`),
  ]);
  return stops;
}

/** Convert semantic R,G,B,A tuples to the native SSF A,R,G,B fields used by lossless Effects.json payloads. */
export function nativeArgbFieldsFromRgbaColorStops(stops: readonly RgbaColor[]): JsonObject {
  const fields: JsonObject = {};
  for (let stop = 0; stop < 4; stop++) {
    const rgba = stops[stop] ?? ([1, 1, 1, 1] as const);
    const first = 33 + stop * 4;
    fields[`U${first}`] = rgba[3];
    fields[`U${first + 1}`] = rgba[0];
    fields[`U${first + 2}`] = rgba[1];
    fields[`U${first + 3}`] = rgba[2];
  }
  return fields;
}
