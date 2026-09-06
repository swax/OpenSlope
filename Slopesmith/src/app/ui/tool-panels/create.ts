import { editMesh } from '../../edit/mesh-target';
import { edgeIndices } from '../../state/mesh-names';
import { meshFromDoc } from '../../../core/mesh/topology';
import { measureEdges } from '../../../core/mesh/measure';
import { detail, note, texturePreview, tip } from '../components/gui';
import { buildTrailIntegrationGuide } from './trail-guide';
import { AUTHORED_MODEL_LEVEL } from '../../../core/doc/models';
import { orientText } from '../../../core/paint/orientation';
import { describeProp } from '../../../core/props/kind';
import { textureRefUrl } from '../../net/asset-paths';
import { fmtM, type ToolsContext } from './widgets';

/**
 * The Edit-mode creation tools: Create Edge (mesh-native drawing and surface cuts), Create Patch, the armed
 * Loop Cut panel, and the two-endpoint elliptical tube draft. Owns the cached live-measurement rows (total /
 * next / step read-outs) that the viewport's preview listeners refresh on pointer moves without rebuilding
 * lil-gui; the coordinator calls reset() at the top of every toolbox rebuild so a stale row is never touched.
 */
export function createCreateTools(ctx: ToolsContext) {
  const { store, viewport, editSection, edit, cageActive, rebuildTools, updateCmdSheet, modelEdit } = ctx;
  const {
    armCreateEdge, armCreatePatch, finishCreatePatch, finishCreateEdge,
    armCreateTube, previewCreateTube, finishCreateTube, cancelCreateTube,
    armCreateTrail, previewCreateTrail, undoCreateTrailPoint, finishCreateTrail, cancelCreateTrail,
  } = edit;

  let createEdgeTotalRow: ReturnType<typeof detail> | null = null;
  let createEdgeNextRow: ReturnType<typeof detail> | null = null;
  let createPatchStepRow: ReturnType<typeof detail> | null = null;
  let createPatchNextRow: ReturnType<typeof detail> | null = null;
  let createTubeStepRow: ReturnType<typeof detail> | null = null;
  let createTubeLengthRow: ReturnType<typeof detail> | null = null;
  let createTubeSectionsRow: ReturnType<typeof detail> | null = null;
  let createTubePatchesRow: ReturnType<typeof detail> | null = null;
  let createTrailPointsRow: ReturnType<typeof detail> | null = null;
  let createTrailNextRow: ReturnType<typeof detail> | null = null;
  let createTrailSpansRow: ReturnType<typeof detail> | null = null;
  let createTrailPatchesRow: ReturnType<typeof detail> | null = null;
  let createEdgeCommittedLength = 0;

  /** Drop the cached row controllers before the toolbox is cleared; the builders recreate the ones their
   *  panel shows, so the refresh functions only ever touch live controllers. */
  function reset() {
    createEdgeTotalRow = null;
    createEdgeNextRow = null;
    createPatchStepRow = null;
    createPatchNextRow = null;
    createTubeStepRow = null;
    createTubeLengthRow = null;
    createTubeSectionsRow = null;
    createTubePatchesRow = null;
    createTrailPointsRow = null;
    createTrailNextRow = null;
    createTrailSpansRow = null;
    createTrailPatchesRow = null;
    createEdgeCommittedLength = 0;
  }

  /** The "Editing <prop>" session banner: what KIND of prop this is, then rename, retexture, turn its tile,
   *  leave, or revise it. Everything below it (create edge / patch / tube, selection ops) authors that
   *  model's polygons. */
  function buildModelBanner() {
    if (!store.modelEditId) return;
    const g = editSection('model-session', `Editing ${modelEdit.activeName() ?? 'prop'}`);
    const binding = { name: modelEdit.activeName() ?? '' };
    tip(g.add(binding, 'name').onFinishChange((value: string) => {
      modelEdit.rename(value); rebuildTools();
    }), 'The prop’s name — how its placements list in the prop library.');
    // WHAT you are editing, in the vocabulary the whole editor uses for it (core/props/kind.ts): the mesh
    // tools are open on this prop for a reason, and the reason is that it is TILED. Said here because this is
    // the panel you are looking at while wondering why the texture is one swatch rather than a UV layout —
    // and because the same words on the library tile and the selection panel are only worth anything if the
    // session states them too.
    const texture = modelEdit.activeTexture();
    const kind = describeProp({
      level: AUTHORED_MODEL_LEVEL, quads: modelEdit.activeQuads(), tile: texture,
    });
    tip(detail(g, kind.detail, kind.label.toLowerCase()), kind.note);
    // The tile as a picture, not a ref to be typed: clicking the swatch raises the Texture Library at the
    // bottom in pick mode, where the choice is made by looking at the art (see modelEdit.pickTexture). The
    // swatch is drawn at the model's own D4, so it is a picture of what the prop is actually wearing.
    const orient = modelEdit.activeOrient();
    // Every quad wears the full tile, wrapping continuously — exactly what a UV-scroll effect needs. The
    // library offers every level's bank plus Custom art, with a "no texture" cell to clear back to clay.
    texturePreview(g, {
      label: 'texture',
      src: texture ? textureRefUrl(texture) : null,
      value: texture || 'No texture — untextured clay',
      hint: 'Click to choose a tile from the Texture Library, or clear it back to clay.',
      onOpen: () => modelEdit.pickTexture(),
      orient,
    });
    // Turning the tile is one gesture across the editor — ← / → with ⇧ to mirror (docs/005) — so the buttons
    // name the keys rather than replacing them. Offered only with a tile on: clay has nothing to turn.
    if (texture) {
      // One orientation state for the whole prop: a tiled prop computes its mapping rather than storing one,
      // so the preview, its placements and the export all wear the tile the same way. Mirror is a separate
      // act rather than a fifth step of the turn — mirrored tiles are essentially unused in the original
      // game, so nothing should cycle into one by accident.
      tip(detail(g, orientText(orient.rot, orient.mirror), 'tile turn'),
        'How the tile sits on every quad — one state for the whole prop.');
      tip(g.add({ turn: () => modelEdit.turnTexture(-1, false) }, 'turn').name('↻ turn tile (→)'),
        'Turn the tile a quarter clockwise — the same as → in Paint mode.');
      tip(g.add({ turn: () => modelEdit.turnTexture(1, false) }, 'turn').name('↺ turn tile (←)'),
        'Turn the tile a quarter anticlockwise.');
      tip(g.add({ flip: () => modelEdit.turnTexture(1, true) }, 'flip').name('⇋ mirror tile (⇧←)'),
        'Flip the tile, holding its rotation.');
    }
    const actions = editSection('model-actions', 'Prop');
    if (store.modelEditLocked) {
      tip(actions.add({ done: modelEdit.exit }, 'done').name('✔ done editing'),
        'Give up the lock and return to the terrain; the prop keeps every change.',
        'Edits are live and undo covers them. Esc (with nothing selected) unlocks first; a second Esc leaves.');
    } else {
      tip(actions.add({ deselect: modelEdit.exit }, 'deselect').name('deselect prop (Esc)'),
        'Return to the terrain — same as clicking off the prop. It keeps every change.');
      tip(actions.add({ lock: () => { store.modelEditLocked = true; rebuildTools(); } }, 'lock').name('🔒 lock session'),
        'Pin the session so clicks off the prop no longer leave it; ✔ done editing is the way out.');
    }
    // The escape hatch, at the moment it is reached for: the mesh tools have run out on this piece, so hand
    // the cage to Blender and take the result back onto this same prop (docs/046).
    if (modelEdit.canSendToBlender()) {
      tip(actions.add({ blender: modelEdit.sendToBlender }, 'blender').name('⬈ edit in Blender'),
        'Take this cage to Blender, then push the result back onto this prop.',
        'It comes back as quads, keeping every placement. With blender/slopesmith_bridge.py installed, Pull '
        + 'from Blender’s own Slopesmith panel; this button downloads the same prop as a GLB for anything else.');
    }
  }

  /** Mesh-native edge drawing. Each click after the first commits another free edge and advances the chain. */
  function buildCreateEdgeTools() {
    buildModelBanner();
    const active = store.createEdgeTool || store.surgeryTool === 'patch' || store.surgeryTool === 'loopcut';
    // In a model edit session the geometry tools grow the MODEL, not the mountain — the title says so.
    const g = editSection(active ? 'active-create' : 'create', store.createEdgeTool ? 'Create Edge'
      : store.surgeryTool === 'patch' ? 'Create Patch' : store.surgeryTool === 'loopcut' ? 'Loop Cut'
      : store.modelEditId ? 'Add to Prop' : 'Create Terrain');
    if (store.surgeryTool === 'loopcut') {
      note(g, 'hover a surface edge · scroll to position the cut · click to commit');
      const actions = editSection('tool-actions', 'Actions');
      tip(actions.add({ cancel: () => {
        store.surgeryTool = null; viewport.setSurgeryTool(null); rebuildTools(); updateCmdSheet();
      } }, 'cancel').name('cancel loop cut (Esc)'), 'Leave Loop Cut without changing the mountain.');
      return;
    }
    if (store.createEdgeTool) {
      if (store.createEdgeChain.length) {
        const doc = editMesh(store);
        const { mesh, edgeHandle } = meshFromDoc(doc);
        createEdgeCommittedLength = measureEdges(mesh, edgeHandle, edgeIndices(doc, store.createEdgeChain))?.total ?? 0;
      }
      detail(g, store.createEdgeStart
        ? store.createEdgeSurfacePath.length
          ? `${store.createEdgeSurfacePath.length - 1} provisional segment${store.createEdgeSurfacePath.length === 2 ? '' : 's'} · continue to another edge or point`
          : `${store.createEdgeChain.length} edge${store.createEdgeChain.length === 1 ? '' : 's'} · click the next endpoint`
        : 'click the first endpoint');
      createEdgeTotalRow = tip(detail(g, fmtM(0), 'total'),
        'Live chain length: all committed segments plus the segment currently previewed under the cursor.');
      createEdgeNextRow = tip(detail(g, '—', 'next'),
        'Length of the purple preview segment from the last placed endpoint to the cursor.');
      refreshCreateEdgeSummary();
      if (store.createEdgeSurfacePath.length) {
        note(g, 'provisional surface cut · continue to another edge or point · Esc discards it');
      } else {
        note(g, 'start or end on any edge · Shift locks free edges to a world axis · Enter / Esc finishes',
          'Only crossed patches are bisected; an endpoint inside a shared edge leaves the neighboring patch '
          + 'untouched and intentionally remains a red T-junction.');
      }
      const actions = editSection('tool-actions', 'Actions');
      actions.add({ done: finishCreateEdge }, 'done').name('✔ finish edge chain (Enter / Esc)');
      return;
    } else if (store.surgeryTool === null) {
      tip(g.add({ add: armCreateEdge }, 'add').name('╱ create edge (L)'),
        'Draw free edges, or cut a surface between points on existing edges.',
        'Only crossed patches are bisected; an endpoint inside a shared edge leaves the neighboring patch '
        + 'untouched and shows as a red T-junction when the chain finishes.');
      tip(g.add({ tube: armCreateTube }, 'tube').name('◯ create tube'),
        'Draw two endpoints for an open elliptical tube, then shape it before committing.');
      if (!store.modelEditId) tip(g.add({ trail: armCreateTrail }, 'trail').name('⌁ create trail'),
        'Draw a centre spline and generate a banked trail from rules measured off the reference maps.');
      // Prop creation is its own panel: a prop is separate grouped geometry, never part of the mountain.
      if (!store.modelEditId) {
        const propSection = editSection('create-prop', 'Create Prop');
        tip(propSection.add({ model: modelEdit.create }, 'model').name('▣ create tiled prop'),
          'Name a new prop and build it with these same tools.',
          'It wears one tile with the mapping computed per quad, so reshaping is free and the texture wraps '
          + 'and scrolls unbroken. Its geometry is its own — never part of the mountain — and it places from '
          + 'the library and carries effects like any other prop.');
      }
    }
    if (!cageActive()) return;
    if (store.surgeryTool === 'patch') {
      const actions = editSection('tool-actions', 'Actions');
      tip(actions.add({ done: () => finishCreatePatch(true) }, 'done').name('✔ finish + select patches (Enter)'),
        'Finish creating and select every patch made during this Create Patch session.');
      tip(actions.add({ keep: () => finishCreatePatch(false) }, 'keep').name('finish · keep unselected (Esc)'),
        'Finish creating, keep every completed patch, and return without selecting them.');
      tip(g.add(store, 'createPatchSides', { quad: 4, triangle: 3 }).name('shape').onChange((value: number | string) => {
        store.createPatchSides = Number(value) === 3 ? 3 : 4;
        viewport.setCreatePatchSides(store.createPatchSides);
        rebuildTools(); updateCmdSheet();
      }), 'Choose a four-corner quad or three-corner triangle. Changing shape clears only the unfinished corner sequence.');
      detail(g, `${store.createPatchQuads.length}`, 'created');
      createPatchStepRow = detail(g, `0 / ${store.createPatchSides}`, 'corners');
      createPatchNextRow = tip(detail(g, '—', 'next'),
        'Straight-line distance from the last placed corner to the corner previewed under the cursor.');
      refreshCreatePatchSummary();
      note(g, `each ${store.createPatchSides === 3 ? 'third' : 'fourth'} corner commits and starts another${store.createPatchSides === 4 ? ' · after three corners, click any one again to close a triangle' : ''} · Enter = finish + select all · Esc = finish without selecting`);
    } else { // 'tube' or none — loop cut armed already returned above with its own panel
      tip(g.add({ patch: armCreatePatch }, 'patch').name('▱ create patch (P)'),
        'Create patches by clicking their corners in perimeter order.',
        'Click terrain, empty space, or existing vertices to fill between them. In Quad mode, click any of '
        + 'the first three corners again to close them as a triangle. Shift locks the next side to a world axis.');
    }
  }

  function buildCreateTubeTools() {
    const placement = editSection('tube-placement', 'Placement');
    const points = viewport.createTubePoints;
    createTubeStepRow = detail(placement, `${points.length} / 2`, 'endpoints');
    createTubeLengthRow = detail(placement, '—', 'length');
    refreshCreateTubeSummary();
    note(placement, points.length < 2
      ? 'click the first and second endpoints · Shift locks the tube axis to world X, Y, or Z'
      : 'adjust the elliptical cross-section, ring edges, and section length · Enter creates and selects the tube');
    const dimensions = editSection('tube-dimensions', 'Dimensions');
    const refresh = () => {
      const result = previewCreateTube();
      createTubeSectionsRow?.setValue(result?.ok ? `${result.axialSections} along × ${result.radialSections} around` : '—');
      createTubePatchesRow?.setValue(result?.ok ? `${result.quads.length}` : '—');
      refreshCreateTubeSummary();
      return result;
    };
    tip(dimensions.add(store, 'tubeWidth', 0.5, 500, 0.5).name('width diameter (m)').onChange(refresh),
      'Full side-to-side diameter of the elliptical tube.');
    tip(dimensions.add(store, 'tubeHeight', 0.5, 500, 0.5).name('height diameter (m)').onChange(refresh),
      'Full vertical diameter. Height follows world-up projected perpendicular to the drawn tube axis.');
    tip(dimensions.add(store, 'tubeSectionLength', 0.5, 200, 0.5).name('section length (m)').onChange(refresh),
      'Target quad length along the drawn tube axis. Slopesmith adds enough rings to stay near this length.');
    tip(dimensions.add(store, 'tubeRingEdges', 3, 64, 1).name('ring edges').onChange(refresh),
      'Number of edges around each cross-section ring. Four is the default; increase it for a rounder tube.');
    createTubeSectionsRow = detail(dimensions, '—', 'sections');
    createTubePatchesRow = detail(dimensions, '—', 'quad patches');
    const preview = refresh();
    const ready = preview?.ok === true;
    const actions = editSection('tool-actions', 'Actions');
    const commit = tip(actions.add({ create: finishCreateTube }, 'create').name('✔ create tube (Enter)'),
      preview && !preview.ok ? preview.error : ready ? 'Commit the teal preview and select all of its quad patches.' : 'Draw both endpoints before creating the tube.');
    if (!ready) commit.disable();
    tip(actions.add({ cancel: cancelCreateTube }, 'cancel').name('cancel tube (Esc)'),
      'Discard the endpoints and preview without changing the mountain.');
  }

  function buildCreateTrailTools() {
    const placement = editSection('trail-placement', 'Centre Spline');
    createTrailPointsRow = detail(placement, `${viewport.createTrailPoints.length}`, 'knots');
    createTrailNextRow = detail(placement, '—', 'next');
    refreshCreateTrailSummary();
    note(placement, 'click to add knots · Shift locks the next segment to world X, Y, or Z · surface clicks are lifted above the patch beneath them');

    const dimensions = editSection('trail-shape', 'Trail Shape');
    const refresh = () => {
      const result = previewCreateTrail();
      createTrailSpansRow?.setValue(result?.ok ? `${result.spans.length}` : '—');
      createTrailPatchesRow?.setValue(result?.ok ? `${result.quads.length}` : '—');
      refreshCreateTrailSummary();
      return result;
    };
    // Every station has left, centre, and right rails, producing exactly two patches across.
    tip(dimensions.add(store, 'trailWidth', 2, 100, 0.5).name('target width (m)').onChange(refresh),
      'Rim-to-rim plan width; the measured Mesa default is 13 m.');
    tip(dimensions.add(store, 'trailPatchLength', 2, 100, 0.5).name('target length (m)').onChange(refresh),
      'Maximum ordinary patch length along the spline. Tight turns are automatically subdivided more finely.');
    tip(dimensions.add(store, 'trailDishPercent', 0, 30, 0.5).name('centre dish (%)').onChange(refresh),
      'How far the centre seam sits below the banked rim chord, as a percentage of full width. Mesa measures about 10.5%.');
    tip(dimensions.add(store, 'trailCenterBias', 0.25, 0.75, 0.01).name('centre seam').onChange(refresh),
      'Position of the centre seam across the width. 0.5 makes equal left and right patches.');
    tip(dimensions.add(store, 'trailMaxTurnDegrees', 5, 120, 1).name('max turn / patch').onChange(refresh),
      'Adaptive curvature threshold. Lower values create more, shorter patches through turns.');

    const banking = editSection('trail-banking', 'Banking');
    tip(banking.add(store, 'trailBankGain', 0, 100, 0.5).name('banking amount').onChange(refresh),
      'Strength of automatic curvature banking. Zero keeps the rim chord level; the measured default is 15 m.');
    tip(banking.add(store, 'trailMaxBankDegrees', 0, 60, 1).name('max bank (deg)').onChange(refresh),
      'Absolute bank clamp. Banking ramps between stations to avoid abrupt cross-slope changes.');
    tip(banking.add(store, 'trailSurfaceLift', 0, 5, 0.05).name('surface lift (m)').onChange((value: number) => {
      viewport.setCreateTrailSurfaceLift(value);
    }), 'Vertical offset applied when a NEW spline knot is clicked on an existing patch or vertex. Free-space knots are unchanged.');
    tip(banking.add(store, 'trailMesaTextures').name('Mesa trail textures').onChange(refresh),
      'Apply matched left/right Mesa trail tiles, switching to the tight-turn stripe set where curvature calls for it.');
    createTrailSpansRow = detail(banking, '—', 'lengthwise spans');
    createTrailPatchesRow = detail(banking, '—', 'quad patches');

    const preview = refresh();
    const ready = preview?.ok === true;
    const actions = editSection('tool-actions', 'Actions');
    const commit = tip(actions.add({ create: finishCreateTrail }, 'create').name('✔ create trail (Enter)'),
      preview && !preview.ok ? preview.error : ready
        ? 'Commit the teal preview and select all generated trail patches.'
        : 'Place at least two centre-spline knots before creating the trail.');
    if (!ready) commit.disable();
    const undo = tip(actions.add({ undo: undoCreateTrailPoint }, 'undo').name('undo last knot (Backspace)'),
      'Remove the last centre-spline knot without leaving Create Trail.');
    if (!viewport.createTrailPoints.length) undo.disable();
    tip(actions.add({ cancel: cancelCreateTrail }, 'cancel').name('cancel trail (Esc)'),
      'Discard the spline and preview without changing the mountain.');
    // Committing the ribbon is only the first of six steps; the rest run in other tools (see trail-guide).
    buildTrailIntegrationGuide(editSection);
  }

  /** Refresh the two live measurement rows without rebuilding lil-gui on every pointer move. */
  function refreshCreateEdgeSummary() {
    if (!createEdgeTotalRow || !createEdgeNextRow || !store.createEdgeTool) return;
    const start = store.createEdgeStart?.pos, hover = viewport.createEdgePreviewPoint;
    const next = start && hover
      ? Math.hypot(hover[0] - start[0], hover[1] - start[1], hover[2] - start[2])
      : null;
    createEdgeNextRow.setValue(next === null ? '—' : fmtM(next));
    createEdgeTotalRow.setValue(fmtM(createEdgeCommittedLength + (next ?? 0)));
  }

  function refreshCreatePatchSummary() {
    if (!createPatchStepRow || !createPatchNextRow || store.surgeryTool !== 'patch') return;
    const points = viewport.createPatchPoints, start = points.at(-1), hover = viewport.createPatchPreviewPoint;
    const next = start && hover
      ? Math.hypot(hover[0] - start[0], hover[1] - start[1], hover[2] - start[2])
      : null;
    createPatchStepRow.setValue(`${points.length} / ${store.createPatchSides}`);
    createPatchNextRow.setValue(next === null ? '—' : fmtM(next));
  }

  function refreshCreateTubeSummary() {
    if (!createTubeStepRow || !createTubeLengthRow || store.surgeryTool !== 'tube') return;
    const points = viewport.createTubePoints;
    const end = points[1] ?? viewport.createTubePreviewPoint;
    const length = points[0] && end
      ? Math.hypot(end[0] - points[0][0], end[1] - points[0][1], end[2] - points[0][2])
      : null;
    createTubeStepRow.setValue(`${points.length} / 2`);
    createTubeLengthRow.setValue(length === null ? '—' : fmtM(length));
  }

  function refreshCreateTrailSummary() {
    if (!createTrailPointsRow || !createTrailNextRow || store.surgeryTool !== 'trail') return;
    const points = viewport.createTrailPoints, start = points.at(-1), hover = viewport.createTrailPreviewPoint;
    const next = start && hover
      ? Math.hypot(hover[0] - start[0], hover[1] - start[1], hover[2] - start[2])
      : null;
    createTrailPointsRow.setValue(`${points.length}`);
    createTrailNextRow.setValue(next === null ? '—' : fmtM(next));
  }

  return {
    reset, buildCreateEdgeTools, buildCreateTubeTools, buildCreateTrailTools,
    refreshCreateEdgeSummary, refreshCreatePatchSummary, refreshCreateTubeSummary, refreshCreateTrailSummary,
  };
}
