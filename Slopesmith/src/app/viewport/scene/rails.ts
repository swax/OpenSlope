import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Rail, V3 } from '../../../core/doc/types';
import {
  isMotionPath, railHasTube, railStartsOff, railStyle, RAIL_STYLE_ICE, RAIL_STYLE_METAL, RAIL_STYLE_WOOD, sampleRail,
} from '../../../core/rails/rails';
import { railSupportPosts, sweepRail, RAIL_TUBE_RADIUS } from '../../../core/rails/rail-mesh';
import type { PropAssets } from './prop-assets';
import { applyPropShade, disposePropShade, propContactTint, PROP_SHADE_TINT } from './prop-shade';
import type { Stage } from '../stage';
import type { ShadeMode } from '../types';
import { railGuidePalette } from './rail-guide-style';

const RAIL_NODE_GEO = new THREE.SphereGeometry(0.6, 10, 8); // shared node pick bulb
/** Grind-guide stroke width, px (fat lines — LineBasicMaterial is stuck at 1px, like the F overlay).
 *  The selected rail draws a step wider AND a step brighter: on a mountain of grind curves, weight alone is
 *  too close a call at distance, and colour alone is lost where two rails cross. */
const RAIL_GUIDE_WIDTH = 2;
const RAIL_GUIDE_SEL_WIDTH = 3.5;
/**
 * A generated pipe's guide is drawn on the tube's CREST rather than down its axis, which is where its curve
 * actually is. A bare guide stays on its authored curve: with no generated tube to clear, that curve is the
 * intended contact line.
 *
 * The two are the same line to the exporter, but a depth-tested line at the axis is buried inside its own
 * tube and never renders — and depth testing is the point: a rail on the far side of a ridge has to be behind
 * the ridge. Lifting by the tube radius puts it on the surface a rider grinds, where it wins against the tube
 * (with the polygon-offset bias below) and still loses to real terrain in front.
 */
const RAIL_PIPE_GUIDE_LIFT = RAIL_TUBE_RADIUS;
/** Depth bias toward the camera, so the guide beats the tube surface it now grazes without beating terrain. */
const RAIL_GUIDE_DEPTH_BIAS = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
/**
 * userData mark for the rail's SHIPPED geometry — the swept tube and its support posts. Those bake into
 * `Props.obj` beside the props (docs/014), so they read the three shade views exactly as a prop does: real
 * skin in Textured, contact-tinted clay in Surface, triangle wires in Wireframe. Everything else this layer
 * draws — the guide curve, the node pick bulbs — is an editor marker rather than geometry that ships, and
 * keeps its own colour in every view, the way the terrain's own overlays do.
 */
const RAIL_SHADED = 'railShadedGeometry';
/** Feature-edge threshold for the selected rail's amber outline — the same 30° `propEdges` uses, so a rail
 *  and a prop are outlined by one rule. On the pentagon sweep it picks out the five seams down the pipe. */
const RAIL_OUTLINE_ANGLE = 30;

/**
 * Authored course splines (docs/014): grind rails use a swept tube, while Effects-owned motion paths use an
 * editor-only purple line — and every grind rail also wears a surface-coloured centreline in Effects mode, plus at all
 * times when it is BARE and the curve is the only thing there is to see. The colour split is ownership rather
 * than shape (docs/026). Either can expose node pick bulbs under
 * `stage.worldRoot` in data coords. The
 * mechanics (build / dispose / place-handle / select-node / clear) live here; the
 * shell's input dispatch drives them and owns the cross-selection mutual-exclusion (a rail node and a prop /
 * light / gem can't both be selected). Parallels the gems layer — the two share the "Tricks" view filter,
 * which the shell coordinates via each layer's `setVisible`.
 */
export function createRailsLayer(stage: Stage, assets: PropAssets) {
  const railGroup = new THREE.Group();
  const grindGroup = new THREE.Group();
  const motionPathGroup = new THREE.Group();
  railGroup.add(grindGroup, motionPathGroup);
  let rails: Rail[] = [];
  let selectedRail: number | null = null;
  let selectedNode: number | null = null;
  let railArmed = false;                     // the Rails tool is drawing: a props-mode ground click adds a node

  let visible = true;                        // the Tricks view filter (coordinated with the gems by the shell)
  let motionPathsVisible = false;            // Effects-only guide layer; never controlled by Tricks
  let effectRailsVisible = false;            // Effects mode: show every grind rail's curve, not just its tube
  let shade: ShadeMode = 'textured';         // the tube + posts follow the shade view, like the props they bake with
  const railMoveHandle = new THREE.Object3D(); // scene-root gizmo anchor for the selected rail node
  const railMatMetal = new THREE.MeshLambertMaterial({ color: 0x93a9c4, emissive: 0x1a2330 });
  const railMatWood = new THREE.MeshLambertMaterial({ color: 0xb0824e, emissive: 0x2a1c0e });
  const railMatPost = new THREE.MeshLambertMaterial({ color: 0x9b9b9b, emissive: 0x1e1e1e }); // untextured grey, like the baked posts
  let railMatSkin: THREE.MeshLambertMaterial | null = null; // the native red/white rail skin (setSkin)
  const railNodeMat = new THREE.MeshBasicMaterial({ color: 0xffcf6b });
  // Two kinds of spline guide, in two colours because they are two RELATIONSHIPS rather than two shapes.
  // Purple is Effects mode's own colour, worn by everything it owns outright — trigger boxes, fog, and a
  // motion path, which IS its purple line and exists for no other reason. Red/yellow/blue is a grindable curve:
  // belongs to the course, and Effects only switches it on and off. Reading a mountain, the difference
  // answers "can I delete this from here?" before you click anything.
  const motionPathMat = new THREE.LineBasicMaterial({ color: 0xb66cff, transparent: true, opacity: 0.95,
    depthTest: false, depthWrite: false });
  const motionPathNodeMat = new THREE.MeshBasicMaterial({ color: 0xb66cff, depthTest: false });
  // FAT lines, unlike the purple: a grind curve is often the only thing marking a rail (a bare one has no
  // tube at all) and it has to stay findable across a mountain rather than dissolve into the terrain at
  // distance — and `LineBasicMaterial` is stuck at one pixel whatever its linewidth says. DoubleSide because
  // worldRoot's chirality flip inverts the fat-line quads' winding, which would cull the whole guide.
  // Depth-TESTED, unlike the purple motion path: a mountain's worth of grind curves showing through the
  // terrain reads as clutter rather than as information, so a rail behind a ridge sits behind the ridge.
  // Dashed = the curve is not in the rail network as it stands. Selection keeps the surface hue but draws
  // brighter and wider, so colour continues to mean material while dashes continue to mean candidacy.
  const makeGuideMaterial = (style: number, selected: boolean, off: boolean) => new LineMaterial({
    color: railGuidePalette(style)[selected ? 'selected' : 'normal'],
    linewidth: selected ? RAIL_GUIDE_SEL_WIDTH : RAIL_GUIDE_WIDTH,
    transparent: true, opacity: selected ? 1 : 0.95,
    depthWrite: false, side: THREE.DoubleSide, ...RAIL_GUIDE_DEPTH_BIAS,
    ...(off ? { dashed: true, dashSize: 1.2, gapSize: 0.9 } : {}),
  });
  const effectRailMaterials = new Map([RAIL_STYLE_METAL, RAIL_STYLE_WOOD, RAIL_STYLE_ICE].map(style => [style, {
    on: makeGuideMaterial(style, false, false),
    off: makeGuideMaterial(style, false, true),
    selected: makeGuideMaterial(style, true, false),
    selectedOff: makeGuideMaterial(style, true, true),
    node: new THREE.MeshBasicMaterial({ color: railGuidePalette(style).normal, depthTest: false }),
  }] as const));
  const effectRailPalette = (style: number) => effectRailMaterials.get(style) ?? effectRailMaterials.get(RAIL_STYLE_METAL)!;
  const railNodeSelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  /** Arm / disarm rail drawing: while armed, a props-mode click on the terrain appends a node to the rail. */
  function setArmed(on: boolean) { railArmed = on; }

  /** Tricks view filter: show / hide the rails (coordinated with the gems by the shell's showTricks). It
   *  governs the surface-coloured guide curves too, Effects mode or not — a rail is a rail, and the filter is the
   *  author's own "hide the rails" control, so it would be strange for one mode to overrule it. */
  function setVisible(on: boolean) { visible = on; grindGroup.visible = on; }

  /** Effects mode owns invisible motion-path visibility independently of the Tricks grind-rail filter. */
  function setMotionPathsVisible(on: boolean) { motionPathsVisible = on; motionPathGroup.visible = on; }

  /**
   * Effects mode: draw every grind rail's centreline, not only its tube (docs/026).
   *
   * The mode binds toggles and movers to CURVES, so it shows the curves — all of them, rather than marking
   * out the ones something already names. A rail cannot own an effect, so a walk of the join backwards would
   * light up exactly the rails that are already accounted for and leave the ones still waiting to be wired
   * looking like inert scenery, which is the opposite of what an author is hunting for here.
   */
  function setEffectRails(on: boolean) {
    if (effectRailsVisible === on) return;
    effectRailsVisible = on;
    setRails(rails, selectedRail, selectedNode);
  }

  /**
   * The rail tube + support posts follow the shade view like the terrain and the props do.
   *
   * They are the one part of a rail that is real geometry — the same sweep the export bakes into `Props.obj`
   * (docs/014) — so leaving them textured while every prop around them went to clay or to wires made the
   * mountain's own rails the only solid the view could not see through. The guide curve and the node bulbs are
   * markers about the rail rather than the rail, and stay as they are.
   */
  function setShadeMode(m: ShadeMode) {
    if (m === shade) return;
    shade = m;
    // Collect first: `applyPropShade` hangs the wireframe passes off each mesh, and a live traverse would
    // then walk into the children it is in the middle of creating.
    const shaded: THREE.Object3D[] = [];
    grindGroup.traverse(o => { if (o.userData[RAIL_SHADED]) shaded.push(o); });
    for (const mesh of shaded) applyPropShade(mesh, shade);
  }

  /**
   * Mark one piece of a rail's shipped geometry and put it in the active shade view. Fresh meshes are built
   * textured (like the props'), so a rebuild under a non-default view has to catch up here.
   *
   * `solid` is the CONTACT class the Surface view colours by, and it is a real question for a rail: a tube
   * ships as a ghost by default — riders pass straight through it, and the grind is the spline's job either
   * way — while `Rail.solid` gives it a collision model, and the support posts pack solid always (docs/014).
   * The tube is never itself a ride surface, so it takes the obstacle colour rather than a SurfaceType's,
   * which is exactly what a solid prop with no ride surface gets.
   */
  function shadeRailGeometry(mesh: THREE.Mesh, solid: boolean) {
    mesh.userData[RAIL_SHADED] = true;
    mesh.userData[PROP_SHADE_TINT] = propContactTint(solid ? 'solid' : 'through');
    if (shade !== 'textured') applyPropShade(mesh, shade);
  }

  /**
   * The selected rail's shipped geometry wears the SAME amber edge outline a selected prop does.
   *
   * A rail's other selected tells are thin by nature — a curve one step brighter, and node bulbs that may sit
   * off-screen on a long rail — so on a pipe the size of the thing just clicked, neither answers "this one".
   * The outline is the tell that scales with the geometry, and it is already the editor's word for "the object
   * you picked", so a rail and a prop now answer a click the same way. It rides over whatever the shade view
   * has the tube wearing, exactly as a prop's does over its tiles.
   */
  function outlineRailGeometry(g: THREE.Group, geo: THREE.BufferGeometry) {
    const edges = new THREE.EdgesGeometry(geo, RAIL_OUTLINE_ANGLE);
    const line = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(edges), assets.propOutlineMat);
    edges.dispose();
    line.renderOrder = 91;
    line.raycast = () => { /* clicks resolve on the tube / posts, never their outline */ };
    g.add(line);
  }

  /** Rebuild the rail tubes + node pick bulbs from the doc, and keep the selected node's gizmo in sync. A tube
   *  is drawn for every rail with ≥2 nodes; node bulbs are drawn only for the selected rail (so idle courses
   *  stay clean). Parallels setPlacedProps / setFreeLights. */
  function setRails(newRails: Rail[], selRail: number | null, selNode: number | null) {
    for (const group of [grindGroup, motionPathGroup]) {
      for (const c of group.children) disposeRailObject(c);
      group.clear();
    }
    rails = newRails;
    selectedRail = selRail;
    selectedNode = selNode;
    grindGroup.visible = visible;
    motionPathGroup.visible = motionPathsVisible;
    for (let i = 0; i < rails.length; i++) {
      const rail = rails[i];
      (isMotionPath(rail) ? motionPathGroup : grindGroup)
        .add(buildRailObject(rail, i, i === selRail ? selNode : null, i === selRail));
    }
    if (selRail !== null && selNode !== null && rails[selRail]?.nodes[selNode]) {
      if (!(stage.gizmoKind === 'railnode' && stage.gizmo.dragging)) {
        placeRailHandle(selRail, selNode);
        railMoveHandle.visible = true;
        if (stage.gizmoKind !== 'railnode') stage.attachGizmo(railMoveHandle, 'railnode', selNode);
      }
    } else if (stage.gizmoKind === 'railnode') {
      clearSelection();
    }
  }

  /** Register the native rail skin (the donor level's red/white split tube texture, resolved by the host
   *  from the shipped rail models' own material) and re-render: metal rails swap their flat colour for the
   *  textured sweep — the exact tube the export bakes into Props.obj. */
  function setSkin(skin: { level: string; tex: string }) {
    railMatSkin?.dispose();
    railMatSkin = new THREE.MeshLambertMaterial({
      map: assets.propTex.texture(skin.level, skin.tex), side: THREE.DoubleSide });
    setRails(rails, selectedRail, selectedNode);
  }

  /** Select rail `r` node `n`: seat the translate gizmo on its handle and tell the host (which shows the rail's
   *  tools). The shell has already cleared the other scene-object selections before calling this. */
  function seatNode(r: number, n: number) {
    selectedRail = r;
    selectedNode = n;
    placeRailHandle(r, n);
    railMoveHandle.visible = true;
    stage.attachGizmo(railMoveHandle, 'railnode', n);
    stage.cb.onSelectRailNode?.(r, n);
  }

  /** Select a rail with NO node: its pick bulbs come up and the host hears about it, but no gizmo is seated.
   *  Effects mode inspects a grind rail this way — it reports what names the rail without quietly becoming a
   *  second place to move one, which stays Props mode's job. */
  function seatRail(r: number) {
    selectedRail = r;
    selectedNode = null;
    railMoveHandle.visible = false;
    if (stage.gizmoKind === 'railnode') stage.detachGizmo();
    stage.cb.onSelectRailNode?.(r, null);
  }

  /** One rail's Group: the swept tube along its curve — the SAME sweep the export bakes (core/rails/rail-mesh), in
   *  the native red/white skin once it registers (metal/ice; wood stays its flat tint), wearing whatever the shade
   *  view asks for — plus, for the selected rail, an amber edge outline over that geometry and a pick bulb at
   *  each node (the selected node white + larger). Built in data coords under railGroup. */
  function buildRailObject(rail: Rail, index: number, selNode: number | null, showNodes: boolean): THREE.Group {
    const g = new THREE.Group();
    const motionPath = isMotionPath(rail);
    const startsOff = railStartsOff(rail);
    const tube = railHasTube(rail);
    // The surface-coloured centreline belongs to Effects mode, exactly as the reference level's does: it is that mode
    // that binds toggles and movers to curves, and a mountain wearing its whole grind network at all times is
    // clutter in every other mode. The one exception is the SELECTED rail, which is the thing the author
    // picked rather than scenery — and for a bare rail the curve is all there would be to see of it.
    const guide = !motionPath && (effectRailsVisible || showNodes);
    // The Effects palette follows the mode, not the exception: a rail selected in Props view keeps the amber
    // node bulbs it has always had there.
    const effectsPalette = !motionPath && effectRailsVisible;
    const sampled = motionPath || guide ? sampleRail(rail.nodes, 24) : [];
    if (sampled.length >= 2) {
      let line: THREE.Object3D;
      if (motionPath) {
        line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(sampled.map(p => new THREE.Vector3(p[0], p[1], p[2]))),
          motionPathMat);
      } else {
        const geo = new LineGeometry();
        const guideLift = tube ? RAIL_PIPE_GUIDE_LIFT : 0;
        geo.setPositions(sampled.flatMap(p => [p[0], p[1] + guideLift, p[2]]));
        const palette = effectRailPalette(railStyle(rail));
        const fat = new Line2(geo, showNodes
          ? (startsOff ? palette.selectedOff : palette.selected)
          : (startsOff ? palette.off : palette.on));
        fat.computeLineDistances(); // dashes are measured along the curve, not the segment list
        line = fat;
      }
      line.renderOrder = 90;
      line.userData.railIndex = index;
      g.add(line);
    }
    const swept = tube ? sweepRail(rail) : null;
    if (swept) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(swept.positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(swept.uvs, 2));
      geo.setIndex(swept.indices);
      geo.computeVertexNormals();
      const wood = railStyle(rail) === RAIL_STYLE_WOOD;
      const tube = new THREE.Mesh(geo, wood ? railMatWood : (railMatSkin ?? railMatMetal));
      tube.userData.railIndex = index; // a raycast hit resolves the rail straight off the tube (nearest node picked)
      shadeRailGeometry(tube, rail.solid === true);
      g.add(tube);
      if (showNodes) outlineRailGeometry(g, geo);
    }
    if (tube && rail.supports) {
      // the same post geometry the export bakes (core/rails/rail-mesh) - the posts you see are the posts that ship
      const posts = railSupportPosts(rail);
      if (posts) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(posts.positions, 3));
        geo.setIndex(posts.indices);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, railMatPost);
        mesh.userData.railIndex = index; // clicking a post selects its rail, like the tube
        shadeRailGeometry(mesh, true); // posts pack always solid, like the shipped levels' rail supports
        g.add(mesh);
        if (showNodes) outlineRailGeometry(g, geo);
      }
    }
    if (showNodes) {
      for (let n = 0; n < rail.nodes.length; n++) {
        const p = rail.nodes[n];
        const bulb = new THREE.Mesh(RAIL_NODE_GEO, n === selNode ? railNodeSelMat
          : motionPath ? motionPathNodeMat : effectsPalette ? effectRailPalette(railStyle(rail)).node : railNodeMat);
        bulb.scale.setScalar(n === selNode ? 1.7 : 1);
        bulb.position.set(p[0], p[1], p[2]);
        if (motionPath || effectsPalette) bulb.renderOrder = 91;
        bulb.userData.railIndex = index;
        bulb.userData.railNode = n; // a raycast hit resolves the exact node off the bulb
        g.add(bulb);
      }
    }
    return g;
  }

  /** Dispose one rail Group's per-rail tube geometry (materials + the shared node geo are kept). */
  function disposeRailObject(o: THREE.Object3D) {
    disposePropShade(o); // drop the shade view's renderer-only wire passes before their source geometry goes
    o.traverse(n => {
      if ((n instanceof THREE.Mesh || n instanceof THREE.Line)
        && (n.geometry as THREE.BufferGeometry) !== RAIL_NODE_GEO) n.geometry.dispose();
    });
  }

  /** Seat the scene-root gizmo handle on rail `r` node `n` (data pos, Z negated onto the flipped scene). */
  function placeRailHandle(r: number, n: number) {
    const p = rails[r]?.nodes[n];
    if (!p) return;
    railMoveHandle.position.set(p[0], p[1], -p[2]);
  }

  /** The node of rail `r` nearest a data-space point — so clicking a rail's tube grabs the closest node. */
  function nearestNodeOnRail(r: number, p: V3): number {
    const nodes = rails[r]?.nodes ?? [];
    let best = 0, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = (nodes[i][0] - p[0]) ** 2 + (nodes[i][1] - p[1]) ** 2 + (nodes[i][2] - p[2]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** Drop any rail-node selection: hide the handle and release the gizmo if it was on it. */
  function clearSelection() {
    if (selectedRail === null && stage.gizmoKind !== 'railnode') return;
    selectedRail = null;
    selectedNode = null;
    railMoveHandle.visible = false;
    if (stage.gizmoKind === 'railnode') stage.detachGizmo();
  }

  stage.worldRoot.add(railGroup); // grind rails + Effects-only motion guides, in data coordinates
  railMoveHandle.visible = false;
  stage.scene.add(railMoveHandle); // scene-root anchor, Z negated by hand like the other nodes

  return {
    get railGroup() { return railGroup; },
    get rails() { return rails; },
    get selectedRail() { return selectedRail; },
    get selectedNode() { return selectedNode; },
    get railArmed() { return railArmed; },
    /** The grind guides rasterise in pixels, so the shell's resize() feeds them the live canvas resolution. */
    get guideMaterials() {
      return [...effectRailMaterials.values()].flatMap(materials =>
        [materials.on, materials.off, materials.selected, materials.selectedOff]);
    },
    setArmed, setVisible, setMotionPathsVisible, setEffectRails, setShadeMode, setRails, setSkin,
    seatNode, seatRail, nearestNodeOnRail, clearSelection,
  };
}

export type RailsLayer = ReturnType<typeof createRailsLayer>;
