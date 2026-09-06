/**
 * The auto-test course builder: it lays a fixture's cells down a fall line and returns the document plus
 * the machine-readable plan the harness grades a run against. The fixtures themselves — every case table,
 * the shapes they are built from and the courses they make up — live in `autotest-cases.ts` and are
 * re-exported here, so this module path stays the one place any of it is imported from.
 */

import type { AuthoredModel, PlacedProp, Rail, V3 } from '../doc/types';
import { buildMeshFromCourse, straightCourse } from '../doc/mountain';
import { surfaceHeightAt } from '../mesh/surface-height';
import {
  addEffectNodeTemplate, addEffectTemplateToProp, bindEffectFunctionCall, bindEffectSplineToMotionPath,
  bindInstanceHop, bindRiderTeleport,
  createEmptyEffectsDocument, effectAttachments, effectCircumstanceLabel, effectNode, nextEffectId,
  setEffectNodeSoundFile, syncAuthoredMotionPathEffectResources, EFFECT_TEMPLATES,
  type EffectSelection,
} from '../effects/authoring';
import { EFFECT_TRIGGER_LEVEL } from '../effects/trigger-volume';
import { AUTHORED_MODEL_LEVEL } from '../doc/models';
import { IMPORTED_PROP_LEVEL } from '../props/imported';
import { addCollisionMarkerNode } from './lab';
import {
  AUTO_TEST_CASES, AUTO_TEST_NAME, AUTO_TEST_TARGET, CLIP_PROP_MODEL, COMPANION_OFFSET_M,
  CRASH_BAG_BASE_OFFSET_M, CRASH_BAG_MODEL, GATE_HEIGHT_M, GATE_WIDTH_M, profile, TRICK_GEM_MODEL,
  type AutoTestCase, type AutoTestMode, type AutoTestRiderSignal, type AutoTestSignal,
  type AutoTestSurfaceStrip,
} from './autotest-cases';

export {
  AUTO_TEST_TARGET, AUTO_TEST_GOLD_NAME, AUTO_TEST_NAME, AUTO_TEST_NAME_B, AUTO_TEST_LAB_NAME,
  AUTO_TEST_FIELD_NAME, AUTO_TEST_SIGNALS_NAME, AUTO_TEST_RELAY_NAME, AUTO_TEST_CALL_NAME,
  AUTO_TEST_COLLISION_NAME, AUTO_TEST_COLLISION_CASES, AUTO_TEST_CASES, AUTO_TEST_CASES_B,
  AUTO_TEST_GOLD_CASES, AUTO_TEST_LAB_CASES, AUTO_TEST_FIELD_CASES, AUTO_TEST_RELAY_CASES,
  AUTO_TEST_CALL_CASES, AUTO_TEST_SIGNALS_CASES, AUTO_TEST_SIGNAL_STRIPS, AUTO_TEST_FIXTURES,
  autoTestFixture,
} from './autotest-cases';
export type {
  AutoTestCase, AutoTestFixture, AutoTestMode, AutoTestRiderSignal, AutoTestSignal, AutoTestSurfaceStrip,
} from './autotest-cases';

export interface AutoTestPlanEntry {
  id: string;
  question: string;
  /** Stable authoring id — the join the export writes into `extensions.slopesmith.bakedGroups`. */
  propId: string;
  /** The authored placement name. Each bake family numbers its groups independently, so the leading
   *  `<Family>_<n>_` of the instance name is not predictable from a case's position in the matrix; this
   *  suffix is, and it is what the export's own name is checked against.
   *
   *  Except for an IMPORTED placement, where it is not the export's to carry. Every other family this fixture
   *  uses is named from something the fixture authored — a panel's model is built per cell and carries the
   *  cell's own name — while an import's group is named from the CATALOGUE model it placed, which several
   *  placements share. `importedModel` below says which rule applies. */
  propName: string;
  /** Set when this case placed a prop from the Custom catalogue. The export names such a group
   *  `Import_<n>_<model>` after the catalogue record, which the fixture does not know a name for, so the plan
   *  check asserts the FAMILY here instead of the authored suffix. The join itself is unaffected: it is read
   *  out of `bakedGroups` under this case's own authoring id, so it is exact either way, and the name checks
   *  are there to catch a case that resolved to the wrong baker. */
  imported?: true;
  /** The native `Instances[].InstanceName` this case became, filled in from the finished export. The harness
   *  hashes it to find the live entity. */
  instanceName: string;
  /** That instance's raw SSX location, filled in from the finished export. The harness confirms a candidate
   *  entity by reading its live translation and matching this, rather than trusting a hash hit. */
  location: [number, number, number] | null;
  /** Metres down the fall line from the start gate — the harness orders events against the run with it. */
  distanceM: number;
  mode: 0 | 1 | 2 | 3;
  signals: AutoTestSignal[];
  /** What hardware has already demonstrated, for the harness to grade this pass against. Absent = the cell
   *  is still a question, and the harness reports its result without calling it a pass or a failure. */
  expect: 'dispatch' | 'no-dispatch' | null;
  expectPaint: boolean;
  /** What the RIDER must do while this cell is nearest to them. Absent = the cell makes no claim about the
   *  rider, and the harness measures every signal anyway. */
  expectRider: readonly { signal: AutoTestRiderSignal; atLeast?: number; atMost?: number }[] | null;
  /** Bounds on how many times the live-node slot is released after it first fills. Absent = the cell makes
   *  no claim about the slot beyond having filled it. */
  expectSlot: { atLeast?: number; atMost?: number } | null;
  /** The across-the-fall-line span check does not apply: this cell's claim comes from a persistent node
   *  rather than from contact. */
  contactOptional?: boolean;
  /**
   * The cell whose dispatch establishes that this row was covered, for a row the rider cannot reach.
   *
   * A hop's companion is placed a half-corridor off the fall line SO THAT nothing but the hop can put a node
   * on it, which means the rider never comes within the harness's 25 m ball and the row's normal condition
   * is `not-reached`. That grades inconclusive — correctly for an ordinary cell, where a miss and a refusal
   * are indistinguishable — and the two rules together made a `no-dispatch` companion a row that could never
   * pass whatever the engine did. `cracked-tough-target` is the one that showed it.
   *
   * What actually covers such a row is the cell that drives it having been ridden, which is a POSITIVE
   * observation rather than an absence: if the host dispatched, the chain ran, and a companion still empty
   * is a refusal. The harness waives `not-reached` only on that evidence, so a run that never got this far
   * still reports honestly.
   */
  coveredBy?: string;
  demonstrated: string | null;
  /** Extra words for the harness to sample, so a cell can report what its node DID and not merely that one
   *  was built. `liveNode` offsets are read relative to the current semantic live-node pointer, and
   *  are re-addressed every tick because the slot changes hands. An `entity` watch is a pointer chain walked
   *  once from the instance itself, so it survives the node being torn down. */
  watches?: ({ label: string; base: 'liveNode'; offsets: number[] }
    | { label: string; base: 'entity'; chain: number[] }
    | { label: string; base: 'absolute'; addresses: number[] })[];
  /** An object the instance cannot reach, found in the heap after the window by the pointer it holds back
   *  to this cell's instance. */
  lateWatch?: { label: string; backPointer: number; offsets: number[]; seconds?: number };
}

/**
 * The texture-flip node's own state, read off whatever node the contact built
 * [Trailmap: 410-flip-runtime].
 *
 * A flip never writes the level's material record — it builds a node-local override table and hands the
 * renderer that instead — so "did the button paint" is only answerable from the node. These five words
 * separate the ways it can silently do nothing:
 *
 *   +0x14  sub-type: 11 is TexFlip. Anything else means the slot is held by another node in the chain and
 *          the flip was never built (the factory refuses a second node of a sub-type already live).
 *   +0x5c  the applied frame — the signal. Exactly -1 is the signature of a material carrying no flip
 *          table, i.e. the frame list never reached the packed material.
 *   +0x60  how many materials the node captured; 0 means it found nothing to paint.
 *   +0x64  frame count taken from the material's flip table; 0 is the same failure seen from the other end.
 *   +0x2d0 the node's enable word; a disabled node draws nothing.
 */
const FLIP_NODE_WATCH = {
  label: 'flipNode', base: 'liveNode' as const, offsets: [0x14, 0x5c, 0x60, 0x64, 0x2d0],
};

/** Instance status flags, read independently of node lifetime. They expose draw-state and bound-node control
 *  transitions that the node itself does not record [Trailmap: 150-control-state, 410-flip-runtime]. */
const ENTITY_FLAGS_WATCH = {
  label: 'entityFlags', base: 'entity' as const, chain: [0xe8],
};

/** The instance's world translation, first component. A prop that never moves holds one value all run. */
const ENTITY_POS_WATCH = {
  label: 'entityPosX', base: 'entity' as const, chain: [0x30],
};

/** Null-owner control for the pad request destinations. A value implicates a null owner; unchanged values leave
 *  a real non-local rider as the remaining outcome [Trailmap: 360-pads-ownership]. */
const PAD_LOW_MEMORY_WATCH = {
  label: 'lowMem', base: 'absolute' as const, addresses: [0x134, 0x138, 0x13c],
};

/** The live-node slot as an ordinary traced probe. The verdict reports when it first filled; this is what
 *  records when it EMPTIED, so a word like the draw gate can be read against the node's lifetime. */
const LIVE_NODE_WATCH = {
  label: 'liveNodeSlot', base: 'entity' as const, chain: [0xe4],
};

/** One instrument strip as the plan records it: the span the paint was laid from, which is therefore the
 *  span the analyzer buckets rider samples by — one set of numbers, used twice. */
export interface AutoTestPlanStrip { label: string; surface: number; fromM: number; toM: number }

/** One placed emitter, as the voice probe grades it.
 *
 * `event` is the only field the fixture cannot know: a custom clip is allocated a reserved id by the EXPORT,
 * so it is read back out of the finished folder rather than predicted — the same rule the instance names
 * follow, and for the same reason. The probe matches pool entries by that id, so a wrong guess here would
 * grade a different emitter and say so confidently. */
/** One fixture-generated clip: the library WAV name, and the pitch it was synthesised at. Both travel into
 *  the plan because the two halves of the audio grade need different ones — the ride matches emitters by
 *  event id, and `tools/autotest/audio_tone.py` matches the SHIPPED bank slot by what it decodes to. */
export interface AutoTestTone {
  file: string;
  hz: number;
}

export interface AutoTestPlanAudio {
  id: string;
  propId: string;
  propName: string;
  distanceM: number;
  /** Silent until the rider hits the prop. */
  gated: boolean;
  /** `sounds` = a voice must start once the rider is in range. `gated` = resident and SILENT until contact,
   *  then sounding — the pair that keeps a run which sounds everything from grading green. `open` measures
   *  without judging, for a cell whose answer is predicted rather than established. `one-shot` is not a ride
   *  grade at all: a collision clip is a transient voice the pool never holds, so the row exists to be read
   *  off the shipped bank instead — where its slot must come out UNLOOPED while its neighbours come out
   *  looped. */
  expect: 'sounds' | 'gated' | 'open' | 'one-shot';
  /** The global event id this emitter ended up with, filled in from the finished export. */
  event: number | null;
  /** The fixture clip this cell carries, when it carries one, and the pitch it was written at. What makes
   *  the bank readable without the console: a slot that decodes to 220 Hz is the bed, whatever id it rode in
   *  on, and a slot that decodes to noise or silence is a defect no dispatch grade can see. */
  clip?: string;
  toneHz?: number;
}

export interface AutoTestPlan {
  name: string;
  target: string;
  /** Course length in metres, so a driver can bound how long a full pass takes. */
  runLengthM: number;
  /** Fixture-owned sampling bound, in game frames, when present. */
  windowFrames?: number;
  /** The generated course contains Show Message nodes and therefore needs the debug-HUD executable patch. */
  hudText?: true;
  /** The mountain this course expects, carried into the plan so the harness reads it rather than being told
   *  it. A mode passed on the command line is a thing to forget; a mode written into the plan the fixture
   *  produced is one the driver can default from and refuse to contradict. */
  mode: AutoTestMode;
  entries: AutoTestPlanEntry[];
  /** The instrument strips, when this course carries them (`AUTOTEST4`). */
  strips?: AutoTestPlanStrip[];
  /** The placed emitters, when this course carries them (`AUTOTEST8`). Graded by
   *  `tools/autotest/audio_voices.py` off the engine's external-voice pool rather than by the dispatch
   *  harness, because "a node was built" is not what an ambient bed is asked to do. */
  audio?: AutoTestPlanAudio[];
}

/** One full-corridor panel, upright or flat, in editor metres about a bottom-centre anchor. */
function panelModel(id: string, name: string, upright: boolean, texture: string | null,
  frames: string[] | null, halfDepth = 4): AuthoredModel {
  const half = GATE_WIDTH_M / 2;
  // Stored [O, second axis, first axis, diagonal] is the front-up/front-out winding the tessellation oracle
  // expects; the mode-1 narrowphase is two-sided either way, so this only settles which face is lit.
  const vertices = upright
    ? [-half, 0, 0, half, 0, 0, -half, GATE_HEIGHT_M, 0, half, GATE_HEIGHT_M, 0]
    : [-half, 0, -halfDepth, half, 0, -halfDepth, -half, 0, halfDepth, half, 0, halfDepth];
  return {
    id, name, anchor: [0, 0, 0], vertices, quads: [[0, 2, 1, 3]],
    ...(texture ? { texture } : {}), ...(frames ? { frames } : {}),
  } as unknown as AuthoredModel;
}

export interface AutoTestOptions {
  name?: string;
  /** Imported catalogue model used by clip-bearing cells and hop companions. The historical fixture uses
   *  model 24, but headless fixture generation imports its bundled SnowGun into a fresh catalogue and
   *  supplies the model number allocated there. */
  clipModel?: number;
  /** A two-entry flipbook tile pair (`"LEVEL/name.png"` refs). Without it the flipbook cells are skipped,
   *  because a ride-over button with a single-frame material is inert for a reason that has nothing to do
   *  with collision and would read as a false negative. */
  flipbookTiles?: { rest: string; frame: string } | null;
  /** Stock course-bank sound slot for the Play-sound cell. A stock slot deliberately avoids the custom
   *  effect-sound pool, whose injection is a separate open question. */
  soundFile?: string | null;
  /** The fixture's own generated clips, by role, as custom-library WAV names. Without them the audio cells
   *  are skipped rather than authored against a missing file — the same rule the flipbook tiles follow, and
   *  for the same reason: a cell that is silent because its asset never arrived says nothing about the
   *  mechanism it was built to grade. */
  ambientTones?: { loop: AutoTestTone; gated: AutoTestTone; hit: AutoTestTone } | null;
  /** Metres between cells along the fall line. */
  spacingM?: number;
  /** Metres from the start gate to the first cell. */
  leadInM?: number;
  /** Fixture-owned sampling bound, copied into the machine-readable plan. */
  windowFrames?: number;
  /** Which catalogue to lay down. Defaults to the gold map's. */
  cases?: readonly AutoTestCase[];
  /** The mountain the plan should declare. Defaults to solo, which is the baseline for every fixture whose
   *  questions are not ABOUT having company. */
  mode?: AutoTestMode;
  /** The instrument strips to paint below the cells (`AUTOTEST4`). */
  strips?: readonly AutoTestSurfaceStrip[];
  /** Give every cell a Show message node naming itself, so a run says on screen which cell just fired.
   *
   *  Costs nothing on an ordinary disc — main type 12 is the dispatcher's inert default there, and
   *  `repack` drops the nodes unless it is built with `--patches hud-text` — so this is safe to leave on. It
   *  is off by default only because a fixture's packed size is one of the things its passes measure. */
  hudText?: boolean;
}

/** Build the auto-test document and the machine-readable plan that describes it. */
export function autoTestMountain(opts: AutoTestOptions = {}): { doc: ReturnType<typeof buildMeshFromCourse>; plan: AutoTestPlan } {
  const name = opts.name ?? AUTO_TEST_NAME;
  const clipModel = opts.clipModel ?? CLIP_PROP_MODEL;
  const spacing = opts.spacingM ?? 90;
  const leadIn = opts.leadInM ?? 140;
  const mode: AutoTestMode = opts.mode ?? 'showoff';
  const cases = (opts.cases ?? AUTO_TEST_CASES)
    .filter(item => !item.needsFlipbook || !!opts.flipbookTiles)
    .filter(item => (!item.ambient?.tone && !item.collisionTone) || !!opts.ambientTones);

  // Long enough to hold every cell at full spacing with room to run out past the last one, and wide enough
  // that a full-corridor panel still sits inside the rideable snow. The instrument strips lie BELOW the
  // last cell (60 m clear, so its window closes on uniform paint) and the course grows to hold them.
  const strips = opts.strips ?? [];
  const stripsStartM = leadIn + spacing * cases.length + 60;
  const stripsLengthM = strips.reduce((sum, strip) => sum + strip.lengthM, 0);
  const runLength = (strips.length ? stripsStartM + stripsLengthM : leadIn + spacing * cases.length) + 120;
  const course = straightCourse(Math.max(400, runLength * 0.32), 320, 18);
  const effects = createEmptyEffectsDocument(name);
  const models: AuthoredModel[] = [];
  const doc = buildMeshFromCourse(course, {
    widthM: 320, roughness: 0, targetPatchM: 20, seed: 1301,
  }, { name, baseSurface: 1, effects });
  if (!doc) throw new Error('The auto-test slope could not be generated.');

  // A uniform approach surface, exactly as the lab does it: lane choice must not change speed or feel, or a
  // cell that failed to dispatch is indistinguishable from one the rider crossed too slowly.
  if (doc.quadPaint) for (const key of Object.keys(doc.quadPaint)) {
    const surface = doc.quadPaint[Number(key)];
    if (surface !== 0 && surface !== 2) doc.quadPaint[Number(key)] = 1;
  }

  const a = course.knots[0].pos, b = course.knots[course.knots.length - 1].pos;
  const dx = b[0] - a[0], dz = b[2] - a[2], horizontal = Math.hypot(dx, dz) || 1;
  const down: V3 = [dx / horizontal, 0, dz / horizontal];
  const side: V3 = [-down[2], 0, down[0]];

  // The instrument strips: full-width SurfaceType bands, painted by each quad centre's distance down the
  // fall line. Only the rideable corridor is repainted — the 0/2 border paint (out-of-bounds walls,
  // off-track margins) stays exactly as the uniform pass left it, so the corridor narrows nowhere and the
  // descent is the same line over every strip. The plan carries the spans the paint was laid from, so the
  // analyzer buckets samples by the same numbers.
  const stripSpans: AutoTestPlanStrip[] = [];
  let stripCursor = stripsStartM;
  for (const strip of strips) {
    stripSpans.push({ label: strip.label, surface: strip.surface,
      fromM: stripCursor, toM: stripCursor + strip.lengthM });
    stripCursor += strip.lengthM;
  }
  if (stripSpans.length) for (let q = 0; q < doc.quads.length; q++) {
    const current = doc.quadPaint?.[q] ?? doc.baseSurface ?? 1;
    if (current === 0 || current === 2) continue;
    const quad = doc.quads[q];
    let cx = 0, cz = 0;
    for (const vertex of quad) { cx += doc.vertices[vertex * 3]; cz += doc.vertices[vertex * 3 + 2]; }
    const along = (cx / quad.length - a[0]) * down[0] + (cz / quad.length - a[2]) * down[2];
    const span = stripSpans.find(item => along >= item.fromM && along < item.toM);
    if (span && span.surface !== current) (doc.quadPaint ??= {})[q] = span.surface;
  }

  const props: PlacedProp[] = [];
  const entries: AutoTestPlanEntry[] = [];
  const tones = opts.ambientTones ?? null;
  /** Clips the mountain claims one of the three interactive-ambient ids for, in authoring order. */
  const hitGated: string[] = [];
  const audio: AutoTestPlanAudio[] = [];
  // The fixture's first motion path, and the mover nodes waiting to be bound to it. Both are filled in
  // during the pass below and resolved after it, because a path is authored from a cell's own position and
  // the binding needs the path to exist first.
  let motionPathAt: number | null = null;
  const splineBindings: EffectSelection[] = [];

  cases.forEach((test, ordinal) => {
    const distance = leadIn + spacing * ordinal;
    const x = a[0] + down[0] * distance;
    const z = a[2] + down[2] * distance;
    const ground = surfaceHeightAt(doc, x, z)
      ?? a[1] + (b[1] - a[1]) * distance / horizontal;
    const propId = `autotest:${ordinal.toString().padStart(2, '0')}`;
    // The fall line runs -X/-Z, so a panel authored across its own X faces the oncoming rider at 45 degrees
    // of yaw. Its span across the corridor is what matters, and the diagonal only widens it.
    const yaw = 45;
    const signals: AutoTestSignal[] = ['entity-node', 'particle'];
    const propName = `AT${ordinal}${test.id}`;
    let prop: PlacedProp;

    if (test.shape === 'bag' || test.shape === 'gem') {
      prop = {
        id: propId, level: AUTO_TEST_TARGET,
        model: test.shape === 'gem' ? TRICK_GEM_MODEL : CRASH_BAG_MODEL, name: propName,
        pos: [x, ground - (test.shape === 'gem' ? 0 : CRASH_BAG_BASE_OFFSET_M) + (test.liftM ?? 0), z],
        yaw, scale: test.scale ?? 1,
        nativeCollision: structuredClone(test.profile),
      };
    } else if (test.shape === 'clip') {
      prop = {
        id: propId, level: IMPORTED_PROP_LEVEL, model: test.importedModel ?? clipModel, name: propName,
        pos: [x, ground + (test.liftM ?? 0), z], yaw, scale: test.scale ?? 1,
        nativeCollision: structuredClone(test.profile),
      };
    } else if (test.shape === 'volume') {
      const size = test.sizeM ?? [GATE_WIDTH_M, GATE_HEIGHT_M, 8];
      prop = {
        id: propId, level: EFFECT_TRIGGER_LEVEL, model: 0, name: propName,
        pos: [x, ground + size[1] / 2, z], yaw, scale: 1,
        effectTrigger: { size: [...size] as [number, number, number] },
      };
    } else {
      const modelIndex = models.length;
      const tiles = test.needsFlipbook ? opts.flipbookTiles ?? null : null;
      models.push(panelModel(`model:${modelIndex.toString().padStart(4, '0')}`, propName,
        test.shape === 'gate', tiles?.rest ?? null, tiles ? [tiles.rest, tiles.frame] : null,
        (test.padDepthM ?? 8) / 2));
      prop = {
        id: propId, level: AUTHORED_MODEL_LEVEL, model: modelIndex, name: propName,
        pos: [x, ground + (test.liftM ?? 0), z], yaw, scale: test.scale ?? 1,
        nativeCollision: structuredClone(test.profile),
      };
      if (test.followsSlope) {
        // Lay the panel IN the surface rather than across it. A horizontal quad dropped on a fall-line course
        // is a LEDGE: the rider meets its edge, books one crossing contact and rides the snow underneath —
        // which is why every ride-on cell measured an impact worth ~87 where a retail pane, lying flat on a
        // floor the rider is genuinely carried by, is worn down about 1 at a time.
        //
        // `pitch` turns the panel about its own X and `roll` about its own Z (composed Ry·Rx·Rz), so each one
        // is read off the terrain gradient along that local axis. Sampled at the panel's own half-extents so
        // the fit is over the span that actually carries the rider, not an infinitesimal slope at the centre.
        const rad = yaw * Math.PI / 180;
        // Local +X and +Z after yaw, in world terms.
        const axisX: [number, number] = [Math.cos(rad), -Math.sin(rad)];
        const axisZ: [number, number] = [Math.sin(rad), Math.cos(rad)];
        const halfW = (GATE_WIDTH_M / 2) * (test.scale ?? 1);
        const halfD = ((test.padDepthM ?? 8) / 2) * (test.scale ?? 1);
        const rise = (axis: [number, number], half: number): number => {
          const hp = surfaceHeightAt(doc, x + axis[0] * half, z + axis[1] * half);
          const hm = surfaceHeightAt(doc, x - axis[0] * half, z - axis[1] * half);
          return hp === null || hm === null ? 0 : hp - hm;
        };
        // Positive local Z rising means the far edge is higher, which is a NEGATIVE pitch under Rx.
        prop.pitch = -Math.atan2(rise(axisZ, halfD), 2 * halfD) * 180 / Math.PI;
        prop.roll = Math.atan2(rise(axisX, halfW), 2 * halfW) * 180 / Math.PI;
      }
    }

    // Placed sound channels. Both hang off the instance rather than off its effect graph, so they are set
    // here on the finished prop whatever shape it took.
    if (test.ambient) {
      const clip = test.ambient.tone ? tones?.[test.ambient.tone] : undefined;
      if (test.ambient.tone) {
        if (clip) {
          prop.ambientSoundFile = clip.file;
          // The interactive class is engine-fixed to three ids, so a clip becomes hit-gated by the mountain
          // CLAIMING one of them for it [Trailmap: 420-audio-runtime]. Claimed in authoring order.
          if (test.ambient.hitGated && !hitGated.includes(clip.file)) hitGated.push(clip.file);
        }
      } else if (test.ambient.event !== undefined) prop.ambientSound = test.ambient.event;
      if (test.ambient.radiusM !== undefined) prop.ambientRadius = test.ambient.radiusM;
      audio.push({
        id: test.id, propId, propName, distanceM: distance,
        gated: !!test.ambient.hitGated, expect: test.ambient.expect, event: null,
        ...(clip ? { clip: clip.file, toneHz: clip.hz } : {}),
      });
      signals.push('sound');
    }
    if (test.collisionTone) {
      const clip = tones?.[test.collisionTone];
      if (clip) prop.collisionSoundFile = clip.file;
      // A one-shot gets a plan row too, even though the ride cannot grade it: the row is how the bank reader
      // learns which slot this cell is about, and "its slot comes out UNlooped" is the only claim the cell
      // was ever making.
      audio.push({
        id: test.id, propId, propName, distanceM: distance,
        gated: false, expect: 'one-shot', event: null,
        ...(clip ? { clip: clip.file, toneHz: clip.hz } : {}),
      });
      signals.push('sound');
    }

    props.push(prop);
    if (test.stageMessage) {
      // Name the specimen BEFORE the rider reaches it, from an independent pass-through trigger. Putting
      // Show Message in the specimen's own chain would make mode 0 and PlayerCollision-off silent — exactly
      // the two cases whose expected result is that the chain never dispatches. Twelve metres is roughly
      // half a second at course speed: enough to read the label, close enough that it still names the object
      // immediately ahead. The trigger is not a plan row and cannot affect the specimen's verdict.
      const stageDistance = distance - 12;
      const sx = a[0] + down[0] * stageDistance;
      const sz = a[2] + down[2] * stageDistance;
      const sground = surfaceHeightAt(doc, sx, sz)
        ?? a[1] + (b[1] - a[1]) * stageDistance / horizontal;
      const stageId = `${propId}:stage`;
      props.push({
        id: stageId, level: EFFECT_TRIGGER_LEVEL, model: 0, name: `${propName} stage message`,
        pos: [sx, sground + GATE_HEIGHT_M / 2, sz], yaw, scale: 1,
        effectTrigger: { size: [GATE_WIDTH_M, GATE_HEIGHT_M, 8] },
      });
      const stageGraph = addEffectTemplateToProp(effects, stageId, 'collision-trigger');
      addEffectNodeTemplate(effects, stageGraph, 'debounce');
      const selection = addEffectNodeTemplate(effects, stageGraph, 'show-message');
      const node = selection ? effectNode(effects, selection) : null;
      if (!node) throw new Error(`${test.id}: the stage Show message node could not be created.`);
      const payload = node.payload as Record<string, unknown>;
      payload.HudText = `${ordinal + 1}/${cases.length} ${test.stageMessage}`;
      [payload.HudRed, payload.HudGreen, payload.HudBlue] = test.color;
    }
    const graph = test.recipe === 'ride-over-button'
      ? addEffectTemplateToProp(effects, propId, 'ride-over-button')
      : addEffectTemplateToProp(effects, propId, 'collision-trigger');
    // A companion prop off the fall line, and the MainType-7 node that reaches it bound to a graph that
    // lives there. Shared by two callers now: a hop at the HEAD of a collision chain, and a hop in the
    // TRIGGER column — which is the shape retail's one counter-fired chain uses, and the only shape that is
    // safe there. A counter-fired column runs while the counter is mid-update retiring itself, so a payload
    // that installs a node on its OWN instance drops the counter from under it; measured as a reproducible
    // engine hang for both a DeadNode and a flipbook. A hop installs on somebody else and never touches it.
    const attachCompanion = (hopNode: ReturnType<typeof effectNode>, question: string): void => {
      if (!hopNode || !test.companion) return;
      // Off the fall line by half a corridor, so the rider passes the cell without ever reaching it.
      const offset = COMPANION_OFFSET_M;
      const cx = x - down[2] * offset, cz = z + down[0] * offset;
      const cground = surfaceHeightAt(doc, cx, cz) ?? ground;
      const companionId = `${propId}:target`;
      const companionName = `AT${ordinal}${test.id}TGT`;
      if (test.companionShape === 'clip') {
        // A model that actually carries keyframes. A hop that installs a CLIP has to land on one: on the
        // default flat panel a clip that plays and a clip that never starts are the same reading, which is
        // the trap the whole clip family walked around [cell `clip-flat-control`].
        props.push({
          id: companionId, level: IMPORTED_PROP_LEVEL, model: clipModel, name: companionName,
          pos: [cx, cground + 2, cz], yaw, scale: 1, nativeCollision: structuredClone(profile(1)),
        });
      } else if (test.companionShape === 'gem') {
        props.push({
          id: companionId, level: AUTO_TEST_TARGET, model: TRICK_GEM_MODEL, name: companionName,
          pos: [cx, cground + 2, cz], yaw, scale: 1, nativeCollision: structuredClone(profile(2)),
        });
      } else {
        const companionModel = models.length;
        models.push(panelModel(`model:${companionModel.toString().padStart(4, '0')}`, companionName,
          true, null, null));
        props.push({
          id: companionId, level: AUTHORED_MODEL_LEVEL, model: companionModel, name: companionName,
          pos: [cx, cground, cz], yaw, scale: 1, nativeCollision: structuredClone(profile(1)),
        });
      }
      // An UNATTACHED graph: nothing dispatches it by circumstance, and the hop is its only caller. The
      // repack compiler appends a graph on demand when a hop names it, so this reaches the ISO without an
      // attachment of its own.
      const companionGraph = nextEffectId(effects, 'graph');
      effects.graphs.push({ id: companionGraph, name: `${test.id} target`, nodes: [] });
      const companionSelection = addEffectNodeTemplate(effects,
        { ownerKind: 'graph', ownerId: companionGraph }, test.companion);
      const companionNode = companionSelection ? effectNode(effects, companionSelection) : null;
      if (companionNode && test.tuneCompanion) {
        test.tuneCompanion(companionNode.payload as Record<string, unknown>);
      }
      bindInstanceHop(effects, hopNode, companionId, companionGraph);
      entries.push({
        id: `${test.id}-target`, propId: companionId, propName: companionName, question,
        ...(test.companionShape === 'clip' ? { imported: true as const } : {}),
        instanceName: '', location: null, distanceM: distance,
        // Matches the collision profile each companion branch places: mode 2 for the retail gem, mode 1 for
        // the imported clip model and the default panel.
        mode: test.companionShape === 'gem' ? 2 : 1,
        signals: ['entity-node'], expect: test.companionExpect ?? test.expect ?? null,
        expectPaint: false, expectRider: null,
        expectSlot: null, demonstrated: test.demonstrated ?? null,
        // The companion is where the interesting thing happens on a hop that installs a property node, so
        // it takes the payload probe as well as the slot one.
        watches: [FLIP_NODE_WATCH, ...(test.companionWatch
          ? [{ label: test.companionWatch.label, base: 'liveNode' as const,
            offsets: [...test.companionWatch.offsets] }]
          : [])],
        contactOptional: true, coveredBy: test.id,
      });
    };
    // Where a MainType-24 node puts the rider. The same half-corridor offset the hop's companion uses, and
    // for a reason that reads the opposite way round: the companion is placed out there so the rider can
    // never reach it, and this one is placed out there so that arriving there cannot be anything else. A
    // rider under power covers ~1.7 m between samples, so 130 m of it in one frame has no other explanation.
    let teleportDestination: string | null = null;
    const attachTeleportTarget = (node: ReturnType<typeof effectNode>): void => {
      if (!node || (!test.teleportTarget && !test.teleportNext) || node.mainType !== 24) return;
      // One destination per cell, however many nodes aim at it: `bindRiderTeleport` shares the instance row
      // the way the native table does, and a second panel would be a second thing for the rider to land on.
      if (teleportDestination) { bindRiderTeleport(effects, node, teleportDestination); return; }
      const offset = COMPANION_OFFSET_M;
      // The ordinary proof target is deliberately unreachable beside the course. A collision relay is the
      // opposite: clear ground halfway to the next case, on the exact fall line, so a solid bag's correct
      // lateral deflection cannot turn every row below it into a miss. The collision cases put an explicit
      // one-second Wait in front of this node, leaving an untouched response trace before the move executes.
      // MainType 24 lands the rider exactly 3 m to the target's local side on this 45-degree heading. Put
      // the relay marker 3 m to the OTHER side of centre, so the runtime offset cancels and the rider starts
      // the next approach on the fall line rather than one small crash-bag width beside it.
      const tx = test.teleportNext
        ? a[0] + down[0] * (distance + spacing / 2) - side[0] * 3 : x - down[2] * offset;
      const tz = test.teleportNext
        ? a[2] + down[2] * (distance + spacing / 2) - side[2] * 3 : z + down[0] * offset;
      const tground = surfaceHeightAt(doc, tx, tz) ?? ground;
      const targetId = `${propId}:dest`;
      const targetName = `AT${ordinal}${test.id}DST`;
      const targetModel = models.length;
      models.push(panelModel(`model:${targetModel.toString().padStart(4, '0')}`, targetName, true, null, null));
      // Flat on the ground and chainless: the rider lands about 3 m off it and has to be able to ride away,
      // so the marker must not be something to hit.
      props.push({
        id: targetId, level: AUTHORED_MODEL_LEVEL, model: targetModel, name: targetName,
        pos: [tx, tground, tz], yaw, scale: 1, nativeCollision: structuredClone(profile(1)),
      });
      teleportDestination = targetId;
      bindRiderTeleport(effects, node, targetId);
    };
    // Ahead of everything else, including the recipes': a gate that rejects ends the chain, and a node that
    // seizes the slot decides what every node behind it is allowed to build.
    if (test.leadNode) {
      const selection = addEffectNodeTemplate(effects, graph, test.leadNode);
      const node = selection ? effectNode(effects, selection) : null;
      if (node && test.tuneLead) test.tuneLead(node.payload as Record<string, unknown>);
      attachTeleportTarget(node);
      attachCompanion(node,
        'THE HOP LANDS. This companion has no chain of its own and the rider never came within '
        + '116 m of it, yet its slot held the target graph\'s node — sub-type 2, the Debounce authored '
        + 'into that graph and nowhere else — in all three passes. It is the cell that answers the '
        + 'question: the gate beside it would report dispatch whether the hop resolved or not, and a hop '
        + 'with a bad index is a silent no-op the engine bounds-checks away.');
    }
    if (test.recipe === 'button-no-debounce') {
      // The shipped recipe's own two working nodes, laid down without the Debounce in front of them. The
      // flip's Length is what makes it a PULSE rather than a free-running cycle, and the template ships
      // Length 0 because its home is the persistent circumstance.
      const selection = addEffectNodeTemplate(effects, graph, 'texture-flip');
      const flip = selection ? effectNode(effects, selection) : null;
      const payload = (flip?.payload as { type0?: { TextureFlip?: { Length: number } } } | undefined)?.type0;
      if (payload?.TextureFlip) payload.TextureFlip.Length = 0.5;
      addEffectNodeTemplate(effects, graph, 'material-texture-frame');
    }
    // Every chain leads with a 3 s debounce, which is what makes this fixture READABLE rather than merely
    // correct. The harness detects dispatch through the live-node observation, which is filled by the
    // constructed node and cleared by its destructor — so an undebounced chain that builds and completes
    // inside a frame or two is invisible to any host-side sampler and reports as "never dispatched". The
    // debounce IS the thread's wait timer [Trailmap: 150-logic], so it holds the evidence still for three
    // seconds. It is also what every retail collision header carries, so this is the shipped shape, not a
    // measurement artefact bolted on: `ride-over-button` already opens with its own and is left alone, and
    // `button-no-debounce` exists precisely to go without one.
    if (!test.recipe) addEffectNodeTemplate(effects, graph, 'debounce');
    addCollisionMarkerNode(effects, graph, test.id, test.color);
    // BEHIND the debounce on purpose. Ahead of it the banner would re-post every frame of contact and say
    // nothing about what the pass recorded; behind it, one banner is one dispatch — the same event the
    // verdict counts. A recipe brings its own debounce, so this sits behind that one too.
    if (opts.hudText) {
      const selection = addEffectNodeTemplate(effects, graph, 'show-message');
      const node = selection ? effectNode(effects, selection) : null;
      if (!node) throw new Error(`${test.id}: the Show message node could not be created.`);
      const payload = node.payload as Record<string, unknown>;
      payload.HudText = test.id;
      // The cell's OWN colour, the one its particle burst already uses. Two readings of the same
      // contact then agree in colour as well as in time, so a burst with no banner beside it — or a
      // banner in the wrong colour — is visible without reading either.
      [payload.HudRed, payload.HudGreen, payload.HudBlue] = test.color;
    }
    if (test.recipe === 'ride-over-button') signals.push('texture-flip');
    if (test.extraNode) {
      const selection = addEffectNodeTemplate(effects, graph, test.extraNode);
      const node = selection ? effectNode(effects, selection) : null;
      if (node && test.tuneExtra) test.tuneExtra(node.payload as Record<string, unknown>, ground);
      if (node && test.extraNode === 'sound') {
        if (opts.soundFile) setEffectNodeSoundFile(node, opts.soundFile);
        signals.push('sound');
      }
    }
    (test.tailNodes ?? []).forEach((tail, index) => {
      const selection = addEffectNodeTemplate(effects, graph, tail);
      const node = selection ? effectNode(effects, selection) : null;
      if (node && test.tuneTail) test.tuneTail(node.payload as Record<string, unknown>, tail, index);
      // A teleport can sit behind a gate rather than leading, which is the only way to put a CONDITION in
      // front of the move — and a condition is what decides which riders it applies to.
      attachTeleportTarget(node);
    });
    if (test.functionNodes?.length) {
      // The call node makes its own body on the way in, exactly as it does for an author in the editor, so
      // the fixture exercises the same binding the picker uses rather than a fixture-only shortcut.
      const callSelection = addEffectNodeTemplate(effects, graph, 'call-function');
      const functionId = callSelection ? bindEffectFunctionCall(effects, callSelection) : null;
      if (!functionId) throw new Error(`${test.id}: the call node could not be given a function body.`);
      const called = effects.functions.find(item => item.id === functionId);
      if (called) called.name = `${test.id} body`.slice(0, 15);
      for (const id of test.functionNodes) {
        const added = addEffectNodeTemplate(effects, { ownerKind: 'function', ownerId: functionId }, id);
        const placed = added ? effectNode(effects, added) : null;
        if (placed?.mainType === 7) attachCompanion(placed,
          'THE CALLED BODY RAN. This companion carries no chain, the rider never approached it, and the only '
          + 'thing naming it is a MainType-7 node inside a shared FUNCTION — a table the cell\'s own collision '
          + 'chain reaches solely through the MainType-21 call beside the marker. A node on this slot '
          + 'therefore means the call resolved its index, the engine spun up a thread on the function, and '
          + 'that thread ran the body. The catalogue\'s `hop-remote-target` is the control — the same hop '
          + 'reached directly from a chain — so a sweep where that lands and this does not indicts the call '
          + 'rather than the hop.');
      }
    }
    if (test.persistentNode) {
      // `addEffectTemplateToProp` files a template under ITS OWN circumstance, so this only lands in the
      // persistent column for a template that declares one. A collision template routed through here would
      // silently append to the chain above instead — the same nodes, none of the question — so it is refused
      // rather than quietly answered.
      const template = EFFECT_TEMPLATES.find(item => item.id === test.persistentNode);
      if (template?.circumstance !== 'persistent') {
        throw new Error(`${test.id}: persistentNode wants a persistent template, and `
          + `${test.persistentNode} is ${template?.circumstance ?? 'unknown'}.`);
      }
      const selection = addEffectTemplateToProp(effects, propId, test.persistentNode);
      const placed = selection ? effectNode(effects, selection) : null;
      if (placed && test.tunePersistent) test.tunePersistent(placed.payload as Record<string, unknown>);
      // Appended to the graph the template above created, in order, so a persistent chain reads the way a
      // collision one does. `addEffectNodeTemplate` takes the OWNER rather than the prop, which is what
      // keeps them in one graph — routing these through `addEffectTemplateToProp` would file each under its
      // own circumstance and quietly build a second graph nothing runs in sequence.
      for (const tail of test.persistentTailNodes ?? [])
        addEffectNodeTemplate(effects, { ownerKind: selection.ownerKind, ownerId: selection.ownerId }, tail);
      // A spline mover is the one persistent template that is inert until it names a ROUTE, and a -1 index
      // leaves the prop static with nothing anywhere to say so [Trailmap: 230-level-ssf §splinemover]. The
      // fixture lays down exactly one motion path, below, and every mover cell rides it.
      if (test.persistentNode === 'spline-animation') {
        motionPathAt = distance;
        splineBindings.push(selection);
      }
    }
    // LAST, once every circumstance this cell wants has been filed on the slot: the trigger column and the
    // latches are read off the slot the attachment resolved to, and until the chains above exist there is
    // no attachment.
    if (test.triggerNodes?.length || test.latches?.length) {
      const attachment = effectAttachments(effects).find(item => item.target.id === propId);
      const slot = attachment ? effects.slots.find(item => item.id === attachment.slot) : undefined;
      if (!slot) throw new Error(`${test.id}: an extra column wants a slot, and this cell has no attachment.`);
      if (test.triggerNodes?.length) {
        const triggerId = slot.circumstances.trigger ?? nextEffectId(effects, 'graph');
        if (!slot.circumstances.trigger) {
          effects.graphs.push({ id: triggerId, name: `${test.id} trigger`, nodes: [] });
          slot.circumstances.trigger = triggerId;
        }
        for (const node of test.triggerNodes) {
          const added = addEffectNodeTemplate(effects, { ownerKind: 'graph', ownerId: triggerId }, node);
          const placed = added ? effectNode(effects, added) : null;
          // A hop in this column is the one payload retail's own counter-fired chain uses, and the reason is
          // now measured: it installs on SOMEBODY ELSE. Anything that seizes this instance's slot drops the
          // counter that is at that moment inside its own update running this chain.
          if (placed?.mainType === 7) attachCompanion(placed,
            'THE COUNTER-FIRED TRIGGER COLUMN RAN. This companion carries no chain, the rider never '
            + 'approached it, and the only thing naming it is a MainType-7 node in the trigger column of the '
            + 'cell beside it — a column nothing outside the effects runtime can reach. A node on this slot '
            + 'therefore means the counter counted down, fired column 5, and the hop landed. It is also the '
            + 'only payload that is SAFE there: a flipbook and a breakable kill each hung the engine within '
            + 'a second, because both install on the counter\'s own instance while it is mid-update.');
        }
      }
      for (const circumstance of test.latches ?? []) {
        const latchId = nextEffectId(effects, 'graph');
        effects.graphs.push({
          id: latchId, name: `${test.id} ${effectCircumstanceLabel(circumstance)} latch`, nodes: [],
        });
        slot.circumstances[circumstance] = latchId;
      }
    }

    entries.push({
      id: test.id, question: test.question, propId, propName,
      ...(test.shape === 'clip' ? { imported: true as const } : {}),
      instanceName: '', location: null,
      distanceM: distance, mode: test.profile.mode, signals,
      expect: test.expect ?? null, expectPaint: !!test.expectPaint,
      expectRider: test.expectRider ?? null,
      expectSlot: test.expectSlot ?? null,
      ...(test.contactOptional ? { contactOptional: true } : {}),
      demonstrated: test.demonstrated ?? null,
      // Every cell reads the flip node's state, not just the flipbook ones: on a cell with no flip in its
      // chain these words describe whatever node the contact DID build, which is how the "which node owns
      // the slot" question gets answered for the whole matrix in one pass rather than one cell at a time.
      watches: [
        FLIP_NODE_WATCH,
        ...(test.nodeWatch ? [{ label: test.nodeWatch.label, base: 'liveNode' as const,
          offsets: [...test.nodeWatch.offsets] }] : []),
        ...(test.watchEntityFlags ? [ENTITY_FLAGS_WATCH] : []),
        ...(test.watchEntityPos ? [ENTITY_POS_WATCH] : []),
        ...(test.watchLiveNode ? [LIVE_NODE_WATCH] : []),
        ...(test.watchLowMemory ? [PAD_LOW_MEMORY_WATCH] : []),
      ],
      ...(test.lateWatch ? { lateWatch: {
        label: test.lateWatch.label, backPointer: test.lateWatch.backPointer,
        offsets: [...test.lateWatch.offsets],
        ...(test.lateWatch.seconds === undefined ? {} : { seconds: test.lateWatch.seconds }),
      } } : {}),
    });
  });

  // One motion path, laid across the corridor at the mover cell's own field so the route is somewhere the
  // rider can see rather than off in the void. Motion paths export as native spline data and nothing else —
  // no tube, no posts, no collision — so this adds a route to the level and not a single visible polygon.
  if (motionPathAt !== null) {
    const px = a[0] + down[0] * motionPathAt, pz = a[2] + down[2] * motionPathAt;
    const across: V3 = [-down[2], 0, down[0]];
    const path: Rail = {
      kind: 'motion', id: 'path:0000', name: 'AutoTest mover route', height: 0,
      nodes: [-1, -0.34, 0.34, 1].map(t => {
        const nx = px + across[0] * t * 60 + down[0] * t * 20;
        const nz = pz + across[2] * t * 60 + down[2] * t * 20;
        const fallback = a[1] + (b[1] - a[1]) * motionPathAt! / horizontal;
        return [nx, (surfaceHeightAt(doc, nx, nz) ?? fallback) + 6, nz] as V3;
      }),
    };
    doc.rails = [path];
    syncAuthoredMotionPathEffectResources(effects, doc.rails);
    for (const binding of splineBindings) bindEffectSplineToMotionPath(effects, binding, doc.rails, path.id);
  }

  doc.models = models;
  doc.props = props;
  doc.effects = effects;
  if (hitGated.length) doc.hitGatedSounds = hitGated;
  return { doc, plan: { name, target: AUTO_TEST_TARGET, runLengthM: runLength,
    ...(opts.windowFrames === undefined ? {} : { windowFrames: opts.windowFrames }),
    ...(opts.hudText || cases.some(test => !!test.stageMessage) ? { hudText: true as const } : {}), mode, entries,
    ...(stripSpans.length ? { strips: stripSpans } : {}),
    ...(audio.length ? { audio } : {}) } };
}
