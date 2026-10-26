import { fmtArea, fmtM, type ToolsContext } from './widgets';
import { actionPair, detail, errorBanner, liveDetail, tip } from '../components/gui';
import { surfaceEditState } from '../../state/surface-edit';
import { surfaceBoundaryLoop, surfaceRowRemoval } from '../../../core/mesh/surface-object';
import { edgeIndices } from '../../state/mesh-names';
import { guideRows, isSurfaceBoundaryGuide } from '../../../core/mesh/surface-guides';
import { surfaceFitTolerance } from '../../../core/mesh/surface-fit';
import { measureSurfaceObject } from '../../../core/mesh/surface-measure';
import { selectedSurfaceBoundary } from '../../../core/mesh/surface-stitch';
import { inferSurfaceCorners } from '../../../core/mesh/surface-corners';
import { getVertex } from '../../../core/doc/doc-edit';

/** The object panel replaces mesh surgery: its source net is the only editable shape. */
export function buildSurfaceTools(ctx: ToolsContext): boolean {
  const { store, edit, editSection } = ctx;
  if (store.modelEditId) return false;
  const stitching = edit.surfaceStitchPlacement();
  if (stitching) {
    const group = editSection('surface-stitch-placement', 'Stitch surface');
    detail(group, `${stitching.count} source edge${stitching.count === 1 ? '' : 's'} captured`);
    detail(group, 'select the same number of target boundary edges');
    detail(group, 'Shift adds edges · Esc cancels');
    group.add(stitching, 'continuity', { Smooth: 'smooth', Crease: 'crease' }).name('join');
    const candidate = edit.surfaceStitchCandidate();
    if (candidate.error) detail(group, candidate.error);
    const apply = group.add({ stitch: edit.completeSurfaceStitch }, 'stitch').name('apply stitch');
    if (!candidate.target) apply.disable();
    group.add({ cancel: edit.cancelSurfaceStitch }, 'cancel').name('cancel stitch (Esc)');
    return true;
  }
  const cells = new Set(store.cellSel),
    points = new Set([
      ...store.regionSel,
      ...store.edgeSel.flat(),
      ...(store.selectedCorner ? [store.selectedCorner] : []),
    ]);
  for (const point of store.controlSel) {
    if (point.kind === 'vertex') points.add(point.vertex);
    else if (point.kind === 'edge') {
      points.add(point.from);
      points.add(point.to);
    } else cells.add(point.quad);
  }
  let shown = false,
    shapeShown = false;
  const placement = edit.surfaceGuidePlacement();
  for (const surface of store.mdoc.surfaces ?? []) {
    if (
      placement?.id !== surface.id &&
      !surface.patches.some(p => cells.has(p.quad)) &&
      !surface.controls.flat().some(id => points.has(id)) &&
      !surface.vertices.some(id => points.has(id))
    )
      continue;
    shown = true;
    if (placement?.id === surface.id) {
      const group = editSection(
        'surface-guide-placement',
        placement.mode.endsWith('-point') ? 'Place control point' : 'Place control curve',
      );
      detail(
        group,
        `${placement.mode.startsWith('move') ? 'Reposition' : placement.mode === 'paste' ? 'Paste' : placement.mode === 'duplicate' ? 'Duplicate' : 'Add'} ${placement.mode.endsWith('-point') ? 'a control point' : 'a ' + placement.axis + ' curve'}`,
      );
      detail(group, 'move over the surface to preview');
      detail(group, 'click to set · Esc to cancel');
      detail(
        group,
        placement.mode === 'paste' || placement.mode === 'duplicate'
          ? 'keeps the copied profile · fits its endpoints to the boundary'
          : 'the surface and patch layout stay fixed',
      );
      if (placement.mode === 'add') {
        const otherAxis = placement.axis === 'U' ? 'V' : 'U';
        tip(
          group
            .add({ flip: () => edit.beginSurfaceGuidePlacement(surface.id, otherAxis, 0, 'add') }, 'flip')
            .name(`orientation: ${placement.axis} → ${otherAxis}`),
          'Switch the new control curve between U and V, then move over the surface to preview it.',
        );
      }
      if (!placement.mode.endsWith('-point'))
        liveDetail(
          group,
          () => {
            const count = edit.surfaceGuidePlacement()?.snappedPoints ?? 0;
            return count ? `reuse ${count} point${count === 1 ? '' : 's'}` : 'move near a control point';
          },
          'snap',
        );
      group.add({ cancel: () => edit.cancelSurfaceGuidePlacement() }, 'cancel').name('cancel placement (Esc)');
      continue;
    }
    const group = editSection('surface-' + surface.id, 'Surface');
    if (surface.guides)
      group.add({ corners: () => edit.beginSurfaceCornerEdit(surface.id) }, 'corners').name('edit corners…');
    const stitches = (store.mdoc.surfaces ?? []).flatMap(s =>
      (s.stitches ?? []).filter(
        st => s.id === surface.id || ('surface' in st.target && st.target.surface === surface.id),
      ),
    );
    const connection = editSection('surface-stitches-' + surface.id, 'Stitching');
    detail(connection, `${stitches.length} live connection${stitches.length === 1 ? '' : 's'}`);
    if (stitches.length) {
      const values = { continuity: stitches[0].continuity };
      connection
        .add(values, 'continuity', { Smooth: 'smooth', Crease: 'crease' })
        .name('join')
        .onChange((continuity: 'smooth' | 'crease') => edit.changeSurfaceStitchContinuity(surface.id, continuity));
    }
    const sourceBoundary = selectedSurfaceBoundary(store.mdoc, store.edgeSel);
    const manual = tip(
      connection.add({ stitch: edit.beginSurfaceStitch }, 'stitch').name('stitch selected edges…'),
      'Select connected boundary control edges on this surface, click Stitch, then select the same number of edges on another surface or plain terrain.',
    );
    if (sourceBoundary?.surface !== surface.id) manual.disable();
    tip(
      connection
        .add({ touching: () => edit.stitchTouchingSurface(surface.id) }, 'touching')
        .name('stitch touching boundaries'),
      'Attach unstitched boundary spans whose points already touch another surface or open terrain edge. Existing connections stay in place.',
    );
    const detach = tip(
      connection.add({ detach: () => edit.detachSurface(surface.id) }, 'detach').name('detach all stitching'),
      'Remove every live connection to this surface, including surfaces attached to it. Source controls remain editable.',
    );
    if (!stitches.length) detach.disable();
    let measurements: ReturnType<typeof measureSurfaceObject> | undefined;
    try {
      measurements = measureSurfaceObject(store.mdoc, surface);
    } catch {
      // A broken source still needs its inspector and error banner so it can be repaired or baked.
    }
    const values = {
      name: surface.name,
      patchSizeM: surface.patchSizeM,
      fitToleranceM: surfaceFitTolerance(surface.patchSizeM, surface.fitToleranceM),
    };
    group
      .add(values, 'name')
      .name('name')
      .onFinishChange((name: string) => edit.updateSurface(surface.id, { name }));
    tip(
      group
        .add(values, 'patchSizeM', 1, 500, 1)
        .name('patch size (m)')
        .onFinishChange((patchSizeM: number) => edit.updateSurface(surface.id, { patchSizeM })),
      'Target curved patch dimensions. The fitter uses all sixteen patch controls; sharp creases retain boundaries.',
    );
    tip(
      group
        .add(values, 'fitToleranceM', 0.01, surface.patchSizeM, 0.01)
        .name('fit error (m)')
        .onFinishChange((fitToleranceM: number) => edit.updateSurface(surface.id, { fitToleranceM })),
      'Maximum positional error when fitting the control curves to terrain patches. A larger allowance can produce fewer, larger patches. Automatic: 2% of patch size.',
    );
    if (surface.fitToleranceM !== undefined)
      group
        .add({ automatic: () => edit.updateSurface(surface.id, { fitToleranceM: null }) }, 'automatic')
        .name('automatic fit error');
    tip(
      detail(group, measurements ? fmtArea(measurements.area) : '—', 'area'),
      'Approximate curved 3D area of the whole source surface, independent of terrain patch size.',
    );
    const average = measurements?.averagePatchSize;
    tip(
      detail(group, average ? `${average.length.toFixed(1)} × ${average.width.toFixed(1)} m` : '—', 'avg patch size'),
      'Average generated patch length × width along the curved U and V centre lines, in metres. Compare both dimensions with patch size (m).',
    );
    if (!shapeShown && !placement && edit.canEditCurvature()) {
      // Match C/S: selected corner controls win over a region, lone point or selected curve's endpoints.
      const selected = store.controlSel.length
        ? store.controlSel.flatMap(point => (point.kind === 'vertex' ? [point.vertex] : []))
        : store.regionSel.length
          ? store.regionSel
          : store.selectedCorner !== null
            ? [store.selectedCorner]
            : store.edgeSel.flat();
      const vertices = [...new Set(selected)];
      if (vertices.length) {
        shapeShown = true;
        const shape = editSection('surface-shape', 'Shape');
        actionPair(
          tip(
            shape.add({ crease: () => edit.creaseVertices(vertices) }, 'crease').name('crease (C)'),
            'Crease the selected points or curve, using the same action as C.',
          ),
          tip(
            shape.add({ smooth: () => edit.smoothVertices(vertices) }, 'smooth').name('smooth (S)'),
            'Smooth the selected guide points through U/V crossings. Selecting the whole surface includes all internal curves, using the same action as S.',
          ),
        );
      }
    }
    if (surface.guides) {
      const sourcePoints = new Set(surface.controls.flat()),
        sourceEdges = new Set(
          surface.controls.flatMap(row => row.slice(1).map((id, i) => [row[i], id].sort().join('>'))),
        );
      tip(
        detail(
          group,
          `${surface.controls.length} curves · ${sourcePoints.size} points · ${sourceEdges.size * 2} handles`,
          'source controls',
        ),
        'Shape definition only. Shared crossing points count once; every source curve segment has two tangent handles. Generated terrain vertices are independent.',
      );
      detail(
        group,
        `U ${guideRows(surface, 'U').length} · V ${guideRows(surface, 'V').length} · ${surface.patches.length} terrain patches`,
      );
      detail(group, 'pink curves shape the surface');
      detail(group, 'drag their points or tangent handles');
      detail(group, 'W move · E rotate · R scale');
      if (surface.error) errorBanner(group, surface.error);
      group.add({ all: () => edit.selectSurfaceControls(surface.id) }, 'all').name('select all control curves');
      tip(
        group
          .add({ refit: () => edit.updateSurface(surface.id, { patchSizeM: surface.patchSizeM }) }, 'refit')
          .name('refit patch layout'),
        'Redistribute terrain patches using the current size and shape. Guides stay where you placed them.',
      );
      const state = surfaceEditState(store, surface.id),
        rows = editSection('surface-rows-' + surface.id, 'Control curves');
      if (store.edgeSel.length) {
        const key = (a: string, b: string) => [a, b].sort().join(',');
        const selected = surface.controls.findIndex(path => {
          const edges = new Set(path.slice(1).map((id, i) => key(path[i], id)));
          return store.edgeSel.every(([a, b]) => edges.has(key(a, b)));
        });
        if (selected >= 0) {
          state.axis = surface.guides[selected].axis;
          state.row = guideRows(surface, state.axis).indexOf(selected);
        }
      }
      const pickedPoint = store.selectedCorner ?? (store.regionSel.length === 1 ? store.regionSel[0] : undefined);
      if (pickedPoint) {
        const current = guideRows(surface, state.axis)[state.row],
          pickedCurve = surface.controls[current]?.includes(pickedPoint)
            ? current
            : surface.controls.findIndex(path => path.includes(pickedPoint));
        if (pickedCurve >= 0) {
          state.axis = surface.guides[pickedCurve].axis;
          state.row = guideRows(surface, state.axis).indexOf(pickedCurve);
        }
      }
      const count = guideRows(surface, state.axis).length;
      state.row = Math.max(0, Math.min(state.row, count - 1));
      const boundaryCurve = isSurfaceBoundaryGuide(surface, guideRows(surface, state.axis)[state.row]);
      const boundaryTip = 'Boundary curves define the outline. Reshape them using their points and tangents.';
      const values = { direction: state.axis };
      rows
        .add(values, 'direction', ['U', 'V'])
        .name('direction')
        .onChange((axis: 'U' | 'V') => edit.selectSurfaceRow(surface.id, axis, 0));
      if (count) {
        rows
          .add({ copy: () => edit.copySurfaceControlCurve(surface.id, state.axis, state.row) }, 'copy')
          .name('copy curve (Ctrl+C)');
        rows
          .add({ duplicate: () => edit.duplicateSurfaceControlCurve(surface.id, state.axis, state.row) }, 'duplicate')
          .name('duplicate curve (Ctrl+D)');
        tip(
          detail(
            rows,
            measurements ? fmtM(measurements.curveLength(guideRows(surface, state.axis)[state.row])) : '—',
            'length',
          ),
          'Length along this complete visible control curve, including its bends.',
        );
        if (boundaryCurve) detail(rows, 'Boundary curve · edit its points to reshape the outline');
        const moveCurve = tip(
          rows
            .add({ move: () => edit.beginSurfaceGuidePlacement(surface.id, state.axis, state.row, 'move') }, 'move')
            .name('reposition curve on surface'),
          boundaryCurve
            ? boundaryTip
            : 'Sample a replacement curve on the surface, then rebuild from the remaining controls.',
        );
        if (boundaryCurve) moveCurve.disable();
      } else detail(rows, 'No curves in this direction yet. Add a cross-section on the current surface.');
      const paste = rows
        .add({ paste: () => edit.pasteSurfaceControlCurve(surface.id, state.axis, state.row) }, 'paste')
        .name('paste curve (Ctrl+V)');
      if (!edit.canPasteSurfaceControlCurve()) paste.disable();
      tip(
        rows
          .add({ add: () => edit.beginSurfaceGuidePlacement(surface.id, state.axis, state.row, 'add') }, 'add')
          .name('add control curve'),
        'Preview a complete curve sampled from the surface, then click to add its editable points and handles.',
      );
      const deleteCurve = tip(
        rows
          .add({ delete: () => edit.deleteSurfaceCurve(surface.id, state.axis, state.row) }, 'delete')
          .name('delete control curve'),
        boundaryCurve
          ? boundaryTip
          : 'Remove this shape constraint, rebuild from the remaining curves and refit terrain patches.',
      );
      if (!count || surface.guides.length <= 1 || boundaryCurve) deleteCurve.disable();
      if (count) {
        const curve = guideRows(surface, state.axis)[state.row],
          path = surface.controls[curve];
        const picked = path.findIndex(
          id => id === store.selectedCorner || (store.regionSel.length === 1 && store.regionSel[0] === id),
        );
        state.point = Math.max(0, Math.min(picked >= 0 ? picked : state.point, path.length - 1));
        const points = editSection('surface-points-' + surface.id, 'Guide points');
        detail(points, 'visible curves and points define the entire surface');
        detail(points, 'ordinary gizmo drags reshape the surface');
        points
          .add(
            { add: () => edit.beginSurfaceGuidePlacement(surface.id, state.axis, state.row, 'add-point', state.point) },
            'add',
          )
          .name('add control point');
        const shared = surface.controls.some((row, i) => i !== curve && row.includes(path[state.point]));
        const movable = state.point > 0 && state.point < path.length - 1 && !shared;
        const reason = shared
          ? 'This point joins crossing curves. Reposition or remove the crossing curve.'
          : 'Keep the two curve endpoints.';
        const movePoint = tip(
          points
            .add(
              {
                move: () =>
                  edit.beginSurfaceGuidePlacement(surface.id, state.axis, state.row, 'move-point', state.point),
              },
              'move',
            )
            .name('reposition control point'),
          movable ? 'Sample a replacement point along this curve, then rebuild from its remaining controls.' : reason,
        );
        const deletePoint = tip(
          points
            .add(
              { delete: () => edit.deleteSurfaceControlPoint(surface.id, state.axis, state.row, state.point) },
              'delete',
            )
            .name('delete control point'),
          movable
            ? 'Reconnect and smooth this curve through its remaining points, then reshape and refit the surface.'
            : reason,
        );
        if (!movable) {
          movePoint.disable();
          deletePoint.disable();
        }
      }
      group.add({ bake: () => edit.bakeSurface(surface.id) }, 'bake').name('bake surface');
      group.add({ remove: () => edit.deleteSurface(surface.id) }, 'remove').name('delete surface');
      group.add({ done: edit.deselectEdit }, 'done').name('deselect (Esc)');
      continue;
    }
    detail(
      group,
      surface.controls[0].length +
        ' × ' +
        surface.controls.length +
        ' source controls · ' +
        surface.patches.length +
        ' terrain patches',
    );
    detail(group, 'drag source controls or rows · W / E / R to move, rotate or scale');
    detail(group, 'terrain patches follow the cage; their vertices are generated');
    if (surface.error) errorBanner(group, surface.error);
    group.add({ all: () => edit.selectSurfaceControls(surface.id) }, 'all').name('select all source controls');
    const state = surfaceEditState(store, surface.id);
    const count = state.axis === 'U' ? surface.controls[0].length : surface.controls.length;
    state.row = Math.max(0, Math.min(state.row, count - 1));
    const rows = editSection('surface-rows-' + surface.id, 'Source rows');
    const rowValues = { direction: state.axis, row: state.row + 1 };
    rows
      .add(rowValues, 'direction', ['U', 'V'])
      .name('direction')
      .onChange((axis: 'U' | 'V') => {
        const limit = axis === 'U' ? surface.controls[0].length : surface.controls.length;
        edit.selectSurfaceRow(surface.id, axis, Math.min(state.row, limit - 1));
      });
    rows
      .add(rowValues, 'row', 1, count, 1)
      .name('row')
      .onFinishChange((row: number) => edit.selectSurfaceRow(surface.id, state.axis, Math.round(row) - 1));
    rows.add({ select: () => edit.selectSurfaceRow(surface.id, state.axis, state.row) }, 'select').name('select row');
    tip(
      rows.add({ insert: () => edit.addSurfaceRow(surface.id, state.axis, state.row) }, 'insert').name('insert row'),
      'Insert beside this control row without changing the surface shape. Move the new source controls with the gizmo.',
    );
    let removal: string;
    let removable = true;
    try {
      removal =
        'Removal preserves the two opposite boundary curves. Maximum positional change: ' +
        surfaceRowRemoval(store.mdoc, surface, state.axis, state.row).deviationM.toFixed(3) +
        ' m.';
    } catch (error) {
      removal = error instanceof Error ? error.message : String(error);
      removable = false;
    }
    const remove = tip(
      rows.add({ remove: () => edit.removeSurfaceRow(surface.id, state.axis, state.row) }, 'remove').name('delete row'),
      removal,
    );
    detail(rows, removal);
    if (!removable) remove.disable();
    group.add({ bake: () => edit.bakeSurface(surface.id) }, 'bake').name('bake surface');
    group.add({ remove: () => edit.deleteSurface(surface.id) }, 'remove').name('delete surface');
    group.add({ done: edit.deselectEdit }, 'done').name('deselect (Esc)');
  }
  return shown;
}

export function buildBoundarySurfaceTools(ctx: ToolsContext): void {
  if (ctx.store.modelEditId) return;
  const doc = ctx.store.mdoc;
  const result = surfaceBoundaryLoop(doc, edgeIndices(doc, ctx.store.edgeSel));
  if (!result.ok) return;
  const group = ctx.editSection('surface-boundary', 'Surface from boundary');
  detail(group, 'Choose four corners in loop order. The enclosed surface starts with a smooth boundary fill.');
  const inferred = inferSurfaceCorners(result.loop.map(i => getVertex(doc, i))),
    values = { A: inferred[0], B: inferred[1], C: inferred[2], D: inferred[3] };
  const options = Object.fromEntries(
    result.loop.map((vertex, i) => ['point ' + (i + 1) + ' · ' + doc.vertexIds[vertex], i]),
  );
  for (const key of ['A', 'B', 'C', 'D'] as const) group.add(values, key, options).name('corner ' + key);
  group
    .add(
      {
        create: () => ctx.edit.createBoundarySurface([values.A, values.B, values.C, values.D].map(i => result.loop[i])),
      },
      'create',
    )
    .name('create surface from loop');
}
