/**
 * The mutation → render funnel. Every edit calls `scheduleRebuild()`; it arms the undo debounce
 * (`scheduleCommit`) and coalesces a burst of edits into ONE render on the next animation frame — so a slider
 * drag, a paint stroke, or a burst of remote assignments arriving together rebuilds the scene once, not per
 * event. The render itself (pushing the doc + the current selections into the viewport, deriving the rig,
 * persisting) is the host's `render` callback; the funnel owns the coalescing, the error boundary, and the
 * settle timer below.
 *
 * ## Why a settle pass exists
 *
 * A rebuild has two halves with different natures. What the changed patches look like is LOCAL — the
 * dependency radius names it exactly, and it is what a render has to get right this frame. What the mountain
 * casts and occludes is GLOBAL: a moved ridge shades ground it never touches, so cast shadow and ambient
 * occlusion cannot be resolved patch by patch at any radius. The same is true of the whole-mesh diagnostics
 * (unresolved T contacts, edge crossings, coincident corners).
 *
 * Those cannot be made incremental, so they are DEFERRED instead: incremental renders run on the last full
 * bake, and this re-runs it once nothing has moved for a moment. At 25 Hz of somebody else's drag that is the
 * difference between paying for a whole-mountain occlusion bake forty times over and paying for it once, when
 * the drag ends.
 */

/**
 * Quiet time before the deferred whole-mountain work runs.
 *
 * It has to outlast the gap between two consecutive remote assignments (40 ms at the coalescing rate) and the
 * gap between two strokes of a hand editing continuously, without leaving a visibly wrong sun hanging around
 * after somebody stops. 400 ms is comfortably longer than both and shorter than a person can finish looking
 * at what they just did — it is also just past the 350 ms undo-commit debounce, so a settle lands after the
 * change it belongs to has been sealed into history rather than in the middle of it.
 */
export const SETTLE_MS = 400;

export function createRebuilder(deps: {
  /** Arm the undo debounce (history.scheduleCommit) — every mutation coalesces into one undo entry. */
  scheduleCommit: () => void;
  /** The actual rebuild: push the doc + selections into the viewport, derive lights, persist. */
  render: () => void;
  /** A render threw (report it to the status line instead of blanking the frame loop). */
  onError: (e: unknown) => void;
  /** The deferred whole-mountain work — the occlusion re-bake and the mesh diagnostics. Armed by the host
   *  from `render` whenever it took the incremental path, and pushed back by any further change. */
  settle?: () => void;
  settleMs?: number;
}) {
  let queued = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelSettle = () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  };

  /** Ask for the deferred pass once the mountain has been quiet for `SETTLE_MS`. Re-arming pushes it back,
   *  so a continuous stream of changes never pays for it and the moment it stops does. */
  function scheduleSettle() {
    if (!deps.settle) return;
    cancelSettle();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      try { deps.settle!(); } catch (e) { deps.onError(e); }
    }, deps.settleMs ?? SETTLE_MS);
  }

  function scheduleRebuild() {
    deps.scheduleCommit(); // every mutation funnels here -> coalesce a burst into one undo entry
    cancelSettle();        // something moved again; whatever was about to settle is out of date
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try { deps.render(); } catch (e) { deps.onError(e); }
    });
  }
  return { scheduleRebuild, scheduleSettle };
}
