import type { V3 } from '../../core/doc/types';
import { sampleSpine, spineAt, totalLength } from '../../core/math/spine';
import { docPositions } from '../../core/doc/doc-edit';
import type { Store } from '../state/store';
import type { Viewport } from '../viewport/viewport';
import { toast } from '../ui/components/toast';
import { reconcileXrEyeBuffer } from './xr/config';

/**
 * Test mode (stored as `play`; docs/016): the test-ride setup + launch glue. Pick a mountain to ride (the authored one or a
 * loaded reference), place / default its world-space start point + its marker, then hand the board to the
 * viewport's ride. Leaving the ride keeps you in Play so you can nudge the start and re-launch. The spawn
 * points live on the store (per target, transient); everything else is viewport ride calls.
 *
 * Watch is the same field without a board of your own: it needs no start point and takes no camera, so the
 * editor keeps its view and you orbit the mountain while the AI riders race it.
 *
 * A slope click ordinarily **drops an AI rider** where you clicked and lets it go — the cheapest way to ask
 * "what does the game do here" about a pitch you are shaping, or about an AI line you have just moved, without
 * riding the whole mountain down to it. Moving the ride start is the rarer job, so it is a deliberate, armed,
 * ONE-shot gesture (`armStartPlacement`) rather than the default meaning of a click.
 */

export type PlayDeps = {
  store: Store;
  viewport: Viewport;
  persistUi: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  syncSkyVisibility: () => void;
  ensureReferenceEffects: () => Promise<void>;
  /** Publish actual play-session start/stop state for the Users roster. */
  onPlayingChanged: (target: 'authored' | 'reference' | null) => void;
};

export function createPlay(deps: PlayDeps) {
  const {
    store, viewport, persistUi, rebuildTools, updateCmdSheet, syncSkyVisibility, ensureReferenceEffects,
    onPlayingChanged,
  } = deps;
  let launching: 'play' | 'watch' | null = null;
  let launchGeneration = 0;

  /** The authored mountain's default start — a little way down the active course (so you begin on the run, not
   *  stuck in the gate), heading downhill along the spine; with no course, the middle of the terrain. Data space. */
  function rideSpawn(): { pos: V3; heading: V3 | null } {
    const c = store.mdoc.course;
    if (c.knots.length >= 2) {
      const s = sampleSpine(c.knots);
      const start = spineAt(s, Math.min(4, totalLength(s) * 0.03)); // a few m past the gate
      return { pos: start.pos, heading: start.fwd };
    }
    let x = 0, y = 0, z = 0;
    const P = docPositions(store.mdoc), n = P.length / 3;
    for (let i = 0; i < P.length; i += 3) { x += P[i]; y += P[i + 1]; z += P[i + 2]; }
    return { pos: [x / n, y / n, z / n], heading: null };
  }

  /** The current target's start point (world space), or null if none set yet. */
  function currentPlaySpawn(): V3 | null { return store.playTarget === 'reference' ? store.playSpawnRef : store.playSpawnAuthored; }

  /** A sensible default start (world): a few metres down either mountain's course (reference centre fallback),
   *  facing down it. The heading matters — courses don't share a compass direction, so a rider dropped without
   *  one faces the board's default and is backwards on any hill that runs the other way. */
  function defaultPlaySpawn(): { pos: V3; heading: V3 | null } | null {
    if (store.playTarget === 'reference') return viewport.referenceSpawn();
    const authored = rideSpawn();
    return {
      pos: viewport.dataToWorld(authored.pos),
      // The spine's forward is data space; the ride is world space, and the two differ by the Z flip alone.
      heading: authored.heading ? [authored.heading[0], authored.heading[1], -authored.heading[2]] : null,
    };
  }

  /** Store + show a new start point for the current target (from a slope click or the Reset button). */
  function setPlaySpawn(world: V3, refreshTools = false) {
    if (store.playTarget === 'reference') store.playSpawnRef = world; else store.playSpawnAuthored = world;
    viewport.showRideSpawn(world);
    if (refreshTools && store.currentMode === 'play') rebuildTools();
  }

  /** Arm the ONE-shot start placement: the next slope click moves the ride start instead of dropping a rider. */
  function armStartPlacement() {
    store.placingStart = true;
    toast('click the slope — or a prop standing on it — to place the ride start', 'info');
    if (store.currentMode === 'play') rebuildTools();
  }

  /** Disarm it — the click landed, Esc, or Play was left with it still armed. */
  function cancelStartPlacement(refreshTools = true) {
    if (!store.placingStart) return;
    store.placingStart = false;
    if (refreshTools && store.currentMode === 'play') rebuildTools();
  }

  /**
   * A click on the target mountain (viewport `onPlayClick`). With the start placement armed it consumes that
   * one-shot and moves the start; otherwise it drops an AI rider there and the rider sets off down whichever AI
   * line runs nearest to it, which is what makes a click a question about the terrain rather than a chore.
   */
  function clickSlope(world: V3) {
    if (store.placingStart) {
      store.placingStart = false;
      setPlaySpawn(world, true);
      toast('ride start placed', 'ok');
      return;
    }
    if (store.playAiMax === 0) {
      toast('AI riders are off — raise Test ▸ Options ▸ AI riders above zero first.', 'info');
      return;
    }
    if (!viewport.dropAiRider(world)) {
      toast('No AI paths on this mountain — a rider has no line to follow. Draw a course in Scene first.', 'warn');
      return;
    }
    if (store.currentMode === 'play') rebuildTools(); // the panel counts what's out there
  }

  /** Ensure the current target has a start point + the marker is shown (default it if the user hasn't placed one). */
  function ensurePlaySpawn() {
    const cur = currentPlaySpawn();
    if (cur) { viewport.showRideSpawn(cur); return; }
    const d = defaultPlaySpawn();
    if (d) setPlaySpawn(d.pos); else viewport.showRideSpawn(null);
  }

  /** Enter Play SETUP for `target`: keep the editor view intact, show its start marker, and rebuild Tools. */
  function enterPlaySetup(target: 'authored' | 'reference', refreshTools = true) {
    if (target !== store.playTarget) cancelLaunch(); // a launch belongs to the target captured when it began
    if (viewport.watching) viewport.stopWatch(); // a field on the other mountain has nothing to do with this one
    cancelStartPlacement(false); // an armed one-shot belongs to the mountain it was armed on
    store.playTarget = target;
    if (target === 'reference') void ensureReferenceEffects();
    syncSkyVisibility();
    viewport.setPlayActive(true, target);
    ensurePlaySpawn();
    persistUi();
    if (refreshTools && store.currentMode === 'play') rebuildTools();
  }

  /** The Play button: drop the board at the chosen start and hand over to the ride. */
  async function startPlay(touchControls = true) {
    if (store.currentMode !== 'play' || launching) return;
    const target = store.playTarget;
    if (target === 'reference' && !viewport.canRideReference) { toast('Load a reference level first (Scene ▸ Reference).', 'warn'); return; }
    const generation = ++launchGeneration;
    launching = 'play'; rebuildTools();
    try {
      if (target === 'reference') await ensureReferenceEffects();
      if (generation !== launchGeneration || store.currentMode !== 'play' || store.playTarget !== target ||
        (target === 'reference' && !viewport.canRideReference)) return;
      cancelStartPlacement(false);
      // A custom start is a bare click point, so it borrows the default's heading rather than facing nowhere.
      const fallback = defaultPlaySpawn();
      const placed = currentPlaySpawn();
      const spawn = placed ?? fallback?.pos ?? null;
      if (!spawn) { toast('No start point — use Position ▸ Set custom start.', 'warn'); return; }
      viewport.startRide(target, spawn, fallback?.heading ?? null, exitRide, store.playAiMax > 0,
        store.playCountdownOn, store.playTelemetryOn, touchControls);
      onPlayingChanged(target);
      syncSkyVisibility(); // the target sky starts with the ride, not while positioning the setup marker
      updateCmdSheet();
    } finally {
      if (generation === launchGeneration) launching = null;
      if (store.currentMode === 'play') rebuildTools(); // loading indicator -> Stop, or back to setup on cancellation
    }
  }

  /**
   * The Play in VR button (docs/048): enter the headset and stand at the start with the board parked there.
   *
   * The order here is load-bearing. WebXR gates `requestSession` on USER ACTIVATION, and awaiting anything first
   * spends it — so the session is asked for before any preparation, not after, and a reference level's effects
   * are fetched behind the rider while they are still standing at the gate on foot. There is no `launching`
   * indicator for the same reason: the headset's own permission and loading screens are the wait.
   */
  async function startVr() {
    if (store.currentMode !== 'play' || launching || viewport.riding || viewport.xrPlaying) return;
    const target = store.playTarget;
    if (target === 'reference' && !viewport.canRideReference) { toast('Load a reference level first (Scene ▸ Reference).', 'warn'); return; }
    cancelStartPlacement(false);
    const fallback = defaultPlaySpawn();
    const spawn = currentPlaySpawn() ?? fallback?.pos ?? null;
    if (!spawn) { toast('No start point — use Position ▸ Set custom start.', 'warn'); return; }
    const entered = await viewport.startXrPlay(target, spawn, fallback?.heading ?? null, exitVr,
      store.playAiMax > 0, store.playTelemetryOn, store.playVrRenderScale, store.playVrLayerMode,
      store.playSmoothCutoutsOn, store.playVrStatsOn, enabled => {
        store.playVrStatsOn = enabled;
        persistUi();
      }, measurement => {
        const reconciled = reconcileXrEyeBuffer(store.playVrEyeBuffer, measurement);
        store.playVrEyeBuffer = reconciled;
        persistUi();
        return reconciled;
      });
    if (!entered) { toast('The headset did not start a VR session.', 'err'); return; }
    onPlayingChanged(target);
    syncSkyVisibility(); // the target sky comes with the run, exactly as it does for a desktop ride
    if (store.currentMode === 'play') rebuildTools();
    updateCmdSheet();
    // Behind the rider, who is on foot at the gate and cannot mount before this lands.
    if (target === 'reference') await ensureReferenceEffects();
  }

  /** The headset session ended — Stop, Esc, the system menu, or the rider taking it off. */
  function exitVr() {
    onPlayingChanged(null);
    syncSkyVisibility();
    if (store.currentMode === 'play') { viewport.showRideSpawn(currentPlaySpawn()); rebuildTools(); }
    updateCmdSheet();
  }

  /** Leave the ride (Esc while riding, or the Stop button): stop the board, show the start marker again, stay in
   *  Test mode so you can adjust and re-launch. */
  function exitRide() {
    viewport.stopRide();
    onPlayingChanged(null);
    syncSkyVisibility(); // back in Play setup: return to the flat editor background
    if (store.currentMode === 'play') { viewport.showRideSpawn(currentPlaySpawn()); rebuildTools(); }
    updateCmdSheet();
  }

  /** The Watch button: race the AI field on the target mountain with no board of your own, leaving the editor
   *  camera exactly where it is — so you keep orbiting the mountain while they run it ([Trailmap: 395]). */
  async function startWatch() {
    if (store.currentMode !== 'play' || launching) return;
    if (store.playAiMax === 0) { toast('AI riders are off — raise the rider count above zero first.', 'info'); return; }
    const target = store.playTarget;
    if (target === 'reference' && !viewport.canRideReference) { toast('Load a reference level first (Scene ▸ Reference).', 'warn'); return; }
    const generation = ++launchGeneration;
    launching = 'watch'; rebuildTools();
    try {
      if (target === 'reference') await ensureReferenceEffects();
      if (generation !== launchGeneration || store.currentMode !== 'play' || store.playTarget !== target ||
        (target === 'reference' && !viewport.canRideReference)) return;
      cancelStartPlacement(false);
      if (!viewport.startWatch(target)) { toast('No AI paths on this mountain to watch.', 'warn'); return; }
      updateCmdSheet();
    } finally {
      if (generation === launchGeneration) launching = null;
      if (store.currentMode === 'play') rebuildTools(); // loading indicator -> Stop, or back to setup on cancellation
    }
  }

  /** Leaving Play or switching its target invalidates an async launch without cancelling the shared effects fetch. */
  function cancelLaunch() {
    launchGeneration++;
    launching = null;
  }

  /** Put the watched field away (Esc, or the Stop button), staying in Play. */
  function stopWatch() {
    viewport.stopWatch();
    if (store.currentMode === 'play') rebuildTools();
    updateCmdSheet();
  }

  return {
    get launching() { return launching; },
    currentPlaySpawn, defaultPlaySpawn, setPlaySpawn, clickSlope, ensurePlaySpawn, enterPlaySetup,
    armStartPlacement, cancelStartPlacement, cancelLaunch,
    startPlay, exitRide, startWatch, stopWatch,
    startVr, stopVr: () => viewport.stopXrPlay(),
  };
}

export type Play = ReturnType<typeof createPlay>;
