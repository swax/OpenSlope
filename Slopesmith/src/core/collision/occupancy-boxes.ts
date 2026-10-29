/** Inclusive lattice bounds, in the exhaustive search's tie-breaking order. */
export type OccupancyBox = [x0: number, x1: number, y0: number, y1: number, z0: number, z1: number];

/** Greedily cover occupied cells with solid boxes. Overlap is allowed, but empty cells are never filled. */
export function greedyOccupancyBoxes(
  gridN: number,
  cells: ReadonlySet<number>,
  cap = 16,
  minNewCells = 3,
): OccupancyBox[] {
  const boxes: OccupancyBox[] = [];
  if (!cells.size) return boxes;
  const covered = new Set<number>();
  const keyOf = (x: number, y: number, z: number) => (x * gridN + y) * gridN + z;
  const coordinates = [new Set<number>(), new Set<number>(), new Set<number>()];
  for (const key of cells) {
    coordinates[0].add(Math.floor(key / (gridN * gridN)));
    coordinates[1].add(Math.floor(key / gridN) % gridN);
    coordinates[2].add(key % gridN);
  }
  const [xs, ys, zs] = coordinates.map(values => [...values].sort((a, b) => a - b));
  const pn = gridN + 1;
  const at = (x: number, y: number, z: number) => (x * pn + y) * pn + z;
  const summedVolume = (source: ReadonlySet<number>) => {
    const prefix = new Uint32Array(pn * pn * pn);
    for (let x = 1; x < pn; x++)
      for (let y = 1; y < pn; y++)
        for (let z = 1; z < pn; z++) {
          const occupied = source.has(keyOf(x - 1, y - 1, z - 1)) ? 1 : 0;
          prefix[at(x, y, z)] =
            occupied +
            prefix[at(x - 1, y, z)] +
            prefix[at(x, y - 1, z)] +
            prefix[at(x, y, z - 1)] -
            prefix[at(x - 1, y - 1, z)] -
            prefix[at(x - 1, y, z - 1)] -
            prefix[at(x, y - 1, z - 1)] +
            prefix[at(x - 1, y - 1, z - 1)];
        }
    return prefix;
  };
  const count = (prefix: Uint32Array, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    x1++;
    y1++;
    z1++;
    return (
      prefix[at(x1, y1, z1)] -
      prefix[at(x0, y1, z1)] -
      prefix[at(x1, y0, z1)] -
      prefix[at(x1, y1, z0)] +
      prefix[at(x0, y0, z1)] +
      prefix[at(x0, y1, z0)] +
      prefix[at(x1, y0, z0)] -
      prefix[at(x0, y0, z0)]
    );
  };
  const cellsPrefix = summedVolume(cells);

  // For fixed X/Y bounds, a solid box is a subinterval of a fully occupied Z run. Extending to the whole
  // run cannot reduce its uncovered-cell score, so only these runs need scoring. Build them once instead
  // of enumerating all six bounds again for every selected box (the former cold-load bottleneck).
  const runs: Array<{ box: OccupancyBox; area: number; volume: number }> = [];
  for (const x0 of xs)
    for (const x1 of xs) {
      if (x1 < x0) continue;
      for (const y0 of ys)
        for (const y1 of ys) {
          if (y1 < y0) continue;
          const area = (x1 - x0 + 1) * (y1 - y0 + 1);
          let start = -1;
          const endRun = (end: number) => {
            const volume = area * (end - start + 1);
            if (start >= 0 && volume >= minNewCells) runs.push({ box: [x0, x1, y0, y1, start, end], area, volume });
            start = -1;
          };
          // Include absent Z coordinates: a gap must split two occupied runs.
          for (let z = zs[0]; z <= zs[zs.length - 1]; z++) {
            if (count(cellsPrefix, x0, x1, y0, y1, z, z) === area) {
              if (start < 0) start = z;
            } else if (start >= 0) endRun(z - 1);
          }
          if (start >= 0) endRun(zs[zs.length - 1]);
        }
    }

  while (boxes.length < cap) {
    let bestNew = minNewCells - 1;
    let best: OccupancyBox | null = null;
    const coveredPrefix = summedVolume(covered);
    for (const { box, area, volume } of runs) {
      if (volume <= bestNew) continue;
      const [x0, x1, y0, y1, z0, z1] = box;
      const fresh = volume - count(coveredPrefix, x0, x1, y0, y1, z0, z1);
      if (fresh <= bestNew) continue;
      // The exhaustive search chose the earliest endpoint on equal scores. Discard fully covered trailing
      // slabs to retain that exact tie-break; the run's start is already the earliest possible start.
      let end = z1;
      while (end > z0 && count(coveredPrefix, x0, x1, y0, y1, end, end) === area) end--;
      bestNew = fresh;
      best = [x0, x1, y0, y1, z0, end];
    }
    if (!best) break;
    boxes.push(best);
    const [x0, x1, y0, y1, z0, z1] = best;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) covered.add(keyOf(x, y, z));
  }
  return boxes;
}
