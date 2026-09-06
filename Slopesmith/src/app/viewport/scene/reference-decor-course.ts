import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { V3 } from '../../../core/doc/types';
import {
  editorFromRaw, referenceSplineIsGrindRail, type RefAiPath, type RefCourseAnchors, type RefSplineRaw,
} from '../../../core/reference/terrain';
import { RAIL_STYLE_ICE, RAIL_STYLE_METAL, RAIL_STYLE_WOOD } from '../../../core/rails/rails';
import { textSprite } from '../shared/overlays';
import type { Stage } from '../stage';
import { railGuidePalette } from './rail-guide-style';

/** Camera-ward depth bias for the true, unshifted grind guides. */
const REF_RAIL_DEPTH_BIAS = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };

/**
 * The reference decor's ROUTE overlays, split out of `reference-decor.ts` because they share none of its
 * live prop/instance registry: the level's recovered main course line (drawn in the authored guide's style,
 * shown with the Info-mode course guide), its AI-path network (AIP.json, on the Info "Show AI paths"
 * toggle), and its GRIND SPLINES (Splines.json, shown throughout Effects mode). All three groups are
 * parented under `stage.refRoot`, so they ride the reference terrain's chirality flip + placement offset
 * like the rest of the reference decoration.
 */
export function createReferenceCourseDecor(stage: Stage) {
  const refCourseGroup = new THREE.Group();      // the level's recovered main course line
  // the SAME course-guide style the authored run draws (green line + dim green path-point beads,
  // viewport.ts / scene/course-markers); what marks this one as the reference's is the missing knot
  // handles — it isn't editable
  const refCourseMat = new THREE.LineBasicMaterial({ color: 0x39b54a });
  const refCourseBeadGeo = new THREE.SphereGeometry(1.6, 8, 6);
  const refCourseBeadMat = new THREE.MeshBasicMaterial({ color: 0x36a746 });
  let refCourseVisible = false;
  const refAiGroup = new THREE.Group();          // the level's AI-path network (AIP.json AIPaths)
  // start paths (StartPosList — one route per race-grid slot) in amber, the same colour the authored AI lines
  // draw in; the rest of the network a violet clearly apart from the course guide's green
  const refAiStartMat = new THREE.LineBasicMaterial({ color: 0xffc24a });
  const refAiMat = new THREE.LineBasicMaterial({ color: 0x9a6bff });
  let refAiVisible = false;
  const refRailGroup = new THREE.Group();        // the level's grind splines (Splines.json)
  // The SAME surface palette an authored grind rail wears, at the same fat-line width (scene/rails.ts), because
  // it is the same thing: a curve the rail query can catch. Metal is red, wood yellow, and ice blue.
  // Depth-TESTED at the spline's TRUE authored coordinates. Retail curves already include their rider clearance
  // above the paired art, so adding the generated pipe radius here made the guide lie about the extracted data.
  // A level's whole rail network showing through the mountain is clutter, hence the retained depth test/bias.
  const makeRefRailMaterial = (style: number, selected: boolean) => new LineMaterial({
    color: railGuidePalette(style)[selected ? 'selected' : 'normal'],
    linewidth: selected ? 3.5 : 2, transparent: true, opacity: selected ? 1 : 0.95,
    depthWrite: false, side: THREE.DoubleSide, ...REF_RAIL_DEPTH_BIAS,
  });
  const refRailMaterials = new Map([RAIL_STYLE_METAL, RAIL_STYLE_WOOD, RAIL_STYLE_ICE].map(style => [style, {
    normal: makeRefRailMaterial(style, false), selected: makeRefRailMaterial(style, true),
  }] as const));
  const refRailMaterial = (style: number, selected: boolean) => {
    const pair = refRailMaterials.get(style) ?? refRailMaterials.get(RAIL_STYLE_METAL)!;
    return selected ? pair.selected : pair.normal;
  };
  let refRailVisible = false;
  let selectedRailSpline: number | null = null;

  /** The reference level's recovered main racing line (its SOP/AIP race lines stitched by descending
   *  DistanceToFinish — the same line "new mountain from this course" sweeps terrain around), drawn over
   *  the reference terrain: the line plus a bead per path point — here the beads are the level's OWN
   *  shipped path vertices, the recovered analogue of the authored guide's exported ~15 m samples.
   *  Points arrive in the level's native editor frame; refRoot supplies the chirality flip + placement
   *  offset, so the route rides the side-by-side toggle with the terrain. Cleared with `null` (a new /
   *  dropped reference). */
  function setCourse(points: V3[] | null, anchors?: RefCourseAnchors | null) {
    for (const c of refCourseGroup.children) {
      if (c instanceof THREE.InstancedMesh) c.dispose(); // the instance-matrix buffer is the mesh's own
      else if (c instanceof THREE.Line) c.geometry.dispose();
      else if (c instanceof THREE.Sprite) c.material.map?.dispose();
      else if (c instanceof THREE.Mesh) c.geometry.dispose();
    }
    refCourseGroup.clear();
    if (points && points.length >= 2) {
      refCourseGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p[0], p[1], p[2]))),
        refCourseMat,
      ));
      const beads = new THREE.InstancedMesh(refCourseBeadGeo, refCourseBeadMat, points.length);
      const m4 = new THREE.Matrix4();
      points.forEach((p, i) => beads.setMatrixAt(i, m4.makeTranslation(p[0], p[1], p[2])));
      beads.instanceMatrix.needsUpdate = true;
      refCourseGroup.add(beads);
    }
    // The level's REAL endpoints, which are not the line's ends: the start is its own hard-coded staging
    // instance, the finish is the DTF=0 crossing (the line overshoots it by 25-61 m), and the podium is the
    // corral past that. Drawn as pillars rather than strips because the recovered line carries no width.
    if (anchors) {
      for (const [pos, color, text] of [
        [anchors.start, 0x41d06a, 'START'],
        [anchors.finish, 0xffffff, 'FINISH'],
        [anchors.podium, 0x8899aa, 'PODIUM'],
      ] as [V3 | null, number, string][]) {
        if (!pos) continue;
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.6, 0.6, 8, 10),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }),
        );
        pillar.position.set(pos[0], pos[1] + 4, pos[2]);
        refCourseGroup.add(pillar);
        const tag = textSprite(text, '#' + color.toString(16).padStart(6, '0'), 18);
        tag.position.set(pos[0], pos[1] + 10, pos[2]);
        refCourseGroup.add(tag);
      }
      // Unlike the roadside signs, these are the actual SOP path stations. Keep every route-specific copy
      // visible; their shared group is what prevents alternate lines from becoming stacked awards at runtime.
      for (const checkpoint of anchors.checkpoints ?? []) {
        const pos = checkpoint.pos;
        const pillar = new THREE.Mesh(
          new THREE.CylinderGeometry(0.45, 0.45, 7, 10),
          new THREE.MeshBasicMaterial({ color: 0xffa83d, transparent: true, opacity: 0.82, depthWrite: false }),
        );
        pillar.position.set(pos[0], pos[1] + 3.5, pos[2]);
        refCourseGroup.add(pillar);
        const minutes = Math.floor(checkpoint.bonusSeconds / 60), seconds = checkpoint.bonusSeconds % 60;
        const tag = textSprite(
          `CP +${minutes}:${String(seconds).padStart(2, '0')} · line ${checkpoint.line + 1}`,
          '#ffbd66', 18,
        );
        tag.position.set(pos[0], pos[1] + 9, pos[2]);
        refCourseGroup.add(tag);
      }
    }
    refCourseGroup.visible = refCourseVisible && refCourseGroup.children.length > 0;
  }

  /** Shown with the course guide (Info mode), like the authored spine + start/finish markers. */
  function showCourse(on: boolean) {
    refCourseVisible = on;
    refCourseGroup.visible = on && refCourseGroup.children.length > 0;
  }

  /** The loaded reference's AI-path network (its AIP.json `AIPaths`, served with the level) drawn over the
   *  terrain: one line per path, `StartPosList` gate paths in amber over the violet network. Points arrive
   *  in the level's native editor frame; refRoot supplies the chirality flip + placement offset, like the
   *  course line. Cleared with `null` (a new / dropped reference). */
  function setAiPaths(paths: RefAiPath[] | null) {
    for (const c of refAiGroup.children) (c as THREE.Line).geometry.dispose();
    refAiGroup.clear();
    if (paths) {
      for (const p of paths) {
        refAiGroup.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(p.points.map(q => new THREE.Vector3(q[0], q[1], q[2]))),
          p.start ? refAiStartMat : refAiMat,
        ));
      }
    }
    refAiGroup.visible = refAiVisible && refAiGroup.children.length > 0;
  }

  /** Shown on the Info "Show AI paths" toggle (independent of the course guide). */
  function showAiPaths(on: boolean) {
    refAiVisible = on;
    refAiGroup.visible = on && refAiGroup.children.length > 0;
  }

  /**
   * The loaded reference's GRIND splines — its `Splines.json` rows selected by the shared style/name candidacy
   * rule, including Alaska's named style-5 IceRails; the same filter the reference test ride grinds by and the
   * same surface palette the authored rails draw (docs/014, docs/026).
   *
   * These are the rails, in the only place a rail actually exists: the tubes are ordinary prop instances
   * that happen to lie along them, joined to nothing. Drawing the curve is therefore the only way to read a
   * shipped level's rail network at all — which of its pipes are catchable, where a grind starts and stops,
   * and which curves have no tube over them. Motion routes (style -1) stay out; they are the mover's own
   * business and are already drawn purple when a mover is inspected.
   *
   * Controls arrive raw (cm, Z-up, X-mirrored) and refRoot supplies the flip + placement offset, like every
   * other reference overlay. Cleared with `null` (a new / dropped reference).
   */
  function setRailSplines(splines: RefSplineRaw[] | null) {
    for (const c of refRailGroup.children) (c as Line2).geometry.dispose();
    refRailGroup.clear();
    for (const spline of splines ?? []) {
      if (!referenceSplineIsGrindRail(spline)) continue;
      const points: number[] = [];
      for (const segment of spline.segments) {
        if (segment.length !== 4) continue;
        const [b0, b1, b2, b3] = segment.map(editorFromRaw);
        // Ten samples a segment, matching the mover's own route line — enough that a shipped rail's bends
        // read as curves rather than chords, and the last point is left to the next segment's first.
        for (let k = 0; k < 10; k++) {
          const t = k / 10, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
          points.push(
            a * b0[0] + b * b1[0] + c * b2[0] + d * b3[0],
            a * b0[1] + b * b1[1] + c * b2[1] + d * b3[1],
            a * b0[2] + b * b1[2] + c * b2[2] + d * b3[2]);
        }
      }
      const last = spline.segments[spline.segments.length - 1];
      if (points.length < 6 || !last || last.length !== 4) continue;
      const tail = editorFromRaw(last[3]);
      points.push(tail[0], tail[1], tail[2]);
      const geometry = new LineGeometry();
      geometry.setPositions(points);
      const line = new Line2(geometry, refRailMaterial(spline.style, spline.originalIndex === selectedRailSpline));
      line.renderOrder = 90; // over the tube it runs through, like the authored centreline
      line.userData.refSplineIndex = spline.originalIndex; // the stable native row, for picking / inspection
      line.userData.refSplineStyle = spline.style;
      refRailGroup.add(line);
    }
    refRailGroup.visible = refRailVisible && refRailGroup.children.length > 0;
  }

  /** Shown throughout Effects mode, beside the authored rails' own surface-coloured curves (viewport.showEffectRails) —
   *  and gated by the reference Tricks filter, which the caller folds in. */
  function showRailSplines(on: boolean) {
    refRailVisible = on;
    refRailGroup.visible = on && refRailGroup.children.length > 0;
  }

  /** Brighten the clicked curve, the way an authored rail brightens when it is the selected one. Swapping the
   *  material rather than rebuilding keeps the geometry (and its pick registration) exactly as it was. */
  function selectRailSpline(originalIndex: number | null) {
    if (selectedRailSpline === originalIndex) return;
    selectedRailSpline = originalIndex;
    for (const child of refRailGroup.children) {
      const line = child as Line2;
      line.material = refRailMaterial(line.userData.refSplineStyle,
        line.userData.refSplineIndex === originalIndex);
    }
  }

  refCourseGroup.visible = false;        // shown with the Info-mode course guide (showCourse)
  stage.refRoot.add(refCourseGroup);     // the recovered course line rides the reference frame too
  refAiGroup.visible = false;            // shown on the Info "Show AI paths" toggle (showAiPaths)
  stage.refRoot.add(refAiGroup);         // the AI network rides the reference frame too
  refRailGroup.visible = false;          // shown throughout Effects mode (showRailSplines)
  stage.refRoot.add(refRailGroup);       // the grind network rides the reference frame too

  return { setCourse, showCourse, setAiPaths, showAiPaths, setRailSplines, showRailSplines, selectRailSpline,
    /** Fat lines rasterise in pixels; the shell's resize() feeds these the live canvas resolution. */
    railSplineMaterials: [...refRailMaterials.values()].flatMap(materials =>
      [materials.normal, materials.selected]),
    /** Pickable in Effects mode: clicking a shipped grind curve inspects the rail it is. */
    get railSplineGroup() { return refRailGroup; } };
}
