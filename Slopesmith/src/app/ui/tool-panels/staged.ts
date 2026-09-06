import { editMesh } from '../../edit/mesh-target';
import { edgeIndices, vertexIndices } from '../../state/mesh-names';
import { applyLoft } from '../../../core/mesh/loft';
import { boundaryEdgeLoopVertices } from '../../../core/mesh/ops';
import { detail, note, tip } from '../components/gui';
import type { ToolsContext } from './widgets';

/**
 * The Edit-mode panels for staged, in-flight operations — each owns the whole toolbox until it commits or
 * cancels: the staged extrusion's ghost-rim placement, the clipboard's paste placement, the point / edge weld
 * source-vs-target flows, and Bridge Builder's ordered rail list with its live loft dry-run.
 */

/** The staged-extrusion placement panel: position the ghost geometry (Move / Rotate / Scale or its distance handle),
 *  then commit the teal preview or discard it. */
export function buildExtrudePlacementTools(ctx: ToolsContext) {
  const { viewport, editSection, edit } = ctx;
  const placement = editSection('extrude-placement', 'Extrude Placement');
  detail(placement, viewport.edgeExtrusionFanMode
    ? 'drag the single distance handle · choose Move for the full direction gizmo'
    : 'position the staged extrusion with Move / Rotate / Scale');
  const segmentReadout = placement.add({ get value() { return `${viewport.edgeExtrusionSegments} · auto`; } }, 'value')
    .name('depth segments').disable().listen();
  segmentReadout.domElement.classList.add('sp-detail');
  if (viewport.edgeExtrusionSideFlippable)
    tip(placement.add({ flip: edit.flipEdgeExtrusionSide }, 'flip').name('⇄ flip side (F)'),
      'Move the interior-edge extrusion to the other adjacent patch strip and reset its constrained placement.');
  const actions = editSection('tool-actions', 'Actions');
  tip(actions.add({ commit: edit.commitEdgeExtrusion }, 'commit').name('✔ commit extrusion (Enter)'),
    'Bake the teal preview into the mountain and select its new top patches or outer edge.');
  tip(actions.add({ cancel: edit.cancelEdgeExtrusion }, 'cancel').name('cancel extrusion (Esc)'),
    'Discard the staged preview without changing the mountain.');
}

/** The paste-placement panel: the clipboard ghost rides the pointer; a click places it, Esc puts it down. */
export function buildPastePlacementTools(ctx: ToolsContext) {
  const { editSection, edit } = ctx;
  const placement = editSection('paste-placement', 'Paste Placement');
  detail(placement, 'move over terrain or empty space · click to place');
  tip(placement.add({ cancel: edit.cancelPastePlacement }, 'cancel').name('cancel paste (Esc)'),
    'Put down the clipboard ghost without creating any geometry.');
}

/** The point-weld panel: the captured source points against the growing target selection, with commit gated
 *  on an exact, non-overlapping pairing. */
export function buildPointWeldTools(ctx: ToolsContext) {
  const { store, editSection, edit } = ctx;
  const target = store.regionSel.length ? store.regionSel : store.selectedCorner !== null ? [store.selectedCorner] : [];
  const sourceCount = store.weldSource.length, targetCount = new Set(target).size;
  const overlaps = target.some(vertex => store.weldSource.includes(vertex));
  const selection = editSection('weld-selection', 'Weld Selection');
  detail(selection, `${sourceCount} source ${sourceCount === 1 ? 'point' : 'points'} captured`);
  detail(selection, `${targetCount} / ${sourceCount} target ${sourceCount === 1 ? 'point' : 'points'} selected`);
  note(selection, 'select separate targets normally · or merge the captured sources to each other');
  const ready = sourceCount > 0 && targetCount === sourceCount && !overlaps;
  const commitHelp = overlaps
    ? 'Source and target sets overlap. Select a separate target set.'
    : targetCount !== sourceCount
    ? `Select exactly ${sourceCount} target ${sourceCount === 1 ? 'point' : 'points'} before committing.`
    : 'Merge every captured source point into the nearest selected target point. Targets survive at their current positions.';
  const actions = editSection('tool-actions', 'Actions');
  const together = tip(actions.add({ together: edit.commitPointWeldTogether }, 'together').name('weld to each other'), sourceCount >= 2
    ? 'Merge every captured source point into the lowest-id source point. No separate target selection is needed.'
    : 'Capture at least two source points to weld them to each other.');
  if (sourceCount < 2) together.disable();
  const commitWeld = tip(actions.add({ commit: edit.commitPointWeld }, 'commit').name('✔ commit weld (Enter)'), commitHelp);
  if (!ready) commitWeld.disable();
  tip(actions.add({ cancel: edit.cancelPointWeld }, 'cancel').name('cancel weld (Esc)'),
    'Leave point-weld mode without changing the mesh and restore the captured source selection.');
}

/** The edge-weld panel. A captured closed boundary specializes the tool into Weld Loops: a second complete
 *  boundary enables an annular seam even when its vertex density differs. Open edge sets retain the ordinary
 *  equal-cardinality endpoint weld. */
export function buildEdgeWeldTools(ctx: ToolsContext) {
  const { store, editSection, edit } = ctx;
  const doc = editMesh(store);
  const sourceCount = store.weldEdgeSource.length, targetCount = store.edgeSel.length;
  const sourceVertexCount = new Set(store.weldEdgeSource.flatMap(edge => edge)).size;
  const targetVertexCount = new Set(store.edgeSel.flatMap(edge => edge)).size;
  const sourceKeys = new Set(store.weldEdgeSource.map(([a, b]) => a < b ? `${a},${b}` : `${b},${a}`));
  const overlaps = store.edgeSel.some(([a, b]) => sourceKeys.has(a < b ? `${a},${b}` : `${b},${a}`));
  const sourceIndices = edgeIndices(doc, store.weldEdgeSource), targetIndices = edgeIndices(doc, store.edgeSel);
  const sourceLoop = sourceIndices.length === sourceCount
    ? boundaryEdgeLoopVertices(doc, sourceIndices)
    : { ok: false as const, error: 'The captured source edges are stale.' };
  const targetLoop = targetIndices.length === targetCount
    ? boundaryEdgeLoopVertices(doc, targetIndices)
    : { ok: false as const, error: 'The selected target edges are stale.' };
  const loopMode = sourceLoop.ok;
  const selection = editSection('weld-selection', 'Weld Selection');
  detail(selection, loopMode
    ? `source boundary loop · ${sourceCount} edges`
    : `${sourceCount} source ${sourceCount === 1 ? 'edge' : 'edges'} captured`);
  detail(selection, loopMode
    ? `${targetCount} target ${targetCount === 1 ? 'edge' : 'edges'} selected`
    : `${targetCount} / ${sourceCount} target ${sourceCount === 1 ? 'edge' : 'edges'} selected`);
  detail(selection, loopMode && targetLoop.ok
    ? `${sourceLoop.vertices.length} source · ${targetLoop.vertices.length} target`
    : `${targetVertexCount} / ${sourceVertexCount}`, 'loop vertices');
  note(selection, loopMode
    ? 'double-click one edge on the trail border to select its complete target loop'
    : 'select targets normally · Shift-click or double-click to build the target set');
  const loopReady = loopMode && targetLoop.ok && !overlaps;
  const edgeReady = !loopMode && sourceCount > 0 && targetCount === sourceCount
    && targetVertexCount === sourceVertexCount && !overlaps;
  const ready = loopReady || edgeReady;
  const commitHelp = overlaps
    ? 'Source and target edge sets overlap. Select a separate target set.'
    : loopMode && !targetLoop.ok
    ? `Select one complete target surface boundary loop. ${targetLoop.error}`
    : loopReady
    ? `Create a patch seam through the gap without moving either loop. ${sourceLoop.vertices.length === targetLoop.vertices.length
      ? 'Matching stations become quads.'
      : 'Unequal loop densities use quads plus triangular transition patches.'}`
    : targetCount !== sourceCount
    ? `Select exactly ${sourceCount} target ${sourceCount === 1 ? 'edge' : 'edges'} before committing.`
    : targetVertexCount !== sourceVertexCount
    ? `The source edges contain ${sourceVertexCount} unique vertices; select target edges containing the same number.`
    : 'Pair the unique target vertices to the closest unique source vertices, then weld them atomically.';
  const actions = editSection('tool-actions', 'Actions');
  const commit = tip(actions.add({ commit: edit.commitEdgeWeld }, 'commit')
    .name(loopMode ? '✔ weld loops (Enter)' : '✔ commit edge weld (Enter)'), commitHelp);
  if (!ready) commit.disable();
  tip(actions.add({ cancel: edit.cancelEdgeWeld }, 'cancel')
    .name(loopMode ? 'cancel loop weld (Esc)' : 'cancel edge weld (Esc)'),
  'Leave weld mode without changing the mesh and restore the captured source edges.');
}

/** Explicit bridge-building mode. The colored list is authoritative; the ordinary yellow edge selection is
 * only a candidate until Add Rail is pressed. Preview and commit use the exact list order + directions. */
export function buildBridgeTools(ctx: ToolsContext) {
  const { store, viewport, editSection, edit, bridgeList } = ctx;
  const doc = editMesh(store);
  const rails = (store.bridgeRails ?? []).map(rail => vertexIndices(doc, rail));
  bridgeList.show(rails);
  viewport.setBridgeRails(rails);
  const selection = editSection('bridge-rails', 'Rails');
  tip(selection.add(store, 'bridgePatchM', 5, 500, 5).name('target patch size (m)').onFinishChange(() => ctx.rebuildTools()),
    'Maximum desired spacing between bridge rails. Longer spans receive evenly spaced intermediate loops.');
  tip(selection.add(store, 'bridgeCurve', 0, 2, 0.05).name('connection curve').onFinishChange(() => ctx.rebuildTools()),
    '0 keeps connections straight, 1 makes them flow smoothly through the rail sequence, and 2 exaggerates the bend.');

  const candidate = edit.bridgeCandidate();
  if (!store.edgeSel.length) {
    detail(selection, 'select the next edge chain · double-click, or click its first and Shift-click its last edge');
  } else if (candidate.ok) {
    detail(selection, `candidate · ${candidate.rail.length} vertices · press A to add`);
  } else {
    detail(selection, `candidate unavailable · ${candidate.error}`);
  }

  if (candidate.ok) {
    tip(selection.add({ add: edit.addBridgeRail }, 'add').name('add rail (A)'),
      'Add the yellow candidate to the ordered rail list. It is initially oriented to the preceding rail; Reverse provides the manual override.');
  } else {
    tip(selection.add({ add: () => {} }, 'add').name('add rail (A)').disable(), candidate.error);
  }

  const actions = editSection('tool-actions', 'Actions');
  if (rails.length >= 2) {
    const dry = applyLoft(doc, rails, {
      preserveRailOrder: true, targetPatchM: store.bridgePatchM, connectionCurve: store.bridgeCurve,
    });
    if (dry.ok) {
      const inserted = Math.round((dry.doc.vertices.length - editMesh(store).vertices.length) / 3 / rails[0].length);
      detail(actions, inserted ? `${inserted} intermediate ${inserted === 1 ? 'loop' : 'loops'} · automatic` : 'no intermediate loops needed');
      viewport.setLoftPreview(dry.doc.quads.slice(editMesh(store).quads.length), dry.doc);
      tip(actions.add({ complete: edit.completeBridge }, 'complete').name('complete bridge (Enter)'),
        'Create the teal preview as real surfaces in one undo step, consume any free edges that became surface edges, and select the new surfaces.');
    } else {
      tip(actions.add({ complete: () => {} }, 'complete').name('complete bridge (Enter)').disable(),
        dry.error.replace(/\bLoft\b/g, 'Bridge').replace(/\bloft\b/g, 'bridge'));
    }
  } else {
    tip(actions.add({ complete: () => {} }, 'complete').name('complete bridge (Enter)').disable(),
      'Add at least two rails to create a bridge.');
  }
  tip(actions.add({ cancel: edit.cancelBridge }, 'cancel').name('cancel bridge (Esc)'),
    'Leave Bridge Builder without changing the mesh and restore Rail 1 as the ordinary edge selection.');
}
