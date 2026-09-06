# Retopology tools

The offline retopology workflow is kept together here:

- `benchmark.ts` prepares jobs, runs configured candidates, and scores their output.
- `reference-maps.ts` packages candidates as loadable reference maps.
- `integrate.ts` merges a selected candidate with protected authored terrain.
- `prescribe.ts` and `layout.ts` inspect and control QuadWild subdivision layouts.
- `runners.example.json` documents external solver command configuration.
- [`quadwild-patches`](quadwild-patches/README.md) carries the separately licensed solver patches.

When a job comes out wrong, three diagnostics replay a saved candidate directory stage by stage and print
what survived. They report rather than assert, and none is part of the gate:

```text
npx tsx tools/retopology/join-probe.ts <job-dir> <mountain.slope.json> [--skip-cut] [--skip-refine] [--conforming]
npx tsx tools/retopology/nudge-probe.ts <job-dir> <mountain.slope.json>
npx tsx tools/retopology/rim-match-probe.ts <mountain.slope.json>
```

`join-probe` replays cut → conform → refine → integrate and reports rim structure per stage (writing an XZ
SVG of any crossing faces to `$TEMP`); `nudge-probe` replays the leaning/seam nudge repair and dissects
whatever crossing survives; `rim-match-probe` answers why `lockedRimLoops` skipped a proxy hole.

Use the package commands for the main workflow:

```text
npm run benchmark:retopology -- prepare --input <mountain.slope.json> --out <directory>
npm run benchmark:retopology -- run --dir <directory> --config <runners.json>
npm run benchmark:retopology -- score --dir <directory> --candidate name=<mesh.obj>
npm run benchmark:retopology-maps -- --dir <directory>
npm run benchmark:retopology-integrate -- --dir <directory> --candidate <mesh.obj>
```

See [`docs/045-retopology-benchmark.md`](../../docs/045-retopology-benchmark.md) for the complete procedure.
