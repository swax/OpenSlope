// tier: fast

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RIDE_AIR_LEVEL_RATE,
  RIDE_CONTACT_SEPARATION_SPEED,
  RIDE_CONTRACT_PROFILE,
  RIDE_CONTRACT_SCHEMA,
  RIDE_CONTRACT_VERSION,
  RIDE_GOLD_SNOWDREAM_TAKEOFFS,
  RIDE_GROUND_ORIENT_GAIN,
  RIDE_GROUND_QUADRATIC_DRAG,
  RIDE_GROUND_TANGENTIAL_PULL,
  RIDE_SIMULATION_HZ,
  RIDE_SURFACE_ROWS,
} from '../src/app/ride/ride-contract.generated';
import {
  AIR_LEVEL_RATE,
  CONTACT_SEPARATION_SPEED,
  GROUND_TANGENTIAL_PULL,
  GROUND_ORIENT_GAIN,
  SURFACE_ROWS,
} from '../src/app/ride/physics';

assert.equal(RIDE_CONTRACT_SCHEMA, 'ride-contract/v1');
assert.equal(RIDE_CONTRACT_VERSION, 1);
assert.equal(RIDE_CONTRACT_PROFILE, 'pal-carving-response-2026-09-15');
assert.equal(RIDE_SIMULATION_HZ, 60);
assert.equal(RIDE_GROUND_QUADRATIC_DRAG, 0);
assert.equal(RIDE_SURFACE_ROWS.length, 20);
assert.deepEqual(RIDE_SURFACE_ROWS.map(row => row.type), Array.from({ length: 20 }, (_, i) => i));
assert.equal(RIDE_GOLD_SNOWDREAM_TAKEOFFS.length, 3);

// Slopesmith's public physics surface is now aliases over the generated contract, not a second table/constant set.
assert.strictEqual(SURFACE_ROWS, RIDE_SURFACE_ROWS);
assert.equal(GROUND_TANGENTIAL_PULL, RIDE_GROUND_TANGENTIAL_PULL);
assert.equal(GROUND_ORIENT_GAIN, RIDE_GROUND_ORIENT_GAIN);
assert.equal(AIR_LEVEL_RATE, RIDE_AIR_LEVEL_RATE);
assert.equal(CONTACT_SEPARATION_SPEED, RIDE_CONTACT_SEPARATION_SPEED);

// The Unity runtime cannot execute in this Node suite, but guard its production wiring here. Unity Play Mode is
// still responsible for numerical runtime validation; this catches the common regression where generated values
// exist but handwritten literals or the old approximation remain on the actual board path.
const repo = resolve(process.cwd(), '..');
const unityRoot = resolve(repo, 'Unity');
const unityImplementation = resolve(unityRoot, 'Importer/Editor/LevelImporter.cs');
assert.ok(existsSync(unityImplementation), 'the required Unity implementation is present');
const board = readFileSync(resolve(repo, 'Unity/VRC/Riding/Board/RideableBoard.cs'), 'utf8');
const railBoard = readFileSync(resolve(repo, 'Unity/VRC/Riding/Board/RideableBoard.Rail.cs'), 'utf8');
const probe = readFileSync(resolve(repo, 'Unity/VRC/Riding/Board/RideableBoard.Probe.cs'), 'utf8');
const surfaces = readFileSync(resolve(repo, 'Unity/VRC/Riding/Board/RideableBoard.Surface.cs'), 'utf8');
const patches = readFileSync(resolve(repo, 'Unity/VRC/Riding/TerrainPatches.cs'), 'utf8');
const generatedUnity = readFileSync(resolve(repo, 'Unity/VRC/Riding/Board/RideableBoard.Contract.Generated.cs'), 'utf8');
const basisGenerated = readFileSync(resolve(repo, 'Unity/Basis/Riding/BasisBoard.Contract.Generated.cs'), 'utf8');
const basisSurfaces = readFileSync(resolve(repo, 'Unity/Basis/Riding/BasisBoard.Surface.cs'), 'utf8');
const basisRide = readFileSync(resolve(repo, 'Unity/Basis/Riding/BasisBoard.Ride.cs'), 'utf8');
assert.match(board, /Vector3\.down \* \(A \/ 100f\)/);
assert.match(board, /RideBankedNormalResponse\(response, capped, theta\)/);
assert.match(board, /normalSpeed > RIDE_CONTACT_SEPARATION_SPEED/);
assert.match(board, /RIDE_GROUND_ORIENT_GAIN \* upError \* upError \* upError/);
assert.match(probe, /RIDE_PROBE_ABOVE/);
assert.match(board, /RIDE_BANK_MAX/);
assert.match(board, /RIDE_STEER_STRENGTH/);
// Desktop first-person follows the board heading through two INSPECTOR dials. The headset-tested VR controller
// behavior is locked in separately: precision stick shaping in every ride state, 25% grounded seat carry after
// the clamp, and full air/rail carry with hard lock still exactly 100%.
assert.doesNotMatch(board, /DESKTOP_FIRST_PERSON_VIEW_LEAD|VR_STICK_SEAT_TURN_CARRY|VIEW_TRAVEL_SMOOTH \+/);
assert.match(board, /public float viewYawRateMax/);
assert.match(board, /public float viewBoardLead/);
assert.match(board, /VR_GROUND_STICK_VIEW_CARRY = 0\.25f/);
assert.match(board, /return Mathf\.Sign\(value\) \* value \* value/);
// VR seat carry is stick-intent only: gaze-derived lean (headLeanFullAngle head-steer) must never rotate the
// seat, or look-to-steer feeds back into a spin.
assert.match(board, /float steerIntent = stickActive \? StickSteer\(\) : headSteer/);
assert.match(board, /float seatTurnLean = stickActive \? turnLean : 0f/);
assert.match(board, /Mathf\.Rad2Deg \* VR_GROUND_STICK_VIEW_CARRY/);
assert.match(board, /float stickYawAir = StickSteer\(\) \* RIDE_AIR_TURN_RATE/);
assert.match(board, /_seatFwd = Quaternion\.AngleAxis\(stickYawAir, Vector3\.up\) \* _seatFwd/);
// Rails steer at the shared (trick-boosted) air rate on every input path; only head follow stays unboosted so
// it can park on its target. A leftover railTurnRate means the slower presentation rate crept back in.
assert.match(railBoard, /float stickRailYaw = StickSteer\(\) \* RIDE_AIR_TURN_RATE \* spinBoostMul \* dt/);
assert.match(railBoard, /_seatFwd = Quaternion\.AngleAxis\(stickRailYaw, Vector3\.up\) \* _seatFwd/);
assert.match(railBoard, /else _fwd = HeadFollow\(_fwd, _boardUp, dt, RIDE_AIR_TURN_RATE\)/);
assert.doesNotMatch(railBoard, /railTurnRate/);
assert.match(board, /RideLateralResistance\(row, u, w, _lean, boost\)/);
assert.match(board, /RideForwardResistance\(row, u, _error, _sinkBudget, _charge, boost\)/);
assert.match(board, /_vel \+= _tickAccel \* h;[\s\S]*?if \(onGround && !_grinding\) GroundSteering/);
assert.match(board, /public bool lowGripAssist = false/);
// The lateral carve slide must reach BOTH consumers on the real board path: the probe base (the carve's
// curvature sensor - without it ice carve force pins at the flat-ground equilibrium) and the drawn deck.
assert.match(board, /-RIDE_CARVE_SLIDE_SCALE \* _lean \* slideGate/);
assert.match(board, /ProbeContact\(probeBase\); else Probe\(probeBase\)/);
assert.match(board, /ContactGap\(probeBase\)/);
assert.match(board, /pivotLat\.normalized \* _carveSlide/);
// The slide must never itself end contact: a slid read that misses or leaves the ground band falls back to the
// unoffset deck (wall rides peel off otherwise - a convex shoulder fakes clearance, a mesh lip fakes a miss).
assert.match(board, /probeSlid && \(!_pFound \|\| error > SurfThresh/);
assert.doesNotMatch(board + probe + surfaces, /faithfulRideModel|pitchConform|landAnticipate|analyticPatchContact/);
assert.match(board, /RIDE_DBG\|kind=header\|schema=unity-ride-telemetry\/v1/);
assert.doesNotMatch(board, /speedDrag \* dragMul/);
assert.match(surfaces, /return _rideSurfA\[SurfRow\(t\)\]/);
assert.match(patches, /RIDE_ANALYTIC_NEWTON_ITERATIONS/);
assert.match(patches, /RRayResidual > RIDE_ANALYTIC_RAY_RESIDUAL_MAX/);
assert.doesNotMatch(patches, /intersect the PROBE RAY[\s\S]{0,250}TANGENT PLANE/);
assert.match(generatedUnity, /RIDE_CONTRACT_SCHEMA = "ride-contract\/v1"/);
assert.match(generatedUnity, /RIDE_CONTRACT_PROFILE = "pal-carving-response-2026-09-15"/);
// Basis consumes the same generated rows. Its handwritten file owns algorithms and scale knobs only; folded
// surface-family if-chains and the older km/h conversion cannot quietly become a fourth tuning table again.
assert.match(basisGenerated, /RIDE_CONTRACT_SCHEMA = "ride-contract\/v1"/);
assert.match(basisGenerated, /RIDE_CONTRACT_PROFILE = "pal-carving-response-2026-09-15"/);
assert.match(basisSurfaces, /return _rideSurfDrag\[SurfaceRow\(t\)\]/);
assert.match(basisSurfaces, /return _rideSurfBudget\[SurfaceRow\(t\)\] \* sinkDepthScale/);
assert.doesNotMatch(basisSurfaces, /KNOWN DIVERGENCE|if \(t == \d+\).*return \d/);
assert.match(basisRide, /float target = SpeedGainFor\(surf\);/);
assert.doesNotMatch(basisRide, /SpeedGainFor\(surf\) \* 0\.277778f/);

console.log('RIDE CONTRACT: PASS');
