import type { PathHandles, V3 } from '../../core/doc/types';
import { pathNodeHasHandles, resetPathHandles, setPathHandle, type PathHandleList } from '../../core/rails/rails';
import type { Store } from '../state/store';
import type { PathHandleSide, PathOwner, ShownPath } from '../viewport/scene/path-handles';

/**
 * Bézier handles on every authored path (docs/014): rails, motion paths, prop lines and trails.
 *
 * All four are the same Catmull-Rom curve through their nodes, so all four take the same handles
 * (`PathHandles`, index-parallel with the nodes) and show them through one viewport layer. This is the host half:
 * which path is selected — at most one in any mode — which of its handles carries the gizmo, and what a drag on
 * one does, which differs by family only in what has to follow: a rail or motion path just redraws, a prop line
 * lays its members out again, and a trail path re-cuts its network (through the trail tools, which own its drag).
 * Of a trail it is one path's handles that show — the path the panel is about — named by its trail and place.
 */

export type PathHandleDeps = {
  store: Store;
  viewport: { setPathHandles(path: ShownPath | null, handle: { node: number; side: PathHandleSide } | null): void };
  /** The trail path Edit mode's panel is about, if any: its id (trail and path), knots, handles and picked knot. */
  trailPath: () => { id: string; nodes: V3[]; handles?: (PathHandles | null)[]; node: number | null } | null;
  /** A handle of that path was clicked: its knot is the picked trail point. */
  selectTrailNode: (node: number) => void;
  /** Re-cut that path with new handles (the trail tools, which also own its drag base). */
  setTrailHandles: (handles: (PathHandles | null)[], live: boolean) => void;
  /** A trail handle drag begins or ends. */
  trailDrag: (dragging: boolean) => void;
  /** Lay a prop line out again after its handles changed. */
  setLineHandles: (id: string, handles: (PathHandles | null)[]) => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
};

/** A node bulb's radius in each family's own layer, so the handles are drawn at a matching size. */
const BULB_RADIUS = { rail: 0.6, line: 0.6, trail: 1.15 } as const;

/** Write a handle list onto its path, dropping the field once nothing is overridden. */
export function assignHandles(path: { handles?: (PathHandles | null)[] }, handles: (PathHandles | null)[]) {
  if (handles.length) path.handles = handles; else delete path.handles;
}

export function createPathHandleOps(deps: PathHandleDeps) {
  const { store, viewport, trailPath, selectTrailNode, setTrailHandles, trailDrag, setLineHandles, scheduleRebuild, rebuildTools } = deps;

  /** The one path whose handles can show — the trail path in Edit mode, else the selected prop line or rail — and
   *  its selected point, the one whose handles do. */
  function selectedPath(): ShownPath | null {
    const mode = store.currentMode;
    if (mode === 'edit') {
      const path = trailPath();
      return path ? { owner: { family: 'trail', id: path.id }, nodes: path.nodes, handles: path.handles,
        node: path.node, bulbRadius: BULB_RADIUS.trail } : null;
    }
    if (mode === 'props' && store.selectedLine !== null && !store.lineDrawing) {
      const line = store.mdoc.propLines?.find(candidate => candidate.id === store.selectedLine);
      if (line?.id) return { owner: { family: 'line', id: line.id }, nodes: line.nodes, handles: line.handles,
        node: store.selectedLineNode, bulbRadius: BULB_RADIUS.line };
    }
    if ((mode === 'props' || mode === 'effects') && store.selectedRail !== null && !store.railDrawing) {
      const rail = store.mdoc.rails?.[store.selectedRail];
      if (rail?.id) return { owner: { family: 'rail', id: rail.id }, nodes: rail.nodes, handles: rail.handles,
        node: store.selectedNode, bulbRadius: BULB_RADIUS.rail };
    }
    return null;
  }

  /** Whether a handle of `family`'s selected path holds the gizmo — its own node layer then leaves it alone. */
  const holds = (family: PathOwner['family']): boolean => store.pathHandle?.family === family;

  /** Show the selected point's handles. Run on every render, after the families' own layers, so a selected handle
   *  wins the gizmo, and on every Tools rebuild, which follows a selection change that renders nothing; a handle
   *  selection the path no longer has (another path, a deleted node) is dropped here. */
  function sync() {
    const path = selectedPath();
    const held = store.pathHandle;
    if (held && !(path && held.family === path.owner.family && held.id === path.owner.id && path.nodes[held.node]))
      store.pathHandle = null;
    viewport.setPathHandles(path, store.pathHandle ? { node: store.pathHandle.node, side: store.pathHandle.side } : null);
  }

  /** A handle was clicked: it carries the gizmo, and its node is the family's selected node for the panel. */
  function select(owner: PathOwner, node: number, side: PathHandleSide) {
    store.pathHandle = { ...owner, node, side };
    if (owner.family === 'rail') store.selectedNode = node;
    else if (owner.family === 'line') store.selectedLineNode = node;
    else selectTrailNode(node);
    scheduleRebuild();
    rebuildTools();
  }

  /** Where a path is found by its owner, with its nodes and current handles. */
  function locate(owner: PathOwner): { nodes: readonly V3[]; handles?: PathHandleList } | null {
    if (owner.family === 'rail') return store.mdoc.rails?.find(rail => rail.id === owner.id) ?? null;
    if (owner.family === 'line') return store.mdoc.propLines?.find(line => line.id === owner.id) ?? null;
    const path = trailPath();
    return path?.id === owner.id ? { nodes: path.nodes, handles: path.handles } : null;
  }

  /** Put a new handle list on its path and let whatever the path lays out follow. */
  function apply(owner: PathOwner, handles: (PathHandles | null)[], live: boolean) {
    if (owner.family === 'trail') { setTrailHandles(handles, live); return; }
    if (owner.family === 'line') { setLineHandles(owner.id, handles); return; }
    const rail = store.mdoc.rails?.find(candidate => candidate.id === owner.id);
    if (!rail) return;
    assignHandles(rail, handles);
    scheduleRebuild();
  }

  /** The selected handle's gizmo moved it. The twin swings to stay in line unless `independent` (Alt). */
  function move(owner: PathOwner, node: number, side: PathHandleSide, pos: V3, independent: boolean) {
    const path = locate(owner);
    const at = path?.nodes[node];
    if (!path || !at) return;
    const offset: V3 = [pos[0] - at[0], pos[1] - at[1], pos[2] - at[2]];
    apply(owner, setPathHandle(path.nodes, path.handles, node, side, offset, independent), true);
  }

  function drag(owner: PathOwner, dragging: boolean) {
    if (owner.family === 'trail') trailDrag(dragging);
    else if (!dragging) rebuildTools(); // "reset handles" appears once a handle has been dragged
  }

  /** The selected path's point the panel is about — a handle's, or the family's selected one. */
  function selectedNode(): number | null {
    return selectedPath()?.node ?? null;
  }

  /** Whether the panel's node has a dragged handle, and whether the path has any. */
  function resetState(): { node: boolean; path: boolean } {
    const path = selectedPath(), node = selectedNode();
    return {
      node: !!path && node !== null && pathNodeHasHandles(path.handles, node),
      path: !!path?.handles?.some(Boolean),
    };
  }

  /** Put the panel's node back on the automatic curve. */
  function resetNode() {
    const path = selectedPath(), node = selectedNode();
    if (!path || node === null) return;
    store.pathHandle = null;
    apply(path.owner, resetPathHandles(path.handles, node), false);
    rebuildTools();
  }

  /** Put the whole selected path back on the automatic curve. */
  function resetPath() {
    const path = selectedPath();
    if (!path) return;
    store.pathHandle = null;
    apply(path.owner, [], false);
    rebuildTools();
  }

  return { selectedPath, holds, sync, select, move, drag, resetState, resetNode, resetPath };
}

export type PathHandleOps = ReturnType<typeof createPathHandleOps>;
