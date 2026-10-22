import { joinMapPath as join, type MapDataSource } from './map-data';

type SourceCone = { type: number; pos: number[]; cone: number };

/** [Trailmap: 220-light-cone, 500-light-cone] Read only source light metadata.
 * Older shared exports omitted this field; the retained files avoid a re-export. */
export async function retainedLightCones(io: MapDataSource, level: string): Promise<SourceCone[]> {
  try {
    const folder = join(io.root, level, 'Source');
    const names = await io.listDir(folder);
    const pbd = names.find(name => /\.pbd$/i.test(name) && !/_sky\.pbd$/i.test(name));
    const index = names.find(name => /\.wdx$/i.test(name));
    const world = index && names.find(name => name.toLowerCase() === index.replace(/\.wdx$/i, '.wdf').toLowerCase());
    const view = (bytes: Uint8Array | null) => {
      if (!bytes || bytes.length > 512 * 1024 * 1024) throw new Error('Invalid light source');
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    const rows: SourceCone[] = [];
    const append = (data: DataView, start: number, count: number, stride: number, shift: number) => {
      if (!count) return;
      if (
        count > 100000 - rows.length ||
        start < 0 ||
        start + Math.max(0, count - 1) * stride + (count ? 76 + shift : 0) > data.byteLength
      )
        throw new Error('Invalid source light table');
      for (let i = 0; i < count; ++i) {
        const p = start + i * stride;
        const type = data.getUint32(p, true);
        const pos = [0, 4, 8].map(offset => data.getFloat32(p + 36 + shift + offset, true));
        const cone = type === 1 ? data.getFloat32(p + 72 + shift, true) : 1;
        if (!pos.every(Number.isFinite) || !Number.isFinite(cone) || cone < -1 || cone > 1)
          throw new Error('Invalid source light cone');
        rows.push({ type, pos, cone });
      }
    };
    if (pbd) {
      const data = view(await io.readBytesOrNull(join(folder, pbd)));
      append(data, data.getUint32(88, true), data.getUint32(28, true), 92, 4);
    } else if (index && world) {
      const data = view(await io.readBytesOrNull(join(folder, index)));
      const geometry = view(await io.readBytesOrNull(join(folder, world)));
      const count = data.getUint32(40, true) * data.getUint32(44, true);
      const table = 72 + data.getUint32(48, true) * 8;
      if (!count || count > 65535 || table + count * 8 > data.byteLength) throw new Error('Invalid source world grid');
      for (let i = 0; i < count; ++i) {
        const start = data.getUint32(table + i * 8, true),
          size = data.getUint32(table + i * 8 + 4, true);
        if (!size) continue;
        if (start + size > geometry.byteLength || size < 816) throw new Error('Invalid source world cell');
        const cell = new DataView(geometry.buffer, geometry.byteOffset + start, size);
        const lights = cell.getUint16(40, true);
        const at =
          Math.ceil((816 + cell.getUint16(44, true) * 4) / 16) * 16 +
          cell.getUint16(36, true) * 272 +
          cell.getUint16(38, true) * 448 +
          cell.getUint16(42, true) * 128;
        append(cell, at, lights, 88, 0);
      }
    }
    return rows;
  } catch {
    return []; // Optional missing/damaged sources must not hide a usable JSON rig.
  }
}
