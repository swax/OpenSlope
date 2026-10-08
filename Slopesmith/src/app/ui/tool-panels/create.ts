import { editMesh } from '../../edit/mesh-target';
import { edgeIndices } from '../../state/mesh-names';
import { meshFromDoc } from '../../../core/mesh/topology';
import { measureEdges } from '../../../core/mesh/measure';
import {
  detail, errorBanner, note, texturePreview, tileSetDropdown, tip, type SetTile, type TileSetArt, type TileSetOption,
} from '../components/gui';
import { tileSetBuilder, type BuilderSquare } from '../components/tile-set-builder';
import { toast } from '../components/toast';
import { buildTrailIntegrationGuide } from './trail-guide';
import { AUTHORED_MODEL_LEVEL } from '../../../core/doc/models';
import { orientText, turnD4 } from '../../../core/paint/orientation';
import { describeProp } from '../../../core/props/kind';
import { textureRefUrl } from '../../net/asset-paths';
import { fmtM, pathHandleActions, type ToolsContext } from './widgets';
import type { TrailKnotSettings, TrailSettings, TrailTileRow, TrailTileSet } from '../../../core/doc/types';
import { TRAIL_SETTINGS_DEFAULTS } from '../../../core/mesh/trail-object';
import { MAX_TRAIL_LANES } from '../../../core/mesh/trail';
import {
  findTrailTileSet, isBuiltInTrailTileSet, TRAIL_TILE_ROW_WORDS, TRAIL_TILE_ROWS, trailSettingsTiles, trailTileRowLanes, trailTileRowView,
  trailTileSetFits, trailTileSetId, trailTileSetLiteral, trailTileSetRow, trailTileViewOrient, withTrailTileRowView, type TrailTileRowKey,
} from '../../../core/mesh/trail-textures';
import { parseTexRef } from '../../../core/paint/textures';
import { mphText } from '../../../core/math/units';

/**
 * The Edit-mode creation tools: Create Edge (mesh-native drawing and surface cuts), Create Patch, the armed
 * Loop Cut panel, and the two-endpoint elliptical tube draft. Owns the cached live-measurement rows (total /
 * next / step read-outs) that the viewport's preview listeners refresh on pointer moves without rebuilding
 * lil-gui; the coordinator calls reset() at the top of every toolbox rebuild so a stale row is never touched.
 */
export function createCreateTools(ctx: ToolsContext) {
  const { store, viewport, editSection, edit, cageActive, rebuildTools, updateCmdSheet, modelEdit, library, persistUi } = ctx;
  const {
    armCreateEdge, armCreatePatch, finishCreatePatch, finishCreateEdge,
    armCreateTube, previewCreateTube, finishCreateTube, cancelCreateTube, armLoopCut,
    armCreateTrail, undoCreateTrailPoint, finishCreateTrail,
    trailStatus, trailError, trailRide, syncTrailView, resumeTrail, setTrailSetting,
    deleteSelectedTrailKnot, disconnectSelectedPoint, splitSelectedPoint, deleteSelectedTrail, dissolveSelectedTrail,
    selectOverlappingVertices, deselectEdit, trailTileSets, addTrailTileSet, editTrailTileSet, deleteTrailTileSet,
    selectedTrailKnot, setTrailKnotSetting, resetTrailKnotSettings, resumeEnds,
    armPathFrom, selectedPointRole, drawingFrom, focusSettings, selectWholeNetwork, trailDrawAnchor,
    trailCustomTileCount, resetTrailTextures,
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
  let createTrailRideRow: ReturnType<typeof detail> | null = null;
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
    createTrailRideRow = null;
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
        note(g, 'points snap to vertices, free edges and patch edges you can cut to · Ctrl sticks to any surface edge or the surface · Shift locks free edges to a world axis · Esc starts a new strand · Enter finishes',
          'Every point snaps to an existing vertex, or onto a free edge, which is split there so the strands of a '
          + 'web share their crossing points and its cells can be filled with Create Patches. A patch edge snaps when '
          + 'the chain can cut to it: across a patch the last point touches, so drawing from one edge of a patch to '
          + 'another splits it, or along a strip of patches out of a red T-junction, which stitches that split back '
          + 'into its neighbours. Otherwise a later point stays at the chain depth, so surface edges and terrain '
          + 'behind the cursor never pull it away; hold Ctrl to cut to any surface edge or drop onto the surface. '
          + 'Only crossed patches are bisected; an endpoint inside a shared surface edge leaves the neighboring patch '
          + 'untouched and remains a red T-junction until a cut is drawn out of it.');
      }
      const actions = editSection('tool-actions', 'Actions');
      actions.add({ done: finishCreateEdge }, 'done').name('✔ finish edge chain (Enter)');
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

  /** The selected paths' settings as a lil-gui target: reading shows the focus path's own value (or the next new
   *  path's, before one exists), writing sets it on every selected path and re-cuts (docs/023). */
  function trailSettingsTarget(): TrailSettings {
    const target = {} as TrailSettings;
    for (const key of Object.keys(TRAIL_SETTINGS_DEFAULTS) as (keyof TrailSettings)[]) {
      Object.defineProperty(target, key, {
        enumerable: true,
        get: () => focusSettings()?.[key] ?? TRAIL_SETTINGS_DEFAULTS[key],
        set: (value: never) => setTrailSetting(key, value),
      });
    }
    return target;
  }

  /** A point's own value marks its row; one following its paths is unmarked. */
  const OWN_MARK = ' ●';
  const KNOT_ROWS: { key: 'widthM' | 'centerBias' | 'dishPercent'; name: string; min: number; max: number; step: number; tip: string }[] = [
    { key: 'widthM', name: 'width (m)', min: 2, max: 100, step: 0.5, tip: 'Rim-to-rim plan width at this point. The trail eases to it from the neighbouring points.' },
    { key: 'centerBias', name: 'centre seam', min: 0.25, max: 0.75, step: 0.01, tip: 'Where the trail’s centre line sits across the width at this point.' },
    { key: 'dishPercent', name: 'centre dish (%)', min: 0, max: 30, step: 0.5, tip: 'How far the trail’s centre line sits below the rims at this point, as a percentage of width.' },
  ];
  const signedDegrees = (value: number) => `${value > 0.05 ? '+' : value < -0.05 ? '−' : ''}${Math.abs(value).toFixed(1)}°`;

  /**
   * The picked point's own section (docs/023 · Per-point section). Each row shows the value cut at this point;
   * moving it makes the value the point's own (marked ●), and every path through the point eases into and out of it
   * over the neighbouring stretches. The bank is either the automatic one, scaled by a strength, or a fixed angle.
   */
  function buildTrailKnotTools(point: number, shared: number) {
    const g = createTrailKnotSection = editSection('trail-knot', `Point ${point + 1}`);
    const own = () => selectedTrailKnot()?.own ?? {};
    const mark = (name: string, key: keyof TrailKnotSettings) => own()[key] !== undefined ? name + OWN_MARK : name;
    if (shared > 1) note(g, `${shared} paths meet here; what this point sets, it sets for all of them.`);
    const target = {} as Record<string, number>;
    for (const row of KNOT_ROWS) {
      Object.defineProperty(target, row.key, {
        enumerable: true,
        get: () => own()[row.key] ?? selectedTrailKnot()?.settings[row.key] ?? TRAIL_SETTINGS_DEFAULTS[row.key],
        set: (value: number) => setTrailKnotSetting(row.key, value),
      });
      const control = g.add(target, row.key, row.min, row.max, row.step).name(mark(row.name, row.key));
      control.onChange(() => { control.name(mark(row.name, row.key)); refreshCreateTrailSummary(); });
      tip(control, row.tip, '● marks a value this point sets for itself; the others follow the path’s settings below.');
    }

    const fixed = own().bankDegrees !== undefined;
    const mode = { bank: fixed ? 'fixed' : 'auto' };
    tip(g.add(mode, 'bank', { 'automatic': 'auto', 'fixed angle': 'fixed' }).name('bank').onChange((value: string) => {
      // A fixed bank starts at the bank the point has now, so choosing it changes nothing until it is moved.
      const now = selectedTrailKnot()?.cut?.bankDegrees ?? 0;
      setTrailKnotSetting('bankDegrees', value === 'fixed' ? Math.round(now * 2) / 2 : undefined);
      rebuildTools();
    }), 'Automatic banks with the curve, as the path’s Banking settings say. A fixed angle holds this point at it.',
    'Between two fixed points the bank turns evenly from one angle to the other — two at 0° keep the stretch between them '
      + 'level through any curve. Between a fixed point and an automatic one it fades from the angle to the automatic bank. '
      + 'The angle is measured along each path through the point, which leans it the same way for a path running the same way.');
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
    const reset = tip(g.add({ reset: resetTrailKnotSettings }, 'reset').name('↺ follow the path here'),
      'Clear everything this point sets for itself, so it takes its paths’ settings again.');
    if (!Object.keys(own()).length) reset.disable();
  }

  const CAPS = { none: 'none', 'start': 'start', 'end': 'end', 'both ends': 'both' };
  /** Where each row of a set is worn. */
  const ROW_HINTS: Readonly<Record<TrailTileRowKey, string>> = {
    cap: 'Worn on a capped end’s square span, as a rider travelling out to that end sees it.',
    trail: 'Worn along the path’s spans.',
    rightTurn: 'Worn through right turns tighter than the turn radius — right as the path runs from its first point.',
    leftTurn: 'Worn through left turns tighter than the turn radius.',
  };

  const setTile = (ref: string | undefined, mirror = false, orient?: { rot: number; mirror: boolean }): SetTile =>
    ({ src: ref ? textureRefUrl(ref) : null, value: ref ? `${ref}${mirror ? ' (mirrored)' : ''}` : '', mirror, ...(orient ? { orient } : {}) });
  /** A row as the art: its tiles across the path, the left lane's first, the way a rider going along it sees them. */
  const rowArt = (row: TrailTileRow, borrowed = false): TileSetArt => ({
    tiles: trailTileRowLanes(row).map(lane => setTile(lane.ref || undefined, lane.mirrored, trailTileRowView(row, lane.which))),
    orient: trailTileViewOrient(row.quarterTurns),
    ...(borrowed ? { borrowed } : {}),
  });
  const setOption = (set: TrailTileSet): TileSetOption => ({
    ...rowArt(set.trail),
    rows: TRAIL_TILE_ROWS.map(key => { const { row, borrowed } = trailTileSetRow(set, key); return rowArt(row, borrowed); }),
    id: trailTileSetId(set), group: set.level, name: `${set.name}${set.narrow ? ' · narrow' : ''}`,
  });

  // ---- the set builder: the mountain's own set worn, laid out to arrange ------------------------------------------
  /** A set's columns: a wide one's three lanes, a narrow one's two. */
  const lanesOf = (set: Pick<TrailTileSet, 'narrow'>) => set.narrow ? ['left', 'right'] as const : ['left', 'middle', 'right'] as const;
  /** The builder's selected square, kept across the panel's rebuilds while the same set is worn. */
  let builderFocus: { id: string; square: BuilderSquare } | null = null;
  /** The set the Texture Library is open for, while it is. */
  let builderLibrary: string | null = null;
  /** One of the mountain's own sets, as it is now — a library click outlives the panel it was opened from. */
  const ownSet = (id: string) => isBuiltInTrailTileSet(id) ? null : trailTileSets().find(set => trailTileSetId(set) === id) ?? null;
  type Placed = { ref: string; view: { rot: number; mirror: boolean } } | null;
  /** A square's tile, and how it shows. */
  const placedAt = (set: TrailTileSet, square: BuilderSquare): Placed => {
    const { row } = trailTileSetRow(set, TRAIL_TILE_ROWS[square.row]);
    const which = lanesOf(set)[square.col], ref = which && row[which];
    return ref ? { ref, view: trailTileRowView(row, which) } : null;
  };
  /** Lay tiles in squares of an own set — or clear them — at once: one edit, one re-cut, one undo. A row it has none
   *  of starts as the trail row shown there. */
  function placeSquares(id: string, placements: readonly { square: BuilderSquare; tile: Placed }[]) {
    const set = ownSet(id);
    if (!set) return;
    const foreign = placements.find(({ tile }) => tile && parseTexRef(tile.ref).level !== set.level);
    if (foreign) { toast(`${id}’s tiles come from ${set.level}: ${foreign.tile!.ref} is another map’s.`, 'err'); return; }
    const rows: Partial<Record<TrailTileRowKey, TrailTileRow>> = {};
    for (const { square, tile } of placements) {
      const key = TRAIL_TILE_ROWS[square.row], which = lanesOf(set)[square.col];
      if (!which) continue;
      const row = rows[key] ?? trailTileSetRow(set, key).row;
      rows[key] = tile ? withTrailTileRowView({ ...row, [which]: tile.ref }, which, tile.view) : { ...row, [which]: '' };
    }
    // Each row whole: the edit lays a change over the row as it was, so what a row no longer has — a mirror, a turn,
    // a middle — is said outright, or it would stay.
    const whole = Object.fromEntries(Object.entries(rows).map(([key, row]) =>
      [key, { middle: undefined, mirrored: undefined, turns: undefined, ...row }]));
    if (editTrailTileSet(id, whole)) { refreshCreateTrailSummary(); rebuildTools(); }
  }
  /** A Library click while the builder has it open: the tile goes in the selected square, upright; ∅ clears it. */
  function libraryPlace(id: string, ref: string | null) {
    if (!ownSet(id)) { library.cancelPick(); return; }
    const focus = builderFocus?.id === id ? builderFocus.square : null;
    if (!focus) { toast('Select a square of the set first, then click a tile to place it there.', 'info'); return; }
    placeSquares(id, [{ square: focus, tile: ref ? { ref, view: { rot: 0, mirror: false } } : null }]);
  }
  /** Open the Texture Library for the builder — standing, so every click places a tile — or close it. */
  function toggleBuilderLibrary(set: TrailTileSet) {
    const id = trailTileSetId(set);
    if (builderLibrary === id && library.picking) { library.cancelPick(); return; }
    const focus = builderFocus?.id === id ? placedAt(set, builderFocus.square) : null;
    library.openPick({
      title: `${id} — ${set.level}’s tiles`, current: focus?.ref ?? (set.trail.left || null), keep: true,
      hint: `Drag a tile onto a square of ${id}, or select a square there and click a tile here to place it. `
        + 'Esc or Done closes the library.',
      onPick: ref => libraryPlace(id, ref),
      onCancel: () => { builderLibrary = null; },
    });
    builderLibrary = id;
    rebuildTools();
  }
  /** Copy a set as it is written among the built-in ones, to paste or send as a preset. */
  function copyLayout(set: TrailTileSet) {
    const text = trailTileSetLiteral(set);
    const fallback = () => window.prompt(`${trailTileSetId(set)} — copy its layout:`, text);
    if (!navigator.clipboard?.writeText) { fallback(); return; }
    navigator.clipboard.writeText(text).then(
      () => toast(`${trailTileSetId(set)}’s layout copied — paste it to share it as a preset`, 'ok'), fallback);
  }

  /** Wear set `id` (or none) on the selected paths, or on the next path. */
  function wearSet(id: string | null) {
    setTrailSetting('trailTiles', id);
    refreshCreateTrailSummary();
    rebuildTools();
  }

  /** Choose a tile of `level`'s in the Texture Library — asked again while the one chosen is another map's. */
  function pickTileOf(level: string, title: string, current: string | null, onPick: (ref: string) => void) {
    library.openPick({
      title, current,
      onPick: ref => {
        if (!ref) return;
        if (parseTexRef(ref).level !== level) {
          toast(`A set’s tiles come from one map: choose a ${level} tile.`, 'err');
          pickTileOf(level, title, current, onPick);
          return;
        }
        onPick(ref);
      },
    });
  }

  /** Make a set of the mountain's own — its trail row's left lane's tile, then its right lane's from the same map, each
   *  chosen in the Texture Library — and wear it. A path other than two lanes wide is asked its middle lanes' tile last;
   *  Esc there leaves them plain. Its cap and turn rows are its trail row's until given their own. */
  function newTileSet(from: TrailTileSet | null) {
    const lanes = trailSettingsTarget().lanes;
    library.openPick({
      title: 'New set — choose its trail row’s left lane’s tile, going along the path; the set is that tile’s map’s',
      current: from?.trail.left ?? null,
      onPick: left => {
        if (!left) return;
        const { level } = parseTexRef(left);
        const same = from?.level === level ? from.trail : null;
        pickTileOf(level, `New set from ${level} — choose the right lane’s tile`, same?.right ?? left, right => {
          const id = addTrailTileSet({ trail: { left, right, quarterTurns: 0 } });
          if (!id) return;
          wearSet(id);
          if (lanes === 2) return;
          pickTileOf(level, `${id} — choose the middle lanes’ tile (Esc leaves them plain)`, same?.middle ?? null, middle => {
            if (editTrailTileSet(id, { trail: { middle } })) { refreshCreateTrailSummary(); rebuildTools(); }
          });
        });
      },
    });
  }

  /** Copy a set as the mountain's own, every row of it, and wear the copy: a built-in set to change. */
  function copyTileSet(set: TrailTileSet) {
    const id = addTrailTileSet({ cap: set.cap, trail: set.trail, rightTurn: set.rightTurn, leftTurn: set.leftTurn, narrow: set.narrow });
    if (!id) return;
    wearSet(id);
    toast(`${id} is a copy of ${trailTileSetId(set)} — change its tiles here`, 'ok');
  }

  /**
   * The selected paths' tiles (docs/023 · Textures): the set they wear — chosen from a dropdown of every set as its 4×3
   * of cap, trail and turn rows — whether their free ends are capped, and the mountain's own set worn, to edit. Every
   * change re-cuts the selected paths, as their other settings do, and becomes the next path's.
   */
  function buildTrailTextures(paths: number) {
    const g = editSection('trail-textures', 'Textures');
    const settings = focusSettings() ?? TRAIL_SETTINGS_DEFAULTS;
    const worn = trailSettingsTiles(settings);
    const lanes = settings.lanes ?? 2;
    const sets = trailTileSets();
    const chosen = findTrailTileSet(worn.trailTiles, sets.filter(set => !isBuiltInTrailTileSet(trailTileSetId(set))));
    if (paths > 1) note(g, `A set chosen here is worn by all ${paths} selected paths.`);
    tileSetDropdown(g, {
      label: 'tile set',
      hint: `The matched tiles ${paths > 1 ? 'these paths wear' : 'this path wears'}, a row each, top to bottom: on its capped `
        + 'ends, along its spans, and through its tight right and left turns — a tile for the left edge lane, one for every '
        + 'lane between, and one for the right, as a rider going along the path sees them. A faded row is one the set has '
        + 'none of: its trail row is worn there.',
      value: chosen ? trailTileSetId(chosen) : worn.trailTiles,
      // A narrow set is offered a two-lane path only: drawn two across, it leaves a wider one's middle lanes plain.
      options: sets.filter(set => trailTileSetFits(set, lanes) || set === chosen).map(setOption),
      none: { label: 'none — plain' },
      add: { label: 'new set…', onAdd: () => newTileSet(chosen) },
      onChange: pick => wearSet(pick),
    });
    // Tiles painted by hand over the set's go with their patches when the paths move, until they are reset.
    const painted = trailCustomTileCount();
    if (painted) {
      detail(g, `${painted} patch${painted === 1 ? '' : 'es'}`, 'painted by hand');
      tip(g.add({ reset: () => { resetTrailTextures(); refreshCreateTrailSummary(); rebuildTools(); } }, 'reset').name('↺ reset textures'),
        `Put ${paths > 1 ? 'these paths’' : 'this path’s'} hand-painted patches back to the tiles the set lays.`,
        'A tile painted, turned or taken off by hand stays on its patch as the path moves, reshapes or changes its set, '
        + 'and is let go only where its patch is gone — its stretch of the path, or a junction it was part of.');
    }
    tip(g.add(trailSettingsTarget(), 'caps', CAPS).name('caps').onChange(() => { refreshCreateTrailSummary(); rebuildTools(); }),
      'Close the path’s free ends with a cap: a square span, as long as a lane is wide, wearing the set’s cap row.',
      'An end at a junction or a joint carries on into it instead. The cap row reads as a rider travelling out to that '
      + 'end sees it, so one cap fits either end. A set with no cap row wears its trail row there.');
    if (chosen?.leftTurn || chosen?.rightTurn) {
      tip(g.add(trailSettingsTarget(), 'turnRadiusM', 10, 500, 5).name('turns under (m)').onChange(() => refreshCreateTrailSummary()),
        'A span turning tighter than this radius wears the set’s turn row for its way of turning. Mesa’s is 80 m.');
    }
    const id = chosen ? trailTileSetId(chosen) : null, builtIn = !!id && isBuiltInTrailTileSet(id);
    // The library open for a set no longer worn here closes — after this build, which its close rebuilds.
    if (builderLibrary && builderLibrary !== (builtIn ? null : id) && library.picking) queueMicrotask(() => library.cancelPick());
    if (!chosen || !id) return;
    // Lanes between the edges (or a one-lane path's only lane) wear the trail row's middle tile.
    if (!trailTileSetFits(chosen, lanes)) {
      note(g, `${id} is narrow — drawn two across, for two-lane paths — so ${lanes === 1 ? 'this one-lane path stays' : 'the middle lanes stay'} `
        + `plain: wear a wide set${builtIn ? '' : ', or make this one wide'}.`);
    } else if (lanes !== 2 && !chosen.trail.middle) {
      note(g, `${id} has no middle tile, so ${lanes === 1 ? 'this one-lane path stays' : 'the middle lanes stay'} plain — `
        + `${builtIn ? 'copy it to give' : 'give its trail row one to give'} ${lanes === 1 ? 'it' : 'them'} one.`);
    }
    if (builtIn) {
      tip(g.add({ copy: () => copyTileSet(chosen) }, 'copy').name(`⧉ copy ${id} to change it`),
        'Make this set the mountain’s own, every row of it, and wear the copy: its tiles are then yours to change.');
      return;
    }
    // The mountain's own set worn: laid out to arrange, every change re-cutting every path wearing it.
    if (builderFocus && (builderFocus.id !== id || builderFocus.square.col >= lanesOf(chosen).length)) builderFocus = null;
    const WIDTHS = { 'wide — 3 across, any path': 'wide', 'narrow — 2 across, two-lane paths': 'narrow' };
    tip(g.add({ width: chosen.narrow ? 'narrow' : 'wide' }, 'width', WIDTHS).name('set width').onChange((width: string) => {
      if (editTrailTileSet(id, {}, { narrow: width === 'narrow' })) { refreshCreateTrailSummary(); rebuildTools(); }
    }), 'A wide set is drawn three across and fits a path of any width; a narrow one two across, for two-lane paths.',
    'Narrow suits turn marks and caps drawn across both lanes. Made narrow, the set loses its middle tiles; made wide '
      + 'again, give it new ones.');
    tileSetBuilder(g, {
      title: id,
      hint: `${id} is this mountain’s own: a change re-cuts every path wearing it. A faded row is one it has none of — its `
        + 'trail row is worn there — and changing it gives the set that row.',
      lanes: lanesOf(chosen),
      rows: TRAIL_TILE_ROWS.map(key => {
        const { row, borrowed } = trailTileSetRow(chosen, key);
        return {
          label: TRAIL_TILE_ROW_WORDS[key], hint: ROW_HINTS[key], borrowed, removable: key !== 'trail' && !borrowed,
          tiles: lanesOf(chosen).map(which => row[which]
            ? { ref: row[which]!, src: textureRefUrl(row[which]!), view: trailTileRowView(row, which) } : null),
        };
      }),
      focus: builderFocus?.square ?? null,
      libraryOpen: builderLibrary === id && library.picking,
      onFocus: square => { builderFocus = square ? { id, square } : null; },
      onDrop: (square, tile) => {
        builderFocus = { id, square };
        placeSquares(id, [{ square, tile: { ref: tile.ref, view: tile.view ?? { rot: 0, mirror: false } } }]);
      },
      onMove: (from, to, copy) => {
        const set = ownSet(id);
        if (!set) return;
        builderFocus = { id, square: to };
        const [a, b] = [placedAt(set, from), placedAt(set, to)];
        placeSquares(id, copy ? [{ square: to, tile: a }] : [{ square: to, tile: a }, { square: from, tile: b }]);
      },
      onTurn: (square, dir, flip) => {
        const set = ownSet(id), tile = set && placedAt(set, square);
        if (tile) placeSquares(id, [{ square, tile: { ref: tile.ref, view: turnD4(tile.view, dir, flip) } }]);
      },
      onClear: square => placeSquares(id, [{ square, tile: null }]),
      onRemoveRow: r => { if (editTrailTileSet(id, { [TRAIL_TILE_ROWS[r]]: null })) { refreshCreateTrailSummary(); rebuildTools(); } },
      onLibrary: () => toggleBuilderLibrary(chosen),
      onCopy: () => copyLayout(ownSet(id) ?? chosen),
    });
    tip(g.add({ del: () => { deleteTrailTileSet(id); refreshCreateTrailSummary(); rebuildTools(); } }, 'del').name(`✕ delete ${id}`),
      'Delete this set of your own. Every path wearing it goes plain.');
  }

  /** The predicted ride in a line: top speed, the jumps, and any path the rider stalls on. */
  function rideText(ride: ReturnType<typeof trailRide>): string {
    if (!ride) return '—';
    const parts = [`top ${mphText(ride.topSpeed)}`];
    if (ride.jumps) parts.push(`${ride.jumps} ${ride.jumps === 1 ? 'jump' : 'jumps'} · ${fmtM(ride.airborneM)} airborne`);
    if (ride.stalled) parts.push(ride.stalled === 1 ? 'stalls' : `stalls on ${ride.stalled} paths`);
    return parts.join(' · ');
  }

  /** The picked point in words: where it stands in the network. */
  function pointRoleText(role: NonNullable<ReturnType<typeof selectedPointRole>>): string {
    const at = `point ${role.point + 1}`;
    if (role.free) return `${at} · a free end`;
    if (role.arms >= 3) return `${at} · a junction of ${role.arms} arms`;
    if (role.arms === 2 && role.paths > 1) return `${at} · where two paths meet`;
    if (role.arms === 2 && !role.ends.length) return at;
    return `${at} · where the loop closes`;
  }

  /**
   * The trail panel (docs/023), while a path is being drawn and whenever trail paths are selected: their points, the
   * section and banking they are cut with — every change re-cuts live, and applies to every selected path — and what
   * can be done with them. One panel for both, because a path being drawn is already in the trail from its second
   * point.
   */
  function buildTrailTools() {
    const drawing = store.surgeryTool === 'trail';
    const status = trailStatus();
    const role = selectedPointRole();
    const leaving = drawing ? drawingFrom() : null;
    const many = !drawing && (status?.paths ?? 0) > 1;
    const spline = editSection('trail-placement', leaving !== null ? `New Path from point ${leaving + 1}`
      : drawing ? 'Create Trail' : many ? `${status!.paths} Trail Paths` : 'Trail Path');
    createTrailPointsRow = detail(spline, `${status?.points ?? 0}`, 'points');
    if (status && status.networkPaths > 1) detail(spline, many || drawing ? `${status.networkPaths}` : `1 of ${status.networkPaths}`, 'paths in the network');
    if (status?.junctions) detail(spline, `${status.junctions}`, 'junctions');
    if (drawing) createTrailNextRow = detail(spline, '—', 'next');
    createTrailSpansRow = detail(spline, '—', many ? 'spans · patches (selected)' : 'spans · patches');
    // docs/023 · Predicted speed: the ride the patches shade by, in a line.
    createTrailRideRow = tip(detail(spline, '—', 'predicted ride'),
      'A rider set off from rest at the trail’s start, carried by the ride’s own ground model: its top speed on these paths, '
      + 'and how often and how far it leaves the ground.');
    tip(spline.add(store, 'trailSpeedColors').name('shade by speed').onChange(() => { persistUi(); syncTrailView(); }),
      'Shade the selected paths by the speed that rider carries over them: red standing, orange slow, yellow cruising, '
      + 'green at the speed cap — and blue where it is in the air.',
      'Each path runs from its first point to its last, from rest where nothing feeds it and from the fastest arrival '
      + 'where other paths do. It rides the centre line square: no steering, braking, boost or tricks.');
    if (role) detail(spline, pointRoleText(role), 'selected point');
    createTrailErrorBanner = errorBanner(spline, '');
    if (status?.broken) errorBanner(spline, 'Something cut into this trail’s patches, so it can no longer re-cut them. '
      + 'Dissolve it to keep the patches as mesh, or delete it.');
    if (status?.connected) note(spline, 'Joined to other patches: moving it stretches them, and its layout is held.');
    note(spline, leaving !== null
      ? 'click to lay the new path’s points — the ghost shows the junction it makes · a point laid on any trail’s point '
        + '(amber) ends the path there · Enter finishes'
      : drawing
        ? 'click to add points · the ghost shows what each click would cut · a point laid on any trail’s point (amber) joins '
          + 'it there — a fork, a merge, a loop — and ends the path · click a point to pick it up, then drag its arrows · '
          + 'Shift locks the next segment to world X, Y, or Z'
        : 'drag the gizmo to move the selected paths (E turns, R scales) · click a point to reshape · drop a point on any '
          + 'other point to join them there · Ctrl-click, a box, Ctrl+A or a double-click selects more paths');

    // The actions sit right under the paths, ahead of the long run of settings.
    const actions = editSection('tool-actions', 'Actions');
    if (drawing) {
      tip(actions.add({ finish: finishCreateTrail }, 'finish').name('✔ finish path (Enter)'),
        status && !status.draft ? 'Stop adding points. The path stays selected; click any of its patches later to edit it again.'
          : 'Stop drawing. A path needs two points, so this one is discarded.');
      const undo = tip(actions.add({ undo: undoCreateTrailPoint }, 'undo').name('undo last point (Backspace)'),
        'Remove the newest point without leaving Create Trail.');
      if (leaving !== null) undo.disable();
    } else {
      // From an end of the one selected path: either with no point picked, the picked one's with an end picked.
      const ends = resumeEnds();
      if (ends.includes('start')) tip(actions.add({ start: () => resumeTrail('start') }, 'start').name('✚ add points before the start'),
        'Lay more points onto the start of this path, ahead of its first point.');
      if (ends.includes('end')) tip(actions.add({ end: () => resumeTrail('end') }, 'end').name('✚ add points after the end'),
        'Lay more points onto the end of this path, after its last point.');
      // Any point but a free end (which the path itself grows from) can start a new path.
      if (role && !role.free && status && !status.draft)
        tip(actions.add({ branch: armPathFrom }, 'branch').name('⑂ start a new path here'),
          'Lay a new path from this point, a click per point, with a ghost of what each click would cut.',
          'The paths meet in a junction here: one patch per lane around a hub, six for a three-way fork. The new path has '
          + 'settings of its own, starting from the last ones used.');
      // Any point two sides or more meet at can come apart: each side then ends at a point of its own.
      if (role && role.arms >= 2 && status && !status.draft)
        tip(actions.add({ disconnect: disconnectSelectedPoint }, 'disconnect').name('✂ disconnect here'),
          `Break this point apart: each of the ${role.arms} sides meeting here ends at a point of its own, at the same place, `
          + 'so they no longer join — drag the point to pull its side away.',
          'A path running through is cut here, keeping its shape. A side no longer joined to the rest becomes a trail of its '
          + 'own. Dropping a point back onto another joins them again.');
      // A point a path runs on through can split there: the pieces still meet, but each can be set on its own.
      if (role && role.through > 0 && status && !status.draft)
        tip(actions.add({ split: splitSelectedPoint }, 'split').name('⫽ split path here'),
          'Cut the path in two here, still joined, so each piece can wear its own tiles and settings.',
          'The pieces meet in a two-arm joint at this point. At a fork or a crossing every path running on through it is '
          + 'split. Unlike disconnecting, nothing comes apart.');
      if (status && status.networkPaths > status.paths)
        tip(actions.add({ network: selectWholeNetwork }, 'network').name('select the whole network (Ctrl+A)'),
          'Select every path joined to the selected ones, to move or set them together.');
    }
    if (store.trailPoint !== null) tip(actions.add({ del: deleteSelectedTrailKnot }, 'del').name('✕ delete this point (Del)'),
      'Remove the picked point; every path through it runs straight past it. A path left with one point is removed.');
    if (status && !status.draft) pathHandleActions(ctx, actions);
    if (!drawing && status) {
      tip(actions.add({ overlap: selectOverlappingVertices }, 'overlap').name('select overlapping vertices'),
        'Swap the selection for every other authored vertex under the trail in this view.',
        'The current viewport is the mask: selection passes through depth and excludes the trail’s own corners. '
        + 'Press Delete afterward to remove the mountain patches beneath it (see the guide below).');
      tip(actions.add({ dissolve: dissolveSelectedTrail }, 'dissolve').name('⇥ dissolve network into patches'),
        'Keep every patch of this trail network exactly where it is as ordinary mesh, and forget its paths.',
        'The whole network goes, since its paths own their junctions together. The patches stay locked; unlock them under '
        + 'Visibility to edit them by hand.');
      tip(actions.add({ remove: deleteSelectedTrail }, 'remove').name(many ? '✕ delete these paths' : '✕ delete path'),
        'Remove the selected paths and every patch they own; the paths they met re-cut without them. Patches joined to them '
        + 'keep the vertices they share.');
      tip(actions.add({ deselect: deselectEdit }, 'deselect').name('deselect (Esc)'), 'Clear the selection.');
    }
    if (role && status && !status.draft) buildTrailKnotTools(role.point, role.paths);
    refreshCreateTrailSummary();

    const settings = trailSettingsTarget();
    const dimensions = editSection('trail-shape', 'Trail Shape');
    if (many) note(dimensions, `Showing one path’s settings; a change here applies to all ${status!.paths} selected paths.`);
    const refresh = () => refreshCreateTrailSummary();
    // Every station has a rail per lane and one more, a patch across between each two.
    tip(dimensions.add(settings, 'widthM', 2, 100, 0.5).name('target width (m)').onChange(refresh),
      'Rim-to-rim plan width; the measured Mesa default is 13 m.', 'The lanes share it, so widen the trail as you add lanes.');
    tip(dimensions.add(settings, 'lanes', 1, MAX_TRAIL_LANES, 1).name('lanes (patches across)').onChange(refresh)
      .onFinishChange(() => rebuildTools()),
    'How many patches wide the trail is. Mesa’s trails are two.',
    'The edge lanes wear a tile set row’s left and right tiles, the lanes between them its middle tile. At a junction each lane '
      + 'carries on toward the hub. Held while other patches are joined to the trail.');
    tip(dimensions.add(settings, 'patchLengthM', 2, 100, 0.5).name('target length (m)').onChange(refresh),
      'Maximum ordinary patch length along the spline. Tight turns are automatically subdivided more finely. '
      + 'Held while other patches are joined to the trail.');
    tip(dimensions.add(settings, 'dishPercent', 0, 30, 0.5).name('centre dish (%)').onChange(refresh),
      'How far the trail’s centre line sits below the banked rim chord, as a percentage of full width. Mesa measures about 10.5%.',
      'With two lanes the centre line is the centre seam; wider, the dish curves across the lanes.');
    tip(dimensions.add(settings, 'centerBias', 0.25, 0.75, 0.01).name('centre seam').onChange(refresh),
      'Where the centre line sits across the width. 0.5 makes equal lanes either side of it.',
      'With two lanes it is the centre seam. The lanes on each side of it share that side’s width evenly.');
    tip(dimensions.add(settings, 'maxTurnDegrees', 5, 120, 1).name('max turn / patch').onChange(refresh),
      'Adaptive curvature threshold. Lower values create more, shorter patches through turns.');

    const banking = editSection('trail-banking', 'Banking');
    tip(banking.add(settings, 'bankGainM', 0, 100, 0.5).name('banking amount').onChange(refresh),
      'Strength of automatic curvature banking. Zero keeps the rim chord level; the measured default is 15 m.');
    tip(banking.add(settings, 'maxBankDegrees', 0, 60, 1).name('max bank (deg)').onChange(refresh),
      'Absolute bank clamp. Banking ramps between stations to avoid abrupt cross-slope changes.');
    if (drawing) tip(banking.add(store, 'trailSurfaceLift', 0, 5, 0.05).name('surface lift (m)').onChange((value: number) => {
      viewport.setCreateTrailSurfaceLift(value);
    }), 'Vertical offset applied when a NEW spline point is clicked on an existing patch or vertex. Free-space points are unchanged.');
    buildTrailTextures(many ? status!.paths : 1);

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
    createTrailPointsRow.setValue(`${status?.points ?? 0}`);
    createTrailSpansRow?.setValue(status && !status.draft ? `${status.spans} · ${status.patches}` : '—');
    createTrailRideRow?.setValue(rideText(trailRide()));
    if (createTrailErrorBanner) {
      const reason = trailError();
      createTrailErrorBanner.textContent = reason ?? '';
      createTrailErrorBanner.style.display = reason ? '' : 'none';
    }
    if (createTrailKnotBankRow) {
      const cut = selectedTrailKnot()?.cut;
      createTrailKnotBankRow.setValue(cut ? signedDegrees(cut.bankDegrees) : '—');
    }
    // A point following its paths shows the path's value, which a path setting just changed.
    for (const control of createTrailKnotSection?.controllers ?? []) control.updateDisplay();
    if (!createTrailNextRow) return;
    const start = trailDrawAnchor(), hover = viewport.createTrailPreviewPoint;
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
