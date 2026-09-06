// tier: fast

/** Headless semantic-label checks. Run with `npx tsx test/labels.test.ts`. */
import { canonicalJson } from '../src/core/doc/canonical';
import { migrateMountain, meshFromNet, starterCourse } from '../src/core/doc/mountain';
import {
  applyRegisters, documentRegisters, objectRegister, quadRegister, registerShell, writeRegister,
} from '../src/core/doc/registers';
import { serializeMountain } from '../src/core/doc/serialize';
import type { QuadMeshDoc } from '../src/core/doc/types';
import { copyMeshVertices, pasteMeshVertices } from '../src/core/mesh/clipboard';
import {
  applyEdgeExtrusion, applyLoopCut, applyMeshDissolve, applyPatchExtrusion, meshContext, planLoopCut,
} from '../src/core/mesh/ops';
import { INDEX_NAMING } from '../src/core/mesh/selection';
import { check, failures } from './check';

function fixture(): QuadMeshDoc {
  const rows = 4, cols = 4, corners: number[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) corners.push(row * 10, row * 2, col * 10);
  const doc = meshFromNet({ rows, cols, spacing: 10, corners, paint: {} },
    { name: 'LABELS', course: starterCourse(), baseSurface: 1 });
  for (const key of Object.keys(doc)) if ((doc as unknown as Record<string, unknown>)[key] === undefined)
    delete (doc as unknown as Record<string, unknown>)[key];
  doc.labels = [
    { id: 'label:0000', name: 'river', color: '#f06292' },
    { id: 'label:0001', name: 'cliffs', color: '#8d6e63' },
  ];
  doc.quadLabels = { 0: ['label:0000'], 4: ['label:0000', 'label:0001'] };
  doc.props = [{ id: 'prop:0000', level: 'CUSTOM', model: 1, name: 'waterfall', pos: [0, 0, 0], yaw: 0,
    scale: 1, labels: ['label:0000'] }];
  return doc;
}

console.log('\n-- semantic labels --');

// Stable-id storage and load normalization.
{
  const doc = fixture(), stored = serializeMountain(doc);
  check(stored.quadLabels?.[doc.quadIds[0]]?.[0] === 'label:0000',
    'patch membership stores under the stable quad id');
  const loaded = migrateMountain(structuredClone(stored));
  check(canonicalJson(loaded.labels) === canonicalJson(doc.labels)
    && canonicalJson(loaded.quadLabels) === canonicalJson(doc.quadLabels)
    && loaded.props?.[0].labels?.[0] === 'label:0000',
  'definitions, patch membership, and prop membership survive save/load');

  const dangling = structuredClone(stored);
  dangling.quadLabels![doc.quadIds[0]] = ['label:0000', 'label:9999'];
  dangling.props![0].labels = ['label:9999'];
  const cleaned = migrateMountain(dangling);
  check(canonicalJson(cleaned.quadLabels?.[0]) === canonicalJson(['label:0000']) && !cleaned.props?.[0].labels,
    'load removes dangling membership without disturbing valid membership');
}

// Collaboration-register decomposition is lossless and independently addressable.
{
  const doc = fixture(), registers = documentRegisters(doc), shell = registerShell(doc);
  const counts = applyRegisters(shell, registers);
  const same = canonicalJson(shell) === canonicalJson(doc);
  if (!same) {
    const keys = [...new Set([...Object.keys(doc), ...Object.keys(shell)])];
    console.log('register round-trip differs in:', keys.filter(key => canonicalJson((doc as any)[key]) !== canonicalJson((shell as any)[key])).join(', '));
  }
  check(counts.refused === 0 && same,
    'label registers decompose and rebuild the document losslessly');
  check(registers.has(objectRegister('label', 'label:0000'))
    && canonicalJson(registers.get(quadRegister(doc.quadIds[0], 'labels'))) === canonicalJson(['label:0000']),
  'definitions and patch membership have independent registers');
  check(writeRegister(doc, quadRegister(doc.quadIds[1], 'labels'), ['label:0001']) === 'landed'
    && doc.quadLabels?.[1]?.[0] === 'label:0001',
  'a synchronized patch-label assignment lands on the addressed patch');
}

// A split gives each child the source patch's semantic membership.
{
  const doc = fixture(), { mesh, adj } = meshContext(doc);
  const result = applyLoopCut(doc, planLoopCut(mesh, adj, 0, [0, 1]), 0.5);
  check(result.ok, 'labelled loop cut is accepted');
  if (result.ok) {
    const riverPatches = Object.values(result.doc.quadLabels ?? {}).filter(labels => labels.includes('label:0000')).length;
    check(riverPatches === 3, 'both children inherit the split source label while unrelated membership stays put');
  }
}

// Extrusion distinguishes a continued surface from newly generated canyon/mesa walls.
{
  const edgeDoc = fixture(), edge = [edgeDoc.quads[0][0], edgeDoc.quads[0][1]] as [number, number];
  const extended = applyEdgeExtrusion(edgeDoc, [edge], [0, 5, 0]);
  check(extended.ok && extended.doc.quadLabels?.[extended.quads[0]]?.includes('label:0000') === true,
    'boundary continuation inherits its source patch labels');

  const patchDoc = fixture(), lifted = applyPatchExtrusion(patchDoc, [4], [0, 5, 0]);
  const top = lifted.ok ? lifted.topQuads?.[0] : undefined;
  const walls = lifted.ok ? lifted.quads.filter(quad => !lifted.topQuads?.includes(quad)) : [];
  check(lifted.ok && top !== undefined
    && canonicalJson(lifted.doc.quadLabels?.[top]) === canonicalJson(['label:0000', 'label:0001'])
    && walls.every(quad => !lifted.doc.quadLabels?.[quad]),
  'patch-extrusion top inherits labels while generated walls start unlabelled');
}

// A many-face dissolve keeps the union on its single surviving patch.
{
  const doc = fixture();
  doc.quadLabels![1] = ['label:0001'];
  const edge: [number, number] = [doc.quads[0][1], doc.quads[0][3]];
  const result = applyMeshDissolve(doc, { edges: [edge] });
  check(result.ok && canonicalJson(result.doc.quadLabels?.[0]) === canonicalJson(['label:0000', 'label:0001']),
    'dissolve unions the source patches’ labels onto the surviving patch');
}

// Clipboard carries both membership and any definitions the destination lacks.
{
  const source = fixture(), { mesh, edgeHandle } = meshContext(source);
  const clip = copyMeshVertices({
    mesh, edgeHandle, naming: INDEX_NAMING, selectedVertices: source.quads[0], selectedQuads: [0],
    labels: quad => source.quadLabels?.[quad], labelDefinitions: source.labels,
  });
  const destination = fixture(), firstQuad = destination.quads.length;
  delete destination.labels; delete destination.quadLabels;
  const pasted = clip ? pasteMeshVertices(destination, clip) : null;
  check(!!pasted && pasted.doc.labels?.some(label => label.id === 'label:0000') === true
    && pasted.doc.quadLabels?.[firstQuad]?.includes('label:0000') === true,
  'paste restores a copied patch label and its missing definition');

  const collision = fixture();
  collision.labels = [{ id: 'label:0000', name: 'cave' }]; delete collision.quadLabels;
  const remapped = clip ? pasteMeshVertices(collision, clip) : null;
  const river = remapped?.doc.labels?.find(label => label.name === 'river');
  check(!!remapped && river?.id !== 'label:0000'
    && remapped.doc.quadLabels?.[collision.quads.length]?.includes(river!.id) === true,
  'paste remaps a colliding label id instead of attaching membership to the destination’s unrelated label');
}

if (failures) process.exit(1);
console.log('\nLABELS OK\n');
