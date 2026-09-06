/**
 * RE canaries — authored props that answer a question about the PS2 engine's animation or render runtime.
 *
 * Each one is a controlled experiment: a shape whose pose or motion differs between competing
 * hypotheses in a way that is unmistakable on screen (or, better, in memory via
 * `Trailmap/tools/pine`). They exist because retail content cannot separate the hypotheses — every
 * shipped clip channels every non-zero rotation it authors, so the interesting cases never occur.
 *
 * They are deliberately written as HAND-BUILT clips rather than through `importedSpinAnimation`,
 * because the whole point is to author `PropModelAnimation` shapes no recipe can express: arbitrary
 * base poses, constant channels, several live channels on one object. That path is only open
 * because the export and the ISO packer carry a clip verbatim (docs/032).
 *
 * Geometry convention is the record's own: MODEL space, raw SSX centimetres, Z up. A sub-object's
 * vertices are stored at its REST pose, so an arm belonging to an object whose rest position is
 * (0, 0, 110) is written around z = 110.
 *
 *   npx tsx tools/re-canaries/make.ts            # write every canary into the Custom prop library
 *   npx tsx tools/re-canaries/make.ts euler-order
 *   npx tsx tools/re-canaries/make.ts object-count=13   # and size it, for the ladders (see SIZES)
 *
 * Place them in a level, export, repack, and read them per the table in README.md.
 */
import { listImportedProps, replaceImportedProp, saveImportedProp } from '../../src/server/routes/imported-props';
import { currentProject } from '../../src/server/projects';
import { migrateLegacyProjectAssets, withProjectAssets } from '../../src/server/project-assets';

const b64 = (v: ArrayBufferView) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');

interface Geom { p: number[]; u: number[]; i: number[] }

/** An axis-aligned box, centre + half-extents, in model-space raw cm. */
function box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): Geom {
  const p: number[] = [], u: number[] = [], i: number[] = [];
  const corner: [number, number, number][] = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  for (const face of [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]) {
    const base = p.length / 3;
    for (const k of face) p.push(cx + corner[k][0] * hx, cy + corner[k][1] * hy, cz + corner[k][2] * hz);
    u.push(0, 0, 1, 0, 1, 1, 0, 1);
    // `face` walks each quad as seen from INSIDE the box (the corner table's historical order). Reverse
    // both triangles so the stored normals point outward. The animation canaries are double-sided and hid
    // this; the lighting gnomon intentionally exposes it because the PS2 shades the stored normal unchanged.
    i.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  // Canary geometry is evidence, so fail at generation time if this helper ever starts lying again. For an
  // outward triangle, its geometric normal must point from the box centre toward the face centroid.
  for (let t = 0; t < i.length; t += 3) {
    const point = (k: number) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]];
    const a = point(i[t]), b = point(i[t + 1]), c = point(i[t + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const out = [(a[0] + b[0] + c[0]) / 3 - cx, (a[1] + b[1] + c[1]) / 3 - cy,
      (a[2] + b[2] + c[2]) / 3 - cz];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] <= 0)
      throw new Error(`box emitted an inward triangle at ${cx},${cy},${cz}`);
  }
  return { p, u, i };
}

function merge(...parts: Geom[]): Geom {
  const p: number[] = [], u: number[] = [], i: number[] = [];
  for (const g of parts) { const o = p.length / 3; p.push(...g.p); u.push(...g.u); i.push(...g.i.map(k => k + o)); }
  return { p, u, i };
}

/** Pin every vertex to the centre of one known source texel. Zero UV derivatives keep the base mip selected,
 * turning a mottled retail page into a flat colour swatch without introducing a custom texture/encoder. */
function constantTexel(g: Geom, x: number, yFromTop: number, size = 128): Geom {
  const u = (x + 0.5) / size, v = 1 - (yFromTop + 0.5) / size;
  const flat: number[] = [];
  for (let vertex = 0; vertex < g.p.length / 3; vertex++) flat.push(u, v);
  return { p: g.p, u: flat, i: g.i };
}

const sub = (g: Geom, object?: number) => ({
  mat: 0, pos: b64(new Float32Array(g.p)), uv: b64(new Float32Array(g.u)),
  idx: b64(new Uint32Array(g.i)), ...(object !== undefined ? { object } : {}),
});

/** A curve list per channel — index 0-2 translation X/Y/Z, 3-5 rotation X/Y/Z (the AnimationAction
 *  bit order). `[a, b, c, d, t0, t1]` is a cubic by Horner in seconds; `d` alone is a constant. */
const channels = (spec: Record<number, number[][]>) =>
  [0, 1, 2, 3, 4, 5].map(i => spec[i] ?? null);
const constant = (deg: number) => [[0, 0, 0, deg, 0, CLIP_SECONDS]];
/** A linear ramp across the WHOLE clip. Spanning longer than the clip is a silent authoring trap —
 *  the window wraps first and the motion looks like it resets part-way through. */
const spinOnce = (deg: number) => [[0, 0, deg / CLIP_SECONDS, 0, 0, CLIP_SECONDS]];

/** Every canary uses one clip length; curves must span exactly this. */
const CLIP_FRAMES = 90;
const CLIP_SECONDS = CLIP_FRAMES / 30;

const ROOT = { parent: -1, restPosition: [0, 0, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1] };
/** An animated sub-object hanging off the static root, pivoting at height `z`. */
const moving = (z: number, baseEuler: number[], spec: Record<number, number[][]>) => ({
  parent: 0, restPosition: [0, 0, z], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
  basePosition: [0, 0, z], baseEuler, channels: channels(spec),
});

/** The shared reference body: a plinth, a mast, a long thin NOSE bar along model +X and a low wide
 *  FIN slab along +Y. Every read is relative to those two, which makes it yaw-independent. */
const stand = (mastTop: number) => merge(
  box(0, 0, 15, 45, 45, 15),
  box(0, 0, mastTop / 2, 8, 8, mastTop / 2),
  box(70, 0, 15, 25, 4, 4),
  box(0, 62, 10, 18, 17, 10));
/** An arm along local +X with a fin at its tip along +Y: rotation about ANY axis is legible —
 *  about X the arm holds still and the fin twirls, about Y it sweeps vertically, about Z flat. */
const arm = (z: number) => merge(box(38, 0, z, 38, 5, 5), box(80, 16, z, 6, 16, 4));

const HEIGHTS = [110, 190, 270];

/** A bar along local +X. Its DIRECTION is the read: left at rest it points at the NOSE, and a constant
 *  90 deg Z channel swings it to the FIN. One bar per object, so a ladder of them reports per object
 *  whether the engine posed it — a count, never an angle to be estimated. */
const bar = (z: number) => box(40, 0, z, 30, 4, 4);

/** MESA's `Mdl_bridgesway_3000` is retail's largest animated model at 7 objects / depth 3. Authored
 *  boundary tests establish a much higher but hard runtime ceiling: 27 TOTAL packed native ModelObjects
 *  work and 28 corrupts the runtime's fixed matrix workspace [Trailmap: 120-objects]. Canonical export omits no-op identity
 *  placement mounts, so both topology probes reach that edge directly:
 *
 *    npx tsx tools/re-canaries/make.ts object-count=26 object-depth=26 # both pack to 27
 *    npx tsx tools/re-canaries/make.ts object-count=27                 # 28: freezes
 *
 *  Naming one canary leaves the other's file untouched. Defaults stay at the safe edge so the no-argument
 *  command never silently installs a known-crashing object-count canary. */
const SIZES: Record<string, number> = { 'object-count': 26, 'object-depth': 26 };
const RUNG_STEP = 30;

/** One link of a CHAIN: parented to the link below and offset one step up from it. Rest position is
 *  PARENT-RELATIVE — canonical `packClip` composes it down the chain
 *  — while the geometry it carries is authored in model space at the accumulated height. Base position
 *  matches rest, as every retail clip's does; the engine reads the base, not the rest. */
const chained = (parent: number, spec: Record<number, number[][]>) => ({
  parent, restPosition: [0, 0, RUNG_STEP], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
  basePosition: [0, 0, RUNG_STEP], baseEuler: [0, 0, 0], channels: channels(spec),
});

const CANARIES: Record<string, { file: string; name: string; build: (size: number) => unknown }> = {
  // A render-path control, deliberately textured from a RETAIL GARI page rather than a Custom page. At yaw
  // zero under Slopesmith's default sun, the +X (NOSE) and +Z plates take key light while -X and -Z are
  // ambient-only; the two Y plates are nearly edge-on to the key. Place two and mark one self-lit to separate
  // texture upload, absolute instance-light magnitude, and normal/light-vector direction (README.md).
  'lighting-gnomon': {
    file: 'zz-lighting-gnomon', name: 'zz lighting gnomon',
    build: () => {
      const cards = merge(
        // Six cardinal normal cards. `box` splits every face's positions, so the packer cannot smooth one
        // card into its neighbours; each outward face is a categorical ±axis normal.
        box(105, 0, 82, 4, 28, 28), box(-105, 0, 82, 4, 28, 28),
        box(0, 105, 82, 28, 4, 28), box(0, -105, 82, 28, 4, 28),
        box(0, 0, 160, 34, 34, 4));
      return {
        // Keep the stand's ordinary 0..1 UVs so the retail snow detail is a visible texture/upload control.
        // Only the cardinal cards use the flat texel needed for numerical light-ratio comparisons.
        subs: [sub(stand(115)), sub(constantTexel(cards, 75, 93))],
        // Qualified retail page: on GARI this remains native, and on another slot it is borrowed verbatim.
        // Either way it bypasses the custom type-5/type-2 encoder whose behaviour this canary helps isolate.
        materials: [{ id: 0, tex: 'GARI/0037.png' }],
      };
    },
  },
  // Does the engine pose an animated object from its stored base, or only from its channels?
  // Base says (90, 90, 90); a single constant channel on bit 3 says X = 90. Landing on exactly
  // Rx(90) — +X->+X, +Y->+Z, +Z->-Y — means the base did not participate.
  'euler-gnomon': {
    file: 'zz-euler-gnomon', name: 'zz euler gnomon',
    build: () => {
      const body = merge(box(0, 0, 10, 50, 50, 10), box(80, 0, 10, 30, 4, 4),
        box(0, 67, 5, 20, 17, 5), box(0, 0, 75, 6, 6, 55));
      const gnomon = merge(
        box(30, 0, 140, 30, 11, 11), box(66, 0, 140, 8, 16, 16),      // SHORT  +X (fat)
        box(0, 50, 140, 7, 50, 7), box(0, 105, 140, 12, 8, 12),       // MEDIUM +Y
        box(0, 0, 215, 5, 5, 75), box(0, 0, 296, 9, 9, 9));           // LONG   +Z (thin)
      return { subs: [sub(body), sub(gnomon, 1)],
        objects: [ROOT, moving(140, [90, 90, 90], { 3: constant(90) })] };
    },
  },
  // Which axis does each AnimationAction rotation bit drive? Base is zero everywhere, so each arm
  // is one plain axis rotation — the same in every composition order, which isolates the mapping.
  'euler-bits': {
    file: 'zz-euler-bits', name: 'zz euler bits',
    build: () => ({
      subs: [sub(stand(300)), sub(arm(HEIGHTS[0]), 1), sub(arm(HEIGHTS[1]), 2), sub(arm(HEIGHTS[2]), 3)],
      objects: [ROOT,
        moving(HEIGHTS[0], [0, 0, 0], { 3: spinOnce(360) }),
        moving(HEIGHTS[1], [0, 0, 0], { 4: spinOnce(360) }),
        moving(HEIGHTS[2], [0, 0, 0], { 5: spinOnce(360) })],
    }),
  },
  // In what order does a multi-channel rotation compose? Each arm drives TWO constant 90 channels
  // with its third component unchannelled; the three pairs together give a 6-way signature.
  'euler-order': {
    file: 'zz-euler-order', name: 'zz euler order',
    build: () => ({
      subs: [sub(stand(300)), sub(arm(HEIGHTS[0]), 1), sub(arm(HEIGHTS[1]), 2), sub(arm(HEIGHTS[2]), 3)],
      objects: [ROOT,
        moving(HEIGHTS[0], [0, 0, 0], { 3: constant(90), 4: constant(90) }),   // (X,Y)
        moving(HEIGHTS[1], [0, 0, 0], { 3: constant(90), 5: constant(90) }),   // (X,Z)
        moving(HEIGHTS[2], [0, 0, 0], { 4: constant(90), 5: constant(90) })],  // (Y,Z)
    }),
  },
  // Where does an animated object's TRANSLATION come from? Rotation is known to ignore both the base
  // and the rest transform, but every clip we have — retail and canary alike — sets base translation
  // equal to rest translation, so the two have never been separated. Here they differ by 2 m: the
  // marker is STORED (and therefore drawn, once the packer localises it) at rest (0,0,200), while the
  // base says (200,0,200). A slow spin makes it obvious the object is animated at all.
  //   marker above the mast           -> translation comes from the REST transform
  //   marker 2 m out toward the NOSE  -> translation comes from the BASE
  //   marker down at the plinth       -> unchannelled translation is zero, as rotation is
  'translation-source': {
    file: 'zz-translation-source', name: 'zz translation source',
    build: () => {
      const body = merge(box(0, 0, 15, 45, 45, 15), box(0, 0, 100, 8, 8, 100),
        box(70, 0, 15, 25, 4, 4), box(0, 62, 10, 18, 17, 10));
      // a chunky marker with a stub arm, stored around its rest height so it reads as one object
      const marker = merge(box(0, 0, 200, 22, 22, 22), box(45, 0, 200, 25, 5, 5));
      return { subs: [sub(body), sub(marker, 1)], objects: [ROOT, {
        parent: 0, restPosition: [0, 0, 200], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
        basePosition: [200, 0, 200], baseEuler: [0, 0, 0], channels: channels({ 5: spinOnce(360) }),
      }] };
    },
  },
  // Flat topology probe for the measured 27-native-object ceiling. Every bar is parented to the root
  // and holds a constant 90 deg Z channel: a posed rung points at the FIN and an unposed one at the NOSE.
  //
  // An identity placement frame needs no helper mount, so each authored rung is exactly one native object:
  // 1 root + n. Twenty-six rungs reach the safe maximum 27; twenty-seven reach the failing 28.
  'object-count': {
    file: 'zz-object-count', name: 'zz object count',
    build: (rungs) => {
      const subs = [sub(stand((rungs + 1) * RUNG_STEP))];
      const objects: unknown[] = [ROOT];
      for (let k = 1; k <= rungs; k++) {
        subs.push(sub(bar(k * RUNG_STEP), k));
        // The TOP rung sweeps instead of holding, so one glance says whether the clip is running at
        // all — a ladder of constants that never got played looks exactly like one that hit a ceiling.
        objects.push(moving(k * RUNG_STEP, [0, 0, 0],
          k === rungs ? { 5: spinOnce(360) } : { 5: constant(90) }));
      }
      return { subs, objects };
    },
  },
  // Topology-control probe for the same total-object ceiling: each link hangs off the one below rather
  // than off the root. Every link turns a constant 90 deg about Z and its offset to the
  // next is along Z, so the offset is invariant under its own rotation — the column stays dead
  // vertical while the bars fan into a four-fold helix, link k pointing at 90k degrees.
  //
  // The placement frame is identity, so no helper mount is inserted: n links pack to n + 1. Twenty-six
  // links reach 27 native objects; twenty-seven reach the failing 28.
  'object-depth': {
    file: 'zz-object-depth', name: 'zz object depth',
    build: (links) => {
      const subs = [sub(stand((links + 1) * RUNG_STEP))];
      const objects: unknown[] = [ROOT];
      for (let k = 1; k <= links; k++) {
        subs.push(sub(bar(k * RUNG_STEP), k));
        objects.push(chained(k - 1, k === links ? { 5: spinOnce(360) } : { 5: constant(90) }));
      }
      return { subs, objects };
    },
  },
};

/** What canonical export emits for these identity-framed probes. The PAL ceiling is 27 entries in this
 * final packed count, root included. A real non-identity frame may still need a helper mount, but neither
 * ladder does, and the exporter validates the actual count after making that decision. */
const nativeCount = (objects: { parent: number; channels?: unknown }[]) => objects.length;

/** `name` selects a canary; `name=N` also sizes it. Sizing is only meaningful for the ladders, and a size
 *  aimed at a fixed-shape canary is a mistake worth stopping on rather than dropping on the floor. */
function parseArgs(argv: string[]): { names: string[]; sizes: Record<string, number> } | null {
  const sizes = { ...SIZES };
  const names: string[] = [];
  for (const arg of argv) {
    const [key, value] = arg.split('=');
    if (!CANARIES[key]) {
      console.error(`unknown canary "${key}" — have: ${Object.keys(CANARIES).join(', ')}`);
      return null;
    }
    names.push(key);
    if (value === undefined) continue;
    const size = Number(value);
    if (!(key in SIZES)) { console.error(`"${key}" has no size to set`); return null; }
    if (!Number.isInteger(size) || size < 1) { console.error(`bad size "${arg}" — want a whole count`); return null; }
    sizes[key] = size;
  }
  return { names: names.length ? names : Object.keys(CANARIES), sizes };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) { process.exitCode = 1; return; }
  const project = await currentProject();
  if (!project) throw new Error('open a mountain before installing RE canaries');
  await migrateLegacyProjectAssets(project);
  await withProjectAssets(project, async () => {
  const { names, sizes } = parsed;
  const existing = await listImportedProps();
  for (const key of names) {
    const canary = CANARIES[key];
    const built = canary.build(sizes[key]) as {
      subs: unknown[];
      objects?: { parent: number; channels?: unknown }[];
      materials?: { id: number; tex: string | null }[];
    };
    const tris = (built.subs as { idx: string }[])
      .reduce((n, s) => n + Buffer.from(s.idx, 'base64').length / 12, 0);
    const record = {
      name: canary.name, tris, subs: built.subs, materials: built.materials ?? [{ id: 0, tex: null }],
      ...(built.objects ? { animation: { clipFrames: CLIP_FRAMES, objects: built.objects } } : {}),
    };
    // Rewrite in place when the canary is already in the library. A fresh save would mint a NEW
    // model number and land beside it as `<name>_2`, and placements persist the number — so every
    // canary already dropped in a level would keep the old geometry while the new copy sat unplaced.
    // Match on the FILE stem, not the display name: a stray duplicate carries the same name, and
    // picking one by name would rewrite the copy instead of the canary that is actually placed.
    const prior = existing.find(e => e.file === `${canary.file}.json`);
    const saved = prior
      ? { file: prior.file, record: await replaceImportedProp(prior.record.id, record as never) }
      : await saveImportedProp(canary.file, record as never);
    console.log(`${key.padEnd(18)} ${prior ? 'replaced' : 'created '} mountain-local/props/${saved.file}`
      + `  (model id ${saved.record.id}, ${tris} tris`
      + (built.objects ? `, ${built.objects.length} objects -> ${nativeCount(built.objects)} native)` : ', static)'));
  }
  });
}
void main();
