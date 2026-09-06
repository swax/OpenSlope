// tier: fast

/**
 * The HEADLESS GLB importer (docs/032), run against real committed models.
 *
 * `tools/prop-recipes/` builds eighteen props and commits them; until the server could read a GLB, the last
 * step of getting one into a project was a human dragging the file onto a panel. This is the path that
 * closes — `glb-decode.ts` reads the container, `import-glb.ts` reproduces the browser importer's
 * conversion, and the art lands in an isolated mountain texture bank.
 *
 * The load-bearing check here is the WINDING one. The raw frame is a mirror of the editor's, a prop's
 * normals come from its stored winding alone, and a face wound the wrong way still draws — ambient-only
 * dark, from every view, in the editor and on the disc. So this asserts what `check.py` asserts of the
 * recipe (`_lib._raw_volume6`) and what every retail prop measures: a closed prop's STORED geometry encloses
 * a positive raw volume. Everything else here could be wrong and visible; this one is wrong and plausible.
 *
 * Run: tsx test/glb-import.test.ts
 *
 * Writes into a throwaway SLOPESMITH_MAPS_ROOT, so the author's own Maps/ library is never touched.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-glb-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = join(root, 'assets');
forgetWorkspaceConfig();

const { decodeGlb } = await import('../src/core/props/glb-decode');
const { encodeGlb } = await import('../src/core/props/glb-encode');
const { glbPropDraft, importGlbFile } = await import('../src/server/props/import-glb');
const { listImportedProps, saveImportedProp } = await import('../src/server/routes/imported-props');
const { decodePng } = await import('../src/server/routes/png');
const { CUSTOM_TEX_LEVEL } = await import('../src/core/paint/textures');
const { MAX_IMPORT_TRIS } = await import('../src/core/props/imported');
type Record_ = Awaited<ReturnType<typeof importGlbFile>>;

const PROPS = join(import.meta.dirname, '..', 'tools', 'prop-recipes', 'props');
const glb = (name: string) => readFileSync(join(PROPS, `${name}.glb`));
const textureDir = () => join(root, 'assets', 'textures');
const stagedTiles = () => { try { return readdirSync(textureDir()).sort(); } catch { return []; } };

/** A stored record's geometry back out of the base64 packing — the same unpacking `decodeProps` does, so
 *  what is measured below is what a placement would actually draw rather than an intermediate. */
function geometry(record: Record_): { positions: Float32Array; indices: Uint32Array }[] {
  return record.subs.map(sub => {
    const pos = Buffer.from(sub.pos, 'base64');
    const idx = Buffer.from(sub.idx, 'base64');
    return {
      positions: new Float32Array(pos.buffer, pos.byteOffset, pos.byteLength / 4),
      indices: new Uint32Array(idx.buffer, idx.byteOffset, idx.byteLength / 4),
    };
  });
}

/** Six times the enclosed volume of the STORED geometry, by `_lib._raw_volume6`'s own method: the signed
 *  determinant of each triangle's three corners, summed. Positive is the orientation every retail prop
 *  stores at, and the orientation the importer's `a, c, b` reversal is there to produce. */
function rawVolume6(record: Record_): number {
  let total = 0;
  for (const { positions, indices } of geometry(record)) {
    const at = (v: number): [number, number, number] =>
      [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const p = at(indices[t]), q = at(indices[t + 1]), r = at(indices[t + 2]);
      total += p[0] * (q[1] * r[2] - q[2] * r[1])
        - p[1] * (q[0] * r[2] - q[2] * r[0])
        + p[2] * (q[0] * r[1] - q[1] * r[0]);
    }
  }
  return total;
}

/** The raw-space bounding box of a stored record, in the record's own model-local centimetres. */
function bounds(record: Record_): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of geometry(record)) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], positions[i + a]);
        max[a] = Math.max(max[a], positions[i + a]);
      }
    }
  }
  return { min, max };
}

/** Every triangle the FILE itself declares, counted straight out of its accessors — so the importer's own
 *  count is compared against the model rather than against a number typed in here. */
function fileTriangles(name: string): number {
  return decodeGlb(glb(name)).meshes.reduce((n, mesh) => n + mesh.primitives.reduce((m, p) =>
    m + (p.indices ? p.indices.length : p.positions.length / 3) / 3, 0), 0);
}

try {
  // ---- the container reader, on its own ---------------------------------------------------------
  {
    const gltf = decodeGlb(glb('SnowGun'));
    check(gltf.nodes.length === 2 && gltf.nodes[0].parent === -1 && gltf.nodes[1].parent === 0,
      'the node hierarchy comes back flattened, parents before children');
    check(gltf.nodes[1].world[13] > 3.7 && Math.abs(gltf.nodes[1].world[13] - 3.7735748) < 1e-5,
      'a child node\'s world matrix carries its own translation (the spin pivot, 3.77 m up)');
    // The key is the PRE-RENAME `SWX_animation` because this fixture GLB was exported before the
    // OpenSlope rename — which is the point: the decoder hands extras back verbatim rather than
    // interpreting them, and `importedSpinFromExtras` accepts either spelling.
    check(!!gltf.nodes[1].extras && typeof (gltf.nodes[1].extras as Record<string, unknown>)
      .SWX_animation === 'string',
      'node `extras` comes back verbatim, which is what the self-describing GLB design rests on');
    check(gltf.materials.length === 1 && gltf.materials[0].baseColorImage === 0,
      'the material resolves its base-colour page through the textures[] indirection');
    check(!!gltf.images[0].bytes?.length && gltf.images[0].uri === null,
      'an embedded image comes back as bytes rather than a reference to read');
    check(decodeGlb(glb('RideButton')).materials[0].extras !== undefined,
      'material `extras` survives too — a flipbook declaration rides on it');

    const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const corners = new Uint32Array([0, 1, 2]);
    const alphaGlb = encodeGlb({
      nodes: [{ name: 'alpha root', mesh: 0 }],
      meshes: [{ name: 'alpha mesh', primitives: [
        { positions: triangle, indices: corners, material: 0 },
        { positions: triangle, indices: corners, material: 1 },
      ] }],
      materials: [
        { name: 'masked', baseColorFactor: [0.2, 0.4, 0.8, 1], alphaMode: 'MASK' },
        { name: 'glass', baseColorFactor: [1, 1, 1, 0.5], alphaMode: 'BLEND' },
      ],
    });
    const decodedAlpha = decodeGlb(alphaGlb);
    check(decodedAlpha.materials[0].alphaMode === 'MASK' && decodedAlpha.materials[1].alphaMode === 'BLEND',
      'the dependency-free decoder retains explicit glTF MASK/BLEND material laws');
    const alphaDraft = await glbPropDraft(alphaGlb, { name: 'alpha modes' });
    const blendPage = decodePng(alphaDraft.textures[1]!);
    check(alphaDraft.alphaModes.join(' ') === 'cutout blend' && blendPage.data[3] >= 127
      && blendPage.data[3] <= 128,
    'the headless importer maps MASK/BLEND and bakes baseColorFactor alpha into the staged PNG');

    let refused = '';
    try { decodeGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])); }
    catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(/not a GLB or a glTF/.test(refused), `a file that is neither is refused clearly ("${refused}")`);
  }

  // ---- PatrolHut: the plain case, and the orientation guard ---------------------------------------
  const hut = await importGlbFile(join(PROPS, 'PatrolHut.glb'));
  {
    check(hut.name === 'PatrolHut', `the display name comes from the file name (${hut.name})`);
    check(hut.tris === fileTriangles('PatrolHut') && hut.tris === 323,
      `the triangle count is what the file actually carries (${hut.tris})`);
    check(hut.tris < MAX_IMPORT_TRIS, 'and it is inside the import cap, so nothing was staged on refusal');

    // THE check. Positive means the stored winding is the one retail props store at; negative means every
    // face points into the model and the prop ships ambient-only dark while still drawing perfectly.
    const volume6 = rawVolume6(hut);
    check(volume6 > 0,
      `the stored geometry encloses a POSITIVE raw volume (${(volume6 / 6).toLocaleString(undefined,
        { maximumFractionDigits: 0 })} cm³) — the winding guard check.py runs`);

    const { min, max } = bounds(hut);
    check(Math.abs(min[0] + max[0]) < 0.01 && Math.abs(min[1] + max[1]) < 0.01,
      `the raw x/y bbox is centred on the origin (${(min[0] + max[0]).toFixed(4)}, `
      + `${(min[1] + max[1]).toFixed(4)}), so a placement drops under the cursor`);
    check(min[2] > -0.01 && max[2] > 400,
      `vertical is left ALONE, so propBaseOffset can stand it on the terrain (z ${min[2].toFixed(1)} … `
      + `${max[2].toFixed(1)} cm)`);

    // The UV V flip, order-independently: glTF v runs top-down and prop UVs are raw OBJ vt.
    const source = decodeGlb(glb('PatrolHut')).meshes[0].primitives[0].uvs!;
    let vLow = Infinity, vHigh = -Infinity;
    for (let i = 1; i < source.length; i += 2) { vLow = Math.min(vLow, source[i]); vHigh = Math.max(vHigh, source[i]); }
    const uv = Buffer.from(hut.subs[0].uv, 'base64');
    const stored = new Float32Array(uv.buffer, uv.byteOffset, uv.byteLength / 4);
    let storedLow = Infinity, storedHigh = -Infinity;
    for (let i = 1; i < stored.length; i += 2) {
      storedLow = Math.min(storedLow, stored[i]); storedHigh = Math.max(storedHigh, stored[i]);
    }
    check(Math.abs(storedLow - (1 - vHigh)) < 1e-6 && Math.abs(storedHigh - (1 - vLow)) < 1e-6,
      'the stored UV v is 1 − the file\'s, so a painted panel lands the right way up');

    check(hut.materials.length === 1 && hut.subs.length === 1,
      'one page, one submesh — the shape a single-material prop converts to');
    check(hut.materials[0].tex === `${CUSTOM_TEX_LEVEL}/PatrolHut_0.png`,
      `its art staged into the mountain texture bank (${hut.materials[0].tex})`);
    check(stagedTiles().includes('PatrolHut_0.png'), 'and the file is really on disk');
    check(!hut.animation && !hut.emitters, 'a static prop declares no clip and no emitters');
  }

  // ---- one kit, one page --------------------------------------------------------------------------
  // The budget half of this. `saveCustomTexture` never overwrites, so ten props embedding one atlas would
  // otherwise spend ten bank slots — and later ten pages of a PS2 texture budget — on ten copies of it.
  {
    const before = stagedTiles().length;
    const a = await importGlbFile(join(PROPS, 'PatrolHut.glb'), { tileName: 'zz-test-kit' });
    const b = await importGlbFile(join(PROPS, 'PatrolHut.glb'), { tileName: 'zz-test-kit' });
    check(a.materials[0].tex === `${CUSTOM_TEX_LEVEL}/zz-test-kit.png`
      && b.materials[0].tex === a.materials[0].tex,
      `two props staged under one tileName reference ONE tile (${a.materials[0].tex})`);
    check(stagedTiles().length === before + 1,
      `and only one file was written for the pair (${stagedTiles().length - before})`);

    // …while the never-overwrite rule still holds for art that is genuinely different.
    const other = await importGlbFile(join(PROPS, 'SnowGun.glb'), { tileName: 'zz-test-kit' });
    check(other.materials[0].tex === `${CUSTOM_TEX_LEVEL}/zz-test-kit_2.png`,
      `a different page under a taken name lands beside it (${other.materials[0].tex})`);
  }

  // ---- SnowGun: a declared spin, a declared emitter, two submeshes on one page ---------------------
  {
    const gun = await importGlbFile(join(PROPS, 'SnowGun.glb'));
    check(gun.tris === fileTriangles('SnowGun') && gun.tris === 190,
      `the moving and static halves are both counted (${gun.tris} tris)`);
    check(gun.materials.length === 1 && gun.subs.length === 2 && gun.subs.every(s => s.mat === 0),
      'two submeshes share ONE material — a run is split by how it MOVES as well as how it draws');
    check(gun.animation?.clipFrames === 40 && gun.animation.objects.length === 3,
      `0.75 rev/s becomes a 40-frame clip of mount + turning child (${gun.animation?.clipFrames})`);
    check(gun.subs[0].object === 0 && gun.subs[1].object === 2,
      'the body belongs to the static root and the fan to the animated object');

    check(gun.emitters?.length === 1, 'the declared emitter is recovered');
    const spawn = gun.emitters![0].fields;
    const { min, max } = bounds(gun);
    // check.py's own guard: an emitter that skipped the re-centring floats clear of its prop, which reads
    // as a physics bug rather than an import one and is invisible until somebody places the machine.
    const inside = [spawn.U9, spawn.U10, spawn.U11]
      .every((v, a) => v >= min[a] - 50 && v <= max[a] + 50);
    check(inside, `the spawn point took the vertices' transform, re-centring included `
      + `(${spawn.U9.toFixed(0)}, ${spawn.U10.toFixed(0)}, ${spawn.U11.toFixed(0)} cm)`);
    check(rawVolume6(gun) > 0, 'and the machine is stored the right way out too');
  }

  // ---- RideButton: a filmstrip page cut into bank tiles --------------------------------------------
  {
    const button = await importGlbFile(join(PROPS, 'RideButton.glb'));
    const material = button.materials[0];
    check(material.frames?.length === 2, `a 2-frame declaration yields 2 frames (${material.frames?.length})`);
    check(material.frames?.[0] === material.tex,
      'frame 0 IS the material\'s own tile, so the state list begins where the material does');
    check(material.tex === `${CUSTOM_TEX_LEVEL}/RideButton_0.png`
      && material.frames?.[1] === `${CUSTOM_TEX_LEVEL}/RideButton_0_f1.png`,
      `and the rest are their own tiles in the bank (${material.frames?.[1]})`);

    // The base tile must be the top BAND, not the whole strip — a prop wearing the uncut page renders
    // every frame at once, stacked, which looks like bad UVs rather than a missing cut.
    const page = decodePng(Buffer.from(decodeGlb(glb('RideButton')).images[0].bytes!));
    const frame0 = decodePng(readFileSync(join(textureDir(), 'RideButton_0.png')));
    const frame1 = decodePng(readFileSync(join(textureDir(), 'RideButton_0_f1.png')));
    check(frame0.w === page.w && frame0.h === page.h / 2 && frame1.h === frame0.h,
      `each frame is one band of the ${page.w}×${page.h} strip (${frame0.w}×${frame0.h})`);
    const sameTop = frame0.data.every((v, i) => v === page.data[i]);
    check(sameTop, 'band 0 is cut from the TOP of the page, the order a painted strip reads in');
  }

  // ---- the record the store actually holds ---------------------------------------------------------
  {
    const saved = await saveImportedProp('zz-test-headless-hut', hut);
    const listed = (await listImportedProps()).find(e => e.record.id === saved.record.id);
    check(!!listed, `the imported record round-trips through the store (${saved.file})`);
    check(listed?.record.tris === hut.tris && listed?.record.subs[0].pos === hut.subs[0].pos,
      'and reads back with the same geometry it was given');
    check(listed?.record.materials[0].tex === hut.materials[0].tex,
      '…still wearing the tile ref import staged for it');
  }

  // ---- a draft can be inspected before anything is staged ------------------------------------------
  {
    const before = stagedTiles().length;
    const draft = await glbPropDraft(glb('PatrolHut'), { fileName: 'PatrolHut.glb' });
    check(draft.size.every(v => v > 0.5 && v < 12)
      && Math.abs(draft.size[0] - 5.3) < 0.05 && Math.abs(draft.size[1] - 4.49) < 0.05,
      `the footprint is reported in editor metres (${draft.size.map(v => v.toFixed(2)).join(' × ')})`);
    check(stagedTiles().length === before,
      'converting stages nothing — the triangle cap is enforced before a byte reaches the bank');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('glb-import: all checks passed');
