// tier: fast

/**
 * The two words the editor says about a prop, and the line between them.
 *
 * `describeProp` is the single source of that vocabulary — the selection panel, the prop library's tiles and
 * the Blender add-on all read from it rather than each phrasing its own — so what is worth pinning here is
 * that the SPLIT is on the right property. It is not provenance: a prop built here, one imported from a GLB
 * and one borrowed from a shipped level are told apart by whether their UVs are computed or authored, which
 * is the only thing that predicts whether reshaping is free.
 *
 * That distinction is also load-bearing for the round trip (docs/046) — a tiled prop sends no UV layer at
 * all, a textured one round-trips its layout in both directions — so a rename that quietly moved the line
 * would desynchronise the editor's words from the bridge's behaviour.
 *
 * Run: tsx test/prop-kind.test.ts
 */
import { AUTHORED_MODEL_LEVEL } from '../src/core/doc/models';
import { IMPORTED_PROP_LEVEL } from '../src/core/props/imported';
import { describeProp, editableHere, ownGeometry, propKindOf } from '../src/core/props/kind';
import { check, failures } from './check';

// ---- the line is drawn on UVs, not on where the geometry came from -------------------------------------
check(propKindOf(AUTHORED_MODEL_LEVEL) === 'tiled', 'a prop built with the mesh tools is TILED');
check(propKindOf(IMPORTED_PROP_LEVEL) === 'textured', 'an imported GLB is TEXTURED');
check(propKindOf('MEGAPLE') === 'textured', 'and so is a shipped level’s prop — same kind, different owner');
check(editableHere(AUTHORED_MODEL_LEVEL) && !editableHere(IMPORTED_PROP_LEVEL)
  && !editableHere('MEGAPLE'),
  'only a tiled prop is editable here, because only its mapping survives being recomputed');
check(ownGeometry(AUTHORED_MODEL_LEVEL) && ownGeometry(IMPORTED_PROP_LEVEL) && !ownGeometry('MEGAPLE'),
  'ownership is a SEPARATE axis from kind — two of the three are the author’s, both kinds appear on each side');

// ---- a tiled prop reads in quads and one tile ------------------------------------------------------------
{
  const tiled = describeProp({ level: AUTHORED_MODEL_LEVEL, quads: 6, tile: 'Custom/river.png' });
  check(tiled.label === 'Tiled prop', 'it is labelled a Tiled prop');
  check(tiled.detail === '6 quads · one tile', `and reads "${tiled.detail}"`);
  check(tiled.note.includes('wraps and scrolls') && tiled.note.includes('computed, not stored'),
    'the note says what follows: it wraps, it scrolls, and reshaping is free');
  check(!tiled.readOnly, 'and it is not read-only');

  const clay = describeProp({ level: AUTHORED_MODEL_LEVEL, quads: 1, tile: null });
  check(clay.detail === '1 quad · no tile — clay',
    `an untextured one says so rather than claiming a tile (${clay.detail})`);
}

// ---- a textured prop reads in triangles and materials ----------------------------------------------------
{
  const textured = describeProp({ level: IMPORTED_PROP_LEVEL, tris: 1240, materials: 3 });
  check(textured.label === 'Textured prop', 'an imported model is labelled a Textured prop');
  check(textured.detail === '1,240 tris · 3 materials', `and reads "${textured.detail}"`);
  check(textured.note.includes('own UV layout') && textured.note.includes('Texture Library'),
    'the note says its layout is data, and where its tiles live');
  check(!textured.readOnly, 'an imported record is the author’s, so it is not read-only');

  const one = describeProp({ level: IMPORTED_PROP_LEVEL, tris: 1, materials: 1 });
  check(one.detail === '1 tri · 1 material', `counts are singular when they should be (${one.detail})`);
}

// ---- a shipped prop is the same KIND, and says who owns it -----------------------------------------------
{
  const reference = describeProp({ level: 'MEGAPLE', tris: 350, materials: 2, from: 'MEGAPLE' });
  check(reference.label === 'Textured prop',
    'a borrowed prop is a Textured prop too — provenance is a clause, not an identity');
  check(reference.detail === '350 tris · 2 materials · from MEGAPLE · read-only',
    `with provenance and permission at the END of the line (${reference.detail})`);
  check(reference.readOnly && reference.note.includes('editable copy'),
    'and the note points at the one action that applies to it');
}

// ---- the vocabulary is closed ------------------------------------------------------------------------------
{
  const words = [
    describeProp({ level: AUTHORED_MODEL_LEVEL, quads: 2, tile: 'a/b.png' }),
    describeProp({ level: IMPORTED_PROP_LEVEL, tris: 2, materials: 1 }),
    describeProp({ level: 'DONOR', tris: 2, materials: 1, from: 'DONOR' }),
  ];
  check(new Set(words.map(w => w.label)).size === 2,
    'three sources, two labels — which is the whole point of naming the property instead of the origin');
  check(words.every(w => !/\bmodel\b/i.test(w.label) && !/\bmodel\b/i.test(w.note)),
    'and "model" appears nowhere in what a person reads: it meant both kinds, so it meant neither');
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('prop-kind: all checks passed');
