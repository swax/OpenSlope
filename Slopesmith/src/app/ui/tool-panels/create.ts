import { editMesh } from '../../edit/mesh-target';
import { edgeIndices } from '../../state/mesh-names';
import { meshFromDoc } from '../../../core/mesh/topology';
import { measureEdges } from '../../../core/mesh/measure';
import { detail, errorBanner, note, texturePreview, tip } from '../components/gui';
import { buildTrailIntegrationGuide } from './trail-guide';
import { AUTHORED_MODEL_LEVEL } from '../../../core/doc/models';
import { orientText } from '../../../core/paint/orientation';
import { describeProp } from '../../../core/props/kind';
import { textureRefUrl } from '../../net/asset-paths';
import { fmtM, pathHandleActions, type ToolsContext } from './widgets';
import type { TrailKnotSettings, TrailSettings } from '../../../core/doc/types';
import { TRAIL_SETTINGS_DEFAULTS } from '../../../core/mesh/trail-object';

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
    armCreateTube, previewCreateTube, finishCreateTube, cancelCreateTube, armLoopCut,
    armCreateTrail, undoCreateTrailPoint, finishCreateTrail,
    selectedTrail, trailStatus, trailError, resumeTrail, setTrailSetting,
    deleteSelectedTrailKnot, deleteSelectedTrail, dissolveSelectedTrail, selectOverlappingVertices, deselectEdit,
    selectedTrailKnot, setTrailKnotSetting, resetTrailKnotSettings, resumeEnds, trailDrawEnd,
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
  let createTrailErrorBanner: HTMLElement | null = null;
  let createTrailKnotBankRow: ReturnType<typeof detail> | null = null;
  let createTrailKnotSection: ReturnType<typeof editSection> | null = null;
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
    createTrailErrorBanner = null;
    createTrailKnotBankRow = null;
    createTrailKnotSection = null;
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
      note(g, 'hover a surface edge · Alt+scroll slides the cut · click to cut · stays armed for the next');
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
      if (store.createEdgeSurfacePath.length > 1) {
        note(g, 'provisional surface cut · continue to another edge or point · Esc discards it');
      } else {
        note(g, 'the first point sticks to a vertex, edge or the surface · after it, hold Ctrl to stick · Shift locks free edges to a world axis · Enter / Esc finishes',
          'After the first point a free point stays at the chain depth, so nearby corners, edges and terrain behind '
          + 'the cursor never pull it away; hold Ctrl to end on a vertex, cut to an edge or drop onto the surface. '
          + 'A cut already across a patch keeps sticking, since only an edge or point can continue it. Only crossed '
          + 'patches are bisected; an endpoint inside a shared edge leaves the neighboring patch untouched and '
          + 'intentionally remains a red T-junction.');
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
      note(g, `each ${store.createPatchSides === 3 ? 'third' : 'fourth'} corner commits and starts another${store.createPatchSides === 4 ? ' · after three corners, click any one again to close a triangle' : ''} · Ctrl puts a corner on the surface · Enter = finish + select all · Esc = finish without selecting`);
    } else { // 'tube' or none — loop cut armed already returned above with its own panel
      tip(g.add({ patch: armCreatePatch }, 'patch').name('▱ create patch (P)'),
        'Create patches by clicking their corners in perimeter order.',
        'Click existing vertices, terrain, or empty space to fill between them — after the first corner a free '
        + 'corner stays at the last corner\'s depth, and Ctrl puts it on the surface. In Quad mode, click any of '
        + 'the first three corners again to close them as a triangle. Shift locks the next side to a world axis.');
      tip(g.add({ loop: armLoopCut }, 'loop').name('⫼ loop cut (Ctrl+R)'),
        'Cut a new edge loop across a strip of patches: hover an edge, Alt+scroll to slide, click to cut.',
        'The loop runs through opposite edges until it reaches the rim, closes into a ring, or meets a pole; '
        + 'each crossed patch splits in two, and the new points sit on the curved edges so the shape holds.');
    }
  }

  function buildCreateTubeTools() {
    const placement = editSection('tube-placement', 'Placement');
    const points = viewport.createTubePoints;
    createTubeStepRow = detail(placement, `${points.length} / 2`, 'endpoints');
    createTubeLengthRow = detail(placement, '—', 'length');
    refreshCreateTubeSummary();
    note(placement, points.length < 2
      ? 'click the first and second endpoints · Ctrl puts the second on the surface · Shift locks the tube axis to world X, Y, or Z'
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

  /** The selected trail's settings as a lil-gui target: reading shows the trail's own value (or the next
   *  trail's, before one exists), writing re-cuts it (docs/023). */
  function trailSettingsTarget(): TrailSettings {
    const target = {} as TrailSettings;
    for (const key of Object.keys(TRAIL_SETTINGS_DEFAULTS) as (keyof TrailSettings)[]) {
      Object.defineProperty(target, key, {
        enumerable: true,
        get: () => selectedTrail()?.settings[key] ?? TRAIL_SETTINGS_DEFAULTS[key],
        set: (value: never) => setTrailSetting(key, value),
      });
    }
    return target;
  }

  /** A knot's own value marks its row; one following the trail is unmarked. */
  const OWN_MARK = ' ●';
  const KNOT_ROWS: { key: 'widthM' | 'centerBias' | 'dishPercent'; name: string; min: number; max: number; step: number; tip: string }[] = [
    { key: 'widthM', name: 'width (m)', min: 2, max: 100, step: 0.5, tip: 'Rim-to-rim plan width at this point. The trail eases to it from the neighbouring points.' },
    { key: 'centerBias', name: 'centre seam', min: 0.25, max: 0.75, step: 0.01, tip: 'Where the centre seam sits across the width at this point.' },
    { key: 'dishPercent', name: 'centre dish (%)', min: 0, max: 30, step: 0.5, tip: 'How far the centre seam sits below the rims at this point, as a percentage of width.' },
  ];
  const signedDegrees = (value: number) => `${value > 0.05 ? '+' : value < -0.05 ? '−' : ''}${Math.abs(value).toFixed(1)}°`;

  /**
   * The selected knot's own section (docs/023 · Per-knot section). Each row shows the value cut at this point;
   * moving it makes the value the point's own (marked ●), and the trail eases into and out of it over the
   * neighbouring stretches. The bank is either the automatic one, scaled by a strength, or a fixed angle.
   */
  function buildTrailKnotTools(trail: NonNullable<ReturnType<typeof selectedTrail>>, knotIndex: number) {
    const g = createTrailKnotSection = editSection('trail-knot', `Point ${knotIndex + 1}`);
    const own = () => selectedTrailKnot()?.own ?? {};
    const mark = (name: string, key: keyof TrailKnotSettings) => own()[key] !== undefined ? name + OWN_MARK : name;
    const target = {} as Record<string, number>;
    for (const row of KNOT_ROWS) {
      Object.defineProperty(target, row.key, {
        enumerable: true,
        get: () => own()[row.key] ?? selectedTrail()?.settings[row.key] ?? trail.settings[row.key],
        set: (value: number) => setTrailKnotSetting(row.key, value),
      });
      const control = g.add(target, row.key, row.min, row.max, row.step).name(mark(row.name, row.key));
      control.onChange(() => { control.name(mark(row.name, row.key)); refreshCreateTrailSummary(); });
      tip(control, row.tip, '● marks a value this point sets for itself; the others follow the trail’s settings below.');
    }

    const fixed = own().bankDegrees !== undefined;
    const mode = { bank: fixed ? 'fixed' : 'auto' };
    tip(g.add(mode, 'bank', { 'automatic': 'auto', 'fixed angle': 'fixed' }).name('bank').onChange((value: string) => {
      // A fixed bank starts at the bank the point has now, so choosing it changes nothing until it is moved.
      const now = selectedTrailKnot()?.cut?.bankDegrees ?? 0;
      setTrailKnotSetting('bankDegrees', value === 'fixed' ? Math.round(now * 2) / 2 : undefined);
      rebuildTools();
    }), 'Automatic banks with the curve, as the trail’s Banking settings say. A fixed angle holds this point at it.',
    'Between two fixed points the bank turns evenly from one angle to the other — two at 0° keep the stretch between them '
      + 'level through any curve. Between a fixed point and an automatic one it fades from the angle to the automatic bank.');
    if (fixed) {
      const bank = { degrees: own().bankDegrees ?? 0 };
      tip(g.add(bank, 'degrees', -60, 60, 0.5).name('bank angle (deg)').onChange((value: number) => {
        setTrailKnotSetting('bankDegrees', value);
        refreshCreateTrailSummary();
      }), 'The bank at this point. The sign is the automatic bank’s: match the sign it had here to lean the same way.');
    } else {
      const strength = { scale: own().bankStrength ?? 1 };
      const control = g.add(strength, 'scale', 0, 3, 0.05).name(mark('bank strength (×)', 'bankStrength'));
      control.onChange((value: number) => {
        setTrailKnotSetting('bankStrength', Math.abs(value - 1) < 1e-9 ? undefined : value);
        control.name(mark('bank strength (×)', 'bankStrength'));
        refreshCreateTrailSummary();
      });
      tip(control, 'Scales the automatic bank at this point: 0 keeps the rims level here, 2 banks twice as hard.',
        'Eases back to the usual bank at the neighbouring points.');
    }
    createTrailKnotBankRow = detail(g, '—', 'bank here');
    const reset = tip(g.add({ reset: resetTrailKnotSettings }, 'reset').name('↺ follow the trail here'),
      'Clear everything this point sets for itself, so it takes the trail’s settings again.');
    if (!Object.keys(own()).length) reset.disable();
  }

  /**
   * The trail panel (docs/023), while one is being drawn and whenever one is selected: its knots, the section
   * and banking it is cut with — every change re-cuts it live — and what can be done with it. One panel for both,
   * because a trail being drawn is already the trail: it is in the document from its second knot.
   */
  function buildTrailTools() {
    const drawing = store.surgeryTool === 'trail';
    const status = trailStatus();
    const knot = store.trailKnot;
    const spline = editSection('trail-placement', drawing ? 'Create Trail' : 'Trail');
    createTrailPointsRow = detail(spline, `${status?.knots ?? 0}`, 'knots');
    if (drawing) createTrailNextRow = detail(spline, '—', 'next');
    createTrailSpansRow = detail(spline, '—', 'spans · patches');
    if (knot !== null && status) detail(spline, `${knot + 1} of ${status.knots}`, 'selected knot');
    createTrailErrorBanner = errorBanner(spline, '');
    if (status?.broken) errorBanner(spline, 'Something cut into this trail’s patches, so it can no longer re-cut them. '
      + 'Dissolve it to keep the patches as mesh, or delete it.');
    if (status?.connected) note(spline, 'Joined to other patches: moving it stretches them, and its patch count is held.');
    note(spline, drawing
      ? 'click to add knots · click a knot to pick it up, then drag its arrows · Shift locks the next segment to world X, Y, or Z'
      : 'drag the gizmo to move the whole trail (E turns it, R scales it) · click a knot to reshape it');
    const trail = selectedTrail();
    if (trail && knot !== null && status && !status.draft) buildTrailKnotTools(trail, knot);
    refreshCreateTrailSummary();

    const settings = trailSettingsTarget();
    const dimensions = editSection('trail-shape', 'Trail Shape');
    const refresh = () => refreshCreateTrailSummary();
    // Every station has left, centre, and right rails, producing exactly two patches across.
    tip(dimensions.add(settings, 'widthM', 2, 100, 0.5).name('target width (m)').onChange(refresh),
      'Rim-to-rim plan width; the measured Mesa default is 13 m.');
    tip(dimensions.add(settings, 'patchLengthM', 2, 100, 0.5).name('target length (m)').onChange(refresh),
      'Maximum ordinary patch length along the spline. Tight turns are automatically subdivided more finely. '
      + 'Held while other patches are joined to the trail.');
    tip(dimensions.add(settings, 'dishPercent', 0, 30, 0.5).name('centre dish (%)').onChange(refresh),
      'How far the centre seam sits below the banked rim chord, as a percentage of full width. Mesa measures about 10.5%.');
    tip(dimensions.add(settings, 'centerBias', 0.25, 0.75, 0.01).name('centre seam').onChange(refresh),
      'Position of the centre seam across the width. 0.5 makes equal left and right patches.');
    tip(dimensions.add(settings, 'maxTurnDegrees', 5, 120, 1).name('max turn / patch').onChange(refresh),
      'Adaptive curvature threshold. Lower values create more, shorter patches through turns.');

    const banking = editSection('trail-banking', 'Banking');
    tip(banking.add(settings, 'bankGainM', 0, 100, 0.5).name('banking amount').onChange(refresh),
      'Strength of automatic curvature banking. Zero keeps the rim chord level; the measured default is 15 m.');
    tip(banking.add(settings, 'maxBankDegrees', 0, 60, 1).name('max bank (deg)').onChange(refresh),
      'Absolute bank clamp. Banking ramps between stations to avoid abrupt cross-slope changes.');
    if (drawing) tip(banking.add(store, 'trailSurfaceLift', 0, 5, 0.05).name('surface lift (m)').onChange((value: number) => {
      viewport.setCreateTrailSurfaceLift(value);
    }), 'Vertical offset applied when a NEW spline knot is clicked on an existing patch or vertex. Free-space knots are unchanged.');
    tip(banking.add(settings, 'mesaTextures').name('Mesa trail textures').onChange(refresh),
      'Apply matched left/right Mesa trail tiles, switching to the tight-turn stripe set where curvature calls for it.');

    const actions = editSection('tool-actions', 'Actions');
    if (drawing) {
      tip(actions.add({ finish: finishCreateTrail }, 'finish').name('✔ finish trail (Enter)'),
        status && !status.draft ? 'Stop adding knots. The trail stays selected; click any of its patches later to edit it again.'
          : 'Stop drawing. A trail needs two knots, so this one is discarded.');
      const undo = tip(actions.add({ undo: undoCreateTrailPoint }, 'undo').name('undo last knot (Backspace)'),
        'Remove the newest knot without leaving Create Trail.');
      if (!status?.knots) undo.disable();
    } else {
      // From an end: either with no knot picked, the picked one's with an end knot picked. A middle knot has
      // none — a branch will start there.
      const ends = resumeEnds();
      if (ends.includes('start')) tip(actions.add({ start: () => resumeTrail('start') }, 'start').name('✚ add points before the start'),
        'Lay more knots onto the start of this trail, ahead of its first knot.');
      if (ends.includes('end')) tip(actions.add({ end: () => resumeTrail('end') }, 'end').name('✚ add points after the end'),
        'Lay more knots onto the end of this trail, after its last knot.');
    }
    if (knot !== null) tip(actions.add({ del: deleteSelectedTrailKnot }, 'del').name('✕ delete this knot (Del)'),
      'Remove the selected knot and re-cut the trail. A trail left with one knot is removed.');
    if (status && !status.draft) pathHandleActions(ctx, actions);
    if (!drawing && status) {
      tip(actions.add({ overlap: selectOverlappingVertices }, 'overlap').name('select overlapping vertices'),
        'Swap the selection for every other authored vertex under the trail in this view.',
        'The current viewport is the mask: selection passes through depth and excludes the trail’s own corners. '
        + 'Press Delete afterward to remove the mountain patches beneath it (see the guide below).');
      tip(actions.add({ dissolve: dissolveSelectedTrail }, 'dissolve').name('⇥ dissolve into patches'),
        'Keep the patches exactly where they are as ordinary mesh, and forget the spline.',
        'They stay locked; unlock them under Visibility to edit them by hand. The trail can no longer re-cut them.');
      tip(actions.add({ remove: deleteSelectedTrail }, 'remove').name('✕ delete trail'),
        'Remove the trail and every patch it owns. Patches joined to it keep the vertices they share.');
      tip(actions.add({ deselect: deselectEdit }, 'deselect').name('deselect (Esc)'), 'Clear the selection.');
    }
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

  /** The trail panel's live rows: knots, the next segment while drawing, the cut's size, and why it refused. */
  function refreshCreateTrailSummary() {
    if (!createTrailPointsRow) return;
    const status = trailStatus();
    createTrailPointsRow.setValue(`${status?.knots ?? 0}`);
    createTrailSpansRow?.setValue(status && !status.draft ? `${status.spans} · ${status.patches}` : '—');
    if (createTrailErrorBanner) {
      const reason = trailError();
      createTrailErrorBanner.textContent = reason ?? '';
      createTrailErrorBanner.style.display = reason ? '' : 'none';
    }
    if (createTrailKnotBankRow) {
      const cut = selectedTrailKnot()?.cut;
      createTrailKnotBankRow.setValue(cut ? signedDegrees(cut.bankDegrees) : '—');
    }
    // A point following the trail shows the trail's value, which a trail setting just changed.
    for (const control of createTrailKnotSection?.controllers ?? []) control.updateDisplay();
    if (!createTrailNextRow) return;
    const knots = selectedTrail()?.knots;
    const start = trailDrawEnd() === 'start' ? knots?.[0] : knots?.at(-1), hover = viewport.createTrailPreviewPoint;
    const next = start && hover
      ? Math.hypot(hover[0] - start[0], hover[1] - start[1], hover[2] - start[2])
      : null;
    createTrailNextRow.setValue(next === null ? '—' : fmtM(next));
  }

  return {
    reset, buildCreateEdgeTools, buildCreateTubeTools, buildTrailTools,
    refreshCreateEdgeSummary, refreshCreatePatchSummary, refreshCreateTubeSummary, refreshCreateTrailSummary,
  };
}
