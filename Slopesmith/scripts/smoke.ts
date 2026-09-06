/**
 * Headless end-to-end check: the default mountain -> a real export through the node byte provider ->
 * REAL `snowknife gltf` bake -> sanity-assert the baked terrain.glb (parses the GLB, checks vertex count
 * and that terrain normals point skyward in glTF Y-up space), then the painted-tile copy, the authored
 * lightmap bake, the exact GS encode and GARI's reference-sun decoupling. Run: npm run smoke
 *
 * The export is composed by core against the NODE provider and the bake is the same `snowknife gltf` an
 * author pastes out of the exported folder's `Repack.md`. That pairing is the point: the editor exports
 * through a second provider in the browser, and this proves the composition both share still bakes.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultMountain } from '../src/core/doc/mountain';
import { setTex } from '../src/core/doc/doc-edit';
import { exportLevel } from '../src/server/routes/export';
import { mapsRoot } from '../src/server/workspace-config';
import { bakeGltf, snowknifeExe } from './snowknife-cli';
import { buildLevelFiles } from '../src/core/export/level';
import { DEFAULT_SUN, type SunLight } from '../src/core/doc/types';
import { sunFromLights, buildReferenceMesh, type LightsFile } from '../src/core/reference/terrain';
import { fitSun, sunDirFromElAz, checkRecordSun, computeModelColored, type LightmapSet } from '../src/core/lighting/lightmap';
import { effectiveBakeSun, effectiveBakeAmbient, bakedLightmapDisplay, decodeLightmapTexel, encodeLightmapTexel } from '../src/core/lighting/bake';
import { decodePng } from '../src/server/routes/png';
import { readLevelPatches } from '../src/server/routes/levels';

const doc = defaultMountain();
doc.name = 'SMOKEMTN';
const dir = join(mapsRoot(), doc.name);
rmSync(dir, { recursive: true, force: true });

/**
 * The extracted level this smoke run reads for its reference-sun and painted-tile legs. It is named once
 * rather than spelled out per use, but it is NOT a free knob: the numeric bands asserted below (record sun
 * ~2.47, baked-effective ~0.7, bakeExposure ~0.28) are measured on this level, so pointing it at another
 * one would fail on calibration rather than on a regression. Retarget the bands with it.
 */
const REFERENCE_MAP = 'GARI';

// texture paint: paint the first cells with a real extracted tile and assert it copies + bakes in
const TILE = { level: REFERENCE_MAP, name: '0019.png', dest: `${REFERENCE_MAP}_0019.png` };
const paintedTile = existsSync(join(mapsRoot(), TILE.level, 'Textures', TILE.name));
if (paintedTile) {
  for (let q = 0; q < 6; q++) setTex(doc, q, `${TILE.level}/${TILE.name}`);
}

const result = await exportLevel(doc, { outDir: dir });
console.log(result.log);

if (!snowknifeExe()) {
  console.error('SMOKE FAIL: no snowknife binary — build the sibling Snowknife checkout in Debug, or point '
    + 'SLOPESMITH_SNOWKNIFE_EXE at one. The bake is what this check exists to prove.');
  process.exit(1);
}
const bake = bakeGltf(dir, doc.name)!;
console.log(`\n$ snowknife gltf ${dir} ${doc.name.toLowerCase()}\n${bake.stdout}${bake.stderr}`);
if (bake.status !== 0) {
  console.error(`SMOKE FAIL: bake did not complete (exit ${bake.status})`);
  process.exit(1);
}

// ---- parse the GLB and find the Terrain node's NORMAL accessor ----
const glbPath = join(dir, 'gltf', 'terrain.glb');
const glb = readFileSync(glbPath);
if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;

const mesh = json.meshes.find((m: { name: string }) => m.name === 'Terrain');
if (!mesh) throw new Error('no Terrain mesh in terrain.glb');
void binStart; // attributes are interleaved; the accessor min/max bounds are all we need

let verts = 0;
let minNy = Infinity;
let maxNy = -Infinity;
for (const prim of mesh.primitives) {
  verts += json.accessors[prim.attributes.POSITION].count;
  const nAcc = json.accessors[prim.attributes.NORMAL];
  minNy = Math.min(minNy, nAcc.min[1]);
  maxNy = Math.max(maxNy, nAcc.max[1]);
}

// terrain colliders ride inside terrain.glb as one TerrainCol_<surfaceType> mesh each
const colMeshes = json.meshes.filter((m: { name: string }) => /^TerrainCol_/.test(m.name)).map((m: { name: string }) => m.name);
const manifest = JSON.parse(readFileSync(join(dir, 'gltf', 'manifest.json'), 'utf8'));

console.log(`\nterrain.glb: ${verts.toLocaleString()} verts across ${mesh.primitives.length} primitives`);
// A mountain is a foldable control net: an overhang's underside legitimately points down (minNy < 0 ok),
// so the assertion is consistent winding — some skyward face, no inverted/NaN normals. (docs/006 S3, the
// bake winds by geometric orientation.)
console.log(`normal Y range (glTF Y-up): [${minNy.toFixed(3)}, ${maxNy.toFixed(3)}]`);
console.log(`collision meshes: ${colMeshes.join(', ') || 'NONE'}`);
console.log(`manifest: Level=${manifest.Level}, Paths.Course=${manifest.Paths?.Course ? manifest.Paths.Course.Start.length + ' line(s)' : 'MISSING'}`);

let fail = false;
if (verts < 1000) { console.error('SMOKE FAIL: suspiciously few terrain verts'); fail = true; }
if (!Number.isFinite(minNy) || !Number.isFinite(maxNy) || minNy < -1.001 || maxNy > 1.001) {
  console.error('SMOKE FAIL: terrain normals are NaN / not unit-length - tessellation bug'); fail = true;
}
if (!(maxNy > 0)) { console.error('SMOKE FAIL: no terrain normal points skyward - winding globally inverted'); fail = true; }
if (!(minNy > -0.2)) console.warn(`note: terrain has overhang/near-vertical faces (minNy ${minNy.toFixed(3)})`);
if (!manifest.Paths?.Course) { console.error('SMOKE FAIL: course path missing from manifest'); fail = true; }
if (colMeshes.length === 0) { console.error('SMOKE FAIL: no TerrainCol_* collision meshes'); fail = true; }

if (paintedTile) {
  const copied = existsSync(join(dir, 'Textures', TILE.dest));
  const inManifest = (manifest.Textures ?? []).some((t: { File?: string }) => t.File === TILE.dest);
  console.log(`texture paint: ${TILE.level}/${TILE.name} -> ${TILE.dest} (copied=${copied}, in manifest=${inManifest})`);
  if (!copied) { console.error('SMOKE FAIL: painted real tile not copied into Textures/'); fail = true; }
  if (!inManifest) { console.error('SMOKE FAIL: painted real tile missing from bake manifest'); fail = true; }
} else {
  console.log(`texture paint: skipped (no Maps/${TILE.level}/Textures/${TILE.name} to paint with)`);
}

// lighting: export bakes the authored sun into Lightmaps/, and the real bake must pick them up
const lmWritten = existsSync(join(dir, 'Lightmaps', '0000.png'));
const lmBaked = /lightmap \d+\/16/.test(bake.stdout);
console.log(`lighting: Lightmaps/0000.png written=${lmWritten}, bake reports lightmap=${lmBaked}`);
if (!lmWritten) { console.error('SMOKE FAIL: export wrote no Lightmaps/ (authored sun not baked)'); fail = true; }
if (!lmBaked) console.warn('note: bake log did not confirm lightmap pickup - check snowknife output');

// EXACT GS encode (bxtools form): folding a patch's diffuse C_D must reconstruct texture × light (lit = C_D·L)
// through the Unity decode, AND must differ from the texture-free white base on a dark texel — the fix that
// makes the baked (in-game) view actually change vs the live smooth model.
{
  const L: [number, number, number] = [0.85, 0.80, 0.70];   // a lit sun colour
  const CD: [number, number, number] = [0.40, 0.38, 0.34];  // dark rock diffuse base
  const [r, g, b, a] = encodeLightmapTexel(L[0], L[1], L[2], CD[0], CD[1], CD[2]);
  const exact = decodeLightmapTexel(r, g, b, a, CD[0], CD[1], CD[2]);   // ≈ C_D·L (texture × light)
  const [wr, wg, wb, wa] = encodeLightmapTexel(L[0], L[1], L[2]);       // white-base encode (texture-free)
  const white = decodeLightmapTexel(wr, wg, wb, wa);                    // ≈ L
  const want: [number, number, number] = [CD[0] * L[0], CD[1] * L[1], CD[2] * L[2]];
  const exactErr = Math.max(...exact.map((v, i) => Math.abs(v - want[i])));
  const diff = Math.max(...exact.map((v, i) => Math.abs(v - white[i])));
  console.log(`exact GS encode: lit [${exact.map(v => v.toFixed(3)).join(',')}] vs C_D·L [${want.map(v => v.toFixed(3)).join(',')}] (err ${exactErr.toFixed(4)}); white-base lit [${white.map(v => v.toFixed(3)).join(',')}] (Δ ${diff.toFixed(3)})`);
  if (!(exactErr < 0.01)) { console.error(`SMOKE FAIL: exact GS encode does not reconstruct texture × light (err ${exactErr.toFixed(4)})`); fail = true; }
  if (!(diff > 0.1)) { console.error(`SMOKE FAIL: exact GS encode matches the white base on dark rock (Δ ${diff.toFixed(3)}) - diffuse not folded in`); fail = true; }
}

// reference sun: loading GARI as a reference must (a) seed the export sun from its OWN Lights.json records
// (the TRUE HDR sun ~2.47), and (b) DECOUPLE that from the bake - the terrain lightmap bakes at GARI's own
// exposure (~0.7 = 2.47 x bakeExposure ~0.28, recovered by pinning the fit to the record direction). The
// exported Lights.json keeps the raw 2.47; only the bake is scaled. Proves both ends of the decoupling.
const refLights = join(mapsRoot(), REFERENCE_MAP, 'Lights.json');
const refPatchesFile = join(mapsRoot(), REFERENCE_MAP, 'Patches.json');
if (existsSync(refLights) && existsSync(refPatchesFile)) {
  const seed = sunFromLights(JSON.parse(readFileSync(refLights, 'utf8')) as LightsFile);
  if (!seed) {
    console.error(`SMOKE FAIL: ${REFERENCE_MAP} Lights.json did not seed a sun (no directional record found)`); fail = true;
  } else {
    // decode GARI's baked lightmaps off disk (node has no canvas) and build its reference mesh, then fit
    const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
    const lm: LightmapSet = new Map();
    for (let id = 0; id <= 15; id++) {
      const f = join(mapsRoot(), REFERENCE_MAP, 'Lightmaps', String(id).padStart(4, '0') + '.png');
      if (!existsSync(f)) continue;
      const { w, h, data } = decodePng(readFileSync(f));
      const px = w * h, a = new Float32Array(px), rgb = new Float32Array(px * 3);
      for (let k = 0; k < px; k++) { const as = data[k * 4 + 3] / 255; a[k] = as; const kk = (as * 255) / 128; rgb[k * 3] = clamp01((0.5 - data[k * 4] / 255) * kk); rgb[k * 3 + 1] = clamp01((0.5 - data[k * 4 + 1] / 255) * kk); rgb[k * 3 + 2] = clamp01((0.5 - data[k * 4 + 2] / 255) * kk); }
      lm.set(id, { a, rgb });
    }
    const mesh = buildReferenceMesh((await readLevelPatches(REFERENCE_MAP)).patches, lm.size ? lm : undefined);
    if (!mesh.intensity) { console.error(`SMOKE FAIL: ${REFERENCE_MAP} lightmaps did not decode (no baked intensity to fit)`); fail = true; }
    else {
      const free = fitSun(mesh.normals, mesh.intensity);                               // free direction (study)
      const recDir = sunDirFromElAz(seed.el, seed.az);                                 // record direction (editor space)
      const pinned = fitSun(mesh.normals, mesh.intensity, recDir);                     // pinned -> I_fit + fit ambient
      const chk = checkRecordSun(recDir, free.dir, seed.sun, pinned.diffuse, pinned.ambient);
      const bakedEff = seed.sun * chk.bakeExposure;
      const recAmb = seed.ambient ?? DEFAULT_SUN.ambient;
      console.log(`ref sun (${REFERENCE_MAP}): record el ${seed.el.toFixed(1)}° az ${seed.az.toFixed(1)}° · export sun ${seed.sun.toFixed(2)} ${seed.sunTint} amb ${recAmb.toFixed(2)}`);
      console.log(`  decouple: I_fit ${pinned.diffuse.toFixed(2)} -> bakeExposure ${chk.bakeExposure.toFixed(3)} (baked-effective sun ${bakedEff.toFixed(2)}) · fit ambient ${chk.fitAmbient.toFixed(2)} · fit-vs-record dir Δ ${chk.dirErrorDeg.toFixed(1)}°`);
      if (!(seed.sun > 2 && seed.sun < 3)) { console.error(`SMOKE FAIL: ${REFERENCE_MAP} export sun ${seed.sun.toFixed(2)} is not the HDR record (~2.47)`); fail = true; }
      if (!(bakedEff > 0.5 && bakedEff < 0.9)) { console.error(`SMOKE FAIL: ${REFERENCE_MAP} baked-effective sun ${bakedEff.toFixed(2)} is not the level's own lightmap exposure (~0.7)`); fail = true; }
      if (!(chk.bakeExposure > 0.15 && chk.bakeExposure < 0.45)) { console.error(`SMOKE FAIL: ${REFERENCE_MAP} bakeExposure ${chk.bakeExposure.toFixed(3)} not ~0.28 - decoupling off`); fail = true; }
      if (!(chk.dirErrorDeg < 5)) { console.error(`SMOKE FAIL: ${REFERENCE_MAP} fit-vs-record direction error ${chk.dirErrorDeg.toFixed(1)}° too large`); fail = true; }
      if (!(chk.fitAmbient > 0.1 && chk.fitAmbient < 0.5)) { console.error(`SMOKE FAIL: ${REFERENCE_MAP} fit ambient ${chk.fitAmbient.toFixed(2)} not ~0.3`); fail = true; }
      if (!(chk.fitAmbient < recAmb - 0.1)) { console.error(`SMOKE FAIL: ${REFERENCE_MAP} fit ambient ${chk.fitAmbient.toFixed(2)} not below the hot record ambient ${recAmb.toFixed(2)}`); fail = true; }

      // The exported Lights.json keeps the raw HDR record sun AND the hot record ambient; only the BAKE is
      // decoupled (bakeExposure + bakeAmbient). `base` = the corrected record-seeded GARI doc sun.
      const base: SunLight = { ...DEFAULT_SUN, el: seed.el, az: seed.az, sun: seed.sun, sunTint: seed.sunTint, skyTint: seed.skyTint ?? DEFAULT_SUN.skyTint, ambient: recAmb, bakeExposure: chk.bakeExposure, bakeAmbient: chk.fitAmbient };
      const probe = defaultMountain(); probe.name = 'LIGHTPROBE'; probe.sun = base;
      const lights = JSON.parse(buildLevelFiles(probe).text['Lights.json']) as { Lights: { Type: number; Colour: number[] }[] };
      const exportSun = Math.max(...(lights.Lights.find(l => l.Type === 0)?.Colour ?? [0]));
      const exportAmb = Math.max(...(lights.Lights.find(l => l.Type === 3)?.Colour ?? [0]));
      if (!(Math.abs(exportSun - seed.sun) < 0.01)) { console.error(`SMOKE FAIL: exported Lights.json sun ${exportSun.toFixed(2)} != raw record ${seed.sun.toFixed(2)} - buildLightsJson sun was scaled`); fail = true; }
      if (!(Math.abs(exportAmb - recAmb) < 0.01)) { console.error(`SMOKE FAIL: exported Lights.json ambient ${exportAmb.toFixed(2)} != raw record ${recAmb.toFixed(2)} - buildLightsJson ambient was scaled`); fail = true; }
      console.log(`  export Lights.json: sun ${exportSun.toFixed(2)} · ambient ${exportAmb.toFixed(2)} (both raw record, un-exposed)`);

      // bake via the FULL export entry (buildLevelFiles -> buildMountainLevel -> bakeLightmaps), NOT
      // bakeLightmaps directly, so the doc's bake overrides have to survive the real level-build path.
      const page = (s: SunLight) => buildLevelFiles({ ...probe, sun: s }).lightmaps['0000.png'].data;
      const meanA = (d: Uint8Array) => { let t = 0; for (let k = 0; k < d.length; k += 4) t += d[k + 3]; return t / (d.length / 4); };
      const bufEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

      // REGRESSION (the reported bug): a record-seeded HDR doc {sun 2.47, bakeExposure 0.27} must bake an
      // UN-saturated lightmap through the full path - A_S mean well under the 255 rail (the failure was 241.7).
      const corrected = meanA(page(base));
      console.log(`  full-path bake (record-seeded doc {sun ${seed.sun.toFixed(2)}, bakeExposure ${chk.bakeExposure.toFixed(2)}, bakeAmbient ${chk.fitAmbient.toFixed(2)}}): A_S mean ${corrected.toFixed(1)} (must be << 255)`);
      if (!(corrected < 200)) { console.error(`SMOKE FAIL: record-seeded doc baked A_S mean ${corrected.toFixed(1)} is saturated (>=200) via buildLevelFiles`); fail = true; }

      // (a) GUARD: a stale doc {sun 2.47, bakeExposure 1} (exposure never applied) must FAIL SAFE - the bake
      // clamps the effective sun to the LDR ceiling, so any over-bright HDR sun yields the SAME bounded LDR
      // bake (not a saturated white-out). bakeAmbient cleared = the reported stale state (raw hot ambient).
      const stale: SunLight = { ...base, bakeExposure: 1, bakeAmbient: undefined };
      const pStale = page(stale), pLdr = page({ ...stale, sun: 1 }), pHot5 = page({ ...stale, sun: 5 });
      const guardClamps = bufEq(pStale, pLdr) && bufEq(pHot5, pLdr);
      const staleMean = meanA(pStale);
      console.log(`  guard: HDR sun ${seed.sun.toFixed(2)}/5.0 @ bakeExposure 1 -> identical LDR bake = ${guardClamps} · A_S mean ${staleMean.toFixed(1)} (< 255, not white-out)`);
      if (!guardClamps) { console.error('SMOKE FAIL: guard did not clamp an un-exposed HDR sun to the LDR ceiling - bake would saturate'); fail = true; }
      if (!(staleMean < 255)) { console.error(`SMOKE FAIL: guarded HDR bake A_S mean ${staleMean.toFixed(1)} is rail-pinned at 255`); fail = true; }
      if (!(corrected < staleMean)) { console.error('SMOKE FAIL: the exposure+ambient decoupling did not darken the bake below the clamped-stale bake'); fail = true; }

      // (b) AMBIENT: the GARI-referenced bake uses the fit ambient (~0.3), not the raw record 0.68 -> a darker
      // (GARI-like) shadow floor. Same doc, only bakeAmbient differs.
      const aFit = meanA(page({ ...base, bakeAmbient: chk.fitAmbient }));
      const aRaw = meanA(page({ ...base, bakeAmbient: recAmb }));
      console.log(`  ambient: baked page mean A_S with fit ambient ${chk.fitAmbient.toFixed(2)} -> ${aFit.toFixed(1)} vs raw record ${recAmb.toFixed(2)} -> ${aRaw.toFixed(1)}`);
      if (!(aFit < aRaw)) { console.error('SMOKE FAIL: bake ignored bakeAmbient (the hot record ambient did not bake brighter than the fit ambient)'); fail = true; }

      // BAKE-TO-BAKE VIEW: the user's "baked-lightmap" view (bakedLightmapDisplay) and the reference's
      // lightmap view (decodeLightmapTexel, via decodeLightmaps) share one encode->GS-display-decode path.
      // (1) the shared decode reproduces the reference's literal formula on real GARI bytes (no drift);
      // (2) lighting GARI's OWN geometry with the calibrated record sun, then displaying it that way, reads
      //     ≈ GARI's reference lightmap (same scale - the fit calibrated the exposure), not ~2x off.
      const hx = (h: string): [number, number, number] => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
      const lm0 = decodePng(readFileSync(join(mapsRoot(), REFERENCE_MAP, 'Lightmaps', '0000.png')));
      let decMax = 0;
      for (let i = 0; i < 4096; i++) { // shared decode == reference's inline formula, on real bytes
        const r = lm0.data[i * 4], g = lm0.data[i * 4 + 1], b = lm0.data[i * 4 + 2], a = lm0.data[i * 4 + 3];
        const k = (a / 255) * 255 / 128;
        const ref = [Math.min(1, Math.max(0, (0.5 - r / 255) * k)), Math.min(1, Math.max(0, (0.5 - g / 255) * k)), Math.min(1, Math.max(0, (0.5 - b / 255) * k))];
        const got = decodeLightmapTexel(r, g, b, a);
        for (let c = 0; c < 3; c++) decMax = Math.max(decMax, Math.abs(ref[c] - got[c]));
      }
      const dir = sunDirFromElAz(base.el, base.az);
      const userLc = computeModelColored(mesh.normals, dir, { ambient: effectiveBakeAmbient(base), sun: effectiveBakeSun(base), shadow: base.shadow, ao: base.ao, sunTint: hx(base.sunTint), skyTint: hx(base.skyTint) });
      const userDisp = bakedLightmapDisplay(userLc);
      const mean3 = (d: Float32Array) => { let t = 0; for (let i = 0; i < d.length; i++) t += d[i]; return t / d.length; };
      const userMean = mean3(userDisp), refMean = mean3(mesh.lightColor!);
      console.log(`  bake-to-bake view: shared-decode Δ ${decMax.toFixed(4)} · user baked-lightmap mean ${userMean.toFixed(3)} vs reference lightmap mean ${refMean.toFixed(3)} (ratio ${(userMean / refMean).toFixed(2)})`);
      if (!(decMax < 1e-6)) { console.error(`SMOKE FAIL: shared decode diverges from the reference's lightmap decode (Δ ${decMax})`); fail = true; }
      if (!(userMean / refMean > 0.6 && userMean / refMean < 1.6)) { console.error(`SMOKE FAIL: user baked-lightmap view is not on the reference's scale (ratio ${(userMean / refMean).toFixed(2)})`); fail = true; }
    }
  }
} else {
  console.log(`ref sun: skipped (no Maps/${REFERENCE_MAP} Lights.json + Patches.json)`);
}

console.log(fail ? '\nSMOKE: FAIL' : '\nSMOKE: PASS');
process.exit(fail ? 1 : 0);
