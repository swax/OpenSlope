// tier: fast

/**
 * How an authored grind rail READS in the viewport (docs/014). Run: tsx test/rail-visuals.test.ts
 *
 * A rail is two different kinds of thing in one layer, and the split is what these checks pin:
 *
 *  1. **The tube and its support posts are shipped geometry** — the same sweep the export bakes into
 *     `Props.obj` — so they follow the shade view exactly as the props they bake beside do: real skin in
 *     Textured, contact-tinted clay in Surface, triangle wires in Wireframe. A rail left textured under
 *     Wireframe was the mountain's only solid the view could not see through.
 *  2. **The guide curve and the node bulbs are editor markers**, not geometry, so no shade view touches them.
 *
 * And selection: clicking a rail has to answer as loudly as clicking a prop does, which means the amber edge
 * outline over the tube — the brighter red curve and the node bulbs are both too thin to carry it on a pipe
 * the size of the thing just clicked.
 */
import * as THREE from 'three';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createReferenceCourseDecor } from '../src/app/viewport/scene/reference-decor-course';
import { RAIL_GUIDE_PALETTES } from '../src/app/viewport/scene/rail-guide-style';
import { createRailsLayer } from '../src/app/viewport/scene/rails';
import {
  PROP_SOLID_COLOR, PROP_THROUGH_COLOR, propContactTint,
} from '../src/app/viewport/scene/prop-shade';
import {
  railMaterialLabel, RAIL_MATERIAL_OPTIONS, RAIL_STYLE_ICE, RAIL_STYLE_METAL, RAIL_STYLE_WOOD,
} from '../src/core/rails/rails';
import { RAIL_TUBE_RADIUS } from '../src/core/rails/rail-mesh';
import type { Rail } from '../src/core/doc/types';
import { surfaceFor } from '../src/app/ride/physics-math';
import { check, failures } from './check';

const stage: any = {
  worldRoot: new THREE.Group(),
  scene: new THREE.Scene(),
  gizmo: { dragging: false },
  gizmoKind: null,
  attachGizmo(_object: THREE.Object3D, kind: string) { this.gizmoKind = kind; },
  detachGizmo() { this.gizmoKind = null; },
  cb: {},
};
const assets = createPropAssets();
const layer = createRailsLayer(stage, assets);

const piped: Rail = {
  id: 'rail:0000', nodes: [[0, 12, 0], [8, 12, 0], [16, 12, 4]], height: 2, supports: true,
};
const bare: Rail = {
  id: 'rail:0001', nodes: [[0, 6, 20], [10, 6, 20]], height: 2, style: RAIL_STYLE_WOOD, bare: true,
};

/** Every mesh the layer marked as a rail's shipped geometry (the tube + the posts). */
const shipped = (): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  layer.railGroup.traverse(o => { if (o.userData.railShadedGeometry) out.push(o as THREE.Mesh); });
  return out;
};
/** The renderer-only wire passes `applyPropShade` hangs under one shaded mesh. */
const wirePasses = (mesh: THREE.Mesh): THREE.Object3D[] =>
  mesh.children.filter(child => child.userData.propWireframePass === true);
/** The amber selection outlines currently drawn (the shared fat-line material identifies them). */
const outlines = (): THREE.Object3D[] => {
  const out: THREE.Object3D[] = [];
  layer.railGroup.traverse(o => {
    if ((o as THREE.Mesh).material === assets.propOutlineMat) out.push(o);
  });
  return out;
};
/** The node pick bulbs — editor markers, and the thing no shade view may touch. */
const bulbs = (): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  layer.railGroup.traverse(o => { if (Number.isInteger(o.userData.railNode)) out.push(o as THREE.Mesh); });
  return out;
};

console.log('== selection answers on the geometry, not only on the curve ==');

layer.setRails([piped, bare], null, null);
check(shipped().length === 2, `a piped rail with supports draws a tube and its posts (${shipped().length})`);
check(outlines().length === 0, 'an unselected mountain of rails draws no selection outline');

layer.setRails([piped, bare], 0, 1);
check(outlines().length === 2,
  `selecting a rail outlines its tube AND its posts in the props' own amber (${outlines().length})`);
check(outlines().every(line => {
  const hits: THREE.Intersection[] = [];
  line.raycast(new THREE.Raycaster(), hits);
  return hits.length === 0;
}), 'the outline is never a pick target — a click still resolves on the tube underneath it');

// A bare rail has no geometry to outline; the brighter curve remains its whole answer, which is why the
// outline is an addition to the selected look rather than a replacement for it.
layer.setRails([piped, bare], 1, 0);
check(outlines().length === 0 && shipped().length === 2,
  'a selected BARE rail adds no outline — it has no tube, and its curve is all there is to see');

console.log('\n== the tube and posts follow the shade view; the markers do not ==');

layer.setRails([piped, bare], 0, 1);
const [tube] = shipped();
const texturedMaterial = tube.material as THREE.Material;
const bulbMaterials = bulbs().map(bulb => bulb.material);
check(bulbMaterials.length === piped.nodes.length, `the selected rail shows a bulb per node (${bulbMaterials.length})`);

layer.setShadeMode('none');
check(shipped().every(mesh => wirePasses(mesh).length === 2 && wirePasses(mesh).every(pass => pass.visible)),
  'Wireframe gives every piece of shipped rail geometry its hidden + visible wire pass');
check((tube.material as THREE.Material).colorWrite === false
  && tube.userData.texturedMaterial === texturedMaterial,
  'the tube itself becomes a colourless depth fill, with its real skin stashed for the way back');
check(bulbs().every((bulb, i) => bulb.material === bulbMaterials[i] && !wirePasses(bulb).length),
  'the node bulbs are markers, not geometry — Wireframe leaves them exactly as they were');

layer.setShadeMode('surface');
check(shipped().every(mesh => wirePasses(mesh).every(pass => !pass.visible)),
  'leaving Wireframe hides the wire passes rather than rebuilding the rail');
check((tube.material as THREE.MeshLambertMaterial).color.getHex() === PROP_THROUGH_COLOR,
  'Surface reads a default (ghost) tube as ride-through, the contact class it actually bakes with');
const posts = shipped().find(mesh => mesh !== tube)!;
check((posts.material as THREE.MeshLambertMaterial).color.getHex() === PROP_SOLID_COLOR,
  'support posts read as an obstacle — they pack always solid, unlike the tube they hang under');
check(propContactTint('solid') === PROP_SOLID_COLOR && propContactTint('through') === PROP_THROUGH_COLOR,
  'both colours come from the props’ own contact table, so the two layers cannot drift apart');

layer.setShadeMode('textured');
check(tube.material === texturedMaterial, 'Textured hands the rail its real skin back');

console.log('\n== a rebuild under a shade view arrives already wearing it ==');

layer.setShadeMode('none');
layer.setRails([{ ...piped, solid: true }, bare], 0, 1);
const rebuilt = shipped();
check(rebuilt.length === 2 && rebuilt.every(mesh => wirePasses(mesh).length === 2
  && wirePasses(mesh).every(pass => pass.visible) && (mesh.material as THREE.Material).colorWrite === false),
  'rails rebuilt while Wireframe is up are wired on the way in, not one shade toggle later');
check(outlines().length === 2, 'and the selected rail keeps its amber outline over the wires');

layer.setShadeMode('surface');
check(shipped().every(mesh => (mesh.material as THREE.MeshLambertMaterial).color.getHex() === PROP_SOLID_COLOR),
  'a SOLID tube reads as an obstacle in Surface, like the posts beneath it');

console.log('\n== grind guides identify the ridden surface ==');

check([RAIL_STYLE_METAL, RAIL_STYLE_WOOD, RAIL_STYLE_ICE].map(railMaterialLabel).join(',') === 'Metal,Wood,Ice',
  'rail properties name metal, wood, and ice explicitly');
check(JSON.stringify(RAIL_MATERIAL_OPTIONS) === '{"metal":13,"wood":12,"ice":5}',
  'the Props material combo offers metal, wood, then ice');
check([RAIL_STYLE_METAL, RAIL_STYLE_WOOD, RAIL_STYLE_ICE].map(style => surfaceFor(style).target.toFixed(1)).join(',')
  === '16.9,15.1,17.8', 'rail speed properties come from the ridden surface rows');

/** Find the fat guide for one authored rail (excluding its shipped meshes and node bulbs). */
const authoredGuide = (railIndex: number): THREE.Object3D | null => {
  let guide: THREE.Object3D | null = null;
  layer.railGroup.traverse(object => {
    const material = (object as THREE.Mesh).material as THREE.Material & { color?: THREE.Color };
    if (object.userData.railIndex === railIndex && !object.userData.railShadedGeometry
      && !Number.isInteger(object.userData.railNode) && material?.color) guide = object;
  });
  return guide;
};
const guideColor = (object: THREE.Object3D | null): number | null =>
  object ? (((object as THREE.Mesh).material as THREE.Material & { color: THREE.Color }).color.getHex()) : null;
const guideStartY = (object: THREE.Object3D | null): number | null =>
  object ? ((object as THREE.Line).geometry.getAttribute('instanceStart')?.getY(0) ?? null) : null;
layer.setEffectRails(true);
layer.setRails([piped, bare], null, null);
check(guideColor(authoredGuide(0)) === RAIL_GUIDE_PALETTES.metal.normal,
  'an authored metal grind guide stays red');
check(guideColor(authoredGuide(1)) === RAIL_GUIDE_PALETTES.wood.normal,
  'an authored wood grind guide is yellow');
check(Math.abs((guideStartY(authoredGuide(0)) ?? Infinity) - (piped.nodes[0][1] + RAIL_TUBE_RADIUS)) < 1e-6,
  'a generated pipe guide draws at the tube crown');
check(Math.abs((guideStartY(authoredGuide(1)) ?? Infinity) - bare.nodes[0][1]) < 1e-6,
  'a bare guide draws at its true authored contact line');

// Reference splines use the same palette, including the name-recognized style-5 IceRails. Selection brightens
// within the surface hue instead of replacing its material signal.
const refRoot = new THREE.Group();
const reference = createReferenceCourseDecor({ refRoot } as any);
const segment = (x: number) => [[x, 0, 0], [x + 25, 0, 0], [x + 75, 0, 0], [x + 100, 0, 0]];
reference.setRailSplines([
  { originalIndex: 0, name: 'Spline_MetalRail_0', style: RAIL_STYLE_METAL, segments: [segment(0)] },
  { originalIndex: 1, name: 'Spline_WoodRail_0', style: RAIL_STYLE_WOOD, segments: [segment(200)] },
  { originalIndex: 2, name: 'Spline_IceRail_2000', style: RAIL_STYLE_ICE, segments: [segment(400)] },
]);
const referenceGuideColors = () => reference.railSplineGroup.children.map(object =>
  ((object as THREE.Mesh).material as THREE.Material & { color: THREE.Color }).color.getHex());
check(referenceGuideColors().join(',') === [
  RAIL_GUIDE_PALETTES.metal.normal, RAIL_GUIDE_PALETTES.wood.normal, RAIL_GUIDE_PALETTES.ice.normal,
].join(','), 'reference metal, wood, and ice guides draw red, yellow, and blue');
check(reference.railSplineGroup.children.every(object =>
  Math.abs((guideStartY(object) ?? Infinity) - 0) < 1e-6),
  'reference guides draw at the extracted spline height without a tube-radius lift');
reference.selectRailSpline(2);
check(referenceGuideColors()[2] === RAIL_GUIDE_PALETTES.ice.selected,
  'selecting an ice rail keeps it blue and brightens it');

console.log(failures ? `\n${failures} FAILED` : '\nall rail-visual checks passed');
process.exit(failures ? 1 : 0);
