// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(
  readFileSync(new URL('../../Snowknife/Snowknife/schemas/course/splines-v1.schema.json', import.meta.url), 'utf8'),
);
const validate = new Ajv2020({ strict: false }).compile(schema);
const points = [
  [0, 0, 0],
  [100, 0, 0],
  [200, 0, 0],
  [300, 0, 0],
];
const document = (segment: object) => ({
  Splines: [{ SplineName: 'Course spline', U0: -1, U1: 0, SplineStyle: -1, Segments: [segment] }],
});
assert(validate(document({ Points: points })), 'existing Bezier-only maps remain valid');
const segment = {
  Points: points,
  PowerCoefficients: [
    [0, 0, 0],
    [0, 0, 0],
    [300, 0, 0],
    [0, 0, 0],
  ],
  ArcLengthCoefficients: [0, 0, 300, 0],
  Length: 300,
  Distance: 0,
  Previous: -1,
  Next: -1,
  SourceSegment: 0,
};
assert(validate(document(segment)), 'native importers can retain source curve, arc length and connectivity');
assert(!validate(document({ ...segment, Length: -1 })), 'negative physical length is rejected');
assert(!validate(document({ ...segment, PowerCoefficients: [[0, 0, 0]] })), 'partial cubic coefficients are rejected');
assert(!validate(document({ ...segment, Next: -2 })), 'only -1 is the absent-link sentinel');
console.log('SPLINE CONTRACT PASS: minimal maps and optional native curve metadata');
