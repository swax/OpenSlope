// tier: fast

/**
 * Revising a prop into your own library, without changing how it looks.
 *
 * The old revision baked a reference prop into a tiled cage, and the copy arrived as grey clay — a tiled
 * prop computes its mapping as the full 0–1 rect per quad, which is not a mapping any shipped prop has.
 * Measured on GARI's river: each segment spans its tile exactly ONCE across two quads, split at the bend, so
 * the same geometry under the tiled rule would show the texture twice.
 *
 * `recordFromReferenceProp` lands the copy in the TEXTURED lane instead, where every one of those channels
 * has somewhere to go. What this file pins is that it is a RE-PACK and not a conversion:
 *
 *  - not one coordinate, UV or index changes — both sides store model-local raw cm with raw OBJ `vt`;
 *  - the material table survives, renumbered to the local 0…n−1 ids a record must use, with its texture
 *    refs qualified to the level they came from so they still resolve;
 *  - flipbook frames, the alpha-blend flag and any declared motion come across.
 *
 * Together those are what let the placement keep its pose and not so much as twitch when it is repointed.
 *
 * Run: tsx test/prop-adopt.test.ts
 */
import { recordFromReferenceProp, revisedPropName } from '../src/core/props/adopt';
import type { LevelProps, PropModel } from '../src/core/reference/props';
import { check, failures } from './check';

const unpackF32 = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};
const unpackU32 = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64');
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

/**
 * A river segment shaped like the ones actually in GARI: six vertices, two quads, and UVs spanning the tile
 * ONCE across the pair — split at 0.5319824, which is where the real bend falls.
 */
const RIVER_UVS = new Float32Array([
  0, 0, 0, 1, 0.5319824, 0, 0.5319824, 1, 1, 0, 1, 1,
]);
const RIVER_POS = new Float32Array([
  0, 0, 0, 0, 400, 0, 900, 0, 0, 900, 400, 0, 1700, 0, 0, 1700, 400, 0,
]);
const RIVER_IDX = new Uint32Array([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4]);

function riverLevel(): { props: LevelProps; model: PropModel } {
  const model: PropModel = {
    id: 229,
    name: 'Mdl_Water_River_1005',
    subs: [
      { mat: 110, positions: RIVER_POS, uvs: RIVER_UVS, indices: RIVER_IDX },
      // A second submesh on a DIFFERENT material, so the local-id renumbering has something to do.
      { mat: 7, positions: RIVER_POS, uvs: RIVER_UVS, indices: RIVER_IDX, object: 1 },
    ],
  };
  const props: LevelProps = {
    level: 'DONOR',
    models: [model],
    instances: [],
    materials: new Map([
      [110, { tex: '0106.png', frames: ['0106.png', '0107.png'], blend: true }],
      [7, { tex: '0007.png', frames: [] }],
    ]),
    crowdFrames: [],
  } as unknown as LevelProps;
  return { props, model };
}

// ---- naming ---------------------------------------------------------------------------------------------
check(revisedPropName('Rail jump') === 'Rail jump v2'
  && revisedPropName('Rail jump v2') === 'Rail jump v3'
  && revisedPropName('Rail jump v9') === 'Rail jump v10',
  'a revision names itself v2, then climbs — the same rule an authored copy already used');

// ---- the geometry is not touched ---------------------------------------------------------------------------
{
  const { props, model } = riverLevel();
  const { record, tris, materials } = recordFromReferenceProp(props, model, 'River v2');

  check(record.subs.length === 2 && tris === 8, `both submeshes come across (${tris} tris)`);
  check(materials === 2, 'and both materials do');

  const pos = unpackF32(record.subs[0].pos);
  const uv = unpackF32(record.subs[0].uv);
  const idx = unpackU32(record.subs[0].idx);
  check(pos.length === RIVER_POS.length && [...pos].every((v, i) => v === RIVER_POS[i]),
    'every position is byte-identical — both sides store model-local raw cm, so nothing is transformed');
  check(uv.length === RIVER_UVS.length && [...uv].every((v, i) => v === RIVER_UVS[i]),
    'and every UV is too: a shipped prop is already raw OBJ vt, so there is no V to flip');
  check([...idx].join() === [...RIVER_IDX].join(),
    'indices carry unchanged, so the winding — and therefore every normal — is the one that shipped');

  // The property that actually matters, stated the way the river makes it visible.
  // `Math.fround`, because the record stores float32 and the literal here is a double — comparing the two
  // raw would fail on a value that round-tripped perfectly.
  const us = [...uv].filter((_, i) => i % 2 === 0);
  check(Math.abs(Math.max(...us) - 1) < 1e-9 && us.includes(Math.fround(0.5319824)),
    'the tile still spans the segment ONCE, split at the bend — which the tiled rule could not express');
}

// ---- the material table is renumbered but not rewritten ------------------------------------------------------
{
  const { props, model } = riverLevel();
  const { record } = recordFromReferenceProp(props, model, 'River v2');

  check(record.subs.map(s => s.mat).join() === '0,1',
    'material ids become LOCAL 0…n−1, which is what a stored record must carry (docs/032)');
  check(record.materials.map(m => m.id).join() === '0,1', 'and the table is numbered to match');
  check(record.materials[0].tex === 'DONOR/0106.png',
    'a bare shipped ref is qualified to the level it came from, so it still resolves from a record with no level');
  check(record.materials[0].frames?.join() === 'DONOR/0106.png,DONOR/0107.png',
    'flipbook frames are qualified too, and the list still begins at the material’s own tile');
  check(record.materials[0].blend === true, 'the alpha-blend flag survives — it is authored data, not pixels');
  check(record.materials[1].tex === 'DONOR/0007.png' && !record.materials[1].frames,
    'a plain material carries its tile and claims no flipbook');
  check(record.subs[1].object === 1, 'an animated submesh keeps the object it belongs to');
}

// ---- declared motion, and the awkward cases ---------------------------------------------------------------------
{
  const { props, model } = riverLevel();
  props.materials.set(110, {
    ...props.materials.get(110)!,
    scroll: { mode: 0, uPerTick: -0.0225, vPerTick: 0, activeDuration: 1, pauseDuration: 0, lifetime: 0 },
  } as never);
  const withScroll = recordFromReferenceProp(props, model, 'River v2').record;
  check(!!withScroll.materials[0].scroll,
    'a material that declares its own motion brings it — the imported-source case, through the same path');

  const untextured: PropModel = {
    id: 5, name: 'Mdl_Blocker', subs: [{ mat: -1, positions: RIVER_POS, uvs: RIVER_UVS, indices: RIVER_IDX }],
  };
  const clay = recordFromReferenceProp(props, untextured, 'Blocker v2').record;
  check(clay.subs.length === 1 && clay.materials.length === 1 && clay.materials[0].tex === null,
    'an untextured submesh keeps its geometry and gets a real slot with no tile, rather than being dropped');

  const empty = recordFromReferenceProp(props,
    { id: 6, name: 'Mdl_Nothing', subs: [{ mat: 0, positions: new Float32Array(), uvs: new Float32Array(), indices: new Uint32Array() }] },
    'Nothing v2');
  check(empty.record.subs.length === 0 && empty.tris === 0,
    'a submesh with no triangles contributes nothing, so the caller can refuse an empty copy');
}

// ---- the ART comes with it too --------------------------------------------------------------------------
/**
 * `recordFromReferenceProp` above qualifies each ref to the bank it came out of, which resolves and is NOT
 * editable — an extracted level's Textures/ folder is the reference and is never written. So a copy stopping
 * there would be one the author can reshape but never retexture, replace art on, or generate over: half a
 * copy, from a button called "revise".
 *
 * `adoptRecordArt` is the other half, and it runs server-side because reading one bank and writing another
 * is not something core can do. The claim worth measuring is the one the whole eager-copy decision rests on:
 * a page that a dozen shipped props share must land ONE tile, not a dozen copies of itself.
 */
{
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'slopesmith-adopt-'));
  process.env.SLOPESMITH_WORKSPACE_ROOT = root;
  process.env.SLOPESMITH_MAPS_ROOT = root;
  const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
  forgetWorkspaceConfig();

  const { encodePng, decodePng } = await import('../src/server/routes/png');
  const { createProject } = await import('../src/server/projects');
  const { withProjectAssets } = await import('../src/server/project-assets');
  const { adoptRecordArt } = await import('../src/server/props/adopt-art');
  const { readTextureBytes, textureFiles } = await import('../src/server/routes/textures');
  const { defaultMountain } = await import('../src/core/doc/mountain');

  const page = (rgb: [number, number, number]) => {
    const data = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
    return encodePng({ w: 8, h: 8, data });
  };

  try {
    // A reference level's bank, laid out the way an extraction leaves it.
    mkdirSync(join(root, 'DONOR', 'Textures'), { recursive: true });
    writeFileSync(join(root, 'DONOR', 'Textures', '0106.png'), page([200, 40, 40]));
    writeFileSync(join(root, 'DONOR', 'Textures', '0107.png'), page([40, 200, 40]));
    writeFileSync(join(root, 'DONOR', 'Textures', '0007.png'), page([40, 40, 200]));
    const mountain = await createProject({ ...defaultMountain(), name: 'Adopt' });

    const { props, model } = riverLevel();
    const first = recordFromReferenceProp(props, model, 'River v2').record;
    const art = await withProjectAssets(mountain, () => adoptRecordArt(first));
    check(art.staged === 3 && art.missing === 0,
      'adopting stages every ref the record named — its two materials and the flipbook’s second frame');
    check(first.materials[0].tex === 'Custom/DONOR_0106.png' && first.materials[1].tex === 'Custom/DONOR_0007.png',
      'and repoints the record at the copies, named for the SOURCE (one page is worn by many props)');
    check(first.materials[0].frames?.join() === 'Custom/DONOR_0106.png,Custom/DONOR_0107.png',
      'flipbook frames come across too, still headed by the material’s own tile (docs/028)');

    const stored = decodePng(await withProjectAssets(mountain,
      () => readTextureBytes('Custom', 'DONOR_0106.png')));
    check(stored.data[0] === 200 && stored.data[1] === 40,
      'the bytes in the bank are the reference page’s, so the copy looks exactly like what it copied');

    // The fact the eager copy rests on: adopting a SECOND prop off the same atlas spends no new slot.
    const second = recordFromReferenceProp(props, model, 'River v3').record;
    await withProjectAssets(mountain, () => adoptRecordArt(second));
    check(second.materials[0].tex === 'Custom/DONOR_0106.png',
      'a second prop off the same page lands on the tile already there rather than beside it');
    const bank = await withProjectAssets(mountain, () => textureFiles('Custom'));
    check(bank.length === 3,
      `so twelve props off one atlas would still cost one tile (${bank.length} after two adoptions)`);

    // A bank that is not there is not an error: the prop draws against the reference exactly as it did.
    const orphan = recordFromReferenceProp(
      { ...props, level: 'NOSUCHLEVEL' } as typeof props, model, 'River v4').record;
    const lost = await withProjectAssets(mountain, () => adoptRecordArt(orphan));
    check(lost.missing === 3 && orphan.materials[0].tex === 'NOSUCHLEVEL/0106.png',
      'a tile that cannot be read is left pointing where it was — a drawn prop beats a dead ref');

    // An already-adopted record is idempotent: its refs are Custom, so a second pass touches nothing.
    const again = await withProjectAssets(mountain, () => adoptRecordArt(first));
    check(again.staged === 0 && again.missing === 0,
      'and a record whose art is already the mountain’s own stages nothing at all');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('prop-adopt: all checks passed');
