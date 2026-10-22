// tier: fast
import assert from 'node:assert/strict';
import { TestRide } from '../src/app/ride/session';

// Exercise the production action handler without constructing WebGL, HUD or input devices.
let resets = 0;
const host = Object.assign(Object.create(TestRide.prototype) as object, {
  started: true,
  pausedFlag: false,
  onFootFlag: false,
  runActive: false,
  countdownElapsed: 0,
  o: { countdown: undefined as { holdSeconds: number } | undefined },
  model: { resetToCourse: () => resets++ },
});
const ride = host as unknown as TestRide;
ride.applyEffect({ kind: 'reset' });
assert.equal(resets, 1, 'Free riding accepts world reset effects without an active scored run');
host.runActive = true;
ride.applyEffect({ kind: 'reset' });
host.runActive = false;
ride.applyEffect({ kind: 'reset' });
assert.equal(resets, 3, 'Recovery remains available after a scored run ends');
host.pausedFlag = true;
ride.applyEffect({ kind: 'reset' });
host.pausedFlag = false;
host.onFootFlag = true;
ride.applyEffect({ kind: 'reset' });
host.onFootFlag = false;
host.o.countdown = { holdSeconds: 3 };
ride.applyEffect({ kind: 'reset' });
assert.equal(resets, 3, 'Pause, walking and countdown suppress mounted recovery');
host.countdownElapsed = 3;
ride.applyEffect({ kind: 'reset' });
assert.equal(resets, 4, 'Recovery resumes as soon as countdown ends');
host.started = false;
ride.applyEffect({ kind: 'reset' });
assert.equal(resets, 4, 'Stopped sessions cannot reset a retained board');
console.log('PASS: free riding, finished-run recovery and control-state gates');
