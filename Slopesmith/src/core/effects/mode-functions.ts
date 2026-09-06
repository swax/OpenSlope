import type { RaceMode } from '../doc/race';
import type { EffectFunction, EffectNode, EffectsDocument } from './document';

/** The exact SSF function name the engine dispatches when a game mode is selected. */
export function effectModeFunctionName(mode: RaceMode): 'RaceMode' | 'ShowoffMode' | 'FreerideMode' {
  if (mode === 'race') return 'RaceMode';
  if (mode === 'showoff') return 'ShowoffMode';
  return 'FreerideMode';
}

/** Resolve a mode entry point case-insensitively. Native names are canonical, while authored documents are editable. */
export function effectModeFunction(document: EffectsDocument, mode: RaceMode): EffectFunction | null {
  const wanted = effectModeFunctionName(mode).toLowerCase();
  return document.functions.find(fn => fn.name.trim().toLowerCase() === wanted) ?? null;
}

/**
 * Flatten the named functions reached from one mode entry point. MainType 21 and 26 are the two function-call
 * opcodes; cycles are legal data, so each function is visited once. The engine uses these entry points for the
 * level-authored mode configuration (HideShowOff / HideRace), not just as labels.
 */
export function effectModeNodes(document: EffectsDocument, mode: RaceMode): EffectNode[] {
  const entry = effectModeFunction(document, mode);
  if (!entry) return [];
  const seen = new Set<string>();
  const out: EffectNode[] = [];
  const visit = (fn: EffectFunction) => {
    if (seen.has(fn.id)) return;
    seen.add(fn.id);
    for (const node of fn.nodes) {
      out.push(node);
      if ((node.mainType !== 21 && node.mainType !== 26) || !node.references?.function) continue;
      const called = document.functions.find(candidate => candidate.id === node.references!.function);
      if (called) visit(called);
    }
  };
  visit(entry);
  return out;
}

/**
 * Stable instance resource ids disabled by the selected mode entry point.
 *
 * Retail's `HideShowOff` / `HideRace` leaves express presence through MainType 7 calls into a tiny
 * DeadNode graph. That graph is not the ordinary MainType-7 `property.breakable-kill` shape, so a preview
 * that merely dispatches it stops the target's node without removing the target draw. At mode select the
 * call edge itself is the useful authored fact: every reached instance target belongs to the content set the
 * selected mode disables. Snowknife uses the same leaf targets to bake Unity's mode masks.
 */
export function effectModeHiddenInstanceIds(document: EffectsDocument, mode: RaceMode): Set<string> {
  const hidden = new Set<string>();
  for (const node of effectModeNodes(document, mode)) {
    if (node.mainType === 7 && node.references?.instance) hidden.add(node.references.instance);
  }
  return hidden;
}

/**
 * Known models from the native LTG GemIndex layer are Showoff objects even though retail does not list them
 * in HideShowOff. This name check is a compatibility fallback; current reference payloads carry LTGState.
 * This is a game-side presence rule, confirmed in a live retail run: Race and Freeride never instantiate the
 * gem layer, while Showoff does. Keep it separate from the authored-function traversal above so the absence of
 * gem MainType-7 targets remains represented accurately.
 */
export function nativeGemModelIsShowoffOnly(modelName: string): boolean {
  return /^gem_(?:trickmultiplier|railsupport)/i.test(modelName.trim());
}

/**
 * Retail stores its complete native Showoff object layer in LTG `GemIndex` (Instances.json `LTGState == 2`).
 * Despite that list's name, it also contains non-pickup support geometry such as `Gem_RailSupport_*`.
 * The model-name fallback keeps older/reference payloads that predate `ltgState` behaving correctly.
 */
export function nativeInstanceIsShowoffOnly(instance: { ltgState?: number; modelName: string }): boolean {
  return instance.ltgState === 2 || nativeGemModelIsShowoffOnly(instance.modelName);
}

/** Whether an effect host is instantiated in one participant's selected mode. Shared ride events may cross
 * mode boundaries, but they must not resurrect an object that the receiving mode deliberately leaves out. */
export function effectHostIsPresentInMode(mode: RaceMode,
  presence: { showoffOnly?: boolean; hiddenByMode?: boolean }): boolean {
  return !presence.hiddenByMode && (mode === 'showoff' || !presence.showoffOnly);
}

/** Stable spline resource ids whose rail-candidacy flag this mode clears (MainType 25, Effect 0). */
export function effectModeDisabledSplineIds(document: EffectsDocument, mode: RaceMode): Set<string> {
  const disabled = new Set<string>();
  for (const node of effectModeNodes(document, mode)) {
    if (node.mainType !== 25 || !node.references?.spline) continue;
    const spline = node.payload?.Spline;
    if (spline && typeof spline === 'object' && !Array.isArray(spline) && Number(spline.Effect) === 0)
      disabled.add(node.references.spline);
  }
  return disabled;
}
