// tier: fast

/**
 * Where a placed emitter's voice is SEATED, as opposed to how loud it is.
 *
 * The ambient layer measures the field in raw native centimetres and seats the voice in world space, which
 * means every authored emitter crosses a frame boundary twice: once into raw for the gain, once out to world
 * for the pan. Those two conversions were reading DIFFERENT centres — the gain took the converted placement,
 * the pan took the caller's original — so an authored prop's ambience was audible at the right volume and
 * panned from `rawToWorld(editor metres)`: a hundredfold scale error routed through the reference root
 * instead of the world one, which also folded in the comparison offset.
 *
 * That shape is why this file exists rather than an assertion inside `external-sound.test.ts`. Nothing in the
 * core field maths was wrong, and every check on it passed throughout; the defect lived entirely in which of
 * two centres the runtime handed to which hook, and it was inaudible as anything but "the bed comes from over
 * there somewhere".
 *
 * The layer is driven through its hooks alone. `loadBuffer` returning null means no `THREE.PositionalAudio`
 * is ever constructed, so this needs no audio context — and `rawToWorld` is called for every audible emitter
 * before a voice is started, which is exactly the value under test.
 *
 * Run: tsx test/ambient-sound.test.ts
 */
import * as THREE from 'three';
import { createAmbientSoundLayer, type AmbientSoundSource } from '../src/app/viewport/scene/ambient-sound';
import type { ExternalSoundEmitter } from '../src/core/effects/external-sound';
import { check, failures } from './check';

/**
 * Enough Web Audio for `THREE.PositionalAudio` to be built, played and stopped under Node.
 *
 * The seating checks below need none of this — they read the hook arguments — but the RETARGET checks do:
 * "the old clip stops when the record changes" is a claim about a voice that exists, and there is no way to
 * observe it without one. It is a stub rather than a real context on purpose: nothing here is asserting what
 * anything sounds like, only which buffer the layer decided to hold.
 */
function fakeAudio(): { listener: THREE.AudioListener; context: AudioContext } {
  const param = () => ({
    value: 1, setTargetAtTime() {}, linearRampToValueAtTime() {}, setValueAtTime() {},
    cancelScheduledValues() {}, exponentialRampToValueAtTime() {},
  });
  const node = (): Record<string, unknown> => ({
    connect: () => node(), disconnect() {}, gain: param(), playbackRate: param(),
    detune: param(), positionX: param(), positionY: param(), positionZ: param(),
    setPosition() {}, setOrientation() {},
    panningModel: 'HRTF', distanceModel: 'linear', refDistance: 1, maxDistance: 10_000,
    rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 0, coneOuterGain: 0,
  });
  const context = {
    currentTime: 0, state: 'running', sampleRate: 48_000, destination: node(),
    createGain: () => node(), createPanner: () => node(),
    createBufferSource: () => ({ ...node(), buffer: null, loop: false, loopStart: 0, loopEnd: 0,
      onended: null, start() {}, stop() {} }),
  } as unknown as AudioContext;
  return { listener: { context, getInput: () => node() } as unknown as THREE.AudioListener, context };
}

/** A decoded buffer standing in for one clip. Identity is all that is read. */
const buffer = (tag: string): AudioBuffer =>
  ({ duration: 1, sampleRate: 48_000, length: 48_000, numberOfChannels: 1, tag } as unknown as AudioBuffer);

/** A type-0 point emitter: `params` is [radius, curve]. Event 105 is an ordinary proximity id, not a gated
 *  one, so it sounds on range alone. */
const point = (radius: number): ExternalSoundEmitter =>
  ({ type: 0, sound: 105, offset: [0, 0, 0], params: [radius, 2] });

/**
 * The two frames, standing in for the viewport's. Raw is centimetres; editor is metres under a root that
 * carries an offset the reference root does not — the arrangement that made the bug visible on the ride but
 * not in the gain.
 */
const CM_PER_M = 100;
const EDITOR_ROOT_OFFSET_CM = 7_000;

function layer() {
  const seatedAt: [number, number, number][] = [];
  const ambient = createAmbientSoundLayer({
    listener: null as never,
    root: null as never,
    rawToWorld: raw => {
      seatedAt.push([raw[0], raw[1], raw[2]]);
      return new THREE.Vector3(raw[0] / CM_PER_M, raw[1] / CM_PER_M, raw[2] / CM_PER_M);
    },
    worldToRaw: world => [world.x * CM_PER_M, world.y * CM_PER_M, world.z * CM_PER_M],
    editorToRaw: editor =>
      [editor[0] * CM_PER_M + EDITOR_ROOT_OFFSET_CM, editor[1] * CM_PER_M, editor[2] * CM_PER_M],
    // No buffer means no voice object, which is what keeps this free of an audio context. The seating
    // happens before the load either way.
    loadBuffer: () => Promise.resolve(null),
  });
  ambient.setEnabled(true);
  return { ambient, seatedAt };
}

const authored = (center: [number, number, number]): AmbientSoundSource =>
  ({ key: 'authored', emitter: point(3_200), center, space: 'editor', owner: 'prop-1' });

// ---- an authored emitter is seated from its CONVERTED centre ----

{
  const { ambient, seatedAt } = layer();
  // 12 m along X in editor metres -> 1200 cm plus the root offset = 8200 cm raw, which is 82 m of world.
  ambient.setSources('DONOR', [authored([12, 0, 0])]);
  // Stand beside where the emitter REALLY is. A listener at world 12.1 — beside where the unconverted
  // centre would put it — is 70 m from the true one and hears nothing, which is the ride symptom.
  ambient.step(1, new THREE.Vector3(82.1, 0, 0));

  check(seatedAt.length === 1, `the emitter is audible and was seated once (seated ${seatedAt.length})`);
  check(seatedAt[0]?.[0] === 12 * CM_PER_M + EDITOR_ROOT_OFFSET_CM,
    `seated from the raw centre, not the editor one (got ${seatedAt[0]?.[0]}, want ${12 * CM_PER_M + EDITOR_ROOT_OFFSET_CM})`);
  // The precise failure this pins: 12 would be the editor metres handed straight to `rawToWorld`.
  check(seatedAt[0]?.[0] !== 12, 'the editor-space centre never reaches rawToWorld');
}

// ---- a reference emitter is already raw and must NOT be converted again ----

{
  const { ambient, seatedAt } = layer();
  const reference: AmbientSoundSource = {
    key: 'reference', emitter: point(3_200), center: [1_200, 0, 0], owner: 'ref-9',
  };
  ambient.setSources('DONOR', [reference]);
  ambient.step(1, new THREE.Vector3(12.1, 0, 0));

  check(seatedAt[0]?.[0] === 1_200,
    `a raw centre passes through untouched (got ${seatedAt[0]?.[0]}, want 1200)`);
}

// ---- gain and seating read the SAME centre, which is the invariant that broke ----

{
  const { ambient, seatedAt } = layer();
  // Far enough that the emitter is only in range if BOTH sides agree the centre is the converted one: the
  // listener sits beside the raw centre, which the unconverted editor centre is 70 m away from.
  ambient.setSources('DONOR', [authored([12, 0, 0])]);
  ambient.step(1, new THREE.Vector3((12 * CM_PER_M + EDITOR_ROOT_OFFSET_CM) / CM_PER_M, 0, 0));

  const heard = ambient.active();
  check(heard.length === 0, 'no voice is reported without a decoded buffer, however loud the field is');
  check(seatedAt.length === 1,
    'the emitter the gain found is the emitter that got seated — one centre, one owner');
}

// ---- retargeting a playing emitter drops the clip it was playing ----

/** A layer that can actually seat voices, plus the log of what it asked to decode. */
function soundingLayer(load: (url: string) => Promise<AudioBuffer | null>) {
  const asked: string[] = [];
  const { listener } = fakeAudio();
  const ambient = createAmbientSoundLayer({
    listener,
    root: new THREE.Object3D(),
    rawToWorld: raw => new THREE.Vector3(raw[0] / CM_PER_M, raw[1] / CM_PER_M, raw[2] / CM_PER_M),
    worldToRaw: world => [world.x * CM_PER_M, world.y * CM_PER_M, world.z * CM_PER_M],
    editorToRaw: editor =>
      [editor[0] * CM_PER_M + EDITOR_ROOT_OFFSET_CM, editor[1] * CM_PER_M, editor[2] * CM_PER_M],
    loadBuffer: url => { asked.push(url); return load(url); },
  });
  ambient.setEnabled(true);
  return { ambient, asked };
}

/** One authored emitter playing an uploaded WAV — the case an author retargets in the editor. */
const withFile = (file: string): AmbientSoundSource =>
  ({ ...authored([12, 0, 0]), file });

const AT_THE_EMITTER = new THREE.Vector3((12 * CM_PER_M + EDITOR_ROOT_OFFSET_CM) / CM_PER_M, 0, 0);
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

async function retargetChecks(): Promise<void> {
  {
    const { ambient, asked } = soundingLayer(url => Promise.resolve(buffer(url)));
    ambient.setSources('DONOR', [withFile('siren.wav')]);
    ambient.step(1, AT_THE_EMITTER);
    await flush();
    check(ambient.active().length === 1, 'a voice starts once its buffer decodes');

    // The author points the same record at a different upload. The KEY is unchanged — it is the same prop
    // and the same record — so key-only bookkeeping kept the siren playing.
    ambient.setSources('DONOR', [withFile('birds.wav')]);
    check(ambient.active().length === 0, 'retargeting the clip stops the voice that was playing the old one');

    ambient.step(1, AT_THE_EMITTER);
    await flush();
    check(asked.some(url => url.includes('birds.wav')), 'the new clip is then requested');
    check(ambient.active().length === 1, 'and the emitter is sounding again, on the clip that is authored now');
  }

  {
    // The same change, made while the first decode is still in flight: the buffer that arrives is already
    // stale and must be dropped rather than seated.
    let release: (buffer: AudioBuffer) => void = () => {};
    const pending = new Promise<AudioBuffer | null>(resolve => { release = resolve; });
    let first = true;
    const { ambient } = soundingLayer(url => {
      if (first) { first = false; return pending; }
      return Promise.resolve(buffer(url));
    });

    ambient.setSources('DONOR', [withFile('siren.wav')]);
    ambient.step(1, AT_THE_EMITTER);
    ambient.setSources('DONOR', [withFile('birds.wav')]);
    release(buffer('siren.wav'));
    await flush();

    check(ambient.active().length === 0, 'a buffer that arrives after its record was retargeted is dropped');
  }
}

void retargetChecks().then(() => {
  console.log(failures ? `\n${failures} failure(s)` : '\nall ok');
  process.exit(failures ? 1 : 0);
});
