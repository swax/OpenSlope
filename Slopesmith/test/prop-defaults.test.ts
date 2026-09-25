// tier: fast

// Prop defaults (docs/069), checked without a browser:
//  - a shipped level's model derives its defaults from the behaviour its visible placements most often carry,
//    ignoring hidden records, junk/reset twins and the per-instance donor id, and says how representative it is;
//  - one instance maps onto placement fields exactly: contact, surface, showoff layer, hit sound (event 0 is
//    retail's "silent"), full-bright (no keys + ambient 256);
//  - resolution: the author's saved defaults, else a derived reference behaviour, else the standard start —
//    solid borrowed art, decorative own art — always with a complete collision profile;
//  - untrusted records are sanitized field by field, and behaviours copy and compare structurally.
import assert from 'node:assert/strict';
import type { PlacedProp, PropBehaviour } from '../src/core/doc/types';
import type { LevelProps, PropInstance, PropModel } from '../src/core/reference/props';
import {
  applyBehaviour, behaviourOf, instanceBehaviour, referencePropDefaults, resolvePropDefaults,
  sameBehaviour, sanitizePropBehaviour,
} from '../src/core/props/defaults';
import { defaultPlacedPropCollision } from '../src/core/props/contact';
import { PROP_FULL_BRIGHT_RECORD } from '../src/core/lighting/prop-lights';
import { IMPORTED_PROP_LEVEL } from '../src/core/props/imported';
import { AUTHORED_MODEL_LEVEL } from '../src/core/doc/models';

let next = 0;
/** A retail instance: a solid, silent, unlit-default obstacle unless told otherwise. */
function inst(model: number, over: Partial<PropInstance> = {}): PropInstance {
  const i = next++;
  return {
    sourceIndex: i, ltgState: 0, model, loc: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], name: `inst ${i}`,
    visible: true, playerCollision: true, playerBounce: true, collisionSound: -1, contact: 'solid', bounce: 0.5,
    surface: -1, shape: 1, responseMass: 1e30, dynamicMass: -1, physicsBody: -1, externalSounds: [],
    ...over,
  };
}
const model = (id: number, name: string): PropModel => ({ id, name, subs: [] });
/** Tree canopy: ride-through (U0 = 0, bounce off) with a leaf sound, exactly as GARI ships them. */
const leaves = (sound: number, over: Partial<PropInstance> = {}) => inst(1, {
  contact: 'through', responseMass: 0, playerBounce: false, bounce: -1, collisionSound: sound, ...over,
});

// ---- one instance → placement fields
{
  const b = instanceBehaviour('GARI', leaves(7));
  assert.deepEqual(b.nativeCollision,
    { mode: 1, playerCollision: true, responseMass: 0, playerBounce: false, bounceAmount: 0 },
    'a canopy copies as ride-through contact');
  assert.equal(b.collisionSound, 7, 'with its leaf sound');
  assert.equal(instanceBehaviour('GARI', inst(2, { collisionSound: 0 })).collisionSound, undefined,
    'event 0 is the native silent sentinel, not a sound to copy');
  const sign = instanceBehaviour('GARI', inst(3, {
    lighting: { ambient: [PROP_FULL_BRIGHT_RECORD, PROP_FULL_BRIGHT_RECORD, PROP_FULL_BRIGHT_RECORD], keys: [] },
  }));
  assert.equal(sign.fullBright, true, 'no key light and an ambient of exactly 256 is retail’s self-lit flag');
  assert.equal(instanceBehaviour('GARI', inst(3, {
    lighting: { ambient: [256, 256, 256], keys: [{ color: [10, 10, 10], direction: [0, 1, 0] }] },
  })).fullBright, undefined, 'a keyed instance is lit, however bright its ambient');
  const deck = instanceBehaviour('MERQUER', inst(4, { surface: 12, ltgState: 2 }));
  assert.equal(deck.surface, 12, 'a rideable surface copies');
  assert.equal(deck.modePresence, 'showoff', 'LTG state 2 is the Showoff-only layer');
}

// ---- a level's models → derived defaults
{
  const props = {
    models: [model(1, 'Mdl_TreeH_SnowLeaves'), model(2, 'Mdl_Fence'), model(3, 'Mdl_Kiosk_Junk'),
      model(4, 'Mdl_Hidden'), model(5, 'Mdl_Barrel')],
    instances: [
      // 5 leaf sound 7 against 1 leaf sound 12 — the GARI split in miniature — plus an invisible outlier
      ...[0, 1, 2, 3, 4].map(() => leaves(7)), leaves(12), leaves(99, { visible: false }),
      inst(2, { collisionSound: 31 }), inst(2, { collisionSound: 31 }),
      inst(3, { contact: 'ghost', playerCollision: false }),
      inst(4, { visible: false }),
      // two barrels borrowing the SAME body through different donor instances still behave identically
      inst(5, { physicsBody: 17 }), inst(5, { physicsBody: 17 }),
    ],
  };
  const derived = referencePropDefaults('GARI', props);
  const canopy = derived.get(1)!;
  assert.equal(canopy.behaviour.collisionSound, 7, 'the canopy defaults to the leaf sound most of its copies carry');
  assert.equal(canopy.behaviour.nativeCollision.responseMass, 0, 'and to ride-through contact');
  assert.deepEqual([canopy.matching, canopy.total], [5, 6], 'counting only visible copies: 5 of 6 agree');
  assert.equal(derived.get(2)?.matching, 2, 'a fence whose copies all agree');
  assert.equal(derived.get(3), undefined, 'junk twins are not art and derive nothing');
  assert.equal(derived.get(4), undefined, 'a model that is never visibly placed derives nothing');
  const barrel = derived.get(5)!;
  assert.deepEqual([barrel.matching, barrel.total], [2, 2],
    'the donor instance a body is borrowed through is not behaviour — the body is');
  assert.equal(barrel.behaviour.nativeCollision.physicsSource?.body, 17);
  assert.equal(barrel.behaviour.nativeCollision.physicsSource?.instance, barrel.sourceIndex,
    'the defaults borrow the body through the first copy that carries it');

  // ---- resolution
  const level = { level: 'GARI', ...props, materials: new Map(), crowdFrames: [] } as LevelProps;
  const tree = resolvePropDefaults('GARI', 1, level);
  assert.equal(tree.source, 'reference');
  assert.equal(tree.savable, false, 'a shipped level’s defaults are derived, never saved');
  assert.equal(tree.behaviour.collisionSound, 7);
  const again = resolvePropDefaults('GARI', 1, level);
  assert.deepEqual(again, tree, 'resolution is repeatable (the derivation is cached per loaded level)');
  again.behaviour.nativeCollision.responseMass = 5;
  assert.equal(resolvePropDefaults('GARI', 1, level).behaviour.nativeCollision.responseMass, 0,
    'each resolution is its own copy, so editing a held prop never edits the cached derivation');
  const hidden = resolvePropDefaults('GARI', 4, level);
  assert.equal(hidden.source, 'baseline');
  assert.deepEqual(hidden.behaviour.nativeCollision, defaultPlacedPropCollision('GARI'),
    'with nothing to derive from, borrowed art starts solid, as it always has');
  assert.equal(resolvePropDefaults('GARI', 1, undefined).source, 'baseline',
    'before the level loads there is nothing to derive from');
}

{
  const saved: PropBehaviour = { collisionSound: 7, fullBright: true };
  const own = { level: IMPORTED_PROP_LEVEL, models: [{ ...model(40, 'lamp'), defaults: saved }, model(41, 'rock')],
    instances: [], materials: new Map(), crowdFrames: [] } as LevelProps;
  const lamp = resolvePropDefaults(IMPORTED_PROP_LEVEL, 40, own);
  assert.equal(lamp.source, 'saved');
  assert.equal(lamp.savable, true, 'the author’s own models keep saved defaults');
  assert.equal(lamp.behaviour.collisionSound, 7);
  assert.deepEqual(lamp.behaviour.nativeCollision, defaultPlacedPropCollision(IMPORTED_PROP_LEVEL),
    'saved defaults without a collision profile stamp the standard one, so every placement has a complete profile');
  lamp.behaviour.collisionSound = 99;
  assert.equal(own.models[0].defaults?.collisionSound, 7, 'the resolved behaviour is a copy — editing it edits nothing stored');
  const rock = resolvePropDefaults(IMPORTED_PROP_LEVEL, 41, own);
  assert.equal(rock.source, 'baseline');
  assert.equal(rock.behaviour.nativeCollision.mode, 0, 'the author’s own art with no defaults starts decorative');
  assert.equal(resolvePropDefaults(AUTHORED_MODEL_LEVEL, 3, undefined).savable, true,
    'a tiled model can save defaults too');
}

// ---- sanitizing
{
  assert.equal(sanitizePropBehaviour(null), null);
  assert.equal(sanitizePropBehaviour([1, 2]), null, 'an array is not a behaviour');
  assert.equal(sanitizePropBehaviour({ surface: -1, modePresence: 'race', bogus: 1 }), null,
    'nothing usable is no defaults at all — one representation for "none"');
  const clean = sanitizePropBehaviour({
    nativeCollision: { mode: 3, playerCollision: true, responseMass: 1e30, playerBounce: true, bounceAmount: 0.5,
      physicsSource: { level: 'GARI', body: 4, instance: 'x' } },
    surface: 12, collisionSound: 2.5, ambientSound: 97, ambientRadius: -4, ambientFalloff: 9,
    ambientHalfExtents: [1, 2, 3], fullBright: 'yes',
  });
  assert.deepEqual(clean, {
    nativeCollision: { mode: 3, playerCollision: true, responseMass: 1e30, playerBounce: true, bounceAmount: 0.5,
      physicsSource: { level: 'GARI', body: 4 } },
    surface: 12, ambientSound: 97, ambientHalfExtents: [1, 2, 3],
  }, 'each field is kept only when well-formed');
  assert.equal(sanitizePropBehaviour({ nativeCollision: { mode: 7, playerCollision: true, responseMass: 0,
    playerBounce: false, bounceAmount: 0 } }), null, 'an out-of-range collision mode drops the whole profile');
}

// ---- copying and comparing
{
  const prop: PlacedProp = { level: 'GARI', model: 1, name: 'x', pos: [0, 0, 0], yaw: 0, scale: 1,
    collisionSound: 72, ambientSound: 97, surface: 3 };
  applyBehaviour(prop, { collisionSound: 7, nativeCollision: defaultPlacedPropCollision('GARI') });
  assert.equal(prop.collisionSound, 7);
  assert.equal(prop.ambientSound, undefined, 'applying a behaviour removes the fields it does not carry');
  assert.equal(prop.surface, undefined);
  assert.equal(prop.level, 'GARI', 'and never touches where the prop is or what it is');
  const copy = behaviourOf(prop);
  copy.nativeCollision!.bounceAmount = 0.1;
  assert.equal(prop.nativeCollision?.bounceAmount, 0.5, 'behaviourOf is a deep copy');
  assert(sameBehaviour({ collisionSound: 7, fullBright: true }, { fullBright: true, collisionSound: 7 }),
    'comparison ignores key order');
  assert(!sameBehaviour({ collisionSound: 7 }, { collisionSound: 8 }));
  assert(sameBehaviour({ ...prop }, behaviourOf(prop)), 'placement-only fields are not behaviour');
}

console.log('prop-defaults: ok');
