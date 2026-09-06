/** Authored-export reference contract: logical texture provenance and qualified refs.
 * Uses an isolated reference root. Run: `npx tsx test/reference-export.test.ts` */
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, failures, recordFailure } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-reference-export-'));
process.env.SLOPESMITH_MAPS_ROOT = root;
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, '_workspace');
// The author's own tiles are per-mountain assets, not a shared Maps/Custom bank (docs/035). With no HTTP
// request to carry the active project, a direct test opts into one explicit isolated root the same way the
// storage tests do — see `server/project-assets.ts`.
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = join(root, '_assets');

try {
  const { encodePng } = await import('../src/server/routes/png');
  const { defaultMountain } = await import('../src/core/doc/mountain');
  const { createEmptyEffectsDocument } = await import('../src/core/effects/authoring');
  const { resolveTerrainTexRef } = await import('../src/core/paint/textures');
  const { exportLevel } = await import('../src/server/routes/export');
  const { readSlopesmithExportManifest, SLOPESMITH_EXPORT_MANIFEST } =
    await import('../src/server/routes/export-manifest');
  const { readReferenceTextureBytes } = await import('../src/server/routes/textures');
  const { readLevelProps } = await import('../src/server/routes/props');
  const { readReferenceEffects } = await import('../src/server/routes/effects');
  const { buildReferenceMesh, buildReferenceMeshProgressive } = await import('../src/core/reference/terrain');

  const patch = (x: number) => ({
    Points: Array.from({ length: 16 }, (_, index) => {
      const u = Math.floor(index / 4), v = index % 4;
      return [x + u * 100, v * 100, (u + v) * 4];
    }),
    SurfaceType: 0,
    TexturePath: '0012.png',
  });
  const terrainPatches = [patch(0), patch(300)];
  const syncMesh = buildReferenceMesh(terrainPatches);
  let terrainYields = 0;
  const progressiveMesh = await buildReferenceMeshProgressive(terrainPatches, {
    frameBudgetMs: 0,
    yieldControl: async () => { terrainYields++; },
  });
  const sameTyped = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length
    && Array.from(a).every((value, index) => value === b[index]);
  check(terrainYields >= 2 && sameTyped(syncMesh.positions, progressiveMesh.positions)
    && sameTyped(syncMesh.normals, progressiveMesh.normals)
    && sameTyped(syncMesh.indices, progressiveMesh.indices)
    && JSON.stringify(syncMesh.topology) === JSON.stringify(progressiveMesh.topology),
  'progressive reference tessellation yields between chunks without changing mesh identity or topology');

  const png = encodePng({ w: 2, h: 2, data: new Uint8Array([
    10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
  ]) });
  const donor = join(root, 'DONOR');
  mkdirSync(join(donor, 'Textures'), { recursive: true });
  writeFileSync(join(donor, 'Patches.json'), JSON.stringify({
    Patches: [{ SurfaceType: 0, TexturePath: '0012.png' }],
  }));
  writeFileSync(join(donor, 'Textures', '0012.png'), png);
  const custom = join(root, '_assets', 'textures');
  mkdirSync(custom, { recursive: true });
  writeFileSync(join(custom, 'candy.png'), png);

  const doc = defaultMountain();
  doc.name = 'AUTHORED_REF';
  doc.quadTex = { 0: 'Custom/candy.png', 1: 'DONOR/0012.png' };
  const out = join(root, doc.name);
  await exportLevel(doc, { outDir: out, lighting: false });

  const manifest = await readSlopesmithExportManifest(out);
  check(existsSync(join(out, SLOPESMITH_EXPORT_MANIFEST)), 'an export writes Slopesmith.json');
  // How a map is RACED can only travel in the sidecar: retail decides both numbers by the disc slot, so no
  // native file has a field for either (core/doc/race). A mountain that set neither says neither, and inherits
  // whatever slot it is packed onto.
  check(manifest?.laps === undefined && manifest?.showoffSeconds === undefined,
    'a mountain with no authored race settings writes neither into the sidecar');

  const raced = defaultMountain();
  raced.name = 'RACED_REF';
  raced.laps = 3;
  raced.showoffSeconds = 150;
  const racedOut = join(root, raced.name);
  await exportLevel(raced, { outDir: racedOut, lighting: false });
  const racedManifest = await readSlopesmithExportManifest(racedOut);
  check(racedManifest?.laps === 3 && racedManifest?.showoffSeconds === 150,
    'an authored lap count and showoff clock ride out in Slopesmith.json for snowknife to prefer');
  check(manifest?.textures['DONOR_0012.png']?.level === 'DONOR'
    && manifest?.textures['DONOR_0012.png']?.staged === 'DONOR_0012.png',
  'a page lifted from a level ships under a portable slot name and keeps its donor in the manifest');
  check(manifest?.textures['Custom_candy.png']?.level === 'Custom'
    && manifest?.textures['Custom_candy.png']?.staged === 'Custom_candy.png',
  'a custom page records its staged portable copy');
  check(manifest?.provenance?.publicDistribution === 'blocked-retail-derived'
    && manifest.provenance.reasons.includes('retail-texture')
    && manifest.provenance.reasons.includes('user-texture'),
  'the export blocks public staging when it combines retail and user-supplied texture bytes');
  check(racedManifest?.provenance?.publicDistribution === 'allowed'
    && racedManifest.provenance.reasons.length === 0,
  'a procedural authored-only export is machine-classified for public staging');
  check(existsSync(join(out, 'Textures', 'DONOR_0012.png'))
    && existsSync(join(out, 'Textures', 'Custom_candy.png')),
  'export stages both pages for reference use');
  check(resolveTerrainTexRef('AUTHORED_REF', 'DONOR_0012.png') === 'AUTHORED_REF/DONOR_0012.png'
    && resolveTerrainTexRef('AUTHORED_REF', 'Custom/candy.png') === 'Custom/candy.png',
  'terrain refs qualify bare names once and preserve already-qualified dependencies');

  unlinkSync(join(out, 'Textures', 'DONOR_0012.png'));
  check((await readReferenceTextureBytes('AUTHORED_REF', 'DONOR_0012.png')).equals(png),
    'the manifest resolves a missing staged page through the level it came from');
  check((await readReferenceTextureBytes('AUTHORED_REF', 'Custom/candy.png')).equals(png),
    'a qualified texture resolves through the receiver reference library');

  const obsolete = join(root, 'OBSOLETE_FLAT_EXPORT');
  mkdirSync(join(obsolete, 'Textures'), { recursive: true });
  writeFileSync(join(obsolete, 'Patches.json'), JSON.stringify({
    Patches: [{ SurfaceType: 0, TexturePath: '0012.png' }],
  }));
  writeFileSync(join(obsolete, 'Props.obj'), 'o Legacy\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  writeFileSync(join(obsolete, 'Materials.json'), JSON.stringify({
    Materials: [{ TexturePath: 'p_DONOR_0003.png' }],
  }));
  writeFileSync(join(obsolete, 'Effects.json'), JSON.stringify(createEmptyEffectsDocument('OBSOLETE_FLAT_EXPORT')));
  let propsRejected = false, effectsRejected = false, textureRejected = false;
  try { await readLevelProps('OBSOLETE_FLAT_EXPORT'); }
  catch (error) { propsRejected = String(error).includes('no Instances.json'); }
  try { await readReferenceEffects('OBSOLETE_FLAT_EXPORT'); }
  catch (error) { effectsRejected = String(error).includes('no Instances.json'); }
  try { await readReferenceTextureBytes('OBSOLETE_FLAT_EXPORT', '0012.png'); }
  catch (error) { textureRejected = String(error).includes('no reference texture'); }
  check(propsRejected && effectsRejected && textureRejected,
    'an obsolete flattened export is rejected instead of being reconstructed or assigned an inferred donor');

} catch (error) {
  recordFailure();
  console.error(error);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`REFERENCE EXPORT FAIL (${failures})`);
  process.exitCode = 1;
} else {
  console.log('REFERENCE EXPORT PASS');
}
