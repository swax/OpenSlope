import type { V3 } from '../../core/doc/types';
import { addSpecialZone, SPECIAL_LABELS, type SpecialZoneKind } from '../../core/props/special';
import type { Store } from '../state/store';
import type { Viewport, Mode } from '../viewport/viewport';
import { toast } from '../ui/components/toast';

export function createSpecialPropOps(deps: {
  store: Store; viewport: Viewport; cancelPlacement: () => void;
  setMode: (mode: Mode) => void; scheduleRebuild: () => void; rebuildTools: () => void;
}) {
  const { store, viewport, cancelPlacement, setMode, scheduleRebuild, rebuildTools } = deps;
  function select(id: string) {
    const index = store.mdoc.props?.findIndex(prop => prop.id === id) ?? -1;
    if (index < 0) return;
    cancelPlacement();
    store.armedProp = null; viewport.setPropArmed(null);
    store.selectedProp = index; store.selectedRefProp = null; store.multiSel = [];
    store.selectedGem = null; store.selectedRail = null; store.selectedNode = null;
    store.selectedLight = null; store.selectedRefLight = null;
    store.selectedScreen = null; store.selectedRefScreen = null;
    store.selectedLine = null; store.selectedLineNode = null;
    store.lineDrawing = false; viewport.setLineDrawing(false);
    store.specialPropView = undefined;
    setMode('props');
    scheduleRebuild(); rebuildTools();
  }
  function add(kind: SpecialZoneKind) {
    const target = viewport.controls.target;
    const position: V3 = [target.x, target.y, -target.z];
    const prop = addSpecialZone(store.mdoc, kind, position);
    select(prop.id!);
    toast(`${SPECIAL_LABELS[kind]} added — move or resize it in the viewport or its settings.`, 'info');
  }
  return { add, select };
}
export type SpecialPropOps = ReturnType<typeof createSpecialPropOps>;
