import * as THREE from 'three';
import {
  estimatedRidePacingMs, measuredRideCpuMs, unmeasuredRideFrameMs,
  type GpuTimerState, type RidePerf,
} from '../perf';
import type { XrLayerMode } from './config';
import { formatRunClock } from '../../../core/doc/race';
import type { RideRunStatus } from '../run-status';
import { boostMeterSegments, RIDE_BOOST_METER_SEGMENTS } from '../score';

/**
 * The in-headset read-out for VR play (docs/048): a compact run/menu watch worn on the LEFT wrist, plus an
 * optional full profiler parked ahead of the rider.
 *
 * The editor's ride HUD (`ride/hud.ts`) is DOM over the canvas, which a headset never composites: in VR it is
 * still drawn, but only for whoever is watching the desktop mirror. So the rider gets this instead — the run
 * read-out in whole mph (the unit the in-world VRChat run HUD reads, Unity docs/vrchat/017), and under it the
 * profiler, because on this platform the frame budget is the feature and you cannot chase it from the desk.
 *
 * Neither is pinned to the head. The full profiler is a dashboard in the rider frame; the compact read-out is a
 * watch that can be glanced at and ignored, which is how VRChat's own boards work.
 *
 * **The panel must not become the thing it is measuring.** A canvas repaint plus its texture upload, at 72–120 Hz
 * per eye, is a real cost — and a profiler that inflates the number it reports is worse than none. So the whole
 * panel repaints at `REPAINT_HZ`, which is also as fast as anyone can read a changing number.
 */

const W = 512, PERF_H = 752, COMPACT_H = 486;
/**
 * Full panel size in metres. Sized for the distance the session parks it at (`session.ts`, ~1.2 m): about 22° wide,
 * which puts the 21 px profiler rows a shade under a degree tall — the size text stops being work to read.
 * At that distance the canvas is close to one texel per display pixel, so it stays crisp without a bigger upload.
 */
const PERF_W = 0.48;
/** A compact 18 cm wrist computer: large enough to read in a headset, but no longer a dashboard on the arm. */
const COMPACT_W = 0.18;
export type XrHudAction = 'calibrate' | 'restart' | 'stats' | 'view' | 'controls' | 'exit';
export type XrControlsMode = 'ride' | 'foot';
/** Four broad rows on the compact watch. Gaps remain after the invisible hit padding, so actions cannot overlap. */
const WATCH_BUTTONS: ReadonlyArray<{ action: XrHudAction; x: number; y: number; w: number; h: number }> = [
  { action: 'calibrate', x: 18, y: 108, w: 476, h: 52 },
  { action: 'restart', x: 18, y: 172, w: 232, h: 52 },
  { action: 'exit', x: 262, y: 172, w: 232, h: 52 },
  { action: 'stats', x: 18, y: 236, w: 232, h: 52 },
  { action: 'view', x: 262, y: 236, w: 232, h: 52 },
  { action: 'controls', x: 18, y: 300, w: 476, h: 52 },
];
const CONTROLS_BACK_BUTTON = { action: 'controls' as const, x: 18, y: 424, w: 476, h: 44 };
/** Invisible acquisition margin: visible buttons stay tidy while controller aim remains forgiving. */
const WATCH_HIT_PAD = 5;
/** How often the canvas is redrawn and re-uploaded. Five times a second is legible and costs ~4 MB/s. */
const REPAINT_HZ = 5;
/** Frame-time colouring against the display's own budget: inside it, over it, and badly over it. */
const OVER_BUDGET = 1.05, WAY_OVER = 1.5;

export interface XrHudState {
  /** Metres per second; the panel converts. */
  speed: number;
  grounded: boolean;
  /** −1 while riding switch. */
  lead: 1 | -1;
  grinding: boolean;
  boosting: boolean;
  /** 0..1 while the ollie is charging, else 0. */
  charge: number;
}

export interface XrHudCalibration {
  phase: 'ready' | 'countdown' | 'saved' | 'error';
  count?: number;
  standingHeight?: number;
  message?: string;
}

export interface XrControllerDiagramRow {
  control: 'TRIGGER' | 'GRIP' | 'STICK' | 'A' | 'B' | 'X' | 'Y';
  action: string;
}

export interface XrControllerDiagramLabels {
  left: readonly XrControllerDiagramRow[];
  right: readonly XrControllerDiagramRow[];
}

/** State-aware copy for the wrist help diagram. This deliberately mirrors `input.ts`; keeping it pure makes a
 * changed binding fail a headless test before stale instructions reach a headset. */
export function xrControllerDiagramLabels(mode: XrControlsMode): XrControllerDiagramLabels {
  return {
    left: mode === 'ride' ? [
      { control: 'TRIGGER', action: 'DISMOUNT' },
      { control: 'GRIP', action: 'CARRY' },
      { control: 'STICK', action: 'CARVE · TUCK/BRAKE' },
      { control: 'X', action: 'COURSE RESPAWN' },
      { control: 'Y', action: 'SHOW / HIDE MENU' },
    ] : [
      { control: 'TRIGGER', action: 'RIDE' },
      { control: 'GRIP', action: 'CARRY' },
      { control: 'STICK', action: 'MOVE' },
      { control: 'X', action: 'SPAWN BOARD' },
      { control: 'Y', action: 'SHOW / HIDE MENU' },
    ],
    right: [
      { control: 'TRIGGER', action: mode === 'ride' ? 'DISMOUNT' : 'RIDE' },
      { control: 'GRIP', action: 'CARRY' },
      { control: 'STICK', action: mode === 'ride' ? 'CLICK VIEW' : 'TURN · CLICK VIEW' },
      { control: 'A', action: mode === 'ride' ? 'HOLD · JUMP' : 'JUMP · DOUBLE / +B FLY' },
      { control: 'B', action: mode === 'ride' ? 'BOOST' : 'AIR BOOST · +A FLY' },
    ],
  };
}

export const XR_BOARD_CONTROL_NOTES = [
  'A + B turns a jump into flight; double-tap A also flies.',
  'Off-board boost is unlimited; empty hand aims with right controller.',
  'On board, B follows deck nose; holding it is a jetpack — even on ground.',
  'Airborne grip removes board; grip behind your head summons.',
  'Holding it: trigger re-equips; release grip throws.',
] as const;

/** What the profiler block draws. The broad phases come from the shared ride profiler so the wrist and the
 *  desktop HUD cannot disagree about where a frame went; the rest is what only a headset can tell you. */
export interface XrHudPerf {
  perf: Readonly<RidePerf>;
  /** The worst single frame of the last second. Averages hide the hitch that actually breaks presence. */
  worstMs: number;
  /** The display's own frame budget in ms, and the rate it came from. */
  budgetMs: number;
  displayHz: number;
  /** True when the RUNTIME reported that rate. False means it was measured from the fastest frame seen, and the
   *  panel says so — a budget everything else is coloured against must not quietly be a guess. */
  rateKnown: boolean;
  /** That fastest frame, in ms. Shown so the estimate can be checked rather than taken on trust. */
  bestMs: number;
  /** The size of ONE eye's buffer, and how many are being drawn. This is the fill cost, and it is not the
   *  canvas size — a headset commonly asks for far more pixels than the monitor behind it. */
  eyeWidth: number;
  eyeHeight: number;
  views: number;
  /** Requested and structurally observed render paths. A mismatch means Three could not be steered as asked. */
  layerRequested: XrLayerMode;
  layerKind: 'webgl' | 'projection' | 'none';
  /** True when the capability override succeeded and Three actually constructed a WebGL layer. */
  layerOverrideApplied: boolean;
  /** The layer's own compositor contract. True means it explicitly ignores app depth; null means unavailable. */
  depthIgnored: boolean | null;
  /** Actual WebGL context AA, effective layer AA, and known sample count (`null` = runtime-owned/unknown). */
  contextAntialias: boolean;
  layerAntialias: boolean | null;
  samples: number | null;
  powerPreference: WebGLPowerPreference;
  /** Unmasked renderer when the browser permits it; otherwise the ordinary WebGL renderer string. */
  gpu: string;
  /** The eye-buffer scale the session was started with, echoed so a sweep's readings can be told apart. */
  renderScale: number;
  /** The LAYER's effective fixed-foveation level, 0 (off) to 1 (most aggressive) — not what was requested.
   *  Null when the runtime offers no such control, which is the common PCVR answer. */
  foveation: number | null;
  /** Raw runtime eye Y and the applied floor correction. A saved body height came from the wrist T-pose. */
  rawHeadY: number;
  correctedHeadY: number;
  floorOffset: number;
  standingHeight: number | null;
  /** Effective XR render-state near plane (falling back to the parent camera before the runtime answers). */
  nearClip: number;
  /** `2×hand`, `2×grip`, mixed, or off for each side. Lower-body landmarks remain inferred IK. */
  handTracking: string;
}

/** Convert compact-panel UV into an action. Exported so its hit geometry stays headless-tested. */
export function xrHudActionAt(showPerf: boolean, uv: THREE.Vector2, controlsOpen = false): XrHudAction | null {
  if (showPerf) return null;
  const x = uv.x * W, y = (1 - uv.y) * COMPACT_H;
  const buttons = controlsOpen ? [CONTROLS_BACK_BUTTON] : WATCH_BUTTONS;
  for (const b of buttons) {
    if (x >= b.x - WATCH_HIT_PAD && x <= b.x + b.w + WATCH_HIT_PAD
      && y >= b.y - WATCH_HIT_PAD && y <= b.y + b.h + WATCH_HIT_PAD) return b.action;
  }
  return null;
}

export function createXrHud(label: string, showPerf = true) {
  const height = showPerf ? PERF_H : COMPACT_H;
  const width = showPerf ? PERF_W : COMPACT_W;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const object = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * (height / W)),
    // Never occluded: it floats a metre or so ahead of the rider, and a board that vanishes into the snow the
    // moment they crest a rise is no use to whoever is reading it. The session owns where it sits.
    new THREE.MeshBasicMaterial({
      map: texture, transparent: true, toneMapped: false, depthWrite: false, depthTest: false,
      // The watch follows a real wrist and can be rolled through either side; its single two-triangle face is
      // cheap enough to keep readable there. The front-facing profiler is always aimed at the eyes.
      side: showPerf ? THREE.FrontSide : THREE.DoubleSide,
    }),
  );
  object.renderOrder = 30;
  if (showPerf) object.raycast = () => {};

  let hint = '';
  let nextPaint = 0;

  /** Repaint, at most `REPAINT_HZ` times a second. `now` is the frame's own clock, so the gate costs no timer. */
  function draw(now: number, state: XrHudState | null, stats: XrHudPerf | null,
                calibration: XrHudCalibration | null = null, statsEnabled = false, thirdPerson = false,
                run: RideRunStatus | null = null, controlsOpen = false,
                controlsMode: XrControlsMode = state ? 'ride' : 'foot', carrying = false) {
    if (now < nextPaint) return;
    nextPaint = now + 1000 / REPAINT_HZ;

    ctx.clearRect(0, 0, W, height);
    ctx.fillStyle = 'rgba(10,16,24,0.78)';
    roundRect(ctx, 4, 4, W - 8, height - 8, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,190,255,0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    ctx.fillStyle = '#9fb6cc';
    ctx.font = '600 24px system-ui, sans-serif';
    ctx.fillText(label, 26, 42);
    if (stats) {
      ctx.textAlign = 'right';
      ctx.fillText(stats.displayHz > 0
        ? `${Math.round(stats.displayHz)} Hz${stats.rateKnown ? '' : ' est'}`
        : '? Hz', W - 26, 42);
      ctx.textAlign = 'left';
    }

    if (!showPerf && controlsOpen) {
      drawControlsPage(ctx, controlsMode, carrying);
      texture.needsUpdate = true;
      return;
    }

    if (!showPerf && run) drawRunHeader(ctx, run);

    if (!showPerf && run && run.phase !== 'running') {
      ctx.fillStyle = run.phase === 'finished' ? '#74e6a3' : '#ffd24a';
      ctx.font = '750 34px system-ui, sans-serif';
      ctx.fillText(run.phase === 'finished' ? 'FINISHED' : 'TIME UP', 26, 78);
      ctx.fillStyle = '#eaf4ff';
      ctx.font = '600 22px system-ui, sans-serif';
      ctx.fillText(run.mode === 'showoff'
        ? `${formatRunClock(run.elapsedSeconds)} · ${Math.max(0, Math.round(run.score)).toLocaleString()} pts`
        : formatRunClock(run.elapsedSeconds), 26, 105);
    } else if (state) {
      const digits = String(Math.round(state.speed * 2.236936));
      ctx.fillStyle = '#eaf4ff';
      ctx.font = '700 68px system-ui, sans-serif';
      ctx.fillText(digits, 26, 106);
      ctx.fillStyle = '#7f96ad';
      ctx.font = '600 24px system-ui, sans-serif';
      ctx.fillText('mph', 26 + measure(ctx, digits, '700 68px system-ui, sans-serif') + 10, 106);
      const flags = [run?.mode === 'showoff' && run.phase === 'running'
        ? `${Math.max(0, Math.round(run.score)).toLocaleString()} pts` : '',
        state.grinding ? 'GRIND' : !state.grounded ? 'AIR' : state.boosting ? 'BOOST' : '',
        state.lead < 0 ? 'SWITCH' : ''].filter(Boolean).join(' · ');
      if (flags) {
        ctx.fillStyle = '#5fd0ff';
        ctx.font = '600 24px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(flags, W - 26, 106);
        ctx.textAlign = 'left';
      }
      if (state.charge > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        roundRect(ctx, 26, 118, W - 52, 10, 5);
        ctx.fill();
        ctx.fillStyle = '#ffd24a';
        roundRect(ctx, 26, 118, (W - 52) * state.charge, 10, 5);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = '#eaf4ff';
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.fillText('on foot', 26, 100);
      if (run?.mode === 'showoff' && run.phase === 'running') {
        ctx.fillStyle = '#ffd56a';
        ctx.font = '700 24px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.max(0, Math.round(run.score)).toLocaleString()} pts`, W - 26, 100);
        ctx.textAlign = 'left';
      }
    }

    if (!showPerf && calibration) drawWatchMenu(ctx, calibration, !state, statsEnabled, thirdPerson);
    // The dots are the BOARD run's energy, not Superman fuel. Hide them off-board, where boost is unlimited,
    // even if an airborne grab is retaining the run clock and score for a catch.
    if (!showPerf && state && run?.phase === 'running') drawBoostMeter(ctx, run.boostMeter);
    if (!showPerf && run?.trick) drawTrick(ctx, run.trick);
    if (showPerf && stats) drawPerf(ctx, stats);

    ctx.fillStyle = '#8fa8c0';
    ctx.font = showPerf ? '500 22px system-ui, sans-serif' : '500 17px system-ui, sans-serif';
    ctx.fillText(showPerf ? hint : short(hint, 56), 26, height - 20);
    texture.needsUpdate = true;
  }

  /** The one line of guidance for the state the rider is in; the session sets it as that state changes. */
  function setHint(text: string) { hint = text; }

  function actionAt(uv: THREE.Vector2, controlsOpen = false): XrHudAction | null {
    return xrHudActionAt(showPerf, uv, controlsOpen);
  }

  /** Menu page changes should paint on the next frame instead of waiting behind the five-Hz data throttle. */
  function invalidate() { nextPaint = 0; }

  function dispose() {
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
    texture.dispose();
    object.removeFromParent();
  }

  return { object, draw, setHint, actionAt, invalidate, dispose };
}

export type XrHud = ReturnType<typeof createXrHud>;

/** The live event clock shares the status row with speed; a completed result takes that row over entirely. */
function drawRunHeader(ctx: CanvasRenderingContext2D, run: RideRunStatus) {
  ctx.textAlign = 'right';
  ctx.fillStyle = run.phase === 'finished' ? '#74e6a3' : run.phase === 'time-up' ? '#ffd24a' : '#8fd7ff';
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.fillText(run.phase === 'running' ? run.mode.toUpperCase() : 'RESULT', W - 26, 42);
  if (run.phase === 'running') {
    ctx.fillStyle = '#eaf4ff';
    ctx.font = '700 30px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(formatRunClock(run.clockSeconds), W - 26, 78);
  }
  ctx.textAlign = 'left';
}

/**
 * The profiler block. Ordered by the question you ask first when a headset drops frames: *are we over budget*,
 * then *is it CPU or GPU*, then *which CPU phase*, and only then the workload that explains it. CPU is the
 * measured JS phases; GPU is an asynchronous elapsed query; `pace~` is the remainder after the slower of those
 * overlapping paths and therefore an estimate of compositor/vsync/runtime pacing rather than a measured phase.
 * If the browser withholds GPU queries, `pace≤` is the conservative frame-minus-CPU upper bound instead.
 */
function drawPerf(ctx: CanvasRenderingContext2D, s: XrHudPerf) {
  const p = s.perf;
  const cpu = measuredRideCpuMs(p);
  const pacing = estimatedRidePacingMs(p);
  const outsideCpu = unmeasuredRideFrameMs(p);
  // An unknown budget colours neutral rather than green: "we never reached vsync" must not read as "in budget".
  const over = s.budgetMs > 0 ? p.frameMs / s.budgetMs : NaN;

  ctx.strokeStyle = 'rgba(120,190,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(26, 140);
  ctx.lineTo(W - 26, 140);
  ctx.stroke();

  // The headline: this frame against the one the display is actually going to show, coloured so a glance is
  // enough. `worst` is the last second's slowest frame — the hitch an average quietly buries.
  ctx.font = '700 30px system-ui, sans-serif';
  ctx.fillStyle = Number.isNaN(over) ? '#9fb6cc'
    : over > WAY_OVER ? '#ff6b6b' : over > OVER_BUDGET ? '#ffc14a' : '#63e08a';
  ctx.fillText(`${ms(p.frameMs)} ms`, 26, 176);
  ctx.font = '500 22px system-ui, sans-serif';
  ctx.fillStyle = '#8fa8c0';
  ctx.fillText(`of ${s.budgetMs > 0 ? ms(s.budgetMs) : '?'} · best ${ms(s.bestMs)}`
    + ` · worst ${ms(s.worstMs)} · ${Math.round(p.fps)} fps`, 150, 176);

  // CPU and GPU overlap, so the third value is frame - max(CPU, GPU), never frame - CPU - GPU.
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillStyle = '#8fd7ff';
  ctx.fillText(`CPU ${ms(cpu)}`, 26, 210);
  ctx.fillStyle = '#ffc14a';
  ctx.fillText(`GPU ${gpuTime(p.gpuMs, p.gpuTimerState)}`, 165, 210);
  ctx.fillStyle = '#c6a7ff';
  ctx.fillText(pacing === null ? `pace≤ ${ms(outsideCpu)}` : `pace~ ${ms(pacing)}`, 350, 210);

  // From here down, hierarchy is visual rather than implicit. Only CPU PHASES add to the headline CPU value;
  // DETAIL rows are nested inside those phases, and RENDER WORK is a count rather than another time value.
  let y = 236;
  const section = (title: string) => {
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillStyle = '#66839e';
    ctx.fillText(title, 26, y);
    ctx.strokeStyle = 'rgba(120,190,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(26, y + 5); ctx.lineTo(W - 26, y + 5); ctx.stroke();
    y += 20;
  };
  const row = (value: string, colour = '#9fb6cc') => {
    ctx.font = '500 18px system-ui, sans-serif';
    ctx.fillStyle = colour;
    ctx.fillText(value, 26, y);
    y += 20;
  };

  const xrMs = p.xrBeginMs + p.xrEndMs;
  const phases = [
    ['XR', xrMs], ['world', p.worldMs], ['ride', p.rideMs], ['play FX', p.effectsMs],
    ['scene', p.sceneMs], ['render', p.renderMs], ['post-frame', p.postFrameMs],
  ] as const;
  const largest = phases.reduce((best, phase) => phase[1] > best[1] ? phase : best);
  const timingCell = (label: string, value: number, x: number) => {
    const hot = label === largest[0] && value > 0;
    ctx.font = `${hot ? 650 : 500} 18px system-ui, sans-serif`;
    ctx.fillStyle = hot ? '#ffc14a' : '#9fb6cc';
    ctx.textAlign = 'left'; ctx.fillText(label, x, y);
    ctx.textAlign = 'right'; ctx.fillText(ms(value), x + 210, y);
    ctx.textAlign = 'left';
  };

  section(`CPU PHASES · THESE ADD TO ${ms(cpu)}`);
  for (let i = 0; i < phases.length; i += 2) {
    timingCell(phases[i][0], phases[i][1], 26);
    if (i + 1 < phases.length) timingCell(phases[i + 1][0], phases[i + 1][1], 272);
    y += 20;
  }

  section('DETAIL · ALREADY INSIDE THE PHASES ABOVE');
  row(`ride → physics ${ms(p.physicsMs)}  · cast ${ms(p.castMs)}  · AI ${ms(p.aiMs)}`);
  row(`ride → pose ${ms(p.poseMs)}  · camera ${ms(p.cameraMs)}  · telemetry ${ms(p.telemetryMs)}  · HUD ${ms(p.hudMs)}`);
  row(`walk → ${ms(p.walkCollisionMs)}  · ${count(p.walkGroundCasts)} ground  · ${count(p.walkSweeps)} sweep`
    + `  · ${count(p.walkTriangleTests)} tri  · ${count(p.walkLiveRefits)} refit`);
  row(`render → prep ${ms(p.renderPrepMs)}  · Three.js submit ${ms(p.renderSubmitMs)}`);

  const views = Math.max(1, s.views);
  section(`RENDER WORK · COUNTS INCLUDE ${views === 2 ? 'BOTH EYES' : `${views} VIEW${views === 1 ? '' : 'S'}`}`);
  const submitUsPerCall = p.drawCalls > 0 ? p.renderSubmitMs * 1000 / p.drawCalls : 0;
  row(`draw ${count(p.drawCalls)} total  · ${count(p.drawCalls / views)}/view ×${views}`
    + `  · ${count(submitUsPerCall)} µs/call`,
    p.drawCalls / views >= 100 ? '#ffc14a' : '#9fb6cc');
  row(`props/view  ref ${count(p.propBatchDraws)} batch + ${count(p.propIsolatedDraws)} isolated`
    + `  · authored ${count(p.authoredPropDraws)}`);
  row(`batch path  ${p.multiDraw ? 'native multi-draw' : 'merged fallback'}`);
  row(`list/view  ${count(p.renderOpaqueItems)} opaque  · ${count(p.renderTransparentItems)} transparent`
    + `  · ${count(p.renderTransmissiveItems)} transmissive`);
  row(`trans src  ref ${count(p.renderTransparentRefBatches)}b+${count(p.renderTransparentRefIsolated)}i`
    + `  · auth ${count(p.renderTransparentAuthoredProps)}  · other ${count(p.renderTransparentOther)}`
    + (p.renderTransparentOtherSources ? ` [${short(p.renderTransparentOtherSources, 25)}]` : ''));
  row(`${millions(p.renderTriangles)} tris total  · ${millions(p.renderTriangles / views)}/view`
    + `  · ${count(p.programs)} programs`);

  section('XR OUTPUT');
  // Never silent: `n/a` is the answer when the runtime does not expose a capability.
  row(`eye ${s.eyeWidth}×${s.eyeHeight} ×${s.views} = ${megapixels(s)} Mpix/frame`);
  row(`layer ${s.layerRequested}${s.layerRequested === 'webgl' ? (s.layerOverrideApplied ? ' forced' : ' FORCE FAILED') : ''}`
    + ` → ${s.layerKind}  · depth ${s.depthIgnored === null ? '?' : s.depthIgnored ? 'ignored' : 'used'}`);
  row(`AA context ${onOff(s.contextAntialias)}  · layer ${onOff(s.layerAntialias)}`
    + `  · samples ${s.samples ?? '?'}  · ${s.powerPreference}`);
  row(`scale ${s.renderScale.toFixed(2)}  · foveation ${s.foveation === null ? 'n/a' : s.foveation.toFixed(2)}`
    + `  · near ${s.nearClip.toFixed(2)} m`);
  row(`GPU timer ${gpuTimerStatus(p.gpuTimerState)}`);
  row(`adapter ${short(s.gpu, 42)}`);
  row(`tracking hands ${s.handTracking}  · lower body IK`
    + `${s.standingHeight === null ? '  · body uncalibrated' : `  · body ${s.standingHeight.toFixed(2)} m`}`);
  row(`view Y ${s.rawHeadY.toFixed(2)}→${s.correctedHeadY.toFixed(2)} m  · floor ${signed(s.floorOffset)}`);
}

function drawWatchMenu(ctx: CanvasRenderingContext2D, calibration: XrHudCalibration, onFoot: boolean,
                       statsEnabled: boolean, thirdPerson: boolean) {
  for (const button of WATCH_BUTTONS) {
    const enabled = button.action === 'restart' || button.action === 'stats' || button.action === 'view'
      || button.action === 'controls' || button.action === 'exit' || onFoot;
    const calibrating = button.action === 'calibrate' && calibration.phase === 'countdown';
    const saved = button.action === 'calibrate' && calibration.phase === 'saved';
    const error = button.action === 'calibrate' && calibration.phase === 'error';
    const active = (button.action === 'stats' && statsEnabled) || (button.action === 'view' && thirdPerson);
    const danger = button.action === 'exit';
    ctx.fillStyle = !enabled ? 'rgba(110,125,140,0.12)'
      : error || danger ? 'rgba(238,91,91,0.25)'
        : saved || active ? 'rgba(66,185,114,0.30)'
          : calibrating ? 'rgba(255,193,74,0.30)' : 'rgba(73,154,222,0.24)';
    roundRect(ctx, button.x, button.y, button.w, button.h, 12);
    ctx.fill();
    ctx.strokeStyle = !enabled ? 'rgba(150,165,180,0.22)'
      : error || danger ? '#ff8d8d' : saved || active ? '#74e6a3' : '#8fd7ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    let title = button.action === 'calibrate' ? 'T-POSE'
      : button.action === 'restart' ? 'RESTART'
          : button.action === 'stats' ? `VR STATS ${statsEnabled ? 'ON' : 'OFF'}`
            : button.action === 'view' ? `3RD PERSON ${thirdPerson ? 'ON' : 'OFF'}`
              : button.action === 'controls' ? 'CONTROLS' : 'EXIT VR';
    if (button.action === 'calibrate') {
      if (calibrating) title = String(calibration.count ?? 3);
      else if (saved && calibration.standingHeight) title = `${calibration.standingHeight.toFixed(2)} M`;
      else if (error) title = 'RETRY';
    }
    ctx.fillStyle = enabled ? '#eaf4ff' : '#657382';
    ctx.textAlign = 'center';
    ctx.font = calibrating ? '800 32px system-ui, sans-serif' : '700 20px system-ui, sans-serif';
    ctx.fillText(title, button.x + button.w / 2, button.y + 33);
  }
  ctx.textAlign = 'left';
}

function drawControlsPage(ctx: CanvasRenderingContext2D, mode: XrControlsMode, carrying: boolean) {
  ctx.fillStyle = '#eaf4ff';
  ctx.font = '800 26px system-ui, sans-serif';
  ctx.fillText('CONTROLS', 26, 76);
  ctx.fillStyle = '#8fd7ff';
  ctx.font = '700 17px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(mode === 'ride' ? 'RIDING' : carrying ? 'ON FOOT · HOLDING BOARD' : 'ON FOOT', W - 26, 76);
  ctx.textAlign = 'left';

  const labels = xrControllerDiagramLabels(mode);
  drawControllerCard(ctx, 18, 88, 'LEFT', 'left', labels.left);
  drawControllerCard(ctx, 262, 88, 'RIGHT', 'right', labels.right);

  ctx.fillStyle = '#66839e';
  ctx.font = '800 14px system-ui, sans-serif';
  ctx.fillText('FLIGHT & BOARD', 26, 300);
  ctx.textAlign = 'right';
  ctx.fillText(mode === 'ride' ? 'X RESPAWN · MENU RESTART' : 'X SPAWN BOARD · MENU RESTART', W - 26, 300);
  ctx.textAlign = 'left';
  ctx.font = '600 14px system-ui, sans-serif';
  XR_BOARD_CONTROL_NOTES.forEach((note, index) => {
    ctx.fillStyle = index < 3 ? '#dcecff' : '#9fb6cc';
    ctx.fillText(`• ${note}`, 26, 326 + index * 21);
  });

  const back = CONTROLS_BACK_BUTTON;
  ctx.fillStyle = 'rgba(73,154,222,0.24)';
  roundRect(ctx, back.x, back.y, back.w, back.h, 12);
  ctx.fill();
  ctx.strokeStyle = '#8fd7ff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#eaf4ff';
  ctx.textAlign = 'center';
  ctx.font = '700 19px system-ui, sans-serif';
  ctx.fillText('BACK', back.x + back.w / 2, back.y + 29);
  ctx.textAlign = 'left';
}

function drawControllerCard(ctx: CanvasRenderingContext2D, x: number, y: number, title: string,
                            handedness: 'left' | 'right', rows: readonly XrControllerDiagramRow[]) {
  ctx.fillStyle = 'rgba(19,31,43,0.82)';
  roundRect(ctx, x, y, 232, 190, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,190,255,0.28)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#8fd7ff';
  ctx.font = '800 16px system-ui, sans-serif';
  ctx.fillText(title, x + 12, y + 23);
  drawMiniController(ctx, x + 48, y + 105, handedness, rows);

  rows.forEach((row, index) => {
    const rowY = y + 34 + index * 29;
    ctx.fillStyle = controlColour(row.control);
    ctx.font = '800 10px system-ui, sans-serif';
    ctx.fillText(row.control, x + 91, rowY + 9);
    ctx.fillStyle = '#eaf4ff';
    let fontSize = 14;
    do {
      ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
      if (ctx.measureText(row.action).width <= 130) break;
      fontSize--;
    } while (fontSize > 10);
    ctx.fillText(row.action, x + 91, rowY + 24);
  });
}

/** Relative control centres for the wrist's top-down controller sketch. The right controller is a true
 * horizontal mirror: its stick moves right and its A/B pair moves left, angling toward the inside edge. */
export function xrMiniControllerLayout(handedness: 'left' | 'right') {
  const faceSide = handedness === 'left' ? 1 : -1;
  return {
    stick: { x: -15 * faceSide, y: -20 },
    faceLower: { x: 12 * faceSide, y: -14 },
    faceUpper: { x: 22 * faceSide, y: -29 },
  } as const;
}

/** Small orientation diagram: the coloured T/G/S and face-button marks correspond to the labelled rows beside
 * it, including the same inward-only grip paddle as the tracked 3D controller. */
function drawMiniController(ctx: CanvasRenderingContext2D, cx: number, cy: number,
                            handedness: 'left' | 'right', rows: readonly XrControllerDiagramRow[]) {
  ctx.fillStyle = '#252a31';
  roundRect(ctx, cx - 15, cy - 8, 30, 82, 15);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy - 17, 37, 25, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#4c5e70';
  ctx.lineWidth = 2;
  ctx.stroke();

  const has = (control: XrControllerDiagramRow['control']) => rows.some(row => row.control === control);
  const layout = xrMiniControllerLayout(handedness);
  if (has('STICK')) miniControl(
    ctx, cx + layout.stick.x, cy + layout.stick.y, 'S', controlColour('STICK'), 8,
  );
  if (handedness === 'left') {
    if (has('X')) miniControl(
      ctx, cx + layout.faceLower.x, cy + layout.faceLower.y, 'X', controlColour('X'), 7,
    );
    if (has('Y')) miniControl(
      ctx, cx + layout.faceUpper.x, cy + layout.faceUpper.y, 'Y', controlColour('Y'), 7,
    );
  } else {
    if (has('A')) miniControl(
      ctx, cx + layout.faceLower.x, cy + layout.faceLower.y, 'A', controlColour('A'), 7,
    );
    if (has('B')) miniControl(
      ctx, cx + layout.faceUpper.x, cy + layout.faceUpper.y, 'B', controlColour('B'), 7,
    );
  }
  if (has('TRIGGER')) miniControl(ctx, cx, cy - 45, 'T', controlColour('TRIGGER'), 7);
  const gripX = cx + (handedness === 'left' ? 16 : -16);
  if (has('GRIP')) miniControl(ctx, gripX, cy + 23, 'G', controlColour('GRIP'), 7);
}

function miniControl(ctx: CanvasRenderingContext2D, x: number, y: number, text: string,
                     colour: string, radius: number) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#071018';
  ctx.font = `900 ${Math.max(9, radius + 3)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function controlColour(control: XrControllerDiagramRow['control']): string {
  if (control === 'TRIGGER') return '#7ee8ff';
  if (control === 'GRIP') return '#ff9dcc';
  if (control === 'STICK') return '#ffd56a';
  return '#9fb7ff';
}

/** Unity's fifteen whole boost dots, fitted along the wrist panel's bottom edge beneath the action rows. */
function drawBoostMeter(ctx: CanvasRenderingContext2D, meter: number) {
  const lit = boostMeterSegments(meter);
  const colours = ['#ffe05a', '#ffc44d', '#ffa447', '#ff7d4c', '#ff555f'];
  const x = 91, y = 368, gap = 3;
  const width = W - x - 18;
  const cell = (width - gap * (RIDE_BOOST_METER_SEGMENTS - 1)) / RIDE_BOOST_METER_SEGMENTS;
  ctx.fillStyle = '#ffd56a';
  ctx.font = '800 16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('BOOST', 26, y + 12);
  for (let i = 0; i < RIDE_BOOST_METER_SEGMENTS; i++) {
    ctx.fillStyle = i < lit ? colours[Math.min(4, Math.floor(i / 3))] : 'rgba(117,126,137,.32)';
    roundRect(ctx, x + i * (cell + gap), y, cell, 12, 6);
    ctx.fill();
  }
}

/** The Unity live/result line: +points paired with its rotation equation, grind/grab timer, or bail reason. */
function drawTrick(ctx: CanvasRenderingContext2D, trick: NonNullable<RideRunStatus['trick']>) {
  const y = 414;
  ctx.textAlign = 'left';
  ctx.fillStyle = trick.state === 'landed' ? '#8fe39a' : trick.state === 'bailed' ? '#ff5a4d' : '#ffffff';
  ctx.font = '800 24px system-ui, sans-serif';
  ctx.fillText(`+${Math.max(0, Math.round(trick.points)).toLocaleString()}`, 26, y);
  if (trick.detail) {
    ctx.textAlign = 'right';
    ctx.fillStyle = trick.state === 'bailed' ? '#ff8a7a'
      : trick.kind === 'grind' ? '#c6a3ff' : trick.kind === 'grab' ? '#ffb3d1' : '#9fd4ff';
    ctx.font = '650 16px system-ui, sans-serif';
    ctx.fillText(trick.detail, W - 26, y - 2);
    ctx.textAlign = 'left';
  }
}

const ms = (value: number) => (value < 10 ? value.toFixed(1) : Math.round(value).toString());
const count = (value: number) => Math.round(value).toLocaleString();
const millions = (value: number) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : count(value));
const megapixels = (s: XrHudPerf) => ((s.eyeWidth * s.eyeHeight * s.views) / 1e6).toFixed(1);
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} m`;
const onOff = (value: boolean | null) => value === null ? '?' : value ? 'on' : 'off';
const gpuTime = (value: number | null, state: GpuTimerState) => state === 'unsupported' ? 'unavail'
  : state === 'disjoint' ? 'reset' : value === null ? 'wait' : ms(value);
const gpuTimerStatus = (state: GpuTimerState) => state === 'unsupported'
  ? 'unavailable · EXT timer not exposed by browser/runtime'
  : state === 'pending' ? 'waiting for asynchronous query'
    : state === 'disjoint' ? 'reset · invalid/disjoint result' : 'active · asynchronous elapsed query';
const short = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/** Width of `text` at `font`, without disturbing the caller's current font. */
function measure(ctx: CanvasRenderingContext2D, text: string, font: string): number {
  const previous = ctx.font;
  ctx.font = font;
  const width = ctx.measureText(text).width;
  ctx.font = previous;
  return width;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
