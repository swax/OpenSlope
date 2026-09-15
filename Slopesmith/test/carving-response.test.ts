// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bankedNormalResponse, DEFAULT_GROUND_RESPONSE, forwardResistance, headingLead, headingYaw,
  lateralResistance, lateralSpeedGain, type GroundResponseTuning } from '../src/app/ride/ride-response';
import { RIDE_SURFACE_ROWS, type RideContractSurfaceRow } from '../src/app/ride/ride-contract.generated';

interface ResponseCase {
  surface: Partial<RideContractSurfaceRow> & { type: number };
  u: number; w: number; error: number; budget: number; lean: number; charge: number; boost: number;
  tuning: GroundResponseTuning; forwardAcceleration: number; lateralAcceleration: number;
}
const fixture = JSON.parse(readFileSync('../Trailmap/specs/data/carving-response-cases-v1.json', 'utf8')) as {
  cases: ResponseCase[];
};
const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 2e-6 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
for (const [index, row] of fixture.cases.entries()) {
  const surface = { ...RIDE_SURFACE_ROWS[row.surface.type], ...row.surface };
  near(forwardResistance(surface, row.u, row.error, row.budget, row.charge, row.boost, row.tuning),
    row.forwardAcceleration, `forward instruction fixture ${index}`);
  near(lateralResistance(surface.drag, row.u, row.w, row.lean, row.boost, row.tuning),
    row.lateralAcceleration, `lateral instruction fixture ${index}`);
}

// Physical invariants distinguish the recovered law from a fitted bite or bounded grip.
near(lateralResistance(1, 12, 0, 0.9, 0), 0, 'zero lateral speed');
near(lateralResistance(1, 12, 2, 0, 0), lateralResistance(1, 12, 2, 0.9051856, 0), 'ordinary lean gain is one');
near(lateralResistance(3, 12, 2, 0, 0) / lateralResistance(0.0025, 12, 2, 0, 0), 1200, 'surface ratio');
assert.ok(lateralSpeedGain(8) < lateralSpeedGain(13.8));
assert.ok(lateralSpeedGain(20) < lateralSpeedGain(14));
assert.ok(Math.abs(lateralResistance(1, 12, 2, 0, 1)) < Math.abs(lateralResistance(1, 12, 2, 0, 0)));
assert.ok(forwardResistance(RIDE_SURFACE_ROWS[1], 20, 0, 0.025, 0, 0) < 0);
near(forwardResistance(RIDE_SURFACE_ROWS[1], 0, 0, 0.025, 0, 0), 0, 'zero forward speed');
assert.equal(DEFAULT_GROUND_RESPONSE.skid, 0);

// Scalar heading cases cover standstill, reverse travel, self-centering, and the signed-lean branch.
const dt = 1 / 60;
assert.equal(headingYaw(0.9, 0.49, 0, 0, 0, 0, dt), 0);
near(headingYaw(0.9, 0.49, 0, 20, 20, 20, dt), 0.1047197580, 'six degree cap');
near(headingYaw(-0.9, -0.49, 0, 20, 20, 20, dt), -0.1047197580, 'opposite cap');
const correcting = headingYaw(0.8, 0.2, Math.sin(0.4), 20, 20, 20, dt);
near(correcting, -0.2 * 0.01004204992, 'opposing correction uses signed lean');
near(headingYaw(0, 0, Math.sin(0.4), 20, -20, 20, dt), 0.4 * 0.01004204992, 'backward correction');
assert.ok(Math.abs(headingYaw(0, 0, 0.2, 20, 20, 0, dt)) > Math.abs(headingYaw(0, 0, 0.2, 20, 20, 20, dt)),
  'alignment measures downhill travel, not sideways slip');
assert.ok(headingLead(0.8, 0, 2) < headingLead(0.8, 0, 0));
assert.ok(headingLead(0.8, 0, 0) < headingLead(0.8, 0, 1));
assert.ok(headingLead(0.8, 1) < headingLead(0.8, 0));

// Resolve the vector composition independently: residual normal + banked vector.
const response = 18, capped = 16, theta = Math.PI / 6;
const quotient = capped / Math.cos(theta);
near(bankedNormalResponse(response, capped, theta), response - quotient + quotient * Math.cos(theta), 'normal residual');
assert.ok(bankedNormalResponse(response, capped, theta) < response);
console.log(`CARVING RESPONSE: PASS (${fixture.cases.length * 2} instruction-reference outputs, heading and force invariants)`);
