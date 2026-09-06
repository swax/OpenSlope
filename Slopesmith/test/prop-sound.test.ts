// tier: fast

/**
 * What a prop sounds when it is hit.
 *
 * `prop-sound` owns both of the placement's audio channels — the `Sounds.CollisonSound` one-shot and the
 * `Sounds.ExternalSounds` ambience — precisely because ONE contact drives both, in an order that matters.
 * Retail registers a hit-gated emitter before it resolves the prop's own collision event to a clip, so a
 * prop whose collision row is the silent sentinel still starts its ambience on a hit that makes no other
 * sound [Trailmap: 420-interactive-gate]. Merquer's 22 fire hydrants are all exactly that case, so getting
 * the order backwards leaves every one of them dry while nothing else looks wrong.
 *
 * These checks stand in for the ride: `contact` is called the way `reference-effects` calls it, and the
 * one-shots are observed through the hooks rather than through an audio context.
 *
 * Run: tsx test/prop-sound.test.ts
 */
import { registerCollisionSoundIndex } from '../src/core/effects/collision-sound';
import {
  authoredOwnerKey, createPropSoundLayer, referenceOwnerKey, referencePropSoundSources, type PropSoundSource,
} from '../src/app/viewport/scene/prop-sound';
import { check, checkNear, failures } from './check';

// Merquer's real routing: 11 is the car/police body impact, 31 the hydrant lid, and 0 is authored-silent —
// absent from the index entirely, which is what every hydrant BASE carries.
registerCollisionSoundIndex({
  Schema: 'openslope-sound-index/v1',
  Level: 'MERQUER',
  Banks: { '2': 'merqurycity1', '3': 'Crowd' },
  CollisionEvents: {
    11: { Group: 2, Slot: 33, Bank: 'merqurycity1', Clip: 'Audio/SFX/merqurycity1/033.wav' },
    31: { Group: 2, Slot: 16, Bank: 'merqurycity1', Clip: 'Audio/SFX/merqurycity1/016.wav' },
  },
});

interface Shot { kind: 'bank' | 'file'; id: string; volume: number }

function layer() {
  const shots: Shot[] = [];
  const vector = { x: 0, y: 0, z: 0 } as never;
  const propSound = createPropSoundLayer({
    playOneShot: (buffer, _position, volume) => {
      void buffer.then(tag => shots.push({ ...(tag as unknown as Shot), volume }));
    },
    // The buffer promises are never decoded here; each carries the identity of what was asked for.
    bankBuffer: (level, slot, bank) =>
      Promise.resolve({ kind: 'bank', id: `${level}/${bank}/${slot}` } as unknown as AudioBuffer),
    fileBuffer: file => Promise.resolve({ kind: 'file', id: file } as unknown as AudioBuffer),
    riderSpeed: () => 0,
    ambient: {
      listener: null as never, root: null as never,
      rawToWorld: () => vector, worldToRaw: () => [0, 0, 0], editorToRaw: () => [0, 0, 0],
      loadBuffer: () => Promise.resolve(null),
    },
  });
  return { propSound, shots, position: vector };
}

const hydrant: PropSoundSource = { key: 'hydrant', level: 'MERQUER', event: 0, contact: 'through' };
const police: PropSoundSource = { key: 'police', level: 'MERQUER', event: 11, contact: 'solid' };

// Reference impact rows are owned by the prop payload that also supplies sourceIndex to the collider. They must
// not depend on the separately loaded Effects payload, and must retain the native movable/solid/through class.
{
  const sources = referencePropSoundSources('MERQUER', [
    { sourceIndex: 9, collisionSound: 11, contact: 'solid' },
    { sourceIndex: 10, collisionSound: 31, contact: 'movable' },
    { sourceIndex: 11, collisionSound: 11, contact: 'through' },
    { sourceIndex: 12, collisionSound: -1, contact: 'ghost' },
  ]);
  check(sources.size === 3 && sources.get(9)?.key === 'reference:9'
    && sources.get(9)?.level === 'MERQUER' && sources.get(9)?.event === 11,
  'the collider-owning prop payload builds the impact registry by sourceIndex');
  check(sources.get(10)?.contact === 'movable' && sources.get(11)?.contact === 'through'
    && !sources.has(12), 'the registry preserves contact curves and drops missing sound rows');
}

// A source registry can outlive a dev hot-reload that introduces a new discriminator. The exact legacy shape
// from before contact curves existed must remain playable instead of throwing while the ride tick is running.
{
  const legacy = layer();
  legacy.propSound.setReferenceSources(new Map([[9,
    { key: 'legacy-police', level: 'MERQUER', event: 11 } as PropSoundSource,
  ]]));
  legacy.propSound.contact({ kind: 'reference', index: 9 }, legacy.position, 9, 1);
  await Promise.resolve();
  checkNear(legacy.shots[0].volume, 0.5, 'a legacy source without contact metadata safely uses the solid curve');
}

// ---- the ordering that hydrants depend on ----

{
  const { propSound, shots, position } = layer();
  propSound.setReferenceSources(new Map([[5, hydrant], [9, police]]));

  propSound.contact({ kind: 'reference', index: 5 }, position, 20, 1);
  await Promise.resolve();
  check(propSound.isArmed(referenceOwnerKey(5)), 'a hydrant hit arms its ambience even though its collision row is silent');
  check(shots.length === 0, '…and plays no one-shot at all, because event 0 resolves to nothing');

  propSound.contact({ kind: 'reference', index: 9 }, position, 20, 1);
  await Promise.resolve();
  check(propSound.isArmed(referenceOwnerKey(9)), 'a police car hit arms its siren');
  check(shots.length === 1 && shots[0].id === 'MERQUER/course/33',
    '…and also plays its ordinary body one-shot from the course bank');
}

// Arming is per instance, or one hit would start the whole street.
{
  const { propSound, position } = layer();
  propSound.setReferenceSources(new Map([[5, hydrant], [6, hydrant]]));
  propSound.contact({ kind: 'reference', index: 5 }, position, 20, 1);
  check(propSound.isArmed(referenceOwnerKey(5)) && !propSound.isArmed(referenceOwnerKey(6)), 'hitting one hydrant leaves its neighbour unarmed');
}

// A prop with NO collision row at all still arms: the registry lookup must not gate the arming.
{
  const { propSound, shots, position } = layer();
  propSound.setReferenceSources(new Map());
  propSound.contact({ kind: 'reference', index: 5 }, position, 20, 1);
  await Promise.resolve();
  check(propSound.isArmed(referenceOwnerKey(5)), 'a prop absent from the collision registry still arms its ambience');
  check(shots.length === 0, '…and sounds nothing');
}

// ---- the debounce gates the one-shot, never the arming ----

{
  const { propSound, shots, position } = layer();
  propSound.setReferenceSources(new Map([[9, police]]));
  propSound.contact({ kind: 'reference', index: 9 }, position, 20, 1);
  propSound.contact({ kind: 'reference', index: 9 }, position, 20, 1.1);
  await Promise.resolve();
  check(shots.length === 1, 'a second contact inside the debounce window does not retrigger the one-shot');
  propSound.contact({ kind: 'reference', index: 9 }, position, 20, 1 + 50 / 60 + 0.01);
  await Promise.resolve();
  check(shots.length === 2, '…and does once the 50-frame window has passed');
}

// The very first contact must never be swallowed — that is the one that arms a hydrant for the whole run.
{
  const { propSound, position } = layer();
  propSound.setReferenceSources(new Map([[5, hydrant]]));
  propSound.contact({ kind: 'reference', index: 5 }, position, 20, 0);
  check(propSound.isArmed(referenceOwnerKey(5)), 'arming lands on the first contact, at elapsed 0');
}

// ---- authored props: same shape, uploaded clip wins ----

{
  const { propSound, shots, position } = layer();
  propSound.setAuthoredSources(new Map([
    ['a', { key: 'a', level: 'MERQUER', event: 11, contact: 'solid' }],
    ['b', { key: 'b', level: 'MERQUER', event: 11, contact: 'solid', file: 'thud.wav' }],
  ]));
  propSound.contact({ kind: 'authored', id: 'a' }, position, 20, 1);
  propSound.contact({ kind: 'authored', id: 'b' }, position, 20, 1);
  await Promise.resolve();
  check(shots.some(s => s.id === 'MERQUER/course/33'), 'an authored prop plays its bank slot');
  check(shots.some(s => s.kind === 'file' && s.id === 'thud.wav'),
    '…and an uploaded clip takes precedence over the event id');
  // An authored placement carrying a gated event is hit-gated in retail exactly as a reference one is, so a
  // contact has to arm it here too — this is the half that used to be reference-only.
  check(propSound.isArmed(authoredOwnerKey('a')), 'an authored prop arms its own hit-gated ambience');
}

// The two id spaces must not collide: reference instance 7 and authored prop "7" are different props.
{
  const { propSound, position } = layer();
  propSound.contact({ kind: 'reference', index: 7 }, position, 20, 1);
  check(propSound.isArmed(referenceOwnerKey(7)) && !propSound.isArmed(authoredOwnerKey('7')),
    'a reference hit does not arm the authored prop that shares its number');
}

// ---- Unity-parity speed gates and volume ramps; playback pitch remains untouched ----

{
  const { propSound, shots, position } = layer();
  propSound.setReferenceSources(new Map([[9, police]]));
  propSound.contact({ kind: 'reference', index: 9 }, position, 9, 1);
  await Promise.resolve();
  checkNear(shots[0].volume, 0.5, 'a 9 m/s solid hit is halfway through Unity’s 2–16 m/s ramp');

  const full = layer();
  full.propSound.setReferenceSources(new Map([[9, police]]));
  full.propSound.contact({ kind: 'reference', index: 9 }, full.position, 16, 1);
  await Promise.resolve();
  checkNear(full.shots[0].volume, 1, 'a 16 m/s solid hit reaches full volume');

  const slow = layer();
  slow.propSound.setReferenceSources(new Map([[9, police]]));
  slow.propSound.contact({ kind: 'reference', index: 9 }, slow.position, 1.99, 1);
  await Promise.resolve();
  check(slow.shots.length === 0, 'a solid graze below 2 m/s is silent');
  slow.propSound.contact({ kind: 'reference', index: 9 }, slow.position, 16, 1.01);
  await Promise.resolve();
  checkNear(slow.shots[0].volume, 1, 'a sub-threshold graze does not consume the sound debounce');
}

{
  const through: PropSoundSource = { key: 'trigger', level: 'MERQUER', event: 11, contact: 'through' };
  const quiet = layer();
  quiet.propSound.setReferenceSources(new Map([[9, through]]));
  quiet.propSound.contact({ kind: 'reference', index: 9 }, quiet.position, 0.49, 1);
  await Promise.resolve();
  check(quiet.shots.length === 0, 'a ride-through contact below 0.5 m/s is silent');
  quiet.propSound.contact({ kind: 'reference', index: 9 }, quiet.position, 0.5, 1.01);
  await Promise.resolve();
  checkNear(quiet.shots[0].volume, 0.35, 'the ride-through threshold opens at Unity’s 35% floor');

  const full = layer();
  full.propSound.setReferenceSources(new Map([[9, through]]));
  full.propSound.contact({ kind: 'reference', index: 9 }, full.position, 12, 1);
  await Promise.resolve();
  checkNear(full.shots[0].volume, 1, 'a 12 m/s ride-through contact reaches full volume');
}

{
  const movable: PropSoundSource = { key: 'bag', level: 'MERQUER', event: 11, contact: 'movable' };
  const hit = layer();
  hit.propSound.setReferenceSources(new Map([[9, movable]]));
  hit.propSound.contact({ kind: 'reference', index: 9 }, hit.position, 9, 1);
  await Promise.resolve();
  checkNear(hit.shots[0].volume, 0.7, 'a 9 m/s movable-prop hit is halfway from its 40% floor to full');
}

// ---- a run boundary forgets everything ----

{
  const { propSound, shots, position } = layer();
  propSound.setReferenceSources(new Map([[9, police]]));
  propSound.contact({ kind: 'reference', index: 9 }, position, 20, 1);
  await Promise.resolve();
  propSound.resetRun();
  check(!propSound.isArmed(referenceOwnerKey(9)), 'leaving Test disarms what the last run armed');
  // The debounce went with it, so the next run's first contact is heard immediately rather than swallowed
  // by a stale deadline carried over from the previous run's clock.
  propSound.contact({ kind: 'reference', index: 9 }, position, 20, 1);
  await Promise.resolve();
  check(shots.length === 2, '…and the debounce too, so the next run sounds its first contact');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
