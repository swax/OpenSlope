// tier: fast

import assert from 'node:assert/strict';
import { AUTHORED_MODEL_LEVEL } from '../src/core/doc/models';
import { IMPORTED_PROP_LEVEL } from '../src/core/props/imported';
import {
  collisionProfileContactState, collisionProfileFromSourceInstance,
  defaultPlacedPropCollision, defaultPlacedPropSolid,
  placedPropContactState, placedPropSolid,
} from '../src/core/props/contact';
import { SURFACE_STYLE } from '../src/core/doc/types';
import { SURFACE_TYPES } from '../src/core/reference/surface-types';
import { propContactTint, PROP_CLAY_COLOR, PROP_SOLID_COLOR } from '../src/app/viewport/scene/prop-shade';

assert.equal(defaultPlacedPropSolid('DONOR'), true, 'borrowed source art defaults solid');
assert.equal(defaultPlacedPropSolid(AUTHORED_MODEL_LEVEL), false, 'authored geometry defaults decorative');
assert.equal(defaultPlacedPropSolid(IMPORTED_PROP_LEVEL), false, 'imported geometry defaults decorative');
assert.deepEqual(defaultPlacedPropCollision('DONOR'), {
  mode: 1, playerCollision: true, responseMass: 1e30, playerBounce: true, bounceAmount: 0.5,
}, 'borrowed placements materialize the complete conventional solid profile');
assert.deepEqual(defaultPlacedPropCollision(AUTHORED_MODEL_LEVEL), {
  mode: 0, playerCollision: false, responseMass: 0, playerBounce: false, bounceAmount: 0,
}, 'arbitrary authored geometry materializes a complete decorative profile');

const borrowed = { level: 'DONOR' };
assert.equal(placedPropSolid(borrowed), true, 'legacy borrowed placements retain their old solid default');
assert.equal(placedPropSolid({ ...borrowed, solid: false }), false, 'an explicit borrowed-prop override wins');
assert.equal(placedPropSolid({ ...borrowed, solid: true, effectTrigger: { size: [1, 1, 1] as [number, number, number] } }), false,
  'trigger volumes remain pass-through even if stale data says solid');

const decorative = { level: AUTHORED_MODEL_LEVEL, solid: false };
assert.equal(placedPropContactState(decorative, false, false), 'none', 'plain non-solid art has no collider');
assert.equal(placedPropContactState(decorative, true, false), 'through', 'a collision effect requests pass-through contact');
assert.equal(placedPropContactState(decorative, false, true), 'through', 'a hit sound requests pass-through contact');
assert.equal(placedPropContactState({ ...decorative, solid: true }, false, false), 'solid', 'Solid requests rider response');

const explicitNone = { level: 'DONOR', nativeCollision: {
  mode: 0 as const, playerCollision: false, responseMass: 0, playerBounce: false, bounceAmount: 0,
} };
assert.equal(placedPropContactState(explicitNone, true, true), 'none',
  'effects and sounds warn but never override an explicit no-contact profile');
const sourceSpheres = { mode: 3 as const, playerCollision: true, responseMass: 5, playerBounce: true, bounceAmount: 0.2,
  physicsSource: { level: 'DONOR', body: 7, instance: 149 } };
assert.equal(collisionProfileContactState(sourceSpheres), 'solid', 'a source-body sphere profile is contactable');
assert.equal(collisionProfileContactState({ ...sourceSpheres, physicsSource: undefined }), 'none',
  'mode 3 without its body stays an explicit invalid/no-shape result');
assert.deepEqual(collisionProfileFromSourceInstance('DONOR', {
  sourceIndex: 149, shape: 3, playerCollision: true, responseMass: 5,
  playerBounce: true, bounce: 0.2, physicsBody: 7, contact: 'solid',
}), sourceSpheres, 'copying a native crash bag preserves its exact sphere body and independent response fields');

// The Surface view has to be able to SHOW what the panel says. `surfaceStyle` answers snow for a type with no
// row, so an incomplete table does not read as "unknown" — it states the wrong surface confidently, and a
// rideable prop wearing near-white reads as the decorative clay beside it (MEGAPLE's metal BumperBase).
for (let type = 0; type < SURFACE_TYPES.length; type++)
  assert.ok(SURFACE_STYLE[type], `shipped SurfaceType ${type} (${SURFACE_TYPES[type].label}) needs its own style row`);
const swatches = new Map<string, number>();
for (const key of Object.keys(SURFACE_STYLE)) {
  const type = Number(key);
  const swatch = propContactTint('solid', type).toString(16);
  const twin = swatches.get(swatch);
  assert.equal(twin, undefined, `SurfaceType ${type} shares its swatch with ${twin}`);
  swatches.set(swatch, type);
  assert.notEqual(propContactTint('solid', type), PROP_CLAY_COLOR,
    `a rideable SurfaceType ${type} solid must not wear the decorative clay colour`);
}
assert.equal(propContactTint('solid', -1), PROP_SOLID_COLOR, 'a solid with no ride surface stays the obstacle blue');
assert.equal(propContactTint('none', 13), PROP_CLAY_COLOR, 'a stored ride surface cannot colour a no-contact prop');

console.log('PLACED PROP CONTACT TESTS PASSED');
