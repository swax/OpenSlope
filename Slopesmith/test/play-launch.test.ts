// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// createPlay imports the browser toast singleton; the launch paths under test never toast, but its module needs
// the one element at import time.
const toastNode = { textContent: '', className: '' };
Object.assign(globalThis, {
  document: { getElementById: () => toastNode },
  window: { setTimeout },
});

const { createPlay } = await import('../src/app/ride/play');
const {
  lastRidePointerWasTouch, noteRidePointerType, preferImmersivePlay,
} = await import('../src/app/ride/input-modality');
const {
  DEFAULT_XR_RENDER_SCALE, XR_RENDER_SCALE_STEP, reconcileXrEyeBuffer, xrEyeBufferNote, xrScaleMayBeCapped,
} = await import('../src/app/ride/xr/config');
const { MAX_VR_RENDER_SCALE } = await import('../src/app/state/store');

assert.equal(MAX_VR_RENDER_SCALE, 3, 'VR render scale permits up to 3× framebuffer supersampling');
assert.equal(DEFAULT_XR_RENDER_SCALE, 1.5, 'WebXR render scale defaults to 1.5×');
assert.equal(XR_RENDER_SCALE_STEP, 0.1, 'VR render scale moves in 0.1× increments');

assert.equal(preferImmersivePlay(true, true), true,
  'an XR-capable coarse browser panel leads with immersive Play');
assert.equal(preferImmersivePlay(true, false), false,
  'a fine-pointer desktop keeps its ordinary screen-first launch flow even when a headset is connected');
assert.equal(preferImmersivePlay(false, true), false,
  'a coarse phone without an immersive runtime remains an ordinary touch ride');
noteRidePointerType('mouse');
assert.equal(lastRidePointerWasTouch(), false, 'a browser/controller ray is not inferred to be direct touch');
noteRidePointerType('touch');
assert.equal(lastRidePointerWasTouch(), true, 'an actual touch pointer enables the direct-touch modality');

assert.match(xrEyeBufferNote(null, 1), /after the first VR launch/,
  'setup explains why no 1× resolution exists before a headset session');
assert.equal(xrEyeBufferNote({
  eyeWidth: 2000, eyeHeight: 2200, views: 2, renderScale: 1, requestedScale: 1,
  nativeRenderScale: 1, maxRenderScale: 2,
}, 1),
  '1×: 2000×2200 per eye · 2 views · measured on the last headset · likely cap 2× · runtime native 1× (not a cap).');
assert.match(xrEyeBufferNote({
  eyeWidth: 1500, eyeHeight: 1650, views: 2, renderScale: 0.75, requestedScale: 0.75,
  nativeRenderScale: null, maxRenderScale: null,
}, 3),
  /3× requests about 6000×6600 per eye · estimated 1× 2000×2200/,
  'the readout derives a nominal 1× baseline while distinguishing a projected request from an actual buffer');
assert.deepEqual(reconcileXrEyeBuffer(
  { eyeWidth: 1250, eyeHeight: 1350, views: 2, renderScale: 1, requestedScale: 1,
    nativeRenderScale: 1, maxRenderScale: 1 },
  { eyeWidth: 2500, eyeHeight: 2700, views: 2, renderScale: 3, requestedScale: 3,
    nativeRenderScale: 1, maxRenderScale: null },
), { eyeWidth: 2500, eyeHeight: 2700, views: 2, renderScale: 2, requestedScale: 3,
  nativeRenderScale: 1, maxRenderScale: 2 },
'a runtime-clamped 3× allocation is retained and presented as the effective 2× maximum');
assert.deepEqual(reconcileXrEyeBuffer(
  { eyeWidth: 1250, eyeHeight: 1350, views: 2, renderScale: 1, requestedScale: 1,
    nativeRenderScale: 1, maxRenderScale: null },
  { eyeWidth: 2500, eyeHeight: 2700, views: 2, renderScale: 2, requestedScale: 2,
    nativeRenderScale: 1, maxRenderScale: null },
), { eyeWidth: 2500, eyeHeight: 2700, views: 2, renderScale: 2, requestedScale: 2,
  nativeRenderScale: 1, maxRenderScale: null },
'a measured 2× allocation clears an overly conservative 1× cap while retaining native 1× as context');
assert.equal(xrScaleMayBeCapped({
  eyeWidth: 2500, eyeHeight: 2700, views: 2, renderScale: 2, requestedScale: 3,
  nativeRenderScale: 1, maxRenderScale: 2,
}, 3), true, 'a selection above the observed allocation bound is advisory-warning red');
assert.equal(xrScaleMayBeCapped({
  eyeWidth: 2500, eyeHeight: 2700, views: 2, renderScale: 2, requestedScale: 2,
  nativeRenderScale: 1, maxRenderScale: 2,
}, 2), false, 'a selection at the observed bound keeps the ordinary resolution styling');
assert.equal(xrScaleMayBeCapped({
  eyeWidth: 2500, eyeHeight: 2700, views: 2, renderScale: 2, requestedScale: 2,
  nativeRenderScale: 1, maxRenderScale: null,
}, 2), false, 'the runtime-native 1× factor alone is never mistaken for a hard cap');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(wait: Promise<void>) {
  const store = {
    currentMode: 'play', playTarget: 'reference', playSpawnRef: [1, 2, 3], playSpawnAuthored: [4, 5, 6],
    placingStart: false, playAiMax: 6, playCountdownOn: false, playTelemetryOn: false,
    playVrRenderScale: 0.75, playVrEyeBuffer: null, playSmoothCutoutsOn: true,
    playVrLayerMode: 'webgl', playVrStatsOn: false,
    mdoc: { course: { knots: [] } },
  };
  let effectRequests = 0, rides = 0, watches = 0, vrSessions = 0, effectsAtVrRequest = -1, persists = 0;
  let rideArgs: unknown[] = [];
  const playingEvents: Array<'authored' | 'reference' | null> = [];
  let vrArgs: unknown[] = [];
  const viewport = {
    canRideReference: true, watching: false, riding: false, xrPlaying: false,
    startRide: (...args: unknown[]) => { rides++; rideArgs = args; }, startWatch: () => { watches++; return true; },
    startXrPlay: (...args: unknown[]) => {
      vrSessions++;
      effectsAtVrRequest = effectRequests;
      vrArgs = args;
      return Promise.resolve(true);
    },
    stopXrPlay: () => {},
    stopRide: () => {}, stopWatch: () => {}, setPlayActive: () => {}, showRideSpawn: () => {},
    referenceSpawn: () => ({ pos: [0, 0, 0], heading: null }), dataToWorld: (v: unknown) => v,
  };
  const play = createPlay({
    store: store as never,
    viewport: viewport as never,
    persistUi: () => { persists++; }, rebuildTools: () => {}, updateCmdSheet: () => {}, syncSkyVisibility: () => {},
    ensureReferenceEffects: () => { effectRequests++; return wait; },
    onPlayingChanged: target => { playingEvents.push(target); },
  });
  return {
    store, viewport, play,
    counts: () => ({ effectRequests, rides, watches }),
    rideArgs: () => rideArgs,
    vr: () => ({ vrSessions, effectsAtVrRequest, vrArgs }),
    playingEvents: () => [...playingEvents],
    persists: () => persists,
  };
}

// Leaving Play while the multi-megabyte effects request is pending invalidates the captured launch.
{
  const gate = deferred();
  const h = harness(gate.promise);
  const pending = h.play.startPlay();
  assert.equal(h.play.launching, 'play');
  h.play.cancelLaunch();
  h.store.currentMode = 'edit';
  gate.resolve();
  await pending;
  assert.deepEqual(h.counts(), { effectRequests: 1, rides: 0, watches: 0 });
  assert.deepEqual(h.playingEvents(), [], 'a cancelled launch never advertises active play');
  assert.equal(h.play.launching, null);
}

// A second click joins the live launch instead of creating another effects request or ride.
{
  const gate = deferred();
  const h = harness(gate.promise);
  const first = h.play.startPlay();
  const second = h.play.startPlay();
  assert.deepEqual(h.counts(), { effectRequests: 1, rides: 0, watches: 0 });
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(h.counts(), { effectRequests: 1, rides: 1, watches: 0 });
  assert.equal(h.rideArgs().at(-1), true, 'ordinary flat Play permits touch controls when real touch input appears');
  assert.deepEqual(h.playingEvents(), ['reference'],
    'the roster marker begins on the ridden Reference only after the ride actually starts');
  h.play.exitRide();
  assert.deepEqual(h.playingEvents(), ['reference', null], 'leaving the ride removes the roster marker');
  assert.equal(h.play.launching, null);
}

// A headset panel's explicit screen fallback is still a normal ride, but cannot mistake its controller ray for
// a touchscreen even if the browser reports that primary pointer as coarse or touch-like.
{
  const h = harness(Promise.resolve());
  await h.play.startPlay(false);
  assert.equal(h.rideArgs().at(-1), false,
    'Play on screen threads the touch-control opt-out through the ordinary launch contract');
}

// Switching target during the wait also cancels the reference launch.
{
  const gate = deferred();
  const h = harness(gate.promise);
  const pending = h.play.startWatch();
  h.play.enterPlaySetup('authored');
  gate.resolve();
  await pending;
  assert.deepEqual(h.counts(), { effectRequests: 1, rides: 0, watches: 0 });
}

/**
 * VR play's ordering rule, which is a browser rule and not a preference (docs/048): WebXR gates
 * `requestSession` on USER ACTIVATION, and awaiting anything first spends it. So the headset must be asked for
 * BEFORE the reference level's effects are fetched — the exact opposite of `startPlay`, which waits for them.
 * Reversing the two reads as "the VR button does nothing on a reference mountain", intermittently, in the
 * headset, which is about the worst place to debug it from.
 */
{
  const gate = deferred();
  const h = harness(gate.promise);
  const pending = h.play.startVr();
  assert.equal(h.vr().vrSessions, 1);
  assert.equal(h.vr().effectsAtVrRequest, 0,
    'the session is requested inside the click, before any effects fetch is awaited');
  assert.deepEqual(h.vr().vrArgs.slice(6, 10), [0.75, 'webgl', true, false],
    'render scale, layer path, MSAA, and the diagnostics toggle reach the session at launch');
  const statsChanged = h.vr().vrArgs[10];
  assert.equal(typeof statsChanged, 'function', 'the headset can report a live stats change back to Test settings');
  (statsChanged as (enabled: boolean) => void)(true);
  assert.equal(h.store.playVrStatsOn, true, 'a wrist stats change becomes the next session’s starting state');
  assert.equal(h.persists(), 1, 'the live wrist choice is persisted');
  const eyeBufferMeasured = h.vr().vrArgs[11];
  assert.equal(typeof eyeBufferMeasured, 'function', 'the session can return its actual eye viewport to Test settings');
  (eyeBufferMeasured as (measurement: unknown) => void)({
    eyeWidth: 1500, eyeHeight: 1650, views: 2, renderScale: 0.75,
    requestedScale: 0.75, nativeRenderScale: 1, maxRenderScale: 2,
  });
  assert.deepEqual(h.store.playVrEyeBuffer,
    { eyeWidth: 1500, eyeHeight: 1650, views: 2, renderScale: 0.75,
      requestedScale: 0.75, nativeRenderScale: 1, maxRenderScale: 2 },
    'the last measured headset buffer is retained for the setup readout');
  assert.equal(h.persists(), 2, 'the measured viewport survives a page reload');
  gate.resolve();
  await pending;
  assert.equal(h.counts().effectRequests, 1, 'the effects still load — behind the rider, once they are in VR');
  assert.equal(h.counts().rides, 0, 'and entering VR mounts no board: you arrive on foot');
  assert.deepEqual(h.playingEvents(), ['reference'], 'an entered VR play session marks its Reference target');
  (h.vr().vrArgs[3] as () => void)();
  assert.deepEqual(h.playingEvents(), ['reference', null], 'ending the VR session removes the roster marker');
}

// The Test toolbox keeps its everyday flow stable: gear → actions → position → avatar → VR options → options → tuning. This is a
// source-order contract because lil-gui appends each controller/folder at the call site in exactly this order.
{
  const panel = readFileSync(resolve(process.cwd(), 'src/app/ui/tool-panels/play.ts'), 'utf8');
  const gear = panel.indexOf('gui.$children.appendChild(gearButtonRow);');
  const actions = panel.indexOf('if (play.launching)');
  const watch = panel.indexOf(".name('👁 Watch the AI')");
  const aiDropHint = panel.indexOf('const out = viewport.aiRiderCount;');
  const position = panel.indexOf("const position = editSection('play-start', 'Position');");
  const goToPlayer = panel.indexOf(".name('Go to player')");
  const avatar = panel.indexOf("const avatar = editSection('play-avatar', 'Avatar', true);");
  const avatarChoice = panel.indexOf('if (!riderModelCatalogSettled())');
  const vrOptions = panel.indexOf("const vrOptions = editSection('play-vr-options', 'VR options', true);");
  const options = panel.indexOf("const options = editSection('play-options', 'Options', true);");
  const tuning = panel.indexOf("const tuning = editSection('play-tuning', 'Tuning', true);");
  assert.ok(gear >= 0 && gear < actions && actions < watch && watch < aiDropHint && aiDropHint < position
    && position < goToPlayer && goToPlayer < avatar && avatar < avatarChoice && avatarChoice < vrOptions && vrOptions < options
    && options < tuning,
  'the panel orders Play/AI controls, Position, Avatar, conditional VR options, Options, then Tuning last');
  let previousOption = options;
  for (const label of [
    'AI riders', 'Snow', 'Race countdown',
  ]) {
    const at = panel.indexOf(`.name('${label}')`, previousOption + 1);
    assert.ok(at > previousOption, `${label} appears in the requested Options order`);
    previousOption = at;
  }
  assert.doesNotMatch(panel, /detail\(position,/, 'Position has no always-visible coordinate row');
  assert.match(panel, /Current start: X /, 'Reset start’s tooltip carries the current X/Y/Z coordinates');
  assert.match(panel, /const activePlayers = viewport\.activeMapPlayers\(\);\s+if \(activePlayers\.length\)/,
    'Go to player is omitted when this map has no other active players');
  assert.match(panel, /viewport\.goToMapPlayer\(sessionId\)/,
    'the player dropdown routes through the setup-camera/live-ride action');
  assert.match(panel, /avatar\.add\(\{ model: store\.playRiderModel \}/,
    'the rider choice lives inside Avatar');
  assert.doesNotMatch(panel, /note\(avatar, 'Mixamo FBX imports/,
    'the Avatar panel has no separate Mixamo storage note');
  assert.match(panel, /server-wide rider library/,
    'the Mixamo tooltip retains the storage guidance');
  assert.match(panel, /options\.add\(aiRiders, 'count', 0, MAX_AI_RIDERS, 1\)\.name\('AI riders'\)/,
    'AI enable and cap are one zero-to-max rider-count control');
  for (const control of ['countdown']) {
    assert.match(panel, new RegExp(`options\\.add\\(\\{ ${control}:`),
      `${control} is grouped under Test Options`);
  }
  for (const control of ['boardFx', 'colliders', 'paths', 'telemetry']) {
    assert.match(panel, new RegExp(`tuning\\.add\\(\\{ ${control}:`),
      `${control} is grouped under the final Tuning panel`);
  }
  let previousTuning = tuning;
  for (const label of [
    'MSAA + smooth cutouts', 'Board FX', 'Draw distance', 'Show AI paths', 'Show colliders', 'Collect telemetry',
  ]) {
    const at = panel.indexOf(`.name('${label}')`, previousTuning + 1);
    assert.ok(at > previousTuning, `${label} appears in the requested Tuning order`);
    previousTuning = at;
  }
  assert.match(panel, /vrOptions\.add\(store, 'playVrStatsOn'\)/,
    'the conditional VR checkbox is grouped under VR options');
  assert.match(panel, /resolutionNote = note\(vrOptions, xrEyeBufferNote/,
    'the measured/projected per-eye resolution sits directly under the render-scale slider');
  assert.match(panel, /MIN_VR_RENDER_SCALE, MAX_VR_RENDER_SCALE, XR_RENDER_SCALE_STEP/,
    'the slider keeps the full 0.5×–3× range and uses the shared WebXR increment');
  assert.match(panel, /classList\.toggle\('sp-vr-resolution-capped', xrScaleMayBeCapped/,
    'a likely-clamped projection is warned in the readout without disabling its scale');
  assert.doesNotMatch(panel, /playVrAntialiasOn/,
    'VR has no second antialias switch that can contradict the global tuning setting');
  assert.match(panel, /tuning\.add\(\{ antialias: store\.playSmoothCutoutsOn \}[\s\S]*location\.reload\(\)/,
    'global MSAA plus smooth cutouts is a Tuning option that reloads the immutable WebGL sample count');
  assert.match(panel, /&& xrAvailable\) \{\s*const vrOptions/,
    'VR options only appears when WebXR is available');
  assert.match(panel,
    /preferImmersivePlay\(xrAvailable, coarsePointer\)[\s\S]*addVrLaunch\(\);[\s\S]*addScreenLaunch\(true\)/,
    'an XR-capable coarse browser puts native VR before the explicit screen fallback');
  assert.match(panel, /Play on screen[\s\S]*Quest Touch controllers are available only inside Play in VR/,
    'the headset screen fallback says why its motion controllers cannot drive navigator gamepad input');
  assert.match(panel, /coarsePointer && xrAvailable === undefined[\s\S]*Checking headset/,
    'a coarse panel cannot enter the flat ride during the brief headset capability check');
}

console.log('PLAY LAUNCH: PASS');
