// tier: fast
import assert from 'node:assert/strict';
import { cruiseSpeedInput } from '../src/app/ride/cruise-speed';
import type { RefAiPathEvent } from '../src/core/reference/terrain';
import { readLevelAiPaths } from '../src/shared/map-levels';
import { pathSource } from './ai-path-data.fixture';

const event = (value: number, start = 100, end = 120): RefAiPathEvent => ({ type: 101, value, start, end });
const speed = [event(71)];
const input = (previous: number, current: number, kmh: number, aggression = 1) =>
  cruiseSpeedInput(speed, previous, current, kmh / 3.6, aggression);

assert.equal(input(93, 93.999, 100), null, 'The speed window starts exactly six horizontal metres ahead');
assert.deepEqual(
  input(93, 94, 100),
  {
    target: 71 / 3.6,
    entered: false,
    throttle: false,
    brake: false,
    boost: false,
  },
  'An overspeed approach suppresses default speed inputs but cannot brake early',
);
assert(input(99, 100, 100)?.brake, 'Brake starts at the authored range entry');
assert(input(110, 115, 65)?.boost, 'Underspeed inside the range requests throttle and boost');
assert(input(93, 94, 65)?.throttle && !input(93, 94, 65)?.boost, 'An underspeed approach requests throttle only');
assert(!input(110, 115, 66)?.throttle && !input(110, 115, 76)?.brake, 'The five-km/h band has strict edges');
assert(!input(110, 115, 50, 0.8)?.throttle, 'Non-nominal aggression scales the lower threshold');
assert(input(110, 115, 50)?.throttle, 'Nominal aggression leaves the threshold unscaled');
assert(input(119, 121, 100)?.brake, 'A fast frame crossing the range end still consumes it');
assert.equal(input(121, 122, 100), null, 'The target clears once the previous station passes the end');
assert.equal(cruiseSpeedInput([event(0)], 110, 115, 2, 1)?.brake, true, 'Zero is a real target');
assert.equal(
  cruiseSpeedInput([{ ...event(0), type: 102 }], 110, 115, 20, 1),
  null,
  'Unidentified events have no cruise behavior',
);
assert.equal(
  cruiseSpeedInput([event(35, 105, 125), event(100)], 99, 100, 20, 1)?.target,
  35 / 3.6,
  'Source order wins over station order for overlapping events',
);
assert.equal(speed[0].value, 71, 'Decoding retains the whole source payload');
const loaded = await readLevelAiPaths(pathSource, 'TEST');
assert(loaded);
assert.equal(
  cruiseSpeedInput(loaded[0].events, 10, 10.5, 15, 1)?.target,
  71 / 3.6,
  'AIP loading preserves cruise payloads and converts range stations to the rider ruler',
);
console.log('PASS: cruise-speed lookahead, input thresholds, source precedence, zero targets and end crossing');
