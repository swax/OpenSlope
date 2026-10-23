import type { Store } from './store';
import type { SurfaceAxis } from '../../core/math/spline-surface';

const states = new WeakMap<Store, Map<string, { axis: SurfaceAxis; row: number; point: number }>>();
/** Selection controls are local UI state, never construction history or shared document content. */
export function surfaceEditState(store: Store, id: string) {
  let surfaces = states.get(store);
  if (!surfaces) {
    surfaces = new Map();
    states.set(store, surfaces);
  }
  let state = surfaces.get(id);
  if (!state) {
    state = { axis: 'U', row: 0, point: 0 };
    surfaces.set(id, state);
  }
  return state;
}
