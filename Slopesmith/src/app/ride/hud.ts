import { D2R, clamp, type RideState } from './physics';
import { estimatedRidePacingMs, measuredRideCpuMs, unmeasuredRideFrameMs, type RidePerf } from './perf';
import { touchRidePosture, type RideHoldSource, type RideKeys, type WalkHoldField } from './input';
import type { PadMirror } from './gamepad';
import type { RideEffectState } from './effect-actions';
import { boostMeterSegments, RIDE_BOOST_METER_SEGMENTS } from './score';
import { formatRunClock } from '../../core/doc/race';
import type { RideRunStatus } from './run-status';
import { toast } from '../ui/components/toast';
import { lastRidePointerWasTouch, primaryPointerIsCoarse } from './input-modality';

/** The touch buttons the pad's diagnostic mirror can light. */
type PadBtnKey = 'ollie' | 'boost' | 'board' | 'respawn';

// ---- tuning ----

// Touch steer stick (px at UI scale 1): knob travel to full deflection, the dead radius a resting thumb is
// allowed, and the stick's idle corner. The dead radius is NOT scaled — a thumb's precision is a physical fact,
// not a function of screen size.
const STICK_RADIUS = 60, STICK_DEAD = 3, STICK_HOME = 92;
/**
 * Slope of the stick's response curve at centre, blending to full authority at the rim: `y = g·x + (1−g)·x³`.
 *
 * A ring this small cannot be linear, a quarter as sensitive, AND still reach full lock — the three don't fit in
 * 47 px of thumb travel, so the curve is what gives. At g = 0.25 the fine end (where you live, holding a line) is
 * four times gentler, half travel is still 2.3× gentler, and the rim reaches 1.0 exactly, so a hard carve and the
 * speed it scrubs are both still there. Only the touch stick is shaped; a key is a digital ±1 and passes through.
 *
 * It also widens the one band the engine rewards: the held boost dies outside a lean of ±0.08 ([Trailmap: 360]),
 * which a linear stick puts inside the first 6.9 px of travel — unholdable. Shaped, it's the first 15.5 px.
 */
const STICK_CENTRE_GAIN = 0.25;
// The touch overlay scales off the display's SHORT edge, which is orientation-invariant — rotating the phone must
// not resize the thumb pads under a rider's hands. `/500` puts a tablet and a desktop at 1 and a 393 px handset at
// 0.79. The BIG face controls scale freely (OLLIE/JUMP and BOOST stay well past 44 px, the size a thumb wants); the small
// ones can't, because linear scaling walks them off the bottom of usable — hence the per-control floors below.
const UI_REF_EDGE = 500, UI_SCALE_MIN = 0.72;
const TAP_MIN_CHIP_W = 40, TAP_MIN_CHIP_H = 32, TAP_MIN_FONT = 10;
/** Desktop browsers do not expose their compositor refresh budget. Use a clearly-labelled 60 fps reference for
 * the glanceable frame colour/bar instead of pretending the panel knows the monitor's actual refresh rate. */
const DESKTOP_FRAME_REFERENCE_MS = 1000 / 60;
const PERF_OVER_REFERENCE = 1.05, PERF_WAY_OVER_REFERENCE = 1.5;
/** Match the VR profiler's readable five-Hz cadence and avoid making DOM churn part of every measured frame. */
const PERF_REPAINT_MS = 200;
/** Touch drags need less physical travel than a desktop mouse sweep; keep the camera's own pitch/yaw tuning and
 * scale only the mobile gesture that feeds it. */
const TOUCH_LOOK_GAIN = 1.35;
// How long a touch keeps the overlay on screen while a pad is connected. Pad presence only hides the controls once
// the screen has gone untouched this long, so a connected controller can't yank them out from under a thumb.
const TOUCH_LINGER_MS = 3000;

/** Which device rode last, page-wide — so restarting a test run doesn't flash the thumb pads at a pad rider. */
let preferPad = false;

export interface RideHudOpts {
  container: HTMLElement;
  /** Short label for the HUD (which mountain is being ridden). */
  label: string;
  /** Source-aware aggregate owned by `input`; touch writes only its own contribution. */
  setHold(source: RideHoldSource, field: keyof RideKeys, down: boolean): void;
  setWalkHold(source: RideHoldSource, field: WalkHoldField, down: boolean): void;
  setOllie(source: RideHoldSource, down: boolean): void;
  releaseSource(source: RideHoldSource): void;
  /** Apply a mobile viewport drag to the active first/third-person camera. */
  look(deltaX: number, deltaY: number): void;
  /** Scale the third-person camera boom; pinch-apart supplies a factor below one (zoom in). */
  zoom(factor: number): void;
  toggleView(): void;
  toggleBoard(): void;
  respawn(): void;
  exit(): void;
  /** False for a headset-panel flat ride: a controller ray is not a direct-touch surface. */
  touchControls?: boolean;
  /** Ordinary coarse-pointer rides retain a DOM Stop button outside the hideable touch diagram. */
  persistentExit?: boolean;
}

/** The ride's on-screen layer: the speed/grade/sink read-out, the FPS + perf chip, and the touch overlay
 *  (steer stick, controller-shaped action cluster, camera / exit chips). `stick` is the live steer axis the model reads. */
export function createRideHud(o: RideHudOpts) {
  let hud!: HTMLDivElement;
  let fpsEl!: HTMLDivElement;
  let fpsValueEl!: HTMLDivElement;
  let perfDetailsEl!: HTMLDetailsElement;
  let perfHeadEl!: HTMLDivElement;
  let perfBudgetFillEl!: HTMLSpanElement;
  let perfIsolationEl!: HTMLDivElement;
  let perfFieldEls!: Map<string, HTMLElement>;
  let perfPhaseEls!: Map<string, HTMLElement>;
  let nextPerfPaintAt = 0;
  let countdownEl!: HTMLDivElement;
  let messageEl!: HTMLDivElement;
  let reticleEl!: HTMLDivElement;
  let messageAnimation: Animation | null = null;
  let clockEl!: HTMLDivElement;
  let timeBonusEl!: HTMLSpanElement;
  let timeBonusAnimation: Animation | null = null;
  let telemetryEl!: HTMLDivElement;

  // Touch controls are built once but revealed only by a real touch launch/input. Pointer accuracy alone is not
  // evidence of a touchscreen: a Quest controller ray can be the browser's coarse primary pointer.
  let touchUi: HTMLDivElement | null = null;
  let persistentExitEl: HTMLButtonElement | null = null;
  let viewBtnEl!: HTMLElement;
  let boardBtnEl!: HTMLElement;
  let boostBtnEl!: HTMLElement;
  let walking = false;
  let firstPersonView = false;
  /** 'touch' shows the labelled controller diagram; 'pad' leaves a clean viewport. Touch always wins the
   *  diagram back instantly; the pad hides it only after TOUCH_LINGER_MS without a touch. */
  let inputMode: 'touch' | 'pad' = 'touch';
  /** Pause temporarily reveals the diagram without changing which input mode should own it after resume. */
  let pauseControlsVisible = false;
  let lastTouchAt = -1e9;
  let ollieFill: HTMLElement | null = null;
  let stickZone!: HTMLDivElement;
  let stickBase!: HTMLDivElement;
  let stickKnob!: HTMLDivElement;
  let lookSurface!: HTMLDivElement;
  let aBtnEl!: HTMLDivElement;
  let padBtnEls!: Record<PadBtnKey, HTMLElement>;
  /** Left stick: X steers and Y holds tuck/brake on-board; X/Y become strafe/forward on foot. */
  const stick = { id: -1, active: false, x: 0, airX: 0, y: 0, cx: 0, cy: 0 };
  /** Physical right-stick look axis. Touch look is direct viewport dragging, so it needs no second virtual stick. */
  const lookStick = { active: false, x: 0, y: 0 };
  let lookPointerId = -1, lookLastX = 0, lookLastY = 0, lookPinchDistance = 0;
  const lookPointers = new Map<number, { x: number; y: number }>();
  let ui = 1;                     // touch-overlay scale, from the display's short edge
  let stickR = STICK_RADIUS;      // scaled; the knob-travel radius the steer axis is measured against
  let stickHome = STICK_HOME;     // scaled; the ring's idle corner inset
  const touchControlsAllowed = o.touchControls !== false;

  const onResize = () => {
    if (!stick.active) restStick();
  };
  /** Every touch, capture-phase, for the HUD's whole life: stamps touch recency, wins the screen back from pad
   *  mode, and doubles as the hybrid machine's first-touch reveal. */
  const onTouchInput = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !touchControlsAllowed) return;
    lastTouchAt = performance.now();
    showPersistentExit();
    if (inputMode === 'pad') setInputMode('touch');
    else showTouchUi();
  };

  // ---- HUD ----

  function buildHud() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute', 'left:0', 'right:0', 'bottom:var(--ride-hud-bottom, 16px)', 'pointer-events:none',
      'display:flex', 'flex-direction:column', 'align-items:center', 'gap:6px',
      'font:600 13px/1.2 system-ui,sans-serif', 'color:#eaf2ff', 'text-shadow:0 1px 3px rgba(0,0,0,.7)', 'z-index:20',
    ].join(';');
    el.innerHTML =
      '<div data-ride-stats style="display:flex;align-items:baseline;gap:8px">' +
        '<span data-mph style="font-size:38px;font-weight:800;letter-spacing:-1px">0</span>' +
        '<span style="opacity:.7">mph</span>' +
        '<span data-lap style="margin-left:18px;opacity:.95;display:none"></span>' +
        '<span data-grade style="margin-left:18px;opacity:.85">grade 0°</span>' +
        '<span data-depth style="margin-left:10px;opacity:.85"></span>' +
        '<span data-surf style="margin-left:10px;opacity:.85"></span>' +
        '<span data-charge style="margin-left:10px;align-self:center;width:64px;height:9px;border-radius:5px;' +
          'background:rgba(255,255,255,.22);overflow:hidden;display:none">' +
          '<span data-chargefill style="display:block;height:100%;width:0;background:#ffd34d"></span>' +
        '</span>' +
      '</div>' +
      '<div data-effects style="min-height:16px;color:#ffd56a;font-weight:700"></div>' +
      '<div data-boost-meter style="display:none;align-items:center;gap:8px;padding:4px 9px;border-radius:7px;' +
        'background:rgba(10,16,24,.68);border:1px solid rgba(255,190,70,.28);' +
        'font:800 9px/1 system-ui,sans-serif;letter-spacing:1.1px;color:#ffd56a">' +
        '<span>BOOST</span><span data-boost-dots style="display:grid;grid-template-columns:repeat(15,1fr);gap:3px;' +
          'width:min(330px,58vw);height:10px">' +
          Array.from({ length: RIDE_BOOST_METER_SEGMENTS }, (_, i) =>
            `<span data-boost-dot="${i}" style="border-radius:999px;background:rgba(117,126,137,.28);` +
            `box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)"></span>`).join('') +
        '</span>' +
      '</div>';
    if (getComputedStyle(o.container).position === 'static') o.container.style.position = 'relative';
    o.container.appendChild(el);
    hud = el;

    // Desktop first person hides the local body, so this restrained centre point preserves an exact aim
    // reference for looking and pointing. WebXR owns a different HUD and never enables this element.
    const reticle = document.createElement('div');
    reticle.dataset.rideReticle = '';
    reticle.style.cssText = [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'display:none', 'width:4px', 'height:4px', 'border-radius:50%', 'pointer-events:none',
      'z-index:24', 'background:rgba(255,255,255,.92)',
      'box-shadow:0 0 0 1px rgba(0,0,0,.78),0 0 4px rgba(0,0,0,.5)',
    ].join(';');
    o.container.appendChild(reticle);
    reticleEl = reticle;

    const countdown = document.createElement('div');
    countdown.style.cssText = [
      'position:absolute', 'left:50%', 'top:42%', 'transform:translate(-50%,-50%)',
      'display:none', 'pointer-events:none', 'z-index:22', 'font:900 96px/.9 system-ui,sans-serif',
      'letter-spacing:-4px', 'color:#f7fbff',
      'text-shadow:0 4px 0 rgba(0,0,0,.42),0 0 24px rgba(120,190,255,.8)',
    ].join(';');
    o.container.appendChild(countdown);
    countdownEl = countdown;

    // MainType-12 debug text: a short, high-contrast in-race banner matching the patched retail lifetime. It is
    // deliberately separate from countdownEl so a collision cell can identify itself during READY/GO or a lap cue.
    const message = document.createElement('div');
    message.style.cssText = [
      'position:absolute', 'left:50%', 'top:27%', 'transform:translate(-50%,-50%)',
      'display:none', 'max-width:min(760px,86%)', 'pointer-events:none', 'z-index:23',
      'padding:8px 18px', 'border-radius:8px', 'background:rgba(8,12,20,.72)',
      'font:900 clamp(24px,4vw,48px)/1.08 system-ui,sans-serif', 'letter-spacing:.5px',
      'text-align:center', 'white-space:pre-wrap', 'overflow-wrap:anywhere',
      'text-shadow:0 3px 0 rgba(0,0,0,.55),0 0 18px currentColor',
    ].join(';');
    o.container.appendChild(message);
    messageEl = message;

    // THE RUN CLOCK, top-centre where a race game puts it and where nothing else is competing for the eye. Keep
    // mode and time on one compact line; the mode decides which way it runs (core/doc/race), exactly as it decides
    // for the one field the engine keeps. Tabular figures stop a falling countdown jittering its own width.
    const clock = document.createElement('div');
    clock.style.cssText = [
      'position:absolute', 'left:50%', 'top:var(--ride-hud-top, calc(var(--bar-h, 46px) + 8px))',
      'transform:translateX(-50%)', 'display:none', 'align-items:baseline', 'gap:6px', 'white-space:nowrap',
      'pointer-events:none', 'z-index:20', 'padding:3px 8px', 'border-radius:6px',
      'background:rgba(12,18,28,.62)', 'color:#eaf2ff',
      'font:700 18px/1.1 ui-monospace,monospace', 'font-variant-numeric:tabular-nums',
      'text-shadow:0 1px 3px rgba(0,0,0,.7)',
    ].join(';');
    clock.innerHTML = '<span data-clocktime>0:00.00</span>'
      + '<span data-clockmode style="font:650 9px/1 system-ui,sans-serif;letter-spacing:1.2px;opacity:.7"></span>'
      + '<span data-clockscore style="margin-left:4px;color:#ffd56a;font:700 13px/1.1 system-ui,sans-serif"></span>'
      + '<span data-clockbelow style="position:absolute;left:50%;top:calc(100% + 4px);transform:translateX(-50%);'
      + 'display:flex;flex-direction:column;align-items:center;gap:4px">'
        + '<span data-timebonus style="display:none;padding:2px 7px;border-radius:5px;'
        + 'background:rgba(12,18,28,.72);color:#ffd34d;font:750 11px/1.2 system-ui,sans-serif;'
        + 'letter-spacing:.4px;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.8)"></span>'
        + '<span data-clocktrick style="display:none;min-width:190px;padding:5px 10px;border-radius:7px;'
        + 'background:rgba(10,16,24,.76);border:1px solid rgba(120,190,255,.22);text-align:center">'
          + '<span data-trickpoints style="display:block;font:800 18px/1.05 system-ui,sans-serif"></span>'
          + '<span data-trickdetail style="display:block;margin-top:3px;font:650 11px/1.1 system-ui,sans-serif;'
          + 'letter-spacing:.2px"></span>'
        + '</span>'
      + '</span>';
    o.container.appendChild(clock);
    clockEl = clock;
    timeBonusEl = clock.querySelector('[data-timebonus]') as HTMLSpanElement;

    // Top-left, tucked under the top bar: which mountain + a live FPS read-out, on a translucent chip that keeps
    // the run visible underneath. The expanded dashboard follows the in-headset profiler's question order: first
    // CPU/GPU, additive CPU phases, nested detail, and finally the render workload that explains those timings.
    // It remains DOM rather than a canvas texture: desktop text stays sharp, selectable, responsive, and cheap.
    const fps = document.createElement('div');
    fps.className = 'os-ride-perf';
    fps.style.cssText = [
      'position:absolute', 'left:10px', 'top:var(--ride-hud-top, calc(var(--bar-h, 46px) + 8px))', 'pointer-events:auto',
      'user-select:text', '-webkit-user-select:text', 'cursor:text',
      'box-sizing:border-box', 'max-width:calc(100vw - 20px)', 'padding:7px 10px', 'border-radius:9px',
      'background:rgba(9,15,25,.36)', 'border:1px solid rgba(143,215,255,.18)',
      'box-shadow:0 8px 28px rgba(0,0,0,.14)', 'backdrop-filter:blur(2px)',
      'font:600 12px/1.45 system-ui,sans-serif', 'color:#eaf2ff',
      // Stay above the full-viewport mobile look surface (z-index 21), otherwise it captures the tap meant for
      // the native details/summary disclosure before the performance panel can receive it.
      'text-shadow:0 1px 2px rgba(0,0,0,.82)', 'z-index:22',
    ].join(';');
    fps.innerHTML = `
      <style>
        .os-ride-perf * { box-sizing:border-box }
        .os-ride-perf .os-perf-course { color:#eaf4ff;font-size:12px;font-weight:700;letter-spacing:.01em }
        .os-ride-perf [data-fps] { color:#8fa8c0;font-size:11px;font-variant-numeric:tabular-nums }
        .os-ride-perf details { margin-top:2px }
        .os-ride-perf summary { display:flex;align-items:center;gap:6px;color:#8fa8c0;font-size:11px;
          font-weight:650;cursor:pointer;list-style:none;user-select:none;-webkit-user-select:none }
        .os-ride-perf summary::-webkit-details-marker { display:none }
        .os-ride-perf .os-perf-chevron { display:inline-block;color:#8fd7ff;font-size:15px;line-height:10px;
          transform:rotate(0deg);transition:transform 120ms ease }
        .os-ride-perf details[open] .os-perf-chevron { transform:rotate(90deg) }
        .os-ride-perf .os-perf-panel { width:min(640px,calc(100vw - 42px));max-height:calc(100vh - var(--bar-h,46px) - 92px);
          margin:8px -2px -1px;padding:15px;overflow:auto;overscroll-behavior:contain;border-radius:8px;
          border:1px solid rgba(143,215,255,.2);background:rgba(8,14,24,.3);box-shadow:0 14px 42px rgba(0,0,0,.18);
          color:#9fb6cc;font-variant-numeric:tabular-nums;scrollbar-color:#45647e transparent }
        .os-ride-perf .os-perf-head { display:flex;align-items:flex-end;justify-content:space-between;gap:18px }
        .os-ride-perf .os-perf-kicker,.os-ride-perf .os-perf-section-title { color:#66839e;font-size:9px;
          font-weight:800;letter-spacing:.13em;text-transform:uppercase }
        .os-ride-perf .os-perf-frame { display:block;margin-top:1px;color:#9fb6cc;font-size:27px;font-weight:750;
          line-height:1.05;letter-spacing:-.025em }
        .os-ride-perf .os-perf-head[data-state="good"] .os-perf-frame { color:#63e08a }
        .os-ride-perf .os-perf-head[data-state="warn"] .os-perf-frame { color:#ffc14a }
        .os-ride-perf .os-perf-head[data-state="bad"] .os-perf-frame { color:#ff6b6b }
        .os-ride-perf .os-perf-reference { color:#8fa8c0;font-size:10px;text-align:right }
        .os-ride-perf .os-perf-reference strong { display:block;color:#c8d7e5;font-size:13px;font-weight:700 }
        .os-ride-perf .os-perf-budget { height:4px;margin-top:10px;overflow:hidden;border-radius:99px;
          background:rgba(143,215,255,.1) }
        .os-ride-perf .os-perf-budget span { display:block;width:0;height:100%;border-radius:inherit;background:#8fa8c0;
          transition:width 140ms linear,background 140ms linear }
        .os-ride-perf .os-perf-budget span[data-state="good"] { background:#63e08a }
        .os-ride-perf .os-perf-budget span[data-state="warn"] { background:#ffc14a }
        .os-ride-perf .os-perf-budget span[data-state="bad"] { background:#ff6b6b }
        .os-ride-perf .os-perf-metrics { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:11px }
        .os-ride-perf .os-perf-metric { min-width:0;padding:8px 9px;border:1px solid rgba(143,215,255,.1);
          border-radius:6px;background:rgba(143,215,255,.045) }
        .os-ride-perf .os-perf-metric span { display:block;color:#66839e;font-size:9px;font-weight:800;letter-spacing:.1em }
        .os-ride-perf .os-perf-metric strong { display:block;margin-top:2px;overflow:hidden;color:#d8e5f0;font-size:13px;
          font-weight:700;text-overflow:ellipsis;white-space:nowrap }
        .os-ride-perf .os-perf-metric.cpu strong { color:#8fd7ff }
        .os-ride-perf .os-perf-metric.gpu strong { color:#ffc14a }
        .os-ride-perf .os-perf-metric.pace strong { color:#c6a7ff }
        .os-ride-perf .os-perf-section { margin-top:14px }
        .os-ride-perf .os-perf-section-title { display:flex;align-items:center;gap:8px;margin-bottom:7px }
        .os-ride-perf .os-perf-section-title::after { content:"";height:1px;flex:1;background:rgba(120,190,255,.12) }
        .os-ride-perf .os-perf-phase-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px 22px }
        .os-ride-perf .os-perf-row { display:flex;align-items:baseline;justify-content:space-between;gap:12px;
          min-width:0;padding:3px 0;color:#9fb6cc;font:500 11px/1.35 system-ui,sans-serif }
        .os-ride-perf .os-perf-row span:first-child { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
        .os-ride-perf .os-perf-row strong { flex:none;color:#c8d7e5;font-weight:650;white-space:nowrap }
        .os-ride-perf .os-perf-wide strong { max-width:72%;overflow-wrap:anywhere;text-align:right;white-space:normal }
        .os-ride-perf .os-perf-row[data-hot] span,.os-ride-perf .os-perf-row[data-hot] strong { color:#ffc14a;font-weight:700 }
        .os-ride-perf .os-perf-detail-grid { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px 16px }
        .os-ride-perf .os-perf-wide { grid-column:1/-1 }
        .os-ride-perf .os-perf-note { margin-top:8px;color:#66839e;font-size:9px;font-weight:550;line-height:1.4 }
        .os-ride-perf [data-telemetry] { margin-top:12px;padding-top:9px;border-top:1px solid rgba(120,190,255,.12);
          color:#8eb8da;font-size:10px;font-weight:650 }
        @media (max-width:680px) {
          .os-ride-perf .os-perf-panel { padding:12px }
          .os-ride-perf .os-perf-metrics { grid-template-columns:repeat(2,minmax(0,1fr)) }
          .os-ride-perf .os-perf-detail-grid { grid-template-columns:repeat(2,minmax(0,1fr)) }
        }
      </style>
      <div class="os-perf-course">${o.label}</div>
      <div data-fps>— fps</div>
      <details data-perf-details>
        <summary><span class="os-perf-chevron">›</span><span>Performance details</span></summary>
        <div data-perf class="os-perf-panel">
          <div data-perf-head class="os-perf-head" data-state="neutral">
            <div><span class="os-perf-kicker">Frame time</span><strong data-perf-field="frame" class="os-perf-frame">— ms</strong></div>
            <div class="os-perf-reference"><span>60 FPS REFERENCE</span><strong><span data-perf-field="fps">—</span> fps · 16.7 ms</strong></div>
          </div>
          <div class="os-perf-budget" title="Smoothed frame time against a labelled 60 fps reference"><span data-perf-budget data-state="neutral"></span></div>
          <div class="os-perf-metrics">
            <div class="os-perf-metric cpu"><span>CPU</span><strong data-perf-field="cpu">— ms</strong></div>
            <div class="os-perf-metric gpu"><span>GPU</span><strong data-perf-field="gpu">—</strong></div>
            <div class="os-perf-metric pace"><span>PACING</span><strong data-perf-field="pacing">—</strong></div>
            <div class="os-perf-metric"><span>NON-CPU</span><strong data-perf-field="outside">— ms</strong></div>
          </div>

          <section class="os-perf-section">
            <div class="os-perf-section-title">CPU phases · add to <span data-perf-field="cpu-total">— ms</span></div>
            <div class="os-perf-phase-grid">
              <div class="os-perf-row" data-perf-phase="world"><span>World FX</span><strong data-perf-field="phase-world">—</strong></div>
              <div class="os-perf-row" data-perf-phase="ride"><span>Ride</span><strong data-perf-field="phase-ride">—</strong></div>
              <div class="os-perf-row" data-perf-phase="effects"><span>Play FX</span><strong data-perf-field="phase-effects">—</strong></div>
              <div class="os-perf-row" data-perf-phase="scene"><span>Scene</span><strong data-perf-field="phase-scene">—</strong></div>
              <div class="os-perf-row" data-perf-phase="render"><span>Render CPU</span><strong data-perf-field="phase-render">—</strong></div>
              <div class="os-perf-row" data-perf-phase="post"><span>Post-frame</span><strong data-perf-field="phase-post">—</strong></div>
              <div class="os-perf-row" data-perf-phase="xr"><span>XR begin + end</span><strong data-perf-field="phase-xr">—</strong></div>
            </div>
          </section>

          <section class="os-perf-section">
            <div class="os-perf-section-title">Detail · already inside phases above</div>
            <div class="os-perf-detail-grid">
              <div class="os-perf-row"><span>Physics</span><strong data-perf-field="physics">—</strong></div>
              <div class="os-perf-row"><span>Cast</span><strong data-perf-field="cast">—</strong></div>
              <div class="os-perf-row"><span>AI</span><strong data-perf-field="ai">—</strong></div>
              <div class="os-perf-row"><span>Pose</span><strong data-perf-field="pose">—</strong></div>
              <div class="os-perf-row"><span>Camera</span><strong data-perf-field="camera">—</strong></div>
              <div class="os-perf-row"><span>Telemetry</span><strong data-perf-field="telemetry">—</strong></div>
              <div class="os-perf-row"><span>HUD</span><strong data-perf-field="hud">—</strong></div>
              <div class="os-perf-row"><span>Walk collision</span><strong data-perf-field="walk">—</strong></div>
              <div class="os-perf-row"><span>Render prep</span><strong data-perf-field="render-prep">—</strong></div>
              <div class="os-perf-row"><span>Three.js submit</span><strong data-perf-field="render-submit">—</strong></div>
              <div class="os-perf-row os-perf-wide"><span>Walk queries</span><strong data-perf-field="walk-work">—</strong></div>
            </div>
          </section>

          <section class="os-perf-section">
            <div class="os-perf-section-title">Render work · exact counts</div>
            <div class="os-perf-detail-grid">
              <div class="os-perf-row"><span>Draw calls</span><strong data-perf-field="draws">—</strong></div>
              <div class="os-perf-row"><span>Triangles</span><strong data-perf-field="triangles">—</strong></div>
              <div class="os-perf-row"><span>Lines / points</span><strong data-perf-field="lines-points">—</strong></div>
              <div class="os-perf-row os-perf-wide"><span>Render list</span><strong data-perf-field="render-list">—</strong></div>
              <div class="os-perf-row os-perf-wide"><span>Transparent sources</span><strong data-perf-field="transparent">—</strong></div>
              <div class="os-perf-row os-perf-wide"><span>Reference props</span><strong data-perf-field="props">—</strong></div>
              <div data-perf-isolation class="os-perf-row os-perf-wide" style="display:none"><span>Prop isolation</span><strong data-perf-field="isolation">—</strong></div>
            </div>
          </section>

          <section class="os-perf-section">
            <div class="os-perf-section-title">Resources</div>
            <div class="os-perf-detail-grid">
              <div class="os-perf-row"><span>Geometry</span><strong data-perf-field="geometries">—</strong></div>
              <div class="os-perf-row"><span>Textures</span><strong data-perf-field="textures">—</strong></div>
              <div class="os-perf-row"><span>Programs</span><strong data-perf-field="programs">—</strong></div>
              <div class="os-perf-row"><span>Batch path</span><strong data-perf-field="batching">—</strong></div>
              <div class="os-perf-row"><span>Ride collision</span><strong data-perf-field="ride-tris">—</strong></div>
            </div>
          </section>
          <div class="os-perf-note">CPU and GPU overlap. Pacing ~ estimates frame time outside the slower path; pacing ≤ is the frame-minus-CPU upper bound while GPU timing is unavailable.</div>
          <div data-telemetry>TELEM pre-roll · M mark · F8 record</div>
        </div>
      </details>`;
    o.container.appendChild(fps);
    fpsEl = fps;
    fpsValueEl = fps.querySelector('[data-fps]') as HTMLDivElement;
    perfDetailsEl = fps.querySelector('[data-perf-details]') as HTMLDetailsElement;
    perfHeadEl = fps.querySelector('[data-perf-head]') as HTMLDivElement;
    perfBudgetFillEl = fps.querySelector('[data-perf-budget]') as HTMLSpanElement;
    perfIsolationEl = fps.querySelector('[data-perf-isolation]') as HTMLDivElement;
    perfFieldEls = new Map(Array.from(fps.querySelectorAll<HTMLElement>('[data-perf-field]'))
      .map(field => [field.dataset.perfField!, field]));
    perfPhaseEls = new Map(Array.from(fps.querySelectorAll<HTMLElement>('[data-perf-phase]'))
      .map(phase => [phase.dataset.perfPhase!, phase]));
    perfDetailsEl.title = 'CPU phases are measured on the JavaScript thread. GPU is an asynchronous hardware timer when supported. The desktop budget colour uses a labelled 60 fps reference because browsers do not expose the compositor refresh budget.';
    telemetryEl = fps.querySelector('[data-telemetry]') as HTMLDivElement;

    buildTouchControls();
  }

  // ---- touch controls ----

  /**
   * Mobile controls: a floating steer stick under the left thumb, plus a labelled controller diagram under the
   * right: face buttons in a diamond, fullscreen, a manual camera toggle, and an on-screen exit.
   *
   * The stick's ring **re-centres on every press**: it rests in the bottom-left corner as a target, and the moment
   * a thumb lands anywhere in the left zone the ring jumps under it. The thumb never has to find the stick, and
   * the whole left zone is live, so a blind grab mid-run steers from wherever it lands. X feeds `steerInput()`;
   * pushing Y forward holds tuck and pulling it back holds brake, with the same dead centre releasing both.
   * On foot both axes become view-relative walk.
   *
   * Built hidden and revealed by the touch that launched the ride, or the first later touch on a hybrid machine.
   * A coarse-pointer media query is deliberately insufficient because a headset controller ray is coarse too.
   */
  function buildTouchControls() {
    // Scale off the SHORT edge so a rotation never resizes the pads mid-run, and clamp so a small phone still gets
    // thumb-sized targets rather than a faithfully-scaled miniature of a desktop layout.
    ui = clamp(Math.min(window.innerWidth, window.innerHeight) / UI_REF_EDGE, UI_SCALE_MIN, 1);
    stickR = Math.round(STICK_RADIUS * ui);
    stickHome = Math.round(STICK_HOME * ui);
    const px = (n: number) => Math.round(n * ui);
    /** A scaled size that refuses to shrink past the point a thumb can land on it. */
    const tap = (n: number, min: number) => Math.max(min, Math.round(n * ui));

    const el = document.createElement('div');
    el.className = 'os-ride-touch'; // the <style> below is document-global; every rule is scoped under this
    el.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:21', 'display:none', 'pointer-events:none',
      'touch-action:none', 'user-select:none', '-webkit-user-select:none', '-webkit-tap-highlight-color:transparent',
    ].join(';');
    // Shared face for every button. `data-on` is stamped by holdBtn while a finger is down; !important because
    // these are inline styles.
    const face = 'pointer-events:auto;touch-action:none;display:flex;align-items:center;justify-content:center;' +
      `border:1px solid rgba(255,255,255,.28);background:rgba(12,18,28,.55);color:#eaf2ff;` +
      `font:700 ${tap(12, TAP_MIN_FONT)}px/1 system-ui,sans-serif;letter-spacing:.4px;box-shadow:0 2px 10px rgba(0,0,0,.35)`;
    const buttonCopy = (code: string, action: string) =>
      `<span class="os-pad-copy"><b class="os-pad-code">${code}</b><span data-action>${action}</span></span>`;
    const knob = Math.round(stickR * 0.82);
    el.innerHTML =
      // [data-on] is a finger; [data-pad] is the controller's diagnostic mirror lighting the same faces.
      '<style>.os-ride-touch [data-on],.os-ride-touch [data-pad]{background:rgba(120,190,255,.6)!important;' +
        'border-color:rgba(225,242,255,.9)!important}' +
        '.os-ride-touch .os-pad-copy{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:4px;' +
        'pointer-events:none}.os-ride-touch [data-pad-kind="face"] .os-pad-copy{flex-direction:column;gap:2px}' +
        `.os-ride-touch .os-pad-code{display:none;font-size:${tap(13, 11)}px}` +
        '.os-ride-touch[data-gamepad] .os-pad-code{display:inline}' +
        `.os-ride-touch [data-action]{font-size:${tap(9, 8)}px;opacity:.78}` +
        '</style>' +
      // Every unoccupied part of the viewport is a direct drag-to-look/orbit surface. It sits underneath the
      // actual controls so steering, walking and the action buttons can all be used at the same time.
      `<div data-look-surface style="position:absolute;inset:0;display:none;z-index:0;pointer-events:auto;touch-action:none"></div>` +
      // Left: the whole zone is the pad; the ring is only its picture. Y is posture on-board and walking on foot.
      `<div data-zone style="position:absolute;left:0;bottom:0;width:46%;height:74%;z-index:1;pointer-events:auto;touch-action:none">` +
        `<div data-base style="position:absolute;width:${stickR * 2}px;height:${stickR * 2}px;` +
          `margin:${-stickR}px 0 0 ${-stickR}px;border-radius:50%;opacity:.5;transition:opacity .12s;` +
          `border:2px solid rgba(255,255,255,.4);background:rgba(12,18,28,.3);box-shadow:0 2px 12px rgba(0,0,0,.35)">` +
          `<div data-knob style="position:absolute;left:50%;top:50%;width:${knob}px;height:${knob}px;` +
            `margin:${-knob / 2}px 0 0 ${-knob / 2}px;border-radius:50%;background:rgba(234,242,255,.82);` +
            `box-shadow:0 2px 8px rgba(0,0,0,.5)"></div>` +
        `</div>` +
      `</div>` +
      // Right: the standard-mapping face buttons form a north/west/east/south diamond. Stick Y owns brake/tuck;
      // physical L2/R2 zoom is named in help rather than duplicated as touch buttons, and telemetry clicks stay off-screen.
      `<div style="position:absolute;pointer-events:none;z-index:1;display:flex;flex-direction:column;align-items:flex-end;gap:${px(10)}px;` +
        `right:calc(${px(14)}px + env(safe-area-inset-right,0px));bottom:env(safe-area-inset-bottom,0px)">` +
        `<div data-face-actions style="position:relative;width:${px(204)}px;height:${px(180)}px">` +
          `<div data-y data-pad-kind="face" role="button" aria-label="Get off board" title="Y · Get off board" style="${face};` +
            `position:absolute;left:50%;top:0;transform:translateX(-50%);width:${tap(64, 50)}px;height:${tap(64, 50)}px;` +
            `border-radius:50%">${buttonCopy('Y', 'BOARD')}</div>` +
          `<div data-x data-pad-kind="face" role="button" aria-label="Boost" title="X · Boost" style="${face};` +
            `position:absolute;left:0;top:50%;transform:translateY(-50%);width:${tap(64, 50)}px;height:${tap(64, 50)}px;` +
            `border-radius:50%">${buttonCopy('X', 'BOOST')}</div>` +
          `<div data-b data-pad-kind="face" role="button" aria-label="Respawn" title="B · Respawn" style="${face};` +
            `position:absolute;right:0;top:50%;transform:translateY(-50%);width:${tap(64, 50)}px;height:${tap(64, 50)}px;` +
            `border-radius:50%">${buttonCopy('B', 'RESPAWN')}</div>` +
          `<div data-a data-pad-kind="face" role="button" aria-label="Ollie" title="A · Ollie" style="${face};` +
            `position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:${tap(88, 70)}px;height:${tap(88, 70)}px;` +
            `border-radius:50%;overflow:hidden">` +
            `<div data-olliefill style="position:absolute;left:0;bottom:0;width:100%;height:0;` +
              `background:rgba(255,211,77,.55);transition:height .04s linear"></div>` +
            buttonCopy('A', 'OLLIE') +
          `</div>` +
        `</div>` +
      `</div>` +
      // Top-right, out of the thumbs' arc: fullscreen and a manual camera-view toggle. Stop is a separate DOM
      // button above this complete hideable diagram, so switching to a pad can never remove the only way out.
      `<div style="position:absolute;display:flex;gap:${px(8)}px;pointer-events:none;z-index:2;` +
        `right:calc(86px + env(safe-area-inset-right,0px));top:var(--ride-hud-top, calc(var(--bar-h, 46px) + 8px))">` +
        `<div data-fs style="${face};width:${tap(44, TAP_MIN_CHIP_W)}px;height:${tap(36, TAP_MIN_CHIP_H)}px;` +
          `border-radius:9px;font-size:${tap(17, 15)}px">⛶</div>` +
        `<div data-view role="button" aria-label="Switch to first person" title="Switch to first person" style="${face};` +
          `width:${tap(52, TAP_MIN_CHIP_W)}px;height:${tap(36, TAP_MIN_CHIP_H)}px;border-radius:9px;` +
          `font-size:${tap(12, TAP_MIN_FONT)}px"><span data-action>1ST</span></div>` +
      `</div>`;

    o.container.appendChild(el);
    touchUi = el;
    stickZone = el.querySelector('[data-zone]') as HTMLDivElement;
    stickBase = el.querySelector('[data-base]') as HTMLDivElement;
    stickKnob = el.querySelector('[data-knob]') as HTMLDivElement;
    lookSurface = el.querySelector('[data-look-surface]') as HTMLDivElement;
    aBtnEl = el.querySelector('[data-a]') as HTMLDivElement;
    ollieFill = el.querySelector('[data-olliefill]');
    viewBtnEl = el.querySelector('[data-view]') as HTMLElement;
    boardBtnEl = el.querySelector('[data-y]') as HTMLElement;
    boostBtnEl = el.querySelector('[data-x]') as HTMLElement;

    el.addEventListener('contextmenu', e => e.preventDefault()); // a held OLLIE must not raise the long-press menu
    const q = (sel: string) => el.querySelector(sel) as HTMLElement;
    holdBtn(aBtnEl,
      () => walking ? o.setWalkHold('touch', 'jump', true) : o.setOllie('touch', true),
      () => { o.setOllie('touch', false); o.setWalkHold('touch', 'jump', false); });
    holdBtn(boostBtnEl,
      () => walking ? o.setWalkHold('touch', 'boost', true) : o.setHold('touch', 'boost', true),
      () => { o.setHold('touch', 'boost', false); o.setWalkHold('touch', 'boost', false); });
    tapBtn(viewBtnEl, () => o.toggleView());
    tapBtn(boardBtnEl, () => o.toggleBoard());
    tapBtn(q('[data-b]'), () => o.respawn());
    tapBtn(q('[data-fs]'), () => toggleFullscreen());
    if (isStandalone()) q('[data-fs]').style.display = 'none'; // already chrome-less from the home-screen icon
    padBtnEls = {
      ollie: aBtnEl, boost: boostBtnEl,
      board: boardBtnEl, respawn: q('[data-b]'),
    };
    bindStick();
    bindLookSurface();
    lookSurface.style.display = 'block';

    if (touchControlsAllowed && lastRidePointerWasTouch()) showTouchUi();
    window.addEventListener('pointerdown', onTouchInput, true);
    if (preferPad) setInputMode('pad'); // last run ended on the pad — don't flash thumb pads at a pad rider
  }

  /**
   * The coarse-pointer escape hatch is intentionally NOT a child of `touchUi`. A pad can hide that diagram and
   * Quest's flat browser can decline it completely; neither transition may hide Stop with it. A normal click is
   * used instead of touch capture/release geometry so mouse, controller ray, accessibility activation, and a
   * finger all take the same path.
   */
  function buildPersistentExit() {
    if (o.persistentExit === false) return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'os-ride-stop';
    el.setAttribute('aria-label', 'Stop ride');
    el.title = 'Stop ride';
    el.textContent = '■ Stop';
    el.style.cssText = [
      'position:absolute', 'right:calc(10px + env(safe-area-inset-right,0px))',
      'top:var(--ride-hud-top, calc(var(--bar-h, 46px) + 8px))', 'z-index:23', 'display:none',
      'min-width:68px', 'height:36px', 'padding:0 10px', 'border-radius:9px',
      'border:1px solid rgba(255,255,255,.34)', 'background:rgba(55,18,24,.82)', 'color:#fff3f4',
      'font:700 12px/1 system-ui,sans-serif', 'letter-spacing:.2px', 'box-shadow:0 2px 10px rgba(0,0,0,.4)',
      'cursor:pointer', 'touch-action:manipulation', '-webkit-tap-highlight-color:transparent',
    ].join(';');
    el.addEventListener('pointerdown', e => e.stopPropagation());
    el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); o.exit(); });
    o.container.appendChild(el);
    persistentExitEl = el;
    if (primaryPointerIsCoarse() || lastRidePointerWasTouch()) showPersistentExit();
  }

  function showPersistentExit() {
    if (persistentExitEl) persistentExitEl.style.display = 'block';
  }

  function showTouchUi() {
    if (!touchControlsAllowed || !touchUi || touchUi.style.display === 'block') return;
    touchUi.style.display = 'block';
    document.body.classList.add('os-touch-riding');
    // the speed read-out is sized for a desktop viewport; 38px is a tenth of a landscape phone's height
    const mph = hud?.querySelector('[data-mph]') as HTMLElement | null;
    if (mph) mph.style.fontSize = `${Math.round(38 * ui)}px`;
    restStick(); // the zones only have rects once the overlay is displayed
  }

  /** Touch mode reveals the labelled diagram; pad mode hides it so a docked phone rides on a clean viewport. */
  function setInputMode(mode: 'touch' | 'pad') {
    if (inputMode === mode) return;
    inputMode = mode;
    preferPad = mode === 'pad';
    if (mode === 'pad') {
      if (touchUi) touchUi.style.display = 'none';
    } else showTouchUi();
  }

  /** True when launched from a home-screen icon (or any installed-app display mode) — already chrome-less,
   *  so the ⛶ chip has nothing to add and isn't built. */
  function isStandalone(): boolean {
    return window.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  }

  /** Fullscreen toggle for the ⛶ chip; webkit-prefixed fallbacks for iPad Safari. iPhone Safari has NO element
   *  fullscreen at all — there the chip explains the Add to Home Screen path instead (the metas in index.html
   *  make that launch chrome-less). Must run from a tap: a gamepad press carries no user activation. */
  function toggleFullscreen() {
    const doc = document as Document & {
      webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void;
    };
    if (!(document.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
      toast('iPhone can’t fullscreen a web page — Share → Add to Home Screen, then ride from the icon', 'warn', 6000);
      return;
    }
    if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
      Promise.resolve((doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc)).catch(() => {});
    } else {
      const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      const req = root.requestFullscreen ?? root.webkitRequestFullscreen;
      Promise.resolve(req?.call(root)).catch(err => toast(`Fullscreen refused: ${err?.message ?? err}`, 'err'));
    }
  }

  /**
   * Diagnostic mirror: light the riding buttons and move the left knob from the pad's live state, so a suspect
   * controller can be read straight off the screen. A control a finger owns is left alone — touch always wins —
   * and the knob tracks the RAW axis, dead zone and all, because stick drift is exactly what this is for.
   */
  function mirrorPad(p: PadMirror | null) {
    // Letter badges explain physical button positions. A touch-only rider needs the action names, not controller
    // glyphs for hardware that is not present; retain detection even while the overlay itself is hidden.
    touchUi?.toggleAttribute('data-gamepad', !!p);
    if (touchUi?.style.display !== 'block') p = null; // nothing visible to light; the pass below clears stale marks
    for (const key of Object.keys(padBtnEls) as PadBtnKey[]) {
      const el = padBtnEls[key];
      if (el.dataset.on) { delete el.dataset.pad; continue; } // a finger owns it
      if (p?.[key]) el.dataset.pad = '1'; else delete el.dataset.pad;
    }
    if (stick.id === -1) { // no thumb on the left ring
      const x = walking ? p?.moveX ?? 0 : p?.steer ?? 0;
      const y = -(p?.moveY ?? 0);
      const dx = clamp(x, -1, 1) * stickR, dy = clamp(y, -1, 1) * stickR;
      stickKnob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
      stickBase.style.opacity = p && Math.hypot(x, y) > 0.02 ? '0.85' : '0.5';
    }
  }

  /** Called while a pad is detected. Hides the diagram only after the screen has gone untouched long enough. */
  function notePadPresent() {
    if (pauseControlsVisible) return;
    if (inputMode === 'pad') return;
    if (stick.id !== -1) return;                     // a thumb owns the steer ring right now
    if (lookPointerId !== -1) return;                 // or the on-foot drag-to-look surface
    if (touchUi?.querySelector('[data-on]')) return; // a touch button is held
    if (performance.now() - lastTouchAt < TOUCH_LINGER_MS) return;
    setInputMode('pad');
  }

  /** A button held down for as long as a finger is on it. Pointer capture keeps the release ours even if the
   *  finger slides off the button first — a slid-off OLLIE still launches, exactly as a keyup would. */
  function holdBtn(el: HTMLElement, down: () => void, up: () => void) {
    const onDown = (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.dataset.on = '1';
      down();
    };
    const onUp = (e: PointerEvent) => {
      if (!el.dataset.on) return; // pointercancel + lostpointercapture both land here; only the first counts
      e.preventDefault(); e.stopPropagation();
      delete el.dataset.on;
      up();
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
  }

  /**
   * A one-shot tap that only fires if the finger comes up still ON the button — so a mis-pressed Exit can be slid
   * off and abandoned, which for the two buttons that end or reset a run is worth the extra test.
   *
   * The release point is checked against the rect rather than leaned on `pointerleave`, because touch pointers get
   * *implicit* capture on pointerdown: the finger never "leaves", and pointerup is delivered here wherever it
   * happens. On touch — the only place these buttons exist — the leave-based version would fire every time.
   */
  function tapBtn(el: HTMLElement, hit: () => void) {
    el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); el.dataset.on = '1'; });
    el.addEventListener('pointercancel', () => { delete el.dataset.on; });
    el.addEventListener('pointerup', e => {
      e.preventDefault(); e.stopPropagation();
      if (!el.dataset.on) return;
      delete el.dataset.on;
      const r = el.getBoundingClientRect();
      const on = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (on) hit();
    });
  }

  /** Park the ring in its idle corner and zero the axis. Also the resize handler, since the corner is a rect read. */
  function restStick() {
    if (!stickZone) return;
    const r = stickZone.getBoundingClientRect();
    setStickCentre(stickHome, Math.max(stickHome, r.height - stickHome));
    stickKnob.style.transform = 'translate(0px,0px)';
    stickBase.style.opacity = '0.5';
    stick.x = stick.airX = stick.y = 0;
    o.setHold('touch', 'tuck', false);
    o.setHold('touch', 'brake', false);
  }

  function setStickCentre(x: number, y: number) {
    stick.cx = x; stick.cy = y;
    stickBase.style.left = `${x}px`;
    stickBase.style.top = `${y}px`;
  }

  function bindStick() {
    const z = stickZone;
    z.addEventListener('pointerdown', e => {
      if (stick.id !== -1) return; // one finger owns the stick; a second in the zone is ignored
      e.preventDefault(); e.stopPropagation();
      stick.id = e.pointerId;
      stick.active = true;
      z.setPointerCapture(e.pointerId);
      const r = z.getBoundingClientRect();
      setStickCentre(e.clientX - r.left, e.clientY - r.top); // the ring comes to the thumb, not the reverse
      stickBase.style.opacity = '0.95';
      moveStick(e);
    });
    z.addEventListener('pointermove', e => {
      if (e.pointerId !== stick.id) return;
      e.preventDefault();
      moveStick(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== stick.id) return;
      stick.id = -1;
      stick.active = false;
      restStick();
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
    z.addEventListener('lostpointercapture', end);
  }

  /** Direct manipulation for mobile look/orbit; two fingers scale the same third-person boom as the wheel. */
  function bindLookSurface() {
    const z = lookSurface;
    z.addEventListener('pointerdown', e => {
      if (lookPointers.has(e.pointerId) || lookPointers.size >= 2) return;
      e.preventDefault(); e.stopPropagation();
      lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      z.setPointerCapture(e.pointerId);
      if (lookPointers.size === 1) {
        lookPointerId = e.pointerId;
        lookLastX = e.clientX; lookLastY = e.clientY;
      } else {
        lookPointerId = -1;
        const [a, b] = [...lookPointers.values()];
        lookPinchDistance = Math.hypot(b.x - a.x, b.y - a.y);
      }
    });
    z.addEventListener('pointermove', e => {
      if (!lookPointers.has(e.pointerId)) return;
      e.preventDefault();
      lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (lookPointers.size === 2) {
        const [a, b] = [...lookPointers.values()];
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        if (lookPinchDistance > 0 && distance > 0) o.zoom(lookPinchDistance / distance);
        lookPinchDistance = distance;
        return;
      }
      if (e.pointerId !== lookPointerId) return;
      const dx = e.clientX - lookLastX, dy = e.clientY - lookLastY;
      lookLastX = e.clientX; lookLastY = e.clientY;
      if (dx || dy) o.look(dx * TOUCH_LOOK_GAIN, dy * TOUCH_LOOK_GAIN);
    });
    const end = (e: PointerEvent) => {
      if (!lookPointers.delete(e.pointerId)) return;
      lookPinchDistance = 0;
      const remaining = [...lookPointers.entries()][0];
      if (remaining) {
        lookPointerId = remaining[0];
        lookLastX = remaining[1].x; lookLastY = remaining[1].y;
      } else lookPointerId = -1;
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
    z.addEventListener('lostpointercapture', end);
  }

  function shapeTouchAxis(distance: number): number {
    const mag = Math.abs(normalizeTouchAxis(distance));
    const shaped = STICK_CENTRE_GAIN * mag + (1 - STICK_CENTRE_GAIN) * mag * mag * mag;
    return clamp(Math.sign(distance) * shaped, -1, 1);
  }

  /** Linear throw outside the pixel dead zone. Ground carving keeps the centre-softened curve above; air spin
   *  consumes this axis so a partial but deliberate swipe is not softened twice. */
  function normalizeTouchAxis(distance: number): number {
    if (Math.abs(distance) <= STICK_DEAD) return 0;
    return clamp(Math.sign(distance) * (Math.abs(distance) - STICK_DEAD) / (stickR - STICK_DEAD), -1, 1);
  }

  /** Knob follows the thumb, clamped to the ring. Riding Y is digital posture; walking Y is forward movement. */
  function moveStick(e: PointerEvent) {
    const r = stickZone.getBoundingClientRect();
    let dx = (e.clientX - r.left) - stick.cx;
    let dy = (e.clientY - r.top) - stick.cy;
    const len = Math.hypot(dx, dy);
    if (len > stickR) { const k = stickR / len; dx *= k; dy *= k; }
    stickKnob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
    stick.x = shapeTouchAxis(dx);
    stick.airX = normalizeTouchAxis(dx);
    const vertical = shapeTouchAxis(dy);
    stick.y = walking ? -vertical : 0;
    const posture = touchRidePosture(vertical, stick.x);
    o.setHold('touch', 'tuck', !walking && posture.tuck);
    o.setHold('touch', 'brake', !walking && posture.brake);
  }

  /** Show the run's lap standing the way the game's announcer counts it — the passes still to run, counting
   *  the one under way (`ride/laps.remaining`), so the first crossing on MEGAPLEX reads "3 laps left". Hidden
   *  entirely on a single-pass course — most courses are one pass, and a permanent lap read-out is noise. */
  function setLaps(laps: { remaining: number; finished: boolean } | null) {
    const el = hud?.querySelector('[data-lap]') as HTMLElement | null;
    if (!el) return;
    el.style.display = laps ? 'inline' : 'none';
    if (!laps) return;
    // `remaining` can sit at 0 before `finished`: the tube's mouth counted the last crossing and the rider is
    // riding the final stretch through to the plane — still the final lap, not a finished run.
    el.textContent = laps.finished ? 'finished' : laps.remaining <= 1 ? 'final lap' : `${laps.remaining} laps left`;
    el.style.color = laps.finished ? '#74f59a' : laps.remaining <= 1 ? '#ffd34d' : '#eaf2ff';
  }

  /**
   * The run clock. `seconds` is what to show — elapsed in a race, remaining in showoff — and the mode is what
   * labels it, since the same 0:12.34 means opposite things in the two events. `expired` is showoff's zero: the
   * clock stops there and goes red, and the test ride keeps running, because a bench that ejects you when the
   * countdown lands is a worse bench (docs/016). Null hides the whole chip.
   */
  function setRunClock(clock: RideRunStatus | null) {
    clockEl.style.display = clock ? 'inline-flex' : 'none';
    if (!clock) return;
    (clockEl.querySelector('[data-clocktime]') as HTMLElement).textContent = formatRunClock(clock.clockSeconds);
    (clockEl.querySelector('[data-clockmode]') as HTMLElement).textContent =
      clock.phase === 'time-up' ? 'TIME UP' : clock.mode === 'showoff' ? 'SHOWOFF' : 'RACE';
    const scoreEl = clockEl.querySelector('[data-clockscore]') as HTMLElement;
    scoreEl.style.display = clock.mode === 'showoff' ? 'inline' : 'none';
    scoreEl.textContent = clock.mode === 'showoff'
      ? `${Math.max(0, Math.round(clock.score)).toLocaleString()} pts` : '';
    const trickRoot = clockEl.querySelector('[data-clocktrick]') as HTMLElement;
    const trick = clock.mode === 'showoff' ? clock.trick : null;
    trickRoot.style.display = trick ? 'block' : 'none';
    if (trick) {
      const points = clockEl.querySelector('[data-trickpoints]') as HTMLElement;
      const detail = clockEl.querySelector('[data-trickdetail]') as HTMLElement;
      points.textContent = `+${Math.max(0, Math.round(trick.points)).toLocaleString()}`;
      points.style.color = trick.state === 'landed' ? '#8fe39a'
        : trick.state === 'bailed' ? '#ff5a4d' : '#ffffff';
      detail.textContent = trick.detail ?? '';
      detail.style.display = trick.detail ? 'block' : 'none';
      detail.style.color = trick.state === 'bailed' ? '#ff8a7a'
        : trick.kind === 'grind' ? '#c6a3ff' : trick.kind === 'grab' ? '#ffb3d1' : '#9fd4ff';
    }
    // Amber under ten seconds is the only cue a countdown gets before it lands; a race clock never colours,
    // since counting up has no threshold to warn about.
    clockEl.style.color = clock.phase === 'time-up' ? '#ff6d7a'
      : clock.mode === 'showoff' && clock.clockSeconds <= 10 ? '#ffd34d' : '#eaf2ff';
  }

  /** A checkpoint award belongs with the Showoff clock, not the centre-screen countdown/cue surface. */
  function showTimeBonus(text: string, durationSeconds = 1.8) {
    timeBonusAnimation?.cancel();
    timeBonusEl.textContent = text.trim();
    if (!timeBonusEl.textContent) { timeBonusEl.style.display = 'none'; return; }
    timeBonusEl.style.display = 'block';
    timeBonusAnimation = timeBonusEl.animate(
      [{ opacity: 0 }, { opacity: 1, offset: .12 }, { opacity: 1, offset: .78 }, { opacity: 0 }],
      { duration: Math.max(0.1, durationSeconds) * 1000, easing: 'linear' },
    );
    timeBonusAnimation.onfinish = () => { timeBonusEl.style.display = 'none'; timeBonusAnimation = null; };
  }

  function update(st: RideState, boost: boolean, perf: RidePerf, effects?: Readonly<RideEffectState>) {
    const mph = Math.round(st.vel.length() * 2.236936); // whole mph, matching the in-world run HUD
    const grade = Math.round(Math.acos(clamp(st.contactN.y, -1, 1)) / D2R);
    (hud.querySelector('[data-mph]') as HTMLElement).textContent = String(mph);
    (hud.querySelector('[data-grade]') as HTMLElement).textContent = `grade ${grade}°`;
    // The contact depth IS the model: it is where the surface's response balances gravity, and it is the one
    // number that says whether a surface is riding as its table row says it should.
    (hud.querySelector('[data-depth]') as HTMLElement).textContent =
      st.grounded ? `sink ${(-st.error * 100).toFixed(1)} cm` : '';
    const surf = hud.querySelector('[data-surf]') as HTMLElement;
    // The motion flag, then the two things about the rider the chase camera does not read at a glance: how far
    // through a flip they are (the number that says whether this one is going to land), and whether they are
    // riding switch — which is not a cosmetic state, it changes which way every carve goes.
    const motion = st.railIdx >= 0 ? '≡ grind' : !st.grounded ? '✈ air' : boost ? '» boost' : '';
    const flip = !st.grounded && Math.abs(st.flip) >= 15
      ? `${st.flip > 0 ? '↻' : '↺'} ${Math.round(Math.abs(st.flip))}°` : '';
    surf.textContent = [motion, flip, st.lead < 0 ? '⇄ switch' : ''].filter(Boolean).join(' · ');
    // ollie charge meter: fills while the ollie is held, gone the frame it releases. On touch the OLLIE button
    // *is* the meter — it fills under the thumb that's holding it, where the eye already is.
    const bar = hud.querySelector('[data-charge]') as HTMLElement;
    bar.style.display = st.charging ? 'inline-block' : 'none';
    (hud.querySelector('[data-chargefill]') as HTMLElement).style.width = `${Math.round(st.charge * 100)}%`;
    if (ollieFill) ollieFill.style.height = st.charging ? `${Math.round(st.charge * 100)}%` : '0';
    fpsValueEl.textContent = `${Math.round(perf.fps)} fps`;

    // Like the canvas profiler in VR, repaint only as quickly as changing diagnostic text can be read. The compact
    // FPS line above remains live every frame; the expanded dashboard is both conditional and throttled so it does
    // not become the long pole it is trying to identify.
    const now = performance.now();
    if (perfDetailsEl.open && now >= nextPerfPaintAt) {
      nextPerfPaintAt = now + PERF_REPAINT_MS;
      const ms = (value: number) => value < 10 ? value.toFixed(2) : value.toFixed(1);
      const count = (value: number) => Math.round(value).toLocaleString();
      const setField = (name: string, value: string) => {
        const field = perfFieldEls.get(name);
        if (field && field.textContent !== value) field.textContent = value;
      };
      const cpuMs = measuredRideCpuMs(perf);
      const outsideCpuMs = unmeasuredRideFrameMs(perf);
      const pacingMs = estimatedRidePacingMs(perf);
      const gpuText = perf.gpuTimerState === 'unsupported' ? 'unavailable'
        : perf.gpuTimerState === 'disjoint' ? 'reset'
          : perf.gpuMs === null ? 'pending' : `${ms(perf.gpuMs)} ms`;
      const referenceRatio = perf.frameMs > 0 ? perf.frameMs / DESKTOP_FRAME_REFERENCE_MS : NaN;
      const referenceState = Number.isNaN(referenceRatio) ? 'neutral'
        : referenceRatio > PERF_WAY_OVER_REFERENCE ? 'bad'
          : referenceRatio > PERF_OVER_REFERENCE ? 'warn' : 'good';

      perfHeadEl.dataset.state = referenceState;
      perfBudgetFillEl.dataset.state = referenceState;
      perfBudgetFillEl.style.width = Number.isNaN(referenceRatio)
        ? '0%' : `${Math.min(100, referenceRatio * 100).toFixed(1)}%`;
      setField('frame', `${ms(perf.frameMs)} ms`);
      setField('fps', String(Math.round(perf.fps)));
      setField('cpu', `${ms(cpuMs)} ms`);
      setField('gpu', gpuText);
      setField('pacing', pacingMs === null ? `≤ ${ms(outsideCpuMs)} ms` : `~ ${ms(pacingMs)} ms`);
      setField('outside', `${ms(outsideCpuMs)} ms`);
      setField('cpu-total', `${ms(cpuMs)} ms`);

      const phases: ReadonlyArray<readonly [string, number]> = [
        ['world', perf.worldMs], ['ride', perf.rideMs], ['effects', perf.effectsMs],
        ['scene', perf.sceneMs], ['render', perf.renderMs], ['post', perf.postFrameMs],
        ['xr', perf.xrBeginMs + perf.xrEndMs],
      ];
      const largestPhase = phases.reduce((largest, phase) => phase[1] > largest[1] ? phase : largest);
      for (const [name, value] of phases) {
        setField(`phase-${name}`, `${ms(value)} ms`);
        perfPhaseEls.get(name)?.toggleAttribute('data-hot', value > 0 && name === largestPhase[0]);
      }

      setField('physics', `${ms(perf.physicsMs)} ms`);
      setField('cast', `${ms(perf.castMs)} ms`);
      setField('ai', `${ms(perf.aiMs)} ms`);
      setField('pose', `${ms(perf.poseMs)} ms`);
      setField('camera', `${ms(perf.cameraMs)} ms`);
      setField('telemetry', `${ms(perf.telemetryMs)} ms`);
      setField('hud', `${ms(perf.hudMs)} ms`);
      setField('walk', `${ms(perf.walkCollisionMs)} ms`);
      setField('render-prep', `${ms(perf.renderPrepMs)} ms`);
      setField('render-submit', `${ms(perf.renderSubmitMs)} ms`);
      setField('walk-work', `${count(perf.walkGroundCasts)} ground · ${count(perf.walkSweeps)} sweep · `
        + `${count(perf.walkTriangleTests)} tri · ${count(perf.walkLiveRefits)} refit`);

      setField('draws', count(perf.drawCalls));
      setField('triangles', count(perf.renderTriangles));
      setField('lines-points', `${count(perf.renderLines)} / ${count(perf.renderPoints)}`);
      setField('render-list', `${count(perf.renderOpaqueItems)} opaque · ${count(perf.renderTransparentItems)} transparent`
        + ` · ${count(perf.renderTransmissiveItems)} transmissive`);
      setField('transparent', `ref ${count(perf.renderTransparentRefBatches)} batch + `
        + `${count(perf.renderTransparentRefIsolated)} isolated · authored ${count(perf.renderTransparentAuthoredProps)}`
        + ` · other ${count(perf.renderTransparentOther)}`
        + (perf.renderTransparentOtherSources ? ` (${perf.renderTransparentOtherSources})` : ''));
      setField('props', `batch ${count(perf.propBatchDraws)} draws / ${count(perf.propBatchSlots)} slots · `
        + `isolated ${count(perf.propIsolatedDraws)} / ${count(perf.propIsolatedSlots)} · `
        + `authored ${count(perf.authoredPropDraws)}`);
      perfIsolationEl.style.display = perf.propIsolation ? '' : 'none';
      setField('isolation', perf.propIsolation || '—');

      setField('geometries', count(perf.geometries));
      setField('textures', count(perf.textures));
      setField('programs', count(perf.programs));
      setField('batching', perf.multiDraw ? 'native multi-draw' : 'merged fallback');
      setField('ride-tris', `${count(perf.rideTris)} tris`);
    }
    const badges: string[] = [];
    if ((effects?.speedBoostSeconds ?? 0) > 0) badges.push(`SPEED ${effects!.speedBoostSeconds.toFixed(1)}s`);
    if ((effects?.trickBoostSeconds ?? 0) > 0) badges.push(`TRICK ${effects!.trickBoostSeconds.toFixed(1)}s`);
    if ((effects?.scoreMultiplier ?? 1) > 1) badges.push(`SCORE ×${effects!.scoreMultiplier}`);
    (hud.querySelector('[data-effects]') as HTMLElement).textContent = badges.join('  ·  ');

    // Unity's run HUD is fifteen whole dots. Keep the same pop-on/pop-off quantisation here rather than slicing
    // the final cell, and hide the complete bar outside a live scored run (where held boost is unlimited).
    const meter = effects?.boostMeter ?? null;
    const meterRoot = hud.querySelector('[data-boost-meter]') as HTMLElement;
    meterRoot.style.display = meter === null ? 'none' : 'flex';
    if (meter !== null) {
      const lit = boostMeterSegments(meter);
      const colours = ['#ffe05a', '#ffc44d', '#ffa447', '#ff7d4c', '#ff555f'];
      const dots = hud.querySelectorAll<HTMLElement>('[data-boost-dot]');
      dots.forEach((dot, i) => {
        dot.style.background = i < lit ? colours[Math.min(4, Math.floor(i / 3))] : 'rgba(117,126,137,.28)';
        dot.style.boxShadow = i < lit
          ? `0 0 7px ${colours[Math.min(4, Math.floor(i / 3))]}88` : 'inset 0 0 0 1px rgba(255,255,255,.08)';
      });
    }
  }

  function setCountdown(label: string | null) {
    const paused = label === 'PAUSED';
    pauseControlsVisible = paused;
    if (paused) showTouchUi();
    else if (inputMode === 'pad' && touchUi) touchUi.style.display = 'none';
    countdownEl.style.display = label ? 'block' : 'none';
    countdownEl.textContent = label ?? '';
    countdownEl.style.top = paused ? 'auto' : '42%';
    countdownEl.style.bottom = paused ? '104px' : 'auto';
    countdownEl.style.transform = paused ? 'translateX(-50%)' : 'translate(-50%,-50%)';
    countdownEl.style.fontSize = label === 'READY' || paused ? '52px' : label === 'GO' ? '74px' : '96px';
    countdownEl.style.letterSpacing = label && label.length > 1 ? '1px' : '-4px';
    countdownEl.style.color = label === 'GO' ? '#74f59a' : '#f7fbff';
  }

  function showMessage(text: string, color: [number, number, number], durationSeconds = 2.5) {
    messageAnimation?.cancel();
    timeBonusAnimation?.cancel();
    const clean = text.trim();
    if (!clean) { messageEl.style.display = 'none'; messageEl.textContent = ''; return; }
    const channel = (value: number) => Math.round(clamp(Number.isFinite(value) ? value : 1, 0, 1) * 255);
    messageEl.textContent = clean;
    messageEl.style.color = `rgb(${channel(color[0])} ${channel(color[1])} ${channel(color[2])})`;
    messageEl.style.display = 'block';
    messageAnimation = messageEl.animate(
      [{ opacity: 0, offset: 0 }, { opacity: 1, offset: .06 },
        { opacity: 1, offset: .78 }, { opacity: 0, offset: 1 }],
      { duration: Math.max(0.1, durationSeconds) * 1000, easing: 'linear' },
    );
    messageAnimation.onfinish = () => { messageEl.style.display = 'none'; messageAnimation = null; };
  }

  /** Swap the controller labels and active face controls when Play moves between its board and walking. */
  function setWalking(onFoot: boolean) {
    // A keeps its physical position while its context changes, exactly like the real gamepad.
    o.releaseSource('touch');
    walking = onFoot;
    const setAction = (el: HTMLElement, action: string) => {
      const label = el.querySelector<HTMLElement>('[data-action]');
      if (label) label.textContent = action;
    };
    setAction(aBtnEl, onFoot ? 'JUMP' : 'OLLIE');
    aBtnEl.setAttribute('aria-label', onFoot ? 'Jump' : 'Ollie');
    aBtnEl.title = onFoot ? 'A · Jump' : 'A · Ollie';
    const boardLabel = onFoot ? 'Get on board' : 'Get off board';
    boardBtnEl.setAttribute('aria-label', boardLabel);
    boardBtnEl.title = `Y · ${boardLabel}`;
    boostBtnEl.setAttribute('aria-disabled', 'false');
    boostBtnEl.style.opacity = '1';
    boostBtnEl.style.pointerEvents = 'auto';
    lookPointerId = -1;
    lookPinchDistance = 0;
    lookPointers.clear();
    stick.active = false; stick.x = stick.airX = stick.y = 0;
    lookStick.active = false; lookStick.x = lookStick.y = 0;
    if (touchUi?.style.display === 'block') restStick();
    const stats = hud?.querySelector('[data-ride-stats]') as HTMLElement | null;
    if (stats) stats.style.display = onFoot ? 'none' : 'flex';
  }

  function setFirstPerson(firstPerson: boolean) {
    firstPersonView = firstPerson;
    reticleEl.style.display = firstPerson ? 'block' : 'none';
    if (viewBtnEl) {
      const action = viewBtnEl.querySelector<HTMLElement>('[data-action]');
      if (action) action.textContent = firstPersonView ? '3RD' : '1ST';
      const label = firstPersonView ? 'Switch to third person' : 'Switch to first person';
      viewBtnEl.setAttribute('aria-label', label);
      viewBtnEl.title = label;
    }
  }

  function setTelemetry(label: string, active = false) {
    telemetryEl.textContent = label;
    telemetryEl.style.color = active ? '#ff6d7a' : '#8eb8da';
    if (active) perfDetailsEl.open = true;
  }

  function dispose() {
    o.releaseSource('touch');
    document.body.classList.remove('os-touch-riding');
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointerdown', onTouchInput, true);
    hud?.remove();
    fpsEl?.remove();
    countdownEl?.remove();
    messageAnimation?.cancel();
    messageEl?.remove();
    reticleEl?.remove();
    clockEl?.remove();
    touchUi?.remove();
    persistentExitEl?.remove();
  }

  buildHud();
  buildPersistentExit();
  window.addEventListener('resize', onResize);

  return {
    stick, lookStick, update, setWalking, setFirstPerson, setCountdown, showMessage, showTimeBonus, setLaps, setRunClock,
    setTelemetry, notePadPresent, mirrorPad, dispose,
  };
}

export type RideHud = ReturnType<typeof createRideHud>;
