import type { V3 } from '../doc/types';

/** Minimal uniform 3D grid used by proximity diagnostics. Values may occupy a point or every cell of an AABB. */
export class SpatialHash3D<T> {
  private readonly bins = new Map<string, T[]>();

  constructor(readonly cellSize: number) {
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) throw new Error('SpatialHash3D needs a finite positive cell size.');
  }

  private cell(value: number): number { return Math.floor(value / this.cellSize); }
  private key(x: number, y: number, z: number): string { return `${x},${y},${z}`; }

  insertPoint(point: V3, value: T): void {
    const key = this.key(this.cell(point[0]), this.cell(point[1]), this.cell(point[2]));
    const list = this.bins.get(key);
    if (list) list.push(value); else this.bins.set(key, [value]);
  }

  queryPoint(point: V3): readonly T[] {
    return this.bins.get(this.key(this.cell(point[0]), this.cell(point[1]), this.cell(point[2]))) ?? [];
  }

  queryPointNeighborhood(point: V3, cellRadius = 1): T[] {
    const cx = this.cell(point[0]), cy = this.cell(point[1]), cz = this.cell(point[2]), out: T[] = [];
    for (let x = cx - cellRadius; x <= cx + cellRadius; x++)
      for (let y = cy - cellRadius; y <= cy + cellRadius; y++)
        for (let z = cz - cellRadius; z <= cz + cellRadius; z++)
          out.push(...(this.bins.get(this.key(x, y, z)) ?? []));
    return out;
  }

  /** Values in cells touched by bounds, or null when the bounds exceed the caller's safety limit. */
  queryBounds(min: V3, max: V3, maxCells = 4096): Set<T> | null {
    const lo = min.map(value => this.cell(value)) as V3, hi = max.map(value => this.cell(value)) as V3;
    const count = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (count > maxCells) return null;
    const out = new Set<T>();
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++)
          for (const value of this.bins.get(this.key(x, y, z)) ?? []) out.add(value);
    return out;
  }

  /** Insert into every touched bounds cell. Returns false instead of expanding an excessive AABB. */
  insertBounds(min: V3, max: V3, value: T, maxCells = 4096): boolean {
    const lo = min.map(component => this.cell(component)) as V3;
    const hi = max.map(component => this.cell(component)) as V3;
    const count = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (count > maxCells) return false;
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const key = this.key(x, y, z), list = this.bins.get(key);
      if (list) list.push(value); else this.bins.set(key, [value]);
    }
    return true;
  }
}
